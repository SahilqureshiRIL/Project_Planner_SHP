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
  // Resolve the required column indices for a sheet, or throw a clear error.
  function requireCols(sheet, names, where) {
    const missing = names.filter((n) => !(norm(n) in sheet.col));
    if (missing.length) throw new Error(where + ": missing column(s) " + missing.join(", "));
    return names.map((n) => sheet.col[norm(n)]);
  }

  /* =====================================================================
     3.1  Chainage GeoJSON
     ===================================================================== */
  // Build the chainage model from an array of raw property objects (original field names).
  D.buildChainageModel = function (propsList) {
    const reqProps = ["Chainage_Id", "Priority", "Profile Name", "No of Profiles", "New SAP Code"];
    const features = [];
    propsList.forEach((p) => {
      if (!p) return;
      const id = p["Chainage_Id"];
      if (id == null || id === "") return;
      const mto = parseInt(U.toNum(p["No of Profiles"]), 10);
      // "Profile" shown across the app = the full Item Description
      // (e.g. "VINYL SHEET PILE 735X300X10.4X4750"); fall back to the short
      // "Profile Name" code (e.g. "ZU735-300-10.4-4750") only if it's missing.
      const itemDesc = String(p["Item Description"] || "").trim();
      const profileCode = String(p["Profile Name"] || "").trim();
      features.push({
        id: String(id).trim(),
        priority: String(p["Priority"] || "").trim(),
        profile: itemDesc || profileCode,
        profileCode: profileCode,  // short code kept for reference
        code: String(p["New SAP Code"] == null ? "" : p["New SAP Code"]).trim(),
        mto: isFinite(mto) ? mto : 0,
        zone: String(p["Zone_Id"] || "").trim(),     // WBS zone level in the .xer export
        lengthMm: U.toNum(p["Length (mm)"]) || 0,   // for the .xer "Length Km" UDF
        areaSqm: U.toNum(p["Area (sqm)"]) || 0,      // for the .xer "Area SqMtr" UDF
        name: p["name"] || null,
        seg: p["__seg"] || null,   // [[lngA,latA],[lngB,latB]] boundary segment (Map view)
        mid: p["__mid"] || null,   // [lng,lat] segment midpoint (marker)
        sortKey: U.chainageSortKey(id)
      });
    });
    if (!features.length) throw new Error("No usable chainages (need " + reqProps.join(", ") + ").");

    const priorities = Array.from(new Set(features.map((f) => f.priority).filter(Boolean)))
      .sort((a, b) => U.priorityOrder(a) - U.priorityOrder(b) || a.localeCompare(b));
    const priorityCounts = {};
    features.forEach((f) => { priorityCounts[f.priority] = (priorityCounts[f.priority] || 0) + 1; });
    const profiles = Array.from(new Set(features.map((f) => f.profile).filter(Boolean)));

    return { features, priorities, priorityCounts, profiles };
  };

  // Two most-distant vertices of a footprint ring ≈ its boundary-segment end-points.
  function segFromGeometry(geom) {
    if (!geom || !geom.coordinates) return null;
    let ring = null;
    if (geom.type === "Polygon") ring = geom.coordinates[0];
    else if (geom.type === "MultiPolygon") ring = geom.coordinates[0] && geom.coordinates[0][0];
    else if (geom.type === "LineString") ring = geom.coordinates;
    if (!ring || ring.length < 2) return null;
    const pts = ring.length > 200 ? ring.slice(0, 200) : ring;
    let best = -1, a = pts[0], b = pts[pts.length - 1];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1], d = dx * dx + dy * dy;
      if (d > best) { best = d; a = pts[i]; b = pts[j]; }
    }
    return [[a[0], a[1]], [b[0], b[1]]];
  }
  // Attach a boundary segment + its midpoint to a chainage property object.
  function attachSeg(p, seg) {
    if (seg) { p.__seg = seg; p.__mid = [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2]; }
    return p;
  }

  // GeoJSON upload path — kept so the frozen dataset can be regenerated if needed.
  D.parseChainage = function (text) {
    let gj;
    try { gj = JSON.parse(text); } catch (e) { throw new Error("Not valid JSON."); }
    if (!gj || gj.type !== "FeatureCollection" || !Array.isArray(gj.features))
      throw new Error("Expected a GeoJSON FeatureCollection with a 'features' array.");
    return D.buildChainageModel(gj.features.map((f) => {
      if (!f || !f.properties) return null;
      return attachSeg(f.properties, f.geometry ? segFromGeometry(f.geometry) : null);
    }));
  };

  // FROZEN dataset loader — expands the compact rows + geo hardcoded in chainage_data.js.
  // This is the only chainage source the app uses at runtime (no upload, read-only).
  D.loadHardcodedChainage = function () {
    const raw = window.SPP_CHAINAGE_DATA;
    if (!raw || !raw.fields || !raw.rows) throw new Error("Frozen chainage data (js/chainage_data.js) not found.");
    const fields = raw.fields, geo = raw.geo || [];
    const props = raw.rows.map((row, idx) => {
      const o = {};
      for (let i = 0; i < fields.length; i++) o[fields[i]] = row[i];
      const g = geo[idx];
      if (g && g.length === 4) attachSeg(o, [[g[0], g[1]], [g[2], g[3]]]);
      return o;
    });
    return D.buildChainageModel(props);
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

  // Tolerant (case/space-insensitive) worksheet lookup.
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

    // Read a dated shift series (Shift Date + the given value column).
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
  // Index a dated series by ISO date -> value.
  function mapByISO(records) { const m = {}; records.forEach((r) => { m[U.fmtISO(r.date)] = r.val; }); return m; }

  /* =====================================================================
     3.3  Material logistics
     ===================================================================== */
  /* The material file carries a two-row header: row 1 has the top-level column
     names ("Actual Arrived Quantity" spans two sub-columns) and row 2 the
     sub-headers ("Accepted at site" / "Damaged"). readSheet() keys off row 1,
     so "Actual Arrived Quantity" IS the accepted-at-site column, and Damaged is
     the (unlabelled) column immediately to its right. The sub-header row has no
     Item Code, so it is skipped by the empty-code guard below.

     Availability is driven by Status:
       • "Delivered"     -> material is on site NOW. Usable = "Accepted at site"
                            (damaged qty excluded). When that cell is blank we
                            fall back to the ordered "Quantity" (data often
                            arrives before the accepted qty is recorded).
       • anything else   -> still awaited; treated as inbound. We expect the
                            ordered "Quantity" to land on the Expected Arrival
                            date (usable on arrival + 1 day, keeping the buffer).
  */
  function parseMaterial(wb) {
    const ws = getSheet(wb, "Planner tool Input") || getSheet(wb, "Material Logistics");
    if (!ws) throw new Error("Need sheet 'Planner tool Input'.");
    const sh = readSheet(ws);
    const [cCode, cName, cQty, cExpArr, cActArr, cAccepted] =
      requireCols(sh, ["Item Code", "Item Name", "Quantity", "Expected Arrival", "Actual Arrived Date", "Actual Arrived Quantity"], "Planner tool Input");
    const cStatus = sh.col[norm("Status")];

    const byCode = {};
    let maxReceipt = null;
    let onsiteRows = 0, inboundRows = 0, inboundNoDate = 0;

    sh.rows.forEach((r) => {
      const code = r[cCode] == null ? "" : String(r[cCode]).trim();
      if (!code) return;
      const qty = U.toNum(r[cQty]) || 0;
      const status = cStatus == null ? "" : norm(r[cStatus]);
      const rec = byCode[code] || (byCode[code] = { code, name: r[cName] || code, onsite: 0, inbound: [] });
      if (r[cName] && rec.name === code) rec.name = r[cName];

      if (status === "delivered") {
        // On site now. Usable = accepted-at-site; blank cell -> ordered Quantity.
        const accCell = r[cAccepted];
        const usable = (accCell == null || accCell === "") ? qty : (U.toNum(accCell) || 0);
        rec.onsite += usable; onsiteRows++;
        const arrived = U.coerceDate(r[cActArr]);
        if (arrived && (!maxReceipt || arrived > maxReceipt)) maxReceipt = arrived;
      } else {
        // Still awaited -> inbound. Expect ordered Quantity on Expected Arrival.
        const arrival = U.coerceDate(r[cExpArr]);
        if (!arrival) { inboundNoDate++; return; }   // can't place on the calendar
        rec.inbound.push({ arrival, usable: U.addDays(arrival, 1), qty });
        inboundRows++;
      }
    });
    Object.values(byCode).forEach((c) => c.inbound.sort((a, b) => U.cmpDate(a.usable, b.usable)));

    return { byCode, maxReceipt, onsiteRows, inboundRows, inboundNoDate };
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
    const cReset = sh.col[norm("Reset")];

    const installedByDate = {};       // ISO -> piles installed that day (current rows only)
    const installedByChainage = {};   // chainage Name -> total piles already installed
    const lastInstallByChainage = {}; // chainage Name -> latest install date (for the work front)
    let maxDate = null;
    let installedRowCount = 0;

    sh.rows.forEach((r) => {
      const sub = r[cSub];
      const d = U.coerceDate(r[cDate]);
      if (sub == null || !d) return;        // §3.4: skip trailing null row
      if (d && (!maxDate || d > maxDate)) maxDate = d;
      if (String(sub).trim() === "Sheet Pile Installed") {
        // The file keeps superseded historical duplicates flagged Reset = TRUE
        // (from a "clear_history" reset). Only the current (Reset = FALSE) rows are
        // authoritative — they sum exactly to a chainage's MTO when complete.
        if (cReset != null && String(r[cReset]).trim().toLowerCase() === "true") return;
        const v = U.toNum(r[cVal]) || 0;
        const iso = U.fmtISO(d);
        installedByDate[iso] = (installedByDate[iso] || 0) + v;
        installedRowCount++;
        const nm = (cName != null && r[cName] != null) ? String(r[cName]).trim() : "";
        if (nm) {
          installedByChainage[nm] = (installedByChainage[nm] || 0) + v;
          if (!lastInstallByChainage[nm] || d > lastInstallByChainage[nm]) lastInstallByChainage[nm] = d;
        }
      }
    });
    return { installedByDate, installedByChainage, lastInstallByChainage, maxDate, installedRowCount };
  }

  // Derive a ramp-up profile from the recent productivity window (fallback if sparse).
  // `edgeSample` = how many days at each end of the window are averaged for the
  // first-vs-last trend check — scaled with window length (3 of 7 days is a
  // meaningful slice; 3 of 30 would be too thin, so a 30-day window samples more).
  function deriveAdaptiveRamp(windowDays, mp, pr, edgeSample) {
    const edge = edgeSample || 3;
    const fallbackProfile = [0.45, 0.58, 0.70, 0.80, 0.88, 0.94, 0.98, 1.00];
    const daily = [];
    windowDays.forEach((d) => {
      const iso = U.fmtISO(d);
      const machines = mp.machineMap[iso] || 0;
      const hours = mp.hourMap[iso] || 0;
      const machineHours = machines * hours;
      const piles = pr.installedByDate[iso] || 0;
      if (machineHours > 0) daily.push({ date: d, productivity: piles / machineHours, piles, machineHours });
    });

    if (!daily.length) {
      return { profile: fallbackProfile.slice(), rampN: 7, source: "fallback", explanation: "No positive machine-hours in the recent window; using the standard default ramp." };
    }

    const sorted = daily.map((x) => x.productivity).sort((a, b) => a - b);
    const median = sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const firstN = daily.slice(0, Math.min(edge, daily.length)).map((x) => x.productivity);
    const lastN = daily.slice(-Math.min(edge, daily.length)).map((x) => x.productivity);
    const avgFirstN = firstN.length ? firstN.reduce((s, x) => s + x, 0) / firstN.length : median;
    const avgLastN_ = lastN.length ? lastN.reduce((s, x) => s + x, 0) / lastN.length : median;
    const trend = avgFirstN > 0 ? (avgLastN_ - avgFirstN) / avgFirstN : 0;

    const target = Math.max(median, Math.min(avgLastN_, median * 1.25));
    const initialFactor = U.clamp(avgFirstN / Math.max(target, 1e-6), 0.35, 0.7);
    const hasClearRamp = daily.length >= 4 && trend > 0.1;
    const rampDays = hasClearRamp ? Math.min(7, Math.max(4, 4 + Math.round(Math.min(2, trend * 10)))) : 4;

    const profile = [];
    for (let i = 0; i < rampDays; i++) {
      const t = rampDays <= 1 ? 1 : i / (rampDays - 1);
      profile.push(U.round(initialFactor + (1 - initialFactor) * t, 2));
    }
    if (profile.length && profile[profile.length - 1] < 1) profile[profile.length - 1] = 1.0;
    if (profile.length > 1) profile[0] = Math.max(0.35, Math.min(profile[0], 0.7));
    for (let i = 1; i < profile.length; i++) profile[i] = Math.max(profile[i], profile[i - 1]);

    return {
      profile,
      rampN: Math.max(0, profile.length - 1),
      source: "adaptive",
      explanation: "Derived from the recent " + windowDays.length + "-day productivity window using a conservative median-based peak and a mild trend check."
    };
  }

  /* =====================================================================
     4.  Defaults (the "last 7 days" methodology)
     ===================================================================== */
  // Impute a missing shift entry from the recent norm: the average of the last N
  // available data points (dates present in `srcMap`) on/before `iso`.
  function avgLastN(srcMap, iso, n) {
    const ds = Object.keys(srcMap).filter((k) => k <= iso).sort();  // ISO dates sort chronologically
    const last = ds.slice(-n);
    if (!last.length) return null;
    return last.reduce((s, k) => s + (srcMap[k] || 0), 0) / last.length;
  }

  D.computeDefaults = function (store) {
    const mp = store.manpower, mat = store.material, pr = store.progress;
    if (!mp.latestShift) throw new Error("No shift dates found in manpower file.");
    // Anchor = max(latest Machine Status date, latest Sheet-Pile-Installed date)
    // — so a day with piles logged but no machine-status entry yet (progress
    // recorded a day after the last shift update) still falls inside the
    // 7-day/30-day windows below. That day's machine-hours get imputed the
    // same way any other gap day already is (§ below); piles themselves are
    // never imputed — installedByDate is read as-is.
    const pileISO = Object.keys(pr.installedByDate || {}).sort();
    const lastPileDate = pileISO.length ? U.parseISODate(pileISO[pileISO.length - 1]) : null;
    const anchor = (lastPileDate && lastPileDate > mp.latestShift) ? lastPileDate : mp.latestShift;

    /* Human-input-error correction: on a day where piles WERE installed but the shift
       record (machines / manpower / manhours) is missing, treat it as a forgotten
       entry rather than a real zero. Fill each series from the average of the last 15
       available data points on/before that day, so the baseline reflects reality. */
    const machineMap = Object.assign({}, mp.machineMap);
    const manpowerMap = Object.assign({}, mp.manpowerMap);
    const hourMap = Object.assign({}, mp.hourMap);
    const imputedDays = [];
    Object.keys(pr.installedByDate || {}).forEach((iso) => {
      if ((pr.installedByDate[iso] || 0) > 0 && !mp.machineMap[iso]) {   // installs but no machine entry
        const im = avgLastN(mp.machineMap, iso, 15);
        const ip = avgLastN(mp.manpowerMap, iso, 15);
        const ih = avgLastN(mp.hourMap, iso, 15);
        if (im != null) machineMap[iso] = im;
        if (ip != null) manpowerMap[iso] = ip;
        if (ih != null) hourMap[iso] = ih;
        if (im != null || ip != null || ih != null) imputedDays.push(iso);
      }
    });
    // Imputed-series view of the manpower model, used for every average/ramp below.
    const mpI = Object.assign({}, mp, { machineMap, manpowerMap, hourMap });

    // 7-day window = anchor and the 6 prior calendar days.
    const windowEnd = anchor;
    const windowStart = U.addDays(anchor, -6);
    const windowDays = [];
    for (let i = 0; i < 7; i++) windowDays.push(U.addDays(windowStart, i));

    let sumMachine = 0, sumMan = 0, sumHour = 0, machineHours = 0, pilesWindow = 0;
    windowDays.forEach((d) => {
      const iso = U.fmtISO(d);
      const m = machineMap[iso] || 0;
      const h = hourMap[iso] || 0;
      sumMachine += m;
      sumMan += (manpowerMap[iso] || 0);
      sumHour += h;
      machineHours += m * h;                 // Σ daily machines × workhours
      pilesWindow += (pr.installedByDate[iso] || 0);
    });

    const machines = Math.round(sumMachine / 7);
    const manpower = Math.round(sumMan / 7);
    const workhours = Math.round(sumHour / 7);
    const productivity = machineHours > 0 ? U.round(pilesWindow / machineHours, 3) : 0;
    const ramp = deriveAdaptiveRamp(windowDays, mpI, pr);

    // Alternate 30-day productivity basis (Installation Planner's Productivity field
    // can be switched to this instead of the 7-day figure above). Machines/manpower/
    // workhours always stay on the 7-day window, but the ramp-up curve gets its own
    // 30-day-derived variant too, so it stays consistent with whichever productivity
    // figure is currently shown instead of silently mixing two different time bases.
    const window30Start = U.addDays(anchor, -29);
    const window30Days = [];
    for (let i = 0; i < 30; i++) window30Days.push(U.addDays(window30Start, i));
    let machineHours30 = 0, pilesWindow30 = 0;
    window30Days.forEach((d) => {
      const iso = U.fmtISO(d);
      const m = machineMap[iso] || 0;
      const h = hourMap[iso] || 0;
      machineHours30 += m * h;
      pilesWindow30 += (pr.installedByDate[iso] || 0);
    });
    const productivity30 = machineHours30 > 0 ? U.round(pilesWindow30 / machineHours30, 3) : 0;
    const prodDerivation30 = pilesWindow30 + " piles ÷ " + U.fmtNum(machineHours30, 0) + " machine-hours = " + U.fmtNum(productivity30, 3);
    const ramp30 = deriveAdaptiveRamp(window30Days, mpI, pr, 7);   // wider edge sample for a 30-day span

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
      productivity30, prodDerivation30,
      latestDataDate, planStartDefault, imputedDays,
      rampProfile: ramp.profile,
      rampN: ramp.rampN,
      rampSource: ramp.source,
      rampExplanation: ramp.explanation,
      rampProfile30: ramp30.profile,
      rampN30: ramp30.rampN,
      rampSource30: ramp30.source,
      rampExplanation30: ramp30.explanation,
      prodDerivation:
        pilesWindow + " piles ÷ " + U.fmtNum(machineHours, 0) + " machine-hours = " + U.fmtNum(productivity, 3) +
        (imputedDays.length ? " (shift data imputed for " + imputedDays.length + " day(s) with installs but no machine/manpower entry, using the last-15-point average)" : "")
    };
  };
})();
