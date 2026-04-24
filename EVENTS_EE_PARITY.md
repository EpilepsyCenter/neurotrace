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
- [x] **All-events overlay panel** (#9) — Overlay tab shows every
  event aligned on peak (or foot), mean in red, ±1 SD envelope.

## Sprint 2 — per-event precision ✅ DONE

- [x] **Amplitude histogram with Gaussian overlay** (#8) — Histogram
  tab with amplitude bars + N(μ, σ) curve scaled to peak count.
- [x] **Per-event monoexponential decay τ** (#4) — fit of
  `baseline + a·exp(-t/τ)` from peak → decay endpoint; reported per
  event row and in the CSV.
- [x] **Event-by-event browser** (#6) — Browser tab with
  prev/next + keyboard ← / → nav, zoom-to-event button, kinetics
  card, and a zoomed single-event plot with foot / peak / decay
  markers.
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

## Out of scope (deferred)

- Auto-detecting stimulus-artifact regions to skip during detection
  (needs protocol introspection; separate feature).
- Cross-sweep alignment (for pooling events across sweeps) — EE has
  per-sweep tabs; we're single-sweep today.
- Poisson-like rate modeling / burst detection on top of events.

## Changelog

- **2026-04-24** — Sprint 1 opened. Baseline foot bug queued.
- **2026-04-24** — Sprint 1, 2, 4 done + Sprint 3 partial (multi-
  template detection + detrend). Deferred: draggable markers, RMS-
  in-area auto-threshold, min-IEI pytest. See the Sprint tables
  above for the remaining items.
