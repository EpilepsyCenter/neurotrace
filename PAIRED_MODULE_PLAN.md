# Paired-recording analysis module — design sketch

Status: design sketch, no code yet. Intended for a feature branch.

## Goal

Add a **Paired Recording** analysis window for simultaneous pre- /
post-synaptic recordings. Given a pre-channel that contains action
potentials (or extracellular stim artifacts) and a post-channel that
contains evoked PSPs / PSCs, compute the standard release-statistics
toolkit:

- **Failure rate** (and success rate)
- **Mean amplitude** (across all trials, including failures = 0)
- **Potency** (mean amplitude conditioned on success)
- **CV** (SD / mean) of successes
- **1/CV²** — variance-mean indicator linked to release probability
- **Latency** mean and **jitter** (SD of latency)
- **Paired-pulse ratio (PPR)** when ≥2 pre-spikes per sweep
- **Connection probability** is out of scope at v1 (single pair only).

A trial = one pre-spike with its time-locked post-window. A sweep can
contain one or many trials. Stats aggregate within a series (one
recorded pair, one stim protocol).

## Why one window, not an extension to AP / Events

The workflow is fundamentally two-channel and **time-locked**: every
post measurement is anchored to a specific pre event. AP and Events
both operate on a single channel with no cross-channel coupling. A
shared window would muddy both. We do, however, **reuse the backend
detection code** from AP (`backend/analysis/ap.py`) and Events
(`backend/analysis/events.py`) — no clean-room rewrite.

## Architecture

One window, three tabs, a shared "trial extraction" stage.

### Window layout — same skeleton as APWindow / EventDetectionWindow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Group ▾  Series ▾  Pre ch ▾  Post ch ▾    ⟨⟨ ⟪ ◀ Sweep N/M ▶ ⟫ ⟩⟩          │
├──────────────────────┬──────────────────────────────────────────────────────┤
│ ░░ Left sidebar  ░░  │  ┌── pre channel mini-viewer ──────────────────────┐ │
│ (resizable,          │  │  trace + detected pre-event markers             │ │
│  default 340 px,     │  │  manual-edit click target                       │ │
│  width persisted via │  └──────────────────────────────────────────────────┘ │
│  ui.leftPanelWidth)  │  ┌── post channel mini-viewer ─────────────────────┐ │
│                      │  │  trace + per-trial post-window overlays         │ │
│ ── scroll region ──  │  │  baseline span + peak markers                   │ │
│ Pre source ▾         │  └──────────────────────────────────────────────────┘ │
│   AP detect          │  ┌── tab strip ────────────────────────────────────┐ │
│   Stim artifact      │  │ [ Trials ]  [ Statistics ]  [ STA / Average ]   │ │
│   TTL pulse          │  └──────────────────────────────────────────────────┘ │
│   Manual             │  ┌── result region (bottom) ───────────────────────┐ │
│ [pre params card]    │  │ Trials tab:    per-trial table                  │ │
│                      │  │ Stats tab:     summary card + histogram + seq   │ │
│ Post window          │  │ STA tab:       average plot + overlays          │ │
│   pre_ms / post_ms   │  └──────────────────────────────────────────────────┘ │
│   baseline_ms        │                                                       │
│   peak direction     │                                                       │
│   filter             │                                                       │
│                      │                                                       │
│ Failure threshold    │                                                       │
│   k·SD / absolute    │                                                       │
│                      │                                                       │
│ Latency rule         │                                                       │
│ ── pinned bottom ──  │                                                       │
│ Run on ▾   [Run][Clr]│                                                       │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

Conventions copied verbatim from existing windows (CLAUDE.md §5 + the
APWindow / EventDetectionWindow patterns):

- **Top header**: group / series / pre-channel / post-channel selectors
  followed by the standard sweep-arrow cluster (`⟨⟨ ⟪ ◀ ▶ ⟫ ⟩⟩`).
