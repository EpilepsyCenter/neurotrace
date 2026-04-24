# Batch analysis + Prism export — plan

Scenario: user has N recordings (one per cell), each already analysed
with its own `<file>.neurotrace` sidecar. They want **one command**
to aggregate across cells + experimental groups and drop a
Prism-ready file.

## Decisions

| Item | Decision |
|---|---|
| **Grouping source** | Sidecar tag (`meta.group_tag`) is the default; Batch-export dialog lets the user override per-row. Option **A + C** from the initial discussion. |
| **Series role tagging** | Each series in each cell carries a free-text role (`TP_pre`, `IV`, `events_baseline`, `events_drug`, `TP_post`, …). Stored in sidecar `meta.series_roles`. Export references roles, not series indices — so protocols at different positions across cells still line up. |
| **Number of experimental groups** | Arbitrary. `group_tag` is a string; any distinct values become columns in the export. |
| **Per-cell unit** | One file = one cell for the first milestone. Upgradable to one-HEKA-group-per-cell later (multi-cell-per-file recordings). |
| **Export format** | **One `.xlsx` per analysis type** (events.xlsx, ap.xlsx, iv.xlsx, …) dropped into a chosen output folder, plus a `_cells.xlsx` metadata file. Keeps each workbook to ≤ 30 sheets; scales cleanly as analyses grow. User picks the inner layout: **(a) Prism-ready** = one sheet per metric × role, 3-column grouped-table shape ready to paste into Prism, or **(b) Excel-friendly** = one sheet per role with all metrics as column groups. Default = Prism-ready; toggle persisted in prefs. |
| **Future export formats** | `.pzfx` (Prism native XML) — phase 4. Multi-file CSV zip — not planned unless someone asks. |
| **Scope** | End-to-end MVP in one session: sidecar metadata → summariser backend → batch dialog → xlsx writer. PZFX deferred. |

## Sidecar schema extensions

Added under `meta:` (flat so schema-v1 readers tolerate unknown keys):

```json
{
  "meta": {
    "group_tag": "WT",
    "cell_id": "2026-04-24_cell02",
    "notes": "clean Rs, no rundown",
    "series_roles": {
      "0:0": "TP_pre",
      "0:1": "IV",
      "0:2": "events_baseline",
      "0:3": "events_drug",
      "0:4": "TP_post"
    }
  }
}
```

All fields optional. Legacy sidecars without `meta` still load; missing
fields fall back to sensible defaults (group = "", role = "", cell_id
= file stem).

## UI touch points

### Whole-cell metadata

Single compact strip under the file name in the main window's top
bar (or in the status bar). Three inputs:

- **Group** — short text field, auto-saves
- **Cell ID** — short text field, defaults to file stem
- **Notes** — expandable textarea (click to open)

### Per-series role

In the tree sidebar, each expandable series row gets an inline
role-tag chip next to the sweep count. Click → inline text input.
Shared dropdown of "recent roles" so typing the same value across
cells is fast.

Also exposed in every analysis window's top bar (next to the Series
selector) so the user can set it while running the analysis.

## Summariser backend

New module `backend/analysis/batch.py` with per-analysis extractors.
Each takes the raw analysis blob (e.g. `EventsData`) + returns a flat
`dict[str, float | None]` of per-cell summary metrics.

```python
def summarise_events(events: EventsData) -> dict[str, float | None]:
    return {
        "n_events":       len(events.events),
        "rate_hz":        len(events.events) / events.total_length_s,
        "amp_mean":       mean([e.amplitude for e in events.events]),
        "amp_sd":         sd([e.amplitude for e in events.events]),
        "rise_mean_ms":   mean(x.rise_time_ms for x in events.events if x.rise_time_ms),
        "decay_mean_ms":  mean(...),
        "tau_decay_mean": mean(...),
        "fwhm_mean_ms":   mean(...),
        "iei_mean_ms":    mean_iei(...),
    }

def summarise_ap(ap: APData) -> dict[str, float | None]: ...
def summarise_iv(iv: IVCurveData) -> dict[str, float | None]: ...
def summarise_resistance(m: list[ResistanceMeasurement]) -> dict[str, float | None]: ...
def summarise_bursts(bursts: FieldBurstsData) -> dict[str, float | None]: ...
def summarise_fpsp(fpsp: FPspData) -> dict[str, float | None]: ...
```

New endpoint **`POST /api/batch/summarise`**:

```json
// Request
{ "file_path": "/path/to/cell01.dat" }

// Response
{
  "cell_id": "cell01",
  "group_tag": "WT",
  "file_path": "/path/to/cell01.dat",
  "cells": [   // one entry per HEKA group (usually just one)
    {
      "heka_group": 0,
      "series": [
        {
          "series_index": 2,
          "role": "events_baseline",
          "analyses": {
            "events": { "rate_hz": 12.3, "amp_mean": -25.1, ... }
          }
        },
        ...
      ]
    }
  ]
}
```

Backend just reads the sidecar; no re-analysis needed.

## Batch-export dialog (new Electron window)

Menu: **File → Batch export…**

### Step 1 — pick files

Folder picker ("recursive" checkbox) OR multi-file picker. App scans
for recordings that have a `.neurotrace` sidecar next to them.

### Step 2 — cell table

