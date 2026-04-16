# NeuroTrace Roadmap

Living document for upcoming work. Written at the end of session N — pick this up next time we sit down.

---

## Session N+1 — Native `.pgf` parser

**Goal:** replace myokit as the primary stimulus extractor with our own parser of HEKA's `.pgf` (stimulus tree). Unblocks I-V, ramps, and multi-channel stim overlays (LTP, optogenetics).

**Why myokit isn't enough:**
- Loses per-sweep increments → I-V Dep series 2 reports all zeros
- Rejects non-constant segments → ramps fail with `NotImplementedError`
- Picks one "supported" DA channel and **drops auxiliary channels entirely** → no stimulator/LED visibility for fEPSP/LTP/opto experiments

**Scope (modern PatchMaster only, ignore amplifier state):**
- Target one format generation: v2x90.x (current)
- Locked little-endian (`DAT2` magic); reject `DAT1` with a clear error
- From the `.amp` file we extract **only** holding potential / current — skip Rs, Cm, gains, filters, compensation
- Discover holding from the **Stimulation** record's `sHolding` field, not from `.amp` (more reliable per-protocol)

**Module layout** (`backend/readers/heka_native/`):
```
bundle.py     ~50 lines   parse DAT2 header, find .pul/.pgf/.dat byte offsets
records.py    ~150 lines  declarative struct definitions for the records we care about
pul.py        ~200 lines  walk the .pul tree → Group/Series/Sweep/Trace metadata
pgf.py        ~250 lines  walk the .pgf tree → Stimulation/Channel/Segment, apply increments
reader.py     ~150 lines  top-level glue → returns our Recording dataclass
```
Total ~800 lines, NumPy only, no third-party deps.

