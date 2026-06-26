# Build Prompt — Sheet Pile Installation Planner (Phase 1)

> Paste this entire file into Claude Code as the task. It is self-contained: it
> describes the objective, the exact data schemas, the input screen, the planning
> engine, the output views, and the design. Build it as a single local web app.

---

## 1. Objective

Build a **chainage-wise project planning tool** for sheet-pile installation on a
construction site. A planner sets a few parameters on an input screen, clicks
**Generate Plan**, and the app produces a **day-by-day installation plan** for the
selected window, viewable as both a **Gantt chart** and a **table** (toggle between
them), plus a **validation panel** that checks material availability, productivity,
and resource usage.

This is **Phase 1 / a prototype**. Favor correctness of the logic and clarity of the
UI over completeness. Keep all parameters editable so the planner can override the
data-derived defaults.

---

## 2. Tech constraints

- **A single, self-contained web app** — plain **HTML + CSS + vanilla JavaScript**.
  No build step, no backend, no framework required. One `index.html` is ideal; a
  small number of co-located `.js`/`.css` files is fine.
- Parse inputs **client-side**:
  - `.xlsx` → use **SheetJS (xlsx)** from a CDN (e.g. cdnjs).
  - `.geojson`/`.json` → native `JSON.parse`.
- The four input files are loaded through **file-upload inputs** on the page (one per
  file). On load, the app parses them, computes the defaults, and pre-fills the input
  screen. Validate that each uploaded file has the expected sheets/keys and show a
  clear error if not.
- The Gantt can be drawn with **plain SVG or CSS** (no heavy charting dependency
  required); a tiny library is acceptable if it keeps the code simple.
- **localStorage** is used for the small piece of cross-plan persistence described in
  §5.6 (remembering the machine count from the previous plan). This is a real local
  web page, so localStorage is fine here.
- All currency/number formatting and dates should be unambiguous (use ISO dates
  `YYYY-MM-DD` in data, friendly dates in the UI).

---

## 3. Input data — exact schemas

There are four input files. **Use these exact field names.** Notes below are derived
from the real sample data and must be handled.

### 3.1 `chainage_data.json` — GeoJSON FeatureCollection (873 features)

Each `feature.properties` carries many fields; the planner cares about these:

| Field | Example | Meaning |
|---|---|---|
| `Chainage_Id` | `"32+800"` | Unique chainage id (1 feature = 1 chainage; ids are unique). |
| `Priority` | `"P-2"` | One of **`P-1a`, `P-1b`, `P-1c`, `P-2`**. |
| `Profile Name` | `"ZU735-300-12-5500"` | The single sheet-pile profile for this chainage (19 distinct profiles). |
| `No of Profiles` | `"141"` | MTO scope = number of individual pile sections to install at this chainage. **String → parse to int.** |
| `New SAP Code` | `"5000090951"` | **Join key to material** (`Item Code`). |

- Every chainage has **exactly one** `Profile Name`.
- Priority counts in the sample: P-1a = 138, P-1b = 105, P-1c = 150, P-2 = 480.
- All property values are **strings** — coerce numerics as needed.
- The polygon `geometry` is **not needed** for Phase 1 (no map). Ignore it.

### 3.2 `manpower_resources.xlsx` — 3 sheets

Each sheet is one row per **shift-date**. Header is row 1.

- **`Machine Status`**: `Shift Date` | `Machine Type` (all `"Hammer"`) | `Machines Available` (int)
- **`Manpower Status`**: `Shift Date` | `Manpower Available` (int)
- **`Shifthour Status`**: `Shift Date` | `Manhour` (int) — this is the **shift length in hours** ("workhours").

Dates are formatted like `"12-Jun-2026"`.

**IMPORTANT data fix:** in the sample, two rows in each sheet are dated `15-Jun-2026`.
This is a typo — **the *first* `15-Jun-2026` row in each sheet should be treated as
`14-Jun-2026`.** After this fix there is exactly one row per day for 12–18 Jun 2026
(7 consecutive days). Apply this correction when parsing. (Build it as a small,
clearly-commented normalization step so it can be removed once the source data is
fixed.)

### 3.3 `material_logistics.xlsx` — 1 sheet `Material Logistics`

Header row 1: `Item Code` | `Item Name` | `Quantity` | `Receipt date` | `Expected Arrival`

