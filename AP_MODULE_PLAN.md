# Action Potentials analysis module — design plan

Status: design only, no code yet.

## Goal

Add a dedicated **Action Potentials** analysis window to NeuroTrace that
covers the same two analyses Easy Electrophysiology ships:

1. **AP Counting** — detect spikes, count them, derive firing-pattern
   metrics per sweep, compute rheobase (incl. ramp protocols) and an
   F–I curve across sweeps.
2. **AP Kinetics** — per-spike waveform measurements (threshold, peak,
   amplitude, rise/decay, FWHM, fAHP/mAHP, max slopes), with a
   dedicated **Phase Plot** view for dV/dt vs V.

Both operate on current-clamp recordings with a single Vm channel
(primary) and optionally an Im channel (for rheobase / F–I).

## References (public-domain maths; code is not ported)

- Easy Electrophysiology analysis repo (GPLv2 — **do not port code**; use
  as a map of which formulas to re-implement):
  - `ap_detection_methods.py` — spike detection
  - `core_analysis_methods.py` L403–793 — thresholds, AHP, rise/decay, FWHM, max-slope, 200 kHz interp
  - `current_calc.py` L90–223, 810 — ISI/LV/rheobase/phase plot
- Sekerli et al. 2004 — Method I & II threshold definitions
- Rossokhin & Saakian 1992 — maximum-curvature threshold
- Shinomoto 2003 — local variance accommodation metric

## Architecture

One window, three tabs, shared detection stage.

### Window layout
```
┌─────────────────────────────────────────────────────────────┐
│ Group ▾  Vm series ▾  Vm channel ▾  Im channel ▾            │
├─────────────────────────────────────────────────────────────┤
│ Pre-detection filter: [ ] on  Lowpass ▾ 1000 Hz  Order 2    │
│ Detection: Auto/rec ▾  amp ▏ +dV/dt ▏ −dV/dt ▏ width ▏ mind │
│ Bounds: [— drag cursors on plot —]                          │
├─────────────────────────────────────────────────────────────┤
│ Run on: ( ) all  ( ) range 1–N  ( ) single N     [Run][Clr] │
├─────────────────────────────────────────────────────────────┤
│ [ Counting ]  [ Kinetics ]  [ Phase plot ]                  │
├─────────────────────────────────────────────────────────────┤
│  ┌── mini-viewer ─────┐  ┌── tab-specific content ──────┐   │
│  │ trace + AP markers │  │ Counting: per-sweep table +  │   │
│  │ draggable bounds   │  │   F–I curve                  │   │
│  │                    │  │ Kinetics: per-spike table    │   │
│  │                    │  │ Phase:  Vm vs dV/dt plot +   │   │
│  │                    │  │   prev/next AP navigator     │   │
│  └────────────────────┘  └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Files

Backend:
- `backend/analysis/ap.py` — detection + all metrics, pure numpy/scipy
- `backend/api/ap.py` — FastAPI router

Frontend:
- `frontend/src/components/AnalysisWindows/APWindow.tsx` — main component
- `frontend/src/stores/appStore.ts` — add `apAnalyses` slice + type
- `frontend/src/AnalysisWindow.tsx` — route `view === 'action_potential'` to `APWindow`
- `frontend/src/components/CursorPanel/CursorPanel.tsx` — add `ap-update` broadcast handler
- `electron/main.ts` — window title for `action_potential`
- Wire into the Analysis dropdown (`AnalysisPanel.tsx`)

## Shared detection stage

### Parameters
| Name | Type | Default | Notes |
|---|---|---|---|
| method | `auto_rec` \| `auto_spike` \| `manual` | `auto_rec` | detection method |
| manual_threshold_mv | float | −10 | used only when `manual` |
| min_amplitude_mv | float | 50 | reject low-amplitude deflections |
| pos_dvdt_mv_ms | float | 10 | +dV/dt trigger |
| neg_dvdt_mv_ms | float | −10 | −dV/dt gate after peak |
| width_ms | float | 5 | max allowed width between crossings |
| min_distance_ms | float | 2 | refractory; merge close peaks |
| bounds_start_s, bounds_end_s | float | full sweep | analysis window |
| filter_enabled, filter_type, filter_low, filter_high, filter_order | | off | same shape as bursts/FPsp |

### Algorithm (clean-room, per-sweep)

```
1. Optionally apply pre-detection filter (scipy.signal.sosfiltfilt)
2. dvdt = np.diff(vm) / dt
3. Find candidate onsets: indices where dvdt[i] > pos_dvdt_mv_ms
4. For each onset, search forward up to width_ms for a sample where
   dvdt < neg_dvdt_mv_ms.
