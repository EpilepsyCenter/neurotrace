# NeuroTrace

A modern electrophysiology analysis desktop app inspired by [Stimfit](https://github.com/neurodroid/stimfit). Built with Electron + React + FastAPI.

## Features

- **File format support**: HEKA Patchmaster (`.dat`), Axon Binary Format (`.abf`), plus 50+ formats via [Neo](https://github.com/NeuralEnsemble/python-neo)
- **Interactive trace viewer**: fast [uPlot](https://github.com/leeoniya/uPlot) rendering with draggable cursor regions, sweep overlay, average trace, and drag-to-zoom
- **Core analyses**:
  - Cursor-based measurements (baseline, peak, amplitude, rise time, half-width, area)
  - Automated series resistance / input resistance / membrane capacitance from test pulses
  - Kinetics (mono / bi-exponential fitting)
  - Event detection (threshold, derivative, template matching)
- **Field potential analyses**: fEPSP slope, population spike amplitude, paired-pulse ratio, LTP/LTD quantification
- **Burst detection**: threshold-based, inter-spike-interval-based, and oscillation/envelope-based methods
- **Spectral analysis**: power spectrum, spectrogram, band power
- **Macro system**: write Python scripts with full NumPy/SciPy access via a `stf`-style API, or build visual analysis pipelines with a node graph editor
- **Custom themes and fonts**: dark/light themes, configurable UI and monospace fonts with persistent preferences

## Architecture

```
NeuroTrace/
├── electron/           # Electron main process + preload (IPC bridge)
├── frontend/           # React + TypeScript + Vite UI
│   └── src/
│       ├── components/ # TraceViewer, TreeNavigator, CursorPanel, ...
│       ├── stores/     # Zustand state (app + theme)
│       └── styles/
├── backend/            # Python FastAPI server
│   ├── api/            # REST endpoints (files, traces, analysis, macros)
│   ├── readers/        # HEKA / ABF / Neo file readers
│   ├── analysis/       # Cursor, resistance, kinetics, events, bursts, ...
│   ├── macros/         # Python script + visual pipeline engines
│   └── utils/          # Filtering, LTTB downsampling, baseline subtraction
└── scripts/
```

Electron spawns the FastAPI backend as a child process on a local port. The frontend talks to it over HTTP. All scientific computation happens in Python; the frontend handles only rendering and interaction.

## Requirements

- Node.js 18+
- Python 3.10+
- npm

## Getting started

Install dependencies:

```bash
npm install
pip install -r backend/requirements.txt
```

Run the dev server (starts both Electron and the Python backend):

```bash
npm run dev
```

Or use the shell helper:

```bash
./scripts/dev.sh
```

## Keyboard shortcuts

- `← / →` or `, / .` — previous / next sweep
- `Home / End` — first / last sweep
- `O` — toggle overlay of all sweeps
- `A` — toggle average trace
- `Z` — toggle drag-to-zoom mode
- `Cmd/Ctrl + Option + I` — open DevTools

## License

MIT
