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

## Sprint 6 — deep EE parity (done)

- [x] **Cross-sweep detection** — `/detect` now accepts a `sweeps`
  list and concatenates events across sweeps with per-event `sweep`
  field. Frontend has a "Run on" dropdown under the Run button
  (Current / All sweeps); excluded sweeps are auto-skipped. Results
  table gets a Sweep column in cross-sweep mode; IEI no longer spans
  sweep boundaries; clicking a row switches the viewer to the event's
  sweep before re-centring. Rate / IEI tabs use `totalLengthS` so
  Hz comes out right across sweeps.
- [x] **Skip regions** (manual artifact skip) — up to 5 cursor-band
  pairs on the main events viewer. Collapsible card in the left
  panel manages them (add / remove / enable / "from cursors").
  Draggable on the viewer just like the baseline cursor band;
  disabled regions render as dashed ghosts. Backend `/detect` drops
  any peak whose time falls inside an enabled region.
- [x] **Per-event biexp fit** — fit the full biexp
  `b0 + b1·(1-exp(-t/τ_r))·exp(-t/τ_d)` to each event's
  (foot → decay-endpoint) window. `biexpTauRiseMs`, `biexpTauDecayMs`,
  `biexpB0`, `biexpB1` added to `EventRow` and to the CSV. New
  `τ rise (ms)` column in the results table.
- [x] **Amp-vs-time scatter tab** — new bottom tab next to Rate.
- [x] **IEI histogram tab** — new bottom tab, sqrt-N auto-binning
  with optional override, mean IEI line.
- [x] **Rise-time convention switcher** — dropdown in the Kinetics
  card: 10-90 (default) / 20-80 (noise-robust) / 37-63 (1 τ span) /
  Custom. Behind the scenes, just drives `riseLowPct` / `riseHighPct`.

## Backlog — still outstanding or new

### From earlier sprints

- [ ] **Draggable event markers** — drag foot/peak/decay dots on the
  main viewer to correct one event's kinetics. Needs a mode switch
  so it doesn't clash with cursor-band drag + click-to-add.
- [ ] **RMS-in-area auto-threshold** — compute a rolling-window RMS
  of the quiet stretches between events, use × multiplier as a
  self-updating threshold.
- [ ] **Verify min-IEI refractory** — pytest asserting `minIeiMs`
  is honoured by all three detection methods on synthetic data.
- [ ] **Display interpolation** — optional 10× upsampling in the
  Browser window for smoother zoom. Probably not needed: markers
  already carry sub-sample precision; trace at 20 kHz looks fine.

### EE features still to add

- [ ] **Auto-skip stimulus artifact regions** — auto-detect TTL
  edges in the stimulus and pre-populate skip regions around them.
  Now that manual skip regions exist, this just needs a "detect
  artifacts" button that writes into `params.skipRegions`.
- [ ] **Copy-to-clipboard** — results table as TSV for direct paste
  into Excel / Prism / Origin.
- [ ] **Event-deletion keyboard shortcut** — Del / Backspace on a
  selected row should discard it.
- [ ] **Per-sweep window stats** — new bottom tab: split current
  sweep (or all sweeps when cross-sweep is on) into N bins, show
  per-bin count / rate / mean amp / mean rise. Good for wash-in /
  wash-out analyses. UI-only once we add a tab and a bin-count
  field.
- [ ] **Sweep annotations** — free-text per-sweep notes. Persisted
  per (file, group, series, sweep) in Electron prefs. Small strip
  under the sweep selector. Included in the CSV export as an
  extra column. Badge on the main TraceViewer when a sweep has
  notes. No backend needed.

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
- **2026-04-24** — Sprint 6 landed most of that deep-parity batch:
  cross-sweep detection + Sweep column + sweep-boundary-aware IEI,
  manual skip regions with draggable cursor bands on the viewer,
  per-event biexp fit (τ_rise + τ_decay + b0 + b1 per event, in the
  CSV too), rise-time convention dropdown, Amp-vs-time + IEI hist
  tabs. Remaining: draggable markers, RMS-in-area, min-IEI pytest,
  auto-skip stim, copy-to-clipboard, Del-to-discard, per-sweep
  window stats, sweep annotations.
