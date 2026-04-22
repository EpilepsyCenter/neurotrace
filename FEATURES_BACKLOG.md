# Features & tweaks backlog

Living list of smaller-than-a-module features and UX polish items we've
brainstormed but not yet scheduled. Size estimates:

- **S** = small tweak, under an hour
- **M** = medium, a few hours
- **L** = bigger, half-session or more

Revisit / prune / promote to `ROADMAP.md` as we pick things up.

---

## Main TraceViewer — UX polish

- **S** — keyboard nav: ←/→ for prev/next sweep, Home/End for first/last, PgUp/PgDn for ±10 sweeps
- **S** — status bar shows live cursor-hovered X (time) and Y (Vm/Im) while hovering the trace
- **S** — right-click context menu on trace: Reset zoom · Copy cursor position · Copy visible X/Y range · Save plot as PNG
- **S** — "Copy plot as PNG" / "Save plot as SVG" button or shortcut (⌘⇧S?)
- **S** — drag-to-select a time range while holding `B` → sets baseline cursor pair; hold `P` → peak; hold `F` → fit
- **M** — crosshair / ruler tool: click-drag to get Δt and ΔV readout between two points (ephemeral, not stored)
- **M** — overlay mode: pick 2+ sweeps (or a range) and display them on the same plot, color-cycled, with a small legend
- **M** — multi-channel overlay: show Vm + Im on the same plot with separate Y axes (currently stim is right axis only)
- **M** — annotations: Alt-click a sample to pin a note at that timestamp; saved per-series; shown as small flags on the trace

## Bugs

- **S** — Main viewer: clicking Average shows the averaged trace but it's time-shifted and on a different X scale from the original sweeps. Affects both "all sweeps" and the new excluded-sweeps path. Likely the backend's average-trace response builds `time = np.arange(n) / sr` from 0 instead of preserving the sweep's real time axis; the frontend then plots it on its own x-range which no longer aligns with the sweep being overlaid. Fix before (or as part of) the planned averaging rework (Feature 2 — multi-select + named averaged sweeps).

## Existing analysis windows — small tweaks

