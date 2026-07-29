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
    const chainage = store.chainage, material = store.material, progress = store.progress;
    const planStart = p.planStart;
    const totalDays = p.periodWeeks * 7;
    const planEnd = U.addDays(planStart, totalDays - 1);

    /* ---- 1. manpower cap (§4 validation: 6 people per machine) ------------- */
    const cap = Math.floor(p.manpower / 6);
    const maxMachines = Math.max(0, Math.min(p.machinesInput, cap));
    const capApplied = p.machinesInput > cap;

    /* ---- 2. candidate chainages + prior progress + blocked detection ------- */
    const prioritiesSet = new Set(p.priorities || []);
    const candidates = chainage.features.filter((f) => prioritiesSet.has(f.priority));

    // Piles already installed per chainage (from progress history, current rows).
    const installedByChainage = (progress && progress.installedByChainage) || {};
    // Piles already installed on a chainage (from progress history).
    function priorInstalled(f) { return installedByChainage[f.name] || 0; }
    // Remaining scope per chainage = full MTO minus what's already installed.
    const remainingById = {}, priorById = {};
    candidates.forEach((f) => {
      const prior = priorInstalled(f);
      priorById[f.id] = prior;
      remainingById[f.id] = Math.max(0, f.mto - prior);
    });
    // Completed chainages drop out of the plan entirely; only "active" (remaining > 0)
    // chainages are planned. "partial" = already started (has progress) but not finished.
    const completed = candidates.filter((f) => f.mto > 0 && remainingById[f.id] <= 0);
    const active = candidates.filter((f) => remainingById[f.id] > 0);
    const partial = candidates.filter((f) => (priorById[f.id] || 0) > 0 && remainingById[f.id] > 0);

    // Material record for an item code (or null if absent).
    function codeMaterial(code) { return material.byCode[code] || null; }
    // Material already consumed per item code = piles already installed across ALL
    // chainages (any priority) that use this code — they drew from the same pool.
    const codeConsumedPrior = {};
    chainage.features.forEach((f) => {
      const prior = installedByChainage[f.name] || 0;
      if (f.code && prior > 0) codeConsumedPrior[f.code] = (codeConsumedPrior[f.code] || 0) + prior;
    });
    // "Accepted at Site" is gross received, so on-site stock still available now =
    // accepted-at-site minus what's already been consumed by installed piles.
    function netOnsite(code) {
      const m = codeMaterial(code);
      if (!m) return 0;
      return Math.max(0, m.onsite - (codeConsumedPrior[code] || 0));
    }
    // An inbound delivery is only usable if it actually arrives on/after the plan
    // start. Overdue on-hold material (Expected Arrival already past, not yet
    // delivered) is NOT on site, so it does not count as available for this plan.
    function arrivesInPlan(inb) { return U.cmpDate(inb.arrival, planStart) >= 0; }
    // Net on-site stock + in-window inbound available for a code.
    function totalMaterialQty(code) {
      const m = codeMaterial(code);
      if (!m) return 0;
      return netOnsite(code) + m.inbound.reduce((s, i) => s + (arrivesInPlan(i) ? i.qty : 0), 0);
    }
    const workable = [], blocked = [];
    active.forEach((f) => {
      if (!f.code || totalMaterialQty(f.code) <= 0) blocked.push(f);
      else workable.push(f);
    });
    const blockedMTO = blocked.reduce((s, f) => s + remainingById[f.id], 0);   // remaining piles blocked
    // Full priority scope (all chainages, full MTO) — for reporting completion %.
    const totalMTO = candidates.reduce((s, f) => s + f.mto, 0);
    const installedPriorTotal = candidates.reduce((s, f) => s + priorById[f.id], 0);
    const remainingMTO = candidates.reduce((s, f) => s + remainingById[f.id], 0);

    /* ---- 3. per-code material state at plan start (§5.3) -------------------- */
    // startingStock = Accepted-at-Site on-site stock only.
    // replenishments = inbound that arrives on/after plan start (dated events);
    //   overdue on-hold material (arrival already past) is not available at all.
    const startStock = {};
    const replen = [];                       // {usable, code, qty}
    const usedCodes = Array.from(new Set(workable.map((f) => f.code)));
    usedCodes.forEach((code) => {
      const m = codeMaterial(code);
      startStock[code] = netOnsite(code);    // accepted-at-site minus already-consumed
      m.inbound.forEach((inb) => {
        // Arrives within the plan → replenishes stock on its usable date (arrival + 1).
        // Overdue pre-window on-hold material is skipped entirely (not on site).
        if (arrivesInPlan(inb)) replen.push({ usable: inb.usable, code: code, qty: inb.qty });
      });
    });
    replen.sort((a, b) => U.cmpDate(a.usable, b.usable));

    // Inbound arrivals that land within the plan window (markers / timeline).
    const windowArrivals = replen
      .filter((ev) => U.cmpDate(ev.usable, planEnd) <= 0)
      .map((ev) => ({ date: ev.usable, code: ev.code, qty: ev.qty,
                      profile: profileForCode(ev.code) }))
      .sort((a, b) => U.cmpDate(a.date, b.date));

    // Display profile name (Item Description) for an item code.
    function profileForCode(code) {
      const f = workable.find((w) => w.code === code) || candidates.find((c) => c.code === code);
      return f ? f.profile : code;
    }

    /* ---- 4. ordered work queue (§5.2) -------------------------------------- */
    // Profiles ranked by starting on-site stock available at plan start (desc) — i.e.
    // by MATERIAL AVAILABILITY. Within a profile the order is:
    //   (1) partially-installed chainages first (finish work already started), then
    //   (2) untouched chainages nearest to the already-worked "frontier" (so work
    //       continues contiguously from the latest completed/started chainage),
    //   (3) ties broken by Chainage_Id.
    const byCode = {};
    workable.forEach((f) => { (byCode[f.code] || (byCode[f.code] = [])).push(f); });
    const orderedCodes = Object.keys(byCode).sort((a, b) =>
      (startStock[b] - startStock[a]) || profileForCode(a).localeCompare(profileForCode(b)));
    // Per profile, the "work front" = the chainage with the MOST RECENT progress date.
    // Untouched chainages then continue outward from that anchor (nearest first), so
    // the crew keeps advancing from wherever it last worked.
    const lastInstallByChainage = (progress && progress.lastInstallByChainage) || {};
    const anchorByCode = {}, anchorTime = {};
    candidates.forEach((f) => {
      if (!f.code || (priorById[f.id] || 0) <= 0) return;
      const dt = lastInstallByChainage[f.name];
      const t = dt ? dt.getTime() : 0;
      // latest date wins; on a tie take the further-along chainage (higher sortKey)
      if (anchorByCode[f.code] == null || t > anchorTime[f.code] ||
         (t === anchorTime[f.code] && f.sortKey > anchorByCode[f.code])) {
        anchorByCode[f.code] = f.sortKey; anchorTime[f.code] = t;
      }
    });
    // True if a chainage is started (has prior progress) but not finished.
    function isPartial(f) { return (priorById[f.id] || 0) > 0 && remainingById[f.id] > 0; }
    // Distance in sort order from the profile's last-worked frontier chainage.
    function distToAnchor(f) {
      const a = anchorByCode[f.code];
      if (a == null) return Infinity;          // fresh profile → fall back to Chainage_Id order
      return Math.abs(f.sortKey - a);
    }
    // Work-queue order: higher priority first (P-1a > P-1b > P-1c > P-2 > ...), then
    // partials, then nearest to the frontier, then Chainage_Id.
    function queueCmp(x, y) {
      const pr = U.priorityOrder(x.priority) - U.priorityOrder(y.priority);
      if (pr !== 0) return pr;                             // (1) higher-priority chainage first
      const px = isPartial(x) ? 0 : 1, py = isPartial(y) ? 0 : 1;
      if (px !== py) return px - py;                       // (2) partials first
      if (px === 1) { const dx = distToAnchor(x), dy = distToAnchor(y); if (dx !== dy) return dx - dy; }  // (3) untouched: nearest to the latest-worked chainage
      return x.sortKey - y.sortKey;                        // (4) then by Chainage_Id
    }
    // Material available within the window per code (for the capToMaterial adjustment).
    function availWindow(code) {
      const m = codeMaterial(code);
      const inW = m.inbound.filter((i) => U.cmpDate(i.usable, planStart) > 0 && U.cmpDate(i.usable, planEnd) <= 0).reduce((s, i) => s + i.qty, 0);
      return startStock[code] + inW;
    }
    const queue = [];
    orderedCodes.forEach((code) => {
      const sorted = byCode[code].slice().sort(queueCmp);
      if (p.capToMaterial) {
        // Only queue chainages whose cumulative MTO fits the window material for this
        // profile, so no profile is started beyond what it can cover (clears shortfall).
        let cum = 0; const avail = availWindow(code);
        sorted.forEach((f) => { if (cum + remainingById[f.id] <= avail + EPS) { queue.push(f); cum += remainingById[f.id]; } });
      } else {
        sorted.forEach((f) => queue.push(f));
      }
    });
    // chById / st cover ALL active chainages (workable + blocked). In the normal
    // (material-constrained) run the blocked ones simply never have stock so they're
    // never worked — output is unchanged.
    const chById = {};
    active.forEach((f) => { chById[f.id] = f; });

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
    // Mark a calendar day as fully lost to a hindrance.
    function markLost(c) {
      c.isWorking = false; c.hours = 0; c.nonWorkReason = "Hindrance — day lost"; c.hindrance = true;
      lostDays.push(c.date);
    }
    // Trim hindrance hours from a day; mark it lost if hours hit zero.
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
    // Ramp multiplier applied on a machine's k-th working day.
    function rampFactor(k) { return rampProfile[Math.min(k, rampProfile.length - 1)]; }

    // The window plan runs over `cal` with the (optionally material-capped) `queue`.
    // The finish projection (§11) reuses this over a longer calendar with the full
    // uncapped queue — hence the optional calDays / queueArr parameters.
    function simulate(M, calDays, queueArr, opts) {
      const days = calDays || cal;
      const q = queueArr || queue;
      const unlimited = !!(opts && opts.unlimited);   // treat material as infinite (capacity-only ceiling)
      const stock = Object.assign({}, startStock);
      const repl = replen.map((r) => ({ usable: r.usable, code: r.code, qty: r.qty }));
      const st = {};
      active.forEach((f) => { st[f.id] = { done: 0, started: false, startDate: null, lastDate: null, completed: false, completedDate: null, machine: null }; });
      const assign = new Array(M).fill(null);
      let totalInstalled = 0, idleMachineDays = 0, workingOrdinal = -1;
      let lastInstallDate = null;
      const schedule = [];
      const consumedByCode = {};

      // Pending work pool = queue order (priority → material → frontier → Chainage_Id),
      // consumed lazily. We scan for the first chainage that (a) still has remaining scope
      // and (b) has usable material RIGHT NOW (skipped when `unlimited`), so a crew never
      // sits idle while a lower-priority selected chainage has stock. `taken` guards against
      // assigning the same chainage to two machines on the same day.
      const pending = q.map((f) => f.id);
      // Pull the next assignable chainage id (highest queue order first) that still has scope
      // and — unless material is unlimited — usable stock right now. Returns null when nothing
      // is workable; skipped work stays in `pending` and resumes once its material arrives.
      function nextWorkable(taken) {
        for (let k = 0; k < pending.length; k++) {
          const id = pending[k];
          if (id == null || taken.has(id)) continue;
          const s = st[id];
          if (s.completed || (remainingById[id] - s.done) <= EPS) { pending[k] = null; continue; }
          if (unlimited || (stock[chById[id].code] || 0) > EPS) { pending[k] = null; return id; }
        }
        return null;
      }

      days.forEach((day) => {
        // material arrives on its calendar date regardless of working status
        for (let r = 0; r < repl.length; r++) {
          if (repl[r].qty > 0 && U.sameDay(repl[r].usable, day.date)) { stock[repl[r].code] += repl[r].qty; repl[r].qty = 0; }
        }
        if (!day.isWorking) return;
        workingOrdinal++;

        // Reserve chainages still in progress (unfinished) so two machines never work the
        // same chainage on the same day; drop any that finished on an earlier day.
        const taken = new Set();
        for (let i = 0; i < M; i++) {
          const id = assign[i];
          if (id == null) continue;
          if ((remainingById[id] - st[id].done) <= EPS) { assign[i] = null; continue; }
          taken.add(id);
        }

        // Each machine spends a FULL day's capacity, flowing across chainages: when it
        // finishes its current chainage (or that chainage runs out of material) and capacity
        // remains, it picks up the next workable chainage with material and keeps going.
        for (let i = 0; i < M; i++) {
          const isNew = i >= p.prevMachines;
          const factor = isNew ? rampFactor(workingOrdinal) : 1.0;
          // Whole-pile daily budget: a pile can't be partially installed, so a machine's
          // capacity for the day is the CEIL of productivity × workhours × ramp factor
          // (e.g. ceil(2.936 × 9) = 27). All installs below are therefore whole piles,
          // and the budget flows across chainages in whole piles.
          const dayCap = Math.ceil(p.productivity * factor * day.hours);   // this machine's capacity for the day
          let budget = dayCap, workedToday = false, guard = 0;

          while (budget > EPS && guard++ < 100000) {
            let id = assign[i];
            const done = id != null && (remainingById[id] - st[id].done) <= EPS;
            const starved = id != null && !done && !unlimited && (stock[chById[id].code] || 0) <= EPS;
            if (id == null || done || starved) {
              if (starved && pending.indexOf(id) < 0) pending.push(id);   // resume later when material arrives
              if (id != null) assign[i] = null;
              const nid = nextWorkable(taken);
              if (nid == null) break;                            // nothing workable → machine stops for the day
              assign[i] = nid; taken.add(nid); id = nid;
            }
            const ch = chById[id], s = st[id];
            if (!s.started) { s.started = true; s.startDate = day.date; s.machine = i + 1; }
            const avail = unlimited ? Infinity : (stock[ch.code] || 0);
            const prior = priorById[id] || 0;
            const remaining = remainingById[id] - s.done;
            const install = Math.min(budget, remaining, avail);
            if (install <= EPS) break;                           // safety: nothing installable
            s.done += install; budget -= install;
            if (!unlimited) stock[ch.code] = avail - install;
            s.lastDate = day.date;
            totalInstalled += install; workedToday = true;
            lastInstallDate = day.date;
            consumedByCode[ch.code] = (consumedByCode[ch.code] || 0) + install;
            schedule.push({
              date: day.date, dayNum: day.dayNum, machine: i + 1, chId: id,
              profile: ch.profile, code: ch.code, install: install,
              cum: prior + s.done, mto: ch.mto, priorInstalled: prior,   // cum/mto are TOTALS
              stockEnd: unlimited ? Infinity : stock[ch.code], capacity: dayCap,
              waiting: false
            });
            if (s.done >= remainingById[id] - EPS) { s.completed = true; s.completedDate = day.date; assign[i] = null; }
            // budget may remain → loop continues onto the next workable chainage
          }
          if (!workedToday) idleMachineDays++;
        }
      });
      const allWorkableDone = workable.every((f) => st[f.id].completed);
      return { totalInstalled, schedule, state: st, stockEnd: stock, consumedByCode, idleMachineDays, lastInstallDate, allWorkableDone };
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
                 done: (priorById[f.id] || 0) + s.done,          // total installed (prior + this plan)
                 thisPlan: s.done, priorInstalled: priorById[f.id] || 0,
                 machine: s.machine, startDate: s.startDate,
                 lastDate: s.lastDate, completed: s.completed, completedDate: s.completedDate };
      })
      .sort((a, b) => a.machine - b.machine || a.startDate - b.startDate || U.chainageSortKey(a.id) - U.chainageSortKey(b.id));

    /* ---- 8b. length covered (km) — wall length proportional to piles installed
       (prior + this plan) per chainage, summed over the priority. */
    const thisPlanById = {};
    worked.forEach((w) => { thisPlanById[w.id] = w.thisPlan || 0; });
    let lengthScopeMm = 0, lengthCoveredMm = 0, lengthThisWindowMm = 0;
    candidates.forEach((f) => {
      const L = f.lengthMm || 0;
      lengthScopeMm += L;
      if (f.mto > 0) {
        const done = (priorById[f.id] || 0) + (thisPlanById[f.id] || 0);
        lengthCoveredMm += L * Math.min(1, done / f.mto);
        lengthThisWindowMm += L * Math.min(1, (thisPlanById[f.id] || 0) / f.mto);
      }
    });
    const totalScopeLengthKm = lengthScopeMm / 1e6;
    const lengthCoveredKm = lengthCoveredMm / 1e6;
    const lengthThisWindowKm = lengthThisWindowMm / 1e6;

    /* ---- 9. per-profile material accounting (§6.3) ------------------------- */
    const profileRows = orderedCodes.map((code) => {
      const m = codeMaterial(code);
      const cands = byCode[code];
      const inboundWindow = m.inbound.filter((i) => U.cmpDate(i.usable, planStart) > 0 && U.cmpDate(i.usable, planEnd) <= 0)
        .reduce((s, i) => s + i.qty, 0);
      const available = startStock[code] + inboundWindow;
      const consumed = plan.consumedByCode[code] || 0;
      const startedHere = worked.filter((w) => w.code === code);
      const requiredStarted = startedHere.reduce((s, w) => s + (w.mto - w.priorInstalled), 0);   // remaining piles
      return {
        code, profile: profileForCode(code),
        onsite: netOnsite(code), starting: startStock[code], inboundWindow, available,
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
         available = net on-site stock (Accepted-at-Site minus already-consumed) PLUS
                     inbound that actually ARRIVES WITHIN this plan window and is
                     usable by that day (usable = arrival + 1), MINUS what the plan has
                     already consumed on earlier days. So it is the balance carried
                     into the day, before that day's consumption. Overdue pre-window
                     expected material is excluded (it is not physically on site).
         inbound   = qty ARRIVING on that day (its Expected Arrival date), not counted
                     in Available until the following day.
         consumed  = piles the plan installs of this code on that day; the balance
                     (available - consumed) carries into the next day.
       Availability is tracked on the real calendar so the 1-day arrival buffer and
       weekly-off/hindrance days line up with the rest of the plan. */
    // Plan consumption per item code per day (from the chosen plan's schedule).
    const consumedByCodeDay = {};
    plan.schedule.forEach((e) => {
      const iso = U.fmtISO(e.date);
      const byDay = consumedByCodeDay[e.code] || (consumedByCodeDay[e.code] = {});
      byDay[iso] = (byDay[iso] || 0) + e.install;
    });
    const pivotCodes = Array.from(new Set(candidates.map((f) => f.code).filter(Boolean)));
    const materialPivot = {
      days: cal.map((c) => ({ date: c.date, dayNum: c.dayNum, isWorking: c.isWorking, nonWorkReason: c.nonWorkReason })),
      rows: pivotCodes.map((code) => {
        const base = netOnsite(code);            // net on-site (accepted-at-site − already-consumed)
        const m = codeMaterial(code);
        const inbList = m ? m.inbound : [];
        const cd = consumedByCodeDay[code] || {};
        let consumedCum = 0;
        const cells = cal.map((c) => {
          const iso = U.fmtISO(c.date);
          // Inbound column = qty arriving on this day (Expected Arrival date).
          const inbound = inbList.reduce((s, inb) => s + (U.sameDay(inb.arrival, c.date) ? inb.qty : 0), 0);
          // Received = in-window arrivals already usable by this day (arrival + 1).
          const received = inbList.reduce((s, inb) =>
            s + (U.cmpDate(inb.arrival, planStart) >= 0 && U.cmpDate(inb.usable, c.date) <= 0 ? inb.qty : 0), 0);
          const available = base + received - consumedCum;   // balance carried in, before today's use
          const consumed = cd[iso] || 0;
          consumedCum += consumed;
          return { available, inbound, consumed };
        });
        return { code, profile: profileForCode(code), onsite: base, cells };
      }).sort((a, b) => a.profile.localeCompare(b.profile))
    };

    /* ---- 9c. estimated finish date for the ENTIRE selected priority --------
       Logic: project the SAME crew (recommended `deployed` machines), the same
       productivity, work-week and hindrance schedule, and the same material-arrival
       timeline forward — past the plan window — until every workable chainage's
       remaining scope is installed. Material that lands in the future unlocks its
       chainages on its usable date, so the estimate waits for slow deliveries.
       Blocked chainages (no usable material at all) can never be installed, so a
       date that covers 100% of the priority only exists when nothing is blocked. */
    let projectedFinish = null, finishCoversAll = false, projFinishWorkingDays = null,
        unachievablePiles = 0, projTimeLimited = false;
    const projLastDateByCode = {};   // per material: last day it installs in the full projection (its material run-dry day)
    if (deployed > 0 && remainingMTO > EPS) {
      // Full, uncapped queue = every workable chainage, all its remaining piles.
      const fullQueue = [];
      orderedCodes.forEach((code) => {
        byCode[code].slice().sort((x, y) => x.sortKey - y.sortKey).forEach((f) => fullQueue.push(f));
      });
      // Extend the working calendar past the window (cap ~2 years) so large scopes
      // and slow material arrivals still resolve. Window days keep their hindrances.
      const HORIZON = 730;
      const projCal = cal.slice();
      for (let i = totalDays; i < HORIZON; i++) {
        const d = U.addDays(planStart, i);
        projCal.push({ date: d, dayNum: i + 1, isWorking: U.isoDow(d) <= p.workDaysPerWeek, hours: p.workhours, nonWorkReason: null });
      }
      const proj = simulate(deployed, projCal, fullQueue);
      proj.schedule.forEach((e) => {   // record each material's last install day (when its stock runs dry)
        if (e.install > 0 && (!projLastDateByCode[e.code] || U.cmpDate(e.date, projLastDateByCode[e.code]) > 0)) projLastDateByCode[e.code] = e.date;
      });
      projectedFinish = proj.lastInstallDate;                                   // last achievable install
      unachievablePiles = Math.max(0, Math.round(remainingMTO - proj.totalInstalled));  // blocked + material-short
      finishCoversAll = unachievablePiles <= 0;                                 // whole remaining priority done
      if (projectedFinish) projFinishWorkingDays = projCal.filter((c) => c.isWorking && U.cmpDate(c.date, projectedFinish) <= 0).length;
      // If work was still running at the horizon edge, the true finish is beyond it.
      const horizonEnd = projCal[projCal.length - 1].date;
      projTimeLimited = !finishCoversAll && !!projectedFinish && U.cmpDate(projectedFinish, U.addDays(horizonEnd, -7)) >= 0;
    }

    /* ---- 10. feasibility + warnings (§6.3) --------------------------------- */
    const installable = plan.totalInstalled;                       // installed THIS window
    const totalComplete = installedPriorTotal + installable;       // prior + this window
    const pctComplete = totalMTO > 0 ? (totalComplete / totalMTO) * 100 : 0;
    const carryOver = Math.max(0, totalMTO - totalComplete);       // remaining beyond this window
    const idleMachines = maxMachines - deployed;
    const steadyDaily = p.productivity * p.workhours;
    const effectiveDailyCapacity = steadyDaily * deployed;

    /* ---- 10b. capacity-only run (isolates the material-caused shortfall) -----
       Re-run the SAME crew (`deployed`), calendar (hindrances applied), ramp curve,
       mid-day flow AND the SAME work queue as the real plan, but with material
       treated as UNLIMITED. Using the identical queue means the only thing that can
       differ is material, so comparing chainage-by-chainage cleanly splits the gap:
         materialShortfall = piles the crew could have reached this window but
                             didn't, purely because material wasn't available;
         timeShortfall     = scope that wouldn't fit this window even with unlimited
                             material (pure time/machine limit).
       The two always sum to carryOver. */
    let capacityOnly = 0, materialShortfall = 0, timeShortfall = carryOver;
    const materialAffected = [];   // chainages held back THIS WINDOW by material
    const windowDemandByCode = {};  // per material: piles this plan would install THIS WINDOW if material were unlimited
    if (deployed > 0 && remainingMTO > EPS) {
      const capPlan = simulate(deployed, null, null, { unlimited: true });
      capacityOnly = Math.min(capPlan.totalInstalled, remainingMTO);
      materialShortfall = Math.max(0, capacityOnly - installable);
      timeShortfall = Math.max(0, remainingMTO - capacityOnly);
      active.forEach((f) => {
        const capDone = (capPlan.state[f.id] && capPlan.state[f.id].done) || 0;
        if (f.code) windowDemandByCode[f.code] = (windowDemandByCode[f.code] || 0) + capDone;   // plan-period demand
        const realDone = (plan.state[f.id] && plan.state[f.id].done) || 0;
        const lost = capDone - realDone;
        if (lost > EPS) materialAffected.push({ id: f.id, lost, realDone, fully: realDone <= EPS });
      });
    }

    /* ---- 10c. material-wise check for THIS PLAN PERIOD ---------------------
       One row per material the plan works this window. Required = capacity-only
       window demand (what the plan would install for that material this period if
       material were unlimited); In stock = net Accepted-at-Site now; In transit =
       ordered material arriving within the window; Gap = period demand not covered;
       Work halts on = the day it runs dry (only when short this period). */
    const scopeByCode = {};
    candidates.forEach((f) => { if (f.code) (scopeByCode[f.code] || (scopeByCode[f.code] = [])).push(f); });
    const materialCheck = Object.keys(windowDemandByCode).map((code) => {
      const required = Math.round(windowDemandByCode[code]);
      const inStock = Math.max(0, Math.round(netOnsite(code)));
      const m = codeMaterial(code);   // null when the code has no material-file entry
      const inTransit = m ? Math.round(m.inbound
        .filter((i) => U.cmpDate(i.usable, planStart) > 0 && U.cmpDate(i.usable, planEnd) <= 0)
        .reduce((s, i) => s + i.qty, 0)) : 0;
      const gap = Math.max(0, required - inStock - inTransit);
      const cands = scopeByCode[code] || [];
      const priority = Array.from(new Set(cands.map((f) => f.priority).filter(Boolean)))
        .sort((a, b) => U.priorityOrder(a) - U.priorityOrder(b)).join(", ");
      return { code, profile: profileForCode(code), priority, required, inStock, inTransit, gap,
               haltDate: gap > 0 ? (projLastDateByCode[code] || null) : null };
    }).filter((r) => r.required > 0).sort((a, b) => b.required - a.required);
    const materialHaltDate = materialCheck.reduce((min, r) =>
      (r.haltDate && (!min || U.cmpDate(r.haltDate, min) < 0)) ? r.haltDate : min, null);

    /* ---- 11. rate-only finish (ASSUME ALL MATERIAL ARRIVES) ----------------
       Ignoring material constraints entirely, how long to install the whole
       remaining priority purely at the steady daily capacity
       (productivity × workhours × deployed machines), respecting work-days/week? */
    let fullMaterialFinish = null, fullMaterialWorkingDays = null;
    if (deployed > 0 && effectiveDailyCapacity > EPS && remainingMTO > EPS) {
      fullMaterialWorkingDays = Math.ceil(remainingMTO / effectiveDailyCapacity);
      let count = 0, d = U.addDays(planStart, -1), guard = 0;
      while (count < fullMaterialWorkingDays && guard < 3650) {
        d = U.addDays(d, 1); guard++;
        if (U.isoDow(d) <= p.workDaysPerWeek) count++;   // count only working days
      }
      fullMaterialFinish = d;
    }

    // Each warning carries a `code` so the per-warning confirmation flow knows how a
    // "decline" should adjust the plan to clear it (see ui.js applyAdjustment).
    const warnings = [];
    if (cap === 0) warnings.push({ code: "noManpower", level: "bad", text: "Not enough manpower to run even one machine (need at least 6 people per machine). Add more manpower to continue." });
    else if (capApplied) warnings.push({ code: "cap", level: "warn", text: "You asked for " + p.machinesInput + " machines, but your manpower (" + p.manpower + " people) only supports " + cap + ". The plan uses " + cap + " machines instead." });
    // Chainages the crew WOULD have reached this window but couldn't (fully) install
    // because material wasn't available — a chainage-level attribution of
    // `materialShortfall` (§10b), scoped strictly to THIS plan window (not the whole
    // dataset). `fully` = couldn't be touched at all; otherwise only partly done.
    if (materialAffected.length && materialShortfall >= 0.5) {
      const fullyCount = materialAffected.filter((x) => x.fully).length;
      const partialCount = materialAffected.length - fullyCount;
      let blockedText = materialAffected.length + " chainage(s) can't be fully installed in this plan due to material shortage (" +
        U.fmtInt(Math.round(materialShortfall)) + " piles held back)";
      if (fullyCount > 0 && partialCount > 0) blockedText += " — " + fullyCount + " not started at all, " + partialCount + " only partly done";
      else if (partialCount > 0) blockedText += " — all only partly done, the rest still installs";
      blockedText += ".";
      warnings.push({ code: "blocked", level: "bad", text: blockedText });
    }
    const shortfalls = profileRows.filter((r) => r.startedCount > 0 && r.shortfall > 0);
    if (shortfalls.length) warnings.push({ code: "shortfall", level: "warn", text: shortfalls.length + " pile type(s) don't have enough material to finish the chainages already in progress — short by " + U.fmtInt(shortfalls.reduce((s, r) => s + r.shortfall, 0)) + " piles." });
    if (lostDays.length) warnings.push({ code: "hindranceDays", level: "warn", text: lostDays.length + " working day(s) are lost to hindrances (" + lostDays.map((d) => U.fmtShort(d)).join(", ") + ") — the plan skips these days." });
    if (hindHours > EPS) warnings.push({ code: "hindranceHours", level: "warn", text: U.fmtNum(hindHours, 1) + " work hour(s) are lost to a hindrance on " + trimmedDays.map((d) => U.fmtShort(d)).join(", ") + "." });
    if (idleMachines > 0) warnings.push({ code: "idle", level: "warn", text: "You only need " + deployed + " machine(s) — the other " + idleMachines + " would sit idle and add no extra piles. We recommend using just " + deployed + "." });
    if (plan.idleMachineDays > 0 && idleMachines === 0) warnings.push({ code: "idleDays", level: "info", text: "As per plan " + plan.idleMachineDays + " machine-day(s) idle in total (a machine idle for a day counts as one)." });
    if (carryOver > 0) {
      // "Expected scope" = capacityOnly — the crew/time-capacity ceiling for THIS
      // window (material-unlimited simulation), i.e. what this window could
      // realistically absorb workload-wise. installable = what actually gets
      // installed once material is accounted for; the gap between the two
      // (materialShortfall) is what material held back this window specifically.
      // Combined across every selected priority (material/queue is pooled), not
      // split per individual priority.
      let carryText = "Expected scope this window for " + p.priorities.join(", ") + ": " + U.fmtInt(Math.round(capacityOnly)) + " piles. " +
        U.fmtInt(Math.round(installable)) + " piles will actually be installed.";
      if (materialShortfall > EPS) carryText += " " + U.fmtInt(Math.round(materialShortfall)) + " piles cannot be installed due to material shortage.";
      warnings.push({ code: "carryOver", level: "info", text: carryText });
    }
    // Warnings the planner declined-but-acknowledged (no structural fix available, e.g.
    // carry-over / idle days) are suppressed so they clear from the list.
    if (p.suppressCodes && p.suppressCodes.length) {
      for (let i = warnings.length - 1; i >= 0; i--) if (p.suppressCodes.indexOf(warnings[i].code) >= 0) warnings.splice(i, 1);
    }
    if (!warnings.length) warnings.push({ code: "ok", level: "ok", text: "No blocking issues detected for this plan." });

    return {
      params: p, planStart, planEnd, totalDays, cap, maxMachines, deployed, idleMachines, capApplied,
      manpowerCapped: maxMachines, calendar: cal, workingDayCount,
      queue, worked, blocked, completed, partial, candidates, totalMTO, blockedMTO,
      installedPriorTotal, remainingMTO, totalComplete, completedCount: completed.length,
      totalScopeLengthKm, lengthCoveredKm, lengthThisWindowKm,
      projectedFinish, finishCoversAll, projFinishWorkingDays, unachievablePiles, projTimeLimited,
      fullMaterialFinish, fullMaterialWorkingDays,
      startStock, windowArrivals, profileRows, materialPivot, materialCheck, materialHaltDate,
      perM, schedule: plan.schedule, totalInstalled: installable, idleMachineDays: plan.idleMachineDays,
      steadyDaily, effectiveDailyCapacity,
      pctComplete, carryOver, capacityOnly, materialShortfall, timeShortfall,
      hindDays: lostDays.length, hindHours, lostDays, trimmedDays,
      rampProfile, warnings
    };
  };
})();
