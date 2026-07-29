# Sheet Pile Installation Planner — Phase 1

A single, self-contained local web app that turns the source files into a
day-by-day sheet-pile installation plan, shown as **Gantt** (default), **Material**,
**Table**, and **Map** views with a **validation panel**, forecast-completion dates,
and a **Primavera P6 `.xer` export** ("Export plan") for the taskmapper system.

Plain HTML + CSS + vanilla JS. No build step, no backend, no framework. Fully
offline-vendored (SheetJS, three.js, and the Inter/Sora webfonts ship locally).

## Running it

Serve it over http (the three live data files are auto-loaded from `./data/` via
`fetch()`, which browsers block over `file://`):

```powershell
# from this folder, with Python installed:
                              python -m http.server 8000
# then open http://localhost:8000
```

## Inputs

**Chainage data is frozen** — it is hardcoded in `js/chainage_data.js` (no upload or
in-app edit); regenerate it from `data/chainage_data.json` when that source changes.

The other three files are **auto-loaded** from `./data/` on startup (a manual-upload
card appears only as a fallback if auto-loading fails):

| File | What it provides |
|---|---|
| `manpower_resources.xlsx` | Sheets `Machine Status`, `Manpower Status`, and `Shifthour Status` **or** `Manhour Status` (one row per shift-date). |
| `material_avalibility.xlsx` | Sheet `Planner tool Input` — per `Item Code`: `Delivered` rows count as on-site stock (usable = `Accepted at site` qty, falling back to `Quantity` when blank; `Damaged` excluded); all other statuses are treated as inbound (`Quantity` expected on `Expected Arrival`). |
| `progress_history.xlsx` | Sheet `Progress history` — `Sub Activity = "Sheet Pile Installed"`, current (`Reset = FALSE`) rows only. Feeds the productivity baseline **and** per-chainage already-installed piles (netted out of the plan). |

Sample copies of all four source files are in `./data/`.

## Files

```
index.html        markup + structure
styles.css        all design tokens live in :root (swap for a real design system)
js/chainage_data.js  FROZEN read-only chainage dataset (hardcoded, 952 chainages)
js/util.js        dates, number/text formatting, small DOM helpers
js/data.js        file parsing, normalization, defaults computation (+ imputation)
js/engine.js      the deterministic planning engine (simulation + cost-optimizer)
js/xer.js         Primavera P6 .xer exporter (Export plan)
js/ui.js          wiring, defaults → form, Gantt / Material / Table / Map / Validation
vendor/           SheetJS (xlsx) + three.js, vendored locally so the app works offline
assets/fonts/     Inter + Sora webfonts (offline)
```

See **`sheet_pile_planner_prompt.md`** for the full logic spec (the `§`-references
used in the code comments).

## Defaults (auto-computed, then editable)

With the bundled data and no priority chosen, the input screen shows the **last-7-days**
averages (anchored on the latest shift date) — computed fields render **greyed** until
edited. Days that logged progress but have **no shift entry** are imputed from the
average of the last 15 available data points (so weekend catch-up entries don't distort
the averages/productivity). Machines/Manpower/Workhours are window averages, Productivity
= `piles ÷ machine-hours`, Plan Start = first Monday after the latest dated record.

## Modeling decisions / assumptions (Phase 1)

These are the places where the spec left room for judgement — all are easy to find
and change:

- **Date typo fix (`data.js → fixDuplicateShiftDate`)** — the source has two rows
  for the same shift-date; the *first* occurrence is shifted back one day so there
  is one row per day. It's a clearly-commented, self-disabling step (no-op once the
  upstream data is corrected). Verified against the sample: the duplicate `15-Jun`
  becomes `14-Jun`.
- **Plan-start default** — *first Monday after the latest **actual** dated record*
  (manpower shift dates, progress dates, material **Actual Arrived** dates).
- **Prior-progress netting** — each chainage's already-installed piles (from progress
  history, `Reset = FALSE`) are subtracted: **completed** chainages drop out, **active**
  ones plan only their *remaining* piles.
- **Material = Accepted at Site (net)** — "Accepted at Site" is treated as gross
  received, so usable on-site stock = accepted − already-consumed. Only material that
  **arrives within the plan window** replenishes stock; **overdue on-hold** material
  (past Expected Arrival, not delivered) is excluded until it actually arrives.
