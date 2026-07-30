/* =============================================================================
   ui.js — file loading, defaults population, the Generate handler, the Gantt /
   Table / Validation renderers, the view toggle and localStorage persistence.
   ============================================================================= */
(function () {
  "use strict";
  const SPP = window.SPP;
  const U = SPP.util;
  const $ = U.$, el = U.el;
  const MACHINE_COLORS = ["#4f46e5", "#0d9488", "#e11d48", "#d97706", "#7c3aed", "#0284c7", "#059669", "#db2777"];

  const state = {
    parsed: { chainage: null, manpower: null, material: null, progress: null },
    store: null, defaults: null, result: null,
    view: "table", ganttColor: "profile", mapZoom: 1, mapSelected: null, mapFilters: new Set()
  };
  const selectedPriorities = new Set();   // planner priorities (multiselect pill dropdown)
  let prodWindow = 7;            // productivity basis the planner has selected: 7 | 30 (days)
  let progressMode = "week";     // recent-progress chart aggregation: "week" | "month"
  let progressOffset = 0;        // periods back from the latest that the 7-period window ends (paged by ‹ ›)
  let progressAnim = null;       // one-shot redraw transition: "older" | "newer" | "fade" (cleared after each draw)

  // Shared read-only access for the Bluesky module (js/bluesky_ui.js), so it can
  // reuse the same loaded store/defaults without duplicating the load pipeline.
  SPP.app = { getStore: () => state.store, getDefaults: () => state.defaults, showModule: (m) => showModule(m) };

  document.addEventListener("DOMContentLoaded", init);

  /* ============================ INIT / WIRING ============================ */
  function init() {
    if (typeof XLSX === "undefined") {
      U.toast("SheetJS failed to load — .xlsx parsing is unavailable. Check vendor/xlsx.full.min.js.", "bad");
    }
    // Chainage data is FROZEN: loaded from the hardcoded js/chainage_data.js (no upload).
    try { state.parsed.chainage = SPP.data.loadHardcodedChainage(); renderChainageReadonly(); }
    catch (e) { U.toast("Chainage data error: " + e.message, "bad"); }

    U.$$('input[type="file"]').forEach((inp) => {
      inp.addEventListener("change", (e) => { if (e.target.files[0]) handleFile(inp.dataset.input, e.target.files[0]); });
    });
    // Header logo → reset both modules to a fresh state (same visible effect
    // as refreshing the window, without an actual reload/re-fetch) and go
    // back to the module picker.
    { const hb = $("#homeLogoBtn"); if (hb) hb.addEventListener("click", () => {
      resetPlanner();
      if (SPP.blueskyUI && SPP.blueskyUI.reset) SPP.blueskyUI.reset();
      showModule(null);
    }); }
    // Module picker cards → open the chosen tool.
    U.$$(".modcard").forEach((c) => c.addEventListener("click", () => showModule(c.dataset.module)));
    $("#tryBundledBtn").addEventListener("click", tryBundled);
    $("#exportPlanBtn").addEventListener("click", onExportXer);
    $("#generateBtn2").addEventListener("click", onGenerate);
    { const rb = $("#resetPlanBtn"); if (rb) rb.addEventListener("click", resetPlanParams); }
    $("#addHindranceBtn").addEventListener("click", () => addHindranceRow());
    // Hindrances are edited in a modal (opened from the card's "+ Add hindrance").
    { const ob = $("#openHindranceModalBtn"); if (ob) ob.addEventListener("click", openHindranceModal); }
    { const hx = $("#hindranceCloseX"); if (hx) hx.addEventListener("click", closeHindranceModal); }
    { const hd = $("#hindranceDoneBtn"); if (hd) hd.addEventListener("click", closeHindranceModal); }
    { const hm = $("#hindranceModal"); if (hm) hm.addEventListener("click", (e) => { if (e.target === hm) closeHindranceModal(); }); }
    $("#pStart").addEventListener("change", enforceMonday);
    $("#pStart").addEventListener("change", refreshHindranceCalendars);
    // Machines: integers only. Sanitize typed/pasted input, block e/E/+/-/. keys.
    $("#pMachines").addEventListener("keydown", (e) => { if (["e", "E", "+", "-", "."].includes(e.key)) e.preventDefault(); });
    $("#pMachines").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/[^0-9]/g, ""); refreshPlannedManpower(); refreshCapNotice(); });
    // Productivity: block only exponent/sign keys so the native number field handles
    // decimals correctly (rewriting .value on every input broke "5.0" → ".5"). Clamp
    // to a max of 3 decimal places on commit.
    $("#pProductivity").addEventListener("keydown", (e) => { if (["e", "E", "+", "-"].includes(e.key)) e.preventDefault(); });
    $("#pProductivity").addEventListener("change", (e) => {
      const v = U.toNum(e.target.value);
      if (isFinite(v) && v > 0) e.target.value = String(Math.round(v * 1000) / 1000);
    });
    U.$$('input[name="period"]').forEach((r) => r.addEventListener("change", refreshHindranceCalendars));

    // Ramp-up curve live preview (Change 5)
    ["#pRampProfile", "#pRampN", "#pProductivity", "#pWorkhours"].forEach((sel) => {
      const n = $(sel); if (n) n.addEventListener("input", renderRampChart);
    });

    U.$$("#viewToggle .view-toggle__btn").forEach((b) =>
      b.addEventListener("click", () => setView(b.dataset.view)));
    // Collapse/expand the input panel via its own header bar (the old header
    // "Hide inputs" button was removed).
    { const pt = $("#plannerPanelToggle");
      if (pt) pt.addEventListener("click", () => { const p = $("#paramsCard"); setSidebarCollapsed(!(p && p.classList.contains("is-collapsed"))); }); }

    // Priority pill dropdown (multi-select).
    { const ctrl = $("#pPriorityControl");
      if (ctrl) {
        ctrl.addEventListener("click", (e) => { if (!e.target.closest(".ms__pill-x")) togglePriorityMenu(); });
        ctrl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePriorityMenu(); } });
      }
      document.addEventListener("click", (e) => { if (!e.target.closest("#pPriorityMS")) closePriorityMenu(); });
    }

    // Work Days / week pill dropdown (single-select, same look as the priority picker).
    { const ctrl = $("#pWorkDaysControl");
      if (ctrl) {
        ctrl.addEventListener("click", () => toggleWorkDaysMenu());
        ctrl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleWorkDaysMenu(); } });
      }
      document.addEventListener("click", (e) => { if (!e.target.closest("#pWorkDaysMS")) closeWorkDaysMenu(); });
      buildWorkDaysDropdown();
    }
    $("#pWorkDays").addEventListener("change", refreshHindranceCalendars);

    // Productivity basis toggle: Last 7 days / Last 30 days.
    { const seg = $("#pProdWindowSeg");
      if (seg) seg.addEventListener("click", (e) => {
        const btn = e.target.closest(".seg__btn"); if (!btn) return;
        setProdWindow(parseInt(btn.dataset.window, 10));
      });
    }

    // Blocked-chainages popup: close via the button or by clicking the backdrop.
    { const bx = $("#blockedCloseX"); if (bx) bx.addEventListener("click", closeBlockedModal); }
    { const bm = $("#blockedModal"); if (bm) bm.addEventListener("click", (e) => { if (e.target === bm) closeBlockedModal(); }); }

    // Recent-progress chart: Week/Month toggle + ‹ / › paging (one period per click).
    { const seg = $("#progressMode");
      if (seg) U.$$(".seg2__btn", seg).forEach((b) => b.addEventListener("click", () => {
        progressMode = b.dataset.mode; progressOffset = 0; progressAnim = "fade";
        U.$$(".seg2__btn", seg).forEach((x) => x.classList.toggle("is-active", x === b));
        redrawProgressKeepScroll();
      })); }
    { const pl = $("#progressPrev"), pn = $("#progressNext");
      if (pl) pl.addEventListener("click", () => { progressOffset += 1; progressAnim = "older"; redrawProgressKeepScroll(); });   // older → slide in from left
      if (pn) pn.addEventListener("click", () => { progressOffset -= 1; progressAnim = "newer"; redrawProgressKeepScroll(); }); }  // newer → slide in from right
    $("#tableGroup").addEventListener("change", () => { if (state.result) renderTable(); });

    // Map zoom controls (Change 8) — delegate to the active renderer (three.js or SVG).
    $("#mapZoomIn").addEventListener("click", () => mapZoomBy(1.4));
    $("#mapZoomOut").addEventListener("click", () => mapZoomBy(1 / 1.4));
    $("#mapZoomFit").addEventListener("click", () => mapZoomFit());
    $("#mapScroll").addEventListener("wheel", (e) => {
      if (mapGL || !state.result) return;          // GL canvas handles its own wheel
      e.preventDefault();
      setMapZoom(state.mapZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    }, { passive: false });

    refresh();
    tryBundled();   // auto-load the three files from ./data/ so the app opens on the Plan Parameters screen
  }
  // Reset the Installation Planner to a fresh state — same visible effect as
  // a page refresh, but reusing the already-parsed data files instead of
  // re-fetching/re-parsing them (they haven't changed). Clears the generated
  // plan, all view/paging state, any hindrances added, and the priority
  // selection, then repopulates the form from freshly recomputed defaults.
  function resetPlanner() {
    state.result = null;
    state.view = "table";
    state.ganttColor = "profile";
    state.mapZoom = 1;
    state.mapSelected = null;
    state.mapFilters = new Set();
    prodWindow = 7;
    progressMode = "week";
    progressOffset = 0;
    progressAnim = null;
    selectedPriorities.clear();

    const list = $("#hindranceList"); if (list) U.clear(list);

    $("#resultsCard").hidden = true;
    $("#resultsEmpty").hidden = false;
    $("#viewToggle").hidden = true;
    { const mc = $("#materialCheckCard"); if (mc) mc.hidden = true; }
    $("#validationCard").hidden = true;
    $("#exportPlanBtn").hidden = true;
    $("#progressCard").hidden = true;

    setSidebarCollapsed(false);
    if (state.store) refresh();   // recompute defaults from the already-parsed store, repopulate the form
  }

  // Switch between the module picker (m = null), the forward planner ("planner")
  // and the Bluesky target-date planner ("bluesky"). The header Export button is
  // shown only when the planner is active with a generated plan; the view switcher
  // lives inside the (planner-only) Plan card, so it needs no handling here.
  function showModule(m) {
    const picker = $("#homePicker"), planner = $("#plannerLayout"), bluesky = $("#blueskyLayout");
    if (picker) picker.hidden = !!m;
    if (planner) planner.hidden = m !== "planner";
    if (bluesky) bluesky.hidden = m !== "bluesky";
    const plannerActive = m === "planner" && !!state.result;
    { const n = $("#exportPlanBtn"); if (n) n.hidden = !plannerActive; }
    if (m === "bluesky" && SPP.blueskyUI && SPP.blueskyUI.onShow) SPP.blueskyUI.onShow();
    window.scrollTo(0, 0);
  }

  // Zoom the map by a relative factor (delegates to the active GL or SVG renderer).
  function mapZoomBy(f) { if (mapGL) mapGL.zoomBy(f); else setMapZoom(state.mapZoom * f); }
  // Reset the whole plan: clear the generated plan / results (the Plan Window and its
  // view/paging state) AND restore the Plan Parameters form to defaults (priorities,
  // period, start, work days, workhours, editable Plan Parameters + hindrances).
  // Leaves the loaded data untouched.
  function resetPlanParams() {
    if (!state.store) return;
    // Drop any generated plan and its view state, then hide the results surfaces.
    state.result = null;
    state.view = "table";
    state.ganttColor = "profile";
    state.mapZoom = 1;
    state.mapSelected = null;
    state.mapFilters = new Set();
    progressMode = "week";
    progressOffset = 0;
    progressAnim = null;
    $("#resultsCard").hidden = true;
    $("#resultsEmpty").hidden = false;
    $("#viewToggle").hidden = true;
    { const mc = $("#materialCheckCard"); if (mc) mc.hidden = true; }
    $("#validationCard").hidden = true;
    $("#exportPlanBtn").hidden = true;
    $("#progressCard").hidden = true;

    // Restore the Plan Parameters form to freshly-computed defaults.
    selectedPriorities.clear();
    const list = $("#hindranceList"); if (list) U.clear(list);
    const p2 = document.querySelector('input[name="period"][value="2"]'); if (p2) p2.checked = true;
    setVal("#pWorkDays", "6"); syncWorkDays();
    prodWindow = 7;
    populateDefaults();   // repopulate priority dropdown (empty), start, workhours, Plan Parameters (empty), ramp, 7/30 toggle
    setSidebarCollapsed(false);   // re-expand the input panel (a generated plan collapses it)
    U.toast("Plan reset.", "ok");
  }

  // Reset the map zoom to fit the whole boundary.
  function mapZoomFit() { if (mapGL) mapGL.fit(); else setMapZoom(1); }
  // Apply an absolute zoom level to the SVG map fallback.
  function setMapZoom(z) {
    state.mapZoom = U.clamp(z, 0.5, 12);
    if (state.result) renderMap();
  }

  /* ============================ CHAINAGE (frozen, read-only) ============================ */
  function renderChainageReadonly() {
    const ch = state.parsed.chainage;
    if (!ch) return;
    const summary = $("#chainageSummary");
    if (!summary) return;   // Chainage card removed from the UI; data still loads for the engine.
    const counts = ch.priorities.map((p) => p + " " + U.fmtInt(ch.priorityCounts[p])).join(" · ");
    summary.innerHTML = "<strong>" + U.fmtInt(ch.features.length) + "</strong> chainages · " +
      ch.profiles.length + " materials · " + counts;
    // Build the read-only table lazily the first time the section is opened.
    const det = $("#chainageDetails");
    let built = false;
    det.addEventListener("toggle", function () {
      if (!det.open || built) return;
      built = true;
      const rows = ch.features.slice().sort((a, b) => a.sortKey - b.sortKey);
      const t = el("table", { class: "data" });
      t.innerHTML = "<thead><tr><th>Chainage_Id</th><th>Priority</th><th>Material</th><th class='num'>No. of Profiles</th><th>Item Code</th></tr></thead>";
      const tb = el("tbody");
      rows.forEach((f) => {
        const tr = el("tr");
        tr.innerHTML = "<td>" + U.esc(f.id) + "</td><td>" + U.esc(f.priority) + "</td><td>" + U.esc(f.profile) +
          "</td><td class='num'>" + U.fmtInt(f.mto) + "</td><td>" + U.esc(f.code || "—") + "</td>";
        tb.appendChild(tr);
      });
      t.appendChild(tb);
      const scroll = $("#chainageTableScroll"); U.clear(scroll); scroll.appendChild(t);
    });
  }

  /* ============================ FILE LOADING ============================ */
  function fileRow(kind) { return document.querySelector('.filerow[data-file="' + kind + '"]'); }
  // Update a data-file row's status text and state class (ok/bad).
  function setStatus(kind, msg, cls) {
    const row = fileRow(kind);
    row.querySelector('[data-role="status"]').textContent = msg;
    row.classList.remove("is-ok", "is-bad");
    if (cls) row.classList.add(cls);
  }

  // Parse a user-picked .xlsx for the given kind, store it, and refresh.
  function handleFile(kind, file) {
    setStatus(kind, "Reading…");
    const reader = new FileReader();
    reader.onerror = () => setStatus(kind, "Could not read file.", "is-bad");
    reader.onload = (e) => {
      try {
        if (kind === "chainage") state.parsed.chainage = SPP.data.parseChainage(e.target.result);
        else state.parsed[kind] = SPP.data.parseWorkbookFile(e.target.result, kind);
        setStatus(kind, summarize(kind, state.parsed[kind]), "is-ok");
      } catch (err) {
        state.parsed[kind] = null;
        setStatus(kind, "✗ " + err.message, "is-bad");
      }
      refresh();
    };
    if (kind === "chainage") reader.readAsText(file); else reader.readAsArrayBuffer(file);
  }

  // Build the short one-line status summary shown for a loaded file.
  function summarize(kind, m) {
    if (kind === "chainage") return "✓ " + U.fmtInt(m.features.length) + " chainages · " + m.priorities.length + " priorities · " + m.profiles.length + " materials";
    if (kind === "manpower") {
      const ds = m.machine.map((r) => r.date);
      const span = ds.length ? U.fmtShort(new Date(Math.min.apply(null, ds.map((d) => d.getTime())))) + "–" + U.fmtShort(m.latestShift) : "?";
      return "✓ " + m.machine.length + " days (" + span + ")" + (m.fix ? " · date-fix applied" : "");
    }
    if (kind === "material") return "✓ " + m.onsiteRows + " on-site · " + m.inboundRows + " inbound rows · " + Object.keys(m.byCode).length + " codes";
    if (kind === "progress") return "✓ " + m.installedRowCount + " install records · latest " + U.fmtShort(m.maxDate);
    return "✓ loaded";
  }

  // True once the chainage model + all three workbooks are parsed.
  function allLoaded() { return state.parsed.chainage && state.parsed.manpower && state.parsed.material && state.parsed.progress; }

  // Recompute the loaded-file count; once complete, build defaults and enable the form.
  function refresh() {
    const n = ["manpower", "material", "progress"].filter((k) => state.parsed[k]).length;
    $("#dataStatusBadge").textContent = n + " / 3 loaded";
    $("#dataStatusBadge").className = "badge" + (n === 3 ? " badge--ok" : "");
    if (allLoaded()) {
      try {
        state.store = { chainage: state.parsed.chainage, manpower: state.parsed.manpower, material: state.parsed.material, progress: state.parsed.progress };
        state.defaults = SPP.data.computeDefaults(state.store);
        populateDefaults();
        $("#paramsCard").setAttribute("aria-disabled", "false");
        $("#generateBtn2").disabled = false;
        if (SPP.blueskyUI && SPP.blueskyUI.onDataReady) SPP.blueskyUI.onDataReady();
      } catch (err) {
        U.toast("Defaults error: " + err.message, "bad");
      }
    } else {
      $("#paramsCard").setAttribute("aria-disabled", "true");
      $("#generateBtn2").disabled = true;
    }
  }

  // Attempt to fetch bundled ./data files (only succeeds over http, not file://).
  function tryBundled() {
    const map = {
      manpower: "data/manpower_resources.xlsx",
      material: "data/material_avalibility.xlsx",
      progress: "data/progress_history.xlsx"
    };
    const kinds = Object.keys(map);
    let ok = 0, done = 0;
    kinds.forEach((kind) => {
      setStatus(kind, "Fetching…");
      fetch(map[kind]).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
        .then((data) => {
          state.parsed[kind] = SPP.data.parseWorkbookFile(data, kind);
          setStatus(kind, summarize(kind, state.parsed[kind]), "is-ok"); ok++;
        })
        .catch((err) => setStatus(kind, "✗ " + err.message + " (use upload instead)", "is-bad"))
        .finally(() => { if (++done === kinds.length) { refresh(); if (ok < kinds.length) revealDataCard(); } });
    });
  }

  // Fallback: if auto-loading from ./data/ didn't fully succeed (e.g. opened via file://),
  // un-hide the Data Files card so the planner can upload the files manually.
  function revealDataCard() {
    const card = $("#dataCard");
    if (card) card.hidden = false;
    U.toast("Couldn't auto-load all files from ./data/ — serve over http, or upload them manually.", "bad");
  }

  /* ============================ DEFAULTS -> FORM ============================ */
  function populateDefaults() {
    const d = state.defaults, ch = state.store.chainage;
    buildPriorityDropdown(ch, Array.from(selectedPriorities));

    // Auto-computed fields show greyed (as defaults); once edited they turn solid and
    // the hint reveals the original auto value.
    markComputed("#pStart", "#pStartHint", U.fmtISO(d.planStartDefault),
      " (Planning Starts Following Monday)");
    // Never allow backdating: the earliest selectable date is always the next
    // Monday on/after today, regardless of what's already typed/computed.
    $("#pStart").min = U.fmtISO(d.planStartDefault);
    // Machines/Manpower/Productivity: read-only SDP averages table (applyAverages) as
    // reference, plus an editable Planned table. The Planned inputs stay empty with the
    // 7-day actuals shown as a FIXED placeholder (they don't move with the 7/30 toggle;
    // a blank field falls back to that actual). Workhours stays a scope-column input.
    markComputed("#pWorkhours", "#pWorkhoursHint", d.workhours, "7-day onsite Avg", "7 Day On-site Average = ");
    // Plan Parameters are user inputs — start empty (no placeholder). A blank field
    // still falls back to the on-site actual when the plan runs, so Process Plan works.
    clearPlanned();
    // Ramp always follows the 7-day (primary) basis the plan defaults to.
    setVal("#pRampN", d.rampN != null ? d.rampN : 7);
    setVal("#pRampProfile", (d.rampProfile || [1]).join(", "));
    prodWindow = 7;
    U.$$("#pProdWindowSeg .seg__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.window === "7"));
    applyAverages();

    // Machines from previous plan: always defaults to the current machines count
    // (i.e. treat the current crew as already-deployed, no ramp), so the SAME
    // visible configuration always yields the SAME plan. Previously this was
    // auto-filled from a localStorage count persisted by the last Process Plan
    // click, which silently changed results between otherwise-identical runs.
    // The planner can still edit this field manually for a real sequential plan.
    setVal("#pPrevMachines", d.machines);
    $("#pPrevHint").textContent = "defaults to machines (no ramp); edit for a follow-on plan";

    $("#paramsPlaceholder").hidden = true;
    $("#paramsForm").hidden = false;
    $("#paramsFoot").hidden = false;
    refreshCapNotice();
    renderRampChart();
    refreshHindranceCalendars();
    renderHindranceSummary();
  }
  // Set an input's value by selector (no-op if the element is missing).
  function setVal(sel, v) { const n = $(sel); if (n) n.value = v; }
  // Show a value as a placeholder (empty actual value) — used by the Planned table.
  function setPlaceholder(sel, v) { const n = $(sel); if (n) { n.value = ""; n.placeholder = String(v); } }

  // Planned resource values used by the engine: the planner's typed value, else the
  // 7-day on-site actual (also shown as the field's placeholder). The 7/30-day toggle
  // only changes the read-only SDP reference table — never these planned defaults.
  function actualDefault(key) { return state.defaults ? (state.defaults[key] || 0) : 0; }
  function plannedMachines() { const v = parseInt($("#pMachines").value, 10); return isFinite(v) ? v : actualDefault("machines"); }
  // Manpower is DERIVED: 6 people per planned machine (read-only field).
  function plannedManpower() { return plannedMachines() * 6; }
  function plannedProductivity() { const v = U.toNum($("#pProductivity").value); return (isFinite(v) && v > 0) ? v : actualDefault("productivity"); }
  // Repaint the read-only Planned Manpower field = machines × 6, but blank while the
  // Machine field is empty (no auto value until the planner enters machines).
  function refreshPlannedManpower() {
    const raw = ($("#pMachines").value || "").trim(), n = parseInt(raw, 10);
    setVal("#pManpower", (raw !== "" && isFinite(n)) ? n * 6 : "");
  }
  // Clear the editable Plan Parameters back to empty (no placeholders).
  function clearPlanned() {
    ["#pMachines", "#pProductivity"].forEach((sel) => { const n = $(sel); if (n) { n.value = ""; n.placeholder = "--"; } });
    refreshPlannedManpower();
  }

  // Switch the Productivity field's basis (7-day / 30-day) and re-populate it.
  function setProdWindow(days) {
    if (days !== 7 && days !== 30) return;
    prodWindow = days;
    U.$$("#pProdWindowSeg .seg__btn").forEach((b) => b.classList.toggle("is-active", parseInt(b.dataset.window, 10) === days));
    applyAverages();
    renderRampChart();
  }
  // Fill the read-only SDP averages table (Productivity / Machine / Manpower) AND the
  // hidden inputs the engine reads, plus the ramp fields — all switched together to
  // the selected 7/30-day window so the plan basis stays internally consistent.
  // Fill ONLY the read-only SDP reference table (Productivity / Machine / Manpower)
  // for the selected 7/30-day window. It is display-only — it never seeds the editable
  // Planned inputs, whose placeholders stay fixed on the 7-day actuals.
  function applyAverages() {
    const d = state.defaults; if (!d) return;
    const is30 = prodWindow === 30;
    const prod = is30 ? d.productivity30 : d.productivity;
    const mach = is30 ? d.machines30 : d.machines;
    const man  = is30 ? d.manpower30 : d.manpower;
    const set = (sel, txt) => { const n = $(sel); if (n) n.textContent = txt; };
    set("#avgProd", U.fmtNum(prod, 3));
    set("#avgMachine", U.fmtInt(mach));
    set("#avgManpower", U.fmtInt(man));
    set("#avgTableHeading", prodWindow + " Day On-site Average as Per SDP");
    const derivation = is30 ? d.prodDerivation30 : d.prodDerivation;
    const rampExplanation = is30 ? d.rampExplanation30 : d.rampExplanation;
    set("#prodInfoPop", derivation + " · " + (rampExplanation || ""));
    // The ramp profile is derived per window, so switch it with the 7/30-day basis —
    // the live ramp-up curve (and the engine) then follow the selected tab.
    const rampN = is30 ? d.rampN30 : d.rampN;
    const rampProfile = is30 ? d.rampProfile30 : d.rampProfile;
    setVal("#pRampN", rampN != null ? rampN : 7);
    setVal("#pRampProfile", (rampProfile || [1]).join(", "));
  }

  /* ---- Priority pill dropdown (multi-select) -------------------------------- */
  function buildPriorityDropdown(ch, keep) {
    const menu = $("#pPriorityMenu"); if (!menu) return;
    U.clear(menu);
    selectedPriorities.clear();
    (keep || []).forEach((p) => { if (ch.priorities.indexOf(p) >= 0) selectedPriorities.add(p); });
    ch.priorities.forEach((p) => {
      const opt = el("div", { class: "ms__opt", role: "option", dataset: { prio: p }, "aria-selected": "false",
        onclick: () => togglePriority(p) });
      opt.appendChild(el("span", { class: "ms__check", html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>' }));
      const body = el("span", { class: "ms__opt-body" });
      body.appendChild(el("span", { class: "ms__opt-name", text: p }));
      body.appendChild(el("span", { class: "ms__opt-meta", text: U.fmtInt(ch.priorityCounts[p]) + " chainages" }));
      opt.appendChild(body);
      menu.appendChild(opt);
    });
    syncPriority();
  }
  // Add/remove a priority from the selection (menu row clicked).
  function togglePriority(p) {
    if (selectedPriorities.has(p)) selectedPriorities.delete(p); else selectedPriorities.add(p);
    syncPriority();
  }
  // Remove a priority from the selection (pill x clicked).
  function removePriority(p) { selectedPriorities.delete(p); syncPriority(); }
  // Priorities in canonical (priority-ranked) order, e.g. P-1a > P-1b > P-1c > P-2.
  function orderedSelectedPriorities(ch) {
    return (ch.priorities || []).filter((p) => selectedPriorities.has(p));
  }
  // Repaint the priority pills + menu checked state from selectedPriorities.
  function syncPriority() {
    const pills = $("#pPriorityPills"); if (!pills) return;
    const ch = state.parsed.chainage;
    U.clear(pills);
    const ordered = ch ? orderedSelectedPriorities(ch) : Array.from(selectedPriorities);
    if (!ordered.length) {
      pills.appendChild(el("span", { class: "ms__placeholder", text: "Select One or More Priorities" }));
    } else {
      ordered.forEach((p) => {
        const pill = el("span", { class: "ms__pill" });
        pill.appendChild(el("span", { text: p }));
        pill.appendChild(el("button", { type: "button", class: "ms__pill-x", title: "Remove " + p, html: "&times;",
          onclick: (e) => { e.stopPropagation(); removePriority(p); } }));
        pills.appendChild(pill);
      });
    }
    U.$$("#pPriorityMenu .ms__opt").forEach((o) => {
      const on = selectedPriorities.has(o.dataset.prio);
      o.classList.toggle("is-sel", on); o.setAttribute("aria-selected", String(on));
    });
  }
  // Open/close the priority options popover.
  function togglePriorityMenu() { $("#pPriorityMenu").hidden ? openPriorityMenu() : closePriorityMenu(); }
  // Show the priority popover and set open state/aria.
  function openPriorityMenu() { $("#pPriorityMenu").hidden = false; $("#pPriorityMS").classList.add("is-open"); $("#pPriorityControl").setAttribute("aria-expanded", "true"); }
  // Hide the priority popover (outside-click or after a pick).
  function closePriorityMenu() { const m = $("#pPriorityMenu"); if (!m) return; m.hidden = true; $("#pPriorityMS").classList.remove("is-open"); $("#pPriorityControl").setAttribute("aria-expanded", "false"); }

  /* ---- Work Days / week pill dropdown (single-select, same look as priority) --- */
  const WORK_DAYS_OPTIONS = [
    { value: "5", label: "5 (Mon–Fri)" },
    { value: "6", label: "6 (Mon–Sat)" },
    { value: "7", label: "7 (all days)" }
  ];
  function buildWorkDaysDropdown() {
    const menu = $("#pWorkDaysMenu"); if (!menu) return;
    U.clear(menu);
    WORK_DAYS_OPTIONS.forEach((o) => {
      const opt = el("div", { class: "ms__opt", role: "option", dataset: { val: o.value }, "aria-selected": "false",
        onclick: () => chooseWorkDays(o.value) });
      opt.appendChild(el("span", { class: "ms__check", html:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>' }));
      const body = el("span", { class: "ms__opt-body" });
      body.appendChild(el("span", { class: "ms__opt-name", text: o.label }));
      opt.appendChild(body);
      menu.appendChild(opt);
    });
    syncWorkDays();
  }
  // Select a work-days value, close the menu, and fire a change event for listeners.
  function chooseWorkDays(v) {
    const input = $("#pWorkDays");
    const changed = input.value !== v;
    input.value = v;
    closeWorkDaysMenu();
    syncWorkDays();
    if (changed) input.dispatchEvent(new Event("change"));
  }
  // Repaint the plain-text value + menu selected state from #pWorkDays' current value.
  function syncWorkDays() {
    const pills = $("#pWorkDaysPills"); if (!pills) return;
    const v = $("#pWorkDays").value;
    const cur = WORK_DAYS_OPTIONS.find((o) => o.value === v);
    U.clear(pills);
    pills.appendChild(el("span", { class: cur ? "" : "ms__placeholder", text: cur ? cur.label : "Select…" }));
    U.$$("#pWorkDaysMenu .ms__opt").forEach((o) => {
      const on = o.dataset.val === v;
      o.classList.toggle("is-sel", on); o.setAttribute("aria-selected", String(on));
    });
  }
  // Open/close the work-days options popover.
  function toggleWorkDaysMenu() { $("#pWorkDaysMenu").hidden ? openWorkDaysMenu() : closeWorkDaysMenu(); }
  function openWorkDaysMenu() { $("#pWorkDaysMenu").hidden = false; $("#pWorkDaysMS").classList.add("is-open"); $("#pWorkDaysControl").setAttribute("aria-expanded", "true"); }
  function closeWorkDaysMenu() { const m = $("#pWorkDaysMenu"); if (!m) return; m.hidden = true; $("#pWorkDaysMS").classList.remove("is-open"); $("#pWorkDaysControl").setAttribute("aria-expanded", "false"); }

  // Show an auto-computed field greyed; when the planner edits it, turn it solid and
  // surface the original computed value in the hint below.
  function markComputed(inputSel, hintSel, autoVal, baseHint, editedLabel) {
    const input = $(inputSel), hint = $(hintSel);
    if (!input) return;
    input.value = autoVal;
    input.dataset.computed = String(autoVal);
    // Prefix shown once the field is edited, followed by the original auto value.
    input.dataset.editedLabel = editedLabel || "Edited · auto was ";
    input.classList.add("is-computed"); input.classList.remove("is-edited");
    if (hint) { hint.dataset.base = baseHint; hint.textContent = baseHint; }
    if (!input.dataset.compBound) {
      input.dataset.compBound = "1";
      const onEdit = () => {
        const edited = String(input.value) !== input.dataset.computed;
        input.classList.toggle("is-computed", !edited);
        input.classList.toggle("is-edited", edited);
        if (hint) {
          if (edited) hint.innerHTML = "<span class='hint-auto'>" + U.esc(input.dataset.editedLabel) + U.esc(input.dataset.computed) + "</span>";
          else hint.textContent = hint.dataset.base || "";
        }
      };
      input.addEventListener("input", onEdit);
      input.addEventListener("change", onEdit);
    }
  }

  /* ============================ PARAM HELPERS ============================ */
  function enforceMonday(e) {
    const d = U.parseISODate(e.target.value);
    if (!d) return;
    const monday = U.isMonday(d) ? d : U.addDays(d, -(U.isoDow(d) - 1)); // back to Monday of that week
    // Backdating guard first — the `min` attribute stops the native picker, but
    // a typed/pasted value can bypass it, so re-check here too.
    const floor = U.nextMondayFromToday();
    if (U.cmpDate(monday, floor) < 0) {
      e.target.value = U.fmtISO(floor);
      U.toast("Plan start can't be backdated — snapped to " + U.fmtFriendly(floor), "");
      return;
    }
    if (!U.isMonday(d)) {
      e.target.value = U.fmtISO(monday);
      U.toast("Plan start must be a Monday — snapped to " + U.fmtFriendly(monday), "");
    }
  }

  // Show/hide the 'machines capped by manpower (6/machine)' notice as inputs change.
  function refreshCapNotice() {
    const machines = plannedMachines();
    const manpower = plannedManpower();
    const notice = $("#capNotice");
    if (!isFinite(machines) || !isFinite(manpower)) { notice.hidden = true; return; }
    const cap = Math.floor(manpower / 6);
    if (machines > cap) {
      notice.hidden = false;
      notice.textContent = "Capped to " + cap + " machine" + (cap === 1 ? "" : "s") + " — manpower " + manpower + " supports " + cap + "×6 = " + (cap * 6) + " people. The engine will use " + cap + ".";
    } else { notice.hidden = true; }
  }

  // Hindrance types: "Political"/"Weather" are single-use across rows; "Other" repeats.
  const HIND_TYPES = ["Political", "Weather", "Other"];
  // Rebuild every hindrance row's type dropdown so a non-repeatable type picked in one
  // row is not offered in the others (each row keeps its own current value).
  function refreshHindranceTypeOptions() {
    const rows = U.$$("#hindranceList .hindrance");
    rows.forEach((row) => {
      const sel = row.querySelector(".hindrance__type"); if (!sel) return;
      const current = sel.value;
      const usedElsewhere = new Set();
      rows.forEach((r2) => { if (r2 !== row) { const v = r2.querySelector(".hindrance__type").value; if (v && v !== "Other") usedElsewhere.add(v); } });
      U.clear(sel);
      HIND_TYPES.forEach((tp) => {
        if (tp !== "Other" && usedElsewhere.has(tp) && tp !== current) return;   // taken by another row
        sel.appendChild(el("option", { value: tp, text: tp, selected: tp === current ? "" : null }));
      });
      sel.value = current;
    });
  }

  // Append an editable hindrance row (type/amount/unit + a Mon-aligned day calendar).
  function addHindranceRow(data) {
    data = data || {};
    const list = $("#hindranceList");
    const row = el("div", { class: "hindrance" });

    const top = el("div", { class: "hindrance__top" });
    // Default a new row to the first still-available (non-repeated) type.
    const usedByOthers = new Set(U.$$("#hindranceList .hindrance .hindrance__type").map((s) => s.value).filter((v) => v && v !== "Other"));
    const defType = data.type || HIND_TYPES.find((t) => !usedByOthers.has(t)) || "Other";
    const type = el("select", { class: "input input--sm hindrance__type" });
    HIND_TYPES.forEach((t) => type.appendChild(el("option", { value: t, text: t, selected: t === defType ? "" : null })));
    type.value = defType;
    type.addEventListener("change", refreshHindranceTypeOptions);
    const amt = el("input", { class: "input input--sm hindrance__amt", type: "number", min: "0", step: "1", value: data.amount != null ? data.amount : "", placeholder: "0", title: "days unit: number of days lost (auto-selects the earliest working days) · hours unit: hours lost per selected day" });
    const unit = el("select", { class: "input input--sm hindrance__unit" });
    ["days", "hours"].forEach((u) => unit.appendChild(el("option", { value: u, text: u, selected: data.unit === u ? "" : null })));
    const del = el("button", { class: "hindrance__del", title: "Remove", html: "&times;", onclick: () => { row.remove(); refreshHindranceTypeOptions(); } });
    [type, amt, unit, del].forEach((n) => top.appendChild(n));
    row.appendChild(top);

    const daysWrap = el("div", { class: "hindrance__days" });
    daysWrap.appendChild(el("div", { class: "hindrance__days-label", text: "Affected day(s):" }));
    const cal = el("div", { class: "hcal" });
    daysWrap.appendChild(cal);
    row.appendChild(daysWrap);

    row.appendChild(el("div", { class: "hindrance__hint", html: "<strong>days</strong>: enter the number of affected days, then click exactly that many dates (a warning shows if you try to exceed it — deselect a day to free a slot). <strong>hours</strong>: enter the hours lost per day, then click any number of dates." }));

    // The affected days/hours value gates the calendar. Nothing is selectable while it
    // is 0. For the DAYS unit the selection is hard-capped at that number (over-select
    // warns and is blocked); for HOURS any number of dates can be picked. No auto-select.
    function dayCap() {
      const n = parseInt(amt.value, 10);
      return (isFinite(n) && n > 0) ? n : 0;
    }
    function trimSelection() {
      const cells = U.$$(".hcal__day", cal);
      if (!(U.toNum(amt.value) > 0)) { cells.forEach((c) => c.classList.remove("is-sel")); return; }   // value 0 → nothing selectable
      if (unit.value !== "days") return;                                                               // hours: any number of dates
      const cap = dayCap();
      let sel = U.$$(".hcal__day.is-sel", cal);
      while (sel.length > cap) { sel[sel.length - 1].classList.remove("is-sel"); sel = U.$$(".hcal__day.is-sel", cal); }   // trim extras if the number is lowered
    }
    cal.addEventListener("click", (e) => {
      const c = e.target.closest(".hcal__day"); if (!c) return;
      if (c.classList.contains("is-sel")) { c.classList.remove("is-sel"); return; }                    // deselect is always allowed
      if (c.classList.contains("is-weekoff")) { U.toast("That day is a non-working day (outside the plan) — it can't be selected.", "bad"); return; }   // off-days aren't in the plan
      if (!(U.toNum(amt.value) > 0)) { U.toast("Enter the affected " + unit.value + " first.", ""); return; }   // 0 → can't select any date
      if (unit.value !== "days") { c.classList.add("is-sel"); return; }                                // hours: free multi-select (working days only)
      const cap = dayCap();
      if (U.$$(".hcal__day.is-sel", cal).length >= cap) {                                              // days: hard cap + warning
        U.toast("Cannot select more than " + cap + " day" + (cap === 1 ? "" : "s") + ".", "bad"); return;
      }
      c.classList.add("is-sel");
    });
    // Cap the affected value to what the plan window can lose:
    //   days  → working days in the window (plan period × work-days/week)
    //   hours → those working days × 24  (e.g. 2 weeks × 6 days × 24 = 288 h)
    function windowWorkingDays() { return U.$$(".hcal__day:not(.is-weekoff)", cal).length; }
    function clampAmt() {
      const maxD = windowWorkingDays();
      const n = U.toNum(amt.value);
      if (unit.value === "days") {
        amt.max = String(maxD);
        if (isFinite(n) && maxD > 0 && n > maxD) {
          amt.value = String(maxD);
          U.toast("Affected days can't exceed " + maxD + " — the plan window only has " + maxD + " working day" + (maxD === 1 ? "" : "s") + ". Capped to " + maxD + ".", "bad");
        }
      } else {
        const maxH = maxD * 24;
        amt.max = String(maxH);
        if (isFinite(n) && maxH > 0 && n > maxH) {
          amt.value = String(maxH);
          U.toast("Affected hours can't exceed " + maxH + " — the plan window has " + maxD + " working day" + (maxD === 1 ? "" : "s") + " × 24 h. Capped to " + maxH + ".", "bad");
        }
      }
    }
    function onAmtOrUnit() { clampAmt(); trimSelection(); }
    amt.addEventListener("input", onAmtOrUnit);
    amt.addEventListener("change", onAmtOrUnit);
    unit.addEventListener("change", onAmtOrUnit);
    list.appendChild(row);
    refreshHindranceTypeOptions();   // keep single-use types unique across all rows
    buildHindranceCalendar(cal, data.days || []);
    onAmtOrUnit();   // restored rows: clamp to the window + keep selection within the saved value
  }

  // TODO: confirm persistence — selected hindrance day(s) are kept in-session (in the
  // form) and carried into scheduling, but are not written to localStorage across reloads.
  function readHindrances() {
    return U.$$("#hindranceList .hindrance").map((row) => ({
      type: row.querySelector(".hindrance__type").value,
      amount: U.toNum(row.querySelector(".hindrance__amt").value) || 0,
      unit: row.querySelector(".hindrance__unit").value,
      days: U.$$(".hcal__day.is-sel", row).map((c) => c.dataset.iso)
    })).filter((h) => h.days.length > 0 || h.amount > 0);
  }

  // Render the affected-day picker for the current plan window (Mon-aligned weeks).
  function buildHindranceCalendar(cal, selectedISO) {
    U.clear(cal);
    const planStart = U.parseISODate($("#pStart").value) || (state.defaults && state.defaults.planStartDefault);
    if (!planStart) { cal.appendChild(el("div", { class: "field__hint", text: "Set a plan start date first." })); return; }
    const weeks = parseInt((document.querySelector('input[name="period"]:checked') || {}).value || "2", 10);
    const workDays = parseInt($("#pWorkDays").value, 10) || 6;
    const sel = new Set(selectedISO || []);
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((w) => cal.appendChild(el("div", { class: "hcal__hd", text: w })));
    for (let i = 0; i < weeks * 7; i++) {
      const d = U.addDays(planStart, i);
      const iso = U.fmtISO(d);
      const weekoff = U.isoDow(d) > workDays;
      cal.appendChild(el("div", {
        // A day that has become a weekly-off (e.g. after reducing Work Days/week) is
        // never kept selected — only working days can carry a selection.
        class: "hcal__day" + (weekoff ? " is-weekoff" : "") + ((!weekoff && sel.has(iso)) ? " is-sel" : ""),
        title: U.fmtFriendly(d) + (weekoff ? " (weekly off)" : ""),
        dataset: { iso: iso }, text: String(d.getDate())
      }));
    }
  }

  // Rebuild every hindrance calendar after the window changes, keeping in-window picks.
  function refreshHindranceCalendars() {
    U.$$("#hindranceList .hindrance").forEach((row) => {
      const cal = row.querySelector(".hcal");
      const keep = U.$$(".hcal__day.is-sel", cal).map((c) => c.dataset.iso);
      buildHindranceCalendar(cal, keep);
      const amt = row.querySelector(".hindrance__amt");
      if (amt) amt.dispatchEvent(new Event("input", { bubbles: true }));   // re-apply the day-count cap to the rebuilt calendar
    });
  }

  /* ---- Hindrance modal: the editor rows live inside a popup; the card shows a
     read-only summary + the "+ Add hindrance" button that opens it. --------- */
  // Open the popup (seed with one empty row if none exist) and sync the calendars.
  function openHindranceModal() {
    const m = $("#hindranceModal"); if (!m) return;
    if (!U.$$("#hindranceList .hindrance").length) addHindranceRow();
    refreshHindranceCalendars();   // match the calendars to the current plan window
    m.hidden = false;
  }
  // Close the popup: drop rows left empty, then repaint the card summary.
  function closeHindranceModal() {
    const m = $("#hindranceModal"); if (!m) return;
    U.$$("#hindranceList .hindrance").forEach((row) => {
      const amt = U.toNum(row.querySelector(".hindrance__amt").value) || 0;
      const days = U.$$(".hcal__day.is-sel", row).length;
      if (amt <= 0 && days === 0) row.remove();   // nothing configured — discard
    });
    refreshHindranceTypeOptions();
    m.hidden = true;
    renderHindranceSummary();
  }
  // Repaint the card's read-only chips from the currently configured hindrances.
  function renderHindranceSummary() {
    const host = $("#hindranceSummary"); if (!host) return;
    const hs = readHindrances();
    U.clear(host);
    if (!hs.length) { host.appendChild(el("span", { class: "field__hint", text: "No hindrances added yet." })); return; }
    hs.forEach((h) => {
      const amtTxt = h.unit === "days"
        ? (h.days.length || h.amount) + " day" + ((h.days.length || h.amount) === 1 ? "" : "s")
        : h.amount + " hr" + (h.amount === 1 ? "" : "s") + (h.days.length ? " × " + h.days.length + "d" : "");
      const chip = el("span", { class: "hind-chip" });
      chip.appendChild(el("span", { class: "hind-chip__type", text: h.type }));
      chip.appendChild(el("span", { class: "hind-chip__meta", text: amtTxt }));
      host.appendChild(chip);
    });
  }

  /* ============================ RAMP-UP CURVE (Change 5) ============================ */
  // TODO: confirm Y-axis meaning — assumed "productivity rate" = piles/machine/hour
  // (base productivity × ramp multiplier), not piles/day.
  function renderRampChart() {
    const host = $("#rampChart");
    if (!host) return;
    // Preview uses the SELECTED-WINDOW SDP productivity so the curve tracks the 7/30-day
    // tab (falls back to the planned value if defaults aren't loaded yet).
    const d = state.defaults;
    const prod = d ? (prodWindow === 30 ? d.productivity30 : d.productivity) : plannedProductivity();
    const ramp = $("#pRampProfile").value.split(",").map((s) => U.toNum(s)).filter((n) => isFinite(n) && n >= 0);
    const nDays = parseInt($("#pRampN").value, 10);
    if (!(prod > 0) || !ramp.length) { host.innerHTML = '<div class="field__hint">Enter productivity and a ramp profile to preview the curve.</div>'; return; }

    const last = ramp[ramp.length - 1];
    const maxDay = ramp.length - 1 + 2;                 // show 2 steady days past the profile
    const pts = [];
    for (let k = 0; k <= maxDay; k++) { const m = k < ramp.length ? ramp[k] : last; pts.push({ day: k, rate: prod * m, mult: m }); }
    // Y-axis ceiling = the steady-state rate itself (prod × last ramp
    // multiplier), not curve-max + headroom — the axis top lines up exactly
    // with the steady-state dashed line.
    const yMax = (prod * last) || 1;

    const W = 320, H = 124, ml = 40, mr = 12, mt = 12, mb = 24, plotW = W - ml - mr, plotH = H - mt - mb;
    const X = (k) => ml + (maxDay ? (k / maxDay) * plotW : 0);
    const Y = (r) => mt + plotH - (r / yMax) * plotH;
    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" font-size="9" font-family="inherit">';
    // axes
    s += '<line x1="' + ml + '" y1="' + mt + '" x2="' + ml + '" y2="' + (mt + plotH) + '" stroke="#c3ccda"/>';
    s += '<line x1="' + ml + '" y1="' + (mt + plotH) + '" x2="' + (ml + plotW) + '" y2="' + (mt + plotH) + '" stroke="#c3ccda"/>';
    // steady-state line
    const ys = Y(prod * last);
    s += '<line x1="' + ml + '" y1="' + ys + '" x2="' + (ml + plotW) + '" y2="' + ys + '" stroke="#1f8f5f" stroke-dasharray="3 3"/>';
    s += '<text x="' + (ml + plotW) + '" y="' + (ys - 3) + '" text-anchor="end" fill="#1f8f5f">steady ' + U.fmtNum(prod * last, 2) + '</text>';
    // n marker
    if (isFinite(nDays) && nDays >= 0 && nDays <= maxDay) {
      const xn = X(nDays);
      s += '<line x1="' + xn + '" y1="' + mt + '" x2="' + xn + '" y2="' + (mt + plotH) + '" stroke="#b6791f" stroke-dasharray="2 2"/>';
      s += '<text x="' + (xn + 3) + '" y="' + (mt + 9) + '" fill="#b6791f">n=' + nDays + '</text>';
    }
    // y ticks
    s += '<text x="' + (ml - 5) + '" y="' + (mt + plotH + 3) + '" text-anchor="end" fill="#8a96a5">0</text>';
    s += '<text x="' + (ml - 5) + '" y="' + (mt + 8) + '" text-anchor="end" fill="#8a96a5">' + U.fmtNum(yMax, 2) + '</text>';
    // x ticks
    s += '<text x="' + ml + '" y="' + (H - 7) + '" text-anchor="middle" fill="#8a96a5">0</text>';
    s += '<text x="' + (ml + plotW) + '" y="' + (H - 7) + '" text-anchor="middle" fill="#8a96a5">' + maxDay + '</text>';
    s += '<text x="' + (ml + plotW / 2) + '" y="' + (H - 7) + '" text-anchor="middle" fill="#8a96a5">days from start</text>';
    s += '<text transform="translate(10,' + (mt + plotH / 2) + ') rotate(-90)" text-anchor="middle" fill="#8a96a5">piles / mc / hr</text>';
    // curve
    s += '<polyline points="' + pts.map((p) => X(p.day) + ',' + Y(p.rate)).join(" ") + '" fill="none" stroke="#0f6e78" stroke-width="2"/>';
    pts.forEach((p) => { s += '<circle cx="' + X(p.day) + '" cy="' + Y(p.rate) + '" r="2.5" fill="#0f6e78"><title>Day ' + p.day + ': ' + U.fmtNum(p.rate, 3) + ' piles/mc/hr (×' + U.fmtNum(p.mult, 2) + ')</title></circle>'; });
    s += '</svg>';
    host.innerHTML = s;
  }


  /* ============================ GENERATE ============================ */
  // Show all warnings together; the planner either Proceeds (plan is shown as-is with
  // the warnings in the Validation panel) or Aborts (nothing generated — back to the form).
  function confirmWarnings(warns) {
    return new Promise((resolve) => {
      const modal = $("#warnModal");
      $("#warnCount").textContent = warns.length + (warns.length === 1 ? " warning" : " warnings");
      const list = $("#warnModalList"); U.clear(list);
      const icon = { bad: "⛔", warn: "⚠", info: "ℹ" };
      warns.forEach((w) => list.appendChild(el("li", { class: "w-" + w.level }, [
        el("span", { class: "warnlist__icon", text: icon[w.level] || "•" }),
        document.createTextNode(" " + w.text)
      ])));
      modal.hidden = false;
      const proceed = $("#warnProceed"), abort = $("#warnAbort");
      // Close the warnings modal and resolve the confirmation promise.
      function cleanup(val) { modal.hidden = true; proceed.onclick = abort.onclick = null; resolve(val); }
      proceed.onclick = () => cleanup(true);
      abort.onclick = () => cleanup(false);
    });
  }

  // Validate inputs, run the engine, confirm any warnings, then play the loader and render.
  async function onGenerate() {
    if (!allLoaded()) { U.toast("Load the manpower, material and progress files first.", "bad"); return; }
    const p = gatherParams();
    if (!p) return;

    let result;
    try { result = SPP.engine.generate(state.store, p); }
    catch (err) { U.toast("Plan failed: " + err.message, "bad"); console.error(err); return; }

    // (Warnings review modal removed — generate directly; any warnings still surface
    // in the plan's validation panel.)
    state.result = result;

    const finish = () => {
      renderAll();
      U.toast("Plan generated — " + result.deployed + " machine(s) deployed.", "ok");
      window.scrollTo({ top: 0, behavior: "smooth" });   // start from top: header → collapsed panel → Plan
    };
    // Run the shared checklist loader (constant ~5s), then reveal the plan.
    if (SPP.blueskyUI && SPP.blueskyUI.runLoader) SPP.blueskyUI.runLoader(finish, PLANNER_LOADER_STEPS);
    else finish();
  }
  const PLANNER_LOADER_STEPS = [
    "Reading site data & progress",
    "Netting installed piles",
    "Ordering work queue by material",
    "Simulating daily installation",
    "Optimizing machine count",
    "Generating plan"
  ];

  // Read + validate the planner form into an engine params object (returns null on error).
  function gatherParams() {
    const ch = state.parsed.chainage;
    // Required inputs, validated in order: Chainage Priority → Productivity → Machine.
    const priorities = ch ? orderedSelectedPriorities(ch) : Array.from(selectedPriorities);
    if (!priorities.length) { U.toast("Choose at least one chainage priority.", "bad"); openPriorityMenu(); return null; }
    const prodRaw = ($("#pProductivity").value || "").trim();
    if (prodRaw === "" || !(U.toNum(prodRaw) > 0)) { U.toast("Enter productivity (piles / machine / hour) in Plan Parameters.", "bad"); $("#pProductivity").focus(); return null; }
    const machRaw = ($("#pMachines").value || "").trim();
    if (machRaw === "" || !(parseInt(machRaw, 10) > 0)) { U.toast("Enter the number of machines in Plan Parameters.", "bad"); $("#pMachines").focus(); return null; }

    const planStart = U.parseISODate($("#pStart").value);
    if (!planStart) { U.toast("Pick a plan start date.", "bad"); return null; }
    if (!U.isMonday(planStart)) { U.toast("Plan start must be a Monday.", "bad"); return null; }
    if (U.cmpDate(planStart, U.nextMondayFromToday()) < 0) { U.toast("Plan start can't be backdated.", "bad"); return null; }

    const periodWeeks = parseInt((document.querySelector('input[name="period"]:checked') || {}).value || "2", 10);
    // Planned values: typed override, else the 7-day actual shown as placeholder.
    const machinesInput = plannedMachines();
    const manpower = plannedManpower();
    const workDaysPerWeek = parseInt($("#pWorkDays").value, 10);
    const workhours = parseInt($("#pWorkhours").value, 10);
    const productivity = plannedProductivity();
    const rampN = parseInt($("#pRampN").value, 10) || 0;
    const prevMachines = Math.max(0, parseInt($("#pPrevMachines").value, 10) || 0);
    const rampProfile = $("#pRampProfile").value.split(",").map((s) => U.toNum(s)).filter((n) => isFinite(n) && n >= 0);

    if (!(machinesInput >= 0)) { U.toast("Machines must be ≥ 0.", "bad"); return null; }
    if (!(manpower > 0)) { U.toast("Manpower must be positive.", "bad"); return null; }
    if (!(workhours > 0)) { U.toast("Workhours must be positive.", "bad"); return null; }
    if (!(productivity > 0)) { U.toast("Productivity must be greater than 0.", "bad"); return null; }

    return { priorities, periodWeeks, planStart, machinesInput, manpower, workDaysPerWeek, workhours,
             productivity, rampN, prevMachines, rampProfile: rampProfile.length ? rampProfile : [1],
             hindrances: readHindrances() };
  }

  /* ============================ RENDER (top) ============================ */
  function renderAll() {
    const r = state.result;
    $("#resultsCard").hidden = false;
    $("#resultsEmpty").hidden = true;
    $("#viewToggle").hidden = false;
    $("#validationCard").hidden = true;   // "Manpower resources and productivity" section removed from the view
    $("#exportPlanBtn").hidden = false;

    const periodLbl = r.params.periodWeeks + " weeks";
    $("#planMeta").innerHTML =
      "<span>" + U.esc(r.params.priorities.join(", ")) + "</span><span>" + periodLbl + "</span>" +
      "<span>" + U.fmtFriendly(r.planStart) + " → " + U.fmtFriendly(r.planEnd) + "</span>" +
      "<span>" + r.deployed + (r.deployed !== r.maxMachines ? "/" + r.maxMachines : "") + " machine" + (r.deployed === 1 ? "" : "s") + "</span>" +
      "<span>" + r.workingDayCount + " working days</span>";

    renderSummary();
    $("#materialCheckCard").hidden = false;
    renderMaterialCheck();
    renderMaterial();
    renderTable();
    // renderValidation();  // section removed from the UI (kept in code for reference)
    $("#progressCard").hidden = false;
    renderProgressChart();
    setView(state.view);   // the Map is rendered lazily when its view is shown
    setSidebarCollapsed(true);   // collapse inputs on generate for a full-width plan view
  }

  // Collapse/expand the top input panel and keep the toggles in sync.
  function setSidebarCollapsed(collapsed) {
    const panel = $("#paramsCard");
    if (panel) panel.classList.toggle("is-collapsed", collapsed);
    const bar = $("#plannerPanelToggle"); if (bar) bar.setAttribute("aria-expanded", String(!collapsed));
    const btn = $("#sidebarToggle");
    if (btn) {
      btn.hidden = false;
      const ico = '<svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>';
      btn.innerHTML = ico + "<span>" + (collapsed ? "Show inputs" : "Hide inputs") + "</span>";
    }
    // The Map sizes to the content width, so re-render it once the grid has reflowed
    // to the new width (prevents it being cut off).
    if (state.result) requestAnimationFrame(() => {
      if (state.view === "map") renderMap();
    });
  }

  // Export the current plan as a Primavera P6 .xer for the taskmapper system.
  function onExportXer() {
    if (!state.result) { U.toast("Generate a plan first.", "bad"); return; }
    if (!SPP.xer) { U.toast("Exporter not loaded.", "bad"); return; }
    if (!state.result.worked || !state.result.worked.length) {
      U.toast("No scheduled chainages in this plan to export.", "bad"); return;
    }
    try {
      const text = SPP.xer.build(state.result, state.store);
      const name = ("SHP_" + state.result.params.priorities.join("-") + "_" + U.fmtISO(state.result.planStart))
        .replace(/[^A-Za-z0-9_\-]/g, "_") + ".xer";
      downloadText(name, text);
      U.toast("Exported " + name + " (" + state.result.worked.length + " activities)", "ok");
    } catch (e) {
      U.toast("Export failed: " + e.message, "bad");
    }
  }
  // Trigger a browser download of a text blob (used by the .xer export).
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  /* Plan summary: a plain-language headline plus KPI tiles surfacing what a
     planner most wants to read off a freshly generated plan. */
  function renderSummary() {
    const r = state.result, host = $("#planSummary");
    host.hidden = false;
    U.clear(host);

    const covered = r.worked.length;
    const totalCh = r.candidates.length;
    const people = r.deployed * 6;                                   // 6 people per deployed machine
    const idle = Math.max(0, r.params.machinesInput - r.deployed);   // chosen machines the plan doesn't need
    const avgPerDay = r.workingDayCount > 0 ? r.totalInstalled / r.workingDayCount : 0;
    const inboundWindow = r.windowArrivals.reduce((s, a) => s + a.qty, 0);

    const prior = r.installedPriorTotal || 0;
    const priorTxt = prior > 0 ? " (<strong>" + U.fmtInt(prior) + "</strong> already installed)" : "";
    // One concise headline — the numbers live in the tiles below, so no finish clauses here.
    host.appendChild(el("p", { class: "plan-summary__lead", html:
      "This <strong>" + r.params.periodWeeks + "-week</strong> plan for <strong>" + U.esc(r.params.priorities.join(", ")) +
      "</strong> installs <strong>" + U.fmtInt(Math.round(r.totalInstalled)) + "</strong> piles" + priorTxt +
      " across <strong>" + U.fmtInt(covered) + "</strong> of " + U.fmtInt(totalCh) +
      " chainages, using <strong>" + r.deployed + "</strong> machine" + (r.deployed === 1 ? "" : "s") +
      " &amp; <strong>" + U.fmtInt(people) + "</strong> people over <strong>" + r.workingDayCount + "</strong> working days." }));

    // Core KPIs (the rest is in the headline / forecast, keeping this uncluttered).
    host.appendChild(statGrid([
      { label: "Piles Planned", value: U.fmtInt(Math.round(r.totalInstalled)), sub: U.fmtInt(Math.round(avgPerDay)) + "/day avg", tone: "indigo" },
      { label: "Total Work Planned", value: U.fmtInt(r.totalComplete) + " of " + U.fmtInt(r.totalMTO), sub: "piles of scope", tone: "violet" },
      { label: "Productivity", value: U.fmtNum(r.params.productivity, 3), sub: "piles / mc / hr", tone: "sky" },
      { label: "Machines deployed", value: r.deployed, sub: U.fmtInt(people) + " people · " + r.params.workhours + " h/day", tone: "amber" },
      { label: "Idle machines", value: idle, sub: idle > 0 ? "chosen but not needed this window" : "none idle", tone: idle > 0 ? "rose" : "emerald" },
      { label: "Length covered", value: U.fmtNum(r.lengthThisWindowKm || 0, 2) + " km", sub: U.fmtNum(r.lengthCoveredKm || 0, 2) + " km cumulative · of " + U.fmtNum(r.totalScopeLengthKm || 0, 1) + " km scope", tone: "teal" },
      { label: "Chainages covered", value: U.fmtInt(covered) + " / " + U.fmtInt(totalCh), sub: r.blocked.length ? r.blocked.length + " blocked (no material)" : "all reachable", tone: r.blocked.length ? "warn" : "emerald" }
    ]));

    // Forecast completion for the whole priority — two dates as distinct callouts.
    const fc = el("div", { class: "forecast" });
    fc.appendChild(el("div", { class: "forecast__title", text: "Forecast completion · Entire Selected priority" }));
    const grid = el("div", { class: "forecast__grid" });
    [{ s: fullFinishStat(r), cls: "forecast__card--all" }].forEach(({ s, cls }) => {
      const c = el("div", { class: "forecast__card " + cls });
      c.appendChild(el("div", { class: "forecast__lbl", text: s.label }));
      c.appendChild(el("div", { class: "forecast__val", text: s.value }));
      c.appendChild(el("div", { class: "forecast__sub", text: s.sub }));
      grid.appendChild(c);
    });
    fc.appendChild(grid);
    host.appendChild(fc);
  }

  /* Priority & material-wise check — remaining demand vs on-site + in-transit, with
     the day each short material runs dry. Data comes from engine result.materialCheck. */
  function renderMaterialCheck() {
    const r = state.result, host = $("#materialCheckScroll"); if (!host) return;
    U.clear(host);
    const rows = r.materialCheck || [];
    const anyGap = rows.some((x) => x.gap > 0);
    const badge = $("#materialCheckBadge");
    if (badge) { badge.textContent = anyGap ? "Shortage" : "Covered"; badge.className = "badge " + (anyGap ? "badge--warn" : "badge--ok"); }
    const hint = $("#materialCheckHint");
    if (hint) hint.textContent = r.materialHaltDate
      ? "At this pace, work stalls for material around " + U.fmtDate(r.materialHaltDate) + "."
      : "Every material this plan works this period is covered by on-site stock + in-transit.";
    if (!rows.length) { host.appendChild(el("div", { class: "emptystate", html: "<p>No materials in scope for this plan.</p>" })); return; }

    const cols = ["Priority", "Material", "Required", "In stock", "In transit", "Gap / shortage", "Work halts on"];
    const NUM = { "Required": 1, "In stock": 1, "In transit": 1, "Gap / shortage": 1 };
    const table = el("table", { class: "data" });
    const thead = el("thead"), htr = el("tr");
    cols.forEach((c) => htr.appendChild(el("th", { class: NUM[c] ? "num" : "", text: c })));
    thead.appendChild(htr); table.appendChild(thead);
    const tb = el("tbody");
    rows.forEach((x) => {
      const tr = el("tr");
      tr.appendChild(el("td", { text: x.priority || "—" }));
      tr.appendChild(el("td", { text: x.profile || x.code }));
      tr.appendChild(el("td", { class: "num", text: U.fmtInt(x.required) }));
      tr.appendChild(el("td", { class: "num", text: U.fmtInt(x.inStock) }));
      tr.appendChild(el("td", { class: "num", text: U.fmtInt(x.inTransit) }));
      tr.appendChild(el("td", { class: "num" + (x.gap > 0 ? " cell-bad" : ""), text: x.gap > 0 ? U.fmtInt(x.gap) : "—" }));
      tr.appendChild(el("td", { text: x.haltDate ? U.fmtDate(x.haltDate) : "—" }));
      tb.appendChild(tr);
    });
    table.appendChild(tb); host.appendChild(table);
  }

  /* Recent progress — a compact bar chart of sheet piles installed on each of the
     last 7 recorded work days (from progress history's installedByDate). Rendered
     at true pixel size (fixed height, no upscaling) and re-drawn on width change. */
  function renderProgressChart() {
    const host = $("#progressChart"); if (!host) return;
    drawProgressChart();
    if (!host._ro && window.ResizeObserver) {
      host._ro = new ResizeObserver(() => { clearTimeout(host._rt); host._rt = setTimeout(drawProgressChart, 60); });
      host._ro.observe(host);
    }
  }
  // Redraw the chart while pinning the page scroll position. Swapping the chart's
  // DOM (and toggling the paging buttons' disabled state) can make the browser
  // shift the viewport; capturing and restoring scrollY keeps the view steady.
  function redrawProgressKeepScroll() {
    const x = window.scrollX, y = window.scrollY;
    drawProgressChart();
    window.scrollTo(x, y);
    requestAnimationFrame(() => { if (Math.abs(window.scrollY - y) > 1 || Math.abs(window.scrollX - x) > 1) window.scrollTo(x, y); });
  }
  // Draw the recent-progress bar chart (piles/day) at true pixel size.
  function drawProgressChart() {
    const host = $("#progressChart"); if (!host) return;
    const sub = $("#progressSub");
    const pr = state.store && state.store.progress;
    const map = (pr && pr.installedByDate) || {};
    const parseISO = (iso) => { const p = iso.split("-"); return new Date(+p[0], (+p[1]) - 1, +p[2]); };
    const WIN = 7;                          // periods shown at once (7 weeks or 7 months)
    const isMonth = progressMode === "month";

    // Aggregate daily installs into week (Monday-to-next-Monday excluding next Monday)
    // or month buckets; keep only non-empty periods, sorted oldest → newest.
    const buckets = {};
    Object.keys(map).forEach((iso) => {
      const v = map[iso] || 0; if (v <= 0) return;
      const d = parseISO(iso);
      let key, rep;
      if (isMonth) { key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); rep = new Date(d.getFullYear(), d.getMonth(), 1); }
      else {
        const m = new Date(d);
        const dayOfWeek = m.getDay();
        const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        m.setDate(m.getDate() - daysToMonday);
        key = U.fmtISO(m);
        rep = m;
      }
      (buckets[key] || (buckets[key] = { sum: 0, date: rep })).sum += v;
    });
    const keys = Object.keys(buckets).sort();
    U.clear(host);
    if (!keys.length) {
      host.appendChild(el("div", { class: "emptystate", html: "<p>No dated installs in the progress history.</p>" }));
      if (sub) sub.textContent = "";
      return;
    }
    // 3-period trailing moving average over the FULL series (so the earliest shown
    // point is still accurate), then sliced to the visible window.
    const seriesAll = keys.map((k) => buckets[k].sum);
    const maAll = seriesAll.map((_, i) => { let acc = 0, c = 0; for (let j = Math.max(0, i - 2); j <= i; j++) { acc += seriesAll[j]; c++; } return acc / c; });

    // Page a WIN-sized window with the ‹ › buttons.
    const maxOffset = Math.max(0, keys.length - WIN);
    if (progressOffset > maxOffset) progressOffset = maxOffset;
    if (progressOffset < 0) progressOffset = 0;
    const endIdx = keys.length - progressOffset, startIdx = Math.max(0, endIdx - WIN);
    const wKeys = keys.slice(startIdx, endIdx);
    const vals = wKeys.map((k) => buckets[k].sum);
    const ma = maAll.slice(startIdx, endIdx);
    const dates = wKeys.map((k) => buckets[k].date);
    { const pl = $("#progressPrev"), pn = $("#progressNext");
      if (pl) pl.disabled = progressOffset >= maxOffset;   // no older periods
      if (pn) pn.disabled = progressOffset <= 0; }          // already at the latest

    const total = vals.reduce((a, b) => a + b, 0), dataMax = Math.max(1, Math.max.apply(null, vals));
    if (sub) sub.textContent = U.fmtInt(total) + " piles across " + wKeys.length + " " +
      (isMonth ? "month" : "week") + (wKeys.length === 1 ? "" : "s") + " shown · x-axis shows each " +
      (isMonth ? "month" : "week’s starting date");
    { const tl = $("#progressTrendLabel"); if (tl) tl.textContent = "Moving avg (3-" + (isMonth ? "month" : "week") + ")"; }

    // "nice" y-axis: round tick step so labels read 0/4/8/12… not odd values.
    const rough = dataMax / 4, pw = Math.pow(10, Math.floor(Math.log10(rough))), rf = rough / pw;
    const nf = rf <= 1 ? 1 : rf <= 2 ? 2 : rf <= 2.5 ? 2.5 : rf <= 5 ? 5 : 10, step = nf * pw;
    const yMax = Math.max(step, Math.ceil(dataMax / step) * step);
    const ticks = []; for (let t = 0; t <= yMax + 1e-9; t += step) ticks.push(Math.round(t));

    // fixed height, natural pixel width (NO viewBox upscaling)
    const W = Math.max(360, Math.floor(host.clientWidth || 760)), H = 220;
    const padL = 38, padR = 20, padT = 20, padB = 34;
    const plotW = W - padL - padR, plotH = H - padT - padB, n = wKeys.length, slot = plotW / n, barW = Math.min(42, slot * 0.42);
    const yOf = (v) => padT + plotH - (v / yMax) * plotH;
    const cxOf = (i) => padL + slot * i + slot / 2;
    const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const xLabel = (d) => isMonth ? (MON[d.getMonth()] + " " + String(d.getFullYear()).slice(2)) : U.fmtShort(d);

    let s = '<svg class="daychart__svg" width="' + W + '" height="' + H + '" font-family="inherit">';
    s += '<defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c3a86"/><stop offset="1" stop-color="#0b1f66"/></linearGradient>' +
      // Gold glow for the trend line (#DDB871).
      '<filter id="trendGlow" x="-10%" y="-80%" width="120%" height="260%"><feDropShadow dx="0" dy="0" stdDeviation="3.5" flood-color="#DDB871" flood-opacity="0.9"/></filter></defs>';
    // gridlines + y ticks
    ticks.forEach((tv) => {
      const gy = yOf(tv);
      s += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '" stroke="#eaeef7"/>';
      s += '<text x="' + (padL - 8) + '" y="' + (gy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#9aa3bd">' + U.fmtInt(tv) + '</text>';
    });
    // bars + x-axis labels (each period's starting date)
    const endDateOf = (d) => isMonth ? new Date(d.getFullYear(), d.getMonth() + 1, 0) : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 6);
    wKeys.forEach((k, i) => {
      const v = vals[i], cxp = cxOf(i), bx = cxp - barW / 2, by = yOf(v), bh = Math.max(0, padT + plotH - by), d = dates[i];
      const dEnd = endDateOf(d);
      const tip = xLabel(d) + " – " + xLabel(dEnd) + " — <strong>" + U.fmtInt(v) + "</strong> pile" + (v === 1 ? "" : "s");
      s += '<g class="daybar" data-tip="' + U.esc(tip) + '">';
      s += '<rect class="daybar__hit" x="' + (cxp - slot / 2).toFixed(1) + '" y="' + padT + '" width="' + slot.toFixed(1) + '" height="' + plotH + '" fill="transparent"/>';
      s += '<rect class="daybar__bar" x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="3" fill="url(#barGrad)"/>';
      s += '<text x="' + cxp.toFixed(1) + '" y="' + (H - 13) + '" text-anchor="middle" font-size="10.5" font-weight="600" fill="#5b6690">' + U.esc(xLabel(d)) + '</text>';
      s += '</g>';
    });
    // trend line = 3-period moving average, gold + glow, with a marker per period
    const pts = ma.map((mv, i) => cxOf(i).toFixed(1) + "," + yOf(mv).toFixed(1));
    s += '<polyline points="' + pts.join(" ") + '" fill="none" stroke="#DDB871" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#trendGlow)"/>';
    ma.forEach((mv, i) => { s += '<circle cx="' + cxOf(i).toFixed(1) + '" cy="' + yOf(mv).toFixed(1) + '" r="4.5" fill="#fff" stroke="#DDB871" stroke-width="2.5"/>'; });
    s += '</svg>';
    host.innerHTML = s;
    // One-shot slide/fade transition on paging or mode-switch (the SVG is a fresh
    // node each render, so the CSS animation replays cleanly every time).
    const svg = host.firstElementChild;
    if (svg && progressAnim) {
      svg.classList.add(progressAnim === "older" ? "daychart__svg--in-left"
        : progressAnim === "newer" ? "daychart__svg--in-right" : "daychart__svg--fade");
    }
    progressAnim = null;
    host.onmousemove = (ev) => { const g = ev.target.closest ? ev.target.closest(".daybar") : null; const t = g && g.getAttribute("data-tip"); if (t) showTip(ev.clientX, ev.clientY, t); else hideTip(); };
    host.onmouseleave = hideTip;
  }

  // Switch the results view (Material/Table/Map) and lazy-render the Map.
  function setView(v) {
    if (v === "gantt") v = "table";   // Gantt removed — never select it
    state.view = v;
    $("#materialView").hidden = v !== "material";
    $("#tableView").hidden = v !== "table";
    $("#mapView").hidden = v !== "map";
    U.$$("#viewToggle .view-toggle__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.view === v));
    // Render the Map only once visible, so it sizes to real container dimensions.
    if (state.result && v === "map") requestAnimationFrame(() => renderMap());
  }

  /* ============================ TABLE VIEW (§6.1) ============================ */
  // Per-chainage display prep: turn each day's raw float install into a whole-pile
  // "Piles (day)" value. Rounding the CUMULATIVE total each day (old approach) could
  // show non-monotonic values like 26, 27, 26 even under flat capacity, because
  // independent day-to-day rounding error was carried through the running total.
  // The engine now installs whole piles per day (a machine's daily budget is the
  // ceil of its capacity, flowed across chainages in whole piles — §5.4/§5.5), so
  // the table just shows those figures directly. Per (machine, chainage, day):
  //   dispInstall = that day's whole-pile install on the chainage — this is the
  //     machine's per-day productivity when the chainage's remaining scope is larger,
  //     or exactly the remaining piles when it's smaller (the engine already caps it
  //     at min(budget, remaining, stock), and any leftover budget flowed to the next
  //     chainage as its own row);
  //   dispCum = the chainage's running total (prior + installed so far), used only to
  //     read off "remaining scope".
  function computeDisplay(schedule) {
    schedule.forEach((e) => {
      e.dispInstall = Math.round(e.install);
      e.dispCum = Math.round(e.cum);
    });
  }

  // Render the day-by-day schedule table for the current group-by.
  function renderTable() {
    const r = state.result;
    computeDisplay(r.schedule);
    const groupBy = $("#tableGroup").value;

    const cols = ["Date", "Day #", "Machine", "Chainage", "Material", "Item Code", "Piles (day)", "Cum.", "MTO", "% Comp.", "Status", "Material left"];
    const NUM_COLS = { "Piles (day)": 1, "Cum.": 1, "MTO": 1, "% Comp.": 1, "Material left": 1 };
    const table = el("table", { class: "data" });
    const thead = el("thead");
    const htr = el("tr");
    cols.forEach((c) => htr.appendChild(el("th", { class: NUM_COLS[c] ? "num" : "", text: c })));
    thead.appendChild(htr); table.appendChild(thead);
    const tb = el("tbody");

    // build row list
    let rows = r.schedule.map((e) => ({ kind: "work", e }));
    const nonwork = r.calendar.filter((c) => !c.isWorking).map((c) => ({ kind: "nonwork", c }));
    if (groupBy === "date") rows = rows.concat(nonwork);

    const keyFn = { date: (x) => x.kind === "work" ? U.fmtISO(x.e.date) : U.fmtISO(x.c.date),
                    chainage: (x) => x.e.chId, machine: (x) => "M" + x.e.machine }[groupBy];
    const sortVal = {
      date: (x) => (x.kind === "work" ? x.e.date.getTime() : x.c.date.getTime()) * 100 + (x.kind === "work" ? x.e.machine : 0),
      chainage: (x) => U.chainageSortKey(x.e.chId) * 1e7 + x.e.date.getTime() / 1e6,
      machine: (x) => x.e.machine * 1e13 + x.e.date.getTime()
    }[groupBy];
    rows.sort((a, b) => sortVal(a) - sortVal(b));

    let lastKey = null;
    rows.forEach((x) => {
      const k = keyFn(x);
      if (k !== lastKey) { tb.appendChild(groupHeader(groupBy, x, cols.length)); lastKey = k; }
      if (x.kind === "nonwork") { tb.appendChild(nonworkRow(x.c, cols.length)); return; }
      tb.appendChild(workRow(x.e));
    });
    table.appendChild(tb);
    const scroll = $("#tableScroll"); U.clear(scroll); scroll.appendChild(table);

    $("#tableSummary").textContent = r.schedule.length + " entries · " + r.worked.length + " chainages · " + U.fmtInt(Math.round(r.totalInstalled)) + " piles installed in window";
  }

  // Build a group-divider row (Date/Chainage/Machine) for the table.
  function groupHeader(groupBy, x, span) {
    let label;
    if (groupBy === "date") {
      const d = x.kind === "work" ? x.e.date : x.c.date;
      const dn = x.kind === "work" ? x.e.dayNum : x.c.dayNum;
      label = U.fmtFriendly(d) + "  ·  Day " + dn;
    } else if (groupBy === "chainage") {
      label = "Chainage " + x.e.chId + "  ·  " + x.e.profile + "  ·  Machine " + x.e.machine;
    } else { label = "Machine " + x.e.machine; }
    const tr = el("tr", { class: "row-group" });
    tr.appendChild(el("td", { colspan: span, text: label }));
    return tr;
  }

  // Build one work row (a machine's install on a chainage for a day).
  function workRow(e) {
    const pct = e.mto > 0 ? (e.cum / e.mto) * 100 : 0;
    const done = e.cum >= e.mto - 1e-6;
    const tr = el("tr", { class: done ? "row-completed" : "" });
    const status = done ? el("span", { class: "pill pill--done", text: "Completed" })
      : e.waiting ? el("span", { class: "pill pill--wait", text: "Awaiting material" })
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
      el("td", {}, [status]),
      el("td", { class: "num", text: U.fmtInt(Math.round(e.stockEnd)) })
    ].forEach((td) => tr.appendChild(td));
    return tr;
  }
  // Build a non-working-day row (weekly off / hindrance).
  function nonworkRow(c, span) {
    const tr = el("tr", { class: "row-nonwork" });
    tr.appendChild(el("td", { colspan: span, text: U.fmtShort(c.date) + " (Day " + c.dayNum + ") — " + c.nonWorkReason + " · no installation" }));
    return tr;
  }

  /* ============================ MATERIAL VIEW (day-by-day availability) ======
     Pivot: rows = profiles (item codes), columns = planned days, each day split
     into Available / Inbound / Consumed sub-columns. Data comes straight from
     r.materialPivot (built in engine.js so the 1-day arrival buffer and calendar
     stay consistent with the plan). Available = net Accepted-at-Site stock carried
     into the day; Consumed = piles the plan installs that day; the balance rolls on. */
  function renderMaterial() {
    const r = state.result;
    const host = $("#materialScroll"); U.clear(host);
    const mp = r.materialPivot;
    // Show only materials the plan actually needs within the selected window — the same
    // set as the material-wise check (materials with demand this period). Materials whose
    // work falls entirely outside the plan timeline are hidden. Values are unchanged.
    const allowed = new Set((r.materialCheck || []).map((x) => x.code));
    const rows = (mp && mp.rows) ? (allowed.size ? mp.rows.filter((row) => allowed.has(row.code)) : mp.rows) : [];
    if (!mp || !rows.length) {
      host.appendChild(el("div", { class: "emptystate", html: "<p>No materials required within this plan window.</p>" }));
      $("#materialSummary").textContent = "";
      return;
    }
    const days = mp.days;
    const table = el("table", { class: "data material-pivot" });

    // Two header rows: day (spans 3) over Avail / In / Cons.
    const thead = el("thead");
    const hDay = el("tr");
    hDay.appendChild(el("th", { class: "mp-profile mp-corner", rowspan: 2, html: "Material <span class='mp-dow'>Item Code</span>" }));
    days.forEach((d) => {
      const off = !d.isWorking;
      hDay.appendChild(el("th", {
        class: "num mp-daygroup" + (off ? " mp-off" : ""),
        colspan: 3,
        title: off && d.nonWorkReason ? d.nonWorkReason : "",
        html: U.fmtShort(d.date) + "<span class='mp-dow'>" + U.weekdayShort(d.date) + (off ? " · off" : "") + "</span>"
      }));
    });
    thead.appendChild(hDay);
    const hSub = el("tr");
    days.forEach((d) => {
      const off = !d.isWorking;
      hSub.appendChild(el("th", { class: "num mp-sub mp-groupstart" + (off ? " mp-off" : ""), text: "Avail" }));
      hSub.appendChild(el("th", { class: "num mp-sub" + (off ? " mp-off" : ""), text: "In" }));
      hSub.appendChild(el("th", { class: "num mp-sub mp-cons" + (off ? " mp-off" : ""), text: "Used" }));
    });
    thead.appendChild(hSub);
    table.appendChild(thead);

    // Body: one row per material required this window.
    const tb = el("tbody");
    rows.forEach((row) => {
      const tr = el("tr");
      tr.appendChild(el("td", { class: "mp-profile", title: "Item code " + row.code }, [
        el("div", { text: row.profile }),
        el("span", { class: "mp-code", text: row.code || "—" })
      ]));
      row.cells.forEach((c, i) => {
        const off = !days[i].isWorking;
        tr.appendChild(el("td", { class: "num mp-groupstart" + (off ? " mp-off" : ""), text: U.fmtInt(Math.round(c.available)) }));
        tr.appendChild(el("td", { class: "num mp-in" + (off ? " mp-off" : ""), text: c.inbound > 0 ? "+" + U.fmtInt(Math.round(c.inbound)) : "—" }));
        tr.appendChild(el("td", { class: "num mp-cons" + (off ? " mp-off" : ""), text: c.consumed > 0 ? "−" + U.fmtInt(Math.round(c.consumed)) : "—" }));
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    host.appendChild(table);

    const totalInbound = rows.reduce((s, row) => s + row.cells.reduce((a, c) => a + c.inbound, 0), 0);
    $("#materialSummary").textContent =
      rows.length + " material(s) · " + days.length + " days · " +
      (totalInbound > 0 ? U.fmtInt(Math.round(totalInbound)) + " piles inbound within window" : "no inbound within window");
  }

  /* ============================ GANTT VIEW (§6.2) ============================ */
  function renderGantt() {
    const r = state.result;
    const host = $("#ganttScroll");
    U.clear(host);
    if (!r.worked.length) { host.appendChild(el("div", { class: "emptystate", html: "<p>No chainages were scheduled (no workable material, or 0 machines).</p>" })); renderLegend(); return; }

    // Size columns to the available width so the chart fills the panel (and reflows
    // when inputs are hidden/shown); falls back to a sensible width if not yet visible.
    const labelW = 250, rowH = 28, headH = 46;
    const avail = Math.max(560, (host.clientWidth || 900));
    const colW = Math.max(34, Math.min(72, Math.floor((avail - labelW) / r.totalDays)));
    const days = r.calendar;
    const W = labelW + colW * r.totalDays, H = headH + rowH * r.worked.length + 8;
    const arrivalsByISO = {};
    r.windowArrivals.forEach((a) => { (arrivalsByISO[U.fmtISO(a.date)] || (arrivalsByISO[U.fmtISO(a.date)] = [])).push(a); });

    const colorMode = state.ganttColor;
    const colorOf = (w) => colorMode === "machine" ? MACHINE_COLORS[(w.machine - 1) % MACHINE_COLORS.length] : U.colorFor(w.profile, 52, 42);

    let s = '<svg width="' + W + '" height="' + H + '" font-family="inherit" font-size="11">';
    // day columns background
    days.forEach((d, i) => {
      const x = labelW + i * colW;
      if (!d.isWorking) {
        const fill = d.hindrance ? "#fbf2dd" : "#eef2f7";
        s += '<rect x="' + x + '" y="' + headH + '" width="' + colW + '" height="' + (rowH * r.worked.length) + '" fill="' + fill + '"/>';
      }
      // header cell
      s += '<text x="' + (x + colW / 2) + '" y="16" text-anchor="middle" fill="#8a96a5">' + U.weekdayShort(d.date) + '</text>';
      s += '<text x="' + (x + colW / 2) + '" y="32" text-anchor="middle" fill="#5b6877" font-variant-numeric="tabular-nums">' + d.date.getDate() + '</text>';
      s += '<line x1="' + x + '" y1="' + headH + '" x2="' + x + '" y2="' + (H - 8) + '" stroke="#eef2f7"/>';
    });
    // header separator + label header
    s += '<line x1="0" y1="' + headH + '" x2="' + W + '" y2="' + headH + '" stroke="#c3ccda"/>';
    s += '<line x1="' + labelW + '" y1="0" x2="' + labelW + '" y2="' + H + '" stroke="#c3ccda"/>';
    s += '<text x="10" y="28" fill="#5b6877" font-weight="600">Chainage · Profile</text>';

    // bars
    r.worked.forEach((w, ri) => {
      const y = headH + ri * rowH;
      const startIdx = U.clamp(U.diffDays(r.planStart, w.startDate), 0, r.totalDays - 1);
      const endIdx = U.clamp(U.diffDays(r.planStart, w.lastDate), startIdx, r.totalDays - 1);
      const bx = labelW + startIdx * colW + 2;
      const bw = (endIdx - startIdx + 1) * colW - 4;
      const pct = w.mto > 0 ? Math.min(1, w.done / w.mto) : 0;
      const col = colorOf(w);
      // Label = chainage id (line 1) + full profile as a subtitle (line 2), so long
      // profile names are never clipped by / painted over by the bars. Truncate
      // defensively to the label column width as a final safety.
      const prof = w.profile || "";
      const maxCh = Math.max(6, Math.floor((labelW - 20) / 5.6));
      const profTxt = prof.length > maxCh ? prof.slice(0, maxCh - 1) + "…" : prof;
      s += '<rect x="2" y="' + (y + 3) + '" width="' + (labelW - 8) + '" height="' + (rowH - 6) + '" fill="' + (ri % 2 ? "#f6f8fb" : "#ffffff") + '"/>';
      s += '<text x="10" y="' + (y + 12) + '" fill="#1c2733" font-weight="600">' + U.esc(w.id) + '</text>';
      s += '<text x="10" y="' + (y + 23) + '" fill="#6b7690" font-size="9.5">' + U.esc(profTxt) + '<title>' + U.esc(prof) + '</title></text>';
      // bar background (full span) + progress fill
      s += '<rect data-tip="' + tipFor(w) + '" x="' + bx + '" y="' + (y + 5) + '" width="' + Math.max(bw, 3) + '" height="' + (rowH - 10) + '" rx="3" fill="' + col + '" opacity="0.28"/>';
      s += '<rect data-tip="' + tipFor(w) + '" x="' + bx + '" y="' + (y + 5) + '" width="' + Math.max(bw * pct, pct > 0 ? 2 : 0) + '" height="' + (rowH - 10) + '" rx="3" fill="' + col + '"/>';
      s += '<text x="' + (bx + Math.max(bw, 3) + 6) + '" y="' + (y + rowH / 2 + 4) + '" fill="#5b6877" font-size="10" font-variant-numeric="tabular-nums">' + U.fmtNum(pct * 100, 1) + '% · M' + w.machine + (w.completed ? " ✓" : "") + '</text>';
    });

    // inbound arrival markers + hindrance day ticks (drawn over columns)
    days.forEach((d, i) => {
      const x = labelW + i * colW;
      const iso = U.fmtISO(d.date);
      if (arrivalsByISO[iso]) {
        const qty = arrivalsByISO[iso].reduce((a, b) => a + b.qty, 0);
        const tip = "Inbound " + U.fmtInt(qty) + " units — " + arrivalsByISO[iso].map((a) => a.profile).join(", ") + " (" + U.fmtFriendly(d.date) + ")";
        s += '<line x1="' + (x + colW / 2) + '" y1="' + headH + '" x2="' + (x + colW / 2) + '" y2="' + (H - 8) + '" stroke="#2f5fb0" stroke-dasharray="3 3"/>';
        s += '<polygon data-tip="' + U.esc(tip) + '" points="' + (x + colW / 2 - 5) + ',' + (headH + 1) + ' ' + (x + colW / 2 + 5) + ',' + (headH + 1) + ' ' + (x + colW / 2) + ',' + (headH + 9) + '" fill="#2f5fb0"/>';
      }
    });

    s += "</svg>";
    host.innerHTML = s;
    attachGanttTips(host);
    renderLegend();
  }
  // Tooltip HTML for a worked chainage bar in the Gantt.
  function tipFor(w) {
    return U.esc(w.id + " · " + w.profile + "\nMachine " + w.machine + "\n" + Math.round(w.done) + " / " + U.fmtInt(w.mto) + " piles (" + U.fmtNum((w.done / w.mto) * 100, 1) + "%)\n" + U.fmtShort(w.startDate) + " → " + U.fmtShort(w.lastDate) + (w.completed ? " (completed)" : ""));
  }
  // Render the Gantt colour legend (by profile or by machine).
  function renderLegend() {
    const r = state.result, host = $("#ganttLegend"); U.clear(host);
    const items = [];
    if (state.ganttColor === "machine") {
      const ms = Array.from(new Set(r.worked.map((w) => w.machine))).sort((a, b) => a - b);
      ms.forEach((m) => items.push({ c: MACHINE_COLORS[(m - 1) % MACHINE_COLORS.length], l: "Machine " + m }));
    } else {
      Array.from(new Set(r.worked.map((w) => w.profile))).forEach((p) => items.push({ c: U.colorFor(p, 52, 42), l: p }));
    }
    items.forEach((it) => host.appendChild(el("span", { class: "legend-item" }, [el("span", { class: "legend-swatch", style: "background:" + it.c }), document.createTextNode(it.l)])));
    host.appendChild(el("span", { class: "legend-item" }, [el("span", { class: "legend-swatch", style: "background:#2f5fb0" }), document.createTextNode("Inbound arrival")]));
    if (r.lostDays.length) host.appendChild(el("span", { class: "legend-item" }, [el("span", { class: "legend-swatch", style: "background:#fbf2dd;border:1px solid #eccb86" }), document.createTextNode("Hindrance day")]));
  }
  let ganttTip = null;
  // Wire hover tooltips onto the rendered Gantt bars.
  function attachGanttTips(host) {
    if (!ganttTip) { ganttTip = el("div", { class: "gantt-tip" }); document.body.appendChild(ganttTip); }
    host.addEventListener("mousemove", (ev) => {
      const t = ev.target.getAttribute && ev.target.getAttribute("data-tip");
      if (t) { ganttTip.style.display = "block"; ganttTip.style.left = (ev.clientX + 14) + "px"; ganttTip.style.top = (ev.clientY + 14) + "px"; ganttTip.innerHTML = t.replace(/\n/g, "<br>"); }
      else ganttTip.style.display = "none";
    });
    host.addEventListener("mouseleave", () => { if (ganttTip) ganttTip.style.display = "none"; });
  }

  /* ============================ MAP VIEW (Change 8) ============================ */
  const MAP_STATUS = {
    complete:   { c: "#2bb673", label: "Completed (from progress)" },
    partial:    { c: "#a78bfa", label: "Partially done (from progress)" },
    inprogress: { c: "#19b8c9", label: "Scheduled this plan" },
    planned:    { c: "#e3a82b", label: "In scope (not scheduled)" },
    blocked:    { c: "#e0563c", label: "Blocked (no material)" }
  };
  const MAP_CONTEXT = "#8593a3";   // boundary / other-priority lines (visible on dark map)
  // Multi-select filter: a chainage shows when no filter is set, or when ANY of its
  // categories is among the selected ones (a chainage can be both "partial" and
  // "scheduled this plan" at once — accepts a single category string or a Set).
  function mapVisible(catOrSet) {
    if (!state.mapFilters.size) return true;
    if (catOrSet instanceof Set) { for (const c of catOrSet) if (state.mapFilters.has(c)) return true; return false; }
    return state.mapFilters.has(catOrSet);
  }
  let mapTipEl = null, mapGL = null, _ptTex = null;

  // Tooltip HTML for a chainage on the map.
  function mapTipText(f, st, info) {
    const lbl = (MAP_STATUS[st] || {}).label || st || "Other priority";
    let t = f.id + " · " + f.profile + "\nStatus: " + lbl + "\nMTO: " + U.fmtInt(f.mto) + " piles";
    if (info) t += "\nMachine " + info.machine + " · " + U.fmtShort(info.startDate) + "–" + U.fmtShort(info.lastDate) +
      "\n" + Math.round(info.done) + " / " + U.fmtInt(info.mto) + " (" + U.fmtNum(info.done / info.mto * 100, 1) + "%)";
    return U.esc(t);
  }
  // Position and show the floating tooltip at a screen point.
  function showTip(clientX, clientY, html) {
    if (!mapTipEl) { mapTipEl = el("div", { class: "map-tip" }); document.body.appendChild(mapTipEl); }
    mapTipEl.style.display = "block"; mapTipEl.style.left = (clientX + 14) + "px"; mapTipEl.style.top = (clientY + 14) + "px";
    mapTipEl.innerHTML = html.replace(/\n/g, "<br>");
  }
  // Hide the floating tooltip.
  function hideTip() { if (mapTipEl) mapTipEl.style.display = "none"; }
  // Feature-detect WebGL so the map can fall back to SVG when unavailable.
  function webglOK() {
    try { const c = document.createElement("canvas"); return !!(window.WebGLRenderingContext && (c.getContext("webgl") || c.getContext("experimental-webgl"))); }
    catch (e) { return false; }
  }

  // Shared model: status/info per chainage + projection bounds.
  //
  // A chainage can genuinely belong to MORE THAN ONE category at once — e.g. it had
  // partial progress before this plan AND this plan schedules it this window. statusById
  // still holds exactly one PRIMARY category (for the single line color a boundary segment
  // can render), but catsById holds the FULL set so filtering/counting doesn't silently
  // drop a chainage's other category. Primary-status priority (last wins, most specific
  // first): base scope → blocked → partial → complete → scheduled-this-plan.
  function computeMapData() {
    const r = state.result;
    const feats = state.parsed.chainage ? state.parsed.chainage.features : [];
    const geoFeats = feats.filter((f) => f.seg);
    const statusById = {}, catsById = {}, infoById = {}, inPriority = {};
    function addCat(id, cat) { (catsById[id] || (catsById[id] = new Set())).add(cat); }
    if (r) {
      r.candidates.forEach((c) => { statusById[c.id] = "planned"; inPriority[c.id] = true; addCat(c.id, "planned"); });
      r.blocked.forEach((b) => { statusById[b.id] = "blocked"; addCat(b.id, "blocked"); });
      (r.partial || []).forEach((c) => { statusById[c.id] = "partial"; addCat(c.id, "partial"); });      // started per progress, not finished
      (r.completed || []).forEach((c) => { statusById[c.id] = "complete"; addCat(c.id, "complete"); });   // fully done per progress history
      r.worked.forEach((w) => { statusById[w.id] = "inprogress"; infoById[w.id] = w; addCat(w.id, "inprogress"); });
    }
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    geoFeats.forEach((f) => f.seg.forEach((p) => {
      if (p[0] < minLng) minLng = p[0]; if (p[0] > maxLng) maxLng = p[0];
      if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1];
    }));
    const lat0 = (minLat + maxLat) / 2, kx = Math.cos(lat0 * Math.PI / 180);
    return {
      r, geoFeats, statusById, catsById, infoById, inPriority, minLng, maxLng, minLat, maxLat, kx,
      catOf: (f) => inPriority[f.id] ? (statusById[f.id] || "planned") : "context",
      // All categories a chainage belongs to (for filter-visibility + legend counts);
      // context (other-priority) chainages have no entry, so fall back to ["context"].
      catsOf: (f) => catsById[f.id] || new Set(["context"])
    };
  }

  // Render the map: WebGL (three.js) if available, else the SVG fallback.
  function renderMap() {
    const host = $("#mapScroll");
    if (mapGL) { try { mapGL.dispose(); } catch (e) {} mapGL = null; }
    const data = computeMapData();
    if (!data.r || !data.geoFeats.length) { U.clear(host); host.appendChild(el("div", { class: "emptystate", html: "<p>No geo-coordinates available to map.</p>" })); return; }
    let usedGL = false;
    if (window.THREE && webglOK()) {
      try { renderMapGL(data); usedGL = true; }
      catch (e) { console.warn("WebGL map unavailable, using SVG fallback:", e); if (mapGL) { try { mapGL.dispose(); } catch (_) {} mapGL = null; } }
    }
    if (!usedGL) renderMapSVG(data);
    renderMapLegend(data);
    updateLegendActive();
  }

  /* ---- three.js renderer (primary): smooth wheel-zoom + drag-pan + picking ---- */
  function roundPointTexture() {
    if (_ptTex) return _ptTex;
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const x = c.getContext("2d"); x.beginPath(); x.arc(32, 32, 27, 0, Math.PI * 2); x.fillStyle = "#fff"; x.fill();
    _ptTex = new THREE.CanvasTexture(c); _ptTex.needsUpdate = true; return _ptTex;
  }
  // three.js WebGL map renderer (orthographic pan/zoom, marker picking, filtering).
  function renderMapGL(data) {
    const host = $("#mapScroll"); U.clear(host);
    const { geoFeats, infoById, minLng, maxLng, minLat, maxLat, kx, catOf, catsOf } = data;
    const PX = (lng) => (lng - minLng) * kx, PY = (lat) => (lat - minLat);   // y up = north
    const dataW = (maxLng - minLng) * kx || 1e-6, dataH = (maxLat - minLat) || 1e-6;
    const W = Math.max(320, host.clientWidth || 880);
    const Hh = Math.max(380, Math.round(window.innerHeight * 0.58));

    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x1b2735);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10); cam.position.z = 1;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, Hh);
    host.appendChild(renderer.domElement);
    const tex = roundPointTexture();
    const hex = (c) => parseInt(c.slice(1), 16);

    // Full site boundary = EVERY chainage segment, drawn once in grey and kept
    // always-visible so the outline shows no matter which legend filter is active.
    const boundaryPos = [];
    const segByCat = { inprogress: [], planned: [], complete: [], partial: [], blocked: [] };
    const mkByCat = { inprogress: [], planned: [], complete: [], partial: [], blocked: [] };
    const pickables = [];
    geoFeats.forEach((f) => {
      const a = f.seg[0], b = f.seg[1];
      boundaryPos.push(PX(a[0]), PY(a[1]), 0, PX(b[0]), PY(b[1]), 0);
      const cat = catOf(f);
      if (cat === "context") return;                  // other priorities live only in the boundary
      const cats = catsOf(f);
      const mx = f.mid ? PX(f.mid[0]) : null, my = f.mid ? PY(f.mid[1]) : null;
      // Draw this chainage's segment/marker into EVERY category bucket it belongs to
      // (not just its primary color category), so toggling any one of its filters
      // (e.g. "Partially done" OR "Scheduled this plan") independently shows/hides it.
      cats.forEach((c) => {
        if (!segByCat[c]) return;
        segByCat[c].push(PX(a[0]), PY(a[1]), 0, PX(b[0]), PY(b[1]), 0);
        if (f.mid) mkByCat[c].push(mx, my, 0);
      });
      if (f.mid) pickables.push({ id: f.id, wx: mx, wy: my, cat: cat, cats: cats, feature: f, info: infoById[f.id] });
    });
    const objs = {};
    const add = (cat, o) => { (objs[cat] = objs[cat] || []).push(o); scene.add(o); };
    {
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(boundaryPos, 3));
      const o = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: hex(MAP_CONTEXT) }));
      o.renderOrder = 0; add("boundary", o);
    }
    Object.keys(segByCat).forEach((cat) => {
      if (!segByCat[cat].length) return;
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(segByCat[cat], 3));
      const o = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: hex(MAP_STATUS[cat].c) }));
      o.renderOrder = 1; add(cat, o);
    });
    Object.keys(mkByCat).forEach((cat) => {
      if (!mkByCat[cat].length) return;
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(mkByCat[cat], 3));
      const o = new THREE.Points(g, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, map: tex, transparent: true, depthTest: false, color: hex(MAP_STATUS[cat].c) }));
      o.renderOrder = 3; add(cat, o);
    });
    // selection halo (white, so it reads on the dark map)
    const selGeom = new THREE.BufferGeometry(); selGeom.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const selObj = new THREE.Points(selGeom, new THREE.PointsMaterial({ size: 18, sizeAttenuation: false, map: tex, transparent: true, depthTest: false, color: 0xffffff }));
    selObj.renderOrder = 2; selObj.visible = false; scene.add(selObj);

    // camera fit + pan/zoom
    const cx = dataW / 2, cy = dataH / 2;
    let panX = cx, panY = cy, zoom = 1;
    // Apply the current pan/zoom to the orthographic camera and redraw.
    function applyCam() {
      const aspect = W / Hh, margin = 1.08;
      let halfW = dataW * margin / 2, halfH = dataH * margin / 2;
      if (halfW / halfH < aspect) halfW = halfH * aspect; else halfH = halfW / aspect;
      halfW /= zoom; halfH /= zoom;
      cam.left = panX - halfW; cam.right = panX + halfW; cam.top = panY + halfH; cam.bottom = panY - halfH;
      cam.updateProjectionMatrix();
    }
    const camW = () => cam.right - cam.left, camH = () => cam.top - cam.bottom;
    const draw = () => renderer.render(scene, cam);
    const s2w = (mx, my) => [cam.left + (mx / W) * camW(), cam.top - (my / Hh) * camH()];
    const w2s = (wx, wy) => [(wx - cam.left) / camW() * W, (cam.top - wy) / camH() * Hh];
    applyCam(); draw();

    // Hit-test the nearest chainage marker to a screen (mouse) point.
    function pick(mx, my) {
      let best = null, bd = 144;
      for (const p of pickables) {
        if (!mapVisible(p.cats)) continue;
        const sc = w2s(p.wx, p.wy), d = (sc[0] - mx) * (sc[0] - mx) + (sc[1] - my) * (sc[1] - my);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    }
    // Position the selection ring/marker on a picked chainage.
    function placeSel(p) {
      if (!p) { selObj.visible = false; return; }
      selObj.geometry.attributes.position.setXYZ(0, p.wx, p.wy, 0);
      selObj.geometry.attributes.position.needsUpdate = true;
      selObj.visible = mapVisible(p.cats);
    }

    const cv = renderer.domElement; cv.style.cursor = "grab"; cv.style.touchAction = "none";
    let dragging = false, lastX = 0, lastY = 0, moved = false;
    cv.addEventListener("wheel", (e) => {
      e.preventDefault(); e.stopPropagation();
      const rect = cv.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const b = s2w(mx, my);
      zoom = U.clamp(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 6000); applyCam();
      const a = s2w(mx, my); panX += b[0] - a[0]; panY += b[1] - a[1]; applyCam(); draw();
    }, { passive: false });
    cv.addEventListener("pointerdown", (e) => { dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY; try { cv.setPointerCapture(e.pointerId); } catch (_) {} cv.style.cursor = "grabbing"; });
    cv.addEventListener("pointermove", (e) => {
      const rect = cv.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (dragging) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        panX -= dx / W * camW(); panY += dy / Hh * camH(); applyCam(); draw(); hideTip(); return;
      }
      const hit = pick(mx, my);
      if (hit) { showTip(e.clientX, e.clientY, mapTipText(hit.feature, hit.cat, hit.info)); cv.style.cursor = "pointer"; }
      else { hideTip(); cv.style.cursor = "grab"; }
    });
    cv.addEventListener("pointerup", (e) => {
      dragging = false; cv.style.cursor = "grab"; try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) return;
      const rect = cv.getBoundingClientRect(), hit = pick(e.clientX - rect.left, e.clientY - rect.top);
      if (!hit) return;
      state.mapSelected = state.mapSelected === hit.id ? null : hit.id;
      placeSel(state.mapSelected ? hit : null);
      showMapInfo(state.mapSelected ? hit.feature : null, hit.cat, hit.info);
      draw();
    });
    cv.addEventListener("pointerleave", hideTip);

    // Re-colour markers to honour the active legend filter set.
    function applyFilter() {
      Object.keys(objs).forEach((cat) => {
        const vis = cat === "boundary" ? true : mapVisible(cat);   // boundary is always shown
        objs[cat].forEach((o) => (o.visible = vis));
      });
      if (state.mapSelected) { const ps = pickables.find((p) => p.id === state.mapSelected); selObj.visible = !!ps && mapVisible(ps.cats); }
      draw();
    }
    // Re-render the map only if the container width actually changed.
    function onResize() { if ((host.clientWidth || 880) !== W) renderMap(); }
    window.addEventListener("resize", onResize);

    // restore prior selection (e.g. after a filter change re-render)
    if (state.mapSelected) { const ps = pickables.find((p) => p.id === state.mapSelected); if (ps) placeSel(ps); }
    applyFilter();

    mapGL = {
      zoomBy: (fac) => { zoom = U.clamp(zoom * fac, 1, 6000); applyCam(); draw(); },
      fit: () => { zoom = 1; panX = cx; panY = cy; applyCam(); draw(); },
      applyFilter: applyFilter,
      dispose: () => {
        window.removeEventListener("resize", onResize);
        try { scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); } catch (_) {}
        try { renderer.dispose(); } catch (_) {}
        if (cv.parentNode) cv.parentNode.removeChild(cv);
      }
    };
  }

  /* ---- SVG renderer (fallback when WebGL is unavailable) ---- */
  function renderMapSVG(data) {
    const host = $("#mapScroll");
    const { geoFeats, statusById, catsById, infoById, inPriority, minLng, maxLng, minLat, maxLat, kx } = data;
    const dataW = (maxLng - minLng) * kx || 1e-6, dataH = (maxLat - minLat) || 1e-6;
    const pad = 26, targetW = 880;
    const S = ((targetW - 2 * pad) / dataW) * state.mapZoom;
    const W = dataW * S + 2 * pad, H = dataH * S + 2 * pad;
    const X = (lng) => pad + (lng - minLng) * kx * S, Y = (lat) => pad + (maxLat - lat) * S;
    let s = '<svg width="' + W.toFixed(0) + '" height="' + H.toFixed(0) + '" font-family="inherit" font-size="10">';
    // full site boundary (every chainage) — always drawn so the outline stays visible under any filter
    geoFeats.forEach((f) => {
      const a = f.seg[0], b = f.seg[1];
      s += '<line x1="' + X(a[0]).toFixed(1) + '" y1="' + Y(a[1]).toFixed(1) + '" x2="' + X(b[0]).toFixed(1) + '" y2="' + Y(b[1]).toFixed(1) + '" stroke="' + MAP_CONTEXT + '" stroke-width="1.5" stroke-linecap="round"/>';
    });
    geoFeats.forEach((f) => {
      // Visibility checks the chainage's FULL category set (a chainage can be both
      // "partial" and "scheduled this plan" at once); color still uses its primary status.
      if (!inPriority[f.id]) return; const st = statusById[f.id] || "planned"; if (!mapVisible(catsById[f.id] || st)) return;
      const col = (MAP_STATUS[st] || {}).c, a = f.seg[0], b = f.seg[1], sel = state.mapSelected === f.id ? " is-sel" : "";
      s += '<line class="map-seg' + sel + '" data-id="' + U.esc(f.id) + '" data-tip="' + mapTipText(f, st, infoById[f.id]) + '" x1="' + X(a[0]).toFixed(1) + '" y1="' + Y(a[1]).toFixed(1) + '" x2="' + X(b[0]).toFixed(1) + '" y2="' + Y(b[1]).toFixed(1) + '" stroke="' + col + '" stroke-width="' + (sel ? 6 : 3.5) + '" stroke-linecap="round"/>';
    });
    geoFeats.forEach((f) => {
      if (!inPriority[f.id] || !f.mid) return; const st = statusById[f.id] || "planned"; if (!mapVisible(catsById[f.id] || st)) return;
      const col = (MAP_STATUS[st] || {}).c;
      s += '<circle class="map-marker" data-id="' + U.esc(f.id) + '" data-tip="' + mapTipText(f, st, infoById[f.id]) + '" cx="' + X(f.mid[0]).toFixed(1) + '" cy="' + Y(f.mid[1]).toFixed(1) + '" r="' + (state.mapSelected === f.id ? 5.5 : 3.5) + '" fill="' + col + '" stroke="#fff" stroke-width="1"/>';
    });
    s += '<g transform="translate(' + (W - 32) + ',30)"><line x1="0" y1="16" x2="0" y2="-4" stroke="#aeb8c4" stroke-width="1.5"/><polygon points="-4,-1 4,-1 0,-9" fill="#aeb8c4"/><text x="0" y="28" text-anchor="middle" fill="#cdd5df">N</text></g>';
    s += mapScaleBar(S, pad, H);
    s += "</svg>";
    host.innerHTML = s;
    if (!mapTipEl) { mapTipEl = el("div", { class: "map-tip" }); document.body.appendChild(mapTipEl); }
    host.onmousemove = (ev) => { const t = ev.target.getAttribute && ev.target.getAttribute("data-tip"); if (t) showTip(ev.clientX, ev.clientY, t); else hideTip(); };
    host.onmouseleave = hideTip;
    host.onclick = (ev) => {
      const id = ev.target.getAttribute && ev.target.getAttribute("data-id"); if (!id) return;
      state.mapSelected = state.mapSelected === id ? null : id;
      const f = geoFeats.find((x) => x.id === id);
      showMapInfo(state.mapSelected ? f : null, statusById[id], infoById[id]);
      renderMap();
    };
  }

  // Build the map scale bar for the current pixel-per-metre scale.
  function mapScaleBar(S, pad, H) {
    const mPerPx = 111320 / S;
    const raw = mPerPx * 120, pow = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / pow;
    const nice = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
    const px = nice / mPerPx, y = H - 16, x0 = pad;
    const label = nice >= 1000 ? (nice / 1000) + " km" : Math.round(nice) + " m";
    return '<g stroke="#aeb8c4" stroke-width="2">' +
      '<line x1="' + x0 + '" y1="' + y + '" x2="' + (x0 + px) + '" y2="' + y + '"/>' +
      '<line x1="' + x0 + '" y1="' + (y - 4) + '" x2="' + x0 + '" y2="' + (y + 4) + '"/>' +
      '<line x1="' + (x0 + px) + '" y1="' + (y - 4) + '" x2="' + (x0 + px) + '" y2="' + (y + 4) + '"/></g>' +
      '<text x="' + (x0 + px / 2) + '" y="' + (y - 6) + '" text-anchor="middle" fill="#cdd5df" font-size="10">' + label + '</text>';
  }

  // Populate + open the "blocked chainages" popup: a table of each blocked
  // chainage against its profile (and item code / scope) so the planner sees
  // exactly what is excluded for want of material. `blocked` is r.blocked.
  function openBlockedModal(blocked) {
    const rows = (blocked || []).slice().sort((a, b) =>
      String(a.profile).localeCompare(String(b.profile)) || U.chainageSortKey(a.id) - U.chainageSortKey(b.id));
    $("#blockedCount").textContent = rows.length + " blocked";

    const table = el("table", { class: "data" });
    const thead = el("thead"), htr = el("tr");
    ["Chainage", "Material", "Item Code", "Piles (MTO)"].forEach((h) => htr.appendChild(el("th", { class: h === "Piles (MTO)" ? "num" : "", text: h })));
    thead.appendChild(htr); table.appendChild(thead);
    const tb = el("tbody");
    rows.forEach((f) => {
      const tr = el("tr");
      tr.appendChild(el("td", { text: f.id }));
      tr.appendChild(el("td", { text: f.profile }));
      tr.appendChild(el("td", { text: f.code || "—" }));
      tr.appendChild(el("td", { class: "num", text: U.fmtInt(f.mto) }));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    const scroll = $("#blockedModalScroll"); U.clear(scroll); scroll.appendChild(table);
    $("#blockedModal").hidden = false;
  }
  function closeBlockedModal() { const m = $("#blockedModal"); if (m) m.hidden = true; }

  // Update the map info bar for a hovered/pinned chainage.
  function showMapInfo(f, st, info) {
    const box = $("#mapInfo");
    if (!f) { box.textContent = "Drag to pan, scroll to zoom. Hover a chainage for details; click to pin. Click legend entries to filter (multiple allowed)."; return; }
    const lbl = (MAP_STATUS[st] || {}).label || "Other priority";
    let html = "<strong>" + U.esc(f.id) + "</strong> · " + U.esc(f.profile) + " · <strong>" + lbl + "</strong> · MTO " + U.fmtInt(f.mto);
    if (info) html += " · Machine " + info.machine + " · " + U.fmtFriendly(info.startDate) + " → " + U.fmtShort(info.lastDate) +
      " · " + Math.round(info.done) + "/" + U.fmtInt(info.mto) + " piles (" + U.fmtNum(info.done / info.mto * 100, 1) + "%)";
    else if (st === "complete") html += " · installed per progress history";
    box.innerHTML = html;
  }

  // Clickable legend = multi-select filter (toggle categories on/off; none = show all).
  function renderMapLegend(data) {
    const host = $("#mapLegend"); U.clear(host);
    // Count a chainage under EVERY category it belongs to, not just its primary
    // (display) one — otherwise a chainage that's e.g. both "partial" and "scheduled
    // this plan" only ever gets tallied once, and the other legend count undercounts.
    const counts = { inprogress: 0, planned: 0, complete: 0, partial: 0, blocked: 0, context: 0 };
    data.geoFeats.forEach((f) => {
      const cat = data.catOf(f);
      if (cat === "context") { counts.context++; return; }
      data.catsOf(f).forEach((c) => { if (counts[c] != null) counts[c]++; });
    });
    const items = [];
    ["inprogress", "partial", "complete", "planned", "blocked"].forEach((k) => { if (counts[k]) items.push({ cat: k, c: MAP_STATUS[k].c, label: MAP_STATUS[k].label, n: counts[k] }); });
    items.push({ cat: "context", c: MAP_CONTEXT, label: "Other priorities", n: counts.context });
    items.forEach((it) => {
      const node = el("span", { class: "legend-item", title: "Toggle: " + it.label, dataset: { cat: it.cat } },
        [el("span", { class: "legend-swatch", style: "background:" + it.c }), document.createTextNode(it.label + " (" + U.fmtInt(it.n) + ")")]);
      node.addEventListener("click", () => toggleMapFilter(it.cat));
      host.appendChild(node);
    });
  }
  // Re-apply the legend filter to whichever renderer is active.
  function reapplyMapFilter() { if (mapGL) mapGL.applyFilter(); else renderMap(); updateLegendActive(); }
  // Toggle a legend category in the map filter set and re-apply.
  function toggleMapFilter(cat) {
    if (state.mapFilters.has(cat)) state.mapFilters.delete(cat); else state.mapFilters.add(cat);
    reapplyMapFilter();
  }
  // Set the filter explicitly (e.g. the "view blocked on map" button) and show the map;
  // setView() re-renders the map, which reads state.mapFilters and marks the legend.
  function setMapFilters(cats) {
    state.mapFilters = new Set(cats || []);
    setView("map");
    // The map now lives inside the Plan card, so bring it into view after it renders.
    requestAnimationFrame(() => { const m = $("#mapView"); if (m) m.scrollIntoView({ behavior: "smooth", block: "start" }); });
  }
  // Sync the legend chips' active styling with the current filter.
  function updateLegendActive() {
    const any = state.mapFilters.size > 0;
    U.$$("#mapLegend .legend-item").forEach((it) => {
      const on = state.mapFilters.has(it.dataset.cat);
      it.classList.toggle("is-active", on);
      it.classList.toggle("is-dim", any && !on);
    });
  }

  /* ============================ VALIDATION (§6.3) ============================ */
  function renderValidation() {
    const r = state.result, body = $("#validationBody"); U.clear(body);

    // feasibility badge
    const badge = $("#feasibilityBadge");
    badge.textContent = U.fmtNum(r.pctComplete, 1) + "% of " + r.params.priorities.join(", ") + " scope";
    badge.className = "badge " + (r.blocked.length ? "badge--warn" : "badge--ok");

    /* ---- Plan feasibility ---- (removed: its figures now live in the plan summary
       at the top — installable, scope %, carry-over, working days, finish dates.
       Only the hindrance-impact note, which is NOT in the summary, is kept below.) */
    if (r.hindDays || r.hindHours) {
      const hind = section("Hindrance impact");
      hind.appendChild(el("div", { class: "kv", html: "<strong>" + r.hindDays + "</strong> working day(s) removed, <strong>" + U.fmtNum(r.hindHours, 1) + "</strong> hour(s) trimmed (applied to the selected day(s))." }));
      body.appendChild(hind);
    }

    /* ---- Resources ---- */
    // "Surplus" = chosen machines that never install a pile, whether blocked by the
    // manpower cap (chosen − cap) or unused by the cost-optimizer (cap − deployed).
    // Measure against the planner's chosen input so the KPI matches "Machines chosen".
    const res = section("Resources");
    const surplus = Math.max(0, r.params.machinesInput - r.deployed);
    const cappedOut = Math.max(0, r.params.machinesInput - r.maxMachines);   // lost to manpower cap
    const optIdle = Math.max(0, r.maxMachines - r.deployed);                  // cap allows, but no gain
    const surplusSub = surplus === 0 ? "matches recommended"
      : cappedOut && optIdle ? cappedOut + " capped by manpower · " + optIdle + " add 0 piles"
      : cappedOut ? cappedOut + " capped by manpower (need " + (r.params.machinesInput * 6) + " people)"
      : "add 0 piles — material/work limited";
    res.appendChild(statGrid([
      { label: "Machines chosen", value: r.params.machinesInput, sub: "planner input", kind: "" },
      { label: "Recommended machines", value: r.deployed, sub: surplus > 0 ? surplus + " fewer than chosen" : "matches input", kind: surplus > 0 ? "warn" : "ok" },
      { label: "Idle if all deployed", value: surplus, sub: surplusSub, kind: surplus > 0 ? "warn" : "ok" },
      { label: "Manpower utilization (at recommended)", value: (r.deployed * 6) + " / " + r.params.manpower, sub: U.fmtNum(r.params.manpower ? (r.deployed * 6 / r.params.manpower) * 100 : 0, 0) + "% of available", kind: "" }
    ]));
    body.appendChild(res);

    /* ---- Productivity ---- */
    // Daily budget is rounded UP to whole piles (a pile can't be partly installed),
    // so we show the raw steady rate with its ceil alongside, and the effective
    // capacity uses that whole-pile rate (ceil × machines) — matching what the plan
    // actually installs per day.
    // "Productivity & ramp-up" tiles moved up into the plan summary (Productivity +
    // Machines deployed KPI tiles). The ramp note is kept here for reference.
    const prod = section("Ramp-up");
    prod.appendChild(el("div", { class: "kv", html: "Steady-state achieved in <strong>" + r.params.rampN + "</strong> day(s); machines 1–" + r.params.prevMachines + " start at steady-state; machines beyond ramp up." }));
    body.appendChild(prod);

    /* ---- Material ---- (per-profile table removed; see the Material tab for the
       day-by-day breakdown. Here we keep just the inbound chips + a blocked shortcut.) */
    const mat = section("Material");
    if (r.windowArrivals.length) {
      mat.appendChild(el("div", { class: "kv", html: "Inbound arrivals within window (usable on arrival + 1 day):" }));
      const chips = el("div", { class: "inbound-time" });
      r.windowArrivals.forEach((a) => chips.appendChild(el("span", { class: "inbound-chip", text: U.fmtShort(a.date) + ": +" + U.fmtInt(a.qty) + " " + a.profile })));
      mat.appendChild(chips);
    }
    if (r.blocked.length) {
      const bl = el("div", { class: "blocked-note" });
      bl.appendChild(el("span", { class: "blocked-note__txt", html: "<strong>" + r.blocked.length + "</strong> chainage(s) blocked — no usable material (" + U.fmtInt(r.blockedMTO) + " piles)." }));
      // Button 1 — open a popup table of the blocked chainages vs their profiles.
      const listBtn = el("button", { type: "button", class: "btn btn--ghost btn--sm" },
        [el("span", { html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:5px"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>' }),
         document.createTextNode("View blocked list")]);
      listBtn.addEventListener("click", () => openBlockedModal(r.blocked));
      bl.appendChild(listBtn);
      // Button 2 — jump to the map with the "blocked" filter applied.
      const btn = el("button", { type: "button", class: "btn btn--ghost btn--sm" },
        [el("span", { html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:5px"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><line x1="9" y1="4" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="20"/></svg>' }),
         document.createTextNode("View blocked on map")]);
      btn.addEventListener("click", () => setMapFilters(["blocked"]));
      bl.appendChild(btn);
      mat.appendChild(bl);
    }
    if (!r.windowArrivals.length && !r.blocked.length) {
      mat.appendChild(el("div", { class: "kv", text: "No inbound within the window and nothing blocked." }));
    }
    body.appendChild(mat);

    /* ---- Warnings ---- */
    const warn = section("Warnings");
    const ul = el("ul", { class: "warnlist" });
    const icon = { bad: "⛔", warn: "⚠", info: "ℹ", ok: "✔" };
    r.warnings.forEach((w) => ul.appendChild(el("li", { class: "w-" + w.level }, [el("span", { class: "warnlist__icon", text: icon[w.level] || "•" }), document.createTextNode(" " + w.text)])));
    warn.appendChild(ul);
    body.appendChild(warn);

    /* ---- Warning decisions (Change 6) ---- */
    if (r.decisions && r.decisions.length) {
      const dec = section("Warning decisions");
      dec.appendChild(el("div", { class: "kv", html: "Reviewed at generation time and stored with this plan:" }));
      const dl = el("ul", { class: "decisionlist" });
      r.decisions.forEach((d) => {
        const li = el("li", { class: "decision decision--" + (d.decision === "accepted" ? "ok" : "adj") });
        li.appendChild(el("span", { class: "decision__tag", text: d.decision === "accepted" ? "Accepted" : "Adjusted" }));
        li.appendChild(el("div", {}, [
          el("div", { class: "decision__warn", text: d.text }),
          el("div", { class: "decision__detail", text: d.detail })
        ]));
        dl.appendChild(li);
      });
      dec.appendChild(dl);
      body.appendChild(dec);
    }
  }

  // Estimated finish date for the whole priority (projected past the plan window),
  // constrained by the actual material-arrival timeline.
  function planFinishStat(r) {
    if (r.remainingMTO <= 0) return { label: "Priority finish", value: "Complete", sub: "already fully installed", kind: "ok" };
    if (r.finishCoversAll && r.projectedFinish)
      return { label: "Total Work Halt due to Non-Availability of Material", value: U.fmtDate(r.projectedFinish), sub: (r.projFinishWorkingDays || 0) + " working days at " + r.deployed + " machine(s)", kind: "" };
    if (r.projTimeLimited)
      return { label: "Total Work Halt due to Non-Availability of Material", value: "beyond ~2 yr", sub: "scope exceeds a 2-year horizon", kind: "warn" };
    if (r.projectedFinish)
      return { label: "Total Work Halt due to Non-Availability of Material", value: U.fmtDate(r.projectedFinish), sub: U.fmtInt(r.unachievablePiles) + " more material needed", kind: "warn" };
    return { label: "Total Work Halt due to Non-Availability of Material", value: "—", sub: r.deployed <= 0 ? "no machines deployed" : "no installable material", kind: "warn" };
  }

  // Estimated finish assuming ALL material arrives — rate-limited only
  // (steady daily capacity × remaining scope), ignoring supply constraints.
  function fullFinishStat(r) {
    if (r.remainingMTO <= 0) return { label: "Est. Finish · As per Full Material Availability", value: "Complete", sub: "already fully installed", kind: "ok" };
    if (r.fullMaterialFinish)
      return { label: "Est. Finish · As per Full Material Availability", value: U.fmtDate(r.fullMaterialFinish), sub: (r.fullMaterialWorkingDays || 0) + " working days at " + U.fmtNum(r.effectiveDailyCapacity, 0) + " piles/day", kind: "ok" };
    return { label: "Est. Finish · As per Full Material Availability", value: "—", sub: "no machines deployed", kind: "warn" };
  }

  // Build a titled section wrapper for the validation panel.
  function section(title) { const s = el("div", { class: "vsection" }); s.appendChild(el("div", { class: "vsection__title", text: title })); return s; }
  // Build a KPI stat-tile grid from {label,value,sub,tone} items.
  function statGrid(stats) {
    const g = el("div", { class: "statgrid" });
    stats.forEach((s) => {
      const c = el("div", { class: "stat" + (s.kind ? " stat--" + s.kind : "") + (s.tone ? " stat--t-" + s.tone : "") });
      c.appendChild(el("div", { class: "stat__label", text: s.label }));
      c.appendChild(el("div", { class: "stat__value", text: s.value }));
      if (s.sub) c.appendChild(el("div", { class: "stat__sub", text: s.sub }));
      g.appendChild(c);
    });
    return g;
  }
  // Build a labelled horizontal progress bar (percent complete).
  function bigBar(pct) {
    const bar = el("div", { class: "bigbar" });
    bar.appendChild(el("div", { class: "bigbar__fill", style: "width:" + U.clamp(pct, 0, 100) + "%" }));
    bar.appendChild(el("div", { class: "bigbar__txt", text: U.fmtNum(pct, 1) + "% complete" }));
    return bar;
  }
})();
