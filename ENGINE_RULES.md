# Engine Rules & Constraints

All rules and constraints the deterministic planning engine (`js/engine.js`,
`SPP.engine.generate`) applies when it turns the inputs into a day-by-day plan.
Grouped by area. Section/`§` references match the comments in `engine.js`.

> Legend — **Type**: `Hard` = a real constraint the plan can never violate;
> `Assumption` = a modeling choice that is tunable/could be revised.

---

## 1. Crew & manpower

| # | Rule / Constraint | Detail | Type |
|---|---|---|---|
| 1.1 | 6 people per machine | `cap = floor(manpower ÷ 6)`. Manpower hard-limits how many machines can run. | Assumption (ratio) |
| 1.2 | Machine cap | Machines used = `min(machinesInput, cap)`. Requesting more than manpower supports is capped (→ `cap` warning). | Hard |
| 1.3 | Zero-machine guard | If `cap === 0`, nothing can be installed (→ `noManpower` warning). | Hard |
| 1.4 | Cost optimization | Simulates every machine count 1…cap and deploys the **fewest** machines that still install the maximum the window can absorb; surplus is flagged idle (→ `idle`). | Assumption |

## 2. Scope & prior progress

| # | Rule / Constraint | Detail | Type |
|---|---|---|---|
| 2.1 | Priority filter | Only chainages whose `priority` is in the selected set are in scope. | Hard |
| 2.2 | Remaining = MTO − already installed | Per chainage `remaining = max(0, mto − priorInstalled)` (prior from progress history, `Reset = FALSE` rows). | Hard |
| 2.3 | Completed drop out | Chainages with `remaining ≤ 0` are excluded; only `active` (remaining > 0) chainages are planned. | Hard |
| 2.4 | Partial-first | A chainage already started (has prior progress, still unfinished) is prioritized to be finished. | Assumption |

## 3. Material

| # | Rule / Constraint | Detail | Type |
|---|---|---|---|
| 3.1 | Net on-site stock | Usable stock = `Accepted-at-Site − already-consumed` by prior installs (per item code). | Hard |
| 3.2 | Only in-window arrivals count | Inbound material counts only if it arrives **on/after plan start**; overdue on-hold stock (past Expected Arrival, not delivered) is excluded. | Assumption |
| 3.3 | 1-day usable buffer | Delivered material becomes usable on `arrival + 1 day`. | Assumption |
| 3.4 | Install ≤ available stock | A machine can never install more of a code than is in stock that day. | Hard |
| 3.5 | Blocked chainages | A chainage with no usable material now *and* none arriving in-window can't be worked; its scope is left for a future plan. | Hard |
| 3.6 | Shared material pool | All chainages of the same item code draw from one stock pool. | Hard |

## 4. Work ordering (queue)

| # | Rule / Constraint | Detail | Type |
|---|---|---|---|
| 4.1 | Priority order first | Higher priority worked first (P-1a > P-1b > P-1c > P-2 > …). | Assumption |
| 4.2 | Then partials | Within a priority, already-started chainages before untouched ones. | Assumption |
| 4.3 | Then nearest to frontier | Untouched chainages ordered by proximity to the most-recently-worked ("frontier") chainage of that profile. | Assumption |
| 4.4 | Then Chainage_Id | Final tie-break by chainage sort key. | Assumption |
| 4.5 | Never idle while stock exists | A machine skips a no-material chainage and takes the next queued one that *does* have stock, rather than sitting idle. | Assumption |

## 5. Time & calendar

| # | Rule / Constraint | Detail | Type |
|---|---|---|---|
| 5.1 | Plan window | `periodWeeks × 7` days from plan start (2 or 3 weeks). | Hard |
| 5.2 | Plan start = Monday | Enforced in the UI; window is Monday-aligned. | Assumption |
| 5.3 | Work days / week | Only days with `ISO-weekday ≤ workDaysPerWeek` are working days; the rest are weekly-off (no install). | Hard |
| 5.4 | Daily capacity (whole piles) | Per machine per day = `ceil(productivity × workhours × ramp factor)`. Rounded **up** to whole piles because a pile can't be partially installed (e.g. `ceil(2.936 × 9) = 27`). Every install is therefore a whole number. | Hard |
| 5.5 | One chainage per machine at a time, with mid-day flow | A machine works a single chainage until it finishes (or its material runs out), **then flows the leftover budget to the next available chainage the same day** — so a chainage gets `min(daily budget, remaining scope, stock)` and any surplus moves on. A machine never wastes capacity while workable, material-backed scope exists. | Assumption |
| 5.6 | One machine per chainage per day | Two machines never work the same chainage on the same day. | Assumption |