5. Peak = argmax(vm) between onset and fall-crossing.
6. Reject if peak − local baseline < min_amplitude_mv.
7. Merge peaks closer than min_distance_ms (keep highest).
8. For `auto_rec` method: compute per-sweep threshold as
   (median(peak_vm) + median(threshold_vm)) / 2 across all detected
   spikes, then redo peak search using that as the level threshold.
9. For `manual`: any upward crossing of manual_threshold_mv followed
   by a downward crossing counts.
```

All numpy, no scipy peak-finding needed (we want the exact crossing
semantics Easy Electrophysiology uses).

## Tab 1 — AP Counting

### Per-sweep metrics
- `spike_count` — int
- `peak_times_s` — list[float]
- `peak_vms_mv` — list[float]
- `first_spike_latency_s` — (peak_times[0] − im_onset_s) or null
- `mean_isi_s` — mean(diff(peak_times)), null if <2 spikes
- `sfa_divisor` — isi[0] / isi[-1], null if <3 spikes
- `local_variance` — Shinomoto 2003: `Σ 3(ISI_i − ISI_{i+1})² / (ISI_i + ISI_{i+1})² / (n−1)`

### Across sweeps
- **F–I curve** — spikes/sweep vs injected current. One point per
  sweep. Points overlaid with connecting line. Axes: pA / Hz (spikes
  divided by bounded window width).
- **Rheobase** — three modes:
  1. **Record** — Im of the first sweep that has ≥1 AP. Uses mean Im
     across that sweep (over the bounded window).
  2. **Exact** — Im at the exact sample of the first AP's peak, minus
     the sweep's pre-stim baseline. Works for step AND ramp protocols
     when the Im channel is a ramp.
  3. **Ramp (manual)** — user marks ramp start/end time and
     start/end Im amplitude via two inputs; rheobase is linearly
     interpolated at the first AP peak's time. Covers the case where
     Im is not recorded (Vm-only file).

### Im source, in priority order
1. User-selected Im channel in the current group/series.
2. Protocol read from `.pgf` stimulus tree (already parsed for FPsp).
   Auto-read step or ramp params when available.
3. Manual Ramp tab (user inputs t_start_s, t_end_s, im_start_pa, im_end_pa).

### Outputs (frontend)
- Per-sweep table — toggleable columns (like the Cursor window).
- F–I curve plot — uPlot, click a point to jump to that sweep in the
  mini-viewer.
- Rheobase value displayed prominently with mode badge.

## Tab 2 — AP Kinetics

### Threshold detection methods
All operate on `dvdt[start:peak_idx+2]`:

| Method | Formula | Paper |
|---|---|---|
| `first_deriv_cutoff` (default) | first sample where `dvdt ≥ cutoff` (default 20 mV/ms) | — |
| `first_deriv_max` | argmax(dvdt) | — |
| `third_deriv_max` | argmax(d³V) | — |
| `third_deriv_cutoff` | first sample where `d³V ≥ cutoff` | — |
| `sekerli_I` | argmax(d²V / dV), masked where dV ≤ lower_bound (default 5) | Sekerli 2004 |
| `sekerli_II` | argmax((d³V · dV − (d²V)²) / dV³), same mask | Sekerli 2004 |
| `leading_inflection` | argmin(dvdt) | — |
| `max_curvature` | argmax(d²V · (1 + dV²)^(−3/2)) | Rossokhin & Saakian 1992 |

### Parameters
| Name | Default | Notes |
|---|---|---|
| threshold_method | `first_deriv_cutoff` | |
| threshold_cutoff_mv_ms | 20 | for cutoff variants |
| threshold_search_ms_before_peak | 5 | search window size |
| sekerli_lower_bound_mv_ms | 5 | mask for Sekerli methods |
| rise_low_pct, rise_high_pct | 10, 90 | rise-time cutoffs |
| decay_low_pct, decay_high_pct | 10, 90 | decay-time cutoffs |
| decay_end | `to_threshold` \| `to_fahp` | |
| fahp_search_start_ms, fahp_search_end_ms | 0, 5 | post-peak search |
| mahp_search_start_ms, mahp_search_end_ms | 5, 100 | post-peak search |
| max_slope_window_ms | 0.5 | window for linear-fit slope |
| interpolate_to_200khz | `true` | for rise/decay/FWHM precision |

### Per-spike metrics
- threshold_vm, threshold_t
- peak_vm, peak_t
- amplitude (peak − threshold)
- rise_time_s (between % cutoffs of amplitude)
- decay_time_s
- half_width_s (FWHM at amplitude/2)
- fahp_vm, fahp_t
- mahp_vm, mahp_t
- max_rise_slope_mv_ms, max_decay_slope_mv_ms
- max_slope_fit_line (for overlay, if requested)

### Output
Per-spike table, one row per detected AP across all run-mode sweeps,
with sweep index + spike index columns. Column toggles identical to
the Cursor window's pattern. CSV export.

## Tab 3 — Phase plot

Interactive Vm vs dV/dt view of one spike at a time.

### Controls
- Prev / Next AP buttons, spin-box for AP index
- Window size: ± ms around peak (default ±5 ms)
- Optional cubic-spline interpolation factor (1, 10, 50, 100)
- Threshold-cutoff overlay (defaults to 20 mV/ms; red line at that
  dV/dt level)

### Metrics shown
- Threshold (at dV/dt cutoff crossing) — same as Kinetics tab
- Max dV/dt
- Min dV/dt (AHP repolarization slope)
- Max Vm
- AP width in V–space: distance between threshold and repolarization
  threshold on the phase plot (useful for comparing spike waveforms)

### Implementation
Compute on demand (one AP at a time) via
`GET /api/ap/phase_plot?group&series&trace&sweep&spike_index&window_ms&interp`.
Return `{ vm: [], dvdt: [], metrics: {...} }`.

## Backend API

- `POST /api/ap/run` — body carries group/series/trace, Im channel,
  sweeps list, mode (`counting`|`kinetics`|`both`), detection params,
  kinetics params, rheobase mode + ramp params. Returns `{ per_sweep,
  per_spike, rheobase, fi_curve, spike_times_per_sweep }`.
- `GET /api/ap/phase_plot` — one AP's phase-plot data + metrics.
- `GET /api/ap/auto_im_params` — returns parsed Im protocol
  (step/ramp/null) from `.pgf`, used by the frontend to prefill the
  ramp-manual inputs.

Pydantic request models mirror `backend/api/fpsp.py` patterns.

## Store & persistence

```ts
interface APPoint {
  sweep: number
  spikeIndex: number          // index within sweep
  threshold: number; thresholdT: number
  peak: number; peakT: number
  amplitude: number
  riseTime: number | null
  decayTime: number | null
  halfWidth: number | null
  fahp: number | null; fahpT: number | null
  mahp: number | null; mahpT: number | null
  maxRiseSlope: number | null
  maxDecaySlope: number | null
}

