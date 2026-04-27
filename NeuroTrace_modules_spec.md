# NeuroTrace — Modules Specification & Implementation Plan
*Drafted 2026-04-26 · Implementation plan finalised 2026-04-27*

This document is the canonical plan for the multi-recording workflow.
It supersedes the earlier `BATCH_EXPORT_PLAN.md`.

---

## Overview

Three composable modules that share the `.neurotrace` sidecar as
their data foundation:

1. **Metadata** — tag files and series before any cross-recording
   work. Foundation for everything below.
2. **Cohort Analysis** — aggregate, run statistics, and produce
   lab-meeting-ready graphs + Prism / Excel exports across recordings.
3. **Trace Export** — publication-ready representative traces
   (single sweeps, overlays, averages, before/after, dual-axis).

Linear data flow:

```
.neurotrace files
   → Metadata tagging
       → Cohort Analysis  → graphs + stats panel
                          → .pzfx / .xlsx (Prism + Excel)
       → Trace Export     → SVG / PDF / PNG figures
```

Each module is independent of the next *except* both consumers
require Metadata to be in place.

Implementation runs in three phases, each commit-able and
independently shippable:

- **Phase A — Metadata** (foundation)
- **Phase B — Cohort Analysis** (statistics + export)
- **Phase C — Trace Export** (figures)

---

## 1. Metadata Module

### Purpose

Allow users to assign **file-level** and **series-level** tags to
`.neurotrace` files. Tags are the foundation of Cohort Analysis —
files without tags can't be grouped for comparison; series without
tags can't be sliced by experimental phase.

### Tag types

**File-level (multi-tag).** Describe the recording as a whole.
Multiple orthogonal tags per file, e.g. `["wildtype", "male", "P30",
"vehicle"]`. Used by Cohort Analysis to resolve unpaired group
comparisons across files.

**Series-level (multi-tag).** Describe the protocol or experimental
phase a single series captures, e.g. `["baseline", "field"]`,
`["treatment", "drug-XYZ"]`, `["TP_pre"]`, `["IV"]`. Used for paired
comparisons within a recording and to pick the right series at
export time when protocol order varies between cells.

Both are free-text arrays — no rigid enum. Consistency comes from
autocomplete and the consistency checker (below), not schema.

### Status indicator

Every file in the tree sidebar gets a small coloured dot:

- **Red** — file has *no* tags at all (neither file nor series).
- **Yellow** — file has file-level tags but at least one series is
  untagged. (Or vice versa.)
- **Green** — file has file-level tags AND every series in the file
  carries at least one tag.

Tooltip on hover lists exactly what's missing. Drives users toward
green before they try Cohort Analysis on the folder.

### Tag editing

- Open any `.neurotrace` file — tags are editable in the metadata
  strip in the main window's top bar (file-level) and in the tree
  sidebar (series-level chips next to sweep counts).
- Same controls also exposed in every analysis window's top bar.
- Editing tags **never re-runs analyses** — pure metadata.
- Auto-saved through the existing sidecar debounce (1 s) — no
  explicit save button.

### Batch tagging

- Multi-select files in the file-explorer / tree.
- "Apply tags to selection…" action: pop a small modal with the
  same tag-editor UI; tags entered there get appended to every
  selected file's `meta.group_tags`.
- Essential for cohorts of 20+ recordings — no one wants to tag
  one at a time.

### Tag autocomplete

- When tagging a file, autocomplete suggests tags already used in
  other `.neurotrace` files in the same folder.
- Suggestions ranked by recency-of-use within the folder.
- Press Tab/Enter to accept. Free-text entry still allowed for new
  tags.

### Tag consistency checker

- Folder-level screen accessed from the tree-sidebar header
  (`Tags…` button) or from Cohort Analysis as a pre-flight check.
- Lists all unique tags in use across the folder, with usage counts.
- Flags **near-duplicates** by case-insensitive equality + edit
  distance ≤ 2: `WT` vs `wildtype`, `Baseline` vs `baseline`,
  `treatement` (typo) vs `treatment`.
- Each flagged group gets a "Merge to…" action that rewrites every
  matching tag across every sidecar in the folder.
- **Cohort Analysis refuses to run** if the active selection
  contains unresolved near-duplicate flags. The user gets a one-click
  jump to the consistency checker to fix them first.

