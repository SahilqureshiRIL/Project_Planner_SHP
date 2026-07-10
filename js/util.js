/* =============================================================================
   util.js — date handling, number/text formatting, small DOM helpers.
   Everything hangs off a single global namespace `SPP` so the plain <script>
   tags don't need a build step or modules (works over file://).
   ============================================================================= */
(function () {
  "use strict";
  const SPP = (window.SPP = window.SPP || {});
  const U = (SPP.util = {});

  /* ---------------------------------------------------------------- dates --- */
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const WEEKDAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const MONTH_IDX = MONTHS.reduce((m, n, i) => ((m[n.toLowerCase()] = i), m), {});

  // Build a date at LOCAL midnight from y/m/d (month is 1-based here).
  U.ymd = function (y, m, d) { return new Date(y, m - 1, d); };

  // Parse "12-Jun-2026" (DD-Mon-YYYY).
  U.parseDMY = function (s) {
    const m = String(s).trim().match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/);
    if (!m) return null;
    const mon = MONTH_IDX[m[2].slice(0, 3).toLowerCase()];
    if (mon == null) return null;
    return new Date(+m[3], mon, +m[1]);
  };

  // Parse "2026-06-12" (ISO date) at LOCAL midnight (avoids UTC shift).
  U.parseISODate = function (s) {
    const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  };

  // Excel serial number -> local-midnight Date (date-only). Excel epoch 1899-12-30.
  U.excelSerialToDate = function (serial) {
    const days = Math.floor(serial - 25569); // days since 1970-01-01
    const utc = new Date(days * 86400000);   // UTC midnight of that day
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
  };

  // Universal coercion: Date | Excel-serial number | "YYYY-MM-DD" | "DD-Mon-YYYY".
  U.coerceDate = function (v) {
    if (v == null || v === "") return null;
    if (v instanceof Date && !isNaN(v)) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
    if (typeof v === "number" && isFinite(v)) return U.excelSerialToDate(v);
    if (typeof v === "string") {
      return U.parseISODate(v) || U.parseDMY(v) || (function () {
        const t = Date.parse(v);
        return isNaN(t) ? null : (function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); })(new Date(t));
      })();
    }
    return null;
  };

  U.addDays = function (d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  U.cmpDate = function (a, b) { return a.getTime() - b.getTime(); };
  U.sameDay = function (a, b) { return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
  U.diffDays = function (a, b) { return Math.round((U.dayStart(b) - U.dayStart(a)) / 86400000); };
  U.dayStart = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

  // Monday=1 ... Sunday=7  (ISO-ish ordinal for "work day of week" maths)
  U.isoDow = function (d) { const g = d.getDay(); return g === 0 ? 7 : g; };
  U.isMonday = function (d) { return d.getDay() === 1; };

  // First Monday strictly AFTER the given date.
  U.firstMondayAfter = function (d) {
    let x = U.addDays(d, 1);
    while (x.getDay() !== 1) x = U.addDays(x, 1);
    return x;
  };

  U.fmtISO = function (d) {
    if (!d) return "";
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  };
  // "Mon, 29 Jun 2026"
  U.fmtFriendly = function (d) {
    if (!d) return "—";
    return WEEKDAYS[d.getDay()] + ", " + d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  };
  // "29 Jun" (compact, for axis)
  U.fmtShort = function (d) { return d.getDate() + " " + MONTHS[d.getMonth()]; };
  // "29 Jun 2026" (compact but with the year)
  U.fmtDate = function (d) { return d ? d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear() : "—"; };
  U.weekdayShort = function (d) { return WEEKDAYS[d.getDay()]; };

  /* -------------------------------------------------------------- numbers --- */
  U.toNum = function (v) {
    if (typeof v === "number") return v;
    if (v == null) return NaN;
    const n = parseFloat(String(v).replace(/[, ]/g, ""));
    return n;
  };
  U.round = function (n, dp) { const f = Math.pow(10, dp || 0); return Math.round(n * f) / f; };
  U.fmtInt = function (n) { return Math.round(n).toLocaleString("en-US"); };
  U.fmtNum = function (n, dp) {
    return Number(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  };
  U.clamp = function (n, lo, hi) { return Math.max(lo, Math.min(hi, n)); };

  // "32+800" -> sortable metres (32*1000 + 800). Falls back to lexical.
  U.chainageSortKey = function (id) {
    const m = String(id).match(/^(\d+)\+(\d+)/);
    if (m) return +m[1] * 100000 + +m[2];
    const n = parseFloat(id);
    return isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
  };

  // Natural priority order P-1a, P-1b, P-1c, P-2, then anything else.
  U.priorityOrder = function (p) {
    const order = { "P-1a": 0, "P-1b": 1, "P-1c": 2, "P-2": 3 };
    return p in order ? order[p] : 99;
  };

  /* ----------------------------------------------------------------- DOM --- */
  U.$ = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  U.el = function (tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") node.className = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else if (k === "dataset") for (const dk in attrs[k]) node.dataset[dk] = attrs[k][dk];
      else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) node.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => { if (c == null) return; node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return node;
  };
  U.clear = function (node) { while (node.firstChild) node.removeChild(node.firstChild); };
  U.esc = function (s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); };

  // Deterministic color for a label (stable hue from string hash).
  U.colorFor = function (label, sat, light) {
    let h = 0;
    const s = String(label);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return "hsl(" + (h % 360) + " " + (sat || 55) + "% " + (light || 45) + "%)";
  };

  let toastTimer = null;
  U.toast = function (msg, kind) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.className = "toast" + (kind ? " is-" + kind : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
  };
})();
