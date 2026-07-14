# Sheet Pile Installation Planner — Logic & Spec Reference

> **Living document.** Originally a build prompt; now the maintained reference for the
> app's logic. The `§`-numbers here are referenced from comments in `js/engine.js`,
> `js/data.js`, and `js/ui.js` — keep them in sync when the logic changes.
>
> Numbers/examples reflect the current sample data (P-1a, 952 chainages, mid-2026).

---

## 1. Objective

A **chainage-wise planning tool** for sheet-pile installation. The planner picks a
priority + a few parameters, clicks **Generate Plan**, and the app produces a
**day-by-day plan** for a 2/3-week window, shown as **Gantt** (default), **Material**,
**Table**, and **Map** views, plus a **Validation** panel and forecast completion
dates. The plan can be **exported as a Primavera P6 `.xer`** for the taskmapper system.

Phase-1 prototype: correctness of logic + clear UI. All data-derived defaults stay
editable.

---

## 2. Tech constraints

- Single self-contained web app: **HTML + CSS + vanilla JS**, no build step/backend.
  Files: `index.html`, `styles.css`, and `js/{util,chainage_data,data,engine,xer,ui}.js`
  (load order: util → chainage_data → data → engine → xer → ui).
- **Fully offline-vendored** (works behind a firewall): `vendor/xlsx.full.min.js`
  (SheetJS), `vendor/three.min.js` (Map WebGL), `assets/fonts/*` (Inter + Sora webfonts).
- Data is **auto-loaded** from `./data/` on startup over http; the manual upload card is
  a fallback (e.g. when opened via `file://`).
- **localStorage** for the small cross-plan persistence in §5.6.
- ISO dates `YYYY-MM-DD` in data; friendly dates in the UI. `?v=NN` cache-buster on all
  `js`/`css` links — bump it whenever those files change.

---

## 3. Input data

Four inputs. The **chainage data is frozen** into `js/chainage_data.js`; the other three
are read live from `./data/`.

### 3.1 Chainage data — frozen in `js/chainage_data.js` (952 chainages)

`window.SPP_CHAINAGE_DATA = { fields, rows, geo }` — compact rows + a `geo` entry per row
(`[lngA,latA,lngB,latB]`, the two most-distant footprint vertices = the boundary segment
for the Map). Regenerated from `data/chainage_data.json` when that source changes. Fields
used (see `D.buildChainageModel`):

| Field | Meaning |
|---|---|
| `Chainage_Id` | unique chainage id (e.g. `75+750`) |
| `Priority` | `P-1a` / `P-1b` / `P-1c` / `P-2` |
| `Profile Name` | short profile code (e.g. `ZU735-300-12-5500`) — kept as `profileCode` |
| `Item Description` | full description (e.g. `VINYL SHEET PILE 735X300X12X5500`) → **this is the displayed `profile`** (falls back to `Profile Name`) |
| `No of Profiles` | MTO = pile count for the chainage |
| `New SAP Code` | **join key to material** (`Item Code`) |
| `name` | e.g. `SHP-ZN-01-32+800` — **join key to progress history** |
| `Zone_Id` | e.g. `ZONE_35` — WBS zone level (§6.6) + Map |
| `Length (mm)`, `Area (sqm)` | per-chainage dims → xer UDFs + "length covered" |

`geo` → each feature's `seg`/`mid` (boundary line + midpoint) for the Map.

### 3.2 `data/manpower_resources.xlsx` — 3 sheets

One row per **shift-date**. Sheets: `Machine Status` (`Shift Date`, `Machine Type`,
`Machines Available`), `Manpower Status` (`Shift Date`, `Manpower Available`),
and `Shifthour Status` **or** `Manhour Status` (`Shift Date`, `Manhour` = shift hours).
Dates like `12-Jun-2026`. A small `fixDuplicateShiftDate` normalization shifts the first
of any duplicated shift date back one day (removable once source data is clean).

### 3.3 `data/material_avalibility.xlsx` — sheet `Planner tool Input`