### Sidecar schema extensions

Adding a `meta` block (the existing `cursors` / `analyses` etc.
stay untouched):

```json
{
  "format": "neurotrace-sidecar",
  "version": 1,
  "meta": {
    "cell_id": "cell_2026_04_24_01",
    "notes": "clean Rs, slight rundown after sweep 50",
    "group_tags": ["wildtype", "male", "P30", "vehicle"],
    "series_tags": {
      "0:0": ["TP_pre"],
      "0:1": ["IV"],
      "0:2": ["baseline", "mEPSC"],
      "0:3": ["treatment", "mEPSC"],
      "0:4": ["TP_post"]
    }
  },
  "analyses": { … },
  …
}
```

All `meta` fields optional. Legacy sidecars without `meta` still
load — they show as red-status until tags are added.

`cell_id` defaults to the file stem when missing. `notes` is a
free-text scratch field, exported in the audit trail.

---

## 2. Cohort Analysis Module

### Purpose

Fast, in-app, lab-meeting-ready statistical comparison across
recordings. Inputs: tagged sidecars from a folder. Outputs: graphs
on screen + a Methods-section blurb + Prism/Excel files.

Not a Prism replacement for publication. The point is to compress
"export → Prism → import → choose test → make graphs" into a single
workflow that ends with both an in-app overview *and* a clean Prism
file ready to refine.

### Entry

`File → Cohort Analysis…` menu item, or button in the main toolbar.

### Flow

1. **Pick folder.** App scans for `.neurotrace` files; reports any
   that are missing tags or have unresolved consistency-checker
   flags. Refuses to proceed until those are clean.

2. **Pick analysis type.** Dropdown of analyses for which at least
   one selected file has results: Events, AP, fEPSP, I-V,
   Resistance, Bursts.

3. **Pick comparison shape.** Two-state radio:
   - **Within recordings** — paired across series tags within each
     file (e.g. `baseline` vs `treatment` for the same cell).
   - **Between groups** — unpaired across files (e.g. `wildtype`
     vs `knockout`).

4. **Pick the tags to compare.**
   - Within: multi-select series tags (≥ 2). Each selected tag
     becomes one bar / column.
   - Between: multi-select file-level tags. Tags must be on the
     SAME taxonomic axis (e.g. genotype, not genotype+sex). UI
     enforces this with a tag-axis grouping.
   - Free-text "filter" field: optional, narrow the universe of
     considered files (e.g. "male" + "P30" before picking
     genotype).

5. **What is N?** Explicit prompt, single-select:
   - sweep / series / slice / animal
   - Default suggestion based on detected design
   - Critical for avoiding pseudoreplication; choice surfaces in
     the audit trail and Methods blurb.

6. **Design preview.** App shows: `n_per_group`, `groups`, design
   name, **the test it will run**, and why. User confirms before
   anything's computed.

7. **Run.** Backend pulls the relevant metric from each cell's
   sidecar, applies the test, returns numerics + graph data.

### Statistical design inference

Inferred automatically from the data structure (selected tags +
N-choice):

| Design | Test (normal) | Test (non-normal) |
|---|---|---|
| 1 file × 2 series tags | Paired t-test | Wilcoxon signed-rank |
| Many files × 2 group tags | Unpaired t-test | Mann-Whitney |
| 1 file × ≥3 series tags | Repeated-measures ANOVA | Friedman |
| Many files × ≥3 group tags | One-way ANOVA + post-hoc | Kruskal-Wallis + post-hoc |
| Mixed designs | Two-way / mixed ANOVA | Aligned-rank ART |

Normality assessed via Shapiro-Wilk on each group; if any group
fails (p < 0.05), the non-parametric branch runs. All stats via
**Pingouin**. Post-hoc: Tukey for ANOVA, Dunn for Kruskal-Wallis.

### Curated metric preset (default selection)

To skip the "check 50 boxes" ritual, the metric tree opens with a
curated preset of the metrics most commonly reported in figures.
Everything else is visible, off, one click away.