- **M** — Resistance analysis window rework: this was the first analysis window and is showing its age. Bring it in line with the newer ones — cursors drawn inside the mini-viewer and draggable, ←/→ arrows to skim through sweeps, locked-zoom pattern from the Cursor window, per-series persistence via the `group:series` key pattern. Basically make it look and behave like FPsp / Cursor / I-V.
- **S** — FPsp: paired-pulse ratio measurement (2nd response amplitude / 1st) when two stims in one sweep
- **S** — I-V: report reversal potential (linear fit x-intercept) + chord/slope conductance in the summary row
- **S** — I-V: when the stimulus trace is missing (user forgot to record it), ask for manual Im stimulus parameters — `start_s`, `end_s`, `start_pA` (amplitude of the first sweep's step), `step_pA` (increment between sweeps) — and reconstruct the expected Im protocol from those numbers so the curve can still be plotted. Fall back to this when `.pgf` parsing also fails to find Im segments.
- **S** — Resistance: plot Cm vs sweep alongside Rs/Rin in the monitor graph
- **S** — Cursor window: "Copy slot config" / "Paste slot config" to propagate a set of cursors + fit funcs to another series
- **S** — All analysis windows: per-sweep "exclude from analysis" checkbox (toggle in the results table row) that re-runs across the filtered set
- **S** — All result tables: right-click a row → Copy row as TSV (for fast paste into Excel/Prism)
- **S** — All result tables: shift-click to multi-select rows for export/exclude
- **S** — All analysis windows: global decimal-precision setting (currently hardcoded at 3 in most places)
- **M** — Mini-viewer in every analysis window: a small "go to this sweep in main" button on each table row (currently only some windows do this)
- **M** — Save/load analysis templates: dump all params of the current analysis window to a named preset, reload on another file
- **M** — Unify splitter persistence across all analysis windows. AP window already persists `topHeight` to electron prefs under `apWindowUI`; mirror the same pattern (own prefs key, mount-time hydrate, write on splitter `mouseup`) for FPsp / Burst / Cursor / IV / Resistance windows. Each gets its own `<window>WindowUI` slot so they track independently.
- **M** — Multi-trace overlay in analysis-window mini-viewers — let the user toggle additional channels (most importantly the stimulus trace, but also e.g. an Im monitor) into the same mini-viewer the analysis runs against. Mirrors the main viewer's `Traces` dropdown but per-analysis-window. Useful in the AP window to see the current command alongside Vm without leaving the analysis context; also useful in Burst / FPsp for sanity-checking detection vs the stim line.

## Data I/O

- **S** — "Recent files" submenu in the File menu, persisted in preferences
- **S** — Export current sweep (or all sweeps) of current series as CSV — both raw trace and sample times
- **M** — Export an analysis window's result table as XLSX (not just CSV) with sheet per series
- **M** — Drag-and-drop a `.dat` file onto the app window to open it
- **L** — Session save/load: snapshot of open analysis windows, their params, cursor positions, and results into a single `.ntsession` JSON that reopens on a relaunch

## Export & persistence pipeline (Prism / JSON sidecar)

Coherent pipeline from the Apr 21 brainstorm (`NeuroTrace_brainstorming.md`). Items are deliberately ordered so each one builds on the previous — don't start mid-stack.

- **L** — JSON sidecar persistence: after every analysis run, write a `.<recording>.ntjson` file next to the source recording with `{neurotrace_version, created, recording: {source_file, format, date_recorded}, analyses: {<type>: {timestamp, parameters, results}}}`. No user action required. Schema in brainstorm doc.
  - **S** — within that: decide overwrite-vs-append when the same analysis is re-run with different parameters. Recommendation from brainstorm: keep last run initially; consider a versioned list later.
- **L** — GraphPad Prism `.pzfx` export via the `pzfx` Python lib (v0.3.1). New `backend/export/prism.py` with a `PrismExporter` class; one method per analysis type (`fepsp_timecourse`, `input_output`, `paired_pulse`, `iv_curve`, `ap_properties`, `mini_summary`, `burst_summary`, `full_experiment`). **Always export raw replicates, never pre-summarized mean±SEM** — Prism computes stats itself.
- **M** — Multi-file Prism export flow: user selects N `.ntjson` sidecars (or a folder), NeuroTrace groups by analysis type → one Prism table per type, columns = recordings → single `.pzfx`. Depends on the two items above.
  - **S** — parameter-mismatch warnings before multi-file export (e.g. different voltage ranges in IO curves across files): list the diverging params, let the user proceed or abort.
- **S** — Analysis-log sheet in every exported `.pzfx`: software version, commit hash, date, source files, full params used per analysis. Cheap to write, gets quoted in Methods sections.

## Analysis modules — tracked in ROADMAP

These came up in the brainstorm but are module-scale, not tweak-scale — they live in `ROADMAP.md`, listed here only as a reminder they're pending:

- Paired-pulse ratio (single ISI + multi-ISI curves). Distinct from the S-sized "2nd/1st amplitude" measurement already in the FPsp tweaks section.
- Input-output curve (stimulus intensity vs fEPSP slope). Slope only — curve fitting delegates to the existing fitting module.

## Cursors & bands

- **S** — per-series cursor persistence: cursor positions are currently global; store + restore them per (group, series) like other analyses
- **S** — cursor "snap" helpers: double-click a cursor edge → snaps to nearest peak/trough within N ms
- **S** — color-coded cursor legend: tiny widget showing baseline/peak/fit colors + their current windows
- **M** — invert-cursor-pair shortcut: click `B` or similar to swap baseline↔peak windows for quick sign-flip experiments

## Analysis results — bottom panel

- **S** — Results tab: filter rows by analysis type / series via dropdown
- **S** — Results tab: "Clear all results" with a confirm
- **M** — Results tab: group-by analysis type with collapsible sections
- **L** — Card-based bottom panel (already spec'd in `ROADMAP.md` section N+1.5 Part C — bump status if still outstanding)

## Main app polish

- **S** — File info header: show file path on hover of the file name, copy-to-clipboard on click
- **S** — Loading states: skeleton placeholders for the tree, trace, and analysis windows while backend is initializing
- **S** — Backend disconnect banner: red bar at top with "Reconnect" button if `/health` stops responding
- **S** — Keyboard shortcut reference: press `?` anywhere to open a modal listing all shortcuts
- **S** — About dialog: version, commit hash, Python version, backend log path
- **M** — Settings dialog: default filter params, default cursor colors, default analysis parameters, decimal precision, theme
- **M** — Inline tooltips on every control (hover delay ~500 ms) explaining what it does; many exist but inconsistently

## Decimal & locale

- **S** — audit every numeric input: make sure they all use `NumInput` (comma→dot normalization, no browser locale reformatting) — there may still be plain `<input type="number">` stragglers

## Performance

- **S** — cache decoded HEKA `.dat` in memory across window reopens so re-opens of recent files are instant
- **M** — trace fetch debouncing: when wheel-zooming rapidly on continuous data, coalesce fetches
- **M** — prefetch next sweep in the background so arrow-key navigation is seamless
- **L** — move LTTB to a WASM build for long continuous traces (if perf ever becomes a problem)

## Backend quality

- **S** — add py_compile to a pre-commit hook so we never commit a syntax error
- **M** — unit tests for `backend/analysis/*.py` — a handful of synthetic-trace tests per module
- **M** — structured logging: replace scattered `print()` with loguru or stdlib logging with levels, persisted to a log file
- **M** — centralized error responses: `HTTPException` with a JSON `{error, detail, suggestion}` shape the frontend can render consistently
- **M** — ABF end-to-end pass: run every analysis module against representative ABF files (episodic and gap-free, ABF1 + ABF2, multi-channel). Units/scaling are the most likely landmines. Blocks the "representative ABF files" ask in the external-beta plan.
- **M** — benchmark event and burst detection against Clampfit on a shared fixture set. Publish the comparison table; this is the kind of thing that gets a methods paper cited.
- **L** — GitHub Actions CI: typecheck, build, py_compile, lint on every push

## Theme / display

- **S** — theme toggle keyboard shortcut (⌘⇧D?)
- **S** — font size slider in Settings for the trace viewer's axis labels (accessibility)
- **M** — additional color schemes: "high contrast", "print" (white bg, black axes for screenshotting)

## Documentation

- **S** — update `README.md` with current feature list
- **S** — screenshots in README for each analysis window
- **S** — start a `CHANGELOG.md` from day one. Cheap now, becomes validation documentation if an industry/CRO customer ever asks for IQ/OQ paperwork later.
- **M** — per-analysis-window doc page (`docs/analyses/fpsp.md`, etc.) with screenshots + parameter explanations
