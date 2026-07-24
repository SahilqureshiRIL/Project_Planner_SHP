/* =============================================================================
   bluesky_ui.js — inputs, wiring and rendering for the Bluesky target-date
   back-planner (the "Bluesky" module on the home picker).

   Responsibilities:
     • collect the inputs (target date, multi-select priorities, work-days,
       workhours, productivity),
     • call SPP.bluesky.compute() (in bluesky.js) to back-calculate the crew,
     • render the result: a KPI summary + verdict, a Priority/Profile-wise
       material check table, and a chainage/machine day-by-day plan table.

   Contracts with the rest of the app:
     • data + defaults are OWNED by ui.js and exposed read-only via SPP.app
       (getStore / getDefaults). This module never parses files itself.
     • ui.js calls BUI.onDataReady() once the files finish loading and
       BUI.onShow() whenever the module is opened, so we can (re)populate.
     • BUI.runLoader() is exported and reused by the planner (ui.js) for its
       own generate-time checklist loader.
     • CSS reuses the shared design-token classes (statgrid / stat / data
       table / notice) so Bluesky and the planner stay visually consistent.

   Layout of this file:
     1. state + init wiring        2. collapsible panel + priority dropdown
     3. tab switch                 4. data → form (populate)
     5. calculate                  6. checklist loader
     7. render (summary / profile table / schedule table) + helpers
   ============================================================================= */