| Analysis | Pre-checked metrics |
|---|---|
| **Events** | `rate_hz`, `amp_mean`, `rise_mean_ms`, `decay_mean_ms`, `tau_decay_mean_ms`, `n_events` |
| **AP** | `rheobase_pa`, `threshold_mean_mv`, `ap_amp_mean_mv`, `fwhm_mean_ms`, `fi_slope_hz_per_pa`, `max_rate_hz` |
| **I-V** | `slope_near_rest`, `input_resistance_mohm`, `reversal_potential_mv` |
| **Resistance** | `rs_mean`, `rin_mean`, `cm_mean` |
| **Bursts** | `burst_count`, `rate_per_min`, `duration_mean_ms`, `peak_mean` |
| **fPSP — LTP** | `baseline_slope_mean`, `post_tetanus_slope_mean`, `pct_potentiation_at_30min` |
| **fPSP — PPR** | `ratio_mean`, `isi_ms` |
| **fPSP — I-O** | full XY curve (handled separately) |

Selection persisted per-user under `prefs.cohortAnalysis.metricSelection`
across runs. **Reset to defaults** button reverts to the curated
preset. Named presets ("Save as…") deferred — schema accommodates
them when the UI lands.

### Per-metric role filter

Next to each metric checkbox, a dropdown that selects which series
tag(s) the metric should pull from. `<any>` averages across all
matching series; specific tags (`baseline`, `treatment`, …) restrict
to that role.

For Cohort Analysis, the role filter is what couples to the series
tags chosen in step 4. UI keeps the two synchronized: switching the
"compare these tags" selection auto-updates the per-metric role
filters.

### Output — graphs panel

- One graph per selected metric, displayed simultaneously as a
  scrollable panel (lab-meeting-ready).
- **Dot plots with mean ± SEM overlay** — every individual point
  visible. Never bar-only. Bars are forbidden by lab convention.
- p-value annotation on each graph; `*` / `**` / `***` markers
  on bars connecting compared groups.
- Click a graph → opens a fullscreen single-graph view with axes
  control, group-color overrides, point labels.
- Export the graph panel as one composite SVG / PDF / PNG.

### Output — statistics table

Adjacent to the graph panel, a table:

| Metric | Group | N | Mean ± SD | Test | Stat | p | Effect size |
|---|---|---|---|---|---|---|---|

Plus a **Methods blurb** below — auto-generated paragraph pasteable
into a manuscript:

> *Inter-event intervals were compared between wildtype (n = 12) and
> knockout (n = 14) using an unpaired t-test (Shapiro-Wilk
> p = 0.21 / 0.18). Significance was set at p < 0.05. Statistical
> tests performed in Pingouin v0.5.x. N is the experimental unit
> (animal).*

### Output — files

Output is a chosen folder containing:

```
events_comparison.pzfx        ← Prism native
events_comparison.xlsx        ← Excel-friendly
ap_comparison.pzfx
ap_comparison.xlsx
…
_cohort_audit.json            ← full audit trail
_cohort_summary.html          ← graphs + stats + blurb, self-contained
```

#### Prism (.pzfx)

Native Prism XML. Each metric → its own grouped table. Raw
replicates only — Prism calculates SD/SEM/CI itself. One `.pzfx`
per analysis type.

#### Excel (.xlsx)

One workbook per analysis type. **Two layout modes**, toggle in
the export dialog (persisted under `prefs.cohortAnalysis.xlsxLayout`):

- **Mode A — Prism-ready (default)**: one sheet per role × metric,
  3-column-per-group grouped-table shape. Paste into Prism →
  Grouped table. Direct route for users who go to Prism anyway.
- **Mode B — Excel-friendly**: one sheet per role; all metrics laid
  out as column groups; metadata columns preserved (cell_id, group
  tags, series tags). For users who pivot in Excel.

Both modes always also write `_cells.xlsx` listing every contributing
cell with its metadata — the export is self-describing.

### Audit trail

Every export writes `_cohort_audit.json` capturing:

- Folder scanned, cell IDs and file paths included
- Tags used to define each group
- Per-cell series-tag → series-index resolution (which series
  contributed to which role for which cell)
- Statistical test chosen, why, and the design inference logic
- N choice (sweep / series / slice / animal) and N per group
- Pingouin version + NeuroTrace version
- Timestamp

Lets a reviewer or future-you reconstruct any export exactly.

---

## 3. Trace Export Module

### Purpose

