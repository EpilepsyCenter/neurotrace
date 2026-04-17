import { create } from 'zustand'

export interface TraceData {
  time: Float64Array
  values: Float64Array
  samplingRate: number
  units: string
  label: string
}

export interface SweepInfo {
  index: number
  label: string
  traceCount: number
}

export interface StimulusSegment {
  start: number  // seconds
  end: number    // seconds
  level: number  // mV or pA
}

export interface StimulusInfo {
  unit: 'mV' | 'pA'       // command unit (VC → mV, CC → pA)
  vHold: number           // holding level (same unit)
  vStep: number           // pulse delta from holding (signed)
  vStepAbsolute: number   // absolute pulse level
  pulseStart: number      // seconds
  pulseEnd: number        // seconds
  baselineStart: number   // seconds (suggested cursor)
  baselineEnd: number     // seconds (suggested cursor)
  segments: StimulusSegment[]  // first-sweep reconstruction for overlay
}

/** Metadata about one recorded channel within a series (probed from first sweep). */
export interface ChannelInfo {
  index: number
  label: string
  units: string
  kind: 'voltage' | 'current' | 'other'
}

/** Sentinel trace index representing the reconstructed stimulus in a
 *  ``visibleTraces`` list. Recorded channel indices are >= 0. */
export const STIMULUS_TRACE_INDEX = -1

export interface SeriesInfo {
  index: number
  label: string
  sweepCount: number
  sweeps: SweepInfo[]
  channels?: ChannelInfo[]
  rs?: number
  cm?: number
  holding?: number
  protocol?: string
  stimulus?: StimulusInfo | null
}

export interface GroupInfo {
  index: number
  label: string
  seriesCount: number
  series: SeriesInfo[]
}

export interface RecordingInfo {
  filePath: string
  fileName: string
  format: string
  groupCount: number
  groups: GroupInfo[]
}

export interface CursorPositions {
  baselineStart: number
  baselineEnd: number
  peakStart: number
  peakEnd: number
  fitStart: number
  fitEnd: number
}

export interface CursorVisibility {
  baseline: boolean
  peak: boolean
  fit: boolean
}

export interface FilterState {
  enabled: boolean
  type: 'lowpass' | 'highpass' | 'bandpass'
  lowCutoff: number   // Hz
  highCutoff: number  // Hz
  order: number
}

/** Viewport into a trace, for continuous-data scrolling. */
export interface Viewport {
  start: number  // seconds, inclusive
  end: number    // seconds, exclusive
}

/** Default viewport length when opening a new sweep (seconds). */
export const DEFAULT_VIEWPORT_SECONDS = 10

/** Monotonic counter used by refetchViewport to discard stale responses
 *  (e.g. when the user drags the scroll slider, we fire many requests and
 *  only the latest one should be committed to state). */
let _viewportFetchSeq = 0

/** Stable empty visible-traces reference. Returned by `getVisibleTraces` when
 *  a series' defaults haven't been materialized yet. Keeping this stable means
 *  selectors return the same reference across renders and don't cause
 *  spurious re-renders / plot rebuilds. */
const EMPTY_VISIBLE_TRACES: number[] = []

/** Persist/restore field-burst detections per-recording via Electron
 *  preferences. Keyed by filePath. Non-blocking — failures are silent. */
async function _loadPersistedBursts(filePath: string): Promise<Record<string, FieldBurstsData> | null> {
  const api = window.electronAPI
  if (!api?.getPreferences || !filePath) return null
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = prefs.savedFieldBursts as Record<string, any> | undefined
    return store?.[filePath] ?? null
  } catch {
    return null
  }
}

async function _savePersistedBursts(filePath: string, fieldBursts: Record<string, FieldBurstsData>) {
  const api = window.electronAPI
  if (!api?.getPreferences || !api?.setPreferences || !filePath) return
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = (prefs.savedFieldBursts as Record<string, any>) ?? {}
    if (Object.keys(fieldBursts).length === 0) {
      delete store[filePath]
    } else {
      store[filePath] = fieldBursts
    }
    await api.setPreferences({ ...prefs, savedFieldBursts: store })
  } catch { /* ignore */ }
}

/** Load/save I-V curves — same shape as the burst helpers above. */
async function _loadPersistedIVCurves(filePath: string): Promise<Record<string, IVCurveData> | null> {
  const api = window.electronAPI
  if (!api?.getPreferences || !filePath) return null
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = prefs.savedIVCurves as Record<string, any> | undefined
    return store?.[filePath] ?? null
  } catch {
    return null
  }
}

async function _savePersistedIVCurves(filePath: string, ivCurves: Record<string, IVCurveData>) {
  const api = window.electronAPI
  if (!api?.getPreferences || !api?.setPreferences || !filePath) return
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = (prefs.savedIVCurves as Record<string, any>) ?? {}
    if (Object.keys(ivCurves).length === 0) {
      delete store[filePath]
    } else {
      store[filePath] = ivCurves
    }
    await api.setPreferences({ ...prefs, savedIVCurves: store })
  } catch { /* ignore */ }
}

/** Broadcast I-V state to other windows — analogous to _broadcastBursts. */
function _broadcastIVCurves(ivCurves: Record<string, IVCurveData>) {
  try {
    const ch = new BroadcastChannel('neurotrace-sync')
    ch.postMessage({ type: 'iv-update', ivCurves })
    ch.close()
  } catch { /* ignore */ }
}

/** Broadcast field-burst state + detection filter to other windows via the
 *  shared `neurotrace-sync` channel. Called from the analysis window's store
 *  after every detection run so markers appear in the main viewer. */
function _broadcastBursts(fieldBursts: Record<string, FieldBurstsData>, params: FieldBurstsParams) {
  try {
    const ch = new BroadcastChannel('neurotrace-sync')
    ch.postMessage({ type: 'bursts-update', fieldBursts })
    // Also push the detection filter config so the main viewer can adopt it
    // (keeps the visual-trace and burst-marker y-values aligned).
    if (params.filter_enabled) {
      ch.postMessage({
        type: 'detection-filter',
        filter: {
          enabled: true,
          type: String(params.filter_type ?? 'bandpass') as FilterState['type'],
          lowCutoff: Number(params.filter_low ?? 1),
          highCutoff: Number(params.filter_high ?? 50),
          order: Number(params.filter_order ?? 4),
        },
      })
    }
    ch.close()
  } catch { /* ignore — BroadcastChannel unavailable */ }
}

export interface MeasurementResult {
  sweepIndex: number
  seriesIndex: number
  baseline: number
  peak: number
  amplitude: number
  riseTime?: number
  decayTime?: number
  halfWidth?: number
  area?: number
  rs?: number
  rin?: number
}

export interface OverlayEntry {
  sweep: number
  data: TraceData
  color: string
}

export type ResistanceQuality = 'good' | 'warning' | 'poor' | 'unknown'

export interface ResistanceMonitorData {
  group: number
  series: number
  trace: number
  sweepIndices: number[]
  rs: (number | null)[]
  rin: (number | null)[]
  cm: (number | null)[]
  quality: ResistanceQuality
  maxRsChangePct: number
  meanRs: number | null
  meanRin: number | null
  vStep: number
  cursors: CursorPositions
}

/** One detected burst, flat shape suitable for the table + overlay.
 *  Amplitudes are computed against a LOCAL pre-burst baseline (mean of
 *  the ~100 ms preceding the burst onset) so they're meaningful regardless
 *  of how the detection baseline was estimated. */
