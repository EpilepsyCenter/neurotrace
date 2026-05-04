# NeuroTrace User Manual

NeuroTrace is a desktop application for analysing electrophysiology
recordings. It reads HEKA `.dat`, Axon `.abf`, and plain-text traces,
and provides interactive tools for measuring passive properties,
synaptic responses, action potentials, spontaneous events, and
field-potential time courses. The interface is built around a
central trace viewer with dedicated windows for each analysis type;
results are stored alongside the recording so a session can be
reopened and resumed exactly where you left off.

This manual is organised into two parts. **Part I** covers the
general application — the workspace, navigation, viewer, and
preferences — and applies to every recording you open. **Part II**
documents each analysis module in turn, with the underlying methods
explained next to the parameters that select them.

---

# Part I — General

## 1. Getting Started

### Launching NeuroTrace

NeuroTrace runs as a single desktop application. When it starts, it
spawns a local Python backend in the background; all numerical work
(filtering, fitting, peak detection, file reading) happens there,
while the window you see is responsible only for display and
interaction. The two communicate over a local port chosen
automatically at start-up, so nothing leaves your machine and no
configuration is required.

If the backend fails to start — most often because a required Python
dependency is missing in a development build — a red banner appears
at the top of the window reading **"Backend failed to start"**. In a
packaged release this should never occur; in development, check that
the backend's dependencies are installed and try restarting the app.

The main window remembers its size, position, and maximised state
between sessions, so you can lay it out once and find it the same
way next time.

### Opening a recording

Click the **Open File** button at the left of the toolbar to pick a
recording. NeuroTrace does not install a separate menu bar of its
own — every command lives on the toolbar — so this is the single
entry point for loading data. NeuroTrace's primary, fully-tested
formats are:

| Format | Extension | Notes |
|---|---|---|
| HEKA Patchmaster | `.dat` | Multi-group, multi-series; stimulus reconstructed from the accompanying `.pgf` if present |
| Axon Binary | `.abf` | ABF1 and ABF2; gap-free and episodic |
| Plain text | `.csv`, `.tsv`, `.txt`, `.atf` | Routed through the **Text Import Wizard** for column mapping and unit assignment |

In addition, NeuroTrace can open a wider range of formats through
the [Neo](https://neuralensemble.org/neo/) library — including
Axograph (`.axgd`, `.axgx`), WinWCP (`.wcp`), Spike2 (`.smr`),
NWB (`.nwb`), NIX (`.nix`), NeoHDF5 (`.h5`), Plexon (`.plx`),
Blackrock (`.nev`, `.ns5`), Intan (`.rhd`, `.rhs`), Micromed
(`.mcd`), and EDF/BDF (`.edf`, `.bdf`). These work in principle but
have not been exercised on a wide variety of real-world files; if
you open one and something looks wrong — units misreported, sweeps
collapsed together, channels missing — please report it. Treat them
as supported-but-experimental until your particular variant has
been verified.

Once a file opens, the **Tree Navigator** on the left fills with the
recording's structure (groups, series, sweeps), the first sweep
loads in the **Trace Viewer** in the centre, and the file name
appears in the toolbar.

![Main window overview](screenshots/main-window-overview.png)

To switch to a different recording, simply open another file —
NeuroTrace replaces the current one. There is no separate close
command; closing the application window quits the program.

### Recent files

The toolbar's **Open File** button has a small chevron (▾) next to
it that opens a list of recently opened files, most recent first.
Clicking an entry reopens that file directly. The list holds up to
ten entries and survives between sessions; **Clear recent** at the
bottom of the list empties it.

![Recent files dropdown](screenshots/toolbar-open-file-dropdown.png)

If a recently-opened file has been moved or deleted, NeuroTrace will
report the failure and remove the entry from the list.

### Per-recording state

Whenever you run an analysis, mark sweeps as excluded, build an
averaged sweep, or change a per-channel filter, NeuroTrace writes
the result to a small JSON sidecar named `<recording>.neurotrace`
placed next to the original file. The sidecar contains analysis
results, UI state, and any custom labels — but never a copy of the
raw signal. Reopening the recording later restores everything from
this file.

You can safely move a recording and its sidecar together. If the
sidecar is missing, the recording opens cleanly and a fresh one is
written the first time you change anything worth saving.

---

## 2. The Toolbar

The toolbar runs across the top of the window and groups the
controls you will reach for most often: opening files, navigating
sweeps, choosing what to display, and launching analysis windows.
Buttons that require a recording are disabled until one is open;
those that operate across files (Tags, Batch, Cohort, Export Traces)
remain available at all times.

From left to right, the toolbar is laid out in five regions:
**file**, **sweep**, **display**, **analyses**, and **status /
settings**.

![Toolbar overview](screenshots/toolbar-full-left-to-right.png)

### File

**Open File** opens the standard file picker. The chevron next to
it opens the **Recent files** list described above.

### Sweep

For episodic recordings, the **Sweep** group shows the current
sweep number alongside the total — for example *3 / 47* — flanked
by **←** and **→** buttons that step backwards and forwards. The
counter itself is read-only; the arrow buttons and the matching
keyboard arrows are the only way to step. See the keyboard
reference in chapter 8 for the full set.

For continuous recordings (a single sweep longer than about a
minute), the counter still reads *1 / 1* but navigation happens
through the viewport bar rather than the sweep arrows; see the
**Trace Viewer** chapter.

### Display

These controls govern what is drawn in the trace viewer.

- **Scaling** opens the per-channel scaling modal, where you can
  override a channel's units (for example, mark a channel as `pA`
  when the file claims `V`) or apply a numeric multiplier. Useful
  when a recording was saved with the wrong amplifier gain or with
  a generic unit. Right-clicking a channel in the **Traces**
  dropdown opens the same modal pre-focused on that channel.

- **Traces** lists every recorded channel and the stimulus trace
  with a checkbox next to each. Use it to hide channels you don't
  want to see; the choice is saved per series.

- **Overlay** turns on a translucent overlay of every sweep in the
  current series, drawn on top of the active sweep. This makes it
  easy to see how a response evolves across an experiment without
  flipping through sweeps one at a time. The lowercase keyboard
  shortcut is `o`.

- **Average ▾** opens a small popover for building an *averaged
  sweep* — a virtual sweep computed as the mean of a chosen subset.
  Pick the source (**All sweeps**, **Selected**, or a **Range**
  with from/to inputs), give it a label, and click **Create**. The
  resulting average appears in the Tree Navigator under the same
  series as a regular sweep, can be displayed and analysed like
  any other, and is persisted in the sidecar. The same popover
  lists existing averages and lets you delete them. The lowercase
  shortcut `a` opens it.

  ![Average popover](screenshots/toolbar-average-popover.png)

- **Zoom** changes what click-and-drag does in the trace viewer.
  With Zoom **off** (the default), dragging **pans** the view; with
  Zoom **on**, dragging sketches a rectangle and the viewer zooms
  into it on release. The mouse wheel always zooms regardless of
  this toggle — see chapter 4 for the full set of wheel and
  modifier-key combinations. The lowercase shortcut `z` switches
  modes.

### Analyses, tagging and cross-recording tools

The **Tags…** button opens the **Metadata** window, where you can
attach tags and notes to a recording, group, or series. Tags drive
the **Batch** and **Cohort** workflows that follow, so it sits
deliberately just before the Analyses dropdown — read the toolbar
left-to-right and you have *tag → analyse → batch → aggregate*.

**Analyses ▾** opens the menu of per-recording analysis windows.
Each entry opens a dedicated window devoted to one kind of analysis;
they are documented one chapter at a time in Part II of this manual.

| Menu entry | Chapter |
|---|---|
| Cursor Measurements | 9 |
| Rs / Rin / Cm | 10 |
| I-V Curve | 11 |
| Action Potentials | 12 |
| Event Detection | 13 |
| Burst Detection | 14 |
| Field Potential | 15 |
| Spectral Analysis | — (experimental) |

The **Spectral Analysis** entry is present in the menu but is still
under construction; it is not documented in this manual and the
window it opens should be considered a preview.

