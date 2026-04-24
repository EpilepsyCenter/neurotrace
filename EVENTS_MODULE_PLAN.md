# Event Detection & Analysis — Module Plan

Ported / adapted from the Easy Electrophysiology v2.7 pipeline.
Target use: spontaneous postsynaptic events (EPSC / IPSC in VC, EPSP / IPSP in CC),
optionally evoked events where classic template detection applies.

---

## Scope summary

Event detection is a substantially bigger module than the analyses we've
built so far. Three reasons:

1. Two very different detection algorithm families (template matching,
   thresholding) with 3 sub-methods for template matching.
2. Rich per-event kinetics: baseline (foot-intersect), peak (smoothed),
   amp, rise, decay, half-width, AUC, optional exponential fits.
3. Heavy interactivity: exemplar selection, template refinement,
   RMS region picking, click-to-add, click-to-discard, drag-select,
   event-overlay outlier review.

We'll ship it in 3 phases. Phase 1 is scoped to cover the 80% daily-use
path. Phase 2 fills in the workflow gaps (refinement → overlay →
average). Phase 3 is power features.

---

## Design principles

- **One window, two methods** (Template matching / Thresholding) —
  share results table, per-event kinetics, viewer, and edit hooks, same
  way EE does. Users pick method in the left panel; only the params
  that differ are swapped.
- **Continuous-recording-friendly viewer** — reuse the BurstSweepViewer
  pattern (viewport presets, nav arrows, slider minimap, time readout,
  scroll-zoom). Events are detected per sweep but usually one sweep is
  a long continuous trace, so the viewer must pan + zoom comfortably
  over tens of seconds.
- **Click-to-add / double-click-to-discard** for manual edits — the
  same pattern as BurstWindow. (Note: add this to APWindow too — current
  AP module uses a different discard flow; track as a follow-up.)
- **VC primary, CC-flexible** — default labels pA, but the code reads
  units from the trace and renders whatever's there. Works for
  spontaneous PSPs in CC too.
- **Shared detection-measure overlay** — reuse the stacked-subplot
  multi-trace pattern we just built. The correlation / deconvolution
  similarity trace appears as an optional subplot beneath the main
  viewer with X-sync from primary and a horizontal cutoff line.
- **Global template library** — templates (name + rise/decay
  coefficients) persist across files via Electron prefs, shared with
  the window-local currently-selected template.

---

## Algorithms (Phase 1 scope)

### Biexponential event template

```
f(x) = b0 + b1 · (1 − exp(−x / τ_rise)) · exp(−x / τ_decay)
```

- `b0` is the baseline offset (fitted, usually near zero).
- `b1` is the amplitude/sign coefficient (fitted; sign decides polarity).
- `τ_rise`, `τ_decay` define the shape — THE parameters users tune.
- `width_ms` controls template window length (not in the equation; it's
  just how many samples the template spans).

Defaults: τ_rise = 0.5 ms, τ_decay = 5 ms (Jonas 1993).

### Template detection — two similarity measures in Phase 1

**1. Correlation (Jonas 1993):**
At each sample, slide the template window over the data, compute
Pearson correlation `r` between template and data in the window. Any
sample where `r ≥ cutoff` (default 0.4) is a candidate event start.
Contiguous runs above cutoff → one event region.

Implementation: use the Clements-Bekkers sliding-window formula for
performance — same O(N·W) pass used by the detection-criterion method,
just normalise differently at the end.

**2. Deconvolution (Pernía-Andrade 2012):**
- Deconvolve data with template in Fourier domain
- Bandpass the resulting trace (Gaussian, default 0.1 – 200 Hz)
- Compute amplitude histogram of the deconvolved signal
- Fit a Gaussian to the histogram (robust to outliers)
- Cutoff specified in standard-deviations of that Gaussian (default
  3.5) — find samples beyond that cutoff → candidate events
- Advantage: handles closely-spaced events that blur into each other
  for the correlation method.

