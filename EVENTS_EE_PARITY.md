# Event detection — EE parity backlog

Rolling record of Easy-Electrophysiology features we still need to
match in the NeuroTrace events module. Items are checked off as they
land; order is chosen by "most user-visible payoff per hour of work".

## Sprint 1 — QC & usability (small, high-impact) ✅ DONE

- [x] **Baseline foot-detection bug** — walks backward from peak now
  (via `_find_rise_crossing_near_peak`) so baseline-noise dips can't
  be mistaken for the rise foot.
- [x] **Summary stats card** (#10) — inline bar above the bottom
  tabs: n events, rate (Hz), amp ± SD, rise / decay / FWHM / IEI.
- [x] **Exclusion filter UI** (#7) — now covers min/max |amp|,
  min IEI, and nullable max rise / max decay / max FWHM / min AUC.
- [x] **All-events overlay panel** (#9) — aligned on peak (or foot),
  mean in red, ±1 SD envelope. Now lives in the detached Browser &
  Overlay window.

## Sprint 2 — per-event precision ✅ DONE

- [x] **Amplitude histogram with Gaussian overlay** (#8) — Histogram
  tab with amplitude bars + N(μ, σ) curve scaled to peak count.
- [x] **Per-event monoexponential decay τ** (#4) — fit of
  `baseline + a·exp(-t/τ)` from peak → decay endpoint; reported per
  event row and in the CSV.
- [x] **Event-by-event browser** (#6) — in the detached window: prev/
  next + keyboard ← / →, discard button, kinetics card, zoomed plot
  with foot / peak / 20% / 80% / FWHM / decay markers (matches EE
  manual p29), filter toggle, scroll-to-zoom + drag-to-pan.
- [ ] **Draggable event markers** (#5) — deferred; drag-to-correct
  foot / peak / decay on the main viewer. Needs a UX pass on the
  edit mode before it's worth building.

## Sprint 3 — detection strength (partial)

- [x] **Three-template detection** — EE's 1/2/3 templates: primary +
  up to 2 additional. Correlation merges via pointwise max of r(t);
  deconvolution merges via union of peak sets with shared min-IEI.
  Template panel has 3 slots; primary drives the overlay.
- [x] **Detrend / baseline-subtract pre-detection** (#2) — optional
  rolling-median subtraction ahead of the Butterworth filter. Knob
  in the Pre-detection filter card.
- [ ] **RMS-in-area auto-threshold** (#1) — deferred; needs a
  detect-quiet-regions helper and cursor-drag linkage.
- [ ] **Verify min-IEI refractory** (#3) — still want a pytest that
  asserts `minIeiMs` is honored for each of the three detection
  methods on synthetic data.

## Sprint 4 — analytics & I/O ✅ DONE

- [x] **Inter-event interval CSV** (#11) — IEI column added to the
  table and CSV export.
- [x] **PSTH / rate-vs-time plot** (#12) — Rate tab with user-
  adjustable bin width, shown as bars.
- [x] **Template import/export JSON** (#13) — buttons in the main
  template panel. Round-trips `id / name / b0 / b1 / τ / width /
  direction`.
- [x] **Template preview thumbnails** (#14) — SVG biexp thumbnail
  beside the active template's coefficient readout. Color codes by
  direction (red = negative, blue = positive).

## Sprint 5 — integration with the main viewer ✅ DONE

- [x] **Event markers on the main TraceViewer** (outside the Events
  analysis window) — peak / foot / decay dots for the current sweep's
  events, same visibility-toggle pattern as bursts and APs. Disk-
  persisted per recording via `savedEventsAnalyses` in Electron prefs.
- [x] **Detached Browser & Overlay window** — new Electron window
  `events_browser` opens on click from the results-tabs bar. Both
  views (Browser + Overlay) have scroll-to-zoom, drag-to-pan, and
  dbl-click to reset; both honour the pre-detection filter (with a
  live toggle).
- [x] **Pre-detection filter defaults** — bandpass 1–1000 Hz, order 1
  (EE's mEPSC defaults).

## Backlog — still outstanding or new

### From the user's review

- [ ] **Display interpolation** — EE upsamples each event window ~10×
  for smoother rendering at tight zooms. Probably not strictly
  necessary for us: the backend already reports sub-sample foot
  positions via the 20/80-line slope intersection, and uPlot
  connects raw samples linearly. Revisit if users complain about
  jagged visuals inside the Browser window.
- [ ] **Draggable event markers** (Sprint 2 carry-over) — drag foot/
  peak/decay dots to correct one event's kinetics. Needs a mode
  switch so it doesn't clash with cursor-band drag + click-to-add.
- [ ] **RMS-in-area auto-threshold** (Sprint 3 carry-over).
- [ ] **Verify min-IEI refractory** (Sprint 3 carry-over).

### EE features I don't think we have yet

- [ ] **Cross-sweep detection** — run detection on every sweep in a
  series at once, pool the results into one table. We're single-
  sweep today. Needs per-sweep rows in `EventsData` or a new
  container. Big UX change: sweep-selector column in the table, the
  Browser needs to address (sweep, idx) rather than idx alone.
- [ ] **Auto-skip stimulus artifact regions** — when the series has
  a stimulus protocol, skip detection ±N ms around each pulse
  edge. Reuses `sweepStimulusSegments` from the store.
- [ ] **Per-event biexp fit** — fit the full biexp (both τ_rise and
  τ_decay) to each event, not just monoexp decay. Gets rise τ per
  event instead of just the rise-time-ms percent measurement.
- [ ] **Amplitude-vs-time scatter** — tab next to Rate for a scatter
  of amplitude vs. peak time. Reveals run-down / drug-response
  trends at a glance.
- [ ] **IEI histogram** — separate histogram of inter-event
  intervals. Often reveals refractory period or bursting structure.
- [ ] **Copy-to-clipboard** — results table as TSV for direct paste
  into Excel / Prism / Origin.
- [ ] **Rise-time convention switcher** — EE lets users pick 10–90,
  20–80, or custom percentile pair from a dropdown. We expose the
  raw `riseLowPct` / `riseHighPct` params but no picker.
- [ ] **Event-deletion keyboard shortcut** — Del / Backspace on a
  selected row should discard it. Matches EE.
- [ ] **Skip-region cursors** — a second cursor pair marks a time
  range where detection should be suppressed. Useful for ignoring
  perfusion switch artifacts mid-recording.
- [ ] **Per-sweep window stats** — split sweep into N equal windows
  and report stats per window (dose-response / wash-in studies).
- [ ] **Sweep annotations** — free-text per-sweep notes field,
  persisted alongside the analysis.

## Out of scope (explicitly deferred)

- Poisson-like rate modeling / burst detection on top of events.
- Machine-learning-based event detection (CNN classifiers, etc.).
- Real-time (during-acquisition) detection.

## Changelog

- **2026-04-24** — Sprint 1 opened. Baseline foot bug queued.
- **2026-04-24** — Sprint 1, 2, 4 done + Sprint 3 partial (multi-
  template detection + detrend).
- **2026-04-24** — Sprint 5 landed: event markers on the main
  TraceViewer + detached Browser & Overlay window with zoom/pan +
  filter toggle + EE-p29 kinetics dots. Refreshed defaults
  (1–1000 Hz order 1). Added a long backlog of EE features we
  didn't originally scope in: cross-sweep detection, auto-skip
  stim artifacts, per-event biexp, amp-vs-time, IEI histogram,
  copy-to-clipboard, rise-time picker, Del-to-discard, skip-region
  cursors, per-sweep window stats, sweep annotations.