- **Work order** — profiles ranked by **net Accepted-at-Site material**, descending;
  within a profile: **partially-installed chainages first**, then untouched chainages
  **nearest to the most-recently-worked chainage** (by progress date), then `Chainage_Id`.
- **Forecast completion** — two projected dates for the whole priority: *as per material
  availability* (replays the crew forward honoring the material timeline until nothing
  more can be installed) and *all material available* (rate-only). See `§5.7`.
- **Install model** — capacity is `productivity × workhours` piles/machine/day, so
  daily installs are fractional internally. The table shows whole piles via
  cumulative rounding (daily = Δ of the rounded running total) so columns still add
  up. Material consumption, MTO and capacity all use the same unit, so installs
  never exceed available material, daily capacity, or remaining MTO (verified).
- **Ramp clock** — every machine is treated as deployed from the first working day;
  a "new" machine (index beyond *Machines from previous plan*) ramps by its
  working-day index using the editable ramp profile.
- **Hindrances** — plan-wide, but each one now records the **specific day(s)** it
  affects (a Mon-aligned mini calendar over the plan window; non-contiguous days
  allowed). A *days* hindrance fully loses each selected working day; an *hours*
  hindrance trims its amount from each selected day. If no day is selected it falls
  back to the earliest working day(s) (legacy behavior). See the `// TODO: confirm`
  notes in `engine.js`/`ui.js` for the assumptions made.
- **Ramp-up curve** — the *Ramp-up settings* section shows a live inline SVG chart of
  productivity rate (piles/machine/hour = base × ramp multiplier) vs. days from start,
  with the steady-state line and the `n` marker; it re-renders as settings change.
- **Per-warning confirmation** — Generate first computes the plan's warnings and
  surfaces them one at a time in a modal ("Proceed with this warning? Yes / No").
  *Yes* keeps the warning and proceeds; *No* applies a defined adjustment that clears it
  (e.g. cap → reduce machines; blocked → exclude no-material chainages; shortfall → cap
  started chainages to material; hindrance → remove hindrances; idle → deploy the
  cost-optimized count; carry-over / idle-days → acknowledge), re-runs, and continues.
  Every warning and its decision (accepted / adjusted + detail) is stored on the plan,
  shown in the *Warning decisions* panel, and the compact form is saved to localStorage.
  See the `// TODO: confirm` note in `ui.js` for the assumed adjustment per warning.
- **Map view** — plots the sheetpile boundary from the real geo-coordinates. Each
  chainage is drawn as its boundary segment with a midpoint marker; the selected
  priority is coloured by status — **Completed (from progress)** (no machine/date),
  **Partially done (from progress)**, **Scheduled this plan** (carries machine/dates),
  **In scope (not scheduled)**, **Blocked (no material)** — and other priorities show as
  grey context. Hover to see details; click to pin. The legend is a **multi-select
  filter**: toggle several categories on/off (none = show all). The Validation panel's
  **"View blocked on map"** button jumps here with the *blocked* filter applied.
  - Rendered with **three.js** (vendored in `vendor/three.min.js`, so it works
    offline) — an orthographic 2-D plan view with smooth wheel-zoom-toward-cursor and
    drag-to-pan, plus a north arrow and scale bar. Picking/selection is done in screen
    space (nearest marker). If WebGL is unavailable it automatically falls back to a
    self-contained **SVG** renderer with the same colors, filtering, hover/click and
    zoom buttons.
  - The compact per-chainage segment `geo: [lngA,latA,lngB,latB]` lives in
    `js/chainage_data.js` (the two most-distant footprint vertices); full polygon
    geometry is intentionally not shipped. A tiled basemap (e.g. Leaflet) could be
    layered in later if online tiles are acceptable.
- **Cost-optimization** — the engine simulates every machine count from 1 to the
  manpower cap and deploys the **fewest** machines that still install the maximum
  the window can absorb (material/work limited), and stores that count in
  `localStorage` for the next run's ramp baseline.
- **Export plan (`js/xer.js`)** — builds a Primavera **P6 `.xer`** for taskmapper: a
  WBS of Root → Priority → Zone → Profile with one task per scheduled chainage,
  equipment/labour resources + FS links, and UDFs (Quantity Nos, Pile Type, Length Km,
  Area SqMtr, Notes). Emitted as CRLF/ASCII/no-BOM; date and numeric fields are
  populated so strict P6 parsers accept it.
