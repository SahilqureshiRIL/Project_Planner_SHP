# Sheet Pile Installation Planner — Phase 1

A single, self-contained local web app that turns four source files into a
day-by-day sheet-pile installation plan, shown as a **Gantt chart** and a
**table** (toggle between them) with a **validation panel**.

Plain HTML + CSS + vanilla JS. No build step, no backend, no framework.

## Running it

**Option A — just open it.** Double-click `index.html` (or open it in a browser).
Then upload the four files using the inputs in the *Data Files* card.

**Option B — serve it** (lets the "Try loading bundled ./data files" button work,
since browsers block `fetch()` of local files over `file://`):

```powershell
# from this folder, with Python installed:
python -m http.server 8000
# then open http://localhost:8000
```

## Inputs

**Chainage data is frozen** — it is hardcoded in `js/chainage_data.js` and shown
read-only in the *Chainage Data* card. There is no upload or in-app edit; the team
overrides values directly in that file (regenerate it from a GeoJSON via
`D.parseChainage` if needed).

Three files are uploaded by the planner:

| File | What it provides |
|---|---|
| `manpower_resources.xlsx` | Sheets `Machine Status`, `Manpower Status`, `Shifthour Status` (one row per shift-date). |
| `material_avalibility.xlsx` | Sheet `Planner tool Input` — per `Item Code`: `Delivered` rows count as on-site stock (usable = `Accepted at site` qty, falling back to `Quantity` when blank; `Damaged` excluded); all other statuses are treated as inbound (`Quantity` expected on `Expected Arrival`). |
| `progress_history.xlsx` | Sheet `Progress history` — used for the productivity baseline (`Sub Activity = "Sheet Pile Installed"`). |

Sample copies of all four source files are in `./data/`.

## Files

```
index.html        markup + structure
styles.css        all design tokens live in :root (swap for a real design system)
js/chainage_data.js  FROZEN read-only chainage dataset (hardcoded, no upload)
js/util.js        dates, number/text formatting, small DOM helpers
js/data.js        file parsing, normalization, defaults computation
js/engine.js      the deterministic planning engine (simulation + cost-optimizer)
js/ui.js          wiring, defaults → form, Table / Gantt / Validation renderers
vendor/           SheetJS (xlsx) vendored locally so .xlsx parsing works offline
```

## Defaults (auto-computed, then editable)

With the bundled sample files and no priority chosen yet, the input screen shows:
**Machines 4 · Manpower 24 · Workhours 9 · Productivity 0.465 · Work Days/week 6 ·
Plan Start Mon 2026-06-29 · ramp n = 7** — all editable.

All defaults use the **last-7-days window** anchored on the latest shift date
(after the date fix, 12–18 Jun 2026); averages divide by 7.

## Modeling decisions / assumptions (Phase 1)

These are the places where the spec left room for judgement — all are easy to find
and change:

- **Date typo fix (`data.js → fixDuplicateShiftDate`)** — the source has two rows
  for the same shift-date; the *first* occurrence is shifted back one day so there
  is one row per day. It's a clearly-commented, self-disabling step (no-op once the
  upstream data is corrected). Verified against the sample: the duplicate `15-Jun`
  becomes `14-Jun`.
- **Plan-start default** — *first Monday after the latest **actual** dated record*
  (manpower shift dates, progress dates, material **receipt** dates). Future inbound
  **Expected Arrival** forecasts are intentionally excluded, which is what yields
  `2026-06-29` for the sample.
- **Profile work order** — profiles are ranked by **material available on-site at
  plan start** (on-site receipts + inbound already arrived), descending; within a
  profile, chainages ascend by `Chainage_Id`.
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
- **Map view** — a third output view (Gantt / Table / **Map**) plots the sheetpile
  boundary from the real geo-coordinates. Each chainage is drawn as its boundary
  segment with a midpoint marker at its true location; the selected priority is
  coloured by status (in-progress / planned / complete / blocked) and other priorities
  show as grey context. Hover for a tooltip and click to pin chainage value, profile,
  status, scheduled dates and progress. The legend is **click-to-filter**: click a
  category (In progress / Planned / Complete / Blocked / Other priorities) to isolate
  it; click again to clear.
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