Several windows can be open at once, and they stay in sync with the
main window: changing the selected sweep or moving a cursor in one
place updates the others.

The next three buttons operate across recordings rather than within
one, and so are available even when no file is open:

- **Batch…** replays a tagged template's analyses across every
  recording in a folder, so a parameter set you have tuned on one
  cell can be applied to a whole experiment in one go.

- **Cohort…** aggregates per-cell metrics across a folder of
  already-analysed recordings, producing pooled tables and summary
  plots.

- **Export Traces…** builds publication-ready figures from sweeps
  drawn from one or more recordings — useful for assembling a
  multi-cell figure without leaving the app.

### Status and settings

To the right of the action buttons, the toolbar shows the current
file's name (or **No file loaded**), a small dot indicating whether
metadata has been entered for the recording, and any tag chips
attached to it. While the backend is doing work — running an
analysis, opening a large file — a **Loading…** indicator appears
in this region.

At the far right, the gear (**⚙**) button opens the **Settings**
popover. The settings are global rather than per-recording.

- **Palette** chooses between the *Classic* (neutral greys with cool
  accents) and *Telegraph* (warm amber-on-black, vellum-on-cream)
  colour schemes. Each palette ships with a dark and a light
  variant.

- **Theme** switches the active variant of the current palette
  between **Light** (☀) and **Dark** (☾).

- **UI Font** sets the application's interface font, with **IBM
  Plex Sans** as the default and Inter, SF Pro, Helvetica Neue, and
  the system default as alternatives.

- **Code Font** sets the monospace font used in tables and numeric
  read-outs. **JetBrains Mono** is the default; Fira Code, SF Mono,
  and Consolas are also available.

- **Font Size** offers a small range (11–15 px) to suit your display
  and viewing distance. The change applies live.

- **Trace colors** lists six colour slots — five for recorded
  channels and one for the stimulus trace — each with a colour
  picker and a small **×** to clear an override and fall back to the
  palette default. **Reset all** restores every slot at once. Trace
  colours are part of the global theme, not a per-recording setting,
  so the channel you usually keep blue stays blue across files.