export interface BurstRecord {
  sweepIndex: number
  startS: number
  endS: number
  durationMs: number
  peakAmplitude: number       // |signal − preBurstBaseline| at peak
  peakSigned: number          // signed deviation at peak (+ = upward, − = downward)
  peakTimeS: number
  meanAmplitude: number       // mean |signal − preBurstBaseline| over burst
  integral: number            // ∫ |signal − preBurstBaseline| dt (units · s)
  riseTime10_90Ms: number | null  // time for |dev| to go 10% → 90% of peak
  decayHalfTimeMs: number | null  // time from peak to 50% of peak (descending)
  preBurstBaseline: number    // raw signal level just before the burst
  meanFrequencyHz: number | null  // (# prominent local maxima) / duration
  nSpikes?: number            // ISI method only
}

/** Params the user configured for the last detection run. Stored alongside
 *  the bursts so the table + overlay lines can be interpreted / re-run. */
export interface FieldBurstsParams {
  method: 'threshold' | 'oscillation' | 'isi'
  baseline_mode: 'percentile' | 'robust' | 'rolling' | 'fixed_start'
  // All method-specific params go here in a flat dict.
  [key: string]: number | string | boolean | null | undefined
}

/** Signal-scale diagnostics attached to every burst-detection response.
 *  Useful for understanding why detection returned few/no bursts. */
export interface FieldBurstsDiag {
  median: number
  min: number
  max: number
  mad: number
  maxAbsDev: number
  nSamples: number
  durationS: number
}

/** One row of the I-V analysis table — computed per-sweep. */
export interface IVPoint {
  sweepIndex: number
  stimLevel: number          // mV (VC) or pA (CC)
  baseline: number           // mean of first baseline_window_ms of the sweep
  steadyState: number        // mean of last peak_window_ms of the pulse
  transientPeak: number      // extreme during pulse window
}

/** Which column of the I-V point is plotted on the y-axis. */
export type IVResponseMetric = 'steady' | 'peak'

/** Per-series I-V output, keyed in the store by "group:series". */
export interface IVCurveData {
  channel: number
  stimUnit: string           // mV for VC, pA for CC (x-axis label)
  responseUnit: string       // pA for VC, mV for CC (y-axis label)
  responseMetric: IVResponseMetric
  /** Cursor windows used for the run (seconds from sweep start). */
  baselineStartS: number
  baselineEndS: number
  peakStartS: number
  peakEndS: number
  points: IVPoint[]
  selectedIdx: number | null
}

/** Per-series burst-detection output, keyed in the store by "group:series". */
export interface FieldBurstsData {
  channel: number
  params: FieldBurstsParams
  baselineValue: number
  thresholdHigh: number | null   // baseline + threshold (null for methods where not applicable)
  thresholdLow: number | null    // baseline − threshold
  bursts: BurstRecord[]
  selectedIdx: number | null
  diag?: FieldBurstsDiag         // signal-scale diagnostics (from the latest run)
}

export interface ResistanceResult {
  baseline: number
  peak_current: number
  steady_state_current: number
  rs: number | null
  rin: number | null
  cm?: number | null
  tau?: number | null
  peak_idx?: number
  steady_state_start_idx?: number
  pulse_end_idx?: number
  /** Tag describing where this result came from */
  source?: string
}

interface AppState {
  // Backend connection
  backendUrl: string
  backendReady: boolean
  initBackend: () => Promise<void>

  // File state
  recording: RecordingInfo | null
  currentGroup: number
  currentSeries: number
  currentSweep: number
  currentTrace: number

  // Trace data
  traceData: TraceData | null
  overlayEntries: OverlayEntry[]
  averageTrace: TraceData | null
  showOverlay: boolean
  showAverage: boolean

  // Additional visible channels (beyond traceData, which tracks currentTrace).
  // Keyed by channel index; fetched in parallel when visibility changes.
  additionalTraces: Record<number, TraceData>

  // Per-series set of visible trace indices. The sentinel STIMULUS_TRACE_INDEX
  // (-1) represents the reconstructed stimulus. Keyed by `${group}:${series}`.
  visibleTraces: Record<string, number[]>

  // Per-sweep stimulus segments (fetched on sweep change for overlay)
  sweepStimulusSegments: StimulusSegment[] | null
  sweepStimulusUnit: string

  // Cursors
  cursors: CursorPositions
  cursorVisibility: CursorVisibility

  // Filtering
  filter: FilterState

  // Zero offset subtraction
  zeroOffset: boolean
  // Actual offset value the backend subtracted for the currently-displayed
  // sweep (from `/api/traces/data` response). Zero when zeroOffset is off.
  // Used by burst-marker rendering to place dots at their correct y on an
  // offset-corrected trace (burst records carry raw y values).
  currentZeroOffset: number

  // Continuous-data viewport — null = "full sweep" (show everything).
  viewport: Viewport | null
  // Full duration of the currently displayed sweep in seconds (from backend metadata).
  // Used to size the scroll slider and clamp viewport navigation.
  sweepDuration: number
  // Max number of samples to request in the current fetch (tied to plot width).
  viewportMaxPoints: number

  // Per-series axis ranges (saved when switching away, restored when switching back)
  seriesAxisRanges: Record<string, { x?: { min: number; max: number }; y?: { min: number; max: number } }>

  // Measurements
  results: MeasurementResult[]

  // Resistance analysis
  resistanceResult: ResistanceResult | null
  resistanceMonitor: ResistanceMonitorData | null

  // Field-burst detection, keyed by `${group}:${series}` so markers can
  // persist across series switches.
  fieldBursts: Record<string, FieldBurstsData>

  // I-V curves, keyed by `${group}:${series}` — persists across navigation
  // and is saved per-recording in Electron preferences.
  ivCurves: Record<string, IVCurveData>

  // UI state
  zoomMode: boolean
  showCursors: boolean
  /** Whether burst markers (baseline + threshold lines + per-burst dots)
   *  are drawn on the main TraceViewer overlay. Independent of `showCursors`. */
  showBurstMarkers: boolean
  /** Whether the hover-tooltip showing x/y coordinates is active in the
   *  main TraceViewer. */
  showCoordinates: boolean
  loading: boolean
  error: string | null

  // Actions
  toggleZoomMode: () => void
  toggleCursors: () => void
  toggleBurstMarkers: () => void
  toggleCoordinates: () => void
  resetCursorsToDefaults: () => void
  setCursorVisibility: (v: Partial<CursorVisibility>) => void
  setFilter: (f: Partial<FilterState>) => void
  applyFilter: () => Promise<void>
  toggleZeroOffset: () => void
  // Viewport controls
  setViewport: (viewport: Viewport | null) => void
  setViewportWindowSize: (seconds: number | null) => void  // null = full sweep
  scrollViewport: (deltaSeconds: number) => void
  setViewportStart: (start: number) => void
  setViewportMaxPoints: (n: number) => void
  refetchViewport: () => Promise<void>
  saveSeriesAxisRange: (group: number, series: number, ranges: { x?: { min: number; max: number }; y?: { min: number; max: number } }) => void
  getSeriesAxisRange: (group: number, series: number) => { x?: { min: number; max: number }; y?: { min: number; max: number } } | null
  // Trace visibility controls — per-series.
  getVisibleTraces: (group: number, series: number) => number[]
  setVisibleTraces: (group: number, series: number, indices: number[]) => void
  toggleTraceVisible: (group: number, series: number, index: number) => void
  /** Fetch/drop `additionalTraces` entries so they match `visibleTraces`
   *  for the currently-viewed series. Idempotent; safe to call on every
   *  sweep/viewport/filter change. */
  syncAdditionalTraces: () => Promise<void>
  openFile: (filePath: string) => Promise<void>
  selectSweep: (group: number, series: number, sweep: number, trace?: number) => Promise<void>
  setCursors: (cursors: Partial<CursorPositions>) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  addResult: (result: MeasurementResult) => void
  clearResults: () => void