Detection-criterion (Clements-Bekkers) deferred to Phase 2 — closely
related to correlation, minor impl delta, not worth bundling in P1.

### Thresholding

Simple sample-by-sample threshold crossing. Two threshold modes in P1:

**1. RMS-based (default):**
- User drag-selects a "quiet region" on the trace
- Backend computes `rms = sqrt(mean((x − mean(x))^2))` over that region
- Threshold = `baseline_value ± n × rms` (sign per peak direction, n
  user-configurable, default 3)
- Baseline value per whole-record: mean of the quiet region OR the
  record's overall mean (user toggle).

**2. Linear draggable (fallback / manual):**
- Horizontal line at a user-specified pA/mV value
- Draggable vertically on the trace.

Curve / drawn / record-by-record adaptive thresholds deferred to P3.

### Per-event kinetics pipeline

For each candidate event region:

1. **Find peak** — min or max sample within the region (respecting
   peak direction setting).
2. **Smooth-refine peak** — average a window of `avg_peak_ms` (default
   1 ms) around the peak; find the new peak within ±3 × that window
   in the smoothed data. Matches EE's two-pass approach — resists
   off-centre noise spikes while still averaging.
3. **Find baseline / foot (Jonas 1993)**:
   - In the `baseline_search_ms` window before the peak (default 10 ms),
     find the local minimum (or max, per direction) that'll serve as a
     rough pre-event baseline.
   - Compute the 20% and 80% rise points between that minimum and the
     peak (on the raw trace).
   - Draw a line through those two rise points, extend backwards, find
     where it intersects the pre-event baseline level → that's the
     event foot.
   - Average a small window (`avg_baseline_ms`, default 1 ms) ending at
     the foot to get the baseline Im value.
4. **Amplitude** = peak − baseline (signed).
5. **Rise time** = time between `low%` and `high%` of amplitude (default
   10–90).
6. **Decay time** — first sample after the peak that has decayed to
   `decay_pct` of amplitude (default 37%, i.e. 1/e). Search within
   `decay_search_ms` window (default 30 ms).
7. **Half-width (FWHM)** — time between the sample before the peak
   where the trace crosses 50% amplitude and the sample after where it
   crosses 50% again. Computed on raw data in Phase 1. (Phase 2 can
   compute on the fitted curve for precision.)
8. **AUC** = trapezoidal integral of (signal − baseline) over the event
   window (peak ± decay endpoint).

Exclusion criteria (applied after kinetics):
- `amplitude_min_pa` (default 5 pA absolute) — below this → dropped.
- `amplitude_max_pa` (upper clip, default 2000 pA) — above → dropped
  (artefact rejection).
- `min_iei_ms` (default 5 ms) — bursts of overlapping peaks thinned by
  keeping the largest.
- `auc_min_pas` (optional, default off).

---

## Backend

### New files

**`backend/analysis/events.py`** (core algorithms, ~800 lines)
```
fit_biexponential(time, values, initial_rise_ms, initial_decay_ms)
    → { b0, b1, tau_rise, tau_decay, r_squared }

compute_rms(values, region_start_idx, region_end_idx)
    → float

detect_events_correlation(
    values, sr, template, cutoff,
    peak_direction, min_iei_ms,
) → list[candidate_peak_idx]

detect_events_deconvolution(
    values, sr, template,
    cutoff_sd, low_hz, high_hz,
    peak_direction, min_iei_ms,
) → list[candidate_peak_idx]

detect_events_threshold(
    values, sr, threshold_line,
    peak_direction, min_iei_ms,
) → list[candidate_peak_idx]

measure_event_kinetics(
    values, sr, peak_idx,
    baseline_search_ms, avg_baseline_ms,
    avg_peak_ms, rise_low_pct, rise_high_pct,
    decay_pct, decay_search_ms,
    peak_direction,
) → EventKinetics dataclass

run_events(
    values, sr,
    method: 'template' | 'threshold',
    template_params, threshold_params,
    kinetics_params, exclusion_params,
    manual_edits,
) → { events: list[EventRow], detection_measure: np.ndarray }
```

