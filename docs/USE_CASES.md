# Sheet Pile Installation Planner — Use Cases

> Companion to [`TEST_CASES.md`](./TEST_CASES.md). This document describes **what each
> module is for and how a planner is expected to use it** (functional intent). The test
> document turns each of these into concrete, checkable cases.
>
> `§`-references point at [`../sheet_pile_planner_prompt.md`](../sheet_pile_planner_prompt.md).
> Data facts (952 chainages, priorities `P-1a/P-1b/P-1c/P-2`) reflect the bundled sample.

---

## 0. Shared context (both modules)

- **Actors:** a site/construction planner (single user, in-browser; no auth, no server).
- **Preconditions common to every use case:**
  - The app is served over `http://` so the three live files auto-load from `./data/`
    (`manpower_resources.xlsx`, `material_avalibility.xlsx`, `progress_history.xlsx`).
    Over `file://`, `fetch()` is blocked and the manual-upload fallback card appears.
  - The chainage dataset is **frozen** in `js/chainage_data.js` (no upload, no edit).
  - All three workbooks parse successfully and produce a non-empty store; defaults compute
    (`SPP.data.computeDefaults`) without throwing.
- **Data flow:** files → parse/normalize (`data.js`) → merge with frozen chainage →
  compute defaults → module engine → views. Both modules read the **same** store via the
  `SPP.app` façade, so material/progress netting is identical between them.
- **Shared material/progress semantics (must hold in both modules):**
  - Net on-site stock for an item code = `Accepted-at-Site − already-consumed`, where
    already-consumed is pooled across **all** chainages (any priority) that use the code.
  - Inbound material becomes usable on `arrival + 1 day`; **overdue on-hold** material
    (arrival before plan start, not delivered) is excluded entirely.
  - Prior progress is netted per chainage (`remaining = MTO − alreadyInstalled`);
    completed chainages drop out.

---

# PART A — INSTALLATION PLANNER (forward planner)

**Purpose:** given machines / manpower / productivity and a 2–3 week window, produce a
day-by-day installation plan for one or more selected priorities, show it as Gantt /
Material / Table / Map with a validation panel and completion forecasts, and export a
Primavera P6 `.xer`.

### UC-P-01 — Generate a baseline plan from auto-computed defaults
- **Goal:** a planner opens the module, picks a priority, and clicks *Process Plan* without
  touching any numbers.
- **Flow:** open Installation Planner → defaults populate (machines/manpower/workhours =
  last-7-day averages, productivity = adaptive, plan start = first Monday after latest
  record) → select one priority → *Process Plan*.
- **Expected:** a plan renders (Gantt default view); KPI summary shows piles planned, %
  work planned, length covered, chainages covered, carry-over; validation badge reflects
  feasibility.
- **Value:** zero-configuration "what does the current site pace get us" answer.

### UC-P-02 — Edit a computed default and re-plan
- **Goal:** override machines / manpower / workhours / productivity / plan start.
- **Flow:** edit a greyed (computed) field → it turns solid ("edited"), the hint shows the
  original auto value → *Process Plan*.
- **Expected:** the engine uses the edited value; summary/forecast update accordingly.

### UC-P-03 — Plan for multiple priorities at once (multi-select)
- **Goal:** select several priorities (e.g. `P-1a` + `P-1b`) and have the crew work them
  in priority order.
- **Flow:** open the priority pill dropdown → tick multiple → *Process Plan*.
- **Expected (per §5.2):** candidates span all selected priorities; the queue works
  **higher priority first** (`P-1a > P-1b > …`); when the top priority is **material-
  starved** and machines/material exist for a lower selected priority, the crew **spills
  into the lower priority instead of idling**. A starved-but-unfinished chainage resumes
  when its material later arrives.
- **Non-goal:** proportional/round-robin sharing — priority order is strict.

### UC-P-04 — Choose plan period (2 vs 3 weeks)
- **Goal:** compare a 2-week vs 3-week window.
- **Expected:** the working calendar length changes (`periodWeeks × 7` calendar days);
  more working days ⇒ more installable piles (up to material/queue limits); carry-over
  and forecasts adjust.

### UC-P-05 — Set work-days per week (5 / 6 / 7)
- **Goal:** model a 5-day, 6-day, or 7-day work week.
- **Expected:** days with `isoDow > workDaysPerWeek` are non-working ("Weekly off"); they
  install nothing but **material still arrives** on them.

### UC-P-06 — Switch productivity basis (last 7 days vs last 30 days)
- **Goal:** use a longer productivity window to smooth out recent noise.
- **Flow:** toggle the *Last 7 days / Last 30 days* segmented control on the Productivity
  field.
