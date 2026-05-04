# Data Module Plan — text import + per-channel scaling overrides

> **Status (2026-05-04): all 7 implementation steps shipped.** See the
> "As-built notes" section at the bottom for deviations from the
> original design.

## Goals

1. **Import generic text files** (CSV / TSV / whitespace ASCII / Axon ATF) so users with non-binary data can load recordings.
2. **Per-channel scaling overrides** that the user can edit post-import to fix wrong units (e.g. data came in as raw V but should display/analyse as mV). Overrides apply numerically: every analysis module sees the corrected values, not just the y-axis.
3. **Persist** the overrides in the existing `.neurotrace` sidecar so they survive across sessions and are portable with the recording.

## Current state (as of 2026-05-04)

- `Trace` already carries `units`, `y_scale`, `y_offset` (`backend/readers/models.py:11-20`) — `y_scale`/`y_offset` exist but are never populated by any reader. We can repurpose them as the override hook without schema churn.
- Channel `units` are surfaced to the frontend per-series via `Recording.to_dict()` → `RecordingInfo.groups[].series[].channels[]` (`appStore.ts:36-41`). No scale factor is sent.
- Reader dispatch is extension/magic-byte sniff in `backend/api/files.py` against an ordered `READERS` list. No text reader exists.
- Sidecar is **frontend-only**, written via `window.electronAPI.writeSidecar` (debounced 1s, `appStore.ts:240`). Schema is `SidecarPayload v2` (`appStore.ts:310-344`).
- Analyses read units from `Trace.units` of the first sweep; no analysis currently consults `y_scale`/`y_offset`.

## Design

### A. Text reader (`backend/readers/text_reader.py`)

New `TextReader(BaseReader)` registered in `files.py` READERS list (after binary readers so binary is preferred when ambiguous).

- `can_read`: extension in `.csv .tsv .txt .dat .atf` AND a cheap content sniff (first non-comment line parses as numbers, ATF magic header `"ATF\t"` for Axon Text File).
- Two parse modes:
  - **Generic delimited**: auto-detect delimiter (`,` `\t` whitespace), skip `#`/`%` comment lines, detect optional header row. First numeric column = time *or* sample index; remaining columns = channels.
  - **ATF**: parse Axon ATF v1.0 header (`"ATF"` line → header rows count → column titles with embedded units like `"Im (pA)"`).
- Import options (passed via `/api/files/open` body, persisted in sidecar):
  - `sample_rate_hz` (required if no time column)
  - `time_column` (`none | first | named`)
  - `delimiter` (`auto | , | \t | space`)
  - `units_per_channel: string[]` (default parsed from header / `""`)
  - `sweep_mode` (`single | column-per-sweep | block-separated`) — defaults to single sweep
- Output: a `Recording` with one `Group` → one `Series` → one or more `Sweep`s, units pre-populated from header/options.

### B. Scaling override layer

**Invariant: overrides apply *before* every analysis sees the data.** No analysis module reads `trace.data` directly after this lands; they all go through `scaled(trace)`. This is enforced by deleting / replacing every direct `trace.data` access during the audit step (Implementation step 1) and is the single most important correctness property of this module — easy to regress, so step 1 ends with a grep gate (`grep -rn "\.data\b" backend/analysis backend/api/traces.py` returns only `scaled(trace)` callsites or known-safe metadata reads).

Two-place model:

1. **Backend `Trace.y_scale` / `y_offset`** become the canonical numerical scaling: `value_displayed = data * y_scale + y_offset`. Readers continue to set `1.0 / 0.0` by default. The text reader can also leave them at 1/0 — overrides come from the sidecar at file-open time.
2. **Sidecar** stores user-applied overrides keyed by `(group, series, channel)`.

Flow on file open:
1. Backend reader returns `Recording` with raw `y_scale=1, y_offset=0`.
2. Frontend reads sidecar; if `scale_overrides` present, POSTs them back to `/api/files/apply_overrides` (new endpoint) which mutates the in-memory cached recording's `Trace.y_scale`/`y_offset` and rewrites `units` per channel.
3. **All trace endpoints** (`/api/traces/data`, `/api/traces/average`, `/api/analysis/run`, every `api/<domain>/*`) apply `data * y_scale + y_offset` at the point they read sweep data, via a small helper `apply_scale(trace) -> ndarray` in `utils/`. This is the only code change required in analysis modules — they keep reading `trace.units` as before, which now reflects the override.

A single helper enforces consistency:

```python
# backend/utils/scaling.py
def scaled(trace: Trace) -> np.ndarray:
    if trace.y_scale == 1.0 and trace.y_offset == 0.0:
        return trace.data
    return trace.data * trace.y_scale + trace.y_offset
```

Replace direct `trace.data` reads inside analyses + `/api/traces/*` with `scaled(trace)`. Search-and-replace audit needed; tracked as a checklist item below.

