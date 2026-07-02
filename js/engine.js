/* =============================================================================
   engine.js — the deterministic planning engine (§5).

   SPP.engine.generate(store, params) returns a full plan result:
     calendar, deployed/cap/idle machines, day-by-day schedule, per-profile
     material accounting, feasibility figures and a warnings list.

   The daily simulation is run once per candidate machine count (1..max) so the
   cost-optimizer can pick the fewest machines that still install the maximum
   the window can absorb (§5.4).
   ============================================================================= */
(function () {
  "use strict";
  const SPP = window.SPP;
  const U = SPP.util;
  const E = (SPP.engine = {});
  const EPS = 1e-6;

  E.generate = function (store, p) {
    const chainage = store.chainage, material = store.material;
    const planStart = p.planStart;
    const totalDays = p.periodWeeks * 7;
    const planEnd = U.addDays(planStart, totalDays - 1);

    /* ---- 1. manpower cap (§4 validation: 6 people per machine) ------------- */
    const cap = Math.floor(p.manpower / 6);
    const maxMachines = Math.max(0, Math.min(p.machinesInput, cap));
    const capApplied = p.machinesInput > cap;

    /* ---- 2. candidate chainages + blocked detection (§5.2 / §5.3) ---------- */
    const candidates = chainage.features.filter((f) => f.priority === p.priority);

    function codeMaterial(code) { return material.byCode[code] || null; }
    function totalMaterialQty(code) {
      const m = codeMaterial(code);
      if (!m) return 0;
      return m.onsite + m.inbound.reduce((s, i) => s + i.qty, 0);
    }
    const workable = [], blocked = [];
    candidates.forEach((f) => {
      if (!f.code || totalMaterialQty(f.code) <= 0) blocked.push(f);
      else workable.push(f);
    });
    const blockedMTO = blocked.reduce((s, f) => s + f.mto, 0);
    // Plan scope MTO is ALWAYS the full priority scope. Blocked chainages (no material)
    // remain in the MTO; because they cannot be installed they surface as carry-over.
    const totalMTO = candidates.reduce((s, f) => s + f.mto, 0);

    /* ---- 3. per-code material state at plan start (§5.3) -------------------- */
    // startingStock = on-site + inbound already usable by plan start.
    // replenishments = inbound usable strictly after plan start (dated events).
    const startStock = {};
    const replen = [];                       // {usable, code, qty}
    const usedCodes = Array.from(new Set(workable.map((f) => f.code)));
    usedCodes.forEach((code) => {
      const m = codeMaterial(code);
      let start = m.onsite;
      m.inbound.forEach((inb) => {
        if (U.cmpDate(inb.usable, planStart) <= 0) start += inb.qty;
        else replen.push({ usable: inb.usable, code: code, qty: inb.qty });
      });
      startStock[code] = start;
    });
    replen.sort((a, b) => U.cmpDate(a.usable, b.usable));

    // Inbound arrivals that land within the plan window (markers / timeline).
    const windowArrivals = replen
      .filter((ev) => U.cmpDate(ev.usable, planEnd) <= 0)
      .map((ev) => ({ date: ev.usable, code: ev.code, qty: ev.qty,
                      profile: profileForCode(ev.code) }))
      .sort((a, b) => U.cmpDate(a.date, b.date));

    function profileForCode(code) {
      const f = workable.find((w) => w.code === code) || candidates.find((c) => c.code === code);
      return f ? f.profile : code;
    }

    /* ---- 4. ordered work queue (§5.2) -------------------------------------- */
    // Profiles ranked by starting on-site stock available at plan start (desc);
    // within a profile, chainages ascend by Chainage_Id.
    const byCode = {};
    workable.forEach((f) => { (byCode[f.code] || (byCode[f.code] = [])).push(f); });
    const orderedCodes = Object.keys(byCode).sort((a, b) =>
      (startStock[b] - startStock[a]) || profileForCode(a).localeCompare(profileForCode(b)));
    // Material available within the window per code (for the capToMaterial adjustment).
    function availWindow(code) {
      const m = codeMaterial(code);
      const inW = m.inbound.filter((i) => U.cmpDate(i.usable, planStart) > 0 && U.cmpDate(i.usable, planEnd) <= 0).reduce((s, i) => s + i.qty, 0);
      return startStock[code] + inW;
    }
    const queue = [];
    orderedCodes.forEach((code) => {
      const sorted = byCode[code].slice().sort((x, y) => x.sortKey - y.sortKey);
      if (p.capToMaterial) {
        // Only queue chainages whose cumulative MTO fits the window material for this
        // profile, so no profile is started beyond what it can cover (clears shortfall).
        let cum = 0; const avail = availWindow(code);
        sorted.forEach((f) => { if (cum + f.mto <= avail + EPS) { queue.push(f); cum += f.mto; } });
      } else {
        sorted.forEach((f) => queue.push(f));
      }
    });
    const chById = {};
    workable.forEach((f) => { chById[f.id] = f; });

    /* ---- 5. working calendar + hindrances (§5.1 / §5.5) -------------------- */
    const cal = [];
    for (let i = 0; i < totalDays; i++) {
      const d = U.addDays(planStart, i);
      cal.push({
        date: d, dayNum: i + 1,
        isWorking: U.isoDow(d) <= p.workDaysPerWeek,
        hours: p.workhours, nonWorkReason: U.isoDow(d) <= p.workDaysPerWeek ? null : "Weekly off"
      });
    }
    // Each hindrance now carries the specific day(s) it affects (non-contiguous OK).
    // Impact lands ONLY on those selected days; if a hindrance has no selected day,
    // we fall back to the earliest working day(s) (preserves the previous behavior).
    // TODO: confirm semantics — assumed: (days unit) every selected working day is
    // fully lost and `amount` is ignored when days are picked; (hours unit) `amount`
    // hours are trimmed from EACH selected day (not split across them).
    const lostDays = [], trimmedDays = [];
    let hindHours = 0;
    function markLost(c) {
      c.isWorking = false; c.hours = 0; c.nonWorkReason = "Hindrance — day lost"; c.hindrance = true;
      lostDays.push(c.date);
    }
    function trimHours(c, hrs) {
      const take = Math.min(c.hours, hrs);
      if (take <= 0) return 0;
      c.hours -= take; c.hindHours = (c.hindHours || 0) + take; hindHours += take;
      if (c.hours <= EPS) { c.isWorking = false; c.hours = 0; c.nonWorkReason = "Hindrance — hours lost"; c.hindrance = true; }
      else { c.partialHindrance = true; }
      if (trimmedDays.indexOf(c.date) < 0) trimmedDays.push(c.date);
      return take;
    }
    p.hindrances.forEach((h) => {
      const sel = (h.days && h.days.length) ? new Set(h.days) : null;
      if (h.unit === "days") {
        if (sel) {                                  // lose exactly the selected working days
          cal.forEach((c) => { if (c.isWorking && sel.has(U.fmtISO(c.date))) markLost(c); });
        } else {                                    // fallback: lose the earliest N working days
          let n = Math.round(h.amount);
          for (let i = 0; i < cal.length && n > 0; i++) if (cal[i].isWorking) { markLost(cal[i]); n--; }
        }
      } else {                                      // hours
        if (sel) {                                  // trim `amount` hours from each selected working day
          cal.forEach((c) => { if (c.isWorking && sel.has(U.fmtISO(c.date))) trimHours(c, h.amount); });
        } else {                                    // fallback: trim `amount` hours from earliest working days
          let toTrim = h.amount;
          for (let i = 0; i < cal.length && toTrim > EPS; i++) if (cal[i].isWorking) toTrim -= trimHours(cal[i], toTrim);
        }
      }
    });
    const workingDayCount = cal.filter((c) => c.isWorking).length;

    /* ---- 6. the daily simulation (§5.4) ------------------------------------ */
    const rampProfile = (p.rampProfile && p.rampProfile.length) ? p.rampProfile : [1];
    function rampFactor(k) { return rampProfile[Math.min(k, rampProfile.length - 1)]; }

    function simulate(M) {
      const stock = Object.assign({}, startStock);
      const repl = replen.map((r) => ({ usable: r.usable, code: r.code, qty: r.qty }));
      const st = {};
      workable.forEach((f) => { st[f.id] = { done: 0, started: false, startDate: null, lastDate: null, completed: false, completedDate: null, machine: null }; });
      const assign = new Array(M).fill(null);
      let qptr = 0, totalInstalled = 0, idleMachineDays = 0, workingOrdinal = -1;
      const schedule = [];
      const consumedByCode = {};

      cal.forEach((day) => {
        // material arrives on its calendar date regardless of working status
        for (let r = 0; r < repl.length; r++) {
          if (repl[r].qty > 0 && U.sameDay(repl[r].usable, day.date)) { stock[repl[r].code] += repl[r].qty; repl[r].qty = 0; }
        }
        if (!day.isWorking) return;
        workingOrdinal++;
        for (let i = 0; i < M; i++) if (assign[i] == null && qptr < queue.length) assign[i] = queue[qptr++].id;

        for (let i = 0; i < M; i++) {
          const id = assign[i];
          if (id == null) { idleMachineDays++; continue; }
          const ch = chById[id], s = st[id];
          if (!s.started) { s.started = true; s.startDate = day.date; s.machine = i + 1; }
          const isNew = i >= p.prevMachines;
          const factor = isNew ? rampFactor(workingOrdinal) : 1.0;
          const capacity = p.productivity * factor * day.hours;
          const avail = stock[ch.code] || 0;
          const remaining = ch.mto - s.done;
          let install = Math.min(capacity, remaining, avail);
          if (install < 0) install = 0;
          s.done += install; stock[ch.code] = avail - install; s.lastDate = day.date;
          totalInstalled += install;
          consumedByCode[ch.code] = (consumedByCode[ch.code] || 0) + install;
          schedule.push({
            date: day.date, dayNum: day.dayNum, machine: i + 1, chId: id,
            profile: ch.profile, code: ch.code, install: install, cum: s.done, mto: ch.mto,
            stockEnd: stock[ch.code], capacity: capacity,
            waiting: install <= EPS && capacity > EPS    // assigned but starved of material
          });
          if (s.done >= ch.mto - EPS) { s.completed = true; s.completedDate = day.date; assign[i] = null; }
        }
      });
      return { totalInstalled, schedule, state: st, stockEnd: stock, consumedByCode, idleMachineDays };
    }

    /* ---- 7. cost-optimization: fewest machines for max installs ------------ */
    const perM = {};
    const plans = {};
    let maxInstalled = 0;
    for (let M = 1; M <= maxMachines; M++) { const r = simulate(M); plans[M] = r; perM[M] = r.totalInstalled; if (r.totalInstalled > maxInstalled) maxInstalled = r.totalInstalled; }
    let deployed = maxMachines;
    for (let M = 1; M <= maxMachines; M++) { if (perM[M] >= maxInstalled - EPS) { deployed = M; break; } }
    const plan = maxMachines > 0 ? plans[deployed] : { totalInstalled: 0, schedule: [], state: {}, stockEnd: Object.assign({}, startStock), consumedByCode: {}, idleMachineDays: 0 };

    /* ---- 8. chainages worked (for gantt / table) --------------------------- */
    const worked = workable
      .filter((f) => plan.state[f.id] && plan.state[f.id].started)
      .map((f) => {
        const s = plan.state[f.id];
        return { id: f.id, profile: f.profile, code: f.code, mto: f.mto,
                 done: s.done, machine: s.machine, startDate: s.startDate,
                 lastDate: s.lastDate, completed: s.completed, completedDate: s.completedDate };
      })
      .sort((a, b) => a.machine - b.machine || a.startDate - b.startDate || U.chainageSortKey(a.id) - U.chainageSortKey(b.id));

    /* ---- 9. per-profile material accounting (§6.3) ------------------------- */
    const profileRows = orderedCodes.map((code) => {
      const m = codeMaterial(code);
      const cands = byCode[code];
      const inboundWindow = m.inbound.filter((i) => U.cmpDate(i.usable, planStart) > 0 && U.cmpDate(i.usable, planEnd) <= 0)
        .reduce((s, i) => s + i.qty, 0);
      const available = startStock[code] + inboundWindow;
      const consumed = plan.consumedByCode[code] || 0;
      const startedHere = worked.filter((w) => w.code === code);
      const requiredStarted = startedHere.reduce((s, w) => s + w.mto, 0);
      return {
        code, profile: profileForCode(code),
        onsite: m.onsite, starting: startStock[code], inboundWindow, available,
        consumed, endStock: plan.stockEnd[code] != null ? plan.stockEnd[code] : startStock[code],
        candidateCount: cands.length, startedCount: startedHere.length,
        requiredStarted, shortfall: Math.max(0, requiredStarted - available)
      };
    });

    /* ---- 9b. day-by-day material availability per profile (pivot view) -----
       One row per item code used anywhere in this priority (workable OR blocked —
       inbound can still arrive for a blocked profile even if no work happens),
       one column per calendar day in the plan window (hindrance days included).
       Per day we expose:
         available = stock carried into that day (on-site + inbound already usable),
                     BEFORE that day's consumption;
         inbound   = qty becoming usable ON that day (arrival + 1-day buffer is
                     already baked into inb.usable in data.js);
         consumed  = left null for now (to be wired to the sim later).
       Availability is tracked on the real calendar so the 1-day arrival buffer and
       weekly-off/hindrance days line up with the rest of the plan. */
    const pivotCodes = Array.from(new Set(candidates.map((f) => f.code).filter(Boolean)));
    const materialPivot = {
      days: cal.map((c) => ({ date: c.date, dayNum: c.dayNum, isWorking: c.isWorking, nonWorkReason: c.nonWorkReason })),
      rows: pivotCodes.map((code) => {
        const m = codeMaterial(code);
        // stock usable at (before) plan start = on-site + inbound usable on/before planStart
        let stock = m ? m.onsite : 0;
        if (m) m.inbound.forEach((inb) => { if (U.cmpDate(inb.usable, planStart) <= 0) stock += inb.qty; });
        const cells = cal.map((c) => {
          const inbound = m ? m.inbound.reduce((s, inb) => s + (U.sameDay(inb.usable, c.date) ? inb.qty : 0), 0) : 0;
          stock += inbound;                    // material lands on its usable date, working or not
          const available = stock;             // carried into the day, before consumption
          return { available, inbound, consumed: null };
        });
        return { code, profile: profileForCode(code), onsite: m ? m.onsite : 0, cells };
      }).sort((a, b) => a.profile.localeCompare(b.profile))
    };

    /* ---- 10. feasibility + warnings (§6.3) --------------------------------- */
    const installable = plan.totalInstalled;
    const pctComplete = totalMTO > 0 ? (installable / totalMTO) * 100 : 0;
    const carryOver = Math.max(0, totalMTO - installable);
    const idleMachines = maxMachines - deployed;
    const steadyDaily = p.productivity * p.workhours;

    // Each warning carries a `code` so the per-warning confirmation flow knows how a
    // "decline" should adjust the plan to clear it (see ui.js applyAdjustment).
    const warnings = [];
    if (cap === 0) warnings.push({ code: "noManpower", level: "bad", text: "Manpower (" + p.manpower + ") supports 0 machines (6 per machine). No installation is possible — increase manpower." });
    else if (capApplied) warnings.push({ code: "cap", level: "warn", text: "Machine cap applied: input " + p.machinesInput + " capped to " + cap + " (manpower " + p.manpower + " ÷ 6 = " + cap + " × 6 = " + (cap * 6) + " people)." });
    if (blocked.length) warnings.push({ code: "blocked", level: "bad", text: blocked.length + " chainage(s) blocked — profile has no material on-site or inbound (" + U.fmtInt(blockedMTO) + " piles of scope, carried over)." });
    const shortfalls = profileRows.filter((r) => r.startedCount > 0 && r.shortfall > 0);
    if (shortfalls.length) warnings.push({ code: "shortfall", level: "warn", text: shortfalls.length + " profile(s) cannot fully cover their in-progress chainages from window material (shortfall total " + U.fmtInt(shortfalls.reduce((s, r) => s + r.shortfall, 0)) + " piles)." });
    if (lostDays.length) warnings.push({ code: "hindranceDays", level: "warn", text: lostDays.length + " working day(s) removed by hindrances (" + lostDays.map((d) => U.fmtShort(d)).join(", ") + "); installation shifts past them." });
    if (hindHours > EPS) warnings.push({ code: "hindranceHours", level: "warn", text: U.fmtNum(hindHours, 1) + " work-hour(s) trimmed by hindrances on " + trimmedDays.map((d) => U.fmtShort(d)).join(", ") + "." });
    if (idleMachines > 0) warnings.push({ code: "idle", level: "warn", text: "Over-provisioned: only " + deployed + " machine(s) are needed — " + idleMachines + " of the " + maxMachines + " would sit idle (add zero piles). Beyond " + deployed + " machines the window is material/work limited at " + U.fmtInt(Math.round(maxInstalled)) + " piles. Recommend deploying " + deployed + "." });
    if (plan.idleMachineDays > 0 && idleMachines === 0) warnings.push({ code: "idleDays", level: "info", text: plan.idleMachineDays + " machine-day(s) idle within the window (ran out of queued work)." });
    if (carryOver > 0) warnings.push({ code: "carryOver", level: "info", text: U.fmtInt(carryOver) + " piles of " + p.priority + " scope carry over beyond this window (" + U.fmtNum(pctComplete, 1) + "% completed)." });
    // Warnings the planner declined-but-acknowledged (no structural fix available, e.g.
    // carry-over / idle days) are suppressed so they clear from the list.
    if (p.suppressCodes && p.suppressCodes.length) {
      for (let i = warnings.length - 1; i >= 0; i--) if (p.suppressCodes.indexOf(warnings[i].code) >= 0) warnings.splice(i, 1);
    }
    if (!warnings.length) warnings.push({ code: "ok", level: "ok", text: "No blocking issues detected for this plan." });

    return {
      params: p, planStart, planEnd, totalDays, cap, maxMachines, deployed, idleMachines, capApplied,
      manpowerCapped: maxMachines, calendar: cal, workingDayCount,
      queue, worked, blocked, candidates, totalMTO, blockedMTO,
      startStock, windowArrivals, profileRows, materialPivot,
      perM, schedule: plan.schedule, totalInstalled: installable, idleMachineDays: plan.idleMachineDays,
      steadyDaily, effectiveDailyCapacity: steadyDaily * deployed,
      pctComplete, carryOver, hindDays: lostDays.length, hindHours, lostDays, trimmedDays,
      rampProfile, warnings
    };
  };
})();