**`backend/api/events.py`** (~300 lines)
```
POST /api/events/detect
  body: group, series, channel, sweep (int, null = all in series),
        method, template_params, threshold_params,
        kinetics_params, exclusion_params,
        manual_edits
  returns: { events: [...], detection_measure: [...]? }

POST /api/events/template/fit
  body: group, series, channel, sweep, t_start_s, t_end_s,
        initial_rise_ms, initial_decay_ms, direction
  returns: { b0, b1, tau_rise_ms, tau_decay_ms, r_squared,
             time: [...], fit_values: [...] }

POST /api/events/refine_template
  body: group, series, channel, sweep, events (list of peak times),
        window_before_ms, window_after_ms, alignment
  returns: { avg_time: [...], avg_values: [...],
             fit: { ... same as template/fit ... } }

POST /api/events/rms
  body: group, series, channel, sweep, t_start_s, t_end_s
  returns: { rms, baseline_mean, region_n_samples }

POST /api/events/detection_measure
  body: group, series, channel, sweep, method, template, cutoff
  returns: { time: [...], values: [...], cutoff_line: [...] }
  (returned data is downsampled to ~4000 points for plot overlay)
```

### Template persistence

Electron prefs, global (not per-file):
```json
"eventsTemplates": {
  "selectedId": "epsc-default",
  "entries": {
    "epsc-default": {
      "name": "EPSC default",
      "b0": 0, "b1": -30, "tau_rise_ms": 0.5, "tau_decay_ms": 5,
      "width_ms": 30, "direction": "negative"
    },
    "ipsc-default": { ... }
  }
}
```

Per-series events results (the detection output + params used) follow
the same per-(group:series) pattern as every other analysis for now.
Full cross-session results persistence is deferred to the later general
persistence pass.

---

## Frontend

### New window — `EventDetectionWindow.tsx`

Two-column layout, same as the others. Covers ~1500 lines.

**Top row (chrome):**
Group / Series / Channel multi-select (reuse `ChannelsOverlaySelect`) /
Sweep navigator.

**LEFT panel (scrollable + pinned Run):**

- **Method card**:
  - Method dropdown: Template Matching / Thresholding
  - Peak direction: auto / positive / negative

- **Template card** (when method = template matching):
  - Current template summary: name, `τ_rise`, `τ_decay`, `width_ms`
  - **Buttons**: `Generate template…` (opens dialog) / `Refine template…`
    (opens dialog, enabled after first detection run) / `Load…` / `Save as…`
  - Detection algorithm: Correlation / Deconvolution
  - Cutoff:
    - Correlation → 0-1, default 0.4
    - Deconvolution → SD, default 3.5 + low/high Hz for bandpass
  - `[✓] Show detection measure on viewer` — enables overlay subplot

- **Threshold card** (when method = thresholding):
  - Threshold mode: RMS / Linear
  - RMS mode:
    - `Select quiet region…` button → enters drag-select mode on viewer
    - Shows: computed RMS, baseline mean, region span
    - `n × RMS` multiplier input (default 3)
  - Linear mode:
    - Threshold value input (draggable line on viewer)

- **Kinetics card**:
  - `baseline_search_ms` (10)
  - `avg_baseline_ms` (1)
  - `avg_peak_ms` (1)
  - `rise_low_pct` / `rise_high_pct` (10 / 90)
  - `decay_pct` (37)
  - `decay_search_ms` (30)

- **Exclusion card**:
  - `amplitude_min_pa` (5)
  - `amplitude_max_pa` (2000)
  - `min_iei_ms` (5)
  - `auc_min_pas` (optional toggle)

- **Pinned Run footer**:
  - Big Run button
  - Sweeps dropdown (All / Single) — no Range in P1, events spanning
    sweep boundaries are an edge case we'll handle later
  - Secondary: Clear, Export CSV