- **Expected:** productivity **and** the ramp-up curve both switch to the selected basis
  together (never a 7-day number with a 30-day ramp). Machines/manpower/workhours stay on
  the 7-day window regardless.

### UC-P-07 — Add hindrances (lost days)
- **Goal:** mark specific working days as fully lost (weather/political/other).
- **Flow:** *+ Add hindrance* → unit *days* → click the affected day(s) on the mini
  calendar.
- **Expected:** each selected working day becomes non-working ("Hindrance — day lost");
  installation shifts past them; a hindrance warning is raised. With **no** day selected,
  the earliest N working days are lost (legacy fallback).

### UC-P-08 — Add hindrances (trimmed hours)
- **Goal:** reduce available hours on specific days.
- **Flow:** *+ Add hindrance* → unit *hours* → amount → select day(s).
- **Expected:** the amount is trimmed from **each** selected day's hours; if a day hits 0
  it becomes fully lost; a partial-hindrance day installs at reduced capacity.

### UC-P-09 — Review and resolve warnings before viewing the plan
- **Goal:** understand and decide on plan warnings (cap applied, blocked chainages,
  shortfall, hindrances, idle machines, carry-over).
- **Flow:** *Process Plan* → warnings modal lists all non-OK warnings → *Proceed* (view as
  is) or *Abort* (back to the form).
- **Expected:** *Proceed* renders the plan with warnings surfaced in the Validation panel;
  *Abort* discards and returns to inputs.

### UC-P-10 — Read the completion forecast for the whole priority
- **Goal:** know when the entire selected scope finishes, not just this window.
- **Expected:** two forecast dates — **as per material availability** (replays the crew
  forward honoring the material timeline until nothing more can install) and **all material
  available** (rate-only). The material-availability date can be blank/limited when scope
  is blocked or beyond the 2-year horizon.

### UC-P-11 — Inspect the Gantt view (color by material / machine)
- **Goal:** see which chainage each machine works and when.
- **Expected:** one bar per scheduled chainage on its machine lane; toggle color by
  profile (material) or by machine; hover shows details; legend matches the color mode.

### UC-P-12 — Inspect the Material view (day-by-day availability)
- **Goal:** verify no day installs more than the material on hand.
- **Expected:** per item code per day — **Available** (net stock carried in, before that
  day's use), **Inbound** (arriving that day, usable next day), **Used** (installed that
  day). Balance carries forward; inbound shows on off days too.

### UC-P-13 — Inspect the Table view (group by date / chainage / machine)
- **Goal:** read the schedule as a table, regrouped on demand.
- **Expected:** whole-pile per-day values via cumulative rounding (daily = Δ of the rounded
  running total) so columns add up to the totals; grouping switches without re-planning.

### UC-P-14 — Inspect the Map view (spatial plan)
- **Goal:** see the plan on the sheet-pile boundary geometry.
- **Expected:** each chainage drawn as its boundary segment + midpoint marker; selected
  priority colored by status (Completed / Partially done / Scheduled this plan / In scope
  not scheduled / Blocked); other priorities greyed as context. Legend is a multi-select
  filter; WebGL (three.js) with SVG fallback; wheel-zoom, drag-pan, hover, click-to-pin.

### UC-P-15 — Jump from Validation "blocked" to the Map
- **Goal:** locate blocked (no-material) chainages spatially.
- **Flow:** Validation panel → *View blocked on map* → Map opens with the *blocked* filter
  applied.

### UC-P-16 — Read the Validation panel
- **Goal:** confirm manpower/resource feasibility and productivity/ramp assumptions.
- **Expected:** feasibility badge; machines chosen vs manpower-capped vs deployed +
  utilization/idle; productivity basis and ramp explanation; hindrance impact note.

### UC-P-17 — Read Recent Progress (week / month, paged)
- **Goal:** sanity-check the pace baseline against recent installs.
- **Expected:** bar chart of piles installed per recent period with a 3-period trend line;
  Week/Month toggle; ‹ › paging through history.

### UC-P-18 — Export the plan as a Primavera P6 `.xer`
- **Goal:** hand the plan to the taskmapper system.
- **Flow:** *Export plan* (header) → downloads `SHP_<priorities>_<startISO>.xer`.
- **Expected:** WBS Root → Priority → Zone → Profile, one task per scheduled chainage,
  equipment + labour resources, FS links, UDFs (Quantity Nos, Pile Type, Length Km, Area
  SqMtr, Notes); CRLF/ASCII/no-BOM. Requires at least one scheduled chainage.

