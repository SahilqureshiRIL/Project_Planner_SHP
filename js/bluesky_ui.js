/* =============================================================================
   bluesky_ui.js — inputs, wiring and rendering for the Bluesky target-date
   back-planner. Reads the shared store/defaults exposed by ui.js (SPP.app) and
   drives SPP.bluesky.compute. Uses the same design-token CSS classes as the
   planner (statgrid / stat / data table) so the two modules look consistent.
   ============================================================================= */
(function () {
  "use strict";
  const SPP = window.SPP;
  const U = SPP.util;
  const $ = U.$, el = U.el;
  const BUI = (SPP.blueskyUI = {});

  let populated = false;
  let lastResult = null;   // kept so the table can re-render on a group-by change
  let activeTab = "material";   // "material" | "plan" — defaults to the material check

  document.addEventListener("DOMContentLoaded", () => {
    const btn = $("#bsCalcBtn");
    if (btn) btn.addEventListener("click", onCalculate);
    const grp = $("#bsTableGroup");
    if (grp) grp.addEventListener("change", () => { if (lastResult) renderSchedule(lastResult); });
    U.$$(".bs-tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.bstab)));
  });

  // Switch the visible result panel; the tab bar governs card visibility.
  function setTab(tab) {
    activeTab = tab;
    U.$$(".bs-tab").forEach((b) => b.classList.toggle("is-active", b.dataset.bstab === tab));
    $("#bsProfileCard").hidden = tab !== "material";
    $("#bsTableCard").hidden = tab !== "plan";
  }

  // Called by ui.js when the data files finish loading, and when the module opens.
  BUI.onDataReady = function () { populate(); };
  BUI.onShow = function () { if (!populated) populate(); };

  function store() { return SPP.app && SPP.app.getStore ? SPP.app.getStore() : null; }
  function defaults() { return SPP.app && SPP.app.getDefaults ? SPP.app.getDefaults() : null; }

  /* ---- fill inputs + build the priority picker from the loaded data -------- */
  function populate() {
    const st = store(), d = defaults();
    if (!st || !d) return;
    populated = true;
    $("#bsPlaceholder").hidden = true;
    $("#bsForm").hidden = false;
    $("#bsFoot").hidden = false;

    // Default target = 4 weeks after the plan-start anchor; can't be before it.
    const start = d.planStartDefault;
    const target = U.addDays(start, 28);
    const tEl = $("#bsTarget");
    tEl.value = U.fmtISO(target);
    tEl.min = U.fmtISO(start);
    $("#bsStartHint").textContent = "Plan start: " + U.fmtFriendly(start) +
      " (first Monday after latest record " + U.fmtShort(d.latestDataDate) + ")";

    if (d.workhours) $("#bsWorkhours").value = d.workhours;
    if (d.productivity) $("#bsProductivity").value = U.fmtNum(d.productivity, 3);
    $("#bsProdHint").textContent = d.prodDerivation || "";

    buildPriorityList(st);
  }

  function buildPriorityList(st) {
    const host = $("#bsPriorityList");
    U.clear(host);
    const scope = SPP.bluesky.priorityScope(st);
    st.chainage.priorities.forEach((p) => {
      const s = scope[p] || { scopeKm: 0, remaining: 0, chainages: 0 };
      const id = "bsPrio_" + p.replace(/[^A-Za-z0-9]/g, "_");
      const row = el("label", { class: "bs-prio", for: id });
      row.appendChild(el("input", { type: "checkbox", id: id, value: p, class: "bs-prio__cb" }));
      const body = el("span", { class: "bs-prio__body" });
      body.appendChild(el("span", { class: "bs-prio__name", text: p }));
      body.appendChild(el("span", { class: "bs-prio__meta",
        text: U.fmtNum(s.remainingKm || 0, 2) + " km left · " + U.fmtInt(s.remaining) + " piles · " + U.fmtInt(s.chainages) + " ch" }));
      row.appendChild(body);
      host.appendChild(row);
    });
  }

  function selectedPriorities() {
    return U.$$("#bsPriorityList .bs-prio__cb:checked").map((c) => c.value);
  }

  /* ---- calculate + render -------------------------------------------------- */
  function onCalculate() {
    const st = store(), d = defaults();
    if (!st || !d) { U.toast("Data is still loading — try again in a moment.", "bad"); return; }

    const priorities = selectedPriorities();
    if (!priorities.length) { U.toast("Select at least one priority.", "bad"); return; }
    const targetDate = U.parseISODate($("#bsTarget").value);
    if (!targetDate) { U.toast("Pick a target date.", "bad"); return; }
    const workDaysPerWeek = parseInt($("#bsWorkDays").value, 10) || 6;
    const workhours = parseInt($("#bsWorkhours").value, 10);
    const productivity = U.toNum($("#bsProductivity").value);
    if (!(workhours > 0)) { U.toast("Workhours must be positive.", "bad"); return; }
    if (!(productivity > 0)) { U.toast("Productivity must be greater than 0.", "bad"); return; }

    let res;
    try {
      res = SPP.bluesky.compute(st, {
        priorities, targetDate, planStart: d.planStartDefault,
        workDaysPerWeek, workhours, productivity,
        // Actuals for the probability-of-success factors.
        baselineMachines: d.machines, baselineManpower: d.manpower, actualProductivity: d.productivity
      });
    } catch (err) { U.toast("Calculation failed: " + err.message, "bad"); console.error(err); return; }

    lastResult = res;
    renderResult(res);
    U.toast("Requirement computed.", "ok");
    $("#bsResultsCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderResult(r) {
    // Meta strip
    $("#bsMeta").innerHTML =
      "<span>" + U.esc(r.priorities.join(", ")) + "</span>" +
      "<span>Target " + U.fmtDate(r.target) + "</span>" +
      "<span>" + U.fmtFriendly(r.planStart) + " start</span>" +
      "<span>" + r.workingDays + " working days</span>";

    const host = $("#bsSummary");
    host.hidden = false; U.clear(host);
    $("#bsEmpty").hidden = true;

    const machinesTxt = isFinite(r.machinesNeeded) ? String(r.machinesNeeded) : "—";
    const manpowerTxt = isFinite(r.manpower) ? U.fmtInt(r.manpower) : "—";

    host.appendChild(el("p", { class: "plan-summary__lead", html:
      "To finish <strong>" + U.fmtInt(Math.round(r.remainingPiles)) + "</strong> remaining pile(s) (" +
      U.fmtNum(r.remainingKm, 2) + " km) across <strong>" + U.fmtInt(r.activeCount) + "</strong> chainage(s) of <strong>" +
      U.esc(r.priorities.join(", ")) + "</strong> by <strong>" + U.fmtDate(r.target) + "</strong>, you need <strong>" +
      machinesTxt + "</strong> machine(s) and <strong>" + manpowerTxt + "</strong> people working " +
      r.params.workDaysPerWeek + " day(s)/week at " + r.params.workhours + " h/day." }));

    const prob = r.probability || { percent: 0, factors: {} };
    const probTone = prob.percent >= 70 ? "emerald" : prob.percent >= 45 ? "amber" : "rose";

    host.appendChild(statGrid([
      { label: "Probability of success", value: prob.percent + "%", sub: "schedule-led · your actuals vs target", tone: probTone },
      { label: "Machines needed", value: machinesTxt, sub: isFinite(r.machinesNeeded) ? "at " + U.fmtNum(r.perMachineDaily, 1) + " piles/machine/day" : "not reachable", tone: "indigo" },
      { label: "Manpower required", value: manpowerTxt, sub: "6 people / machine", tone: "violet" },
      { label: "Piles to install", value: U.fmtInt(Math.round(r.remainingPiles)), sub: U.fmtInt(r.priorTotal) + " already done", tone: "teal" },
      { label: "Length remaining", value: U.fmtNum(r.remainingKm, 2) + " km", sub: "of " + U.fmtNum(r.totalScopeKm, 1) + " km scope", tone: "sky" },
      { label: "Required pace", value: isFinite(r.requiredRate) ? U.fmtInt(Math.round(r.requiredRate)) + "/day" : "—", sub: r.workingDays + " working days to target", tone: "amber" },
      { label: "Material gap", value: U.fmtInt(Math.round(r.gapTotal)), sub: r.gapTotal > 0 ? "piles short of supply" : "supply covers demand", tone: r.gapTotal > 0 ? "rose" : "emerald" }
    ]));

    const verdict = el("div", { class: "notice notice--" + (r.verdictLevel === "bad" ? "bad" : r.verdictLevel === "warn" ? "warn" : "ok") });
    verdict.appendChild(el("span", { text: r.verdict }));
    host.appendChild(verdict);

    // Probability breakdown — the three factors that make up the score.
    host.appendChild(el("p", { class: "bs-prob-note", html:
      "<strong>Success " + prob.percent + "%</strong> basis Schedule-led confidence from actuals: " +
      "crew scalability (need " + machinesTxt + " machines vs a baseline of " +
      (prob.baseCap != null ? prob.baseCap : "?") + "), productivity realism, delivery consistency." }));

    renderProfileTable(r);
    renderSchedule(r);
    $("#bsTabs").hidden = false;
    setTab("material");   // default panel on every Process Plan
  }

  function renderProfileTable(r) {
    const badge = $("#bsProfileBadge");
    badge.textContent = r.gapTotal > 0 ? "Shortage" : "Covered";
    badge.className = "badge" + (r.gapTotal > 0 ? " badge--warn" : " badge--ok");
    $("#bsProfileHint").textContent = r.haltDate
      ? "At this pace, work stalls for material around " + U.fmtDate(r.haltDate) +
        (r.completionDate && U.cmpDate(r.completionDate, r.target) > 0 ? "; earliest realistic finish " + U.fmtDate(r.completionDate) + "." : ".")
      : "Material supply sustains the required pace through the target date.";

    const t = el("table", { class: "data bs-table" });
    const thead = el("thead");
    const htr = el("tr");
    ["Priority", "Profile", "Required", "In Stock", "In Transit", "Gap / Shortage", "Work halts on"].forEach((h) =>
      htr.appendChild(el("th", { text: h })));
    thead.appendChild(htr); t.appendChild(thead);

    const tb = el("tbody");
    r.profileRows.forEach((row) => {
      const tr = el("tr", { class: row.gap > 0 ? "is-short" : "" });
      tr.appendChild(el("td", { class: "bs-prio-cell", text: row.priority }));
      tr.appendChild(el("td", { class: "bs-prof", text: row.profile }));
      tr.appendChild(el("td", { class: "num", text: U.fmtInt(row.demand) }));
      tr.appendChild(el("td", { class: "num", text: U.fmtInt(row.atSite) }));
      tr.appendChild(el("td", { class: "num", text: U.fmtInt(row.inTransitByTarget) +
        (row.inTransitLater > 0 ? " (+" + U.fmtInt(row.inTransitLater) + " later)" : "") }));
      tr.appendChild(el("td", { class: "num" + (row.gap > 0 ? " bs-gap" : ""), text: row.gap > 0 ? U.fmtInt(row.gap) : "—" }));
      tr.appendChild(el("td", { text: row.haltsOn ? U.fmtDate(row.haltsOn) : "—" }));
      tb.appendChild(tr);
    });
    t.appendChild(tb);

    const scroll = $("#bsProfileScroll"); U.clear(scroll); scroll.appendChild(t);
  }

  /* Chainage-wise / machine-wise day-by-day plan (material unlimited). Mirrors the
     planner's Table view; grouped by Date / Chainage / Machine. */
  function computeDisplay(schedule) {
    const byCh = {};
    schedule.forEach((e) => (byCh[e.chId] || (byCh[e.chId] = [])).push(e));
    Object.values(byCh).forEach((list) => {
      list.sort((a, b) => a.date - b.date);
      let prev = Math.round(list.length ? (list[0].priorInstalled || 0) : 0);
      list.forEach((e) => { e.dispCum = Math.round(e.cum); e.dispInstall = e.dispCum - prev; prev = e.dispCum; });
    });
  }

  function renderSchedule(r) {
    if (!r.schedule || !r.schedule.length) {
      U.clear($("#bsTableScroll"));
      $("#bsTableScroll").appendChild(el("p", { class: "hint", text: "No schedule — the target is not reachable, or the selected priorities are already complete." }));
      $("#bsTableSummary").textContent = "";
      return;
    }
    computeDisplay(r.schedule);
    const groupBy = $("#bsTableGroup").value;

    const cols = ["Date", "Day #", "Machine", "Chainage", "Profile", "Item Code", "Piles (day)", "Cum.", "MTO", "% Comp.", "Status"];
    const NUM = { "Piles (day)": 1, "Cum.": 1, "MTO": 1, "% Comp.": 1 };
    const table = el("table", { class: "data" });
    const thead = el("thead"), htr = el("tr");
    cols.forEach((c) => htr.appendChild(el("th", { class: NUM[c] ? "num" : "", text: c })));
    thead.appendChild(htr); table.appendChild(thead);
    const tb = el("tbody");

    const rows = r.schedule.slice();
    const sortVal = {
      date: (e) => e.date.getTime() * 100 + e.machine,
      chainage: (e) => U.chainageSortKey(e.chId) * 1e7 + e.date.getTime() / 1e6,
      machine: (e) => e.machine * 1e13 + e.date.getTime()
    }[groupBy];
    const keyFn = {
      date: (e) => U.fmtISO(e.date),
      chainage: (e) => e.chId,
      machine: (e) => "M" + e.machine
    }[groupBy];
    rows.sort((a, b) => sortVal(a) - sortVal(b));

    let lastKey = null;
    rows.forEach((e) => {
      const k = keyFn(e);
      if (k !== lastKey) { tb.appendChild(scheduleGroupHeader(groupBy, e, cols.length)); lastKey = k; }
      tb.appendChild(scheduleRow(e));
    });
    table.appendChild(tb);
    const scroll = $("#bsTableScroll"); U.clear(scroll); scroll.appendChild(table);

    $("#bsTableSummary").textContent = r.schedule.length + " entries · " + r.scheduleWorked + " chainages · " +
      U.fmtInt(Math.round(r.remainingPiles)) + " piles" +
      (r.scheduleFinish ? " · finishes " + U.fmtDate(r.scheduleFinish) : "");
  }

  function scheduleGroupHeader(groupBy, e, span) {
    let label;
    if (groupBy === "date") label = U.fmtFriendly(e.date) + "  ·  Day " + e.dayNum;
    else if (groupBy === "chainage") label = "Chainage " + e.chId + "  ·  " + e.profile;
    else label = "Machine " + e.machine;
    const tr = el("tr", { class: "row-group" });
    tr.appendChild(el("td", { colspan: span, text: label }));
    return tr;
  }

  function scheduleRow(e) {
    const pct = e.mto > 0 ? (e.cum / e.mto) * 100 : 0;
    const done = e.cum >= e.mto - 1e-6;
    const tr = el("tr", { class: done ? "row-completed" : "" });
    const status = done ? el("span", { class: "pill pill--done", text: "Completed" })
      : el("span", { class: "pill pill--prog", text: "In progress" });
    [
      el("td", { text: U.fmtShort(e.date) }),
      el("td", { class: "num", text: e.dayNum }),
      el("td", { text: "Machine " + e.machine }),
      el("td", { text: e.chId }),
      el("td", { text: e.profile }),
      el("td", { text: e.code || "—" }),
      el("td", { class: "num", text: U.fmtInt(e.dispInstall) }),
      el("td", { class: "num", text: U.fmtInt(e.dispCum) }),
      el("td", { class: "num", text: U.fmtInt(e.mto) }),
      el("td", { class: "num", text: U.fmtNum(pct, 1) + "%" }),
      el("td", {}, [status])
    ].forEach((td) => tr.appendChild(td));
    return tr;
  }

  // Local copy of the planner's stat-grid builder (same CSS classes/tones).
  function statGrid(stats) {
    const g = el("div", { class: "statgrid" });
    stats.forEach((s) => {
      const c = el("div", { class: "stat" + (s.tone ? " stat--t-" + s.tone : "") });
      c.appendChild(el("div", { class: "stat__label", text: s.label }));
      c.appendChild(el("div", { class: "stat__value", text: s.value }));
      if (s.sub) c.appendChild(el("div", { class: "stat__sub", text: s.sub }));
      g.appendChild(c);
    });
    return g;
  }
})();