**Key reference docs to fetch before starting:**
- HEKA's official `StimFile_v9.txt` and `PulseFile_v9.txt` (field-by-field byte-offset specs)
- [swharden/HEKA-File-Format](https://github.com/swharden/HEKA-File-Format) — easier-to-read tables and hex dumps
- [campagnola/heka_reader](https://github.com/campagnola/heka_reader) — vendor-able reference implementation for the pulse tree (BSD)

**Multi-channel data model** (extends what we have):
```python
@dataclass
class StimulusChannelInfo:
    channel_index: int
    name: str                # from chDacUnit / chLinkedChannel
    unit: str                # "mV" / "pA" / "V" (raw DAC) / etc.
    role: str                # "command" | "ttl" | "led" | "auxiliary"
    holding: float           # per-channel holding from chHolding
    segments_per_sweep: list[list[StimulusSegment]]   # [sweep][seg]

@dataclass
class StimulusInfo:
    channels: list[StimulusChannelInfo]
    primary_channel_index: int
```

**Increment math (the part myokit doesn't do):**
```python
def segment_value_at_sweep(seg, sweep_idx, holding):
    if seg.vmode == StimToDac:
        base = seg.voltage
    elif seg.vmode == StimRelToDac:
        base = holding + seg.voltage

    if seg.increment_mode == 'SegLin':
        return base + seg.delta_voltage * sweep_idx
    elif seg.increment_mode == 'SegLog':
        return base * (seg.delta_voltage_factor ** sweep_idx)
    # SegSqrt, SegSquare, SegAlternate also exist
```

**Validation strategy:** for each format quirk, cross-check against a real file open in PatchMaster. Take a screenshot of the stimulus dialog for one sweep, parse the same series, verify our reconstructed waveform matches sample-for-sample.

**TraceViewer changes that fall out:**
- Show/hide checkbox becomes a small dropdown or row of checkboxes — one per stimulus channel
- Multiple right-side Y axes (one per visible stim channel), each in its own color
- Default-on: channels with `role == "command"`. Default-off: TTL / LED unless they're the only thing
- A "protocol summary" string on each series in the TreeNavigator (e.g. "VC, hold −70 mV, 50 ms pulse to −5 mV" / "LED 5 ms × 10 Hz")

**Estimated effort:** 1 focused session, possibly 2 if the spec has surprises.

---

## Session N+1.5 — Panel UX: collapse, focus mode, detached Results

**Goal:** more screen real estate when working on a single trace, plus the ability to put the Results window on a second monitor while keeping the trace visible. Also: rethink what the bottom panel actually shows so it isn't four static tabs.

This is small enough to slot in before continuous data (and would actually make the continuous-data work easier to demo).

### Part A — Collapsible panels + focus mode (~half session)

**Collapse buttons:**
- Each side panel and the bottom panel get a chevron button in their corner
- Click → panel collapses to a 28 px strip with a vertical (sidebars) or horizontal (bottom) label
- Click the strip → expands again
- Remember the *expanded* width/height separately so re-expanding restores user's preferred size, not the default
- Persist collapsed/expanded state to `localStorage` (or to the existing `preferences.json` file via the Electron IPC we already have)

**Keyboard shortcuts:**
- `F1` → toggle left sidebar (TreeNavigator)
- `F2` → toggle right sidebar (Cursor + Analysis)
- `F3` → toggle bottom panel
- `F` → **focus mode**: hide ALL panels at once, leaving only the Toolbar + TraceViewer + StatusBar. Press `F` again to restore the previous layout. This is the single most useful shortcut for "I just want to scroll through this 30-min recording."

**Implementation notes:**
- Add `panelLayout` slice to `appStore` (or to a new `layoutStore` that lives alongside `themeStore` and uses the same persistence pattern):
  ```ts
  panelLayout: {
    leftCollapsed: boolean
    rightCollapsed: boolean
    bottomCollapsed: boolean
    leftWidth: number      // remembered expanded width
    rightWidth: number
    bottomHeight: number
    focusMode: boolean     // when true, ignores the individual collapsed flags
  }
  ```
- The existing `ResizeHandle` components stay; they just get hidden when their adjacent panel is collapsed
- `App.tsx` reads the layout state and conditionally renders each panel as collapsed-strip vs full
- Focus mode is a derived UI state — when on, render every panel as collapsed regardless of individual flags

### Part B — Detachable Results window (~half session)

This is the one panel where popping it out into a separate window is genuinely useful: you can keep a results table visible on a second monitor while you work on the trace.

**Approach:**
- Use Electron's `BrowserWindow` directly from the main process, opened via a new IPC handler `open-results-window`
- The new window loads the same Vite dev server URL (or `dist/index.html` in production) but with a query parameter `?view=results` so the renderer knows to mount **only** the Results panel instead of the full app
- A `view=results` mount renders `<ResultsTable />` standalone with a minimal header (file name, the same theme/font controls in a small popover)
- **State sharing**: both windows are renderer processes in the same Electron app, but they're separate processes so they can't share Zustand state directly. Two options:
  - **Polling via the Python backend**: the Results window polls `/api/files/info` or a new `/api/results/list` endpoint on a slow interval (1 s). Simple, no IPC plumbing.
  - **`BroadcastChannel` over IPC**: the main process forwards messages between renderer windows. More complex but real-time. Probably overkill for results which only update when an analysis runs.
- Recommended: start with **polling** for simplicity, upgrade to broadcast IPC if it ever feels laggy
- The "open in window" button lives on the bottom-panel Results tab. Clicking it opens the new window AND removes the Results tab from the bottom panel until the window is closed (so we don't have it in two places)
- Closing the popped-out window restores the Results tab in the bottom panel
- Window position and size are remembered in `preferences.json`

**Why only Results gets this treatment (for now):**
- The TraceViewer is too tightly coupled to the active selection / cursors / store state to make sense as a standalone window
- The CursorPanel and AnalysisPanel are useless without the trace next to them
- The MacroEditor + PipelineBuilder are full-screen-friendly but rarely used while looking at the trace
- The ResultsTable is the only thing you genuinely want to **glance at while doing something else**

If we ever want to detach more panels later, the same machinery (renderer with `?view=` query param + new BrowserWindow) generalizes — but we don't need to build that now.

### Part C — Rethinking what the bottom panel shows (design discussion, then implementation)

Right now the bottom panel has **four static tabs**: Results / Macros / Pipeline / Rs-Rin Monitor. They're always there, in that order, regardless of what the user is doing. That's not great:

- The **Pipeline** tab is empty (placeholder). It shouldn't take a tab slot until it does something.
- The **Rs/Rin Monitor** is only relevant if you've actually run the resistance analysis. Otherwise the tab is dead.
- Future work will add **event navigation**, **burst navigation**, **spectral plots**, **fEPSP slope plots**, etc. — at four tabs the UI is already crowded; at ten tabs it'll be unusable.
- The user's current workflow is already telling: open file → Run Analysis → look at Results. The Results tab is "what I just did" 90% of the time.

**Proposal: context-aware bottom panel.**

Instead of a fixed tab strip, the bottom panel becomes a **stack of "result cards"** that appear when an analysis runs and persist until dismissed. The currently-selected card fills the panel. Think of it like a browser's tab strip but where tabs are created by user actions, not declared upfront:

```
┌─────────────────────────────────────────────────────────────────┐
│ [✕ Resistance · Test pulse] [✕ Events · Mini recording]   [+ ▼]│  ← tab strip
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│            (currently selected card's content)                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

- **Run resistance** → a "Resistance · {series name}" card is created and selected. Shows the Rs/Rin monitor chart that the existing `ResistanceMonitor` component renders.
- **Run event detection** → an "Events · {series name}" card is created. Shows the event list + histograms (this is what we'd build in N+3).
- **Run burst detection** → "Bursts · {series name}" card. (N+4)
- **Macros** and **Pipeline** are still available via the `[+ ▼]` button (an "open new view" menu). Clicking it lists: Results table, Macros editor, Pipeline builder, plus any analysis-result types we have. Selecting one creates a new card.
- Each card has an `✕` to close it. Closing the last card collapses the bottom panel entirely (or shows an empty hint).
- Cards are **persistent across sweep navigation** — running an analysis on a different sweep updates the same card's data (or the user can use "+" to create a new one if they want to compare).
- **Multiple cards of the same type are allowed** — useful for comparing two analyses side-by-side (one card for Test pulse Rs, another for a Cont.CC Rs).

Implementation:
- New `bottomPanel.cards: BottomCard[]` slice in the store, where each card has `{ id, kind, label, sourceSeries, data, createdAt }`
- `kind` enum drives which component renders the card content: `'resistance' | 'events' | 'bursts' | 'spectral' | 'fepsp' | 'results-table' | 'macros' | 'pipeline'`
- An action `addCard(kind, label, data)` that appends a card and selects it
- An action `closeCard(id)` that removes one
- The "Run Analysis" button in the AnalysisPanel triggers `addCard` after a successful run
- Old `bottomTab` state is replaced by `selectedCardId`

**Migration strategy:** keep the old tab system working as a fallback while building the card system, so we can A/B compare. Once the card UX feels right, delete the old tabs.

### Part D — Open questions for design discussion

Before building Part C, we should answer:

1. **Where does the generic "Results table" live?** Is it always present (one master table that accumulates everything), or is it just another card type that you open from `[+ ▼]`? Currently it's a sticky tab. The macro system currently writes into a global results array — that wants a single place to land.

2. **What about the resistance analysis result that currently displays in the AnalysisPanel sidebar?** Does it stay there (small inline summary) AND also create a bottom-panel card (full chart)? Probably yes — the sidebar shows "the latest run," the bottom card holds it for cross-comparison.

3. **Should "Macros" and "Pipeline" be cards or stay as full-window views?** They're editing surfaces, not result views. Maybe they live somewhere else entirely (e.g., a dedicated mode toggle, like switching from "Analyze" to "Macros" in the toolbar). Worth discussing.

4. **What's the maximum useful number of cards?** Probably 5-6 before the tab strip gets crowded. Beyond that we'd need overflow handling (a `›` chevron to scroll the strip, or a dropdown).

5. **Persistence?** Should bottom-panel cards survive a file reload, or do they reset? Probably reset for cleanliness.

### Estimated effort

- Part A (collapse + focus): half session
- Part B (detached Results): half session (assuming polling is acceptable)
- Part C (card-based bottom panel): 1 session, after a short design discussion (Part D)

Total: 2 sessions, can be split across the timeline however we want. Part A is the highest value-per-hour and could even land before the `.pgf` parser if we want a quick win.

---

## Session N+2 — Continuous data support, Phase 1

**Goal:** make NeuroTrace usable for spontaneous / mini / epileptiform / LFP recordings without choking on long traces.

**Constraints (confirmed):**
- Sweep duration: up to 30–60 minutes
- Channel count: up to 2
- Sampling rate: up to 20 kHz
- Worst case: 60 min × 20 kHz × 2 ch × float64 = **115 MB per series**
- Mixed files (test pulse → continuous in same `.dat`) are common

**Architecture decision: keep everything in RAM, downsample on read.**
- 115 MB per series is well within Python heap headroom — no memory-mapping needed
- The Python backend already runs as a subprocess so memory is contained
- The bottleneck is **JSON serialization for browser transfer**, not disk I/O

**Backend:**
- `/api/traces/data` gains required `t_start` / `t_end` query params
- Backend slices `trace.data[t_start*sr : t_end*sr]`, runs LTTB to `max_points`, returns JSON
- For windows 2 s wide at 20 kHz = 40k samples → LTTB to 4k → cheap (<50 ms)
- Analysis endpoints stay unchanged (they read the full in-memory NumPy array)
- New helper: `is_continuous_series(series)` based on sweep count = 1 + duration > 10 s, OR (after the `.pgf` parser exists) read the mode flag directly from the protocol

**Frontend TraceViewer:**
- New state: `viewport: { tStart, tEnd }`
- On mount: viewport spans the full duration
- On wheel zoom / pan: update viewport, debounced refetch (150 ms), feed new data into uPlot
- The plot only ever holds ~4000 points → uPlot stays smooth
- Episodic mode unchanged (loads the full short sweep once, no viewport machinery)

**Minimap (new component):**
- Thin uPlot below the main plot
- Shows the entire recording at low resolution (~2000 points, fetched once)
- Draggable rectangle marks the current viewport
- Click to jump, drag to pan
- Only visible when the current series is continuous

**Mode-aware Toolbar:**
- "Sweep N/M" navigation hidden when in continuous mode
- Replaced with "viewport: 12.4 s – 14.7 s of 1800.0 s"
- Page Up/Down keyboard shortcuts → jump by viewport
- Home/End → jump to start/end of recording
- "Continuous" mode is **per-series**, not per-file (mixed files just switch UI when you click a different series)

**TreeNavigator:**
- Small icon next to each series indicating mode (episodic vs continuous)

**Out of scope for this session:** event navigation UI, burst navigation UI, continuous Rs/Rin monitor — those come later.

**Estimated effort:** 1 session.

---

## Session N+3 — Mini event analysis workflow

**Prereq:** continuous mode (Session N+2) is shipped.

**Goal:** turn the existing event detection algorithm into an actual workflow for mEPSC / mIPSC analysis.

**Backend** (mostly already exists in `backend/analysis/events.py`):
- Run threshold / template matching / derivative detection on the full in-memory trace
- Return a list of events with `index`, `time_s`, `amplitude`, `rise_time`, `decay_tau`
- Per-event windows so the frontend can fetch the local trace around each event

**Frontend:**
- Detected events shown as markers on the main trace + on the minimap
- Event list panel with sortable columns (time, amplitude, rise, decay)
- Click event in list → viewport jumps to event, centered, with a few hundred ms of context
- "Next / previous event" keyboard navigation
- Accept/reject per-event with a checkbox column → exports excludes rejected
- Histograms tab: amplitude distribution, IEI distribution (log-binned), decay tau distribution
- Mean-event waveform: average of all accepted events, displayed in a small panel
- Frequency over time: bin events into 1-min windows, plot as a sparkline

**Estimated effort:** 1–2 sessions.

---

## Session N+4 — Burst detection workflow

**Burst detection workflow:**
- Algorithms already exist in `backend/analysis/bursts.py` (threshold / ISI / oscillation methods)
- Same "detect-then-navigate" UI pattern as events
- Bursts displayed as shaded regions on the trace + minimap
- Per-burst stats: duration, intra-burst frequency, peak amplitude, area, n_spikes
- Per-burst review (accept/reject) for noisy / artifact bursts
- For epileptiform recordings: histograms of inter-burst interval, burst duration

**Note on Rs/Rin monitoring for continuous data:** *not needed*. The user's
workflow runs separate test-pulse series in between continuous segments
within the same file. The existing per-sweep `ResistanceMonitor` already
handles that — the user just navigates to the test-pulse series and runs
"across all sweeps" as usual. No dedicated continuous-trace Rs/Rin code
required.

**Estimated effort:** 1 session.

---

## Test files needed (drop these somewhere outside `sample_data/`)

Put them in `~/Documents/heka_test_files/` or similar — anywhere we can read them. The `.gitignore` already excludes `*.dat` so they won't accidentally land in the repo.

**For the `.pgf` parser session (N+1):**
1. **Test pulse** — already have it (`r4170728aM.dat` series 0). Confirms the basic parser works.
2. **I-V (Dep)** with stepped voltage — modern PatchMaster version, the kind that myokit currently fails on.
3. **A ramp protocol** — confirms ramp segment handling.
4. **A fEPSP / LTP recording with a stimulator channel** — confirms multi-channel parsing. This is the most important new case.
5. **An optogenetics recording with an LED channel** — same as above but with a different unit.
6. **A paired-pulse on the stimulator** (if available) — confirms multiple non-holding segments per sweep on an auxiliary channel.

**For the continuous-data sessions (N+2 and onward):**
7. **A mini recording** — a few minutes of spontaneous mEPSC or mIPSC. Used to design and validate the viewport / event navigation UI.
8. **An epileptiform burst recording** — a long-ish gap-free recording. Used to validate burst navigation.
9. **A mixed file** — one that starts with a test pulse series and then has a long continuous series. Used to validate the per-series mode switch.

For each file, ideally also note (in a comment or sidecar text file) what the protocol "should" look like according to PatchMaster's display — this is our ground truth for cross-checking.

---

## Notes carried over from session N

**Math convention for resistance:** Rs and Rin use `vStepAbsolute` (the raw protocol level, e.g. −5 mV), **not** the delta from holding (`vStep`, e.g. +65 mV). This is the user's decided convention — leave it.

**Cm fitting** still occasionally fails the sanity-check range and returns None. Not urgent, but worth a session of its own at some point — the exponential fit is too sensitive to the cursor position.

**Fit cursors** are only consumed by `kinetics` and `fitting` analyses, NOT by resistance. The user can hide them via the cursor show/hide toggle.

**Stimulus extraction status on the existing sample file:**
- ✅ Test pulse — works via `da_protocol`
- ✅ Reversal — works via `reconstruction()` fallback
- ✅ I-V (Dep) series 8 — works via `reconstruction()` fallback
- ❌ I-V (Dep) series 2 — myokit returns all zeros from both paths
- ❌ Ramps — myokit raises `NotImplementedError`
- ❌ CC Stim, Cont.CC — no supported DA channel

The native `.pgf` parser fixes all of these.

**Known TraceViewer behavior to preserve when refactoring for continuous mode:**
- Cursor draw is on a separate transparent canvas overlay (not part of uPlot)
- Cursor positions are stored in absolute seconds — no conversion needed across modes
- The container div is *always* mounted (even in empty state) so the ResizeObserver attaches at first render — don't break this when adding the minimap
- Wheel zoom near axes is debounced through React's synthetic event; native `wheel` listeners would be slightly faster but the current approach is fine