One row per (file × HEKA group). Columns:

- Filename (click to open in main window — read-only preview)
- Cell ID (editable — writes back to sidecar)
- **Group tag** (editable, autocompleted from other rows)
- Series roles summary (read-only, truncated list)
- Button `Edit roles…` — opens a sub-dialog to view / edit the
  series-role mapping for that cell

User can toggle rows off (checkbox per row) to exclude.

### Step 3 — pick metrics

Tree view, collapsible by analysis type:

```
▸ Events
    ☑ rate_hz
    ☑ amp_mean
    ☐ amp_sd
    ☑ rise_mean_ms
    ...
▸ AP
    ☐ rheobase_pa
    ...
▸ Resistance
    ☑ rs_mean
    ...
```

For each checked metric, a **role filter** dropdown next to it:

- `<any>` — pull from every series of that analysis type
- `events_baseline`, `events_drug`, … — populated from the role tags
  seen across selected cells

### Step 4 — preview + export

Preview table: rows = cells, columns = metrics (only the checked
ones). Missing values flagged. Sanity-check.

Click **Export…** → save-as dialog → writes `.xlsx`.

## xlsx writer

`backend/export/prism_xlsx.py`. Uses `openpyxl`.

### File layout

User picks a destination FOLDER. The writer creates one workbook per
analysis type, each named after the analysis (`events.xlsx`,
`ap.xlsx`, `iv.xlsx`, `resistance.xlsx`, `bursts.xlsx`, `fpsp.xlsx`).
Files without matching data in the selection are skipped entirely.

Always also writes `_cells.xlsx` in the same folder: one row per
included cell, columns = file path, cell_id, group_tag, notes,
available series roles. Self-documents the export.

### Inside each workbook — two modes

**Mode A — Prism-ready (default)**

One sheet per `<role>__<metric>` pair (role omitted for analyses
without roles, like resistance).

Sheet layout:

| WT          | HET         | KO          |
|-------------|-------------|-------------|
| 12.3        | 8.1         | 4.2         |
| 15.7        | 9.4         | 3.9         |
| 11.2        | 8.8         |             |
| 13.8        |             |             |

Row 1 = group names (ordered). Row 2+ = cell values, sorted by
`cell_id` within each group. Blanks = missing (either the cell has
no matching role, or the metric couldn't be computed).

Paste directly into Prism → New Table → Grouped.

Typical count: 10–30 sheets per file. Sorted alphabetically:

```
baseline__amp_mean
baseline__decay_mean_ms
baseline__fwhm_mean_ms
baseline__rate_hz
baseline__rise_mean_ms
drug__amp_mean
drug__decay_mean_ms
...
```

**Mode B — Excel-friendly**

One sheet per role. Within the sheet, ALL metrics laid out as column
groups. Layout:

| rate_hz (WT) | rate_hz (HET) | rate_hz (KO) | amp_mean (WT) | amp_mean (HET) | … |
|--------------|---------------|---------------|----------------|-----------------|---|

Same cell → row relationship; easier to scan / pivot in Excel; Prism
paste works but requires selecting a sub-column-range per metric.

### Format toggle

Persisted in prefs under `batchExport.layout = 'prism' | 'excel'`.
Defaults to `prism`. Lives in the export dialog's step 3.

### Always-on safety rails

- Missing values → blank cell (Prism's "no data" convention).
- Unicode-safe cell values; units in sheet names rather than cell
  values so numerics stay numeric.
- `_cells.xlsx` flags any row whose sidecar lacked the requested
  role — user sees exactly which cells were partially excluded.

## Phased delivery (all in one session)

1. **Phase 0 — sidecar metadata + top-bar UI** (~30 min)
   Extend sidecar schema with `meta`. Add a whole-cell metadata strip
   in the main window + inline series-role chips in the tree.

2. **Phase 1 — summariser backend** (~45 min)
   `backend/analysis/batch.py` with one extractor per analysis type.
   `/api/batch/summarise` endpoint.

3. **Phase 2 — batch-export window** (~1 hr)
   New Electron analysis window type `batch_export`. Steps 1–4 above.
   File picker, cell table editable, metrics tree, preview.

4. **Phase 3 — xlsx writer** (~30 min)
   `backend/export/prism_xlsx.py`, invoked by `/api/batch/export` or
   returned directly from the export step.

## Deferred (not in this sprint)

- **"Combine into single xlsx"** toggle — concatenates all analysis
  workbooks into one for email-a-cohort scenarios. Easy to add
  later; skip until someone asks.
- `.pzfx` direct Prism-XML export
- "Save batch config" → reusable for repeat exports
- Summary-plot preview (mean ± SEM bar chart per metric/group)
- Cross-file param re-run ("rerun AP detection with these params on
  every cell in this folder")
- Per-HEKA-group (multi-cell-per-file) splitting

## Open threads to return to

- How far back do existing exports already work? The Events window
  has a CSV export; AP/FPsp/IV have their own. Consider whether the
  per-analysis-window exports should eventually go through the same
  summariser so the columns match what batch gives.
- Prism-column ordering: should groups be sorted alphabetically or
  in first-seen order? Probably an export-dialog toggle.
- Missing-data policy: blank cell, NaN, or `"NA"`? Prism treats
  blanks as "no data" — that's the right default.