Two-row header: row 1 top-level names, row 2 the sub-headers under
`Actual Arrived Quantity` → `Accepted at site` / `Damaged`. Columns used:
`Item Code`, `Item Name`, `Quantity`, `Expected Arrival`, `Actual Arrived Date`,
`Actual Arrived Quantity` (= **Accepted at Site**), `Status`.

Per row, keyed by `Item Code` (→ chainage `New SAP Code`):

- **`Status == "Delivered"`** → material is **on site now**. Usable = **Accepted at Site**
  quantity (**Damaged excluded**); if that cell is blank, fall back to the ordered
  `Quantity`. `maxReceipt` tracks the latest `Actual Arrived Date` among delivered rows.
- **Any other status** (on-hold, under-dispatch, blank, …) → **inbound**: expect the
  ordered `Quantity` to land on the `Expected Arrival` date, usable on **arrival + 1 day**.
  Inbound rows with no `Expected Arrival` are skipped (can't be placed on the calendar).

"Accepted at Site" = **gross received** (not remaining), so consumption is netted off in
§5.3.

### 3.4 `data/progress_history.xlsx` — sheet `Progress history`

Rows where `Sub Activity == "Sheet Pile Installed"` give `Value` = piles installed on
`Date`, per chainage `Name`. **Only current rows count: skip `Reset == TRUE`** (those are
superseded "clear_history" duplicates; the `Reset == FALSE` rows sum exactly to a
chainage's MTO when complete — counting both roughly double-counts). The parser produces:

- `installedByDate` — piles/day (feeds the productivity baseline, §4);
- `installedByChainage` — total piles already installed per chainage `Name` (§5.2 netting);
- `lastInstallByChainage` — **latest install date** per chainage (the work-front anchor, §5.2).

---

## 4. Input screen & defaults

The **7-day window** ends on the latest `Shift Date` (anchor) and covers that day + the 6
prior calendar days. Averages divide by 7.

**Human-input-error correction (imputation):** if a day has piles installed but **no**
machine/manpower/manhour shift entry, it's treated as a forgotten shift, not a real zero
— each series is filled from the **average of the last 15 available data points** on/before
that day. This keeps the machine/manpower/workhour averages and the productivity ratio
honest (otherwise weekend catch-up entries deflate hours and inflate productivity).

Defaults (all editable): **Machines / Manpower / Workhours** = window averages (rounded);
**Productivity** = `piles in window ÷ Σ(daily machines × workhours)`; **Plan Start** =
first Monday after the latest dated record across inputs (Mondays only). **Plan Period**
2 / 3 weeks (segmented toggle). **Work Days/week** 5 / 6 / 7 (default 6). **Ramp-up**
settings (n, per-day multipliers, machines-from-previous-plan). **Hindrances** list
(plan-wide; per-day picker).

**Greyed computed defaults:** auto-computed fields (Machines, Manpower, Workhours,
Productivity, Start) render **greyed/italic** with an "Auto (…)" hint. When the planner
edits one, it turns **solid navy with a gold edge** and the hint switches to
**"Edited · auto was X"** so the original value stays visible.

**Cap:** 6 people per machine — effective machines auto-capped to `floor(Manpower ÷ 6)`
(notice shown, not blocked).

---

## 5. Planning engine (`js/engine.js`, run on Generate Plan)

### 5.1 Working calendar
Days in the 2/3-week span matching Work-Days/week; hours = Workhours; hindrances applied
per §5.5.

### 5.2 Candidates, prior-progress netting & sequencing
- Candidates = chainages of the selected priority.
- **Prior progress netting:** per chainage, `remaining = MTO − alreadyInstalled`
  (from §3.4). **Completed** (remaining ≤ 0) chainages **drop out** of the plan;
  **active** (remaining > 0) are planned for their *remaining* piles only; **partial** =
  had progress but not finished.
- **Blocked** = active chainages whose profile has **no usable material** (§5.3).
- **Sequencing (queue order):**
  1. **Profiles ranked by material availability** — net on-site (Accepted-at-Site)
     descending;
  2. within a profile, **partially-installed chainages first** (finish started work);
  3. then **untouched chainages nearest to the work-front anchor** — the chainage with the
     **most recent progress date** (`lastInstallByChainage`); so the crew advances
     contiguously from where it last worked;
  4. ties broken by `Chainage_Id`.
- **One machine per chainage**; up to *deployed* chainages progress in parallel.

### 5.3 Material model
- **"Accepted at Site" is gross received**, so **net on-site** for a code =
  `Accepted-at-Site − already-consumed`, where already-consumed = piles already installed
  across **all** chainages (any priority) using that code (shared pool).
- **Starting stock** = net on-site. **Replenishments** = inbound that **arrives on/after
  the plan start** (`arrival ≥ planStart`), applied on its usable date (arrival + 1 day).
  **Overdue on-hold material** (arrival before the window, not delivered) is **excluded
  entirely** — it isn't physically on site.
- Installation consumes stock (1 pile = 1 unit); a chainage progresses each day only up to
  that day's available stock. No usable material ⇒ **blocked**.

### 5.4 Productivity, ramp-up & cost-optimization
- Steady per-machine daily capacity = `Productivity × Workhours`.
- New machines (beyond "machines from previous plan") ramp via the per-day profile; the
  rest run at steady-state.
- Daily capacity = Σ deployed machines, bounded by per-day material and remaining MTO.
- **Cost-optimization:** deployed = the **fewest** machines (≤ manpower cap) that still
  install as many piles as the window can absorb; idle extras are recommended away.

### 5.5 Hindrances
Plan-wide. Day-type removes working days (selected days, else earliest); hour-type trims
hours. Impact surfaced in the plan + a "Hindrance impact" note in Validation.

### 5.6 Cross-plan persistence
On Generate, store the deployed machine count (localStorage); default
"machines from previous plan" to it next run. "Reset stored history" control provided.

### 5.7 Forecast completion for the whole priority
Two dates, both projecting the **recommended crew + productivity + work-week**:
- **Est. finish (as per material availability):** replay the plan forward past the window
  (cap ~2 years), honoring the real **material-arrival timeline**, until nothing more can
  be installed. The last install date = **reachable finish**; report how many piles still
  **need more material** (blocked / not-yet-arrived) and whether it exceeds the horizon.
- **Est. finish (all material available):** rate-only —
  `ceil(remaining piles ÷ (Productivity × Workhours × deployed))` working days from the
  plan start (respecting Work-Days/week). This is *later* than the material date when
  supply is the bottleneck, because it completes **everything**.

---

## 6. Output

Header **view toggle**: **Gantt (default)** ⇄ Material ⇄ Table ⇄ Map. The inputs sidebar
**auto-collapses** on Generate (toggle with "Show/Hide inputs"); Gantt & Map re-render to
the available width when it toggles. The header **"Export plan"** button (shown once a
plan exists) exports the `.xer` (§6.6).

**Plan summary** (top of the Plan card): a one-line headline, then **KPI tiles** —
*Piles this window*, *Scope complete %*, **Length covered** (km of wall, proportional to
piles installed incl. prior; replaces the old "chainages complete" count), *Chainages
covered*, *Carry-over* — then a **Forecast completion** group with the two §5.7 dates
(gold = current material, green = all material).

### 6.1 Table view
One row per (working day × chainage worked). `Cum.` and `MTO`/`%` are **totals**
(prior + this plan), so per-day installs start from the chainage's prior progress.
Group by date / chainage / machine; hindrance days marked.

### 6.2 Gantt view (default)
Rows = worked chainages (color by profile or machine). Columns **size to the panel width**
and re-flow on sidebar toggle. Inbound-arrival markers + hindrance days on the timeline;
per-bar % fill (total completion).

### 6.3 Validation panel
- **Resources** — machines chosen vs manpower-capped vs deployed; utilization; idle.
- **Productivity & ramp-up** — steady value, ramp, effective daily capacity.
- **Material** — inbound-arrival chips; a **"View blocked on map"** button (→ Map with the
  *blocked* filter). *(The old per-profile material table was removed — see the Material
  tab §6.4.)*
- **Hindrance impact** (only if hindrances set).
- **Warnings** — cap applied, shortfalls, blocked (no usable material), hindrance loss, etc.
- *(The "Plan feasibility" section was removed — its figures live in the plan summary.)*

### 6.4 Material tab
Pivot: rows = profiles (item codes), columns = plan days, each day split into
**Avail / In / Used**:
- **Available** = net Accepted-at-Site stock **+ inbound already received**, **− what the
  plan has consumed on earlier days** (balance carried into the day). Overdue pre-window
  material is excluded.
- **In** = qty **arriving** that day (its Expected Arrival); it rolls into Available the
  **next** day (arrival + 1).
- **Used** = piles the plan installs that day; balance carries to the next day.

### 6.5 Map view
WebGL (three.js) with an SVG fallback. Chainages coloured by category, drawn over the full
grey site boundary:
- **Completed (from progress)** — fully done per progress history (no machine/date shown);
- **Partially done (from progress)** — started but unfinished, not scheduled this plan;
- **Scheduled this plan** — worked this window (carries machine + dates);
- **In scope (not scheduled)**; **Blocked (no material)**; **Other priorities** (boundary).

Legend entries are a **multi-select filter** (toggle several on/off; none = show all).

### 6.6 Export plan → Primavera P6 `.xer` (`js/xer.js`)
Tab-delimited P6 XER matching the taskmapper sample: `ERMHDR` line, then
`%T`/`%F`/`%R` table blocks, ending `%E`. **CRLF, ASCII, no BOM.**

- **WBS hierarchy:** Root `Kutch RE Z2 - Sheet Pile` → **Priority** → **Zone** (`Zone_Id`)
  → **Profile** (Item Description); chainages are the **TASK** activities under each profile.
- **One task per scheduled chainage** (window); `target/early/late/rem_late/restart/reend`
  dates all = its planned start/finish; status `TK_NotStart`.
- **Resources:** one `RT_Equip` per deployed machine + one `RT_Labor` crew; assigned per
  task with `target_qty` = piles. **FS links** chain each machine's chainages in order.
- **UDFs** on each task: `Quantity Nos`, `Pile Type`, `Length Km`, `Area SqMtr`, `Notes`.
- **Validity rules:** empty **date** fields break P6 parsers (`datetime('')`), and empty
  **numeric** fields break them (`float('')`) — so every date the sample populates is
  filled, and numeric fields default to `0` (except `parent_wbs_id`, which stays empty on
  the root or the WBS tree orphans).

---

## 7. Design

Reliance identity — deep **navy** (`#040F52`) + **gold** (`#D2AB67`), a touch of New-Energy
**green**. Current look:
- **Deep-blue colourful canvas** (navy/indigo with soft green/gold/blue glows); white/light
  cards float on it.
- **Cards** = deep-navy header band (white title, gold tick + gold underline) over a softly
  tinted body.
- **Glassy navy taskbar** with a glowing gold accent line; gold active view-tab; gold CTAs.
- **Fonts:** Sora (display: headings, hero numbers), Inter (body/tables, tabular figures).
- Segmented toggles, pill tags, greyed→gold "edited" inputs. All tokens in CSS `:root`.

---

## 8. Acceptance / self-check

With the bundled data auto-loaded and no priority chosen, inputs show the **greyed**
7-day defaults (Machines/Manpower/Workhours/Productivity/Start), with imputation applied to
install-days that lack a shift entry. Then:

- Manpower `< 6 × machines` shows the cap notice; the engine uses the capped count.
- Generating a priority nets off already-installed piles (completed chainages excluded),
  installs against **net Accepted-at-Site + in-window arrivals only**, sequences
  **partials → nearest-to-latest-worked → Chainage_Id** within material-ranked profiles,
  and never exceeds per-day material.
- Blocked chainages are reachable via **View blocked on map**; the Map shows completed /
  partial / scheduled categories with multi-select filters.
- Summary shows the 4 KPIs + **length covered** + the two **forecast** dates.
- **Export plan** produces a P6-parseable `.xer` with the Root→Priority→Zone→Profile WBS.
