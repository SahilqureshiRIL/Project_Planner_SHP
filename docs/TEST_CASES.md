# Sheet Pile Installation Planner — Test Cases

> Companion to [`USE_CASES.md`](./USE_CASES.md). Each test maps to a use case (`UC-*`) and
> is written to be **checkable** — a precondition, concrete steps, and an expected result
> stated as an assertion. Data facts reflect the bundled sample (952 chainages; priorities
> `P-1a`=146, `P-1b`=117, `P-1c`=153, `P-2`=536; latest record mid-2026).
>
> **How to run**
> - **UI tests (T-*-U):** serve over http (`python -m http.server 8000`), open
>   `http://localhost:8000`, and follow the steps.
> - **Engine/logic tests (T-*-E):** run headless in Node, loading the modules against the
>   real bundled data. Skeleton at the bottom (§ *Headless harness*). These assert on the
>   objects returned by `SPP.engine.generate` / `SPP.bluesky.compute` and the parsers in
>   `SPP.data`, so they are deterministic and fast.
>
> **Severity:** 🔴 critical (correctness/data integrity) · 🟠 major (logic/feature) ·
> 🟡 minor (UI/formatting).

---

## Contents
- [A. Data loading & parsing](#a-data-loading--parsing)
- [B. Defaults computation](#b-defaults-computation)
- [C. Installation Planner — engine](#c-installation-planner--engine)
- [D. Installation Planner — UI / views](#d-installation-planner--ui--views)
- [E. XER export](#e-xer-export)
- [F. Bluesky — engine](#f-bluesky--engine)
- [G. Bluesky — UI](#g-bluesky--ui)
- [H. Cross-cutting invariants](#h-cross-cutting-invariants)
- [I. Headless harness](#i-headless-harness)

---

## A. Data loading & parsing

| ID | Sev | Precondition | Steps | Expected |
|---|---|---|---|---|
| **T-A-01-E** | 🔴 | bundled files | `parseWorkbookFile(manpower.xlsx,"manpower")` | returns `{machine, manpower, hour}` arrays; `latestShift` is a valid Date; `machineMap/manpowerMap/hourMap` keyed by ISO date. |
| **T-A-02-E** | 🔴 | bundled files | `parseWorkbookFile(material.xlsx,"material")` | `byCode` non-empty; each code has `onsite ≥ 0` and a sorted `inbound[]` (by usable date). |
| **T-A-03-E** | 🔴 | bundled files | `parseWorkbookFile(progress.xlsx,"progress")` | `installedByDate`, `installedByChainage`, `lastInstallByChainage`, `maxDate` populated; only `Reset=FALSE` + `Sub Activity="Sheet Pile Installed"` rows counted. |
| **T-A-04-E** | 🔴 | frozen data | `loadHardcodedChainage()` | 952 features; priorities exactly `[P-1a,P-1b,P-1c,P-2]`; counts `{P-1a:146,P-1b:117,P-1c:153,P-2:536}`. |
| **T-A-05-E** | 🟠 | frozen data | inspect a feature | `profile` = Item Description (falls back to `Profile Name`); `code` = New SAP Code; `mto` = No of Profiles (int ≥ 0); `seg`/`mid` present when geo exists. |
| **T-A-06-E** | 🟠 | manpower with a duplicated shift date | parse | `fixDuplicateShiftDate` shifts the **first** occurrence back one day; `fix` field records `{from,to}`; one row per day afterward. |
| **T-A-07-E** | 🟠 | material row `Status="Delivered"`, blank Accepted | parse | usable falls back to ordered `Quantity`; `Damaged` excluded. |
| **T-A-08-E** | 🟠 | material row non-Delivered, no Expected Arrival | parse | row is **skipped** (can't place on calendar); counted in `inboundNoDate`. |
| **T-A-09-E** | 🟡 | missing required column | parse | throws `Error` naming the missing column + sheet. |
| **T-A-10-E** | 🟡 | non-xlsx bytes | `parseWorkbookFile` | throws "Could not read .xlsx…". |
| **T-A-11-E** | 🟠 | material inbound row | parse | `usable === arrival + 1 day` (buffer applied). |
| **T-A-12-U** | 🟠 | opened via `file://` | load app | auto-load fails gracefully → the Data Files upload card appears; uploading all 3 unlocks the form. |
| **T-A-13-U** | 🟡 | served over http | load app | Data Files card stays hidden; form populates automatically. |

---

## B. Defaults computation (`computeDefaults`)

| ID | Sev | Precondition | Steps | Expected |
|---|---|---|---|---|
| **T-B-01-E** | 🔴 | bundled | `computeDefaults(store)` | `machines/manpower/workhours` = rounded 7-day averages anchored on `latestShift`; `productivity = pilesWindow ÷ machineHours` (3 dp). |
| **T-B-02-E** | 🔴 | bundled | check `planStartDefault` | = first **Monday after** `latestDataDate` (max of latest shift, progress maxDate, material maxReceipt — future inbound **excluded**). Always a Monday. |
| **T-B-03-E** | 🟠 | a day with installs but no machine entry | check imputation | that day's machine/manpower/hour filled from avg of last 15 available points; listed in `imputedDays`. |
| **T-B-04-E** | 🟠 | bundled | 30-day variant | `productivity30`, `rampProfile30`, `rampN30`, `rampExplanation30` present and internally consistent (30-day derived). |
| **T-B-05-E** | 🟠 | bundled | ramp profile | non-decreasing, first ∈ [0.35,0.7], last = 1.0; `rampN = profile.length−1`. |
| **T-B-06-E** | 🟡 | window with zero machine-hours | derive ramp | falls back to `[0.45..1.00]`, `source="fallback"`. |
| **T-B-07-E** | 🟡 | no shift dates | `computeDefaults` | throws "No shift dates found…". |

---

## C. Installation Planner — engine (`SPP.engine.generate`)

### C1. Candidate selection & prior-progress netting

| ID | Sev | Input | Expected |
|---|---|---|---|
| **T-C1-01-E** | 🔴 | `priorities=["P-1a"]` | `candidates.length === 146`. |
| **T-C1-02-E** | 🔴 | `priorities=["P-1a","P-1b"]` | `candidates.length === 263` (146+117). |
| **T-C1-03-E** | 🔴 | all four priorities | `candidates.length === 952`. |
| **T-C1-04-E** | 🔴 | any priority | `completed` = chainages with `remaining ≤ 0` (dropped); `active = candidates − completed`; `partial ⊆ active` has prior > 0. |
| **T-C1-05-E** | 🟠 | any | `remainingMTO = Σ max(0, mto − prior)`; `installedPriorTotal = Σ min(prior, mto)`. |
| **T-C1-06-E** | 🟠 | chainage with no `code` or zero total material | that chainage is in `blocked`, not `workable`; `blockedMTO` counts its remaining. |

### C2. Manpower cap & cost-optimization

| ID | Sev | Input | Expected |
|---|---|---|---|
| **T-C2-01-E** | 🔴 | `machinesInput=10, manpower=36` | `cap = 6`, `maxMachines = 6`, `capApplied = true`; a `cap` warning present. |
| **T-C2-02-E** | 🔴 | `manpower=5` | `cap = 0`, `maxMachines = 0`, no installs; a `noManpower` **bad** warning. |
| **T-C2-03-E** | 🔴 | `machinesInput=4, manpower=36` (default) | `deployed ≤ maxMachines`; `deployed` = fewest machines achieving `maxInstalled` (cost-optimizer). |
| **T-C2-04-E** | 🟠 | over-provisioned (machines ≫ needed) | `idleMachines = maxMachines − deployed > 0`; an `idle` warning recommends `deployed`. |
| **T-C2-05-E** | 🟠 | exactly-needed machines | `idleMachines = 0`; no `idle` warning. |

### C3. Multi-priority scheduling & no-idle spillover (the fix)

| ID | Sev | Input | Expected |
|---|---|---|---|
| **T-C3-01-E** | 🔴 | `["P-1a","P-1b"]`, default machines (capacity-limited window) | queue works `P-1a` first; because P-1a alone saturates the window, output may be all P-1a — **acceptable** (strict priority). Assert: `worked` ⊆ selected priorities; ordering respects `priorityOrder`. |
| **T-C3-02-E** | 🔴 | `["P-1a","P-1b"]`, **high** machines (P-1a material-starves mid-window) | `worked` spans **both** priorities; total installed > single-P-1a total; a machine that starves on P-1a picks up P-1b the same window. *(Sample: M=30 ⇒ ~39 P-1a + ~14 P-1b.)* |
| **T-C3-03-E** | 🔴 | any single priority whose chainages starve while siblings have stock | no machine emits repeated `waiting` rows while another in-scope chainage has material; starved machine is released & reassigned. *(Sample regression: single `P-1b` M=4 installs more than the pre-fix 860 because 18 wasted "waiting" machine-days are eliminated.)* |
| **T-C3-04-E** | 🟠 | starved chainage, material arrives later in window | the chainage **resumes** on/after the material's usable date (returned to the pool, not dropped). |
| **T-C3-05-E** | 🔴 | any | on any single day, **no chainage is assigned to two machines** (schedule has ≤1 row per `date#machine`). |
| **T-C3-06-E** | 🟠 | `["P-2"]` and `["P-1a"]` default | single-priority outputs are **unchanged vs pre-fix** for capacity-limited priorities (P-1a: 15 worked / 1719 installed; P-2: 14 / 1704). |

### C4. Working calendar & hindrances

| ID | Sev | Input | Expected |
|---|---|---|---|
| **T-C4-01-E** | 🔴 | `periodWeeks=2, workDaysPerWeek=6` | calendar = 14 days; working = Mon–Sat (12); Sun non-working ("Weekly off"). |
| **T-C4-02-E** | 🔴 | `workDaysPerWeek=5` / `7` | 5 ⇒ Mon–Fri working; 7 ⇒ all days working. |
| **T-C4-03-E** | 🔴 | hindrance `unit="days"`, 2 days selected | those working days → non-working ("Hindrance — day lost"); `lostDays.length===2`; `hindranceDays` warning. |
| **T-C4-04-E** | 🟠 | hindrance `unit="hours"`, amount=4, 1 day selected | that day's hours −4 (partial) or lost if hits 0; `hindHours` accrues; `hindranceHours` warning. |
| **T-C4-05-E** | 🟠 | hindrance `days`, **no** day selected, amount=2 | earliest 2 working days lost (fallback). |
| **T-C4-06-E** | 🟠 | hindrance day = a weekly-off day | no effect (only working days are lost/trimmed). |
| **T-C4-07-E** | 🟡 | material arrival on a hindrance/off day | stock still increments on that date. |

### C5. Material accounting invariants

| ID | Sev | Input | Expected |
|---|---|---|---|
| **T-C5-01-E** | 🔴 | any | for every schedule row, `install ≤ capacity + EPS`, `install ≤ remaining + EPS`, `install ≤ stock-before + EPS`. |
| **T-C5-02-E** | 🔴 | any | per code: `Σ install ≤ startStock + Σ in-window inbound + EPS` (never installs material it doesn't have). |
| **T-C5-03-E** | 🟠 | overdue on-hold inbound (arrival < planStart, not delivered) | excluded from `startStock` and replenishments. |
| **T-C5-04-E** | 🟠 | inbound arriving inside window | appears in `windowArrivals`; usable = arrival+1; rolls into Available the next day in the pivot. |
| **T-C5-05-E** | 🔴 | material pivot | for each row/day: `available = netOnsite + received-usable-by-today − consumed-before-today`; never negative after a valid plan. |
| **T-C5-06-E** | 🟠 | started chainage exceeds its window material | a `shortfall` warning lists the profile(s) and total shortfall piles. |

### C6. Forecasts & feasibility

| ID | Sev | Input | Expected |
|---|---|---|---|
| **T-C6-01-E** | 🔴 | scope fits window | `pctComplete = (installedPrior + installedThisWindow) / totalMTO × 100`; `carryOver = max(0, totalMTO − totalComplete)`. |
| **T-C6-02-E** | 🟠 | nothing blocked | `projectedFinish` set; `finishCoversAll = true`; `unachievablePiles = 0`. |
| **T-C6-03-E** | 🟠 | some blocked / material-short | `finishCoversAll = false`; `unachievablePiles > 0` (= blocked + never-arriving). |
| **T-C6-04-E** | 🟠 | scope beyond 2-yr horizon | `projTimeLimited = true`. |
| **T-C6-05-E** | 🟠 | `deployed>0`, capacity>0 | `fullMaterialFinish` = `planStart` + `ceil(remainingMTO/effectiveDailyCapacity)` working days (rate-only). |
| **T-C6-06-E** | 🟡 | any | `effectiveDailyCapacity = productivity × workhours × deployed`. |

### C7. Warnings & suppression

| ID | Sev | Input | Expected |
|---|---|---|---|
| **T-C7-01-E** | 🟠 | clean plan | single `ok` warning ("No blocking issues detected"). |
| **T-C7-02-E** | 🟠 | `suppressCodes=["carryOver"]` | carry-over warning removed from the list. |
| **T-C7-03-E** | 🟠 | each trigger (e.g. P-1a+1b+1c, 10 machines, prod 6, 7 work-days ⇒ over-provisioned + blocked + carry-over) | correct `code` emitted: `noManpower/cap/blocked/shortfall/hindranceDays/hindranceHours/idle/idleDays/carryOver`. Note the `idle` warning only fires when capacity outruns material (high prod/work-days); at the low default productivity all 10 machines are needed, so `idle` is absent — that is correct. |

---

## D. Installation Planner — UI / views

| ID | Sev | Steps | Expected |
|---|---|---|---|
| **T-D-01-U** | 🟠 | select 0 priorities → Process | toast "Choose at least one chainage priority"; menu opens; no plan. |
| **T-D-02-U** | 🟠 | set plan start to a non-Monday | field snaps back to that week's Monday with a toast. |
| **T-D-03-U** | 🟠 | machines=0 / manpower=0 / workhours=0 / productivity=0 | each blocked with its specific toast; no plan. |
| **T-D-04-U** | 🟡 | edit a computed field | turns from greyed ("is-computed") to solid ("is-edited"); hint shows "auto was …". |
| **T-D-05-U** | 🟠 | multi-select priorities → Process | `#planMeta` and summary list **all** selected priorities (comma-joined). |
| **T-D-06-U** | 🟠 | toggle Productivity 7↔30 | productivity value **and** ramp curve/profile switch together; hint text updates. |
| **T-D-07-U** | 🟠 | Process with warnings | modal lists all non-OK warnings; Proceed renders plan; Abort returns to form. |
| **T-D-08-U** | 🟠 | Gantt view | one bar per scheduled chainage on its machine lane; color-by-profile/machine toggles recolor + relegend; hover tooltip. |
| **T-D-09-U** | 🟠 | Material view | Available/Inbound/Used columns per day; balance never shows an install exceeding Available. |
| **T-D-10-U** | 🟠 | Table view, switch Group by | date/chainage/machine regroup without re-planning; per-day whole piles sum to totals. |
| **T-D-11-U** | 🟠 | Map view | boundary segments drawn; selected priority colored by status; legend multi-select filters; zoom/pan/hover/click work; WebGL→SVG fallback if no WebGL. |
| **T-D-12-U** | 🟠 | Validation → "View blocked on map" | Map opens with the blocked filter applied. |
| **T-D-13-U** | 🟡 | Recent progress Week/Month + ‹ › | aggregation + paging update the chart & subtitle. |
| **T-D-14-U** | 🟡 | Process | input panel collapses; page scrolls to top; "Show inputs" toggle appears. |
| **T-D-15-U** | 🟡 | cap notice | editing machines above `floor(manpower/6)` shows the live cap notice. |

---

## E. XER export (`SPP.xer.build`)

| ID | Sev | Steps | Expected |
|---|---|---|---|
| **T-E-01-E** | 🔴 | build from a plan with scheduled chainages | returns a string starting with `ERMHDR`; contains `%T PROJECT`, `%T PROJWBS`, `%T TASK`, `%T TASKRSRC`, `%T TASKPRED`, `%T UDFVALUE`; ends with `%E`. |
| **T-E-02-E** | 🟠 | inspect TASKs | one TASK per scheduled chainage; WBS = Root→Priority→Zone→Profile. |
| **T-E-03-E** | 🟠 | inspect resources | one equipment resource per deployed machine + one labour crew; assigned with `target_qty` = piles this window. |
| **T-E-04-E** | 🟠 | inspect UDFs | Quantity Nos, Pile Type, Length Km, Area SqMtr, Notes present. |
| **T-E-05-E** | 🟠 | numeric fields | fields in `NUM` maps are populated (never blank) so strict P6 parsers accept it; `parent_wbs_id` empty on the root node. |
| **T-E-06-E** | 🟡 | line endings/encoding | CRLF line breaks, ASCII, no BOM. |
| **T-E-07-U** | 🟠 | Export with **no** scheduled chainages | toast "No scheduled chainages…"; no download. |
| **T-E-08-U** | 🟡 | Export a valid plan | downloads `SHP_<priorities>_<startISO>.xer`; filename sanitized. |

---

## F. Bluesky — engine (`SPP.bluesky.compute`)

### F1. Crew back-calculation

| ID | Sev | Input | Expected |
|---|---|---|---|
| **T-F1-01-E** | 🔴 | target well after start, `["P-1a"]`, prod>0 | `machinesNeeded` = smallest M with `capacityOverDays(M, workingDays) ≥ remainingPiles`; `manpower = M×6`. |
| **T-F1-02-E** | 🔴 | `prevMachines=0` (all ramp) vs `prevMachines=M` (all steady) | steady case never needs **more** machines than the ramp case for the same target. |
| **T-F1-03-E** | 🔴 | `targetDate < planStart` (e.g. planStart−1) → no working days | `workingDays = 0`; `machinesNeeded = Infinity`; verdict **bad** "not after plan start". *(Edge: `targetDate == planStart`, a Monday, yields **1** working day — finite but a very large crew, not Infinity.)* |
| **T-F1-04-E** | 🔴 | `productivity=0` or `workhours=0` | `machinesNeeded = Infinity`; verdict **bad** "cannot compute". |
| **T-F1-05-E** | 🟠 | selected priorities already complete | `remainingPiles=0`; `machinesNeeded=0`; verdict **ok** "nothing to plan"; `completionDate=planStart`. |
| **T-F1-06-E** | 🟠 | `workingDays` count | counts only days with `isoDow ≤ workDaysPerWeek` from planStart..target inclusive. |
| **T-F1-07-E** | 🟠 | very tight target (1 working day, huge scope) | `machinesNeeded` large but finite (≤ flatGuess+200), or Infinity only when window/rate makes it impossible. |

### F2. Material demand / supply / gap

| ID | Sev | Input | Expected |
|---|---|---|---|
| **T-F2-01-E** | 🔴 | any | one `profileRows` entry per (priority, code) with `atSite + inTransitByTarget + gap === demand` (allocation conserves demand). |
| **T-F2-02-E** | 🔴 | code shared by P-1a & P-1b | shared pool allocated **highest priority first**; per-row `atSite`/`inTransit` sum back to code totals. |
| **T-F2-03-E** | 🟠 | overdue pre-window inbound | not counted in `atSite`/`inTransit`. |
| **T-F2-04-E** | 🟠 | inbound usable after target | counted as `inTransitLater`, not `supplyByTarget`. |
| **T-F2-05-E** | 🟠 | a profile starves mid-run | its row's `haltsOn` = first starved working day. |
| **T-F2-06-E** | 🟠 | whole crew starved a day | `haltDate` set to that day; `completionDate` set when scope finishes (may be after target). |
| **T-F2-07-E** | 🔴 | any | `gapTotal = Σ profileRows.gap`; `materialShort = max(0, remainingPiles − installedTotal)`. |

### F3. Probability of success

| ID | Sev | Input | Expected |
|---|---|---|---|
| **T-F3-01-E** | 🔴 | any | `percent` ∈ [2,98]; = round(100 × geomean of factors with weights {mac:.47,prod:.40,cons:.13}). |
| **T-F3-02-E** | 🟠 | `machinesNeeded = baseCap` | `S_mac = 1`. As needed exceeds baseCap, `S_mac = exp(−0.55·(x−1))` decreases. |
| **T-F3-03-E** | 🟠 | input productivity = actual | `S_prod = 1`; input > actual ⇒ `S_prod < 1`; input < actual ⇒ saturates at 1. |
| **T-F3-04-E** | 🟠 | `actualProductivity = 0` | `S_prod = 0.6` (neutral). |
| **T-F3-05-E** | 🟠 | < 3 daily-install samples | `S_cons = 0.7` (neutral). |
| **T-F3-06-E** | 🟠 | steady daily installs (low CV) | `S_cons` near 1; erratic (high CV) ⇒ toward 0.4 floor. |
| **T-F3-07-E** | 🟠 | `machinesNeeded = Infinity` | `S_mac = 0.001`; percent near floor. |

### F4. Verdict & schedule

| ID | Sev | Input | Expected |
|---|---|---|---|
| **T-F4-01-E** | 🟠 | `gapTotal > 0` | verdict **warn**, mentions shortage + halt/finish dates. |
| **T-F4-02-E** | 🟠 | feasible, no gap | verdict **ok** "deploy N machines…". |
| **T-F4-03-E** | 🟠 | schedule (unlimited material) | one chainage per machine per day; priority then Chainage_Id order; ramp on new machines; `scheduleWorked` = distinct chainages; `scheduleFinish` = last date. |
| **T-F4-04-E** | 🔴 | schedule | no chainage assigned to two machines on the same day. |

---

## G. Bluesky — UI

| ID | Sev | Steps | Expected |
|---|---|---|---|
| **T-G-01-U** | 🟠 | no priorities → Process | toast "Select at least one priority"; no run. |
| **T-G-02-U** | 🟠 | no target date | toast "Pick a target date". |
| **T-G-03-U** | 🟠 | workhours ≤ 0 / productivity ≤ 0 | respective toasts; no run. |
| **T-G-04-U** | 🟡 | open Bluesky | plan start hint = next Monday on/after today; target/workhours/productivity prefilled from defaults; priority picker shows per-priority remaining scope. |
| **T-G-05-U** | 🟠 | Process a feasible target | KPI grid + verdict render; both tabs populate; "Priority & Material-wise Check" active first. |
| **T-G-06-U** | 🟠 | switch to "Chainage-wise & Machine-wise Plan" tab | schedule table renders; Group by date/chainage/machine works. |
| **T-G-07-U** | 🟡 | material-wise table | At site / In transit / Required / Gap / Work halts columns; badge shows Shortage vs Covered. |
| **T-G-08-U** | 🟡 | Process | ~5s checklist loader plays, then results; panel collapses; scroll to top. |
| **T-G-09-U** | 🟡 | selection persists | re-opening the module keeps a prior priority selection (populate guard). |

---

## H. Cross-cutting invariants (assert in every engine/bluesky run)

| ID | Sev | Invariant |
|---|---|---|
| **T-H-01-E** | 🔴 | **Material conservation:** installs per code ≤ available material per code (both modules). |
| **T-H-02-E** | 🔴 | **No double-booking:** ≤1 schedule row per `(date, machine)`. |
| **T-H-03-E** | 🔴 | **Priority order respected:** for the same code, higher priority is scheduled before lower. |
| **T-H-04-E** | 🟠 | **Non-negative:** installs, stock balances, gaps, machine counts, percentages ≥ 0. |
| **T-H-05-E** | 🟠 | **Reconciliation:** the two modules agree on net on-site stock, prior netting, and inbound usable-date for the same store. |
| **T-H-06-E** | 🟠 | **Determinism:** same store + same params ⇒ identical result (no reliance on Map/Set iteration order for numeric output). |
| **T-H-07-E** | 🟠 | **Rounding integrity (planner table):** per-day whole piles = Δ of the rounded running total, and sum to the plan totals. |
| **T-H-08-E** | 🟡 | **Dates:** every `planStart` is a Monday; all dates are local-midnight (no UTC drift). |

---

## I. Headless harness

The engine/logic tests (`-E`) run in Node against the real bundled data. Skeleton (extend
with assertions per the tables above). This mirrors how the multi-priority fix was verified.

```js
// docs/run_tests.js  (run: node docs/run_tests.js  from the project root)
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
```

> **Note on UI tests:** these are manual/browser checks (or automatable later with
> Playwright against `http://localhost:8000`). The `-E` set above is the authoritative,
> deterministic guardrail for the engine logic and should be run whenever `data.js`,
> `engine.js`, or `bluesky.js` change.
