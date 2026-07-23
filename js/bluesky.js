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

    /* ---- 5. per-profile demand vs supply (at-site / in-transit / gap) ------- */
    const demandByCode = {};
    rows.forEach((r) => { const c = r.f.code || "(no code)"; demandByCode[c] = (demandByCode[c] || 0) + r.remaining; });

    const profileRows = Object.keys(demandByCode).map((code) => {
      const m = codeMaterial(code);
      const inbound = m ? m.inbound : [];
      const atSite = netOnsite(code);
      // In-transit that can realistically be used by the target (arrives in-window,
      // usable = arrival + 1 ≤ target). Later arrivals are tracked separately.
      let inTransitByTarget = 0, inTransitLater = 0;
      inbound.forEach((inb) => {
        if (U.cmpDate(inb.arrival, planStart) < 0) return;               // overdue pre-window on-hold: not counted
        if (U.cmpDate(inb.usable, target) <= 0) inTransitByTarget += inb.qty;
        else inTransitLater += inb.qty;
      });
      const demand = demandByCode[code];
      const supplyByTarget = atSite + inTransitByTarget;
      const gap = Math.max(0, demand - supplyByTarget);
      return {
        code, profile: profileForCode(code),
        demand, atSite, inTransitByTarget, inTransitLater,
        supplyByTarget, gap, haltsOn: null   // filled by the simulation below
      };
    }).sort((a, b) => b.gap - a.gap || b.demand - a.demand || a.profile.localeCompare(b.profile));
    const rowByCode = {}; profileRows.forEach((r) => { rowByCode[r.code] = r; });

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
            if (!rowByCode[code].haltsOn) rowByCode[code].haltsOn = new Date(d);
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

    return {
      params: p, planStart, target, workingDays, perMachineDaily,
      priorities: p.priorities.slice(),
      candidateCount: candidates.length, activeCount: rows.length,
      remainingPiles, remainingKm, totalScopeKm, totalMTO, priorTotal,
      requiredRate, machinesNeeded, manpower,
      profileRows, gapTotal, materialShort,
      haltDate, completionDate,
      verdict, verdictLevel
    };
  };
})();