### C. Sidecar additions (v3)

Bump `SidecarPayload.version` to `3`. New top-level slice:

```ts
scale_overrides?: {
  // key = `${groupIndex}:${seriesIndex}:${channelIndex}`
  [key: string]: {
    units: string         // user-corrected unit string, e.g. "mV"
    y_scale: number       // multiplicative factor applied to raw samples
    y_offset: number      // additive offset (post-scale), default 0
    note?: string         // free-text reason ("imported as V, should be mV")
  }
}
```

Backwards compat: v2 sidecars load fine; absence of `scale_overrides` = no-op. Saving always writes v3.

### D. Frontend UI

1. **Channel scaling editor** — single modal, two entry points (both required):
   - **Primary (contextual)**: right-click on a channel pill in `TreeNavigator` → "Edit scaling…". Opens the modal pre-focused on that channel.
   - **Secondary (global)**: new Toolbar button labeled **"Scaling"**, placed *immediately before* the existing "Traces" dropdown in `Toolbar.tsx`. Enabled only when a recording is open. Opens the modal showing every channel across all series, so the user can audit and bulk-edit.
   - Fields per channel row: current units (read-only), override units (text or dropdown), `y_scale`, `y_offset`, preset buttons (V→mV ×1000, A→pA ×1e12, mV→V ÷1000, pA→A ÷1e12, ×10, ÷10, reset), free-text note.
   - Live preview of scaled min/max for the first sweep of the focused channel.
   - Apply is atomic per modal session: all edits are sent in one `apply_overrides` call.
2. **Text-import wizard** — auto-opens when `TextReader` is the dispatched reader, *before* the recording commits. Modal collects delimiter / sample-rate / units / sweep-mode; header sniff pre-fills units when possible. Persisted in sidecar so subsequent re-opens are silent. Also reachable later via a "Re-import options…" entry.
3. **Post-import scaling nudge**: if a text import finishes with any channel `units == ""`, show a non-blocking toast — *"No units detected — set channel scaling"* — that opens the Scaling modal. Skippable. Binary readers never trigger this since they always populate units.
4. **Visual indicator** on channel pills with active overrides (small `×N` badge), tooltip shows the override (`raw V → mV (×1000)` style).

### E. Cross-window sync

New BroadcastChannel message type `scale-overrides-update` mirroring the existing pattern (`bursts-update` etc.):
- Update `CursorPanel.tsx` `state-request` reply + adopt-handler.
- Update `AnalysisWindow.tsx` adopt-handler.
- `appStore.ts`: `_broadcastScaleOverrides`, setter action, prefs save/load + `subscribe` block keyed on `state.recording?.filePath`.

Analysis windows refetch trace data on `scale-overrides-update` so their displayed traces match.

## Dormant-by-default behavior

Most recordings (HEKA, ABF) arrive with correct units and need no overrides. The module must be invisible in that case:

- **Backend**: `scaled(trace)` short-circuits on `y_scale==1.0 and y_offset==0.0` — single branch, no copy, no allocation. Recording cache is not mutated; `apply_overrides` is not called when the sidecar has no `scale_overrides` slice.
- **Cross-window**: no `scale-overrides-update` is ever broadcast, so analysis windows do not refetch for scaling reasons.
- **UI**:
  - No `×N` badge on channel pills.
  - Toolbar "Scaling" button is enabled (recording is open) but opens the modal in a clean state — channel list shown, all rows at `y_scale=1, y_offset=0, units = file-reported`. No nag, no warning, no auto-open.
  - No toast — the empty-units nudge fires only for text imports where `units == ""`.
- **Analysis windows**: behave identically to today. They request `/api/traces/data`, get the same numbers, render the same plots. They do not need to know overrides exist.

Analysis windows only react to overrides when one *becomes active mid-session*: a single `useEffect` subscribed to `scale-overrides-update` invalidates cached trace data and refetches. Same shape as existing `cursor-update` / `sweep-update` handlers.

The dominant code path is "nothing happens." Don't over-engineer the no-override case.

## Implementation order