- **On-site stock** = rows where `Receipt date` is set and `Expected Arrival` is empty.
- **Inbound stock** = rows where `Expected Arrival` is set and `Receipt date` is empty.
- `Item Code` joins to chainage `New SAP Code`. (One sample `Item Code` `5000090945`
  has no matching chainage — such items are simply never needed and can be ignored.
  Some chainage profiles have **no** material row at all — see §5.3.)
- Dates parse as datetimes.

### 3.4 `progress_history.xlsx` — 1 sheet `Progress history`

Header row 1 includes: `Name`, `Sub Activity`, `Activity`, `Date`, `Value`, `Sub Layer`, `Layer` (and others).

- The relevant metric is rows where **`Sub Activity` == `"Sheet Pile Installed"`**;
  for those rows **`Value` = number of piles installed** that `Date` (other
  sub-activities like `"Length Covered"` and `"Bunds Installed"` are **not** used for
  productivity).
- `Date` is `YYYY-MM-DD`. **Skip the one trailing row that has a null `Date`/`Sub Activity`.**
- `Name` (e.g. `"SHP-ZN-01-32+800"`) corresponds to a chainage; not needed for the
  Phase-1 calculations below, but keep it available.

---

## 4. Input screen

Compute every default from the data using the **methodology below**, then let the
planner edit it. Show each field's default value and a short "(auto from last 7 days)"
hint where applicable. **All numeric defaults round to the nearest integer except
Productivity, which is a decimal.**

### The "last 7 days" window

- Anchor on the **latest `Shift Date` in `manpower_resources.xlsx`** (after the 14-Jun
  fix this is **18-Jun-2026**). The window is that date and the **6 prior calendar
  days → 12–18 Jun 2026 (7 days)**.
- Averages divide by **7** (the full window length), not by the number of populated
  rows.

### Parameters

1. **Chainage Priority** — single-select dropdown. Options = the distinct `Priority`
   values in the data (`P-1a`, `P-1b`, `P-1c`, `P-2`). No default selection forced
   (planner must choose). *Phase 1 plans a **single** priority only.*

2. **Plan Period** — radio buttons: **2 weeks** / **3 weeks**.

3. **Plan Start Date** — **date picker restricted to Mondays only** (disable / reject
   non-Mondays). Default = **the first Monday after the latest date present across the
   input data** (sample → **Monday 29-Jun-2026**). The plan window spans 2 or 3
   calendar weeks from this Monday.

4. **Machines Deployable** — editable integer. Default = `round(mean of daily
   "Machines Available" over the 7-day window)`. **Sample default = 4** (sum 27 ÷ 7 =
   3.857 → 4).

5. **Manpower** — editable integer. Default = `round(mean of daily "Manpower
   Available" over the 7-day window)`. **Sample default = 24** (sum 169 ÷ 7 = 24.14).

6. **Work Days per week** — select **5 / 6 / 7**, **default 6**. (Work week starts
   Monday: 5 = Mon–Fri, 6 = Mon–Sat, 7 = all 7 days. Non-work days are skipped in the
   daily plan.)

7. **Workhours** (shift hours/day) — editable integer. Default = `round(mean of daily
   "Manhour" over the 7-day window)`. **Sample default = 9.**

8. **Hindrances** — a small editable list; planner can **add multiple**. Each entry:
   - **Type**: `Political` / `Weather` / `Other`.
   - **Amount affected**: a number plus a unit toggle **days** or **hours**.
   - Hindrances are **plan-wide** (not chainage-specific). See §5.5 for how they reduce
     capacity. Default = empty list.

9. **Productivity** — editable decimal, **piles installed per machine per hour**.
   Default =
   `total "Sheet Pile Installed" piles in the 7-day window ÷ (Σ daily machines × workhours over the window)`.
   With the window machine-hours = `27 × 9 = 243` and piles = `113`, **sample default =
   0.465**. Show the derivation as a tooltip.

10. **Ramp-up settings** (prototype assumptions — clearly label as editable/assumed; see
    §5.6):
    - **Days to steady-state (n)** — integer, **default 7**.
    - **Ramp profile** — per-day productivity multipliers for day 0…n applied to a
      *newly introduced* machine, then 1.0 thereafter. Default (assumed realistic
      learning curve): `[0.45, 0.58, 0.70, 0.80, 0.88, 0.94, 0.98, 1.00]`.
    - **Machines from previous plan** — integer; machines up to this count start at
      steady-state, machines beyond it are "new" and ramp. Default = value persisted
      from the last generated plan (localStorage), or, on first run, equal to the
      chosen **Machines Deployable** (so the first plan shows no ramp, matching the
      agreed behavior).