(function () {
  "use strict";
  const SPP = window.SPP;
  const U = SPP.util;
  const $ = U.$, el = U.el;
  const BUI = (SPP.blueskyUI = {});

  /* ---- module state -------------------------------------------------------- */
  let populated = false;        // guard so we only build the inputs form once
  let lastResult = null;        // last compute() result — re-render the table on group-by change
  let activeTab = "material";   // "material" | "plan" — result tab; defaults to the material check
  const selected = new Set();   // currently-selected priorities (multiselect state)
  let scopeCache = null;        // per-priority scope (km/piles/chainages) for pill + menu meta

  /* ============================ 1. INIT / WIRING ============================ */
  document.addEventListener("DOMContentLoaded", () => {
    const btn = $("#bsCalcBtn");
    if (btn) btn.addEventListener("click", onCalculate);
    const grp = $("#bsTableGroup");
    if (grp) grp.addEventListener("change", () => { if (lastResult) renderSchedule(lastResult); });
    U.$$(".bs-tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.bstab)));

    // Collapsible top panel.
    const toggle = $("#bsPanelToggle");
    if (toggle) toggle.addEventListener("click", () => setPanelCollapsed(!$("#bsParamsCard").classList.contains("is-collapsed")));

    // Multiselect dropdown open/close.
    const ctrl = $("#bsMsControl");
    if (ctrl) {
      ctrl.addEventListener("click", (e) => { if (!e.target.closest(".ms__pill-x")) toggleMenu(); });
      ctrl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleMenu(); } });
    }
    document.addEventListener("click", (e) => { if (!e.target.closest("#bsPriorityMS")) closeMenu(); });
  });

  /* ============================ 2. PANEL + DROPDOWN ============================ */
  // Collapse/expand the top input panel (CSS animates the max-height of .bs-panel__wrap).
  function setPanelCollapsed(collapsed) {
    const card = $("#bsParamsCard");
    card.classList.toggle("is-collapsed", collapsed);
    const t = $("#bsPanelToggle"); if (t) t.setAttribute("aria-expanded", String(!collapsed));
  }

  /* ---- priority multiselect dropdown ---------------------------------------
     A custom control (not a native <select>) so we can show selected priorities
     as removable pills and each option with its km/piles scope. `selected` holds
     the state; syncMs() re-paints the pills + menu checkmarks from it. */
  function toggleMenu() { $("#bsMsMenu").hidden ? openMenu() : closeMenu(); }   // control clicked
  function openMenu() {   // show the options popover + set open state/aria
    $("#bsMsMenu").hidden = false;
    $("#bsMsControl").setAttribute("aria-expanded", "true");
    $("#bsPriorityMS").classList.add("is-open");
  }
  function closeMenu() {   // hide the popover (called on outside-click and after a pick)
    const m = $("#bsMsMenu"); if (!m) return;
    m.hidden = true;
    $("#bsMsControl").setAttribute("aria-expanded", "false");
    $("#bsPriorityMS").classList.remove("is-open");
  }

  function toggleOption(prio) {   // menu row clicked → add/remove from selection
    if (selected.has(prio)) selected.delete(prio); else selected.add(prio);
    syncMs();
  }
  function removeOption(prio) { selected.delete(prio); syncMs(); }   // pill ✕ clicked

  // Re-render the pills (in the control) and the checked state in the menu.
  function syncMs() {
    const pills = $("#bsMsPills"); U.clear(pills);
    const ordered = st_priorities().filter((p) => selected.has(p));
    if (!ordered.length) {
      pills.appendChild(el("span", { class: "ms__placeholder", text: "Select priorities…" }));
    } else {
      ordered.forEach((p) => {
        const pill = el("span", { class: "ms__pill" });
        pill.appendChild(el("span", { text: p }));
        pill.appendChild(el("button", { type: "button", class: "ms__pill-x", title: "Remove " + p, html: "&times;",
          onclick: (e) => { e.stopPropagation(); removeOption(p); } }));
        pills.appendChild(pill);
      });
    }
    U.$$("#bsMsMenu .ms__opt").forEach((o) => {
      const on = selected.has(o.dataset.prio);
      o.classList.toggle("is-sel", on);
      o.setAttribute("aria-selected", String(on));
    });
    updateScopeHint();
  }

  // Sum the selected priorities' remaining scope and show it under the dropdown.
  function updateScopeHint() {
    const hint = $("#bsScopeHint"); if (!hint) return;
    if (!selected.size || !scopeCache) { hint.textContent = ""; return; }
    let km = 0, piles = 0, ch = 0;
    st_priorities().filter((p) => selected.has(p)).forEach((p) => {
      const s = scopeCache[p]; if (s) { km += s.remainingKm || 0; piles += s.remaining || 0; ch += s.chainages || 0; }
    });
    hint.textContent = "Scope: " + U.fmtNum(km, 2) + " km left · " + U.fmtInt(piles) + " piles · " + U.fmtInt(ch) + " chainages";
  }

  // Priorities in the canonical order the chainage model exposes them.
  function st_priorities() { const st = store(); return st ? st.chainage.priorities : []; }

  /* ============================ 3. RESULT TABS ============================ */
  // Switch the visible result panel; the tab bar governs which card is shown.
  function setTab(tab) {
    activeTab = tab;
    U.$$(".bs-tab").forEach((b) => b.classList.toggle("is-active", b.dataset.bstab === tab));
    $("#bsProfileCard").hidden = tab !== "material";
    $("#bsTableCard").hidden = tab !== "plan";
  }

  /* ============================ 4. DATA → FORM ============================ */
  // ui.js hooks: onDataReady fires once files load; onShow fires each time the
  // module is opened (populate() is idempotent via the `populated` guard).
  BUI.onDataReady = function () { populate(); };
  BUI.onShow = function () { if (!populated) populate(); };

  // Read-only accessors to the shared store/defaults owned by ui.js (SPP.app).
  function store() { return SPP.app && SPP.app.getStore ? SPP.app.getStore() : null; }
  function defaults() { return SPP.app && SPP.app.getDefaults ? SPP.app.getDefaults() : null; }

  // Bluesky plans forward from the next Monday on/after TODAY (never backdated).
  function planStartFromToday() {
    const t = new Date();
    let d = new Date(t.getFullYear(), t.getMonth(), t.getDate());   // today at local midnight
    while (U.isoDow(d) !== 1) d = U.addDays(d, 1);                  // advance to Monday (today if already Monday)
    return d;
  }

  // Fill the input defaults (target date, workhours, productivity) and build the
  // priority picker. Runs once — the `populated` guard keeps a re-open from
  // wiping a selection the user already made.
  function populate() {
    const st = store(), d = defaults();
    if (!st || !d) return;
    populated = true;
    $("#bsPlaceholder").hidden = true;
    $("#bsForm").hidden = false;

    // Default target = 4 weeks after the plan start; can't be before it.
    const start = planStartFromToday();
    const target = U.addDays(start, 28);
    const tEl = $("#bsTarget");
    tEl.value = U.fmtISO(target);
    tEl.min = U.fmtISO(start);
    $("#bsStartHint").textContent = "Plan start: " + U.fmtFriendly(start) + " (next Monday from today)";

    if (d.workhours) $("#bsWorkhours").value = d.workhours;
    if (d.productivity) $("#bsProductivity").value = U.fmtNum(d.productivity, 3);
    $("#bsProdHint").textContent = d.prodDerivation || "";

    // Already-installed (steady-state) machines default to the 7-day onsite
    // average — same baseline the planner uses for its ramp's prevMachines.
    if (d.machines != null) $("#bsPrevMachines").value = d.machines;
    $("#bsPrevHint").textContent = "Auto (7-day onsite avg → " + d.machines + "). Machines beyond this ramp up before reaching full productivity.";

    buildPriorityMenu(st);
  }

  // Build the dropdown menu options (one per priority, with its scope meta) and
  // clear any prior selection. scopeCache is reused by the pills/scope hint.
  function buildPriorityMenu(st) {
    const menu = $("#bsMsMenu");
    U.clear(menu);
    selected.clear();
    scopeCache = SPP.bluesky.priorityScope(st);
    st.chainage.priorities.forEach((p) => {
      const s = scopeCache[p] || { remainingKm: 0, remaining: 0, chainages: 0 };
      const opt = el("div", { class: "ms__opt", role: "option", dataset: { prio: p }, "aria-selected": "false",
        onclick: () => toggleOption(p) });
      opt.appendChild(el("span", { class: "ms__check", html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>' }));
      const body = el("span", { class: "ms__opt-body" });
      body.appendChild(el("span", { class: "ms__opt-name", text: p }));
      body.appendChild(el("span", { class: "ms__opt-meta",
        text: U.fmtNum(s.remainingKm || 0, 2) + " km left · " + U.fmtInt(s.remaining) + " piles · " + U.fmtInt(s.chainages) + " ch" }));
      opt.appendChild(body);
      menu.appendChild(opt);
    });
    syncMs();
  }

  // Selected priorities returned in canonical order (not click order).
  function selectedPriorities() {
    return st_priorities().filter((p) => selected.has(p));
  }

  /* ============================ 5. CALCULATE ============================ */
  // Validate inputs, run the compute engine, then play the loader before showing
  // the result. Validation happens BEFORE the loader so errors surface instantly.
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
    const prevMachines = Math.max(0, parseInt($("#bsPrevMachines").value, 10) || 0);
    if (!(workhours > 0)) { U.toast("Workhours must be positive.", "bad"); return; }
    if (!(productivity > 0)) { U.toast("Productivity must be greater than 0.", "bad"); return; }

    let res;
    try {
      res = SPP.bluesky.compute(st, {
        priorities, targetDate, planStart: planStartFromToday(),
        workDaysPerWeek, workhours, productivity,
        // Already-installed machines run at steady-state (factor 1.0); machines
        // beyond this ramp up per the same adaptive curve the planner derives.
        prevMachines, rampProfile: d.rampProfile,
        // Actuals for the probability-of-success factors.
        baselineMachines: d.machines, baselineManpower: d.manpower, actualProductivity: d.productivity
      });
    } catch (err) { U.toast("Calculation failed: " + err.message, "bad"); console.error(err); return; }

    lastResult = res;
    // Run the checklist loader (constant ~5s), then reveal the results and
    // collapse the input panel so the plan gets the full screen.
    runLoader(() => {
      renderResult(res);
      setPanelCollapsed(true);
      U.toast("Plan ready.", "ok");
      // Start the view from the top: header → collapsed panel → Plan.
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  /* ============================ 6. CHECKLIST LOADER ============================
     A purely cosmetic overlay: it always runs for a fixed ~5s regardless of how
     fast compute() was, ticking each step in sequence, then calls `done`. The
     step labels are just an array (edit freely); the planner passes its own set.
     The duration is one constant (`total`) — change it in one place. */
  const LOADER_STEPS = [
    "Reading site actuals",
    "Netting installed progress",
    "Checking material stock & in-transit",
    "Back-calculating crew & manpower",
    "Building chainage-wise schedule",
    "Computing plan"
  ];
  BUI.runLoader = runLoader;   // exported so the planner (ui.js) reuses the same overlay
  // done  = callback to run once the animation completes.
  // steps = optional custom labels (defaults to LOADER_STEPS).
  function runLoader(done, steps) {
    const overlay = $("#bsLoader"), list = $("#bsLoaderList");
    U.clear(list);
    const items = (steps || LOADER_STEPS).map((label) => {
      const li = el("li", { class: "bs-lstep" });
      li.appendChild(el("span", { class: "bs-lstep__ico", html:
        '<svg class="bs-lstep__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>' }));
      li.appendChild(el("span", { class: "bs-lstep__label", text: label }));
      list.appendChild(li);
      return li;
    });
    overlay.hidden = false;
    const total = 5000, step = total / items.length;
    items.forEach((li, i) => {
      // Each item phases in (is-in) and starts spinning (is-active) on its turn,
      // then flips to a tick (is-done) before the next item phases in.
      setTimeout(() => li.classList.add("is-in", "is-active"), Math.round(i * step));
      setTimeout(() => { li.classList.remove("is-active"); li.classList.add("is-done"); }, Math.round((i + 1) * step - 160));
    });
    setTimeout(() => { overlay.hidden = true; done(); }, total + 180);
  }

  /* ============================ 7. RENDER ============================ */
  // Paint the whole result: meta strip, KPI summary + verdict, then the two
  // tabbed tables. `r` is the object returned by SPP.bluesky.compute().
  function renderResult(r) {
    // Meta strip (priorities · target · start · working days)
    $("#bsMeta").innerHTML =
      "<span>" + U.esc(r.priorities.join(", ")) + "</span>" +
      "<span>Target " + U.fmtDate(r.target) + "</span>" +
      "<span>" + U.fmtFriendly(r.planStart) + " start</span>" +
      "<span>" + r.workingDays + " working days</span>";

    $("#bsResultsCard").hidden = false;
    const host = $("#bsSummary");
    host.hidden = false; U.clear(host);

    const machinesTxt = isFinite(r.machinesNeeded) ? String(r.machinesNeeded) : "—";
    const manpowerTxt = isFinite(r.manpower) ? U.fmtInt(r.manpower) : "—";

    host.appendChild(el("p", { class: "plan-summary__lead", html:
      "To finish <strong>" + U.fmtInt(Math.round(r.remainingPiles)) + "</strong> remaining pile(s) (" +
      U.fmtNum(r.remainingKm, 2) + " km) across <strong>" + U.fmtInt(r.activeCount) + "</strong> chainage(s) of <strong>" +
      U.esc(r.priorities.join(", ")) + "</strong> by <strong>" + U.fmtDate(r.target) + "</strong>, you need <strong>" +
      machinesTxt + "</strong> machine(s) and <strong>" + manpowerTxt + "</strong> people working " +
      r.params.workDaysPerWeek + " day(s)/week at " + r.params.workhours + " h/day." }));

    // KPI tiles — probability tile tone tracks the score (green/amber/rose).
    const prob = r.probability || { percent: 0, factors: {} };
    const probTone = prob.percent >= 70 ? "emerald" : prob.percent >= 45 ? "amber" : "rose";

    host.appendChild(statGrid([
      { label: "Probability of success", value: prob.percent + "%", sub: "schedule-led · your actuals vs target", tone: probTone },
      { label: "Machines needed", value: machinesTxt, sub: isFinite(r.machinesNeeded) ? "at " + U.fmtNum(r.perMachineDaily, 1) + " piles/machine/day" : "not reachable", tone: "indigo" },
      { label: "Already installed machines", value: U.fmtInt(r.prevMachines || 0), sub: isFinite(r.machinesNeeded)
          ? (r.rampedMachines > 0 ? r.rampedMachines + " new machine(s) ramping up" : "covers the full crew — no ramp-up needed")
          : "steady-state baseline", tone: "sky" },
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

  // Tab 1 — Priority/Profile-wise material check. One row per (priority, profile)
  // with At-site / In-transit / Gap and the per-profile material halt date.
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

  // Per-chainage display prep: turn each day's raw float install into a whole-pile
  // "Piles (day)" value. Rounding the CUMULATIVE total each day (old approach) could
  // show non-monotonic values like 26, 27, 26 even under flat capacity, because
  // independent day-to-day rounding error was carried through the running total.
  // Fix: ceil every non-final day's raw install (so a flat/rising capacity series
  // never dips), then on the chainage's last day, net the display against MTO so
  // the displayed total still ties out exactly (absorbing the rounding surplus).
  function computeDisplay(schedule) {
    const byCh = {};
    schedule.forEach((e) => (byCh[e.chId] || (byCh[e.chId] = [])).push(e));
    Object.values(byCh).forEach((list) => {
      list.sort((a, b) => a.date - b.date);
      let prev = Math.round(list.length ? (list[0].priorInstalled || 0) : 0);
      list.forEach((e, idx) => {
        const isLastDay = idx === list.length - 1 || e.cum >= e.mto - 1e-6;
        e.dispInstall = isLastDay ? Math.max(0, Math.round(e.mto) - prev) : Math.ceil(e.install);
        prev += e.dispInstall;
        e.dispCum = prev;
      });
    });
  }

  // Tab 2 — chainage-wise / machine-wise day-by-day plan (material assumed
  // unlimited in Bluesky). Mirrors the planner's Table view; the Group-by control
  // re-sorts and re-groups by Date / Chainage / Machine.
  function renderSchedule(r) {
    if (!r.schedule || !r.schedule.length) {
      U.clear($("#bsTableScroll"));
      $("#bsTableScroll").appendChild(el("p", { class: "hint", text: "No schedule — the target is not reachable, or the selected priorities are already complete." }));
      $("#bsTableSummary").textContent = "";
      return;
    }
    computeDisplay(r.schedule);
    const groupBy = $("#bsTableGroup").value;

    const cols = ["Date", "Day #", "Machine", "Chainage", "Profile", "Item Code", "Piles (day)", "Cum.", "MTO", "% Comp."];
    const NUM = { "Piles (day)": 1, "Cum.": 1, "MTO": 1, "% Comp.": 1 };
    const table = el("table", { class: "data" });
    const thead = el("thead"), htr = el("tr");
    cols.forEach((c) => htr.appendChild(el("th", { class: NUM[c] ? "num" : "", text: c })));
    thead.appendChild(htr); table.appendChild(thead);
    const tb = el("tbody");

    // sortVal orders rows within the chosen grouping; keyFn decides when to emit
    // a new group-header row. The multipliers just make the primary key dominate.
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

  // A full-width divider row that labels the start of each Date/Chainage/Machine group.
  function scheduleGroupHeader(groupBy, e, span) {
    let label;
    if (groupBy === "date") label = U.fmtFriendly(e.date) + "  ·  Day " + e.dayNum;
    else if (groupBy === "chainage") label = "Chainage " + e.chId + "  ·  " + e.profile;
    else label = "Machine " + e.machine;
    const tr = el("tr", { class: "row-group" });
    tr.appendChild(el("td", { colspan: span, text: label }));
    return tr;
  }

  // One schedule line (a machine's work on a chainage for a day). % Comp. and the
  // completed-row highlight use the true cumulative (e.cum), not the rounded delta.
  function scheduleRow(e) {
    const pct = e.mto > 0 ? (e.cum / e.mto) * 100 : 0;
    const done = e.cum >= e.mto - 1e-6;
    const tr = el("tr", { class: done ? "row-completed" : "" });
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
      el("td", { class: "num", text: U.fmtNum(pct, 1) + "%" })
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