A short preview ("UI preview: The quick brown fox" / "Code: fn(x) =>
x * 2") sits at the bottom of the popover so you can compare font
choices at a glance.

---

## 3. The Tree Navigator

Down the left side of the window is the **Tree Navigator** — the
table of contents of the current recording. It mirrors the way
Patchmaster, pCLAMP and most other acquisition systems organise
their data, with three nested levels: a recording is divided into
**groups** (typically one per cell or experiment), each group
contains one or more **series** (a contiguous block of sweeps run
under a single protocol), and each series contains a number of
**sweeps**. Selecting an entry in the tree controls what the trace
viewer shows; selecting more than one sweep also drives the
**Average** popover and the per-series workflows in the analysis
windows.

Press `F1` to hide and show the tree at any time.

### Groups

Each group is shown as a labelled row with an expand/collapse
chevron and a small badge giving the number of series it contains.
Groups can be collapsed away when they are not the focus — useful
for long recording sessions with several cells in the same file.

### Series

Series are the workhorse level: nearly every analysis runs on a
single series at a time. Each row carries:

- **A type badge** — *VC* (voltage clamp), *CC* (current clamp), or
  *FP* (field potential) — colour-coded so you can tell at a glance
  what kind of recording you are looking at. NeuroTrace guesses the
  type from the series label, the protocol, and the holding
  potential; if it is wrong, you can override the channel units in
  the **Scaling** dialog.

- **A sweep-count badge** showing how many sweeps the series
  contains.

- **Analysis-presence pills** indicating which analyses have already
  been run and saved. The letters are deliberately short:

  | Pill | Analysis |
  |---|---|
  | C | Cursor Measurements |
  | R | Resistance (Rs / Rin / Cm) |
  | IV | I-V Curve |
  | AP | Action Potentials |
  | E | Event Detection |
  | B | Burst Detection |
  | FP | Field Potential |

  Hovering a pill names the full analysis. The pills update
  automatically as analyses are run and cleared.

- **A tag chip** showing the first metadata tag attached to the
  series, when present (see chapter 16). Hovering reveals the full
  tag list.

![Series row badges and pills](screenshots/tree-navigator-series-row.png)

### Sweeps

Inside an expanded series, every sweep is listed in order. Click a
sweep to load it into the trace viewer; the **Sweep** counter in
the toolbar updates accordingly. Sweeps that have been excluded
from analysis are drawn in a dimmer style so they are easy to spot.

Multi-sweep selection follows standard conventions:

- **Click** a sweep to select it.
- **Shift-click** to extend the selection to a contiguous range.
- **⌘ / Ctrl-click** to add or remove individual sweeps from the
  selection.

The current selection is what the **Average** popover, the **Batch**
analysis, and several analysis windows use when their *Selected*
mode is chosen.

![Sweep selection and exclusion](screenshots/tree-navigator-sweep-multi-select.png)

### Averaged sweeps

When you create an averaged sweep through the toolbar's **Average**
popover, it appears in the tree under the same series, named
`Avg: <your label>`. These virtual sweeps are first-class citizens
of the tree: click them to display, run analyses on them, or
include them in figures. They are stored in the sidecar with the
underlying samples, so they survive a restart and can still be
reviewed even if the original sweeps are later excluded.

---

## 4. The Trace Viewer

The trace viewer fills the centre of the window and is where
virtually all interaction with the signal happens. Its job is to
draw the current sweep — or the current viewport, if the recording
is continuous — clearly, quickly, and at any zoom level, while
giving you the controls you need to measure, compare, and annotate
what you see.

### How the trace is drawn

A typical electrophysiology recording contains far more samples
than the screen has pixels, so showing every sample would be
expensive and pointless. NeuroTrace decimates the visible region
down to roughly four thousand points using **LTTB** — the
**Largest-Triangle-Three-Buckets** algorithm — before handing the
result to the plot. LTTB divides the time axis into buckets and,
within each bucket, picks the sample whose triangle with the
previously-kept point and the next bucket's centroid has the
largest area. The effect is that visual peaks, troughs, and
inflection points are preserved even at extreme zoom-out, while
flat regions collapse cleanly. Numerical analyses are always run on
the full-resolution data, never on the decimated copy you see.

The plot has a primary Y axis on the left for the recorded signal
and a secondary Y axis on the right for the stimulus or any
additional trace you have made visible. Both axes carry units —
*mV*, *pA*, or whatever the file declares — and rescale
automatically when you switch sweeps or channels.

### Mouse interactions

The mouse wheel zooms one axis at a time, with modifier keys
selecting which:

| Wheel | Action |
|---|---|
| (no modifier) | Zoom the **X axis** in or out, anchored at the cursor position |
| **Option / Alt** + wheel | Zoom the **Y axis** nearest the cursor — useful for multi-channel files where each channel can be zoomed independently by hovering it before scrolling |
| **Shift** + wheel | Zoom the **stimulus axis**, when the stimulus trace is visible |

Anchoring at the cursor means the time (or value) under the pointer
stays put while the rest of the axis expands or contracts around
it, so you can drill into a region just by moving the pointer there
and scrolling.

Drag-and-release behaviour is governed by the toolbar's **Zoom**
toggle (or the `Z` shortcut):

- With **Zoom off** (the default), click-and-drag inside the plot
  **pans** the view — the natural way to slide a long sweep across
  the window.
- With **Zoom on**, click-and-drag sketches a rectangle and the
  viewer zooms into it on release. Useful for picking out a precise
  time-and-amplitude window in a single gesture.

**Right-clicking** the trace opens a small context menu with the
following entries:

- **Copy as PNG** — copies the current view to the clipboard as a
  raster image.
- **Save as PNG…** — writes a PNG to disk via a file dialog.
- **Copy as SVG** — copies the view as a scalable vector graphic.
- **Save as SVG…** — writes an SVG to disk.

The PNG entries export at the displayed resolution; the SVG entries
preserve the trace as vector paths, suitable for scaling without
loss in figure-editing software. For more elaborate
publication-ready figures with multiple sweeps and annotations,
use the **Export Traces** window described in chapter 17 instead.

![Right-click context menu](screenshots/trace-viewer-right-click-menu.png)

### The viewport bar and slider

For episodic recordings — one sweep per protocol step — there is
nothing fancy to navigate: the toolbar's `←` / `→` buttons step
between sweeps. For **continuous** recordings, where a single sweep
can run for many minutes, NeuroTrace switches into a viewport-based
mode:

- The plot shows a time-window of the full sweep at a time.
- A **viewport bar** above the plot exposes a **Reset zoom** button
  and the active zoom-and-pan controls.
- A **viewport scroll bar** at the bottom of the viewer behaves
  like an ordinary application scroll bar: a thin track spanning
  the full duration of the recording, with a coloured handle
  showing where in the recording the visible window currently sits
  and how wide it is. Click anywhere on the track to jump the
  viewport there, or click-and-drag to scroll continuously. The
  handle's width is determined by the X-axis zoom level — to make
  the visible window wider or narrower, zoom out or in with the
  mouse wheel.

The arrow keys and `Home` / `End` keep working in either mode; in
continuous mode they scroll by one viewport width, with `Shift`
modifying the step size.

### Cursors

Cursors are the foundation of every measurement in NeuroTrace.
Three independent **pairs** are available, drawn as translucent
shaded bands across the plot:

| Pair | Colour | Typical use |
|---|---|---|
| Baseline | green | The pre-stimulus window from which the resting level is measured |
| Peak | yellow | The window containing the response of interest |
| Fit | purple | The window over which an exponential is fitted (decay τ, capacitive transient) |

The exact shades depend on the active palette and theme variant, but
the same green / yellow / purple identity is preserved across both
**Classic** and **Telegraph** so that "baseline" always reads as the
green band wherever you see it. Individual analysis windows can
introduce additional cursor pairs of their own — for example, the
Field Potential window distinguishes a *volley* window from the
*fEPSP* window — and those are colour-coded separately within each
chapter.

![Cursors on the trace](screenshots/trace-viewer-cursors.png)

Each pair is configured in the **Cursor Panel** on the right (see
chapter 5) and can be shown or hidden independently. To move a
cursor on the plot, drag one of its edges; to translate the whole
band without changing its width, drag the interior. The cursor
edge snaps to the pointer within an eight-pixel tolerance so a
quick drop is enough.

By default, the cursors are **off** in the main viewer — most
work happens inside the analysis windows, which display their own
cursors against their own mini-viewers. Switch them on from the
Cursor Panel when you want to make a quick measurement against the
main display.

### Analysis markers

When an analysis has been run, its results are drawn back onto the
main trace as a way of inspecting the detection in context:

- **Burst markers** appear as shaded regions over the duration of
  each detected burst.
- **Action-potential markers** are dots at each detected spike. A
  bare-detection run places a single red dot on the peak. When
  kinetics have been measured (in the AP window's Kinetics tab),
  each spike instead carries a small cluster of coloured dots at
  the points the AP analysis identified — red at the peak, grey at
  the threshold, two yellow dots at the half-amplitude crossings
  joined by a dashed line, orange at the fAHP, and a darker orange
  at the mAHP. Spikes you have added or kept by hand are drawn with
  an extra outer ring around the peak dot, so manual edits are
  visually distinct from auto-detections.
- **Event markers** are dots placed at each detected event, colour-
  coded by what they represent (foot, peak, decay).

Markers respect the **Zero-offset** state of the trace, so they
follow the signal when you toggle the offset on or off rather than
floating off in the original sample frame.

### The stimulus trace

When the file contains a reconstructable stimulus — for HEKA
recordings, this means a `.pgf` protocol file is present alongside
the `.dat` — NeuroTrace draws the stimulus on the secondary Y axis
in the colour assigned to the stimulus slot in **Settings**. The
stimulus is a regular trace as far as the viewer is concerned, with
its own checkbox in the **Traces** dropdown.

If your file does not carry a usable protocol, the secondary axis
is simply empty; analyses that need the stimulus (for example, the
I-V Curve) provide a manual fallback for entering the protocol
parameters by hand.

### Zero offset

The **Zero offset** toggle (per channel, accessible from each
analysis window's mini-viewer header strip; see also the per-trace
state in the sidecar) subtracts the first sample of the displayed
window from every other sample, so the trace starts at zero on the
Y axis. This is purely a display aid: the underlying data is not
modified, and analyses always work in the original units. It is
most useful for visually comparing the shapes of two traces with
different DC offsets, or for displaying a small response without
the surrounding baseline taking up most of the axis range.

### Filtering

A live, zero-phase filter can be applied to any channel. Filter
controls live in the **Cursor Panel** (next chapter) and consist of
a master enable checkbox, a type selector — **Lowpass**,
**Highpass**, or **Bandpass** — one or two cutoff frequencies in
hertz, and an order from 1 to 4. A filtered trace is drawn in
place of the raw one in the main viewer and in any analysis window
that inherits the filter on opening.

The filter itself is a Butterworth IIR run **forwards and
backwards** through SciPy's `sosfiltfilt`, which gives a zero-phase
response — peaks and troughs stay where they were, just smoothed.
Edge handling uses constant (edge-value) padding rather than the
default odd-reflection, which avoids ringing at the very start of
traces that begin away from zero. For very short signals (fewer
samples than `6 × n_sections`), NeuroTrace falls back to a one-way
`sosfilt` so the filter still runs without raising an error.

Filters are stored per channel in the sidecar, so each channel can
carry its own setting and that setting is restored next time you
open the recording.

### Hover read-out

A small **x,y** button at the right-hand end of the viewer's
control strip toggles a coordinate read-out that follows the
pointer as you hover, showing the time and the value at the nearest
sample. It is on by default and is helpful for quick measurements
that do not justify placing a full pair of cursors — checking the
amplitude of a single event, for example, or noting the time of an
obvious feature.

---

## 5. The Cursor Panel

The right-hand sidebar is the **Cursor Panel**. It carries the
positions of the three cursor pairs, a continuously-updated read-out
of what the cursors currently enclose, and the per-channel filter
controls described in the previous chapter. Analyses themselves are
launched from the toolbar's **Analyses** menu (chapter 2), not from
this panel — the panel exists to set up the inputs, not to dispatch
the work. Press `F2` to hide and show it.

### Cursor configuration

Three rows — **Baseline**, **Peak**, and **Fit** — let you set the
exact start and end times of each cursor pair in seconds, absolute
to the sweep. Each row has a checkbox that shows or hides that pair
in the main viewer. Editing a value in the panel moves the cursor
on the plot in the same frame; dragging a cursor on the plot
updates the inputs in the panel. The two views are always in sync.

### Live read-out

Underneath the cursor configuration is a compact read-out
recomputed in real time as you move the cursors or step between
sweeps. It carries:

- **Baseline** — the mean of the signal over the baseline window,
  in the channel's units.
- **Peak** — the sample inside the peak window with the largest
  absolute deviation from the baseline. The sign is preserved, so
  inward currents read negative and outward currents read positive.
- **Amplitude** — the peak minus the baseline.
- **Peak time** — the time of the peak sample relative to the start
  of the sweep, in milliseconds.

The panel deliberately keeps this set small. Standard deviation,
noise estimates, exponential-fit time constants, rise times,
half-widths, and similar derived metrics are all available, but
they live in the **Cursor Measurements** window (chapter 9), where
they can be computed across many sweeps and exported as a table.
Treat the panel read-out as a quick sanity check; reach for the
Cursor Measurements window when you want a record of what you
measured.

![Cursor panel read-out](screenshots/cursor-panel-readout.png)

### Auto-placed cursors

Several analyses can suggest cursor positions — for example, the
Field Potential window can place the baseline and response windows
relative to the stimulus onset detected from the protocol file.
When this happens, the values appear in the cursor inputs and the
shaded bands move on the plot. You are always free to nudge them
afterwards; nothing in NeuroTrace will overwrite a manual edit
without asking.

### Filter

The lower half of the panel carries the filter controls described
in chapter 4: enable, type, cutoff(s), order. The settings are
remembered per channel so that, for instance, you can leave a
50-Hz notch on a noisy field-potential channel while the patched
cell on the same recording stays unfiltered.

---

## 6. Settings and Theme

The toolbar chapter introduced the **Settings** popover at a glance.
This chapter covers what each setting does in a little more detail
and explains how NeuroTrace's two-axis approach to appearance —
**theme** and **palette** — is meant to be used. All settings here
are global: they apply to every window and every recording.

### Palettes and themes

A **palette** is a coordinated set of colours; a **theme** is the
light or dark variant of that palette. The two are independent,
which means there are four combinations available rather than the
usual two. NeuroTrace ships with two palettes:

- **Classic** — neutral greys with cool blue accents. The default,
  designed to feel at home alongside other scientific software and
  to put no demands on the eye for a long analysis session.

- **Telegraph** — warm and high-contrast. The dark variant is
  amber-on-near-black, reminiscent of an old terminal; the light
  variant is dark ink on a vellum background. Both are intended for
  workflows where contrast matters more than neutrality.

The **Theme** toggle (☀ Light / ☾ Dark) flips the active palette
between its two variants without changing the palette itself.

### Fonts

The **UI Font** dropdown sets the typeface used for menus, buttons,
labels, and panels. **IBM Plex Sans** is the default. Alternatives
are **Theme default** (defers to whatever the active palette
specifies, typically the same as the IBM Plex default), **Inter**,
**SF Pro**, **Helvetica Neue**, and **System Default** (delegates
to the operating system — San Francisco on macOS, Segoe UI on
Windows, the system sans-serif on Linux).

The **Code Font** dropdown sets the monospace face used in tables,
numeric read-outs, and copyable values. **JetBrains Mono** is the
default, with **Theme default**, **Fira Code**, **SF Mono**, and
**Consolas** as alternatives. A monospace face matters here because
the alignment of decimal points across rows is what makes a results
table scannable.

![Settings popover — palette, theme and fonts](screenshots/settings-popover-palettes-fonts.png)

A small **UI preview** and **Code** preview line at the bottom of
the popover gives you an immediate sense of how a font choice will
look before committing.

### Font size

The **Font size** stepper covers a small range — 11 to 15 pixels —
suitable for most displays. The change applies live, including to
existing analysis windows; pick the smallest size that you can read
comfortably to leave more room for plots.

### Trace colours

NeuroTrace gives every channel its own colour slot so that, once
you have settled on (say) blue for the patched cell and red for the
field electrode, that mapping persists across files. Six slots are
provided: five for recorded channels (1 through 5) and one for the
stimulus trace.

Each slot has a colour picker and a small **×** button that clears
your override and falls back to the palette's default for that slot.
**Reset all** clears every slot at once. The slot you have
overridden is shown filled in, and the default is shown with a
muted indicator, so you can tell which colours are yours and which
came from the palette.

Trace colours are global rather than per-recording, which suits the
common case of running similar protocols on similar configurations
across many files. If you need different colours for a particular
figure, build it in the **Export Traces** window, where colours can
be set per sweep.

![Settings popover — trace colours](screenshots/settings-popover-trace-colors.png)

---

## 7. Where Your Work is Stored

NeuroTrace persists state in two places. Understanding which is
which makes the difference between a setting that follows the
recording around and one that follows you, the user, around.

### Application preferences

Global, user-level state is written to a small **preferences.json**
file inside the platform's standard application-data directory
(`~/Library/Application Support/NeuroTrace` on macOS,
`%APPDATA%\NeuroTrace` on Windows, `~/.config/NeuroTrace` on
Linux). This file holds:

- **Window bounds** — the size, position, and maximised state of
  the main window.
- **Recent files** — the list shown in the Open File dropdown.
- **Layout** — sidebar widths, collapse state, focus mode.
- **Theme** — palette, theme variant, fonts, font size, and trace
  colours.

It also holds a few per-file caches that mirror what is in the
sidecar (excluded sweeps, averaged sweeps, saved analysis results,
form parameters, and the like), keyed by file path. These exist so
that NeuroTrace can restore your view of a recording before it has
finished loading the sidecar from disk; the sidecar is the
authoritative copy.

### The recording sidecar

Per-recording state is written to a JSON file named
`<recording>.neurotrace`, placed next to the recording itself. It
contains everything that is specific to that file:

- **Analysis results** — Cursor Measurements, Resistance, I-V
  Curve, fEPSP, Bursts, Action Potentials, Events. Each module
  stores its own block, keyed by *group:series* (and, where
  relevant, by sub-mode such as `ltp` for Field Potential).
- **UI state** — the set of excluded sweeps, the catalogue of
  averaged sweeps (with their underlying samples), the per-channel
  zero-offset states, the visible-traces list, and the per-channel
  filter configurations.
- **Metadata** — the version of NeuroTrace that created the file,
  the timestamp, and a reference back to the source recording.

When you move a recording to a different machine, copy its sidecar
along with it and everything you have done — exclusions, averages,
analyses, filters — comes with the file. If the sidecar is missing,
NeuroTrace opens the recording cleanly and writes a fresh one the
first time you make a change worth saving. Sidecars do not store a
copy of the raw recording, so they stay small even for long
experiments. The one exception is averaged sweeps, whose computed
samples are written into the sidecar so they can be displayed and
analysed without having to recompute the average from the original
sweeps every time the file is opened.

![Sidecar JSON excerpt](screenshots/sidecar-json-excerpt.png)

### What is *not* persisted

Cursor positions in the main viewer are deliberately ephemeral: they
reset on every file open. Cursor positions inside an analysis
window, in contrast, are persisted as part of that analysis's
form parameters, so a window you reopen on the same series comes
back exactly as you left it.

---

## 8. Keyboard Shortcuts

All shortcuts are inactive while a text input or a numeric field
has the keyboard focus, so typing a value into a parameter input
will never accidentally trigger a navigation command. Click on the
trace plot once if you want the keyboard to drive navigation again.

### Global

All single-letter shortcuts use the **lowercase** key with no
modifier keys.

| Key | Action |
|---|---|
| `F1` | Toggle the left sidebar (Tree Navigator) |
| `F2` | Toggle the right sidebar (Cursor Panel) |
| `f` | Toggle focus mode — hides both sidebars at once |

NeuroTrace does not install a native menu bar, so opening a file
has no keyboard shortcut: use the toolbar's **Open File** button.

### Trace navigation

| Key | Episodic mode | Continuous mode |
|---|---|---|
| `←` / `→` | Previous / next sweep | Scroll by one viewport width |
| `Shift+←` / `Shift+→` | — | Scroll by half or two viewport widths |
| `Home` / `End` | First / last sweep | Jump to the start / end of the recording |

The **Burst Detection** window (chapter 14) extends this with
`PageUp` / `PageDown` to jump three viewport widths at a time, plus
left-click to add and right-click or double-click to remove a
manual burst.

### Toolbar shortcuts

| Key | Action |
|---|---|
| `o` | Toggle the **Overlay** of all sweeps |
| `a` | Open the **Average** popover |
| `z` | Toggle **Zoom mode** (drag-rectangle to zoom vs drag to pan) |

### Tables

Most analysis-window tables share a common set of shortcuts:

- **Click** to select a row.
- **Shift-click** to extend the selection to a contiguous range.
- **⌘ / Ctrl-click** to add or remove individual rows.
- **Right-click** a row to copy it as TSV.
- **⌘C / Ctrl+C** copies the current selection as TSV (where wired).

Pasting any of these into a spreadsheet preserves the column layout,
so building a working figure from a NeuroTrace results table is
usually a matter of selecting, copying, and pasting.

---

# Part II — Analysis Modules

The chapters that follow each cover one analysis window. Every
window opens as its own desktop window — separate from the main
NeuroTrace window — and stays in sync with the main view through a
shared sweep selection and cursor state. Several windows can be
open at once; closing them does not lose your work, because each
saves its results into the recording's sidecar. Where a window
exposes a choice of methods, the methods themselves are explained
inline next to the parameter that selects them.

---

## 9. Cursor Measurements

The **Cursor Measurements** window is the workhorse of NeuroTrace.
It takes the same idea as the cursor pair on the main viewer — a
pre-stimulus baseline window and a post-stimulus peak window — and
multiplies it: up to ten independent **slots**, each with its own
peak window and its own optional curve fit, all measured against a
common baseline and run across an entire series. The result is a
table of per-slot, per-sweep numbers that you can copy into a
spreadsheet, save to CSV, or eyeball directly to see how a
preparation evolves over an experiment.

In Stimfit terms, this window does what a dozen pairs of cursors
plus the menu-driven *Measure / Fit* commands would do, but
batched, persisted, and visualisable in one place.

### When to use this window

Reach for Cursor Measurements when the question you have is
amplitude- and timing-shaped — peak amplitude, time-to-peak, rise
time, half-width, area under the curve, or the time constant of an
exponential decay. It is the right tool for things like:

- Measuring fEPSP slope and amplitude per sweep across a long
  stimulation protocol.
- Tracking the amplitude of an evoked current across many sweeps
  to see whether the response is rundown- or potentiation-prone.
- Fitting a monoexponential to the decay phase of a synaptic event
  and reporting τ.
- Splitting a complex response into early and late components by
  giving each its own slot.

For purely timing-of-spikes work, use **Action Potentials**
(chapter 12); for spontaneous events, use **Event Detection**
(chapter 13).

### Window layout

The window is divided into a thin top bar and a two-column body.

The **top bar** carries the recording selectors — group, series,
and channel — followed by a sweep preview navigator: ←, an editable
sweep number, and →. The preview lets you scroll through the
series sweep by sweep without committing to a "run on this single
sweep" choice; the run-mode selector lower down the window controls
that separately.

Below the top bar, the **left panel** holds the parameters: the
filter, the shared baseline window, one card per enabled slot, and
the run controls pinned to the bottom. A vertical splitter between
the left panel and the rest of the window lets you widen it when
you have many slots configured.

The **right panel** is split horizontally: the **mini-viewer** at
the top draws the current preview sweep with all the cursor bands
overlaid, and the **results panel** at the bottom shows a tabbed
table of measurements. A horizontal splitter between the two
adjusts how much vertical space each gets.

![Cursor Measurements window overview](screenshots/cursor-window-overview.png)

### Slots

A *slot* is one peak window plus, optionally, one fit window. The
window supports up to ten slots, numbered 1–10, each drawn in its
own colour both on the mini-viewer and in the results table. Slots
are independent — slot 1 might cover the early fast component of a
synaptic response, slot 2 the late slow component, slot 3 a
control window, and so on — but they all share the single baseline
window defined at the top of the left panel.

Increase the **Cursor pairs** number on the left panel to enable
more slots; each newly enabled slot appears as its own card below.
You do not need to use them in order, and disabling a slot leaves
its configuration intact for next time — the slot card simply dims
and stops contributing to the run. Slot colours are assigned
automatically and reused cyclically; they are not user-pickable.

### Configuring a slot

Each slot card carries:

- **Peak window** — start and end times, in seconds, defining the
  region within which the slot's peak will be measured. You can
  type into the inputs or drag the band on the mini-viewer; both
  views stay in sync.
- **Fit checkbox** — when ticked, an additional fit window appears,
  along with a function selector. Until the checkbox is on, no
  curve fit is performed for that slot.
- **Fit range** — start and end of the window over which the chosen
  function will be fitted. Like the peak window, this can be edited
  numerically or by dragging on the mini-viewer.
- **Fit function** — see the **Fit functions** section below.
- **Advanced fit options** — a small disclosure that exposes the
  optimiser's iteration limit (`max iter`), function-tolerance
  (`ftol`), and parameter-tolerance (`xtol`), plus a list of named
  initial-guess inputs for each parameter of the chosen function.
  Leave these blank to let NeuroTrace pick reasonable starting
  values; fill them in only when you are fighting a stubborn fit.
  A **reset guesses** button clears any overrides.

### The mini-viewer

The mini-viewer at the top of the right panel draws the currently
previewed sweep, with the baseline band, every enabled slot's peak
band, and any active fit bands overlaid in their respective colours.
Move a cursor by dragging its edge to resize or by dragging its
interior to translate; numerical values in the left panel update
in real time.

Three small controls live in the **top-right corner** of the
mini-viewer header:

- **Zero offset** subtracts a baseline computed from the first few
  milliseconds of each previewed sweep, so traces with very
  different DC offsets can be compared by shape. It is a display
  aid only — the underlying analysis still works in the original
  units.
- **Reset cursors** distributes the baseline band into the first
  10 % of the visible time range and spaces every enabled slot's
  peak band evenly across the rest. Useful when you have zoomed in
  on a different region and want to start over with sensible
  positions.
- **Reset zoom** auto-fits the X and Y axes to the data extents.

A small help line under the plot reminds you of the wheel and drag
conventions: scroll to zoom X, Option/Alt-scroll to zoom Y, drag
empty space to pan, drag inside a band to move it, drag a band
edge to resize.

![Mini-viewer header controls](screenshots/cursor-window-mini-viewer.png)

### The filter

A **Filter** section at the top of the left panel exposes the same
zero-phase Butterworth filter described in chapter 4 — Lowpass,
Highpass, or Bandpass — applied live to whatever is shown in the
mini-viewer. The filter is seeded from the main viewer's filter on
opening, so the trace you start with looks the way it did in the
main window, but you can change it here without disturbing the main
viewer's setting. Measurements always operate on the filtered trace
when the filter is enabled.

### The baseline window and method

A single **Baseline** window — start and end in seconds — applies
to every slot. The **Method** selector below it controls how a
single baseline value is computed from that window:

- **Mean** — the arithmetic mean of all samples in the window. The
  default; appropriate for stationary, well-behaved baselines.
- **Median** — the 50th percentile. More robust when the baseline
  contains occasional outliers (e.g., spontaneous events you do not
  want to fold into the reference).

The choice of method also affects how the baseline's spread is
reported in the results table: under **mean** the column is
standard deviation; under **median** it is interquartile range.

### The run controls

The bottom of the left panel pins the run controls so they remain
reachable as you scroll through slot cards.

- **Run** triggers the analysis on the backend with the current
  parameters and the chosen sweep set.

- The **Sweeps** dropdown picks what to run on:
  - **All sweeps** — every sweep in the selected series, minus any
    excluded ones.
  - **Range** — a contiguous range, with from/to inputs.
  - **Single sweep** — one specific sweep, picked by index.

- **Average selected sweeps first** averages the chosen sweep set
  *before* running the analysis, producing a single set of
  measurements (one per slot) instead of one row per sweep. This
  is useful when you want a single representative value for, say,
  a stable baseline period.

- **Clear** discards the current measurements (the parameters
  themselves are kept).
- **Export CSV** writes the visible measurements to a CSV file via
  the standard save dialog.

If a run fails, an inline red banner reports the error.

### The results panel

Below the mini-viewer, the results panel shows a table of
measurements with two tabs at the top: **Measurements** and **Fit**.
Each tab carries its own column-visibility set; click the
**Columns ▾** dropdown on the right of the tab strip to toggle
columns on or off. Your choice is remembered across sessions.

Within either table, the **Sweep** and **Slot** columns are always
locked, so you always know which row belongs to which sweep and
slot. Rows are click-selectable, with shift-click for ranges and
⌘ / Ctrl-click for individual additions; right-click a row for a
**Copy as TSV** entry, or select multiple rows first and copy them
in one go. Pasted into a spreadsheet, the columns line up directly.

The **Fit** tab is filtered automatically to show only those rows
that carry a fit result, and its columns differ accordingly: the
fit function name, R², residual sum of squares, and the fitted
parameters in `name=value` form.

![Results table](screenshots/cursor-window-results-table.png)

### Measurements

The Measurements tab carries the following columns. All times are
shown in milliseconds, all amplitudes in the channel's recorded
units, and all slopes in *units per second*.

- **baseline** — the mean (or median, per the baseline method) of
  the signal over the baseline window.
- **baseline sd** — the standard deviation of the baseline window
  under the mean method, or the interquartile range under the
  median method.
- **peak** — the sample inside the peak window with the largest
  *signed* deviation from the baseline. The sign is preserved, so
  inward currents read negative and outward currents read positive.
  Both the maximum and minimum are considered, and whichever is
  farther from the baseline wins; this means slots can detect
  upward and downward responses without you having to declare a
  direction.
- **amplitude** — peak minus baseline.
- **peak time** — the absolute time of the peak sample, measured
  from the start of the sweep.
- **time to peak** — the time from the start of the peak window to
  the peak itself; effectively the latency of the response within
  the cursor.
- **rise time 10–90 %** and **rise time 20–80 %** — the time the
  trace takes to climb from 10 % (or 20 %) of the signed amplitude
  to 90 % (or 80 %). NeuroTrace finds the two crossing points
  walking back from the peak and **interpolates linearly between
  adjacent samples** so the result is not quantised to the sample
  rate. If either crossing cannot be found inside the cursor (for
  example, because the trace did not actually return to baseline
  before the window ended), the field is left blank rather than
  reported as a wrong number.
- **half-width** (FWHM, t½) — the duration during which the trace
  is above (or below, for downward responses) 50 % of the signed
  amplitude. Computed by interpolating the two 50 % crossings
  bracketing the peak.
- **rise slope** — the steepest slope of the rising phase, computed
  as the largest first-difference *dy/dt* between the start of the
  peak window and the peak itself, in the appropriate sign.
- **decay slope** — the steepest slope of the falling phase, from
  the peak to the end of the peak window.
- **R/D** — the ratio of rise slope to decay slope. Reported only
  when the decay slope is non-zero.
- **area** — the signed area enclosed between the trace and the
  baseline within the peak window, computed by trapezoidal
  integration. The units are *channel-units · seconds* — that is,
  picocoulombs for currents in pA, or millivolt-seconds for
  voltage. Charge transfer for inhibitory and excitatory events
  comes out negative and positive, respectively, in line with the
  sign convention for the peak.

### Fit functions

A slot's optional curve fit runs the chosen function against the
samples in the fit window using a least-squares optimiser. Eleven
functions are available; pick the one whose shape matches the
process you are studying. In the equations below, *x* is time
relative to the start of the fit window.

| Function | Equation | Parameters | Typical use |
|---|---|---|---|
| **Monoexponential** | *amp · exp(−x/τ) + offset* | amp, τ, offset | Single-time-constant decays: synaptic-current decay, capacitive transients |
| **Monoexponential with delay** | flat at *baseline* until *delay*, then exponential approach to *peak* with time constant *τ* | baseline, delay, τ, peak | Decays that begin some time after the start of the fit window |
| **Biexponential** | *amp₀ · exp(−x/τ₀) + amp₁ · exp(−x/τ₁) + offset* | amp₀, τ₀, amp₁, τ₁, offset | Decays with two distinguishable time constants (fast + slow) |
| **Biexponential with delay** | delayed rise-and-decay with two τ values | baseline, delay, τ₁, factor, τ₂ | Synaptic responses with a finite rise time and a separable decay |
| **Triexponential** | sum of three exponentials with a common offset | amp₀..amp₂, τ₀..τ₂, offset | Compound decays that resist a two-exponential description |
| **Triexponential with delay** | delayed three-component kinetics | baseline, delay, τ₁ₐ, factor, τ₂, τ₁ᵦ, p_τ₁ᵦ | Rare; reserved for kinetics that genuinely require three components and a delay |
| **Alpha function** | *A · (x/τ) · exp(1 − x/τ) + offset* | amp, rate, offset | Synaptic conductance or current waveforms with a rising-and-falling shape; peaks at *t = τ* |
| **Gaussian** | *amp · exp(−((x − μ)/w)²)* | amp, μ, w | Symmetric bell-shaped events; useful for, e.g., aligning to a peak in a histogram |
| **Hodgkin–Huxley g_Na** | *g′ · (1 − exp(−x/τₘ))³ · exp(−x/τₕ) + offset* | g′, τₘ, τₕ, offset | Activation/inactivation kinetics of voltage-gated sodium current |
| **Power-of-1 g_Na** | *g′ · (1 − exp(−x/τₘ)) · exp(−x/τₕ) + offset* | g′, τₘ, τₕ, offset | A simpler Na conductance form when the cubic term is unjustified |
| **Boltzmann** | *bottom + (top − bottom) / (1 + exp((V₅₀ − x) / slope))* | bottom, top, V₅₀, slope | Voltage-dependent activation or inactivation curves; *x* is voltage rather than time |

For each fit, the Fit tab reports:

- **R²** — the coefficient of determination; a quick goodness-of-fit
  number. Values close to 1 indicate that the model accounts for
  most of the variance in the fit window; low or negative values
  indicate a bad fit.
- **RSS** — the residual sum of squares, in the channel's units
  squared. Useful for absolute comparisons between two fits to the
  same data.
- **params** — the fitted parameter values, formatted as
  *name=value* pairs.

The fit's predicted curve is also drawn on the mini-viewer in
purple over the fit window, on top of the trace, so you can see at
a glance whether the optimiser has converged to something
reasonable. If the fit fails outright — for example, the optimiser
hits the iteration limit — that slot's row in the Fit tab is left
blank for that sweep.

### Persistence

Cursor Measurements stores its parameters and results in two
places, following the pattern described in chapter 7. The per-file
state — slot configuration, baseline window, run mode, and
measurement results for each *(group, series)* pair — is broadcast
to the main window and saved into the sidecar. The window's own
visual preferences — the splitter positions, the visible-column
sets for each tab, and the like — live in the global preferences
file, so they follow you across recordings.

When you reopen a recording, the window comes back exactly as you
left it: the same slots configured the same way, the same
measurements still on screen.

---

## 10. Resistance — Rs / Rin / Cm

The **Resistance** window analyses the brief test pulse that most
voltage-clamp protocols put at the start (or end) of every sweep,
and turns it into three numbers — series resistance **Rs**, input
resistance **Rin**, and membrane capacitance **Cm** — together with
the membrane time constant **τ** that Cm is derived from. Run
across a series, those numbers form the cell-quality timecourse
you typically need to keep an eye on for the duration of an
experiment: Rs creeping up, Rin collapsing, Cm changing in either
direction.

The expected input is a sweep that contains a small, brief command
step — typically a 5 mV depolarising pulse for VC, lasting a few
tens of milliseconds — applied against an otherwise stable baseline.
You do not need to mark the step yourself: when the recording's
HEKA `.pgf` is available, NeuroTrace reads the step amplitude from
the protocol and pre-fills it for you.

### When to use this window

- Tracking access resistance over a long whole-cell recording, to
  decide when to discard sweeps that drift past your tolerance
  (typically 20–25 % change).
- Estimating membrane capacitance and time constant from the same
  test pulse used for Rs monitoring.
- Comparing cell properties across conditions in a single
  experiment — for example, before and after wash-in of a drug.

### Window layout

The structural pattern is the same as **Cursor Measurements**: a
top selector bar, a left parameter pane, a vertical splitter, and a
right pane split horizontally into a mini-viewer above a results
table.

The **top bar** carries the group, series, and channel selectors
followed by a sweep preview navigator (←, sweep number, →). The
preview lets you scroll through the series independently of the
"single sweep" run mode, so you can look at sweep 17 while
preparing to analyse only sweep 5.

The **left panel** holds the cursor read-out, the fit parameters,
and the run controls.

The **right panel** has the mini-viewer at the top — with the
baseline and peak bands draggable — and the results table at the
bottom. The horizontal splitter between them is draggable.

![Resistance window overview](screenshots/resistance-window-main-layout.png)

### The mini-viewer and cursors

Resistance uses two cursor pairs:

| Pair | Colour | Purpose |
|---|---|---|
| **Baseline** | green | The pre-pulse window, used to compute the resting current |
| **Peak / pulse** | yellow | The window containing the test pulse, from its onset to its end |

Unlike Cursor Measurements, there is no separate **fit** cursor:
the fit window is taken automatically from the peak of the
capacitive transient onward, with its length set by the **Fit
duration** parameter described below. This keeps the workflow
simple — you mark where the pulse is, NeuroTrace finds the
transient inside it.

Cursor positions are shown read-only at the top of the left panel
in the format `BL: 0.001 → 0.010 s` and `PK: 0.010 → 0.050 s`. To
move a cursor, **drag it on the mini-viewer**: drag a band's
interior to translate, drag an edge to resize. The numerical
read-outs update in real time.

The mini-viewer header carries the same three controls you saw in
chapter 9 — **Zero offset**, **Reset cursors**, **Reset zoom** —
plus a small purple indicator that lights up when a fit is
displayed (e.g. *Fit (mono-exp, 5.0 ms)*). The fit curve itself is
overlaid on the trace in purple.

### Fit parameters

Three parameters drive the analysis.

- **V_step (mV)** — the amplitude of the test-pulse command, used
  as the numerator in the Rs and Rin formulae below. When a HEKA
  `.pgf` is available for the recording, this field is filled in
  automatically and labelled *auto*. You can override the value at
  any time by typing a different number — useful for files where
  the protocol metadata is missing or wrong, or for ABF files where
  no `.pgf` exists.

- **Exp fit** — *Mono* (single exponential) or *Bi* (sum of two
  exponentials). The single exponential is the right choice for
  most well-clamped cells; bi-exponential is offered for cases
  where the capacitive transient genuinely shows two distinguishable
  time constants — typically a small fast component dominated by
  Rs and a slower component reflecting the dendritic charge
  distribution.

- **Fit duration (ms)** — the length of the window over which the
  exponential is fitted, measured **from the peak of the
  transient**. Anywhere from 0.5 to 50 ms; the default of about
  5 ms is appropriate for most patch-clamp transients.

### Run controls

The Run controls at the bottom of the left panel work as in chapter
9, with one extra mode tailored to monitoring workflows:

- **All sweeps (N)** — every sweep in the series, minus exclusions.
- **Selected (N)** — only the sweeps currently selected in the
  Tree Navigator. Useful for analysing only the test pulses you
  trust, or only those flanking a drug application.
- **Averaged range** — averages a contiguous range of sweeps first,
  then runs the analysis once on the resulting average. Reduces
  noise at the cost of replacing per-sweep results with a single
  row labelled *avg X–Y*.
- **Single sweep** — one sweep, picked by index.

The **Run** button executes the chosen mode; **Clear** wipes the
results for the current series; **Copy CSV** places the entire
current results table on the clipboard as comma-separated values,
ready to paste into a spreadsheet.

If a run fails — typically because the pulse window is too short
for a fit, or because the optimiser does not converge — an inline
error banner explains why.

### How the numbers are computed

All four output quantities come from the same backend pass over a
single sweep (or averaged sweep). The procedure is:

**Step 1 — Baseline.** The current is averaged over the baseline
cursor window. This single number is then subtracted from
everything that follows.

**Step 2 — Peak transient.** Within the first 5 ms of the peak
window (or the first half of the peak window, whichever is
shorter), the sample with the largest absolute deviation from the
baseline is taken as the *peak current* of the capacitive
transient. The sign is preserved — for a depolarising VC step the
peak is positive, for a hyperpolarising step it is negative — but
the formulas below use absolute values so direction doesn't matter.

**Step 3 — Steady state.** The current is averaged over the last
20 % of the peak window — the assumption being that, by then, the
capacitive transient has decayed and what is left is the
steady-state response to the command.

**Step 4 — Rs and Rin.** Both are then straightforward applications
of Ohm's law:

> **Rs** *(MΩ)* = |V_step| / |peak current|
>
> **Rin** *(MΩ)* = |V_step| / |steady-state current|

Both numbers are converted to megohms internally (mV / pA gives
gigohms; the factor of 1000 in the code applies the unit
conversion). If either current is essentially zero — below
10⁻¹⁰ A in the code — the corresponding resistance is reported as
blank rather than as a divide-by-zero.

**Step 5 — Decay fit.** Starting from the peak sample, the fit
window of length **Fit duration** is taken. The samples in that
window are baseline-subtracted and the chosen exponential model is
fitted by non-linear least squares (SciPy's `curve_fit`, capped at
10 000 function evaluations).

For the **monoexponential**, the model is:

> *I(t) = a · exp(−t/τ) + offset*

with the time constant τ bounded between 0.01 ms and 0.9 × Fit
duration so that the optimiser cannot run away to physically
implausible values.

For the **biexponential**, the model is:

> *I(t) = a₁ · exp(−t/τ₁) + a₂ · exp(−t/τ₂) + offset*

with the same per-τ bounds. After convergence, the two components
are sorted so that τ₁ < τ₂ (fast first, slow second). The single τ
reported in the results is the **amplitude-weighted average** of
the two:

> *τ = (|a₁| · τ₁ + |a₂| · τ₂) / (|a₁| + |a₂|)*

This collapses the biexponential back into a single number that
slots into the Cm formula below.

The fit's quality is reported as **R²** computed from the
residuals against the variance of the data in the fit window.
Values close to 1 mean the fit explains most of the variance;
values near zero or negative mean it does not. R² is clamped at
zero so a pathologically bad fit can never drag the column into
the negatives.

**Step 6 — Cm.** Membrane capacitance is recovered from the time
constant and Rs by treating the cell as a simple RC circuit
charging through Rs:

> **Cm** *(pF)* = τ / Rs

with units arranged so that τ in ms divided by Rs in MΩ gives Cm
in pF directly. The formula approximates the full *Cm = τ × (Rs +
Rin) / (Rs · Rin)* by neglecting the contribution of Rin, which is
acceptable when Rin ≫ Rs — typical for healthy cells. For cells
where the input resistance is low (sick cells, leaky seals), the
reported Cm should be treated as approximate.

NeuroTrace also applies a sanity filter: any computed Cm outside
the range 0.1 pF to 2 000 pF is dropped from the row rather than
displayed, on the grounds that anything outside that window is
overwhelmingly more likely to be a fit artefact than a real
measurement.

### The results table

Each run appends rows to the table; the table is not cleared
between runs against the same series, so you can incrementally
build up a record by running different sweep ranges with different
fit settings if you want to. The columns, in order, are:

- **Series** — the series name (truncated if long; hover for full).
- **Sweep** — the sweep index, 1-based, or *avg X–Y* for averaged
  ranges.
- **Rs** (MΩ), 1 decimal.
- **Rin** (MΩ), 1 decimal.
- **Cm** (pF), 1 decimal, blank if outside the sanity range.
- **τ** (ms), 2 decimals, blank if the fit did not converge.
- **R²**, 3 decimals, blank if the fit did not converge.

Selection and copying follow the table conventions from chapter 8
— click for single, shift-click for ranges, ⌘ / Ctrl-click for
additive — and right-click any row to copy it as TSV. **Copy CSV**
on the left panel exports every row in the current table at once.

![Resistance results and fit overlay](screenshots/resistance-window-fit-overlay.png)

A summary timecourse plot — Rs / Rin / Cm over the sweep axis — is
not currently part of the window; results live only in the table.
For a quick visual scan, copy the table into a spreadsheet and plot
from there.

### Persistence

Resistance results are saved per *(group, series)* pair and stored
in the recording's sidecar, alongside the form parameters
(V_step, exponential mode, fit duration, run mode). The window's
own UI preferences — left-panel width, mini-viewer height — live
in the global preferences file. Reopening a recording restores
both, so you come back to the same view with the same numbers
already in place.

---

## 11. I-V Curve

The **I-V Curve** window plots a cell's response amplitude against
the level of injected stimulus, sweep by sweep, and fits a line
through the result. The slope of that line is the cell's **input
resistance** (or its conductance, depending on which axis you read
the line off), and the X-intercept is the **reversal potential** of
the underlying current. Per-sweep entries also expose two summary
numbers — **sag amplitude** and **sag ratio** — that quantify the
slow re-equilibration after a hyperpolarising step, useful for
characterising HCN-mediated Iₕ.

The window supports both modes of recording symmetrically:

- In **voltage clamp**, the stimulus is in mV and the response is
  in pA. The slope of the I-V line is then a conductance (pA / mV
  → nS); its inverse, scaled to MΩ, is the input resistance.
- In **current clamp**, the stimulus is in pA and the response is
  in mV. The slope is now a resistance directly; multiplied by the
  unit factor it is reported in MΩ as input resistance.

In either case NeuroTrace works out the directionality from the
units of the recorded channel, so you do not have to tell it which
mode the recording is in.

### When to use this window

- Estimating input resistance from a step or ramp protocol.
- Locating the reversal potential of a synaptic or evoked current
  by extrapolating the I-V line to where it crosses zero.
- Quantifying sag during hyperpolarising current injection (the
  classic HCN signature).
- Comparing I-V relationships before and after a manipulation by
  running the analysis on two series and inspecting the two curves
  side by side in the results table.

### Window layout

The structural pattern is identical to **Resistance**: top selector
bar with sweep preview, left parameter pane, vertical splitter,
right pane split horizontally into mini-viewer above results.
What is new is the I-V curve plot itself — a scatter plot of stim
vs response with the linear-fit line overlaid — accessible through
a tab strip in the results panel.

![I-V window overview](screenshots/iv-window-full-layout.png)

### The mini-viewer and cursors

I-V uses two cursor pairs, sharing the same window for two different
measurements:

| Pair | Colour | Purpose |
|---|---|---|
| **Baseline** | green | The pre-stimulus window from which the resting current (or voltage) is measured |
| **Peak / SS** | yellow | The pulse window. The mean over this window gives the *steady-state* response; the most-deflected sample within it gives the *transient peak* |

Cursor positions are read-only at the top of the left panel; drag
the bands on the mini-viewer to move them. The mini-viewer header
carries the same controls as the other analysis windows — Zero
offset, Reset cursors (which positions Baseline at 5–20 % and
Peak/SS at 35–65 % of the visible range), and Reset zoom.

The stimulus trace, when the file carries one, is shown as an
overlay in its usual right-axis colour; turn it on from the channel
overlay selector at the top of the window if it is not already
visible.

### The response metric

A small dropdown on the left panel — labelled **Y metric** — picks
which of two computed responses is plotted on the I-V curve and
shown in the *Response* column of the table. The choice is purely
display-driven: both metrics are always computed and stored per
sweep, so you can switch between them after a run without
re-running.

- **Steady-state (mean)** — the mean of the trace over the Peak/SS
  window, baseline-subtracted. The default. Right for steady
  steps where the cell has settled into its asymptotic response.
- **Transient peak** — the sample within the Peak/SS window with
  the largest *signed* deviation from the baseline,
  baseline-subtracted. Right when you are interested in the
  fast-onset response (for example, the peak of a synaptic current
  before desensitisation).

### Stimulus level: auto and manual

Each sweep in an I-V protocol carries a different level of
injected stimulus, and the analysis needs to know what that level
is to plot it against the response. NeuroTrace offers two ways of
supplying it.

**Auto** — the default — reads the level out of the recording's
HEKA `.pgf` protocol file. NeuroTrace picks the channel most
likely to be the actual command (heuristically, the one with the
largest range and an active *do-write* flag) and, for each sweep,
uses the most-deflected segment value of that channel as the
stimulus level. Volts are converted to millivolts and amperes to
picoamperes automatically. After a successful run, the panel
reports back what it detected — for example,
*Detected: reconstructed (mV)*.

**Manual** is the fallback for ABF files, plain-text imports, or
HEKA recordings whose protocol metadata is missing. Pick **Manual
(start / step)** and fill in four fields:

- **start (s)** — the time at which the stimulus turns on.
- **end (s)** — the time at which it turns off.
- **start Im (pA)** — the stimulus level of the *first* sweep in
  the analysis range.
- **step (pA)** — the increment per sweep, so that the level for
  sweep *n* is *start + n × step*.

The window shows the formula as a small caption under the inputs to
make the convention explicit. Negative values and zero steps are
allowed; NeuroTrace uses whatever you supply.

If you leave the window in Auto on a recording that does not have
a usable stimulus, the run aborts with a clear message asking you
to switch to Manual.

### Run controls

The same All / Range / Single / *averaged range* dispatch you saw
in chapter 10. Two I-V-specific behaviours are worth flagging:

- The results are **sorted by stimulus level** before being plotted,
  so the curve always reads left-to-right in stim order regardless
  of how the protocol was actually run.
- **Single sweep** mode *appends* to the existing table rather than
  replacing it, the way it does in Resistance. This is intentional:
  it lets you cherry-pick individual sweeps onto the same I-V
  curve, which is useful when a protocol contains both monotonic
  and outlier steps.

**Run** executes; **Clear** removes the entry for the current
*(group, series)* pair; **Export CSV** writes the entire
collection of I-V results across every analysed series in the
recording to a single CSV file.

### How the numbers are computed

For each sweep in the run set, the backend extracts five quantities
from the trace:

- **Baseline** = mean over the baseline window.
- **Steady-state** = mean over the Peak/SS window.
- **Transient peak** = the sample within the Peak/SS window whose
  absolute deviation from the baseline is largest. The sign is
  preserved.
- **Sag amplitude** = transient peak − steady-state. With the
  signs preserved, the result is positive when the trace transiently
  *exceeds* its steady-state response and negative otherwise — the
  classic depolarising sag during a hyperpolarising step comes out
  as a positive number under VC and a negative number under CC,
  which simply reflects the unit conventions of the two modes.
- **Sag ratio** = sag amplitude divided by (transient peak −
  baseline), reported only when the denominator is non-zero. A
  dimensionless number that allows comparison across cells of
  different sizes; commonly used as the headline number for
  Iₕ-mediated sag.

Each row in the table carries all five (plus the **Response**
column, which is whichever of *steady* or *peak* you have
currently selected as the Y metric, baseline-subtracted).

### The I-V line

Once at least two points are present, NeuroTrace fits a straight
line through them using ordinary least-squares linear regression.
The fit is computed client-side directly from the per-sweep table,
so switching the Y metric immediately re-fits without going back
to the backend.

What the fit reports:

- **Slope** — the slope of the line in *response-units per
  stim-units*. Reported as part of the summary line above the I-V
  plot.
- **R²** — the goodness of fit, on the standard 0–1 scale.
- **Input resistance (Rin)** — the slope, scaled into megohms with
  the right sign for the recording mode:
  - In voltage clamp (stim mV, response pA), *Rin = 1000 / slope*
    MΩ.
  - In current clamp (stim pA, response mV), *Rin = slope × 1000*
    MΩ.
  - For other unit combinations the field is left blank, since
    there is no unambiguous resistance interpretation.
- **Reversal potential** — the X-intercept of the line, read off
  the plot directly. The Y axis on the I-V plot is forced to
  include zero so that the crossing is always visible.

### The results panel

Two tabs sit at the top of the results panel.

The **I-V curve** tab is the scatter plot, with the linear-fit
line drawn through the points as a dashed accent-coloured line.
Click a point to highlight it; the corresponding row in the table
is highlighted in the same colour. (Selecting a point or row does
not jump the main viewer to that sweep — use the sweep preview
arrows on the top bar for navigation.)

The **Table** tab shows every per-sweep row with the columns
**Sweep · Stim · Baseline · Steady-state · Transient peak · Sag
amp · Sag ratio · Response**. The Sweep column is 1-based; the
unit headings update with the recording's units. Selection,
shift-click, ⌘ / Ctrl-click, right-click-to-copy-as-TSV all work
as in chapter 8.

A summary line above both tabs reports the point count, the
cursor windows used for the run, and (when a fit is present) the
slope, R² and input resistance.

![I-V curve and fit summary](screenshots/iv-window-curve-tab.png)

### Persistence

I-V results, the form parameters (run mode, sweep range, Y
metric, manual-Im fields, detected stimulus source), and the
selected point are stored per *(group, series)* pair in the
sidecar. The window's left-panel width and mini-viewer height
live in the global preferences file. Reopening a recording
restores everything, including which metric you had selected and
which point you had highlighted on the curve.

---