- **Left sidebar**: resizable column, default 340 px, drag handle on its
  right edge. Width persists via `ui.leftPanelWidth` like
  EventDetectionWindow does. Inner layout = `flex` column with a
  scrolling top region (`flex: 1; overflow: auto`) containing all
  parameter cards, and a `flexShrink: 0` bottom region pinning the
  **Run on ▾ / Run / Clear** controls.
- **Middle**: two stacked uPlot mini-viewers — pre channel on top, post
  channel below. Each carries its own header strip with **Reset zoom /
  Fit Y / Zero offset** controls. Pre-detection filter previews live on
  both traces as soon as enabled (no Run gate).

### Mini-viewer conventions (mandatory — copy from APWindow / FPsp / Burst)

The two stacked viewers must follow the existing app-wide rules
verbatim. None of these are negotiable; deviating from them has caused
specific bugs (CLAUDE.md §4, §5, §7) that we already fixed elsewhere.

1. **Rebuild on data change, never `u.setData()` in place.** Each
   viewer's effect destroys the existing uPlot instance and constructs
   a new one when its `data` (or filter / zero-offset / sweep) changes.
   This is what kept FPsp / Burst free of stale-frame and stuck-zoom
   bugs.

2. **Zoom persistence across rebuilds via refs + range callbacks.**
   Each viewer holds `zoomXRef` and `zoomYRef` (`useRef<[number,
   number] | null>(null)`). The uPlot opts pass:
   ```ts
   scales: {
     x: { range: (_u, dMin, dMax) => zoomXRef.current ?? [dMin, dMax] },
     y: { range: (_u, dMin, dMax) => zoomYRef.current ?? [dMin, dMax] },
   }
   ```
   Wheel / pan / drag-resize updates the refs (and bumps a `setVer`
   counter so React knows the button's enabled-state may have
   changed). Refs survive plot rebuilds, so zooming → re-running →
   filter toggle never resets the user's view.