### Input validation (block / warn)

- **6 people per machine, exactly.** Effective machines are **auto-capped** to
  `floor(Manpower ÷ 6)`. Do **not** block input; if the planner's chosen machines
  exceed the cap, show a visible notice ("Capped to N machines — manpower supports
  N×6 = … people") and use the capped number downstream.
- Plan Start must be a Monday (enforced by the picker).
- Numeric fields must be positive; Productivity > 0.

---

## 5. Planning engine

Run when the planner clicks **Generate Plan**. Produce a deterministic day-by-day
schedule for the plan window. Below is the required algorithm.

### 5.1 Build the working calendar

- Working days = days within the 2-or-3-week span from the Monday start that match
  **Work Days per week** (skip the rest). Hours per working day = **Workhours**.
- Apply **hindrances** to this calendar per §5.5.

### 5.2 Candidate chainages & sequencing

- Candidates = all chainages whose `Priority` == the selected priority.
- Each chainage's required work = `No of Profiles` piles of its `Profile Name`.
- **Material drives ordering.** Among the **profiles** needed by the candidate
  chainages, rank profiles by **available on-site quantity, descending** — the profile
  with the **highest on-site stock is worked first**. When a profile's stock is
  exhausted and plan time remains, move to the **next-highest-stock** profile.
  Account for inbound replenishment over time (§5.3).
- Within a profile, sequence its chainages in **ascending `Chainage_Id`** order
  (natural site progression) as the default tie-break.
- **One machine per chainage**: a chainage is worked by exactly one machine at a time,
  so up to *(effective deployed machines)* chainages progress in parallel. A machine
  that finishes a chainage moves to the next chainage in sequence.

### 5.3 Material model

- For each profile (`Item Code`/`New SAP Code`):
  - **Starting stock** (available from plan day 1) =
    Σ `Quantity` of **on-site** rows for that code
    **plus** Σ `Quantity` of **inbound** rows whose **(Expected Arrival + 1 day) ≤ plan
    start** (i.e. already arrived and usable).
  - **Future inbound**: each remaining inbound row adds its `Quantity` on date
    **(Expected Arrival + 1 day)** if that date is after the plan start. Track these as
    dated replenishments during the plan.
- Installation **consumes** stock of the chainage's profile (1 pile installed = 1 unit
  consumed). A chainage/profile can only progress on a given day up to the stock
  available **that day**.
- **Chainages whose profile has zero starting stock and zero relevant inbound** cannot
  be planned — exclude them from the schedule and **flag them** in the validation panel
  ("No material available"). (In the sample, 6 chainage profiles have no material row.)

### 5.4 Productivity, ramp-up & machine cost-optimization

- Steady-state per-machine daily capacity = `Productivity × Workhours` piles/day
  (sample: `0.465 × 9 ≈ 4.19`).
- **Ramp-up (per machine, from its own day 0):** machines counted as "from previous
  plan" run at steady-state from day 1. Any machine **beyond** that count is **new**
  and uses `Productivity × ramp[k] × Workhours` on its k-th day of operation (k = 0…n),
  then steady-state. Persist the deployed count for next time (§5.6).
- **Daily install capacity** = Σ over deployed machines of their per-day capacity, then
  **bounded by** (a) the day's available material per profile and (b) remaining MTO of
  the chainages in progress.
- **Cost-optimization (suggest fewer machines):** the **effective deployed machine
  count** = the **smallest** number of machines (≤ the manpower-capped maximum) that
  still installs as many piles as the plan can otherwise absorb in the window given
  material and available work. If extra machines would sit idle (material- or
  work-limited), **recommend the lower count** and surface both the planner's input and
  the recommended/deployed number in the output. Optimize for fewest machines, not
  fastest completion.

### 5.5 Hindrances

- Hindrances are plan-wide and reduce capacity:
  - **Day-type** hindrances remove that many **working days** — represent them as
    explicit non-working days applied to the **earliest** working days of the plan
    (shifting installation later; any work pushed past the window is reported as
    carry-over).
  - **Hour-type** hindrances subtract from total available hours — apply by trimming
    hours from the earliest working day(s).
  - Multiple hindrances are summed.