### UC-P-19 — Cross-plan machine-history persistence (ramp baseline)
- **Goal:** the next plan should ramp only the *new* machines.
- **Expected:** on *Process Plan*, the effective **deployed** count is written to
  `localStorage` (`spp_machines_prev`); the next session seeds *Machines from previous
  plan* from it (first run = machines, no ramp). *Reset stored machine history* clears it.

### UC-P-20 — Cost-optimize the machine count
- **Goal:** avoid over-provisioning machines.
- **Expected (§5.4):** the engine simulates every machine count 1..cap and **deploys the
  fewest** that still install the maximum the window can absorb; extras are surfaced as an
  "over-provisioned / idle" warning with a recommended count.

### UC-P-21 — Manpower cap enforcement (6 people per machine)
- **Goal:** never plan more machines than manpower supports.
- **Expected:** effective machines = `min(machinesInput, floor(manpower / 6))`; a live cap
  notice appears while editing; a cap warning is raised when the input exceeds the cap;
  `manpower = 0..5` ⇒ 0 machines ⇒ a blocking "no manpower" warning.

### UC-P-22 — Return to home / reset
- **Goal:** switch modules or start over.
- **Flow:** click the logo (home) → module picker; selecting a module preserves loaded
  data (no re-parse).

---

# PART B — BLUESKY (target-date back-planner)

**Purpose:** given a **target finish date** and selected priorities, back-calculate how
many machines & how much manpower are needed to finish the remaining scope by that date,
plus a material gap check (at-site / in-transit / gap, and the day work would halt), a
chainage/machine schedule (assuming unlimited material), and a schedule-led **probability
of success**.

### UC-B-01 — Back-calculate the crew for a target date
- **Goal:** "I must finish `P-1a` by <date> — how many machines?"
- **Flow:** open Bluesky → pick a target date → select priority(ies) → *Process Plan*.
- **Expected:** `machinesNeeded` = smallest crew whose **ramp-aware** capacity over the
  working days until the target covers the remaining piles; `manpower = machinesNeeded × 6`.
  Plan start is the **next Monday on/after today** (never backdated).

### UC-B-02 — Multi-priority target planning
- **Goal:** finish several priorities by one date.
- **Expected:** remaining scope sums across selected priorities; the crew is sized for the
  combined scope; material demand/supply is shown **per (priority, profile)** with the
  shared per-code pool allocated **highest priority first**.

### UC-B-03 — Material gap check (Priority & Material-wise Check panel)
- **Goal:** see whether material supply can sustain the required pace.
- **Expected:** one row per (priority, profile) with **At site** (net accepted), **In
  transit** (usable by target, + later), **Required** (demand), **Gap/Shortage**, and
  **Work halts on** (first day that profile starves). A total gap > 0 ⇒ warn verdict.

### UC-B-04 — Chainage-wise / machine-wise schedule (unlimited material)
- **Goal:** see the day-by-day plan the crew would run at the required pace.
- **Expected:** one chainage per machine per day, priority then Chainage_Id order, ramp
  applied to new machines; regroupable by date/chainage/machine; assumes **unlimited**
  material (material constraints live only in the gap panel).

### UC-B-05 — Probability of success
- **Goal:** a single realism score for hitting the date.
- **Expected:** weighted **geometric mean** of three factors — crew scalability (needed vs
  your actual fieldable crew), productivity realism (input vs actual recent productivity),
  delivery consistency (CV of recent daily installs) — clamped to 2–98%. Material is
  **excluded** (shown separately). One weak factor drags the whole score down.

### UC-B-06 — Set pace parameters (work-days, workhours, productivity, already-installed machines)
- **Goal:** tune the assumptions behind the back-calculation.
- **Expected:** *Already Installed Machines* run at steady-state (factor 1.0); machines
  beyond that ramp up per the adaptive curve. Changing workhours/productivity changes
  `perMachineDaily` and hence the crew.

### UC-B-07 — Infeasible / already-complete verdicts
- **Goal:** get a clear message when the ask is impossible or moot.
- **Expected:**
  - Target not after plan start (no working days) ⇒ **bad** verdict, "pick a later date".
  - Productivity/workhours zero ⇒ **bad** verdict.
  - Remaining scope = 0 (all selected priorities complete) ⇒ **ok** "nothing to plan".

### UC-B-08 — Read the verdict + KPIs
- **Goal:** one-glance summary.
- **Expected:** verdict sentence (ok/warn/bad) + KPI tiles (probability, machines,
  manpower, gap, remaining piles, completion date), consistent with the panels.