interface APPerSweep {
  sweep: number
  spikeCount: number
  peakTimes: number[]
  firstSpikeLatency: number | null
  meanISI: number | null
  sfaDivisor: number | null
  localVariance: number | null
  imMean: number | null        // from Im channel if present
}

interface APData {
  group: number; series: number; trace: number
  imChannel: number | null
  detectionMethod: 'auto_rec' | 'auto_spike' | 'manual'
  // ... all detection + kinetics params echoed
  perSweep: APPerSweep[]
  perSpike: APPoint[]
  fiCurve: { im: number[]; rate: number[]; sweep: number[] } | null
  rheobase: { mode: 'record'|'exact'|'ramp'; value: number | null } | null
  selectedSpikeIdx: number | null
}

apAnalyses: Record<"group:series", APData>
```

Persisted per-file via `savedAPAnalyses[filePath]` in Electron prefs,
exactly matching FPsp/IV/Cursor:
- `_loadPersistedAP`, `_savePersistedAP`, `_broadcastAP` helpers
- Module-level `useAppStore.subscribe` that writes to prefs on change
- `openFile` loads and broadcasts
- `CursorPanel` listener in main window catches `ap-update` and sets
  the main store (this is the fix we just added for cursorAnalyses)
- `AnalysisWindow.tsx` handles `ap-update` in its BroadcastChannel listener

## Testing plan

Unit tests for `backend/analysis/ap.py`:
- Synthetic AP generator (double-exponential or biophysical HH toy
  model) — tests exact peak_t, threshold, rise/decay against known
  inputs.
- Edge cases: zero spikes in sweep, single spike (no ISI), burst
  (min-distance merging), bi-phasic decay (fAHP vs mAHP separation).
- Regression: one fixed HEKA file checked into `sample_data/` with a
  gold-standard JSON of expected metrics.

## Manual spike editing

Auto-detection misses real spikes or flags noise as spikes often
enough that a manual touch-up is essential. The mini-viewer supports:

- **Left-click** on the trace anywhere inside the bounds window →
  add a spike. The click position snaps to the nearest local Vm
  maximum within ±`min_distance_ms / 2` of the click (so the user
  doesn't have to land exactly on the peak). A new AP is inserted
  into the current sweep's spike list, all Counting metrics for that
  sweep are recomputed, and Kinetics metrics are computed for the new
  spike using the current threshold method. The added spike is
  rendered as a marker like the auto-detected ones but with a subtle
  ring around it to indicate manual origin.
- **Right-click** on an existing spike marker → remove that spike.
  A small tolerance (6 px) is used for hit-testing. Metrics
  recompute in the same way.

### Policy for parameter changes

When the user re-runs detection (changed detection params, bounds,
filter, etc.), we keep manual edits by replaying them on top of the
fresh auto-detection:

- Manually-added spike positions (absolute sample times) are inserted
  into the newly-detected set if not already present within
  `min_distance_ms`.
- Manually-removed spike positions are subtracted from the new set
  using the same tolerance.

A **Clear manual edits** button drops the overrides entirely and
shows only the raw auto-detection result. This makes the edits
durable across legitimate param tweaks but escape-hatchable.

### Data model

```ts
interface APManualEdits {
  added: Record<number /* sweep idx */, number[] /* peak_t seconds */>
  removed: Record<number, number[]>
}
```

Stored in `APData.manualEdits`, persisted with the rest of the per-
series blob.

### Backend contract

`/api/ap/run` accepts an optional `manual_edits` field. The backend:
1. Runs auto-detection as usual.
2. For each sweep in `manual_edits.removed`, drops any detected peak
   within `min_distance_ms` of a removed timestamp.
3. For each sweep in `manual_edits.added`, inserts a spike at that
   sample (snapping to the nearest local max within
   `min_distance_ms / 2`), but only if no auto-detected peak is
   already within that window.
4. Re-sorts each sweep's spike list and computes all metrics.

Return shape is unchanged — downstream code doesn't need to know the
origin of each spike. The `APPoint` record gains a single bool flag
`manual` for the UI's ring-marker styling.

### Frontend flow

On click / right-click, the component:
1. Updates `APData.manualEdits` locally.
2. Posts to `/api/ap/run` with the updated edits + current params.
3. Replaces the full results in the store on response.

This is simpler than doing any client-side recomputation and keeps
the algorithm in one place.

## Explicit non-goals (v1)

- Batch mode (multi-file folder processing)
- Firing-pattern classifiers (regular / adapting / accommodating / bursting)
- Bursting detection within AP Counting (field-burst window already
  exists; can be adapted later if needed for intracellular bursts)
- "Copy parameters" clipboard export (CSV download is enough)

## Implementation order

1. **Backend `analysis/ap.py`** — detection (`auto_rec`, `auto_spike`,
   `manual`) + all 8 threshold methods + kinetics metrics. Hand-
   written unit tests against synthetic spikes.
2. **Backend `api/ap.py`** — `/run` endpoint with all params. Smoke
   test with `curl`.
3. **Store additions** — types, slice, broadcast/persist helpers,
   openFile load path, main-window listener.
4. **`APWindow.tsx` shell** — selectors, detection params card,
   run controls, empty mini-viewer. Wire Run → backend → store.
5. **Counting tab** — per-sweep table, F–I curve, rheobase badge.
   Im-channel selector + `/auto_im_params` for prefill.
6. **Kinetics tab** — per-spike table with column toggles + CSV.
   All 8 threshold methods wired, `interpolate_to_200khz` toggle.
7. **Phase-plot tab** — Vm vs dV/dt plot with prev/next + window
   slider. `/phase_plot` endpoint.
8. **Manual spike editing** — extend `/api/ap/run` with
   `manual_edits`, add backend snap-and-patch logic, extend `APData`
   with `manualEdits` + `manual` flag on points, wire left-click/
   right-click on the mini-viewer, add the Clear-manual-edits button,
   make markers ring-styled for manual origin.
9. **Polish** — auto-Reset on first data, locked-zoom pattern from
   CursorWindow, spike markers on mini-viewer, click-spike-in-table →
   highlight on plot, click-F–I-point → jump to sweep.
10. **Verify** — typecheck, py_compile, smoke test with a real
    current-clamp recording from `sample_data`.

Estimated ~1400 lines total (backend ~450, frontend ~950). Slightly
more than the FPsp / Cursor windows because of the manual-edit layer.
