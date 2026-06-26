/* =============================================================================
   data.js — parse the four source files, normalize, and compute defaults.

   Exposes SPP.data with:
     parseChainage(text)            -> chainage model
     parseWorkbookFile(buf, kind)   -> manpower | material | progress models
     computeDefaults(store)         -> the auto-filled input defaults
   Each parser throws Error("clear message") on a structural problem so the UI
   can show it against the right file row.
   ============================================================================= */
(function () {
  "use strict";
  const SPP = window.SPP;
  const U = SPP.util;
  const D = (SPP.data = {});

  /* ---- helpers for header-based sheet reading ------------------------------ */
  function norm(h) { return String(h == null ? "" : h).replace(/\s+/g, " ").trim().toLowerCase(); }

  // Read a worksheet as array-of-arrays + a {normalizedHeader: colIndex} map.
  function readSheet(ws) {
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
    const header = rows.length ? rows[0] : [];
    const idx = {};
    header.forEach((h, i) => { const n = norm(h); if (n && !(n in idx)) idx[n] = i; });
    return { rows: rows.slice(1), header: header, col: idx };
  }
  function requireCols(sheet, names, where) {
    const missing = names.filter((n) => !(norm(n) in sheet.col));
    if (missing.length) throw new Error(where + ": missing column(s) " + missing.join(", "));
    return names.map((n) => sheet.col[norm(n)]);
  }

  /* =====================================================================
     3.1  Chainage GeoJSON
     ===================================================================== */
  D.parseChainage = function (text) {
    let gj;
    try { gj = JSON.parse(text); } catch (e) { throw new Error("Not valid JSON."); }
    if (!gj || gj.type !== "FeatureCollection" || !Array.isArray(gj.features))
      throw new Error("Expected a GeoJSON FeatureCollection with a 'features' array.");

    const reqProps = ["Chainage_Id", "Priority", "Profile Name", "No of Profiles", "New SAP Code"];
    const features = [];
    let badProps = 0;
    gj.features.forEach((f) => {
      const p = f && f.properties;
      if (!p) { badProps++; return; }
      const id = p["Chainage_Id"];
      if (id == null || id === "") return;
      const mto = parseInt(U.toNum(p["No of Profiles"]), 10);
      features.push({
        id: String(id).trim(),
        priority: String(p["Priority"] || "").trim(),
        profile: String(p["Profile Name"] || "").trim(),
        code: String(p["New SAP Code"] == null ? "" : p["New SAP Code"]).trim(),
        mto: isFinite(mto) ? mto : 0,
        name: p["name"] || null,
        sortKey: U.chainageSortKey(id)
      });
    });
    if (!features.length) throw new Error("No usable features (need " + reqProps.join(", ") + ").");

    const priorities = Array.from(new Set(features.map((f) => f.priority).filter(Boolean)))
      .sort((a, b) => U.priorityOrder(a) - U.priorityOrder(b) || a.localeCompare(b));
    const priorityCounts = {};
    features.forEach((f) => { priorityCounts[f.priority] = (priorityCounts[f.priority] || 0) + 1; });
    const profiles = Array.from(new Set(features.map((f) => f.profile).filter(Boolean)));

    return { features, priorities, priorityCounts, profiles };
  };

  /* =====================================================================
     Workbook dispatcher
     ===================================================================== */
  D.parseWorkbookFile = function (buf, kind) {
    let wb;
    try { wb = XLSX.read(buf, { type: "array" }); }
    catch (e) { throw new Error("Could not read .xlsx (is it a valid Excel file?)."); }
    if (kind === "manpower") return parseManpower(wb);
    if (kind === "material") return parseMaterial(wb);
    if (kind === "progress") return parseProgress(wb);
    throw new Error("Unknown workbook kind: " + kind);
  };

  function getSheet(wb, name) {
    // tolerant sheet lookup (case/space-insensitive)
    if (wb.Sheets[name]) return wb.Sheets[name];
    const want = norm(name);
    const hit = wb.SheetNames.find((s) => norm(s) === want);
    return hit ? wb.Sheets[hit] : null;
  }

  /* ---------------------------------------------------------------------------
     Removable normalization (§3.2): the source has TWO rows with the same shift
     date (a typo). The FIRST occurrence of the duplicated date is shifted back
     one day so there is exactly one row per day. Delete this function call once
     the upstream data is corrected — it is a no-op when there are no duplicates.
     --------------------------------------------------------------------------- */
  function fixDuplicateShiftDate(records) {
    const seen = new Set();
    let dupISO = null;
    for (const r of records) {                       // find first date that repeats
      const iso = U.fmtISO(r.date);
      if (seen.has(iso)) { dupISO = iso; break; }
      seen.add(iso);
    }
    if (!dupISO) return { records, applied: null };
    for (const r of records) {                       // shift first occurrence back 1 day
      if (U.fmtISO(r.date) === dupISO) {
        const from = U.fmtISO(r.date);
        r.date = U.addDays(r.date, -1);
        r._fixedFrom = from;
        return { records, applied: { from: dupISO, to: U.fmtISO(r.date) } };
      }
    }
    return { records, applied: null };
  }

  /* =====================================================================
     3.2  Manpower / machines / shift hours
     ===================================================================== */
  function parseManpower(wb) {
    const sMachine = getSheet(wb, "Machine Status");
    const sManpower = getSheet(wb, "Manpower Status");
    const sHour = getSheet(wb, "Shifthour Status") || getSheet(wb, "Manhour Status");
    if (!sMachine || !sManpower || !sHour)
      throw new Error("Need sheets 'Machine Status', 'Manpower Status', 'Shifthour Status'.");

    function readSeries(ws, valCol, where) {
      const sh = readSheet(ws);
      const [cDate, cVal] = requireCols(sh, ["Shift Date", valCol], where);
      const out = [];
      sh.rows.forEach((r) => {
        const d = U.coerceDate(r[cDate]);
        if (!d) return;
        out.push({ date: d, val: U.toNum(r[cVal]) || 0 });
      });
      return fixDuplicateShiftDate(out);
    }

    const machine = readSeries(sMachine, "Machines Available", "Machine Status");
    const manpower = readSeries(sManpower, "Manpower Available", "Manpower Status");
    const hour = readSeries(sHour, "Manhour", "Shifthour Status");

    const machineMap = mapByISO(machine.records);
    const manpowerMap = mapByISO(manpower.records);
    const hourMap = mapByISO(hour.records);

    const allDates = machine.records.map((r) => r.date);
    const latestShift = allDates.length ? new Date(Math.max.apply(null, allDates.map((d) => d.getTime()))) : null;

    return {
      machine: machine.records, manpower: manpower.records, hour: hour.records,
      machineMap, manpowerMap, hourMap, latestShift,
      fix: machine.applied || manpower.applied || hour.applied || null
    };
  }
  function mapByISO(records) { const m = {}; records.forEach((r) => { m[U.fmtISO(r.date)] = r.val; }); return m; }

  /* =====================================================================
     3.3  Material logistics
     ===================================================================== */
  function parseMaterial(wb) {
    const ws = getSheet(wb, "Material Logistics");
    if (!ws) throw new Error("Need sheet 'Material Logistics'.");
    const sh = readSheet(ws);
    const [cCode, cName, cQty, cReceipt, cArrival] =
      requireCols(sh, ["Item Code", "Item Name", "Quantity", "Receipt date", "Expected Arrival"], "Material Logistics");

    const byCode = {};
    let maxReceipt = null;
    let onsiteRows = 0, inboundRows = 0;

    sh.rows.forEach((r) => {
      const code = r[cCode] == null ? "" : String(r[cCode]).trim();
      if (!code) return;
      const qty = U.toNum(r[cQty]) || 0;
      const receipt = U.coerceDate(r[cReceipt]);
      const arrival = U.coerceDate(r[cArrival]);
      const rec = byCode[code] || (byCode[code] = { code, name: r[cName] || code, onsite: 0, inbound: [] });
      if (r[cName] && rec.name === code) rec.name = r[cName];

      // On-site: Receipt date set & Expected Arrival empty.
      if (receipt && !arrival) {
        rec.onsite += qty; onsiteRows++;
        if (!maxReceipt || receipt > maxReceipt) maxReceipt = receipt;
      }
      // Inbound: Expected Arrival set & Receipt date empty. Usable on arrival + 1 day.
      else if (arrival && !receipt) {
        rec.inbound.push({ arrival, usable: U.addDays(arrival, 1), qty });
        inboundRows++;
      }
      // (rows with both / neither are ignored)
    });
    Object.values(byCode).forEach((c) => c.inbound.sort((a, b) => U.cmpDate(a.usable, b.usable)));

    return { byCode, maxReceipt, onsiteRows, inboundRows };
  }

  /* =====================================================================
     3.4  Progress history
     ===================================================================== */
  function parseProgress(wb) {
    const ws = getSheet(wb, "Progress history") || wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("Need a 'Progress history' sheet.");
    const sh = readSheet(ws);
    const [cSub, cDate, cVal] = requireCols(sh, ["Sub Activity", "Date", "Value"], "Progress history");
    const cName = sh.col[norm("Name")];

    const installedByDate = {};   // ISO -> piles installed that day
    let maxDate = null;
    let installedRowCount = 0;

    sh.rows.forEach((r) => {
      const sub = r[cSub];
      const d = U.coerceDate(r[cDate]);
      if (sub == null || !d) return;        // §3.4: skip trailing null row
      if (d && (!maxDate || d > maxDate)) maxDate = d;
      if (String(sub).trim() === "Sheet Pile Installed") {
        const v = U.toNum(r[cVal]) || 0;
        const iso = U.fmtISO(d);
        installedByDate[iso] = (installedByDate[iso] || 0) + v;
        installedRowCount++;
      }
    });
    return { installedByDate, maxDate, installedRowCount };
  }

  /* =====================================================================
     4.  Defaults (the "last 7 days" methodology)
     ===================================================================== */
  D.computeDefaults = function (store) {
    const mp = store.manpower, mat = store.material, pr = store.progress;
    const anchor = mp.latestShift;
    if (!anchor) throw new Error("No shift dates found in manpower file.");

    // 7-day window = anchor and the 6 prior calendar days.
    const windowEnd = anchor;
    const windowStart = U.addDays(anchor, -6);
    const windowDays = [];
    for (let i = 0; i < 7; i++) windowDays.push(U.addDays(windowStart, i));

    let sumMachine = 0, sumMan = 0, sumHour = 0, machineHours = 0, pilesWindow = 0;
    windowDays.forEach((d) => {
      const iso = U.fmtISO(d);
      const m = mp.machineMap[iso] || 0;
      const h = mp.hourMap[iso] || 0;
      sumMachine += m;
      sumMan += (mp.manpowerMap[iso] || 0);
      sumHour += h;
      machineHours += m * h;                 // Σ daily machines × workhours
      pilesWindow += (pr.installedByDate[iso] || 0);
    });

    const machines = Math.round(sumMachine / 7);
    const manpower = Math.round(sumMan / 7);
    const workhours = Math.round(sumHour / 7);
    const productivity = machineHours > 0 ? U.round(pilesWindow / machineHours, 3) : 0;

    // Latest *actual* dated record across inputs (EXCLUDES future inbound forecasts).
    const candidates = [anchor];
    if (pr.maxDate) candidates.push(pr.maxDate);
    if (mat.maxReceipt) candidates.push(mat.maxReceipt);
    const latestDataDate = new Date(Math.max.apply(null, candidates.map((d) => d.getTime())));
    const planStartDefault = U.firstMondayAfter(latestDataDate);

    return {
      windowStart, windowEnd, windowDays,
      machines, manpower, workhours, productivity,
      sumMachine, sumMan, sumHour, machineHours, pilesWindow,
      latestDataDate, planStartDefault,
      prodDerivation:
        pilesWindow + " piles ÷ (" + sumMachine + " machine-days × " + (workhours) +
        " h) = " + pilesWindow + " ÷ " + machineHours + " machine-hours = " + U.fmtNum(productivity, 3)
    };
  };
})();
