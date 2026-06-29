/* =============================================================================
   ui.js — file loading, defaults population, the Generate handler, the Gantt /
   Table / Validation renderers, the view toggle and localStorage persistence.
   ============================================================================= */
(function () {
  "use strict";
  const SPP = window.SPP;
  const U = SPP.util;
  const $ = U.$, el = U.el;
  const LS_KEY = "spp_machines_prev";
  const MACHINE_COLORS = ["#0f6e78", "#b6791f", "#2f5fb0", "#8a3ffc", "#1f8f5f", "#c2412f", "#5b6877", "#0aa2c0"];

  const state = {
    parsed: { chainage: null, manpower: null, material: null, progress: null },
    store: null, defaults: null, result: null,
    view: "gantt", ganttColor: "profile"
  };

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
    $("#tryBundledBtn").addEventListener("click", tryBundled);
    $("#generateBtn").addEventListener("click", onGenerate);
    $("#generateBtn2").addEventListener("click", onGenerate);
    $("#addHindranceBtn").addEventListener("click", () => addHindranceRow());
    $("#resetHistoryBtn").addEventListener("click", resetHistory);
    $("#pStart").addEventListener("change", enforceMonday);
    $("#pStart").addEventListener("change", refreshHindranceCalendars);
    $("#pMachines").addEventListener("input", refreshCapNotice);
    $("#pManpower").addEventListener("input", refreshCapNotice);
    U.$$('input[name="period"]').forEach((r) => r.addEventListener("change", refreshHindranceCalendars));
    $("#pWorkDays").addEventListener("change", refreshHindranceCalendars);

    // Ramp-up curve live preview (Change 5)
    ["#pRampProfile", "#pRampN", "#pProductivity", "#pWorkhours"].forEach((sel) => {
      const n = $(sel); if (n) n.addEventListener("input", renderRampChart);
    });

    U.$$("#viewToggle .view-toggle__btn").forEach((b) =>
      b.addEventListener("click", () => setView(b.dataset.view)));
    U.$$("#ganttColorMode .seg__btn").forEach((b) =>
      b.addEventListener("click", () => { state.ganttColor = b.dataset.mode; U.$$("#ganttColorMode .seg__btn").forEach((x) => x.classList.toggle("is-active", x === b)); if (state.result) renderGantt(); }));
    $("#tableGroup").addEventListener("change", () => { if (state.result) renderTable(); });

    updateStoredHistoryHint();
    refresh();
  }

  /* ============================ CHAINAGE (frozen, read-only) ============================ */
  function renderChainageReadonly() {
    const ch = state.parsed.chainage;
    if (!ch) return;
    const counts = ch.priorities.map((p) => p + " " + U.fmtInt(ch.priorityCounts[p])).join(" · ");
    $("#chainageSummary").innerHTML = "<strong>" + U.fmtInt(ch.features.length) + "</strong> chainages · " +
      ch.profiles.length + " profiles · " + counts;
    // Build the read-only table lazily the first time the section is opened.
    const det = $("#chainageDetails");
    let built = false;
    det.addEventListener("toggle", function () {
      if (!det.open || built) return;
      built = true;
      const rows = ch.features.slice().sort((a, b) => a.sortKey - b.sortKey);
      const t = el("table", { class: "data" });
      t.innerHTML = "<thead><tr><th>Chainage_Id</th><th>Priority</th><th>Profile</th><th class='num'>No. of Profiles</th><th>SAP Code</th></tr></thead>";
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
  function setStatus(kind, msg, cls) {
    const row = fileRow(kind);
    row.querySelector('[data-role="status"]').textContent = msg;
    row.classList.remove("is-ok", "is-bad");
    if (cls) row.classList.add(cls);
  }

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

  function summarize(kind, m) {
    if (kind === "chainage") return "✓ " + U.fmtInt(m.features.length) + " chainages · " + m.priorities.length + " priorities · " + m.profiles.length + " profiles";
    if (kind === "manpower") {
      const ds = m.machine.map((r) => r.date);
      const span = ds.length ? U.fmtShort(new Date(Math.min.apply(null, ds.map((d) => d.getTime())))) + "–" + U.fmtShort(m.latestShift) : "?";
      return "✓ " + m.machine.length + " days (" + span + ")" + (m.fix ? " · date-fix applied" : "");
    }
    if (kind === "material") return "✓ " + m.onsiteRows + " on-site · " + m.inboundRows + " inbound rows · " + Object.keys(m.byCode).length + " codes";
    if (kind === "progress") return "✓ " + m.installedRowCount + " install records · latest " + U.fmtShort(m.maxDate);
    return "✓ loaded";
  }

  function allLoaded() { return state.parsed.chainage && state.parsed.manpower && state.parsed.material && state.parsed.progress; }

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
        $("#generateBtn").disabled = false;
      } catch (err) {
        U.toast("Defaults error: " + err.message, "bad");
      }
    } else {
      $("#paramsCard").setAttribute("aria-disabled", "true");
      $("#generateBtn").disabled = true;
    }
  }

  // Attempt to fetch bundled ./data files (only succeeds over http, not file://).
  function tryBundled() {
    const map = {
      manpower: "data/manpower_resources.xlsx",
      material: "data/material_logistics.xlsx",
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
        .finally(() => { if (++done === kinds.length) { refresh(); if (!ok) U.toast("Bundled fetch blocked (likely file://). Use the upload inputs.", "bad"); } });
    });
  }

  /* ============================ DEFAULTS -> FORM ============================ */
  function populateDefaults() {
    const d = state.defaults, ch = state.store.chainage;
    const sel = $("#pPriority");
    const cur = sel.value;
    U.clear(sel);
    sel.appendChild(el("option", { value: "", disabled: "", selected: cur ? null : "" , text: "Select priority…" }));
    ch.priorities.forEach((p) => sel.appendChild(el("option", { value: p, text: p + "  (" + U.fmtInt(ch.priorityCounts[p]) + " chainages)", selected: p === cur ? "" : null })));

    $("#pStart").value = U.fmtISO(d.planStartDefault);
    $("#pStartHint").textContent = "Default " + U.fmtFriendly(d.planStartDefault) + " (first Monday after latest record " + U.fmtShort(d.latestDataDate) + ").";

    setVal("#pMachines", d.machines);
    setVal("#pManpower", d.manpower);
    setVal("#pWorkhours", d.workhours);
    setVal("#pProductivity", U.fmtNum(d.productivity, 3));

    $("#pMachinesHint").textContent = "Onsite Avg: " + U.fmtNum(d.sumMachine / 7, 2) + "/day → " + d.machines;
    $("#pManpowerHint").textContent = "Onsite Avg: " + U.fmtNum(d.sumMan / 7, 2) + "/day → " + d.manpower;
    $("#pWorkhoursHint").textContent = "Onsite Avg: " + U.fmtNum(d.sumHour / 7, 2) + "/day → " + d.workhours;
    $("#pProductivityHint").textContent = "Onsite Avg (12–18 Jun window)";
    $("#prodInfoPop").textContent = d.prodDerivation;

    // Machines from previous plan: stored value, else equal to machines (no ramp on first plan).
    const stored = readStored();
    setVal("#pPrevMachines", stored ? stored.machines : d.machines);
    $("#pPrevHint").textContent = stored ? ("from last plan (" + U.fmtShort(new Date(stored.ts)) + ")") : "first run = machines (no ramp)";

    $("#paramsPlaceholder").hidden = true;
    $("#paramsForm").hidden = false;
    refreshCapNotice();
    renderRampChart();
    refreshHindranceCalendars();
  }
  function setVal(sel, v) { const n = $(sel); if (n) n.value = v; }

  /* ============================ PARAM HELPERS ============================ */
  function enforceMonday(e) {
    const d = U.parseISODate(e.target.value);
    if (!d) return;
    if (!U.isMonday(d)) {
      const monday = U.addDays(d, -(U.isoDow(d) - 1)); // back to Monday of that week
      e.target.value = U.fmtISO(monday);
      U.toast("Plan start must be a Monday — snapped to " + U.fmtFriendly(monday), "");
    }
  }

  function refreshCapNotice() {
    const machines = parseInt($("#pMachines").value, 10);
    const manpower = parseInt($("#pManpower").value, 10);
    const notice = $("#capNotice");
    if (!isFinite(machines) || !isFinite(manpower)) { notice.hidden = true; return; }
    const cap = Math.floor(manpower / 6);
    if (machines > cap) {
      notice.hidden = false;
      notice.textContent = "Capped to " + cap + " machine" + (cap === 1 ? "" : "s") + " — manpower " + manpower + " supports " + cap + "×6 = " + (cap * 6) + " people. The engine will use " + cap + ".";
    } else { notice.hidden = true; }
  }

  function addHindranceRow(data) {
    data = data || {};
    const list = $("#hindranceList");
    const row = el("div", { class: "hindrance" });

    const top = el("div", { class: "hindrance__top" });
    const type = el("select", { class: "input input--sm hindrance__type" });
    ["Political", "Weather", "Other"].forEach((t) => type.appendChild(el("option", { value: t, text: t, selected: data.type === t ? "" : null })));
    const amt = el("input", { class: "input input--sm hindrance__amt", type: "number", min: "0", step: "0.5", value: data.amount != null ? data.amount : "1", title: "days unit: # of earliest days (used only if no day is selected) · hours unit: hours lost per selected day" });
    const unit = el("select", { class: "input input--sm hindrance__unit" });
    ["days", "hours"].forEach((u) => unit.appendChild(el("option", { value: u, text: u, selected: data.unit === u ? "" : null })));
    const del = el("button", { class: "hindrance__del", title: "Remove", html: "&times;", onclick: () => row.remove() });
    [type, amt, unit, del].forEach((n) => top.appendChild(n));
    row.appendChild(top);

    const daysWrap = el("div", { class: "hindrance__days" });
    daysWrap.appendChild(el("div", { class: "hindrance__days-label", text: "Affected day(s) — click to toggle (non-contiguous OK):" }));
    const cal = el("div", { class: "hcal" });
    daysWrap.appendChild(cal);
    row.appendChild(daysWrap);

    row.appendChild(el("div", { class: "hindrance__hint", html: "<strong>days</strong>: each selected day is fully lost · <strong>hours</strong>: the amount is trimmed from each selected day. With no day selected, impact falls on the earliest day(s)." }));

    cal.addEventListener("click", (e) => { const c = e.target.closest(".hcal__day"); if (c) c.classList.toggle("is-sel"); });
    list.appendChild(row);
    buildHindranceCalendar(cal, data.days || []);
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
        class: "hcal__day" + (weekoff ? " is-weekoff" : "") + (sel.has(iso) ? " is-sel" : ""),
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
    });
  }

  /* ============================ RAMP-UP CURVE (Change 5) ============================ */
  // TODO: confirm Y-axis meaning — assumed "productivity rate" = piles/machine/hour
  // (base productivity × ramp multiplier), not piles/day.
  function renderRampChart() {
    const host = $("#rampChart");
    if (!host) return;
    const prod = U.toNum($("#pProductivity").value);
    const ramp = $("#pRampProfile").value.split(",").map((s) => U.toNum(s)).filter((n) => isFinite(n) && n >= 0);
    const nDays = parseInt($("#pRampN").value, 10);
    if (!(prod > 0) || !ramp.length) { host.innerHTML = '<div class="field__hint">Enter productivity and a ramp profile to preview the curve.</div>'; return; }

    const last = ramp[ramp.length - 1];
    const maxDay = ramp.length - 1 + 2;                 // show 2 steady days past the profile
    const pts = [];
    for (let k = 0; k <= maxDay; k++) { const m = k < ramp.length ? ramp[k] : last; pts.push({ day: k, rate: prod * m, mult: m }); }
    const yMax = Math.max.apply(null, pts.map((p) => p.rate)) * 1.12 || 1;

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

  /* ============================ STORAGE ============================ */
  function readStored() { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { return null; } }
  function writeStored(machines, priority) {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ machines, priority, ts: Date.now() })); } catch (e) {}
    updateStoredHistoryHint();
  }
  function resetHistory() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    if (state.defaults) setVal("#pPrevMachines", $("#pMachines").value || state.defaults.machines);
    $("#pPrevHint").textContent = "reset — first run = machines (no ramp)";
    updateStoredHistoryHint();
    U.toast("Stored machine history cleared.", "ok");
  }
  function updateStoredHistoryHint() {
    const s = readStored();
    $("#storedHistoryHint").textContent = s ? ("Stored: " + s.machines + " machines · " + (s.priority || "") + " · " + U.fmtShort(new Date(s.ts))) : "Nothing stored yet.";
  }

  /* ============================ GENERATE ============================ */
  function onGenerate() {
    if (!allLoaded()) { U.toast("Load the manpower, material and progress files first.", "bad"); return; }
    const p = gatherParams();
    if (!p) return;
    try {
      state.result = SPP.engine.generate(state.store, p);
    } catch (err) {
      U.toast("Plan failed: " + err.message, "bad"); console.error(err); return;
    }
    writeStored(state.result.deployed, p.priority);  // §5.6 persist effective deployed count
    renderAll();
    U.toast("Plan generated — " + state.result.deployed + " machine(s) deployed.", "ok");
    document.getElementById("resultsCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function gatherParams() {
    const priority = $("#pPriority").value;
    if (!priority) { U.toast("Choose a chainage priority.", "bad"); $("#pPriority").focus(); return null; }
    const planStart = U.parseISODate($("#pStart").value);
    if (!planStart) { U.toast("Pick a plan start date.", "bad"); return null; }
    if (!U.isMonday(planStart)) { U.toast("Plan start must be a Monday.", "bad"); return null; }

    const periodWeeks = parseInt((document.querySelector('input[name="period"]:checked') || {}).value || "2", 10);
    const machinesInput = parseInt($("#pMachines").value, 10);
    const manpower = parseInt($("#pManpower").value, 10);
    const workDaysPerWeek = parseInt($("#pWorkDays").value, 10);
    const workhours = parseInt($("#pWorkhours").value, 10);
    const productivity = U.toNum($("#pProductivity").value);
    const rampN = parseInt($("#pRampN").value, 10) || 0;
    const prevMachines = Math.max(0, parseInt($("#pPrevMachines").value, 10) || 0);
    const rampProfile = $("#pRampProfile").value.split(",").map((s) => U.toNum(s)).filter((n) => isFinite(n) && n >= 0);

    if (!(machinesInput >= 0)) { U.toast("Machines must be ≥ 0.", "bad"); return null; }
    if (!(manpower > 0)) { U.toast("Manpower must be positive.", "bad"); return null; }
    if (!(workhours > 0)) { U.toast("Workhours must be positive.", "bad"); return null; }
    if (!(productivity > 0)) { U.toast("Productivity must be greater than 0.", "bad"); return null; }

    return { priority, periodWeeks, planStart, machinesInput, manpower, workDaysPerWeek, workhours,
             productivity, rampN, prevMachines, rampProfile: rampProfile.length ? rampProfile : [1],
             hindrances: readHindrances() };
  }

  /* ============================ RENDER (top) ============================ */
  function renderAll() {
    const r = state.result;
    $("#resultsEmpty").hidden = true;
    $("#viewToggle").hidden = false;
    $("#validationCard").hidden = false;

    const periodLbl = r.params.periodWeeks + " weeks";
    $("#planMeta").innerHTML =
      "<span>" + U.esc(r.params.priority) + "</span><span>" + periodLbl + "</span>" +
      "<span>" + U.fmtFriendly(r.planStart) + " → " + U.fmtShort(r.planEnd) + "</span>" +
      "<span>" + r.deployed + (r.deployed !== r.maxMachines ? "/" + r.maxMachines : "") + " machine" + (r.deployed === 1 ? "" : "s") + "</span>" +
      "<span>" + r.workingDayCount + " working days</span>";

    renderGantt();
    renderTable();
    renderValidation();
    setView(state.view);
  }

  function setView(v) {
    state.view = v;
    $("#ganttView").hidden = v !== "gantt";
    $("#tableView").hidden = v !== "table";
    U.$$("#viewToggle .view-toggle__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.view === v));
  }

  /* ============================ TABLE VIEW (§6.1) ============================ */
  function computeDisplay(schedule) {
    const byCh = {};
    schedule.forEach((e) => (byCh[e.chId] || (byCh[e.chId] = [])).push(e));
    Object.values(byCh).forEach((list) => {
      list.sort((a, b) => a.date - b.date);
      let prev = 0;
      list.forEach((e) => { e.dispCum = Math.round(e.cum); e.dispInstall = e.dispCum - prev; prev = e.dispCum; });
    });
  }

  function renderTable() {
    const r = state.result;
    computeDisplay(r.schedule);
    const groupBy = $("#tableGroup").value;

    const cols = ["Date", "Day #", "Machine", "Chainage", "Profile", "Piles (day)", "Cum.", "MTO", "% Comp.", "Status", "Material left"];
    const table = el("table", { class: "data" });
    const thead = el("thead");
    const htr = el("tr");
    cols.forEach((c, i) => htr.appendChild(el("th", { class: i >= 5 && i <= 8 || i === 10 ? "num" : "", text: c })));
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
      el("td", { class: "num", text: U.fmtInt(e.dispInstall) }),
      el("td", { class: "num", text: U.fmtInt(e.dispCum) }),
      el("td", { class: "num", text: U.fmtInt(e.mto) }),
      el("td", { class: "num", text: U.fmtNum(pct, 1) + "%" }),
      el("td", {}, [status]),
      el("td", { class: "num", text: U.fmtInt(Math.round(e.stockEnd)) })
    ].forEach((td) => tr.appendChild(td));
    return tr;
  }
  function nonworkRow(c, span) {
    const tr = el("tr", { class: "row-nonwork" });
    tr.appendChild(el("td", { colspan: span, text: U.fmtShort(c.date) + " (Day " + c.dayNum + ") — " + c.nonWorkReason + " · no installation" }));
    return tr;
  }

  /* ============================ GANTT VIEW (§6.2) ============================ */
  function renderGantt() {
    const r = state.result;
    const host = $("#ganttScroll");
    U.clear(host);
    if (!r.worked.length) { host.appendChild(el("div", { class: "emptystate", html: "<p>No chainages were scheduled (no workable material, or 0 machines).</p>" })); renderLegend(); return; }

    const labelW = 250, colW = Math.max(30, Math.min(46, Math.floor(760 / r.totalDays))), rowH = 28, headH = 46;
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
      s += '<rect x="2" y="' + (y + 4) + '" width="' + (labelW - 8) + '" height="' + (rowH - 8) + '" fill="' + (ri % 2 ? "#f6f8fb" : "#ffffff") + '"/>';
      s += '<text x="10" y="' + (y + rowH / 2 + 4) + '" fill="#1c2733">' + U.esc(w.id) + '</text>';
      s += '<text x="110" y="' + (y + rowH / 2 + 4) + '" fill="#8a96a5" font-size="10">' + U.esc(w.profile) + '</text>';
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
  function tipFor(w) {
    return U.esc(w.id + " · " + w.profile + "\nMachine " + w.machine + "\n" + Math.round(w.done) + " / " + U.fmtInt(w.mto) + " piles (" + U.fmtNum((w.done / w.mto) * 100, 1) + "%)\n" + U.fmtShort(w.startDate) + " → " + U.fmtShort(w.lastDate) + (w.completed ? " (completed)" : ""));
  }
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
  function attachGanttTips(host) {
    if (!ganttTip) { ganttTip = el("div", { class: "gantt-tip" }); document.body.appendChild(ganttTip); }
    host.addEventListener("mousemove", (ev) => {
      const t = ev.target.getAttribute && ev.target.getAttribute("data-tip");
      if (t) { ganttTip.style.display = "block"; ganttTip.style.left = (ev.clientX + 14) + "px"; ganttTip.style.top = (ev.clientY + 14) + "px"; ganttTip.innerHTML = t.replace(/\n/g, "<br>"); }
      else ganttTip.style.display = "none";
    });
    host.addEventListener("mouseleave", () => { if (ganttTip) ganttTip.style.display = "none"; });
  }

  /* ============================ VALIDATION (§6.3) ============================ */
  function renderValidation() {
    const r = state.result, body = $("#validationBody"); U.clear(body);

    // feasibility badge
    const badge = $("#feasibilityBadge");
    badge.textContent = U.fmtNum(r.pctComplete, 1) + "% of " + r.params.priority + " scope";
    badge.className = "badge " + (r.blocked.length ? "badge--warn" : "badge--ok");

    /* ---- Plan feasibility ---- */
    const feas = section("Plan feasibility");
    feas.appendChild(statGrid([
      { label: "Installable this window", value: U.fmtInt(Math.round(r.totalInstalled)), sub: "piles", kind: "" },
      { label: "Total MTO (" + r.params.priority + ")", value: U.fmtInt(r.totalMTO), sub: r.candidates.length + " chainages", kind: "" },
      { label: "Carry-over beyond window", value: U.fmtInt(r.carryOver), sub: "piles not fitting", kind: r.carryOver > 0 ? "warn" : "ok" },
      { label: "Working days", value: r.workingDayCount, sub: r.totalDays + " calendar days", kind: "" }
    ]));
    feas.appendChild(el("div", { class: "kv", html: "Completion of selected priority scope:" }));
    feas.appendChild(bigBar(r.pctComplete));
    if (r.hindDays || r.hindHours) feas.appendChild(el("div", { class: "kv", html: "Hindrance impact: <strong>" + r.hindDays + "</strong> day(s) removed, <strong>" + U.fmtNum(r.hindHours, 1) + "</strong> hour(s) trimmed (applied to the selected day(s))." }));
    body.appendChild(feas);

    /* ---- Resources ---- */
    const res = section("Resources");
    res.appendChild(statGrid([
      { label: "Machines chosen", value: r.params.machinesInput, sub: "planner input", kind: "" },
      { label: "Manpower cap", value: r.cap, sub: r.params.manpower + " ÷ 6", kind: r.capApplied ? "warn" : "" },
      { label: "Deployed (cost-opt)", value: r.deployed, sub: r.idleMachines > 0 ? r.idleMachines + " would be idle" : "all productive", kind: r.idleMachines > 0 ? "warn" : "ok" },
      { label: "Manpower utilization", value: (r.deployed * 6) + " / " + r.params.manpower, sub: U.fmtNum(r.params.manpower ? (r.deployed * 6 / r.params.manpower) * 100 : 0, 0) + "% of available", kind: "" }
    ]));
    // per-machine install transparency
    const perMtxt = Object.keys(r.perM).map((m) => "M" + m + ": " + U.fmtInt(Math.round(r.perM[m]))).join("  ·  ");
    if (perMtxt) res.appendChild(el("div", { class: "kv", html: "Piles installed by machine count — " + perMtxt + " &nbsp;(fewest machines reaching the max is deployed)." }));
    body.appendChild(res);

    /* ---- Productivity ---- */
    const prod = section("Productivity & ramp-up");
    prod.appendChild(statGrid([
      { label: "Productivity", value: U.fmtNum(r.params.productivity, 3), sub: "piles / machine / hour", kind: "" },
      { label: "Steady-state / machine / day", value: U.fmtNum(r.steadyDaily, 2), sub: U.fmtNum(r.params.productivity, 3) + " × " + r.params.workhours + " h", kind: "" },
      { label: "Effective daily capacity", value: U.fmtNum(r.effectiveDailyCapacity, 2), sub: r.deployed + " machine(s) at steady-state", kind: "" }
    ]));
    prod.appendChild(el("div", { class: "kv", html: "Ramp: <strong>n = " + r.params.rampN + "</strong> · profile [" + r.rampProfile.map((x) => U.fmtNum(x, 2)).join(", ") + "] · machines 1–" + r.params.prevMachines + " start at steady-state; machines beyond ramp up." }));
    body.appendChild(prod);

    /* ---- Material ---- */
    const mat = section("Material");
    const mt = el("table", { class: "data" });
    mt.innerHTML = "<thead><tr><th>Profile</th><th class='num'>On-site</th><th class='num'>Start stock</th><th class='num'>Inbound (window)</th><th class='num'>Available</th><th class='num'>Consumed</th><th class='num'>End stock</th><th class='num'>Shortfall</th></tr></thead>";
    const mtb = el("tbody");
    r.profileRows.forEach((p) => {
      const tr = el("tr");
      tr.innerHTML =
        "<td>" + U.esc(p.profile) + "</td>" +
        "<td class='num'>" + U.fmtInt(p.onsite) + "</td>" +
        "<td class='num'>" + U.fmtInt(Math.round(p.starting)) + "</td>" +
        "<td class='num'>" + U.fmtInt(p.inboundWindow) + "</td>" +
        "<td class='num'>" + U.fmtInt(Math.round(p.available)) + "</td>" +
        "<td class='num'>" + U.fmtInt(Math.round(p.consumed)) + "</td>" +
        "<td class='num'>" + U.fmtInt(Math.round(p.endStock)) + "</td>" +
        "<td class='num'>" + (p.shortfall > 0 ? "<span style='color:var(--danger)'>" + U.fmtInt(Math.round(p.shortfall)) + "</span>" : "0") + "</td>";
      mtb.appendChild(tr);
    });
    mt.appendChild(mtb);
    mat.appendChild(mt);

    if (r.windowArrivals.length) {
      mat.appendChild(el("div", { class: "kv", style: "margin-top:12px", html: "Inbound arrivals within window (usable on arrival + 1 day):" }));
      const chips = el("div", { class: "inbound-time" });
      r.windowArrivals.forEach((a) => chips.appendChild(el("span", { class: "inbound-chip", text: U.fmtShort(a.date) + ": +" + U.fmtInt(a.qty) + " " + a.profile })));
      mat.appendChild(chips);
    }
    if (r.blocked.length) {
      const bl = el("div", { class: "blocked-list" });
      bl.innerHTML = "<strong>Blocked — no material (" + r.blocked.length + " chainages, " + U.fmtInt(r.blockedMTO) + " piles):</strong> " +
        r.blocked.slice(0, 40).map((b) => "<code>" + U.esc(b.id) + "</code>").join(" ") + (r.blocked.length > 40 ? " …" : "");
      mat.appendChild(bl);
    }
    body.appendChild(mat);

    /* ---- Warnings ---- */
    const warn = section("Warnings");
    const ul = el("ul", { class: "warnlist" });
    const icon = { bad: "⛔", warn: "⚠", info: "ℹ", ok: "✔" };
    r.warnings.forEach((w) => ul.appendChild(el("li", { class: "w-" + w.level }, [el("span", { class: "warnlist__icon", text: icon[w.level] || "•" }), document.createTextNode(" " + w.text)])));
    warn.appendChild(ul);
    body.appendChild(warn);
  }

  function section(title) { const s = el("div", { class: "vsection" }); s.appendChild(el("div", { class: "vsection__title", text: title })); return s; }
  function statGrid(stats) {
    const g = el("div", { class: "statgrid" });
    stats.forEach((s) => {
      const c = el("div", { class: "stat" + (s.kind ? " stat--" + s.kind : "") });
      c.appendChild(el("div", { class: "stat__label", text: s.label }));
      c.appendChild(el("div", { class: "stat__value", text: s.value }));
      if (s.sub) c.appendChild(el("div", { class: "stat__sub", text: s.sub }));
      g.appendChild(c);
    });
    return g;
  }
  function bigBar(pct) {
    const bar = el("div", { class: "bigbar" });
    bar.appendChild(el("div", { class: "bigbar__fill", style: "width:" + U.clamp(pct, 0, 100) + "%" }));
    bar.appendChild(el("div", { class: "bigbar__txt", text: U.fmtNum(pct, 1) + "% complete" }));
    return bar;
  }
})();