## 6. Ramp-up

| # | Rule / Constraint | Detail | Type |
|---|---|---|---|
| 6.1 | Ramp curve | A newly introduced machine's capacity is scaled by a per-working-day multiplier (`rampProfile`), ramping to steady state. | Assumption |
| 6.2 | "New" machines only | Machines beyond `prevMachines` (carried from the last plan) ramp; existing ones run at full rate (factor = 1.0). | Assumption |
| 6.3 | Ramp is per-machine, not per-chainage | The factor follows the machine's own working-day count, unaffected by switching chainages. | Assumption |

## 7. Hindrances

| # | Rule / Constraint | Detail | Type |
|---|---|---|---|
| 7.1 | Day hindrance | Each selected day is fully lost (0 hours, no install) → `hindranceDays`. | Hard |
| 7.2 | Hour hindrance | `amount` hours trimmed from each selected day; if it hits 0, the day is lost → `hindranceHours`. | Hard |
| 7.3 | Fallback placement | A hindrance with no specific day selected falls to the earliest working day(s). | Assumption |

## 8. Feasibility / shortfall accounting

| # | Rule / Constraint | Detail | Type |
|---|---|---|---|
| 8.1 | Capacity-only ceiling | A parallel simulation with unlimited material (same crew/queue/days) gives the max installable this window. | Assumption |
| 8.2 | Material shortfall | `capacityOnly − installed` = piles lost specifically to material. | Hard (derived) |
| 8.3 | Time shortfall | `remaining − capacityOnly` = scope that wouldn't fit even with unlimited material. | Hard (derived) |
| 8.4 | Reconciliation | `materialShortfall + timeShortfall = carryOver` (always). | Hard (invariant) |
| 8.5 | Whole-piles throughout | Installs are whole piles at the source (§5.4), so the table shows the engine's per-day figures directly — no display-time rounding. Each row's "Piles (day)" is the day's install on that chainage (the daily budget, or the smaller remaining scope); "Cum." is the running total, used only to read off remaining scope. | Hard |

## 9. Forecasts (beyond the window)

| # | Rule / Constraint | Detail | Type |
|---|---|---|---|
| 9.1 | Material-aware finish | Projects the same crew forward past the window, honoring the material-arrival timeline, until all reachable scope is done (blocked scope never finishes). | Assumption |
| 9.2 | Rate-only finish | Assumes all material available; time = `remaining ÷ (productivity × workhours × machines)`, respecting work-days/week. | Assumption |
| 9.3 | ~2-year horizon cap | Projection stops at ~730 days; beyond that is reported as time-limited. | Assumption |

---

### Quick reference — the key numeric assumptions (easy to change)

| Knob | Current value | Where |
|---|---|---|
| People per machine | 6 | `cap = Math.floor(p.manpower / 6)` |
| Daily-capacity rounding | `ceil` (whole piles) | `dayCap = Math.ceil(p.productivity * factor * day.hours)` |
| Material usable buffer | arrival + 1 day | `data.js` (`usable`) |
| Ramp profile (default) | `0.45, 0.58, 0.70, 0.80, 0.88, 0.94, 0.98, 1.00` | input default; adaptive from actuals |
| Plan periods offered | 2 or 3 weeks | UI radio |
| Forecast horizon | 730 days | `HORIZON` in §9c |

_Bluesky (target-date) module (`js/bluesky.js`) reuses the same material/prior-progress
semantics but inverts the calculation (given a date → required machines/manpower); its
probability-of-success factors are documented separately in that file._