  // Overlay / average
  toggleOverlay: () => void
  toggleAverage: () => void
  addOverlaySweep: (sweep: number) => Promise<void>
  removeOverlaySweep: (sweep: number) => void
  clearOverlays: () => void
  overlayAllSweeps: () => Promise<void>
  loadAverageTrace: () => Promise<void>

  // Resistance analysis actions
  runResistanceOnSweep: (vStep: number) => Promise<void>
  runResistanceOnAverage: (vStep: number, sweepIndices: number[] | null) => Promise<void>
  loadResistanceMonitor: (vStep: number) => Promise<void>
  clearResistanceResult: () => void

  // Field-burst actions
  /** Run on a single sweep. Result REPLACES any existing bursts for that
   *  (group, series, sweepIndex) triple and APPENDS for new sweep indices. */
  runFieldBurstsOnSweep: (
    group: number, series: number, sweep: number,
    channel: number, params: FieldBurstsParams,
  ) => Promise<void>
  /** Run across every sweep in a series. REPLACES the series's burst table
   *  wholesale. */
  runFieldBurstsOnSeries: (
    group: number, series: number,
    channel: number, params: FieldBurstsParams,
  ) => Promise<void>
  /** Discard bursts for a specific series, or all series if omitted. */
  clearFieldBursts: (group?: number, series?: number) => void
  /** Set the currently-selected burst within a series (for mini-viewer). */
  selectFieldBurst: (group: number, series: number, idx: number | null) => void
  /** Dump the union of all detected bursts across all series to CSV. */
  exportFieldBurstsCSV: () => Promise<void>

  // I-V curve actions
  runIVCurve: (
    group: number, series: number, channel: number,
    params: {
      /** Cursor windows in seconds from sweep start. */
      baselineStartS: number
      baselineEndS: number
      peakStartS: number
      peakEndS: number
      /** Zero-based sweep indices to run on. null = all sweeps. */
      sweepIndices?: number[] | null
      /** When true, merge the returned points into the existing table
       *  (replacing any rows with matching sweepIndex). Used by "single
       *  sweep" mode. When false, the table is replaced outright. */
      appendToExisting?: boolean
    },
  ) => Promise<void>
  clearIVCurve: (group?: number, series?: number) => void
  selectIVPoint: (group: number, series: number, idx: number | null) => void
  setIVResponseMetric: (group: number, series: number, metric: IVResponseMetric) => void
  exportIVCSV: () => Promise<void>
}

const OVERLAY_COLORS = [
  '#64b5f6', '#81c784', '#ffb74d', '#e57373', '#ba68c8',
  '#4dd0e1', '#aed581', '#ffd54f', '#ff8a65', '#ce93d8',
  '#4fc3f7', '#a5d6a7', '#fff176', '#ef9a9a', '#b39ddb',
]

/** Build the query string for trace data, including filter params if enabled.
 *
 * If ``viewport`` is provided, the backend slices to [start, end] seconds and
 * decimates to at most ``maxPoints`` samples. If ``viewport`` is null, the full
 * trace is returned (decimated to maxPoints if > 0).
 *
 * When ``zeroOffset`` is true the backend computes the baseline from the first
 * ~3 ms of the FULL sweep (post-filter, pre-slice) and subtracts it before
 * returning — so the offset is always per-sweep, not per-viewport-window.
 */
function traceDataUrl(
  group: number, series: number, sweep: number, trace: number,
  filter: FilterState,
  viewport: Viewport | null = null,
  maxPoints: number = 0,
  zeroOffset: boolean = false,
): string {
  let url = `/api/traces/data?group=${group}&series=${series}&sweep=${sweep}&trace=${trace}&max_points=${maxPoints}`
  if (viewport) {
    url += `&t_start=${viewport.start}&t_end=${viewport.end}`
  }
  if (filter.enabled) {
    url += `&filter_type=${filter.type}`
    if (filter.type === 'lowpass' || filter.type === 'bandpass') {
      url += `&filter_high=${filter.highCutoff}`
    }
    if (filter.type === 'highpass' || filter.type === 'bandpass') {
      url += `&filter_low=${filter.lowCutoff}`
    }
    url += `&filter_order=${filter.order}`
  }
  if (zeroOffset) {
    url += `&zero_offset=true`
  }
  return url
}