3. **Interactions** (identical to APWindow's sweep viewer):
   - **wheel** → zoom X around cursor
   - **⌥-wheel** (Alt) → zoom Y around cursor
   - **drag** → pan (after a small `move > 3 px` threshold so a click
     stays a click — matters for the manual-add gesture)
   - **double-click** → reset zoom (same as the button)
   - Hint line below the strip: `wheel: zoom X · ⌥ wheel: zoom Y · drag: pan`.
   Wheel handler must register with `{ passive: false }` so we can
   `preventDefault` the page from scrolling.

4. **Header buttons** (every mini-viewer carries all three):
   - **Reset zoom** — clears both `zoomXRef` and `zoomYRef`, returning
     to full data bounds in both axes. Disabled when both refs are
     already null.
   - **Fit Y** — re-autoscales Y to the currently-visible X window
     only (preserves X zoom). Useful after panning into a region with
     a different y-scale. Convention from EventDetectionWindow line
     ~3009 and FieldBurstWindow line ~1442.
   - **Zero offset** checkbox — passes `zero_offset=true` to
     `/api/traces/data`, which DC-subtracts a baseline window. The
     server returns `zero_offset` in the response; the viewer keeps
     it as `zeroOffsetApplied`. **All overlay markers** (pre-event
     peaks, baseline span, post-peak dot, threshold lines) carry
     raw-signal y-values, so plotting code subtracts
     `zeroOffsetApplied` before drawing — see CLAUDE.md §5 and the
     `drawBurstOverlay` pattern. The checkbox state persists via
     `writeUIPref({ zeroOffset })` like EventDetectionWindow does.

5. **X axis is always shared between the two viewers.** This is a
   hard rule, not a "nice to have": at every moment both viewers show
   exactly the same X window. Wheel-zoom or pan on the pre viewer
   pans/zooms the post viewer in lockstep, and vice versa. Reset zoom
   on either resets both X axes; Fit Y on one only re-fits that
   viewer's Y. Implementation:
   - **One shared `zoomXRef` lives on the parent `PairedWindow`**, not
     per-viewer. Each viewer receives it as a prop along with an
     `onXRangeChange(range: [number, number] | null)` callback.
   - Wheel / pan / double-click handlers in either viewer mutate the
     shared ref via the callback, then both viewers re-redraw (the
     parent bumps a `xVer` counter so React knows to schedule the
     redraw on whichever viewer didn't originate the event).
   - Both viewers' `scales.x.range` callbacks read from the same ref,
     so by construction they cannot disagree.
   - Y stays independent per viewer (pre and post are in different
     units — mV vs pA — and we never want them coupled).
   - The auto-Fit-on-first-data step (point 6) fits Y on each viewer
     individually but does NOT touch the shared X ref unless the
     `(group, series)` key changes.

   FPspWindow's `onXRangeChange` callback (~line 2375) is the same
   shape; the difference is just that here the ref is single-source-
   of-truth for X across both viewers, not a per-viewer ref with a
   notification side-channel.

6. **Auto-Fit on first data, then never automatically.** When data
   first arrives for a `(group, series, channel)` and the user hasn't
   touched the view yet, auto-Fit Y so they see something sensible.
   Tracked with a `firstFitDoneRef = useRef(false)` that resets when
   the `(group, series)` key changes (NOT on filter / zero-offset /
   sweep change — those should respect existing zoom).

7. **Pre-detection filter inheritance.** On window mount, if
   `useAppStore.getState().filter.enabled`, the new window adopts the
   main viewer's filter so the displayed traces match what the user is
   already looking at (CLAUDE.md §5).

8. **LTTB-safe time→index lookups.** `/api/traces/data` returns a
   non-uniform LTTB-decimated time array. Any code that maps a
   time-in-seconds (e.g. a clicked manual-edit anchor, or a per-trial
   `t_pre` overlay) to a sample index MUST binary-search
   `traceData.time` rather than `Math.round(t * sr)` — same fix as
   `CursorAnalysisWindow.tsx`'s quick-measure (CLAUDE.md §6).

9. **Manual-edit click target on the pre viewer.** Click vs drag is
   disambiguated by the 3-px movement threshold (point 3). On a
   genuine click inside the bounds region, snap to the nearest local
   extreme within `min_distance_ms / 2`, post the updated
   `manual_edits` to `/api/paired/run`, replace results in the store
   on response. Right-click on an existing pre-event marker → remove
   (6 px hit-test tolerance, AP-window pattern).
- **Bottom**: tab strip + result region. Tabs swap the result region's
  content; mini-viewers stay put.

### Files

Backend:
- `backend/analysis/paired.py` — trial extraction + stats. Calls into
  `analysis/ap.py` for pre detection and into `analysis/events.py` for
  post measurement primitives.
- `backend/api/paired.py` — FastAPI router.

Frontend:
- `frontend/src/components/AnalysisWindows/PairedWindow.tsx`
- `frontend/src/stores/appStore.ts` — `pairedAnalyses` slice
- `frontend/src/AnalysisWindow.tsx` — route `view === 'paired'`
- `frontend/src/components/CursorPanel/CursorPanel.tsx` — `paired-update`
  adopt-handler + `state-request` reply
- `electron/main.ts` — window title for `paired`
- Wire into the Analysis dropdown (`AnalysisPanel.tsx`)

## Trial extraction (shared stage)

### Pre-event detection

Four modes for finding **trial anchors** on the pre channel:

1. **AP detect** — call `analysis/ap.py` detection (`auto_rec` /
   `auto_spike` / `manual`). All AP detection params are exposed.
   Default for current-clamp pre-recordings.
2. **Stim artifact** — for biphasic / capacitive artifacts on a stim-
   monitor or pre-Im trace. Detection runs on `|d/dt|` of the signal
   (so polarity doesn't matter). Params: `dvdt_threshold`,
   `min_distance_ms`. The reported anchor time is the **first**
   threshold crossing of each artifact group (so it tracks the
   command onset, not the rebound).
3. **TTL pulse** — for square external-stimulator triggers. The
   signal is treated as a near-binary level: anchor is the rising
   edge crossing of `level_threshold` (default = midway between the
   sweep's min and max). Params: `level_threshold`, `edge` (rising /
   falling / both), `min_pulse_ms` (debounce; ignore crossings closer
   than this to the previous accepted edge), `min_distance_ms`.
   Implementation is `np.diff((x > level).astype(int8))` → `+1`
   indices for rising, `-1` for falling, then debounce. Cheap and
   robust to tens-of-microseconds noise on the TTL line.
4. **Manual** — user-placed markers only (Manual edits layer below).

The pre mini-viewer overlays a horizontal threshold line whenever the
active mode uses one (Stim artifact: dV/dt threshold against the
derivative trace shown faintly; TTL: the level threshold against the
raw trace) so the user can drag the value and see hits update live.

Manual edits (added/removed timestamps per sweep) layer on top per the
AP-window pattern. Same `min_distance_ms / 2` snap-to-local-extreme.

### Post window per pre event

For each pre-event peak time `t_pre`:

- `t0 = t_pre - pre_ms` (typically 1 ms before)
- `t1 = t_pre + post_ms` (typically 20–50 ms after)
- `baseline_window = [t_pre − pre_ms − baseline_ms, t_pre − pre_ms]`
  — strictly **before** the pre-event peak, so even a fast post
  response can't bias the baseline.

If the next pre-event falls inside `[t_pre, t1]`, truncate this trial's
post window at the next event minus a 0.2 ms guard. This is the
standard fix for high-frequency trains and is what gates PPR analysis.

### Per-trial measurements

For each trial:

| Field | How |
|---|---|
| `pre_t` | pre-event peak time |
| `pre_amp` | pre-event amplitude (Vm peak − threshold for AP; peak `\|d/dt\|` for stim artifact; pulse height for TTL) |
| `baseline_mean`, `baseline_sd` | from baseline_window on post channel |
| `post_peak`, `post_peak_t` | extremum within `[t_pre, t1]`, sign per peak_direction |
| `amplitude` | `post_peak − baseline_mean` (signed; convention: depolarizing PSP +, inward PSC by sign of post_peak − baseline) |
| `latency_s` | `latency_t − t_pre`, where `latency_t` is either the time at `latency_fraction × amplitude` or the d²V/dt² inflection on the rising flank |
| `success` | `\|amplitude\| ≥ threshold` (see failure threshold below) |
| `rise_time_s`, `decay_tau_s` | reuse `events.py` measurement helpers — only on successes |
| `truncated` | bool, true if next event truncated this window |

### Failure threshold

Two configurable rules:

- **k × SD of baseline** (default, k = 3). Computed per trial — robust
  to drift across long recordings.
- **Absolute** in pA or mV. For when baseline is dirty enough that the
  k·SD rule lets too many "small responses" through.

Trials below threshold are scored `success = False` with `amplitude`
preserved (NOT zeroed), so you can plot a histogram of failures vs
successes and inspect the boundary.

## Tab 1 — Trials

Per-trial table, one row per trial across all sweeps in the run set.
Columns (toggleable, like the Cursor window):

`sweep · trial_idx · pre_t · pre_amp · amplitude · success · latency_ms · rise_ms · decay_tau_ms · baseline_mean · baseline_sd · truncated`

CSV export. Click a row → mini-viewer scrolls to that pre-event and
highlights it. The post mini-viewer shows the post window with
**baseline span** and **peak marker** overlaid.

## Tab 2 — Statistics

Per-series summary card:

| Metric | Formula |
|---|---|
| `n_trials`, `n_success`, `n_failures` | counts |
| `failure_rate` | `n_failures / n_trials` |
| `mean_amplitude` | mean over all trials (failures included as their measured value, NOT zeroed — this matches PSP-amplitude convention; we also report `mean_amplitude_zeroed` with failures = 0) |
| `potency` | mean over successes only |
| `cv_success` | `SD(amp_success) / mean(amp_success)` |
| `inv_cv2` | `1 / cv_success²` |
| `latency_mean_ms`, `latency_sd_ms` (jitter) | over successes only |
| `ppr_2_1` | `mean(amp_2) / mean(amp_1)` across sweeps with ≥2 trials, computed only over sweeps where `amp_1` is a success (configurable: include / exclude failures in numerator) |
| `pprN_1` | same, generalized; rendered as a small bar plot |

Two diagnostic plots in this tab:

- **Amplitude histogram** with the failure threshold drawn as a red
  vertical line. Successes vs failures coloured.
- **Trial sequence** — amplitude vs trial index, with successes /
  failures coloured. Useful for spotting rundown.

## Tab 3 — STA / Average

Spike-triggered average of the post channel.

- Aligns each post window to its `t_pre`, interpolates onto a common
  grid (2 × the source rate, linear interp — same trick as
  `TraceViewer.buildSeriesData`), averages.
- Toggles: **all trials**, **successes only**, **failures only**.
- Overlay individual traces faintly behind the average.
- Show ± SEM band.
- Display measurements on the average: peak amplitude, 10–90 rise,
  decay τ (single exponential fit via `analysis/fitting.py`), latency.

This tab is what people typically put in figures.

## Backend API

- `POST /api/paired/run` — body carries group/series, `pre_channel`,
  `post_channel`, sweeps list, pre-detection mode + params, post
  window + filter + failure-threshold params, latency rule,
  `manual_edits`. Returns:
  ```
  {
    per_trial: PairedTrial[],
    per_sweep_summary: { sweep, n_trials, n_success, ppr_2_1, ... }[],
    series_summary: { failure_rate, mean_amplitude, potency, cv_success, inv_cv2, latency_mean_ms, latency_sd_ms, pprN_1: [..] },
    sta: { time: [], mean: [], sem: [], n: int }
  }
  ```
- `GET /api/paired/trial_window` — one trial's pre + post slice for
  the mini-viewer overlay; cheap, used while scrolling. Mirrors
  `/api/ap/phase_plot` shape.
- (No separate `/auto_params` endpoint at v1 — pre-detection params
  default from the AP window's last-used set, post-window params from
  Events window's last-used set.)

Pydantic request models follow `backend/api/ap.py`.

## Store & persistence

```ts
interface PairedTrial {
  sweep: number
  trialIdx: number
  preT: number; preAmp: number
  amplitude: number
  success: boolean
  latencyMs: number | null
  riseMs: number | null
  decayTauMs: number | null
  baselineMean: number; baselineSd: number
  truncated: boolean
}

interface PairedSeriesSummary {
  nTrials: number; nSuccess: number; nFailures: number
  failureRate: number
  meanAmplitude: number; meanAmplitudeZeroed: number
  potency: number | null
  cvSuccess: number | null; invCv2: number | null
  latencyMeanMs: number | null; latencySdMs: number | null
  pprN1: { n: number; ratio: number }[]   // PPR from pulse 1 → pulse n
}

interface PairedManualEdits {
  added:   Record<number /* sweep */, number[] /* pre_t s */>
  removed: Record<number, number[]>
}

interface PairedData {
  group: number; series: number
  preChannel: number; postChannel: number
  // pre-detection params
  preMode: 'ap' | 'stim' | 'ttl' | 'manual'
  // ... echo all detection + window + threshold params
  perTrial: PairedTrial[]
  seriesSummary: PairedSeriesSummary
  sta: { time: number[]; mean: number[]; sem: number[]; n: number } | null
  manualEdits: PairedManualEdits
  selectedTrialIdx: number | null
}

pairedAnalyses: Record<"group:series", PairedData>
```

Persistence rides the **per-recording `.neurotrace` sidecar** — the
same single-file workspace blob `eventsAnalyses`, `apAnalyses`,
`fpspCurves`, `cursorAnalyses`, etc. already use. No separate
Electron-prefs slot. Concretely:

1. **`SidecarPayload` schema** (`appStore.ts` near line 343) gains two
   new fields:
   ```ts
   analyses?: {
     ...existing slots...
     paired?: Record<string, PairedData>     // keyed "${group}:${series}"
   }
   forms?: {
     ...existing slots...
     paired?: PairedFormState                 // last-used pre / post / threshold params
   }
   ```
   Bump `SIDECAR_VERSION` from 3 → 4. Add a one-line migration in the
   load path: `version < 4 → payload.analyses.paired ??= {}`.
2. **Store slice** in `appStore.ts`:
   `pairedAnalyses: Record<string, PairedData>` and
   `pairedForm: PairedFormState`. Both feed into / out of the sidecar
   via `_sidecarPayloadFromState` (write) and the loader's apply step
   (read). The 1 s debounced auto-save (`SIDECAR_DEBOUNCE_MS`) handles
   the writes — no per-slice subscribe block needed beyond the
   existing one that triggers the save.
3. **`fileCloseResetSlices()`** (~line 249) gains `pairedAnalyses: {},
   pairedForm: <defaults>` so close-file behaves like every other
   slice.
4. **Cross-window broadcast**: add a `_broadcastPaired` helper that
   posts `{ type: 'paired-update', pairedAnalyses }` on
   `BroadcastChannel('neurotrace-sync')`. Call it from the slice
   setter actions in `appStore.ts`.
5. **`CursorPanel.tsx` (main window)**: add a `paired-update` adopt-
   handler that writes the incoming map into the main store (which is
   what triggers the sidecar auto-save). Include `pairedAnalyses` and
   `pairedForm` in the `state-update` reply to `state-request`.
6. **`AnalysisWindow.tsx` (sub-windows)**: matching `paired-update`
   adopt-handler so a freshly-opened Paired window hydrates from any
   other window's most-recent state.

Form rehydration on `(group, series)` change uses the
`rehydratedKeyRef = useRef<string|null>(null)` trick from
FPspWindow / FieldBurstWindow — pull the per-series entry out of
`pairedAnalyses[`${group}:${series}`]` if present, else fall back to
`pairedForm` (last-used global defaults), else the hard-coded
defaults.

Result: opening a recording restores everything (per-series Paired
results + last-used form params), closing it clears state, and the
sidecar auto-save covers it without any extra Electron-prefs plumbing.

### Cohort module hook (forward-compat)

The cohort window already extracts events / bursts / AP / fPSP per
cell from `analyses.*`. To stay consistent, add a tiny extractor in
`backend/analysis/cohort.py` (`extract_paired`) that reads
`slice_data.get('paired')` and returns `{failure_rate, mean_amp,
potency, cv, inv_cv2, latency_jitter_ms}` per pair. Out of v1 scope to
wire it into the cohort UI, but having the extractor in place makes
v1's sidecar shape forward-compatible — no schema bump later.

## Manual editing

Same as AP window: left-click on the **pre** mini-viewer adds a pre-
event at the snapped local extreme; right-click on a marker removes
it. Re-run replays edits on top of fresh auto-detection. **Clear
manual edits** button. The `manual` flag rides on each `PairedTrial`
for ring-marker styling.

(No manual editing on the post side — peak detection within a fixed
post window is mechanical and shouldn't need it.)

## Multi-channel readiness

- HEKA reader: `n_channels = pm_series.channel_count()` already
  exposed in `Series.channels`. The frontend channel selector reads
  this — `Toolbar.tsx` already lets you pick a channel for the main
  viewer, so the pattern is in place.
- ABF: `abf.channelCount` → already iterated in `abf_reader.py`.
- Neo: per-block channel index already parsed.
- Text: each non-time column is a channel.

The window's pre/post selectors are two independent channel-index
spinners, bounded by `series.channels.length`. No reader changes
needed.

## Failure threshold — design call

The two-Gaussian / deconvolution estimator (Silver, Stricker–Redman)
is **not** in v1. Reasoning:

- Adds ~250 lines, requires a stable optimiser, and quietly does the
  wrong thing on small N.
- The k × SD rule plus an amplitude histogram (Tab 2) lets the user
  see exactly where the boundary is and override with the absolute
  rule if it's wrong.
- Easy to add later as a third option without changing the
  per-trial schema.

## Explicit non-goals (v1)

- Multi-pair / connection probability across many cells. (One series
  = one pair. Cohort-style aggregation across pairs lives in the
  Cohort window if/when we extend it.)
- Quantal analysis (binomial fit of amp histogram, N·q·p decomposition).
- Plasticity protocols (PPR sweeps with varying ISI as their own
  axis). The current PPR is single-ISI — it just reports
  ratio-by-pulse-index for the pulses that exist in the recording.
- LTP/LTD timecourse view. (LTP macro template already exists; can be
  extended to pull from `pairedAnalyses` later.)

## Implementation order

1. **Backend `analysis/paired.py`** — trial extraction, per-trial
   measurements (re-using `ap.py` and `events.py` primitives),
   summary stats, STA. Unit tests with synthetic pre-spike train +
   alpha-function post responses with known release probability.
2. **Backend `api/paired.py`** — `/run`, `/trial_window`. `curl` smoke.
3. **Store additions** — types, slice, broadcast / persist helpers,
   openFile load path, main-window listener.
4. **`PairedWindow.tsx` shell** — selectors (group, series, pre ch,
   post ch), pre-detection card, post-window card, failure-threshold
   card, run controls, two empty mini-viewers.
5. **Trials tab** — per-trial table with toggleable columns + CSV;
   row click → scroll mini-viewers; post-window overlay (baseline
   span + peak marker).
6. **Statistics tab** — summary card + amplitude histogram + trial-
   sequence plot.
7. **STA tab** — STA plot with successes/failures/all toggles, ±SEM
   band, fit-on-average measurements.
8. **Manual editing on pre** — `manual_edits` field on `/run`,
   snap-and-patch in backend, ring-marker styling, Clear button.
9. **Polish** — auto-Reset on first data, locked-zoom across rebuilds,
   pre-detection filter live preview, inherit main viewer's filter on
   mount.
10. **Verify** — `npx tsc --noEmit`, `npx vite build`,
    `python -m py_compile backend/analysis/paired.py
    backend/api/paired.py`, smoke test on a real paired-recording
    HEKA file from `sample_data/` (or add one).

Estimated ~1300 lines (backend ~400, frontend ~900). Cheaper than the
AP module because pre-detection and post-measurement code are
reused; the new code is mostly the trial-extraction loop, the stats
card, and the STA tab.

## Open questions for the user

- Do you have a representative paired-recording file we can drop into
  `sample_data/` for regression testing? (Needed before step 1 can be
  unit-tested against real data.)
- For PPR, is the convention in your data "include sweeps where pulse
  1 fails" (PPR can blow up) or "exclude them"? Default v1 will
  **exclude** — happy to flip.
- Latency convention: time-to-fraction-of-peak (default 20%) or
  onset-by-second-derivative? Both are used in the literature; we'll
  ship both with a toggle, default to time-to-20%.
- Is there ever a use case for **post**-channel manual editing of the
  peak (e.g. when the auto-peak finds a stim artifact tail)? If yes,
  add a click-on-post-mini-viewer-to-relocate-peak interaction in
  step 8. If no, skip.
