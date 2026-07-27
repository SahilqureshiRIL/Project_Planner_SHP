const fs = require("fs");
global.window = {};
global.document = { getElementById: () => null, addEventListener: () => {} };
global.XLSX = require("../vendor/xlsx.full.min.js");
require("../js/util.js");
require("../js/chainage_data.js");
require("../js/data.js");
require("../js/engine.js");
require("../js/bluesky.js");
const SPP = global.window.SPP, U = SPP.util;

const rd = (f) => new Uint8Array(fs.readFileSync(f)).buffer;
const store = {
  chainage: SPP.data.loadHardcodedChainage(),
  manpower: SPP.data.parseWorkbookFile(rd("./data/manpower_resources.xlsx"), "manpower"),
  material: SPP.data.parseWorkbookFile(rd("./data/material_avalibility.xlsx"), "material"),
  progress: SPP.data.parseWorkbookFile(rd("./data/progress_history.xlsx"), "progress"),
};
const d = SPP.data.computeDefaults(store);

let pass = 0, fail = 0;
function check(id, cond, detail) {
  if (cond) { pass++; console.log("PASS " + id); }
  else { fail++; console.error("FAIL " + id + (detail ? " — " + detail : "")); }
}

// --- helpers ---------------------------------------------------------------
function planParams(prios, over) {
  return Object.assign({
    priorities: prios, periodWeeks: 3, planStart: d.planStartDefault,
    machinesInput: d.machines || 4, manpower: d.manpower || 36, workDaysPerWeek: 6,
    workhours: d.workhours || 9, productivity: d.productivity || 2.9,
    rampN: d.rampN, prevMachines: d.machines || 4, rampProfile: d.rampProfile, hindrances: [],
  }, over || {});
}
function workedByPriority(r) {
  const byId = {}; store.chainage.features.forEach((f) => (byId[f.id] = f.priority));
  const out = {}; r.worked.forEach((w) => (out[byId[w.id]] = (out[byId[w.id]] || 0) + 1));
  return out;
}
function noDoubleBooking(schedule) {
  const seen = new Set();
  for (const e of schedule) { const k = U.fmtISO(e.date) + "#" + e.machine; if (seen.has(k)) return false; seen.add(k); }
  return true;
}

// --- A / B ------------------------------------------------------------------
check("T-A-04-E", store.chainage.features.length === 952 &&
  JSON.stringify(store.chainage.priorities) === JSON.stringify(["P-1a","P-1b","P-1c","P-2"]));
check("T-B-02-E", U.isMonday(d.planStartDefault));

// --- C1 candidate counts ----------------------------------------------------
check("T-C1-01-E", SPP.engine.generate(store, planParams(["P-1a"])).candidates.length === 146);
check("T-C1-02-E", SPP.engine.generate(store, planParams(["P-1a","P-1b"])).candidates.length === 263);
check("T-C1-03-E", SPP.engine.generate(store, planParams(["P-1a","P-1b","P-1c","P-2"])).candidates.length === 952);

// --- C2 manpower cap --------------------------------------------------------
{ const r = SPP.engine.generate(store, planParams(["P-1a"], { machinesInput: 10, manpower: 36 }));
  check("T-C2-01-E", r.cap === 6 && r.capApplied === true); }
{ const r = SPP.engine.generate(store, planParams(["P-1a"], { manpower: 5 }));
  check("T-C2-02-E", r.cap === 0 && Math.round(r.totalInstalled) === 0 &&
    r.warnings.some((w) => w.code === "noManpower")); }

// --- C3 multi-priority spillover (the fix) ---------------------------------
{ const hi = planParams(["P-1a","P-1b"], { machinesInput: 30, manpower: 180, prevMachines: 30,
    workhours: 10, productivity: 3, rampProfile: [1] });
  const r = SPP.engine.generate(store, hi); const bp = workedByPriority(r);
  check("T-C3-02-E", (bp["P-1a"] || 0) > 0 && (bp["P-1b"] || 0) > 0, JSON.stringify(bp)); }
{ const r = SPP.engine.generate(store, planParams(["P-1a"]));
  check("T-C3-05-E", noDoubleBooking(r.schedule)); }

// --- C5 material conservation ----------------------------------------------
{ const r = SPP.engine.generate(store, planParams(["P-1a","P-1b"]));
  const perCode = {}; r.schedule.forEach((e) => (perCode[e.code] = (perCode[e.code] || 0) + e.install));
  let ok = true;
  Object.keys(perCode).forEach((c) => {
    const inWin = (store.material.byCode[c] ? store.material.byCode[c].inbound : [])
      .filter((i) => U.cmpDate(i.arrival, r.planStart) >= 0 && U.cmpDate(i.usable, r.planEnd) <= 0)
      .reduce((s, i) => s + i.qty, 0);
    if (perCode[c] > (r.startStock[c] || 0) + inWin + 1e-3) ok = false;
  });
  check("T-C5-02-E", ok); }

// --- F Bluesky --------------------------------------------------------------
function bsParams(prios, over) {
  return Object.assign({
    priorities: prios, targetDate: U.addDays(d.planStartDefault, 120), planStart: d.planStartDefault,
    workDaysPerWeek: 6, workhours: d.workhours || 9, productivity: d.productivity || 2.9,
    prevMachines: 0, rampProfile: d.rampProfile,
    baselineMachines: d.machines, baselineManpower: d.manpower, actualProductivity: d.productivity,
  }, over || {});
}
{ const r = SPP.bluesky.compute(store, bsParams(["P-1a"]));
  check("T-F1-01-E", isFinite(r.machinesNeeded) && r.manpower === r.machinesNeeded * 6); }
{ const r = SPP.bluesky.compute(store, bsParams(["P-1a"], { targetDate: U.addDays(d.planStartDefault, -1) }));
  check("T-F1-03-E", r.workingDays === 0 && !isFinite(r.machinesNeeded) && r.verdictLevel === "bad"); }
{ const r = SPP.bluesky.compute(store, bsParams(["P-1a"], { productivity: 0 }));
  check("T-F1-04-E", !isFinite(r.machinesNeeded) && r.verdictLevel === "bad"); }
{ const r = SPP.bluesky.compute(store, bsParams(["P-1a"]));
  const conserved = r.profileRows.every((x) =>
    Math.abs((x.atSite + x.inTransitByTarget + x.gap) - x.demand) < 1e-3);
  check("T-F2-01-E", conserved); }
{ const r = SPP.bluesky.compute(store, bsParams(["P-1a"]));
  check("T-F3-01-E", r.probability.percent >= 2 && r.probability.percent <= 98); }
{ const r = SPP.bluesky.compute(store, bsParams(["P-1a"]));
  check("T-F4-04-E", noDoubleBooking(r.schedule)); }

// --- H determinism ----------------------------------------------------------
{ const a = JSON.stringify(SPP.engine.generate(store, planParams(["P-1a"])).schedule.length);
  const b = JSON.stringify(SPP.engine.generate(store, planParams(["P-1a"])).schedule.length);
  check("T-H-06-E", a === b); }

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