Publication-ready representative traces directly from NeuroTrace.
Eliminates screenshotting + Illustrator manual-scalebar work.

### Trace selection

- Pick recordings (multi-select from a tree).
- Per recording, pick sweeps:
  - Single sweep
  - Multiple sweeps for overlay
  - Range → average trace, optionally with individual sweeps drawn
    underneath in light grey
- Cross-recording overlay: pull sweeps from different files into
  one figure (e.g. baseline vs LTP from two cells).

### Layouts

- **Single panel** — one trace or overlay
- **Stacked panels** — multiple traces stacked vertically with
  shared x-axis (synchronized time)
- **Side-by-side** — two panels horizontally
- **Dual-axis** — patch + field on the same panel, separate y-axes,
  shared x

### Trace processing (export-time only — never modifies sidecar)

- **Baseline correction** — subtract median of a user-defined
  pre-event window
- **Stimulus artifact blanking** — interpolate or hide a window
  around stim TTL
- **Filtering** — same Butterworth params as analysis pre-detection,
  optional separate low-pass for display
- **Down-sampling** — for SVG file-size sanity on long sweeps;
  decimation preserves peaks
- **Color control** — per sweep, per overlay group, or theme-default

### Scalebars

- Replace axes entirely (e-phys publication standard).
- Auto-scaled from sidecar metadata: sampling rate, units, gain.
- User specifies scalebar VALUES (e.g. "5 ms, 50 pA"); app draws
  bars of the correct pixel length.
- L-shape, corner-anchored, customizable position + thickness.

### Export formats

- **SVG** — primary; fully vector; editable in Illustrator /
  Inkscape.
- **PDF** — alternative vector.
- **PNG** — raster, user-defined DPI (default 300), for slides /
  quick share.

### Templates / presets

Save the current layout + processing settings as a named template
(`"mEPSC representative"`, `"LTP before/after"`, `"AP train at 200
pA"`). Re-apply to a new selection in two clicks. Persisted in
prefs.

---

## Implementation phasing

Each phase is independently shippable. After each, the user has
something useful even if we never get to the next.

### Phase A — Metadata module (foundation)

**Backend**

- Sidecar schema extension: `meta.cell_id`, `meta.notes`,
  `meta.group_tags: string[]`, `meta.series_tags: Record<"g:s", string[]>`.
- Migration: legacy sidecars open without `meta`; status indicator
  shows red until tagged.
- New endpoint `POST /api/sidecar/scan_folder` — given a folder,
  return a list of `.neurotrace` files with their `meta` blocks +
  status (red/yellow/green) + a flat tag-counter for the folder.
- New endpoint `POST /api/sidecar/rewrite_tags` — atomically rewrite
  one tag value to another across all sidecars in a folder. Used by
  the consistency checker's "Merge to…" action.

**Frontend**

- Top-bar metadata strip in the main window: cell_id input,
  group_tags chip-input with autocomplete, notes expandable
  textarea. Auto-saves via the existing 1-s debounced sidecar
  writer.
- Tree-sidebar status dots (red / yellow / green) per file, with
  hover tooltip detailing what's missing.
- Per-series tag chips in the tree, inline editable.
- Multi-select + "Apply tags to selection" action in the tree
  context menu.
- New "Tags…" button in tree-sidebar header → opens the consistency
  checker window. Lists all tags + usage counts; flags
  near-duplicates; offers per-flag "Merge to…" rewrites.

**Deliverable**: users can fully tag a folder of recordings, see
their progress at a glance, and clean up inconsistencies before
running anything cross-file. Phase B/C are unblocked.

### Phase B — Cohort Analysis module

**Backend**

- New module `backend/analysis/cohort.py`:
  - Per-analysis summary extractors (one per analysis type) that
    read a sidecar and produce `dict[metric_name, value]`. Curated
    preset list defined here.
  - Design-inference helper: given selected files + tags +
    N-choice, returns design name + recommended test.
  - Test runner (Pingouin): paired/unpaired t, Mann-Whitney /
    Wilcoxon, RM-ANOVA / Friedman, one-way ANOVA / Kruskal-Wallis +
    post-hoc.
  - Methods-blurb generator: short auto-paragraph with stats
    summary.