1. ✅ **Backend plumbing (no UI)** — `backend/utils/scaling.py` with `scaled(trace)`. Audit replaced every sample-value `tr.data` read in `api/traces.py`, `api/cursors.py`, `api/bursts.py`, `api/iv.py`, `api/fpsp.py`, `api/events.py`, `api/ap.py`, `api/analysis.py` (single + per-sweep dispatch). Remaining `tr.data` references are length-only (`.size`) reads.
2. ✅ **Override apply endpoint** — `POST /api/files/apply_overrides` in `api/files.py`. Mutates cached recording, returns updated `RecordingInfo`. Lazily snapshots file-reported units via `_ensure_original_units_snapshot` so clearing an override restores them.
3. ✅ **Sidecar v3** — `SidecarPayload.scale_overrides` slice. v2 sidecars still load. Auto-save subscriber tracks the slice; cross-window `scale-overrides-update` broadcast wired into `CursorPanel` (with sweep-refetch) and `AnalysisWindow`. State-update reply carries `scaleOverrides` so newly-opened windows hydrate.
4. ✅ **Frontend channel editor** — `ScalingModal.tsx` flat-table layout, all channels visible with inline editors and preset chips. Toolbar "Scaling" button placed before the Traces dropdown; right-click on TracesDropdown rows opens the modal pre-focused on a channel.
5. ✅ **Text reader** — `backend/readers/text_reader.py`. Generic delimited (CSV/TSV/whitespace, comment-strip, header units parsed via `_split_label_units`) and ATF v1.0 supported. `BaseReader.read()` extended with `**options`; binary readers accept-and-ignore. Registered last in `READERS` so binary always wins on ambiguous extensions.
6. ✅ **Text-import wizard** — `TextImportWizard.tsx` + `POST /api/files/probe_text` backend endpoint. Auto-fills delimiter / time column / sample rate / per-column units from a 50-row probe. Triggered for `.csv` `.tsv` `.txt` `.atf` from both the Open dialog and the Recent files list. Recording commits only after the user confirms.
7. ✅ **Cross-window sync** — completed inline with step 3; no separate pass needed. Analysis windows refetch via the BroadcastChannel adopt handler.

## As-built notes (deviations from the design above)

- **Override key is `(channel_index, file_units)`, not `(group, series, channel)`.** The original plan keyed overrides per-(g,s,c). During step-4 review the user pushed back: a channel is conceptually a recording-level entity, not a per-series one, and the per-(g,s,c) UI was clunky. We collapsed to per-channel — but mixed-protocol HEKA files reuse the same channel index for different physical signals across CC vs VC series (`r4170728aM.dat` was the canary). The fix was to identify each physical channel by `(channel_index, original_file_units)`. `_ensure_original_units_snapshot` captures the file-reported units at first apply / first probe so the key is stable even after the user changes display units.
- **Sidecar key is `${channelIdx}|${fileUnits}`** (e.g. `0|mV`, `0|pA`). Frontend `parseOverrideKey()` unpacks it; `setScaleOverrides` posts a list of `{channel, file_units, units, y_scale, y_offset}` and the backend handles the (g,s,c) expansion.
- **`/api/files/channels` endpoint** wasn't in the original plan but was needed to surface channels missed by `_channels_for_series`'s first-sweep probe. Walks every sweep of every series, groups by composite key, returns the authoritative list the modal consumes.
- **Toolbar UI**: button labeled "Scaling", placed immediately before the Traces dropdown (per user direction). Right-click on TracesDropdown rows passes only the channel index (the dropdown sees overridden units, not file units) tagged as `index:N`; the modal matches the first row with that index.
- **Preset set**: shipped V↔mV, A↔pA, ×10, ÷10. Did not ship the additional ×1e-3 / ÷1000 entries from the original sketch — `mV→V` (÷1000) and `pA→A` (÷1e12) cover those.
- **Visual badge on channel pills**: skipped. `TreeNavigator` doesn't render channel pills, and the equivalent surface (TracesDropdown rows) shows current units, which already reflect the override. The Scaling modal itself shows active rows tinted plus a `×N → units` indicator.
- **Post-import scaling nudge** (toast for empty units): not shipped. The wizard already collects units explicitly per column before commit, so the empty-units case mostly can't happen.
- **Text reader sweep modes**: only `single` is implemented. `column-per-sweep` and `block-separated` are deferred to backlog as described in the original "Risks" section.
- **Right-click "Re-import options…" entry**: not shipped; users currently re-import by closing and re-opening the file.
- **Step 1 grep gate**: enforced and passed; only safe `.size` reads and one docstring remain.

## Risks / open questions

- **Decimation interaction**: LTTB downsampling in `/api/traces/data` runs on raw samples; scaling must happen *before* LTTB so ranges match. Confirm by inspecting `api/traces/data` and `utils/lttb`.
- **Cached recordings**: backend keeps an in-memory map of opened recordings — overrides must mutate that cache, not just be applied per-request, otherwise analysis endpoints that re-fetch by `(file_path, group, series)` won't see them.
- **Unit-driven heuristics**: a few analyses key off `units in ("mV","V")` to choose voltage-clamp vs current-clamp paths (e.g. stimulus parsing). After an override changes units, those paths flip — desirable but needs a regression pass on existing fixtures in `sample_data/` and `heka_test_files/`.
- **Sweep boundaries in text import**: column-per-sweep vs block-separated is ambiguous; default to single-sweep and require the user to opt in to multi-sweep parsing.
- **Performance for very large text files**: chunked read + numpy `loadtxt` is fine to ~100 MB; beyond that consider `pyarrow.csv` or memory-mapped parsing. Out of scope for v1; flag in `FEATURES_BACKLOG.md`.