- Mark hindrance impact clearly in both the plan view and the validation panel. (This
  earliest-days placement is a deterministic Phase-1 simplification; date-specific
  placement can come later.)

### 5.6 Cross-plan persistence

- On a successful **Generate Plan**, store the **effective deployed machine count** (and
  optionally a timestamp/selected priority) in **localStorage**.
- On the next run, default **"Machines from previous plan"** to that stored value so
  machines added beyond it are treated as newly introduced and ramp accordingly.
- Provide a small **"Reset stored history"** control.

---

## 6. Output

Two synchronized views with a **toggle button (Gantt ⇄ Table)**, plus a validation
panel. The plan is at **daily granularity**.

### 6.1 Table view

One row per **(working day × chainage worked that day)**. Suggested columns:

`Date` · `Day #` · `Machine` (Machine 1…k) · `Chainage_Id` · `Profile Name` · `Piles
Planned (this day)` · `Cumulative Piles (chainage)` · `Chainage MTO (No of Profiles)` ·
`% Complete` · `Status` (In progress / Completed) · `Material Remaining (profile, end
of day)`.

Allow grouping/sorting by date, by chainage, and by machine. Show hindrance days as
clearly-marked non-working rows.

### 6.2 Gantt view

- Rows = **chainages** (group/color by `Profile Name`, or offer a "color by machine"
  toggle). X-axis = the plan's calendar dates.
- Each chainage bar spans its **start → finish** day with a **% fill** for progress.
- Mark **inbound material arrival dates** and **hindrance days** on the timeline.
- Keep it legible for a few dozen chainages (scroll/zoom is fine).

### 6.3 Validation panel

A clear summary the planner reads alongside the plan:

- **Material:** per profile — required (for planned chainages) vs available (on-site +
  inbound within window) vs consumed vs shortfall; a small inbound-arrival timeline;
  and the **list of chainages blocked by "No material."**
- **Productivity:** the steady-state value used, the ramp assumptions (n + profile),
  and the resulting effective daily capacity.
- **Resources:** machines **chosen** vs **manpower-capped** vs **deployed
  (cost-optimized)**; manpower utilization (`deployed × 6` vs available); any idle
  machines.
- **Plan feasibility:** total piles installable in the window vs total MTO of the
  selected priority; overall **% completion**; **carry-over** (work not fitting in the
  window); and the impact of hindrances.
- **Warnings** (collect prominently): machine cap applied, material shortfalls, blocked
  chainages, hindrance time lost, plan start not Monday (should be prevented), etc.

---

## 7. Design

Professional, corporate look — this is a **placeholder design system** to be replaced
later, so keep styling centralized and swappable (CSS custom properties / design
tokens at `:root`).

- Clean, restrained palette: neutral slate/gray surfaces, a single calm accent (navy or
  teal), clear semantic colors for warning/success. Subtle borders and shadows; ample
  whitespace.
- A readable UI typeface (system font stack or Inter). Tabular numerals for data.
- Card-based layout: an **Inputs** panel/section, a **Results** area with the view
  toggle, and the **Validation** panel. Sticky header with the app title and the
  Generate / view-toggle controls.
- Dense but legible data tables (zebra rows, sticky header, right-aligned numbers).
- Responsive down to a laptop width; graceful on smaller screens.
- Keep all colors, radii, spacing, and font choices in CSS variables so a real design
  system can drop in.

---

## 8. Acceptance / self-check

With the four sample files loaded and **priority not yet chosen**, the input screen
should show: **Machines = 4, Manpower = 24, Workhours = 9, Productivity = 0.465,
Work Days/week = 6, Plan Start = Monday 2026-06-29**, ramp n = 7. Verify:

- Changing **Manpower** below `6 × chosen machines` triggers the auto-cap notice and the
  engine uses the capped machine count.
- Selecting a priority + **2 weeks** generates a daily plan whose installs never exceed
  available material per profile per day, and where chainages with no material are
  listed as blocked.
- Inbound quantities become available on **Expected Arrival + 1 day** and show on the
  Gantt timeline.
- The **Gantt ⇄ Table** toggle shows the same plan both ways.
- If the chosen machines would sit idle (material/work limited), the validation panel
  recommends a **lower deployed machine count**, and that count is what gets stored to
  localStorage for the next run.

Build it now. Ask before introducing any heavy dependency; otherwise proceed.