**RIGHT panel:**

- **Continuous sweep viewer** (reuse / generalise BurstSweepViewer):
  - Viewport preset row (Full / 5s / 2s / 1s / Custom)
  - Nav arrows (⟨⟨ ⟪ ◀ ▶ ⟫ ⟩⟩)
  - Viewport slider (minimap)
  - Time readout
  - Event markers: red filled circle at peak (negative: below trace;
    positive: above), light-blue circle at foot/baseline, purple circle
    at decay endpoint
  - Threshold line overlay (red) in linear mode
  - Shaded quiet-region band in RMS-select mode
  - **Interactions** (matching BurstWindow conventions):
    - Click empty space with "Add event" mode → new event at click X
    - Double-click existing peak marker → discard
    - Drag-select with hold-D → discard all peaks inside
    - Scroll = zoom X, ⌥scroll = zoom Y, drag = pan
- **Detection-measure overlay subplot** (optional, via stacked-subplot
  pattern):
  - Shows correlation r(t) or deconvolution σ(t)
  - Horizontal line at cutoff
  - X-sync from primary viewer
- **Horizontal splitter** (3px / 2px)
- **Results table**:
  - Columns: #, sweep, peak_time_s, peak_pa, baseline_pa, amplitude_pa,
    rise_time_ms, decay_time_ms, half_width_ms, auc_pa_s, method
  - Click row → scroll viewer to that event (pan + flash highlight)
  - Sort by any column

### New dialogs / sub-windows

Two separate Electron windows (following the "multiple windows" pattern
the user likes):

**Template Generator window (`EventsTemplateGenerator.tsx`):**
- Shows the current sweep with `Select exemplar` mode
- User click-drag → region highlighted in red
- `Fit curve` button → backend fits biexponential to that region
- Shows fit overlaid in black
- Sliders + number inputs for τ_rise, τ_decay, b0, b1 (can manually
  tweak and see fit live)
- `Width (ms)` slider — visual template window length
- Template library panel on left:
  - List of saved templates (name + rise/decay)
  - `Load`, `Delete`, `Save as new` buttons
- `Apply & Close` writes the template back to the main window

**Template Refinement window (`EventsTemplateRefine.tsx`):**
- Opens after at least one detection run
- Shows all detected events aligned on peak, overlaid
- Average event in red
- Biexponential fit overlaid
- Alignment dropdown: peak / rise half-width / baseline
- `Fit to average` button → biexponential fit on the average
- `Accept refined template` → replaces currently-selected template
  coefficients, main window re-runs detection on accept

### Store additions

```ts
interface EventsTemplate {
  id: string
  name: string
  b0: number
  b1: number
  tauRiseMs: number
  tauDecayMs: number
  widthMs: number
  direction: 'positive' | 'negative'
}

interface EventsParams {
  method: 'template' | 'threshold'
  peakDirection: 'auto' | 'positive' | 'negative'
  // template
  templateId: string  // id from the library
  detectionMethod: 'correlation' | 'deconvolution'
  correlationCutoff: number
  deconvCutoffSd: number
  deconvLowHz: number
  deconvHighHz: number
  // threshold
  thresholdMode: 'rms' | 'linear'
  rmsRegion: { startS: number; endS: number } | null
  rmsValue: number | null
  rmsBaselineMean: number | null
  rmsMultiplier: number
  linearThresholdPA: number
  // kinetics
  baselineSearchMs: number
  avgBaselineMs: number
  avgPeakMs: number
  riseLowPct: number
  riseHighPct: number
  decayPct: number
  decaySearchMs: number
  // exclusion
  amplitudeMinPA: number
  amplitudeMaxPA: number
  minIEIMs: number
  aucMinPAs: number | null
}

interface EventRow {
  sweep: number
  peakTimeS: number
  peakPA: number
  baselinePA: number
  footTimeS: number
  amplitudePA: number
  riseTimeMs: number | null
  decayTimeMs: number | null
  halfWidthMs: number | null
  aucPAs: number | null
  manual: boolean   // added by user vs auto-detected
}

interface EventsData {
  group: number
  series: number
  channel: number
  params: EventsParams
  events: EventRow[]
  selectedIdx: number | null
  manualEdits: { added: EventRow[]; removedPeakTimes: number[] }
  detectionMeasurePreview: { time: number[]; values: number[] } | null
}

// Store slice
eventsTemplates: {
  selectedId: string | null
  entries: Record<string, EventsTemplate>
}
eventsAnalyses: Record<string, EventsData>  // key = "group:series"

// Actions
fitEventsTemplate(group, series, channel, sweep,
                  tStartS, tEndS, direction): Promise<void>
saveEventsTemplate(template): void
loadEventsTemplate(id): void
deleteEventsTemplate(id): void
runEvents(group, series, channel, sweep, params): Promise<void>
refineEventsTemplate(...): Promise<void>
clearEvents(group, series): void
selectEvent(group, series, idx): void
addEventAtTime(group, series, sweep, timeS): void
discardEvent(group, series, idx): void
```

