# Event detection — EE parity backlog

Rolling record of Easy-Electrophysiology features we still need to
match in the NeuroTrace events module. Items are checked off as they
land; order is chosen by "most user-visible payoff per hour of work".

## Sprint 1 — QC & usability (small, high-impact)

- [x] **Baseline foot-detection bug** — sometimes detects the event
  foot far back into the pre-peak window, inflating rise times.
  Root cause: `_find_rise_crossing` walks forward from pre-window
  start and returns the FIRST crossing of the 20 % / 80 % threshold,
  so any baseline-noise dip below the threshold gets mistaken for the
  rise. Fix: scan backward from the peak end of `pre`, return the
  rise crossing nearest to peak.
- [ ] **Summary stats card** (#10) — n events, mean amp ± SD,
  mean rise/decay/FWHM, frequency (Hz), mean IEI ± SD. Lives above
  the results table.
- [ ] **Exclusion filter UI** (#7) — the `exclusion` params already
  exist in the store; add min/max inputs for amplitude, rise, decay,
  FWHM, plus a "discard" tick per event in the table.
- [ ] **All-events overlay panel** (#9) — optional second tab
  beside the trace viewer that stacks every detected event aligned
  on peak (or foot), draws the mean in red, ±1 SD envelope in
  translucent red. Matches EE's "Events" tab.

## Sprint 2 — per-event precision

- [ ] **Amplitude histogram with Gaussian-fit cutoff** (#8) — small
  plot showing the distribution of DM values (correlation r or
  deconvolved σ) with the Gaussian fit overlaid and the current
  cutoff line. User sees "am I sampling tail or noise?".
- [ ] **Per-event monoexponential decay τ** (#4) — fit `b0 + b1·exp(-t/τ)`
  from peak → decay-endpoint for each event, report `decayTauMs` per
  row. Reuse `fit_biexponential` with `tau_rise` pinned to ~0.
- [ ] **Draggable event markers** (#5) — click-and-drag the foot,
  peak, or decay-endpoint dot on the main viewer to correct one
  event's kinetics. Backend supports via `/api/events/remeasure` or
  inline on the frontend using cached trace.
- [ ] **Event-by-event browser** (#6) — keyboard arrows + a
  zoomed-in single-event plot (centered on selected row), so the
  user can tab through events one at a time with kinetics visible.

## Sprint 3 — detection strength

- [ ] **Three-template detection** — EE supports detecting with up
  to three biexp templates simultaneously, taking `max(r_1, r_2, r_3)`
  for correlation or the union for deconvolution. Store needs a
  `selectedIds: string[]` (up to 3) instead of single `selectedId`;
  detection endpoint loops over templates.
- [ ] **RMS-in-area auto-threshold** (#1) — compute a rolling-window
  RMS of the quiet stretches between events and use that × multiplier
  as the live threshold, updating as the user drags the cutoff band.
- [ ] **Detrend / baseline-subtract pre-detection** (#2) — optional
  rolling-median subtraction before detection to deal with slow
  drift. Independent of the high-pass filter.
- [ ] **Verify min-IEI refractory** (#3) — `minIeiMs` exists in params
  but I want a test confirming it's honored by all three detection
  methods.

## Sprint 4 — analytics & I/O

- [ ] **Inter-event interval CSV** (#11) — extra column in events
  CSV export for IEI + separate "iei-only" export for rate analysis.
- [ ] **PSTH / rate-vs-time plot** (#12) — bottom-tab plot that
  shows event rate in Hz binned over time. Useful for seeing
  wash-in / wash-out effects.
- [ ] **Template import/export JSON** (#13) — save / load template
  library slices to share between datasets.
- [ ] **Template preview thumbnails** (#14) — render a tiny
  black-curve thumbnail next to each library entry in the dropdown,
  so users can pick by shape.

## Out of scope (deferred)

- Auto-detecting stimulus-artifact regions to skip during detection
  (needs protocol introspection; separate feature).
- Cross-sweep alignment (for pooling events across sweeps) — EE has
  per-sweep tabs; we're single-sweep today.
- Poisson-like rate modeling / burst detection on top of events.

## Changelog

- **2026-04-24** — Sprint 1 opened. Baseline foot bug queued.