- New endpoints:
  - `POST /api/cohort/aggregate` — folder + analysis type + tags
    → flat per-cell metric table
  - `POST /api/cohort/run_stats` — aggregated table + design choice
    → test results + graph data + audit trail
  - `POST /api/cohort/export_pzfx` — produces `.pzfx` files
  - `POST /api/cohort/export_xlsx` — produces `.xlsx` files +
    `_cells.xlsx`
- New deps in `backend/requirements.txt`:
  - `pingouin`
  - `pzfx` (Prism XML writer)
  - `pandas` (already present? confirm during phase)
  - `openpyxl` (xlsx writer)
  - `matplotlib` (for `_cohort_summary.html` rendered graphs)

**Frontend**

- New Electron analysis window `cohort_analysis`.
- Six-step wizard (folder → analysis → comparison-shape → tags →
  N-choice → design preview → run).
- Curated metric tree with role filters; persistence of selection
  in prefs; reset-to-defaults button.
- Graph panel — render Pingouin-fed plots inline (PNG fallback
  acceptable; SVG nicer if tractable).
- Stats table + Methods blurb panel.
- "Export…" button → save-to-folder dialog → `.pzfx` + `.xlsx` +
  `_cohort_audit.json` + `_cohort_summary.html`.

**Deliverable**: end-to-end cohort comparison with publication-grade
inputs to Prism + an in-app graphical / textual report.

### Phase C — Trace Export module

**Backend**

- New module `backend/export/trace_export.py`:
  - Render pipeline: matplotlib figure with custom scalebar
    primitives; SVG / PDF / PNG output via matplotlib backends.
  - Trace-processing helpers (baseline, blanking, filter,
    decimation) — separate from the analysis-module versions so
    publication tweaks never bleed into analysis state.
- New endpoint `POST /api/trace/render` — takes a render-config
  payload, returns the bytes (or path) of the produced figure.

**Frontend**

- New Electron analysis window `trace_export`.
- Trace selector — multi-recording, multi-sweep tree.
- Layout picker (single / stacked / side-by-side / dual-axis).
- Per-trace style controls (color, weight, dash).
- Scalebar config (values, position, thickness, fonts).
- Live preview pane.
- Templates: save / load / list.
- Export button → save dialog → file written.

**Deliverable**: replaces screenshot-then-Illustrator workflow for
the entire "I need a representative trace for figure 2B" task.

---

## Dependencies (new)

| Lib | Purpose | Phase | Bundle impact |
|---|---|---|---|
| `pingouin` | Stats tests | B | ~10 MB |
| `pzfx` | Prism XML export | B | small |
| `openpyxl` | xlsx export | B | ~5 MB |
| `pandas` | Data handling | B | ~30 MB (if not already in env) |
| `matplotlib` | Cohort + Trace plots | B + C | ~40 MB |

Total estimated bundle growth: ~60-90 MB. Within the user's "I
don't care if 100 MB" budget.

---

## Out of scope for this iteration

Recorded so they don't get forgotten:

- **Named metric presets** ("Save as preset…" + dropdown) — schema
  for `metricSelection` is already a shape that scales to multiple
  named entries.
- **`.pzfx` import** (i.e. open an existing Prism file in NeuroTrace).
- **Cross-cell parameter macros** (re-run AP detection with these
  params on every cell in this folder).
- **Per-HEKA-group cell splitting** (multi-cell-per-file
  recordings). Today: one file = one cell.
- **Cohort-level rerun** — Cohort Analysis reads cached sidecar
  results; if a sidecar is missing an analysis the user has to run
  it on that recording first. A future "rerun missing analyses"
  button would automate this.
- **Mixed / two-way ANOVA** designs in Cohort Analysis — supported
  by Pingouin but UI for picking two factors deferred.

---

## Working notes

- Old plan (`BATCH_EXPORT_PLAN.md`) deleted in favour of this doc;
  most decisions captured here. Anything missing → it was rejected
  by the spec.
- "Cohort Analysis" naming is provisional. If the team wants
  something else (Group Stats, Cross-Cell Stats, …), rename in one
  place: the Electron window type + menu label. Module file paths
  use `cohort.py` / `cohort_analysis` as the stable internal name.
- Schema bumps version when we ship Phase A. Define
  `SIDECAR_VERSION = 2` and write a forward-migration that wraps
  legacy sidecars' missing fields in defaults.