---

## Phase breakdown

### Phase 1 — MVP (this plan)

Ships a working event detection / kinetics / results loop:

- Backend: template fit (biexponential), correlation detection,
  deconvolution detection, thresholding (RMS + linear), full per-event
  kinetics, exclusion, manual-edit passthrough, refine-template endpoint.
- Frontend: EventDetectionWindow two-column layout, continuous viewer
  with viewport nav, Template Generator + Refinement sub-windows,
  results table, click-to-add / double-click-discard, detection-measure
  overlay subplot.
- Template persistence (global library via prefs).

Estimate: 1500 lines backend, ~2500 lines frontend.

### Phase 2 — Workflow completion

- Detection-criterion method (Clements-Bekkers amplitude/noise scaling)
- **Events Overlay window** — all events aligned, cycle-through,
  most-distant outlier mode, delete from overlay
- **Average Event analysis** — compute kinetics on the average, with
  filter + normalize + optional biexponential refit
- Manual add via click-drag (region-based, peak = max within region —
  more forgiving than single-click)
- Edit Kinetics mode — drag baseline / decay endpoint on individual
  events
- Event groups (1–5, keyboard-assigned) + per-group filtered results
- Interpolate-to-200kHz option
- R² exclusion + fit-with-shifted-start for biexponential/monoexp
  decay fits
- Monoexponential decay fit per event (optional)
- **Also in Phase 2: port the BurstWindow click-to-add /
  double-click-discard pattern to APWindow** (AP currently uses a
  different interaction — align it with the rest)

### Phase 3 — Power features

- Curve / polynomial-fit threshold
- Drawn threshold
- Multi-template (up to 3 simultaneous, assignment rules)
- Max rise / max decay slope (regression over n samples)
- Histograms + CDFs for every parameter (reuse Phase 2's per-param
  extraction)
- Burst detection on events (LogISI + MaxInterval — same algorithms
  already available for APs)
- Omit-time-periods (exclude stim artefacts by time range)
- Batch mode integration (when the general batch infrastructure lands)

---

## Open questions to resolve during Phase 1

1. **Scope of "Run" for continuous data** — many event recordings are
   one giant sweep (30 s – 10 min). Running on "all sweeps" is the same
   as running on sweep 0 for those. But for epileptiform recordings
   with evoked stim + spontaneous activity in successive sweeps, users
   want to run the whole series. Default to "current sweep" and offer
   "all sweeps" — simplest right answer for P1.

2. **Detection-measure resolution** — at 50 kHz × 60 s = 3M samples.
   Sending the full correlation trace to the frontend for overlay will
   be slow. Downsample to ~4000 points (matches uPlot's typical
   resolution) with max-preserving decimation. Backend-side.