async function apiFetch(backendUrl: string, path: string, options?: RequestInit) {
  const resp = await fetch(`${backendUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }))
    throw new Error(err.detail || resp.statusText)
  }
  return resp.json()
}

export const useAppStore = create<AppState>((set, get) => ({
  backendUrl: '',
  backendReady: false,

  recording: null,
  currentGroup: 0,
  currentSeries: 0,
  currentSweep: 0,
  currentTrace: 0,

  traceData: null,
  overlayEntries: [],
  averageTrace: null,
  showOverlay: false,
  showAverage: false,
  additionalTraces: {},
  visibleTraces: {},

  cursors: {
    baselineStart: 0,
    baselineEnd: 0.01,
    peakStart: 0.01,
    peakEnd: 0.05,
    fitStart: 0.01,
    fitEnd: 0.1,
  },

  sweepStimulusSegments: null,
  sweepStimulusUnit: '',

  cursorVisibility: { baseline: true, peak: true, fit: true },
  filter: { enabled: false, type: 'bandpass', lowCutoff: 1, highCutoff: 50, order: 4 },
  zeroOffset: false,
  currentZeroOffset: 0,
  viewport: null,
  sweepDuration: 0,
  viewportMaxPoints: 5000,
  seriesAxisRanges: {},

  results: [],
  resistanceResult: null,
  resistanceMonitor: null,
  fieldBursts: {},
  ivCurves: {},
  zoomMode: false,
  showCursors: true,
  showBurstMarkers: true,
  showCoordinates: false,
  loading: false,
  error: null,

  toggleZoomMode: () => set((s) => ({ zoomMode: !s.zoomMode })),
  toggleCursors: () => set((s) => ({ showCursors: !s.showCursors })),
  toggleBurstMarkers: () => set((s) => ({ showBurstMarkers: !s.showBurstMarkers })),
  toggleCoordinates: () => set((s) => ({ showCoordinates: !s.showCoordinates })),

  resetCursorsToDefaults: () => {
    const { traceData, sweepDuration, viewport } = get()
    if (!traceData) return
    // In continuous / viewport mode, place cursors relative to the CURRENTLY
    // VISIBLE window so they always land on screen when the user clicks reset.
    // Otherwise use the full sweep duration.
    const start = viewport ? viewport.start : 0
    const end = viewport
      ? viewport.end
      : sweepDuration > 0
        ? sweepDuration
        : traceData.values.length / traceData.samplingRate
    const span = end - start
    set({
      cursors: {
        baselineStart: start,
        baselineEnd: start + 0.2 * span,
        peakStart: start + 0.3 * span,
        peakEnd: start + 0.5 * span,
        fitStart: start + 0.6 * span,
        fitEnd: start + 0.8 * span,
      },
    })
  },

  setCursorVisibility: (v) =>
    set((s) => ({ cursorVisibility: { ...s.cursorVisibility, ...v } })),

  setFilter: (f) => {
    set((s) => ({ filter: { ...s.filter, ...f } }))
    // Re-fetch the current trace with updated filter params (respecting viewport)
    if (get().traceData && get().backendUrl) {
      get().refetchViewport().catch(() => { /* ignore */ })
    }
  },

  applyFilter: async () => {
    const state = get()
    if (state.backendUrl) {
      state.selectSweep(state.currentGroup, state.currentSeries, state.currentSweep, state.currentTrace)
    }
  },

  toggleZeroOffset: () => {
    set((s) => ({ zeroOffset: !s.zeroOffset }))
    // Offset is now computed server-side, so we have to refetch to get the
    // values with/without the baseline subtracted.
    get().refetchViewport().catch(() => { /* ignore */ })
  },

  // ---- Viewport actions ----

  setViewport: (viewport) => {
    // Clamp to the current sweep duration so zoom / Apply / drag-zoom can't
    // push the store into an out-of-bounds state. null means Full mode, left
    // untouched.
    let clamped = viewport
    if (viewport != null) {
      const { sweepDuration } = get()
      if (sweepDuration > 0) {
        let start = Math.max(0, Math.min(viewport.start, sweepDuration))
        let end = Math.max(start, Math.min(viewport.end, sweepDuration))
        // If the window collapsed to a point (zoom-in past data), keep at
        // least a tiny slice so the plot has something to render.
        if (end - start < 1e-6) {
          end = Math.min(sweepDuration, start + Math.max(1e-3, sweepDuration * 1e-4))
          start = Math.max(0, end - 1e-3)
        }
        clamped = { start, end }
      }
    }
    set({ viewport: clamped })
    // Fire-and-forget refetch with the new viewport
    get().refetchViewport().catch(() => { /* ignore */ })
  },

  setViewportWindowSize: (seconds) => {
    const { viewport, sweepDuration } = get()
    if (seconds === null || sweepDuration <= 0) {
      set({ viewport: null })
      get().refetchViewport().catch(() => { /* ignore */ })
      return
    }
    // Preserve current start; clamp end to duration; if window would push past
    // the end, slide it back.
    const start = viewport?.start ?? 0
    let newStart = start
    let newEnd = start + seconds
    if (newEnd > sweepDuration) {
      newEnd = sweepDuration
      newStart = Math.max(0, newEnd - seconds)
    }
    set({ viewport: { start: newStart, end: newEnd } })
    get().refetchViewport().catch(() => { /* ignore */ })
  },

  scrollViewport: (deltaSeconds) => {
    const { viewport, sweepDuration } = get()
    if (!viewport) return
    const len = viewport.end - viewport.start
    let newStart = Math.max(0, Math.min(sweepDuration - len, viewport.start + deltaSeconds))
    if (!isFinite(newStart)) newStart = 0
    set({ viewport: { start: newStart, end: newStart + len } })
    get().refetchViewport().catch(() => { /* ignore */ })
  },

  setViewportStart: (start) => {
    const { viewport, sweepDuration } = get()
    if (!viewport) return
    const len = viewport.end - viewport.start
    const clamped = Math.max(0, Math.min(Math.max(0, sweepDuration - len), start))
    set({ viewport: { start: clamped, end: clamped + len } })
    get().refetchViewport().catch(() => { /* ignore */ })
  },

  setViewportMaxPoints: (n) => {
    const prev = get().viewportMaxPoints
    const clamped = Math.max(500, Math.floor(n))
    if (clamped === prev) return
    set({ viewportMaxPoints: clamped })
  },

  refetchViewport: async () => {
    const {
      backendUrl, currentGroup, currentSeries, currentSweep, currentTrace,
      filter, viewport, viewportMaxPoints, zeroOffset,
    } = get()
    if (!backendUrl) return
    // Increment the sequence — when the response comes back we verify that
    // no newer fetch has been issued meanwhile. This prevents stale slider-
    // drag responses from clobbering the current view.
    const mySeq = ++_viewportFetchSeq
    try {
      const url = traceDataUrl(
        currentGroup, currentSeries, currentSweep, currentTrace,
        filter, viewport, viewportMaxPoints, zeroOffset,
      )
      const data = await apiFetch(backendUrl, url)
      if (mySeq !== _viewportFetchSeq) return  // superseded — drop
      set((s) => ({
        traceData: {
          time: new Float64Array(data.time),
          values: new Float64Array(data.values),
          samplingRate: data.sampling_rate,
          units: data.units,
          label: data.label,
        },
        sweepDuration: data.duration ?? s.sweepDuration,
        currentZeroOffset: Number(data.zero_offset ?? 0),
      }))
      // Keep additional channels in sync with the new viewport/filter.
      get().syncAdditionalTraces().catch(() => { /* ignore */ })
    } catch { /* ignore transient errors */ }
  },

  saveSeriesAxisRange: (group, series, ranges) => {
    const key = `${group}:${series}`
    set((s) => ({
      seriesAxisRanges: { ...s.seriesAxisRanges, [key]: ranges },
    }))
  },

  getSeriesAxisRange: (group, series) => {
    const key = `${group}:${series}`
    return get().seriesAxisRanges[key] ?? null
  },

  // ---- Trace visibility ----

  getVisibleTraces: (group, series) => {
    // Pure read — returns the materialized value or a stable empty array.
    // `selectSweep` materializes defaults for a series on first visit so
    // consumers in render paths get a stable reference.
    const key = `${group}:${series}`
    return get().visibleTraces[key] ?? EMPTY_VISIBLE_TRACES
  },

  setVisibleTraces: (group, series, indices) => {
    const key = `${group}:${series}`
    // Dedupe and sort: recorded channels in natural order, stimulus sentinel at end.
    const recorded = Array.from(new Set(indices.filter((i) => i >= 0))).sort((a, b) => a - b)
    const withStim = indices.includes(STIMULUS_TRACE_INDEX)
      ? [...recorded, STIMULUS_TRACE_INDEX]
      : recorded
    set((s) => ({ visibleTraces: { ...s.visibleTraces, [key]: withStim } }))
    // If this is the currently-viewed series, sync the fetched additional
    // channels (add newly visible, drop newly hidden).
    const { currentGroup, currentSeries } = get()
    if (group === currentGroup && series === currentSeries) {
      get().syncAdditionalTraces().catch(() => { /* ignore */ })
    }
  },

  toggleTraceVisible: (group, series, index) => {
    const current = get().getVisibleTraces(group, series)
    const next = current.includes(index)
      ? current.filter((i) => i !== index)
      : [...current, index]
    get().setVisibleTraces(group, series, next)
  },

  syncAdditionalTraces: async () => {
    // Fetch TraceData for every visible channel that isn't the primary
    // (currentTrace — already held in `traceData`). Drop any that are no
    // longer visible. Fire the fetches in parallel.
    const {
      backendUrl, currentGroup, currentSeries, currentSweep, currentTrace,
      filter, viewport, viewportMaxPoints, zeroOffset,
    } = get()
    if (!backendUrl) return
    const visible = get().getVisibleTraces(currentGroup, currentSeries)
    const wanted = visible.filter((i) => i >= 0 && i !== currentTrace)
    const existing = get().additionalTraces
    // Drop channels no longer wanted.
    const kept: Record<number, TraceData> = {}
    for (const k of Object.keys(existing).map(Number)) {
      if (wanted.includes(k)) kept[k] = existing[k]
    }
    set({ additionalTraces: kept })
    // Fetch the missing ones in parallel.
    const toFetch = wanted.filter((i) => !(i in kept))
    if (toFetch.length === 0) return
    await Promise.all(toFetch.map(async (chIdx) => {
      try {
        const url = traceDataUrl(
          currentGroup, currentSeries, currentSweep, chIdx,
          filter, viewport, viewportMaxPoints, zeroOffset,
        )
        const data = await apiFetch(backendUrl, url)
        // Check still wanted before committing (user may have toggled off meanwhile).
        const stillWanted = get().getVisibleTraces(currentGroup, currentSeries).includes(chIdx)
        if (!stillWanted) return
        set((s) => ({
          additionalTraces: {
            ...s.additionalTraces,
            [chIdx]: {
              time: new Float64Array(data.time),
              values: new Float64Array(data.values),
              samplingRate: data.sampling_rate,
              units: data.units,
              label: data.label,
            },
          },
        }))
      } catch { /* ignore per-channel errors */ }
    }))
  },

  initBackend: async () => {
    try {
      const url = window.electronAPI
        ? await window.electronAPI.getBackendUrl()
        : 'http://localhost:8321'
      set({ backendUrl: url })

      for (let i = 0; i < 60; i++) {
        try {
          await fetch(`${url}/health`)
          set({ backendReady: true })
          console.log('Backend connected at', url)
          return
        } catch {
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      set({ error: 'Backend failed to start' })
    } catch (err) {
      set({ error: `Backend init error: ${err}` })
    }
  },

  openFile: async (filePath) => {
    const { backendUrl } = get()
    set({
      loading: true,
      error: null,
      overlayEntries: [],
      averageTrace: null,
      additionalTraces: {},
      visibleTraces: {},
      fieldBursts: {},
      ivCurves: {},
      showOverlay: false,
      showAverage: false,
      resistanceResult: null,
      resistanceMonitor: null,
    })
    try {
      const recording = await apiFetch(backendUrl, '/api/files/open', {
        method: 'POST',
        body: JSON.stringify({ file_path: filePath }),
      })
      set({
        recording,
        currentGroup: 0,
        currentSeries: 0,
        currentSweep: 0,
        currentTrace: 0,
        loading: false,
      })
      // Restore any bursts previously detected on this recording.
      if (recording?.filePath) {
        const savedBursts = await _loadPersistedBursts(recording.filePath)
        if (savedBursts) {
          set({ fieldBursts: savedBursts })
          // Push to analysis windows if any are open, so they see existing
          // detections without requiring a re-run.
          try {
            const ch = new BroadcastChannel('neurotrace-sync')
            ch.postMessage({ type: 'bursts-update', fieldBursts: savedBursts })
            ch.close()
          } catch { /* ignore */ }
        }
        // Same for I-V curves.
        const savedIV = await _loadPersistedIVCurves(recording.filePath)
        if (savedIV) {
          set({ ivCurves: savedIV })
          try {
            const ch = new BroadcastChannel('neurotrace-sync')
            ch.postMessage({ type: 'iv-update', ivCurves: savedIV })
            ch.close()
          } catch { /* ignore */ }
        }
      }
      await get().selectSweep(0, 0, 0, 0)
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  selectSweep: async (group, series, sweep, trace = 0) => {
    const state = get()
    const { backendUrl, recording } = state
    if (!recording) return

    // Detect whether we're switching to a different series — in that case
    // apply the stimulus-derived cursor defaults (if the new series exposes them).
    const seriesChanged =
      state.traceData == null ||
      state.currentGroup !== group ||
      state.currentSeries !== series

    const newSeries = recording.groups[group]?.series[series]
    const stimulus = newSeries?.stimulus

    const patch: Partial<AppState> = {
      currentGroup: group,
      currentSeries: series,
      currentSweep: sweep,
      currentTrace: trace,
    }

    if (seriesChanged && stimulus) {
      // Snap cursors to the stimulus windows. Keep fit cursors independent.
      patch.cursors = {
        ...state.cursors,
        baselineStart: stimulus.baselineStart,
        baselineEnd: stimulus.baselineEnd,
        peakStart: stimulus.pulseStart,
        peakEnd: stimulus.pulseEnd,
      }
    }

    set(patch)

    try {
      const { filter, viewport: prevViewport, viewportMaxPoints, zeroOffset } = get()
      const sweepChanged =
        seriesChanged || state.currentSweep !== sweep || state.currentTrace !== trace

      // Pick the viewport for THIS fetch:
      // - Same sweep (e.g. cursor drag): keep whatever the user has.
      // - Different sweep: optimistically request [0, DEFAULT] — the backend
      //   clamps to the actual sweep duration, so for short sweeps we get
      //   everything in one round-trip with no waste.
      // This avoids a double-fetch: we don't issue a full-range probe first.
      const viewportForFetch: Viewport | null = sweepChanged
        ? { start: 0, end: DEFAULT_VIEWPORT_SECONDS }
        : prevViewport

      const [traceResp, stimResp] = await Promise.all([
        apiFetch(
          backendUrl,
          traceDataUrl(group, series, sweep, trace, filter, viewportForFetch, viewportMaxPoints, zeroOffset),
        ),
        apiFetch(backendUrl, `/api/traces/stimulus?group=${group}&series=${series}&sweep=${sweep}`).catch(() => null),
      ])

      const duration: number = traceResp.duration ?? 0

      // If the actual sweep is shorter than the default window, there's no
      // viewport to speak of — switch to "Full" mode so the slider/bar know.
      let viewportNow: Viewport | null = viewportForFetch
      if (sweepChanged && duration > 0 && duration <= DEFAULT_VIEWPORT_SECONDS) {
        viewportNow = null
      }

      const updates: Partial<AppState> = {
        traceData: {
          time: new Float64Array(traceResp.time),
          values: new Float64Array(traceResp.values),
          samplingRate: traceResp.sampling_rate,
          units: traceResp.units,
          label: traceResp.label,
        },
        sweepDuration: duration,
        viewport: viewportNow,
        currentZeroOffset: Number(traceResp.zero_offset ?? 0),
      }

      if (stimResp && stimResp.segments?.length > 0) {
        updates.sweepStimulusSegments = stimResp.segments
        updates.sweepStimulusUnit = stimResp.unit || ''
      } else {
        updates.sweepStimulusSegments = null
        updates.sweepStimulusUnit = ''
      }

      // Reset additional channels on sweep/series change so we don't flash
      // stale data while the new fetches are in flight.
      if (sweepChanged) updates.additionalTraces = {}

      // Materialize default trace visibility for the new series if this is
      // the first time we've visited it. Doing this eagerly (instead of
      // computing defaults lazily in `getVisibleTraces`) keeps selector
      // references stable across renders — which is critical, because
      // allocating a fresh default array on every selector call caused the
      // plot-rebuild effect to fire continuously and the trace to flash
      // blank right after loading.
      const vtKey = `${group}:${series}`
      const existingVt = get().visibleTraces
      if (!existingVt[vtKey]) {
        // Default: primary channel only. Stimulus is hidden by default —
        // user opts in from the Traces dropdown when they want it.
        updates.visibleTraces = { ...existingVt, [vtKey]: [trace] }
      }

      set(updates)

      // Now sync any visible additional channels for the new view.
      get().syncAdditionalTraces().catch(() => { /* ignore */ })
    } catch (err: any) {
      set({ error: err.message })
    }
  },

  setCursors: (partial) =>
    set((state) => ({ cursors: { ...state.cursors, ...partial } })),

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  addResult: (result) =>
    set((state) => ({ results: [...state.results, result] })),

  clearResults: () => set({ results: [] }),

  // --- Overlay ---

  toggleOverlay: () => set((s) => ({ showOverlay: !s.showOverlay })),
  toggleAverage: () => set((s) => ({ showAverage: !s.showAverage })),

  addOverlaySweep: async (sweep: number) => {
    const { backendUrl, currentGroup, currentSeries, currentTrace, overlayEntries, filter, viewport, viewportMaxPoints, zeroOffset } = get()
    if (overlayEntries.some((e) => e.sweep === sweep)) return
    try {
      const data = await apiFetch(
        backendUrl,
        traceDataUrl(currentGroup, currentSeries, sweep, currentTrace, filter, viewport, viewportMaxPoints, zeroOffset)
      )
      const color = OVERLAY_COLORS[overlayEntries.length % OVERLAY_COLORS.length]
      set({
        overlayEntries: [
          ...overlayEntries,
          {
            sweep,
            data: {
              time: new Float64Array(data.time),
              values: new Float64Array(data.values),
              samplingRate: data.sampling_rate,
              units: data.units,
              label: `Sweep ${sweep + 1}`,
            },
            color,
          },
        ],
      })
    } catch (err: any) {
      set({ error: err.message })
    }
  },

  removeOverlaySweep: (sweep: number) => {
    set((s) => ({ overlayEntries: s.overlayEntries.filter((e) => e.sweep !== sweep) }))
  },

  clearOverlays: () => set({ overlayEntries: [], showOverlay: false }),

  overlayAllSweeps: async () => {
    const { recording, currentGroup, currentSeries, currentTrace, backendUrl, filter, viewport, viewportMaxPoints, zeroOffset } = get()
    if (!recording) return
    const ser = recording.groups[currentGroup]?.series[currentSeries]
    if (!ser) return

    set({ loading: true })
    const entries: OverlayEntry[] = []
    for (let i = 0; i < ser.sweepCount; i++) {
      try {
        const data = await apiFetch(
          backendUrl,
          traceDataUrl(currentGroup, currentSeries, i, currentTrace, filter, viewport, viewportMaxPoints, zeroOffset)
        )
        entries.push({
          sweep: i,
          data: {
            time: new Float64Array(data.time),
            values: new Float64Array(data.values),
            samplingRate: data.sampling_rate,
            units: data.units,
            label: `Sweep ${i + 1}`,
          },
          color: OVERLAY_COLORS[i % OVERLAY_COLORS.length],
        })
      } catch { /* skip failed sweeps */ }
    }
    set({ overlayEntries: entries, showOverlay: true, loading: false })
  },

  loadAverageTrace: async () => {
    const { backendUrl, currentGroup, currentSeries, currentTrace } = get()
    try {
      const data = await apiFetch(
        backendUrl,
        `/api/traces/average?group=${currentGroup}&series=${currentSeries}&trace=${currentTrace}&max_points=0`
      )
      set({
        averageTrace: {
          time: new Float64Array(data.time),
          values: new Float64Array(data.values),
          samplingRate: data.sampling_rate,
          units: data.units,
          label: data.label,
        },
        showAverage: true,
      })
    } catch (err: any) {
      set({ error: err.message })
    }
  },

  // ---- Resistance analysis ----

  runResistanceOnSweep: async (vStep: number) => {
    const { backendUrl, currentGroup, currentSeries, currentSweep, currentTrace, cursors } = get()
    set({ loading: true, error: null })
    try {
      const resp = await apiFetch(backendUrl, '/api/analysis/run', {
        method: 'POST',
        body: JSON.stringify({
          analysis_type: 'resistance',
          group: currentGroup,
          series: currentSeries,
          sweep: currentSweep,
          trace: currentTrace,
          cursors,
          params: { v_step: vStep },
        }),
      })
      const m = resp.measurement || {}
      set({
        resistanceResult: { ...m, source: `sweep ${currentSweep + 1}` },
        loading: false,
      })
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  runResistanceOnAverage: async (vStep: number, sweepIndices: number[] | null) => {
    const { backendUrl, currentGroup, currentSeries, currentTrace, cursors } = get()
    set({ loading: true, error: null })
    try {
      const resp = await apiFetch(backendUrl, '/api/analysis/run_averaged', {
        method: 'POST',
        body: JSON.stringify({
          analysis_type: 'resistance',
          group: currentGroup,
          series: currentSeries,
          trace: currentTrace,
          sweep_indices: sweepIndices,
          cursors,
          params: { v_step: vStep },
        }),
      })
      const m = resp.measurement || {}
      const n = resp.n_sweeps_averaged ?? 0
      const indices: number[] = resp.sweep_indices ?? []
      let sourceLabel: string
      if (indices.length > 0) {
        const lo = Math.min(...indices) + 1
        const hi = Math.max(...indices) + 1
        sourceLabel = indices.length === hi - lo + 1
          ? `averaged over sweeps ${lo}–${hi}`
          : `averaged over ${n} sweeps`
      } else {
        sourceLabel = `averaged over ${n} sweeps`
      }
      set({
        resistanceResult: { ...m, source: sourceLabel },
        loading: false,
      })
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  loadResistanceMonitor: async (vStep: number) => {
    const { backendUrl, currentGroup, currentSeries, currentTrace, cursors } = get()
    set({ loading: true, error: null })
    try {
      const params = new URLSearchParams({
        group: String(currentGroup),
        series: String(currentSeries),
        trace: String(currentTrace),
        v_step: String(vStep),
        baseline_start: String(cursors.baselineStart),
        baseline_end: String(cursors.baselineEnd),
        peak_start: String(cursors.peakStart),
        peak_end: String(cursors.peakEnd),
      })
      const data = await apiFetch(backendUrl, `/api/resistance/monitor?${params}`)
      set({
        resistanceMonitor: {
          group: currentGroup,
          series: currentSeries,
          trace: currentTrace,
          sweepIndices: data.sweep_indices,
          rs: data.rs,
          rin: data.rin,
          cm: data.cm,
          quality: data.quality,
          maxRsChangePct: data.max_rs_change_pct,
          meanRs: data.mean_rs,
          meanRin: data.mean_rin,
          vStep,
          cursors: { ...cursors },
        },
        loading: false,
      })
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  clearResistanceResult: () => set({ resistanceResult: null }),

  // ---- Field-burst detection ----

  runFieldBurstsOnSweep: async (group, series, sweep, channel, params) => {
    const { backendUrl } = get()
    set({ loading: true, error: null })
    try {
      const resp = await apiFetch(backendUrl, '/api/analysis/run', {
        method: 'POST',
        body: JSON.stringify({
          analysis_type: 'bursts',
          group, series, sweep, trace: channel,
          params,
        }),
      })
      const m = resp.measurement || {}
      if (m.error) {
        set({ error: `Burst detection: ${m.error}`, loading: false })
        return
      }
      const newRecords = burstsFromResponse(m, sweep)
      const key = `${group}:${series}`
      set((s) => {
        const prev = s.fieldBursts[key]
        // Replace existing rows for this sweep; keep rows from other sweeps.
        const kept = (prev?.bursts ?? []).filter((b) => b.sweepIndex !== sweep)
        const merged = [...kept, ...newRecords].sort(
          (a, b) => a.sweepIndex - b.sweepIndex || a.startS - b.startS,
        )
        const next: FieldBurstsData = {
          channel,
          params,
          baselineValue: Number(m.baseline_value ?? 0),
          thresholdHigh: m.threshold_high != null ? Number(m.threshold_high) : null,
          thresholdLow: m.threshold_low != null ? Number(m.threshold_low) : null,
          bursts: merged,
          selectedIdx: null,
          diag: diagFromResponse(m),
        }
        return { fieldBursts: { ...s.fieldBursts, [key]: next }, loading: false }
      })
      _broadcastBursts(get().fieldBursts, params)
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  runFieldBurstsOnSeries: async (group, series, channel, params) => {
    const { backendUrl } = get()
    set({ loading: true, error: null })
    try {
      const resp = await apiFetch(backendUrl, '/api/analysis/batch', {
        method: 'POST',
        body: JSON.stringify({
          analysis_type: 'bursts',
          group, series, trace: channel,
          // sweep_end: -1 tells the backend to use ser.sweep_count, which
          // avoids reading `recording` from this store (it's only populated
          // in the main window — the analysis window has its own instance).
          sweep_start: 0, sweep_end: -1,
          params,
        }),
      })
      const results: any[] = resp.results ?? []
      const allBursts: BurstRecord[] = []
      let baselineValue = 0
      let thresholdHigh: number | null = null
      let thresholdLow: number | null = null
      let diag: FieldBurstsDiag | undefined
      const sweepErrors: string[] = []
      for (const perSweep of results) {
        const sw = Number(perSweep.sweep_index ?? 0)
        if (perSweep.error) {
          sweepErrors.push(`sweep ${sw + 1}: ${perSweep.error}`)
          continue
        }
        allBursts.push(...burstsFromResponse(perSweep, sw))
        // Capture baseline + thresholds from the FIRST sweep's result — they
        // should be comparable across sweeps since params are the same.
        if (perSweep.baseline_value != null && baselineValue === 0) {
          baselineValue = Number(perSweep.baseline_value)
          if (perSweep.threshold_high != null) thresholdHigh = Number(perSweep.threshold_high)
          if (perSweep.threshold_low != null) thresholdLow = Number(perSweep.threshold_low)
          diag = diagFromResponse(perSweep)
        }
      }
      allBursts.sort((a, b) => a.sweepIndex - b.sweepIndex || a.startS - b.startS)
      const key = `${group}:${series}`
      const next: FieldBurstsData = {
        channel,
        params,
        baselineValue,
        thresholdHigh,
        thresholdLow,
        bursts: allBursts,
        selectedIdx: null,
        diag,
      }
      set((s) => ({
        fieldBursts: { ...s.fieldBursts, [key]: next },
        loading: false,
        error: sweepErrors.length > 0 ? sweepErrors.join('; ') : null,
      }))
      _broadcastBursts(get().fieldBursts, params)
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  clearFieldBursts: (group, series) => {
    set((s) => {
      if (group == null || series == null) return { fieldBursts: {} }
      const key = `${group}:${series}`
      const { [key]: _dropped, ...rest } = s.fieldBursts
      return { fieldBursts: rest }
    })
    // Propagate to other windows (main viewer) so markers clear there too.
    try {
      const ch = new BroadcastChannel('neurotrace-sync')
      ch.postMessage({ type: 'bursts-update', fieldBursts: get().fieldBursts })
      ch.close()
    } catch { /* ignore */ }
  },

  selectFieldBurst: (group, series, idx) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.fieldBursts[key]
      if (!entry) return s
      return {
        fieldBursts: {
          ...s.fieldBursts,
          [key]: { ...entry, selectedIdx: idx },
        },
      }
    })
  },

  exportFieldBurstsCSV: async () => {
    const { fieldBursts, recording, backendUrl } = get()
    const keys = Object.keys(fieldBursts)
    if (keys.length === 0) return
    // `recording` is only populated in the main window's store; analysis
    // windows don't carry it. Fall back to querying the backend if we're
    // in the analysis window.
    let fileName: string = recording?.fileName ?? ''
    if (!fileName && backendUrl) {
      try {
        const info = await fetch(`${backendUrl}/api/files/info`).then((r) => r.ok ? r.json() : null)
        if (info?.fileName) fileName = info.fileName
      } catch { /* ignore */ }
    }
    const header = [
      'file', 'group', 'series', 'sweep_index', 'burst_idx',
      'start_s', 'end_s', 'duration_ms',
      'peak_amplitude', 'peak_time_s', 'mean_amplitude',
      'integral', 'rise_time_10_90_ms', 'decay_half_time_ms',
      'pre_burst_baseline',
      'mean_frequency_hz', 'n_spikes',
      'method', 'baseline_mode', 'baseline_value',
      'threshold_high', 'threshold_low',
    ]
    const rows: string[] = [header.join(',')]
    for (const key of keys) {
      const [g, s] = key.split(':').map(Number)
      const entry = fieldBursts[key]
      entry.bursts.forEach((b, i) => {
        rows.push([
          JSON.stringify(fileName),
          g, s, b.sweepIndex, i,
          b.startS.toFixed(6), b.endS.toFixed(6), b.durationMs.toFixed(3),
          b.peakAmplitude.toFixed(4), b.peakTimeS.toFixed(6),
          b.meanAmplitude.toFixed(4), b.integral.toFixed(6),
          b.riseTime10_90Ms != null ? b.riseTime10_90Ms.toFixed(3) : '',
          b.decayHalfTimeMs != null ? b.decayHalfTimeMs.toFixed(3) : '',
          b.preBurstBaseline.toFixed(4),
          b.meanFrequencyHz != null ? b.meanFrequencyHz.toFixed(3) : '',
          b.nSpikes ?? '',
          String(entry.params.method),
          String(entry.params.baseline_mode),
          entry.baselineValue.toFixed(4),
          entry.thresholdHigh != null ? entry.thresholdHigh.toFixed(4) : '',
          entry.thresholdLow != null ? entry.thresholdLow.toFixed(4) : '',
        ].join(','))
      })
    }
    const csv = rows.join('\n')
    const defaultName = (fileName || 'recording').replace(/\.[^.]+$/, '') + '_bursts.csv'
    // Browser-style download works in Electron too and handles the Save dialog
    // via the renderer's built-in download handler.
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = defaultName
    a.click()
    URL.revokeObjectURL(url)
  },

  // ---- I-V curve analysis ----

  runIVCurve: async (group, series, channel, params) => {
    const { backendUrl } = get()
    if (!backendUrl) return
    set({ loading: true, error: null })
    try {
      const qs = new URLSearchParams({
        group: String(group),
        series: String(series),
        trace: String(channel),
        baseline_start_s: String(params.baselineStartS),
        baseline_end_s: String(params.baselineEndS),
        peak_start_s: String(params.peakStartS),
        peak_end_s: String(params.peakEndS),
      })
      if (params.sweepIndices && params.sweepIndices.length > 0) {
        qs.set('sweeps', params.sweepIndices.join(','))
      }
      const resp = await apiFetch(backendUrl, `/api/iv/run?${qs}`)
      const key = `${group}:${series}`
      const existing = get().ivCurves[key]
      const newPoints: IVPoint[] = (resp.points ?? []).map((p: any) => ({
        sweepIndex: Number(p.sweep_index ?? 0),
        stimLevel: Number(p.stim_level ?? 0),
        baseline: Number(p.baseline ?? 0),
        steadyState: Number(p.steady_state ?? 0),
        transientPeak: Number(p.transient_peak ?? 0),
      }))
      // Merge into existing table vs replace — driven by the run mode.
      // "append" (single sweep) keeps older rows from other sweeps and
      // replaces any row for the same sweep. Range + all replace entirely.
      let mergedPoints: IVPoint[] = newPoints
      if (params.appendToExisting && existing) {
        const newSweepSet = new Set(newPoints.map((p) => p.sweepIndex))
        const kept = existing.points.filter((p) => !newSweepSet.has(p.sweepIndex))
        mergedPoints = [...kept, ...newPoints].sort((a, b) => a.stimLevel - b.stimLevel)
      }
      const next: IVCurveData = {
        channel,
        stimUnit: String(resp.stim_unit ?? existing?.stimUnit ?? ''),
        responseUnit: String(resp.response_unit ?? existing?.responseUnit ?? ''),
        responseMetric: (existing?.responseMetric ?? 'steady') as IVResponseMetric,
        baselineStartS: params.baselineStartS,
        baselineEndS: params.baselineEndS,
        peakStartS: params.peakStartS,
        peakEndS: params.peakEndS,
        points: mergedPoints,
        selectedIdx: null,
      }
      set((s) => ({ ivCurves: { ...s.ivCurves, [key]: next }, loading: false }))
      _broadcastIVCurves(get().ivCurves)
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  clearIVCurve: (group, series) => {
    set((s) => {
      if (group == null || series == null) return { ivCurves: {} }
      const key = `${group}:${series}`
      const { [key]: _dropped, ...rest } = s.ivCurves
      return { ivCurves: rest }
    })
    _broadcastIVCurves(get().ivCurves)
  },

  selectIVPoint: (group, series, idx) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.ivCurves[key]
      if (!entry) return s
      return {
        ivCurves: {
          ...s.ivCurves,
          [key]: { ...entry, selectedIdx: idx },
        },
      }
    })
  },

  setIVResponseMetric: (group, series, metric) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.ivCurves[key]
      if (!entry) return s
      return {
        ivCurves: {
          ...s.ivCurves,
          [key]: { ...entry, responseMetric: metric },
        },
      }
    })
    _broadcastIVCurves(get().ivCurves)
  },

  exportIVCSV: async () => {
    const { ivCurves, recording, backendUrl } = get()
    const keys = Object.keys(ivCurves)
    if (keys.length === 0) return
    let fileName: string = recording?.fileName ?? ''
    if (!fileName && backendUrl) {
      try {
        const info = await fetch(`${backendUrl}/api/files/info`).then((r) => r.ok ? r.json() : null)
        if (info?.fileName) fileName = info.fileName
      } catch { /* ignore */ }
    }
    const header = [
      'file', 'group', 'series', 'sweep_index',
      'stim_level', 'stim_unit',
      'baseline', 'steady_state', 'transient_peak',
      'response_metric', 'response', 'response_unit',
    ]
    const rows: string[] = [header.join(',')]
    for (const key of keys) {
      const [g, s] = key.split(':').map(Number)
      const entry = ivCurves[key]
      entry.points.forEach((p) => {
        const resp = entry.responseMetric === 'peak'
          ? p.transientPeak - p.baseline
          : p.steadyState - p.baseline
        rows.push([
          JSON.stringify(fileName),
          g, s, p.sweepIndex,
          p.stimLevel.toFixed(4),
          JSON.stringify(entry.stimUnit),
          p.baseline.toFixed(4),
          p.steadyState.toFixed(4),
          p.transientPeak.toFixed(4),
          entry.responseMetric,
          resp.toFixed(4),
          JSON.stringify(entry.responseUnit),
        ].join(','))
      })
    }
    const csv = rows.join('\n')
    const defaultName = (fileName || 'recording').replace(/\.[^.]+$/, '') + '_iv.csv'
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = defaultName
    a.click()
    URL.revokeObjectURL(url)
  },
}))

/** Normalize a single-sweep burst-detector response into BurstRecord[]. */
function burstsFromResponse(m: any, sweepIndex: number): BurstRecord[] {
  const bursts: any[] = m.bursts ?? []
  return bursts.map((b) => ({
    sweepIndex,
    startS: Number(b.start_s ?? 0),
    endS: Number(b.end_s ?? 0),
    durationMs: Number(b.duration_ms ?? 0),
    peakAmplitude: Number(b.peak_amplitude ?? 0),
    peakSigned: Number(b.peak_signed ?? b.peak_amplitude ?? 0),
    peakTimeS: Number(b.peak_time_s ?? 0),
    meanAmplitude: Number(b.mean_amplitude ?? 0),
    integral: Number(b.integral ?? 0),
    riseTime10_90Ms: b.rise_time_10_90_ms != null ? Number(b.rise_time_10_90_ms) : null,
    decayHalfTimeMs: b.decay_half_time_ms != null ? Number(b.decay_half_time_ms) : null,
    preBurstBaseline: Number(b.pre_burst_baseline ?? 0),
    meanFrequencyHz: b.mean_frequency_hz != null ? Number(b.mean_frequency_hz) : null,
    nSpikes: b.n_spikes != null ? Number(b.n_spikes) : undefined,
  }))
}

/** Pull the signal-scale diagnostics block out of a detection response. */
function diagFromResponse(m: any): FieldBurstsDiag | undefined {
  const d = m.signal_diag
  if (!d) return undefined
  return {
    median: Number(d.median ?? 0),
    min: Number(d.min ?? 0),
    max: Number(d.max ?? 0),
    mad: Number(d.mad ?? 0),
    maxAbsDev: Number(d.max_abs_dev ?? 0),
    nSamples: Number(d.n_samples ?? 0),
    durationS: Number(d.duration_s ?? 0),
  }
}

// Persist fieldBursts to electron preferences whenever they change, keyed
// by the current recording's filePath. Runs in any window, but the analysis
// window has `recording: null` so it's effectively a no-op there — only the
// main window actually writes. Runs once on module load per window.
let _lastPersistedBurstsRef: Record<string, FieldBurstsData> | null = null
useAppStore.subscribe((state) => {
  if (state.fieldBursts === _lastPersistedBurstsRef) return
  _lastPersistedBurstsRef = state.fieldBursts
  if (state.recording?.filePath) {
    _savePersistedBursts(state.recording.filePath, state.fieldBursts)
  }
})

// Same pattern for I-V curves.
let _lastPersistedIVRef: Record<string, IVCurveData> | null = null
useAppStore.subscribe((state) => {
  if (state.ivCurves === _lastPersistedIVRef) return
  _lastPersistedIVRef = state.ivCurves
  if (state.recording?.filePath) {
    _savePersistedIVCurves(state.recording.filePath, state.ivCurves)
  }
})

declare global {
  interface Window {
    electronAPI?: {
      syncPreferences: Record<string, unknown>
      getBackendUrl: () => Promise<string>
      openFileDialog: () => Promise<string | null>
      saveFileDialog: (defaultName: string, filters?: { name: string; extensions: string[] }[]) => Promise<string | null>
      getPreferences: () => Promise<Record<string, unknown>>
      setPreferences: (prefs: Record<string, unknown>) => Promise<boolean>
      openAnalysisWindow: (type: string) => Promise<boolean>
      closeAnalysisWindow: (type: string) => Promise<boolean>
      getOpenAnalysisWindows: () => Promise<string[]>
      onAnalysisWindowClosed: (callback: (type: string) => void) => () => void
    }
  }
}
