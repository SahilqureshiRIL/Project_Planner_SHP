/* =============================================================================
   bluesky.js — the "Bluesky" target-date back-planner engine.

   Where engine.js runs FORWARD (given machines/manpower → how many piles &
   when does work finish), Bluesky runs BACKWARD: given a TARGET DATE and a set
   of priorities, it computes how many machines & how much manpower are needed
   to finish the remaining scope by that date — and whether material supply can
   actually sustain it (profile-wise availability, in-transit, gap/shortage and
   the date work would halt for want of material).

   SPP.bluesky.compute(store, params) -> a result object consumed by bluesky_ui.js.

   Material / prior-progress semantics mirror engine.js exactly (net Accepted-at-
   Site stock, inbound usable = arrival + 1, prior-installed netted per chainage
   and pooled per item code) so the two modules reconcile.
   ============================================================================= */
(function () {
  "use strict";
  const SPP = window.SPP;
  const U = SPP.util;
  const B = (SPP.bluesky = {});
  const EPS = 1e-6;

  // Per-priority remaining scope (piles + km) — used to label the priority picker.
  B.priorityScope = function (store) {
    const chainage = store.chainage, progress = store.progress;
    const installedByChainage = (progress && progress.installedByChainage) || {};
    const out = {};
    chainage.features.forEach((f) => {
      const o = out[f.priority] || (out[f.priority] = { priority: f.priority, chainages: 0, mto: 0, remaining: 0, scopeKm: 0, remainingKm: 0 });
      const prior = Math.min(installedByChainage[f.name] || 0, f.mto);
      const remaining = Math.max(0, f.mto - prior);
      const km = (f.lengthMm || 0) / 1e6;
      o.chainages++; o.mto += f.mto; o.remaining += remaining; o.scopeKm += km;
      o.remainingKm += f.mto > 0 ? km * (remaining / f.mto) : 0;
    });
    return out;
  };

  B.compute = function (store, p) {
    const chainage = store.chainage, material = store.material, progress = store.progress;
    const planStart = p.planStart;                 // Date — first Monday after latest actual record
    const target = p.targetDate;                   // Date — the date we want to finish by
    const prioritiesSet = new Set(p.priorities || []);
    const perMachineDaily = p.productivity * p.workhours;   // piles / machine / day (steady-state)

    /* ---- 1. remaining scope across the selected priorities ------------------ */
    const installedByChainage = (progress && progress.installedByChainage) || {};
    const candidates = chainage.features.filter((f) => prioritiesSet.has(f.priority));
    const rows = [];                               // {f, prior, remaining} for chainages with work left
    let remainingPiles = 0, remainingKm = 0, totalScopeKm = 0, priorTotal = 0, totalMTO = 0;
    candidates.forEach((f) => {
      const prior = Math.min(installedByChainage[f.name] || 0, f.mto);
      const remaining = Math.max(0, f.mto - prior);
      const km = (f.lengthMm || 0) / 1e6;
      totalScopeKm += km; totalMTO += f.mto; priorTotal += prior;
      if (remaining > EPS) {
        remainingPiles += remaining;
        remainingKm += f.mto > 0 ? km * (remaining / f.mto) : 0;
        rows.push({ f, prior, remaining });
      }
    });

    /* ---- 2. material state (shared by item code, netted like engine.js) ----- */
    // Piles already installed per item code across ALL priorities drew from the
    // same on-site pool, so net on-site stock = accepted-at-site − already-consumed.
    const codeConsumedPrior = {};
    chainage.features.forEach((f) => {
      const prior = installedByChainage[f.name] || 0;
      if (f.code && prior > 0) codeConsumedPrior[f.code] = (codeConsumedPrior[f.code] || 0) + prior;
    });
    function codeMaterial(code) { return material.byCode[code] || null; }
    function netOnsite(code) {
      const m = codeMaterial(code);
      return m ? Math.max(0, m.onsite - (codeConsumedPrior[code] || 0)) : 0;
    }
    // Profile label (Item Description) for an item code.
    const profileByCode = {};
    candidates.forEach((f) => { if (f.code && !profileByCode[f.code]) profileByCode[f.code] = f.profile; });
    function profileForCode(code) { return profileByCode[code] || code; }

    /* ---- 3. working days available until the target ------------------------- */
    let workingDays = 0;
    if (U.cmpDate(target, planStart) >= 0) {
      for (let d = new Date(planStart); U.cmpDate(d, target) <= 0; d = U.addDays(d, 1)) {
        if (U.isoDow(d) <= p.workDaysPerWeek) workingDays++;
      }
    }

    /* ---- 4. back-calculate the crew (the whole point of Bluesky) ------------ */
    const requiredRate = workingDays > 0 ? remainingPiles / workingDays : Infinity;  // piles / day
    let machinesNeeded;
    if (remainingPiles <= EPS) machinesNeeded = 0;                                    // nothing left to do
    else if (workingDays <= 0 || perMachineDaily <= EPS) machinesNeeded = Infinity;   // impossible in the window
    else machinesNeeded = Math.max(1, Math.ceil(requiredRate / perMachineDaily - 1e-9));
    const manpower = isFinite(machinesNeeded) ? machinesNeeded * 6 : Infinity;        // 6 people per machine (engine rule)

    /* ---- 5. per-priority-profile demand vs supply (at-site / in-transit / gap)
       One row per (priority, profile). Because material is a single on-site /
       in-transit pool per item code shared across priorities, that pool is
       ALLOCATED across the priorities that use the code in priority order
       (P-1a before P-1b … before P-2) — higher priority draws material first —
       so the per-row In Stock / In Transit still sum back to the code totals. */
    const groupKey = (prio, code) => prio + "|||" + code;
    const demandByGroup = {};
    rows.forEach((r) => {
      const code = r.f.code || "(no code)";
      const k = groupKey(r.f.priority, code);
      const g = demandByGroup[k] || (demandByGroup[k] = { priority: r.f.priority, code, demand: 0 });
      g.demand += r.remaining;
    });
    const groupsByCode = {};
    Object.keys(demandByGroup).forEach((k) => { const g = demandByGroup[k]; (groupsByCode[g.code] || (groupsByCode[g.code] = [])).push(g); });

    const profileRows = [];
    Object.keys(groupsByCode).forEach((code) => {
      const m = codeMaterial(code);
      const inbound = m ? m.inbound : [];
      // Shared pools for this code: on-site stock, in-transit usable by target, and later.
      let poolSite = netOnsite(code), poolTransit = 0, poolLater = 0;
      inbound.forEach((inb) => {
        if (U.cmpDate(inb.arrival, planStart) < 0) return;               // overdue pre-window on-hold: not counted
        if (U.cmpDate(inb.usable, target) <= 0) poolTransit += inb.qty;
        else poolLater += inb.qty;
      });
      // Allocate the pools to this code's priorities, highest priority first.
      groupsByCode[code].sort((a, b) => U.priorityOrder(a.priority) - U.priorityOrder(b.priority)).forEach((g) => {
        const siteAlloc = Math.min(g.demand, poolSite); poolSite -= siteAlloc;
        let rem = g.demand - siteAlloc;
        const transitAlloc = Math.min(rem, poolTransit); poolTransit -= transitAlloc; rem -= transitAlloc;
        const laterAlloc = Math.min(rem, poolLater); poolLater -= laterAlloc;
        profileRows.push({
          priority: g.priority, code, profile: profileForCode(code),
          demand: g.demand, atSite: siteAlloc, inTransitByTarget: transitAlloc, inTransitLater: laterAlloc,
          supplyByTarget: siteAlloc + transitAlloc, gap: Math.max(0, g.demand - siteAlloc - transitAlloc),
          haltsOn: null   // filled by the simulation below
        });
      });
    });
    // Sort by priority, then by Required (demand) descending.
    profileRows.sort((a, b) => U.priorityOrder(a.priority) - U.priorityOrder(b.priority) || b.demand - a.demand || a.profile.localeCompare(b.profile));
    const rowByGroup = {}; profileRows.forEach((r) => { rowByGroup[groupKey(r.priority, r.code)] = r; });

    /* ---- 6. material-aware simulation: when (if ever) does work halt? -------
       Run the crew forward at the computed capacity, drawing on-site stock and
       dated inbound arrivals. A profile "halts" the first working day its stock
       is exhausted while it still has remaining demand; the whole operation is
       considered halted the first working day nothing at all can be installed
       (every remaining profile is starved). Arrivals may later resume work, so
       we also report the projected completion date. */
    const stock = {}; Array.from(new Set(rows.map((r) => r.f.code))).forEach((c) => { if (c) stock[c] = netOnsite(c); });
    const arrivals = [];   // {usable, code, qty} for in-window inbound
    Object.keys(stock).forEach((code) => {
      const m = codeMaterial(code); if (!m) return;
      m.inbound.forEach((inb) => { if (U.cmpDate(inb.arrival, planStart) >= 0) arrivals.push({ usable: inb.usable, code, qty: inb.qty }); });
    });
    arrivals.sort((a, b) => U.cmpDate(a.usable, b.usable));

    // Work queue: by priority, then profiles with the most on-site stock first
    // (same spirit as engine.js §5.2), then chainage order. Track per-chainage done.
    const queue = rows.slice().sort((a, b) =>
      U.priorityOrder(a.f.priority) - U.priorityOrder(b.f.priority) ||
      (netOnsite(b.f.code) - netOnsite(a.f.code)) ||
      a.f.sortKey - b.f.sortKey);
    const done = new Array(queue.length).fill(0);

    let haltDate = null;                 // first working day with remaining work but zero installable
    let completionDate = null;           // day the last remaining pile is installed
    let installedTotal = 0;
    const HORIZON = 1460;                // ~4 years guard
    if (isFinite(machinesNeeded) && machinesNeeded > 0 && remainingPiles > EPS) {
      const dayCap = machinesNeeded * perMachineDaily;
      let ai = 0;
      let d = new Date(planStart);
      for (let i = 0; i < HORIZON && installedTotal < remainingPiles - EPS; i++, d = U.addDays(d, 1)) {
        while (ai < arrivals.length && U.cmpDate(arrivals[ai].usable, d) <= 0) { stock[arrivals[ai].code] += arrivals[ai].qty; ai++; }
        if (U.isoDow(d) > p.workDaysPerWeek) continue;    // non-working day
        let cap = dayCap, installedToday = 0;
        for (let q = 0; q < queue.length && cap > EPS; q++) {
          const need = queue[q].remaining - done[q];
          if (need <= EPS) continue;
          const code = queue[q].f.code;
          const avail = stock[code] || 0;
          if (avail <= EPS) {                             // this profile is starved today
            const gr = rowByGroup[groupKey(queue[q].f.priority, code)];
            if (gr && !gr.haltsOn) gr.haltsOn = new Date(d);
            continue;
          }
          const take = Math.min(need, avail, cap);
          done[q] += take; stock[code] = avail - take; cap -= take; installedToday += take; installedTotal += take;
        }
        if (installedToday <= EPS && !haltDate) haltDate = new Date(d);   // whole crew stalled for material
        if (installedTotal >= remainingPiles - EPS) { completionDate = new Date(d); break; }
      }
    } else if (remainingPiles <= EPS) {
      completionDate = planStart;
    }
    const materialShort = Math.max(0, remainingPiles - installedTotal);   // piles never installable within the horizon
    const gapTotal = profileRows.reduce((s, r) => s + r.gap, 0);

    /* ---- 7. verdict --------------------------------------------------------- */
    let verdict, verdictLevel;
    if (remainingPiles <= EPS) { verdict = "Nothing to plan — the selected priorities are already complete."; verdictLevel = "ok"; }
    else if (!isFinite(machinesNeeded)) {
      verdict = workingDays <= 0
        ? "The target date is not after the plan start — no working days available. Pick a later date."
        : "Productivity/workhours are zero — cannot compute a machine count.";
      verdictLevel = "bad";
    } else if (gapTotal > EPS) {
      verdict = machinesNeeded + " machine(s) would hit the date on rate, but material is short by " +
        U.fmtInt(gapTotal) + " pile(s) — work halts" + (haltDate ? " around " + U.fmtDate(haltDate) : "") +
        (completionDate && U.cmpDate(completionDate, target) > 0 ? "; earliest realistic finish " + U.fmtDate(completionDate) + "." : ".");
      verdictLevel = "warn";
    } else {
      verdict = "Feasible — deploy " + machinesNeeded + " machine(s) (" + U.fmtInt(manpower) +
        " people) to finish " + U.fmtInt(Math.round(remainingPiles)) + " pile(s) by " + U.fmtDate(target) + ".";
      verdictLevel = "ok";
    }

    /* ---- 8. probability of success (schedule-led, Bluesky only) ------------
       A weighted geometric mean of three factors derived from the site's
       ACTUALS vs. what this target date demands. Material is deliberately
       excluded (it is surfaced separately in the gap table). Geometric so one
       weak factor pulls the score down; clamped to (2%, 98%) so it is never a
       false 0% / 100% certainty. */
    const probability = successProbability(p, machinesNeeded, dailyInstallSeries(progress));

    /* ---- 9. chainage-wise / machine-wise schedule (material UNLIMITED) -----
       A day-by-day plan for the computed crew at steady productivity, ignoring
       material entirely (Bluesky assumes unlimited supply). One chainage per
       machine per day (same model as the planner's table); a machine picks the
       next queued chainage the day after it finishes one. Runs from plan start
       over working days until the whole remaining scope is installed. */
    const schedule = [];
    const scheduleCalendar = [];
    if (isFinite(machinesNeeded) && machinesNeeded > 0 && remainingPiles > EPS) {
      const M = machinesNeeded, capPerMachine = perMachineDaily;
      const q = rows.slice().sort((a, b) =>
        U.priorityOrder(a.f.priority) - U.priorityOrder(b.f.priority) || a.f.sortKey - b.f.sortKey);
      const stt = q.map((r) => ({ f: r.f, prior: r.prior, remaining: r.remaining, done: 0, machine: null }));
      const assign = new Array(M).fill(-1);      // machine slot -> index into stt (-1 = idle)
      let qptr = 0, dayNum = 0, guard = 0, remainingLeft = remainingPiles;
      const HMAX = 3650;
      let d = new Date(planStart);
      while (remainingLeft > EPS && guard < HMAX) {
        guard++;
        if (U.isoDow(d) <= p.workDaysPerWeek) {
          dayNum++;
          scheduleCalendar.push({ date: new Date(d), dayNum: dayNum, isWorking: true });
          for (let i = 0; i < M; i++) if (assign[i] < 0 && qptr < stt.length) assign[i] = qptr++;
          for (let i = 0; i < M; i++) {
            const si = assign[i];
            if (si < 0) continue;
            const s = stt[si];
            const need = s.remaining - s.done;
            if (need <= EPS) { assign[i] = -1; continue; }
            if (s.machine == null) s.machine = i + 1;
            const install = Math.min(capPerMachine, need);
            s.done += install; remainingLeft -= install;
            schedule.push({ date: new Date(d), dayNum: dayNum, machine: i + 1, chId: s.f.id,
              profile: s.f.profile, code: s.f.code, install: install,
              cum: s.prior + s.done, mto: s.f.mto, priorInstalled: s.prior });
            if (s.done >= s.remaining - EPS) assign[i] = -1;   // free the machine for the next day
          }
        }
        d = U.addDays(d, 1);
      }
    }
    const scheduleWorked = Object.keys(schedule.reduce((m, e) => ((m[e.chId] = 1), m), {})).length;
    const scheduleFinish = schedule.length ? schedule[schedule.length - 1].date : null;

    return {
      params: p, planStart, target, workingDays, perMachineDaily,
      priorities: p.priorities.slice(),
      candidateCount: candidates.length, activeCount: rows.length,
      remainingPiles, remainingKm, totalScopeKm, totalMTO, priorTotal,
      requiredRate, machinesNeeded, manpower,
      profileRows, gapTotal, materialShort,
      haltDate, completionDate,
      verdict, verdictLevel, probability,
      schedule, scheduleCalendar, scheduleWorked, scheduleFinish
    };
  };

  /* Recent daily install throughput (piles on days that logged installs), most
     recent 30 records — the raw material for the consistency factor. */
  function dailyInstallSeries(progress) {
    const byDate = (progress && progress.installedByDate) || {};
    return Object.keys(byDate).sort().slice(-30).map((k) => byDate[k]).filter((v) => v > 0);
  }

  // Schedule-led probability of success. Weights (crew 0.47, productivity 0.40,
  // consistency 0.13) renormalized from the schedule-led set with material dropped.
  function successProbability(p, machinesNeeded, dailyInstalls) {
    const W = { mac: 0.47, prod: 0.40, cons: 0.13 };

    // 1. Crew scalability — machinesNeeded vs. the machines your actual crew can
    //    field (min of recent machines and what recent manpower supports, 6/machine).
    const baseMac = p.baselineMachines || 0;
    const mpMac = Math.floor((p.baselineManpower || 0) / 6);
    const baseCap = Math.max(1, (baseMac && mpMac) ? Math.min(baseMac, mpMac) : (baseMac || mpMac || 1));
    const x = isFinite(machinesNeeded) ? machinesNeeded / baseCap : Infinity;
    const S_mac = isFinite(x) ? Math.exp(-0.55 * Math.max(0, x - 1)) : 0.001;

    // 2. Productivity realism — assumed vs. actual recent productivity. Optimistic
    //    (input above actual) is penalized; conservative saturates near 1.
    const ap = p.actualProductivity || 0;
    let S_prod;
    if (ap <= 0) S_prod = 0.6;                                   // no actuals → neutral
    else { const y = p.productivity / ap; S_prod = 1 / (1 + Math.max(0, y - 1)); }

    // 3. Delivery consistency — coefficient of variation of recent daily output.
    let S_cons, cv = null;
    if (!dailyInstalls || dailyInstalls.length < 3) S_cons = 0.7;   // too little data → neutral
    else {
      const mean = dailyInstalls.reduce((s, v) => s + v, 0) / dailyInstalls.length;
      if (mean <= 0) S_cons = 0.7;
      else {
        const variance = dailyInstalls.reduce((s, v) => s + (v - mean) * (v - mean), 0) / dailyInstalls.length;
        cv = Math.sqrt(variance) / mean;
        S_cons = U.clamp(1 - 0.5 * cv, 0.4, 1);
      }
    }

    const raw = Math.exp(W.mac * Math.log(S_mac) + W.prod * Math.log(S_prod) + W.cons * Math.log(S_cons));
    const bounded = U.clamp(raw, 0.02, 0.98);
    return {
      percent: Math.round(bounded * 100),
      factors: { mac: S_mac, prod: S_prod, cons: S_cons },
      weights: W, scaleX: x, cv: cv, baseCap: baseCap
    };
  }
})();