3. **Auto peak direction** — "auto" infers sign from the template's
   `b1` coefficient (negative → negative events). For thresholding
   mode "auto" picks the direction with more threshold crossings on a
   test region. Probably fine; revisit if it misbehaves.

4. **Manual-add when no template / threshold set yet** — disable Run
   button until at least one valid detection configuration exists.
   Allow manual-add even before a first run (it just creates an
   EventsData with an empty auto-detected list).

5. **Baseline foot on slow-rising events** — Jonas's foot-intersect
   assumes a sharp rising phase. For broad events (IPSCs, LFP ripples)
   it can overshoot. Offer a "baseline mode" fallback: "simple" =
   mean of pre-peak window, "jonas" = foot-intersect. Default to jonas;
   switch to simple if fit fails.

---

## Dependencies / prereqs

- `scipy.optimize.curve_fit` for biexponential fitting (already in use)
- `numpy.fft` for deconvolution (no new deps)
- `scipy.signal.butter` / `sosfilt` for Gaussian bandpass on the
  deconvolved trace (already used elsewhere)
- `scipy.stats.norm` for fitting the amplitude histogram (already in use)
- Continuous viewer reuses `BurstSweepViewer` — may need to extract
  into a shared component (`ContinuousSweepViewer`) to avoid
  divergence; evaluate during Phase 1.

---

## Implementation order (Phase 1)

Concrete stepwise checklist:

1. **Backend core** (`analysis/events.py`):
   a. Biexponential function + `fit_biexponential`.
   b. RMS + baseline computation helper.
   c. Correlation sliding-window detector.
   d. Deconvolution detector (FFT + Gaussian bandpass + histogram fit).
   e. Threshold detector.
   f. `measure_event_kinetics` — Jonas foot intersect, smoothed peak,
      rise/decay/half-width/AUC.
   g. Exclusion filter.
   h. `run_events` top-level that glues a-g together.
   i. Unit tests per function with synthetic data.

2. **Backend API** (`api/events.py`):
   a. `/detect`, `/template/fit`, `/rms`, `/detection_measure`,
      `/refine_template` endpoints.
   b. Register router in `main.py`.

3. **Frontend store**:
   a. `EventsTemplate`, `EventsParams`, `EventRow`, `EventsData` types.
   b. `eventsTemplates` + `eventsAnalyses` slices.
   c. Actions (runEvents, fitEventsTemplate, ...).
   d. Persistence subscribers (templates only).

4. **Shared continuous viewer**:
   a. Evaluate extracting `ContinuousSweepViewer` from
      `BurstSweepViewer` to avoid duplication.
   b. If extracted, port BurstWindow over too.
   c. Otherwise clone and diverge — faster for P1.

5. **Main window** (`EventDetectionWindow.tsx`):
   a. Two-column skeleton.
   b. Method/Template/Threshold/Kinetics/Exclusion cards in left panel.
   c. Run footer.
   d. Primary viewer integration (with event markers + threshold line
      + RMS region band).
   e. Detection-measure overlay subplot.
   f. Results table + click-to-jump.
   g. Manual add / discard interactions.

6. **Template Generator window**:
   a. Separate Electron window + BroadcastChannel sync.
   b. Exemplar select mode.
   c. Fit + live slider tweak.
   d. Template library panel.
   e. Apply-and-close propagation.

7. **Template Refinement window**:
   a. Same pattern as Generator.
   b. Overlay of detected events + average + fit.
   c. Alignment mode selector.
   d. Accept-refined flow.

8. **Polish pass** — keyboard shortcuts, empty states, error banners,
   documentation comments.

---

## Non-goals (for Phase 1)

- Events detected across sweep boundaries (continuous recording with
  sweep breaks). P2.
- Partial re-run (detect only inside a viewport window). P3.
- Histograms / CDFs. P3.
- Burst analysis on events. P3.
- Batch analysis across files. Deferred across all modules.
- Frequency-domain analysis of event trains (power spectra, etc.). Out
  of module scope.
