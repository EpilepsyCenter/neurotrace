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

/** Persist/restore the burst-detection *form* state (method, baseline
 *  mode, and parameter dict) per-series within a recording. Separate
 *  from the run results in `savedFieldBursts` so the user's param
 *  tweaks survive even if they close the window without running
 *  detection. Keyed filePath → "g:s" → FieldBurstsParams. */
async function _loadPersistedBurstFormParams(
  filePath: string,
): Promise<Record<string, FieldBurstsParams> | null> {
  const api = window.electronAPI
  if (!api?.getPreferences || !filePath) return null
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = prefs.savedBurstFormParams as Record<string, any> | undefined
    return store?.[filePath] ?? null
  } catch {
    return null
  }
}

async function _savePersistedBurstFormParams(
  filePath: string,
  formParams: Record<string, FieldBurstsParams>,
) {
  const api = window.electronAPI
  if (!api?.getPreferences || !api?.setPreferences || !filePath) return
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = (prefs.savedBurstFormParams as Record<string, any>) ?? {}
    if (Object.keys(formParams).length === 0) {
      delete store[filePath]
    } else {
      store[filePath] = formParams
    }
    await api.setPreferences({ ...prefs, savedBurstFormParams: store })
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

/** Load/save fPSP data per-recording via Electron preferences. */
/** Migrate FPsp entries saved before the I-O/PPR/LTP tab bar landed.
 *  Old keys were `"${group}:${series}"` (two parts); new keys are
 *  `"${group}:${series}:${mode}"` (three parts). Old entries also
 *  lacked a `mode` field. Treat anything missing both as LTP.
 *  Idempotent: a pass over an already-migrated map returns it as-is. */
function _migrateFPspCurves(raw: Record<string, any>): Record<string, FPspData> {
  const out: Record<string, FPspData> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object') continue
    const parts = k.split(':')
    if (parts.length === 3) {
      out[k] = { ...v, mode: v.mode ?? (parts[2] as FPspMode) }
    } else if (parts.length === 2) {
      // Legacy pre-tab-bar entry.
      out[`${k}:ltp`] = { ...v, mode: 'ltp' }
    } else {
      // Unrecognised — drop it rather than corrupt the state.
    }
  }
  return out
}

async function _loadPersistedFPsp(filePath: string): Promise<Record<string, FPspData> | null> {
  const api = window.electronAPI
  if (!api?.getPreferences || !filePath) return null
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = prefs.savedFPspCurves as Record<string, any> | undefined
    const raw = store?.[filePath]
    return raw ? _migrateFPspCurves(raw) : null
  } catch {
    return null
  }
}

async function _savePersistedFPsp(filePath: string, fpspCurves: Record<string, FPspData>) {
  const api = window.electronAPI
  if (!api?.getPreferences || !api?.setPreferences || !filePath) return
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = (prefs.savedFPspCurves as Record<string, any>) ?? {}
    if (Object.keys(fpspCurves).length === 0) {
      delete store[filePath]
    } else {
      store[filePath] = fpspCurves
    }
    await api.setPreferences({ ...prefs, savedFPspCurves: store })
  } catch { /* ignore */ }
}

function _broadcastFPsp(fpspCurves: Record<string, FPspData>) {
  try {
    const ch = new BroadcastChannel('neurotrace-sync')
    ch.postMessage({ type: 'fpsp-update', fpspCurves })
    ch.close()
  } catch { /* ignore */ }
}

/** Cursor-analysis persistence — one state blob per recording. */
async function _loadPersistedCursors(filePath: string): Promise<Record<string, CursorAnalysisData> | null> {
  const api = window.electronAPI
  if (!api?.getPreferences || !filePath) return null
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = prefs.savedCursorAnalyses as Record<string, any> | undefined
    return store?.[filePath] ?? null
  } catch {
    return null
  }
}

async function _savePersistedCursors(filePath: string, analyses: Record<string, CursorAnalysisData>) {
  const api = window.electronAPI
  if (!api?.getPreferences || !api?.setPreferences || !filePath) return
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = (prefs.savedCursorAnalyses as Record<string, any>) ?? {}
    if (Object.keys(analyses).length === 0) {
      delete store[filePath]
    } else {
      store[filePath] = analyses
    }
    await api.setPreferences({ ...prefs, savedCursorAnalyses: store })
  } catch { /* ignore */ }
}

function _broadcastCursorAnalyses(cursorAnalyses: Record<string, CursorAnalysisData>) {
  try {
    const ch = new BroadcastChannel('neurotrace-sync')
    ch.postMessage({ type: 'cursor-analyses-update', cursorAnalyses })
    ch.close()
  } catch { /* ignore */ }
}

/** Excluded-sweeps persistence — same per-recording pattern as the
 *  other analysis slices. Stored as nested dict keyed by file path,
 *  with each file's value being `Record<"g:s", number[]>`. */
async function _loadPersistedExcluded(filePath: string): Promise<Record<string, number[]> | null> {
  const api = window.electronAPI
  if (!api?.getPreferences || !filePath) return null
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = prefs.savedExcludedSweeps as Record<string, any> | undefined
    return store?.[filePath] ?? null
  } catch {
    return null
  }
}

async function _savePersistedExcluded(filePath: string, excluded: Record<string, number[]>) {
  const api = window.electronAPI
  if (!api?.getPreferences || !api?.setPreferences || !filePath) return
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = (prefs.savedExcludedSweeps as Record<string, any>) ?? {}
    if (Object.keys(excluded).length === 0) {
      delete store[filePath]
    } else {
      store[filePath] = excluded
    }
    await api.setPreferences({ ...prefs, savedExcludedSweeps: store })
  } catch { /* ignore */ }
}

function _broadcastExcludedSweeps(excludedSweeps: Record<string, number[]>) {
  try {
    const ch = new BroadcastChannel('neurotrace-sync')
    ch.postMessage({ type: 'excluded-update', excludedSweeps })
    ch.close()
  } catch { /* ignore */ }
}

/** Averaged-sweep persistence — same per-recording pattern as the
 *  other analysis slices. Stored under `savedAveragedSweeps[filePath]`
 *  in Electron prefs. Value shape: `Record<"g:s", AveragedSweep[]>`. */
async function _loadPersistedAveraged(filePath: string): Promise<Record<string, AveragedSweep[]> | null> {
  const api = window.electronAPI
  if (!api?.getPreferences || !filePath) return null
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = prefs.savedAveragedSweeps as Record<string, any> | undefined
    return store?.[filePath] ?? null
  } catch {
    return null
  }
}

async function _savePersistedAveraged(filePath: string, averaged: Record<string, AveragedSweep[]>) {
  const api = window.electronAPI
  if (!api?.getPreferences || !api?.setPreferences || !filePath) return
  try {
    const prefs = (await api.getPreferences()) ?? {}
    const store = (prefs.savedAveragedSweeps as Record<string, any>) ?? {}
    if (Object.keys(averaged).length === 0) {
      delete store[filePath]
    } else {
      store[filePath] = averaged
    }
    await api.setPreferences({ ...prefs, savedAveragedSweeps: store })
  } catch { /* ignore */ }
}

function _broadcastAveragedSweeps(averagedSweeps: Record<string, AveragedSweep[]>) {
  try {
    const ch = new BroadcastChannel('neurotrace-sync')
    ch.postMessage({ type: 'averaged-update', averagedSweeps })
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

/** Broadcast the per-series burst-detection form state so every open
 *  window (including the main window, which owns persistence) stays in
 *  sync. The main window's CursorPanel listener adopts the payload into
 *  its store; the disk-persistence subscribe then writes to Electron
 *  prefs. Without this round-trip, the analysis window's updates would
 *  never reach disk. */
function _broadcastBurstFormParams(
  burstFormParams: Record<string, FieldBurstsParams>,
) {
  try {
    const ch = new BroadcastChannel('neurotrace-sync')
    ch.postMessage({ type: 'burst-form-params-update', burstFormParams })
    ch.close()
  } catch { /* ignore */ }
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
  /** True when the user added this burst manually via the sweep viewer
   *  (left-click) rather than auto-detection. Drives italic row styling
   *  + a ring around the peak dot. */
  manual?: boolean
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

// ---- Field PSP (fEPSP + fiber-volley) analysis ----

export type FPspMeasurementMethod = 'amplitude' | 'full_slope' | 'range_slope'
export type FPspPeakDirection = 'auto' | 'negative' | 'positive'
export type FPspTimeAxis = 'timestamp' | 'index'

/** Which flavour of fPSP analysis an FPspData entry holds. All three
 *  modes share the same per-sweep measurement machinery (slope, amp,
 *  baseline, volley/fEPSP values) — they differ only in how the result
 *  table is presented and which axis is used in the secondary plot. */
export type FPspMode = 'io' | 'ppr' | 'ltp'

export interface FPspPoint {
  sourceSeries: number       // which series index this bin came from
  binIndex: number           // index WITHIN its source series (0-based)
  sweepIndices: number[]
  meanSweepIndex: number
  baseline: number
  volleyPeak: number
  volleyPeakTs: number
  volleyAmp: number
  fepspPeak: number
  fepspPeakTs: number
  fepspAmp: number
  slope: number | null
  slopeLow: { t: number; v: number } | null
  slopeHigh: { t: number; v: number } | null
  ratio: number | null
  flagged: boolean
  // ---- PPR mode only: second response + paired-pulse ratios ----
  // Populated when the run was in PPR mode (two fEPSP windows per
  // sweep). Undefined in I-O / LTP entries. Ratios are
  // second/first, so a PPR < 1 means synaptic depression and > 1
  // means facilitation.
  volleyPeak2?: number
  volleyPeakTs2?: number
  volleyAmp2?: number
  fepspPeak2?: number
  fepspPeakTs2?: number
  fepspAmp2?: number
  slope2?: number | null
  slopeLow2?: { t: number; v: number } | null
  slopeHigh2?: { t: number; v: number } | null
  pprAmp?: number | null      // fepspAmp2 / fepspAmp
  pprSlope?: number | null    // slope2 / slope (both in |abs| terms)
}

export interface FPspData {
  /** Which tab this entry was produced from. Distinguishes I-O / PPR
   *  / LTP runs that may coexist for the same (group, series). Defaults
   *  to 'ltp' when absent for backward-compat with pre-tab-bar saves. */
  mode: FPspMode
  channel: number
  responseUnit: string
  /** Primary ("baseline") series index in the file. */
  seriesA: number
  /** Optional second ("LTP" / post-tetanus) series index. Only used
   *  in LTP mode. */
  seriesB: number | null
  stimOnsetS: number
  /** Inter-sweep intervals (seconds) parsed from .pgf for each series.
   *  0 means unknown — the graph then falls back to sweep-index-based x. */
  sweepIntervalA: number
  sweepIntervalB: number
  measurementMethod: FPspMeasurementMethod
  slopeLowPct: number
  slopeHighPct: number
  peakDirection: FPspPeakDirection
  avgN: number
  /** Pre-detection filter used for the run (echoed back so the mini-
   *  viewer can fetch the same filtered waveform). */
  filterEnabled: boolean
  filterType: 'lowpass' | 'highpass' | 'bandpass'
  filterLow: number
  filterHigh: number
  filterOrder: number
  /** Cursor positions at the time of the run (seconds). Echoed so the
   *  mini-viewer and table summary can refer back to them. */
  baselineStartS: number
  baselineEndS: number
  volleyStartS: number
  volleyEndS: number
  fepspStartS: number
  fepspEndS: number
  /** UI-only settings persisted with the entry. */
  timeAxis: FPspTimeAxis
  normalize: boolean
  normBaselineFrom: number   // 1-based bin index, inclusive (across the
  normBaselineTo: number     //   concatenated points list)
  points: FPspPoint[]
  selectedIdx: number | null
  /** I-O mode only: echoed back so the results table and scatter plot
   *  can label points with their stimulus intensity. Each point's
   *  intensity is computed as `ioInitialIntensity + sweepIndex * ioIntensityStep`
   *  on the frontend (preserves intensity alignment across excluded sweeps). */
  ioInitialIntensity?: number
  ioIntensityStep?: number
  /** Unit shown on the intensity axis (µA by default). Not converted
   *  — purely a label attached to the user's own input. */
  ioUnit?: string
  /** Which metric drives the I-O scatter's y-axis: slope (default) or
   *  amplitude. User-togglable; persisted with the entry. */
  ioMetric?: 'slope' | 'amplitude'
  // ---- PPR mode only ----
  /** Cursor window for the 2nd response's volley / fEPSP. The
   *  baseline window is shared with the 1st response (field above). */
  volley2StartS?: number
  volley2EndS?: number
  fepsp2StartS?: number
  fepsp2EndS?: number
  /** Inter-stimulus interval used for the last "Place V2/F2 from ISI"
   *  action. Persisted so the control retains the last-used value
   *  when the window reopens. */
  pprIsiMs?: number
  /** Whether the PPR over-time scatter shows amp-ratio or slope-ratio. */
  pprMetric?: 'amp' | 'slope'
}

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

/** Cursor-analysis types: one state blob per recording, mirroring the
 *  pattern used by ivCurves / fpspCurves / fieldBursts. */
export interface CursorSlotConfig {
  enabled: boolean
  peak: { start: number; end: number }
  fit: { start: number; end: number } | null
  fitFunction: string | null
  fitOptions: {
    maxfev?: number
    ftol?: number
    xtol?: number
    /** Per-parameter initial-guess override. null/undefined = auto. */
    initialGuess?: Record<string, number | null>
  } | null
}

export interface CursorMeasurement {
  slot: number
  sweep: number                           // -1 for the averaged trace
  baseline: number
  baseline_sd: number
  peak: number
  peak_time: number
  amplitude: number
  time_to_peak?: number
  rise_time_10_90?: number
  rise_time_20_80?: number
  half_width?: number
  max_slope_rise?: number
  max_slope_decay?: number
  rise_decay_ratio?: number
  area?: number
  ap_threshold?: number
  ap_threshold_time?: number
  fit?: {
    function: string
    params: Record<string, number>
    rss: number
    r_squared: number
    fit_time: number[]
    fit_values: number[]
  } | null
}

export interface CursorAnalysisData {
  group: number
  series: number
  trace: number
  slotCount: number                       // 1..10 — number of visible slots
  baseline: { start: number; end: number }
  baselineMethod: 'mean' | 'median'
  computeAP: boolean
  apSlope: number
  slots: CursorSlotConfig[]               // always length 10 (unused ones are disabled)
  runMode: 'all' | 'range' | 'one'
  sweepFrom: number
  sweepTo: number
  sweepOne: number
  average: boolean
  measurements: CursorMeasurement[]
  traceUnit: string
}

export interface CursorWindowUI {
  plotHeight: number
  measurementColumns: string[]            // visible-column IDs for the Measurements tab
  fitColumns: string[]                    // visible-column IDs for the Fit tab
  activeTab: 'measurements' | 'fit'
}

/** User-created averaged trace that shows up in the TreeNavigator as
 *  a virtual sweep. Time/values are stored at full resolution so the
 *  plot can resample to whatever max_points the viewer needs. */
export interface AveragedSweep {
  id: string                   // stable unique key (e.g. "avg-<ms>-<rand>")
  group: number
  series: number
  trace: number
  sourceSweepIndices: number[] // 0-based indices of the sweeps averaged
  label: string
  time: number[]
  values: number[]
  samplingRate: number
  units: string
  createdAt: number            // epoch ms
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
  seriesAxisRanges: Record<string, {
    x?: { min: number; max: number }
    y?: { min: number; max: number }
    stim?: { min: number; max: number }
  }>

  // Measurements
  results: MeasurementResult[]

  // Resistance analysis
  resistanceResult: ResistanceResult | null
  resistanceMonitor: ResistanceMonitorData | null

  // Field-burst detection, keyed by `${group}:${series}` so markers can
  // persist across series switches.
  fieldBursts: Record<string, FieldBurstsData>

  /** Per-series burst-detection *form* state (method, baseline mode,
   *  all numeric params, filter fields). Survives window close even if
   *  the user never clicked Run. Keyed by `${group}:${series}`;
   *  persisted per-recording in Electron prefs as `savedBurstFormParams`. */
  burstFormParams: Record<string, FieldBurstsParams>

  // I-V curves, keyed by `${group}:${series}` — persists across navigation
  // and is saved per-recording in Electron preferences.
  ivCurves: Record<string, IVCurveData>

  // Field PSP analyses, same key shape + same persistence pattern.
  fpspCurves: Record<string, FPspData>

  // Cursor analyses — at most one blob per recording (keyed by filePath).
  // Contains the full slot configuration plus the last run's measurements,
  // so reopening the window on the same file restores the previous state.
  cursorAnalyses: Record<string, CursorAnalysisData>
  /** Global (per-user, not per-file) UI prefs for the cursor window:
   *  splitter position, visible columns per tab, active tab. */
  cursorWindowUI: CursorWindowUI

  /** Per-series set of excluded sweep indices. Keyed by "group:series".
   *  Stored as a sorted array (JSON-serializable) rather than a Set so
   *  it round-trips through Electron prefs and BroadcastChannel cleanly.
   *  Excluded sweeps are dropped from EVERY analysis and from the main
   *  viewer's "Show average" — they're not deleted from disk, just
   *  filtered out of any batch processing. */
  excludedSweeps: Record<string, number[]>

  /** Per-series session-only multi-selection in the tree. Drives the
   *  "Average → Selected" mode and any future multi-sweep actions.
   *  NOT persisted. Cleared when switching series. */
  selectedSweeps: Record<string, number[]>

  /** Per-series user-created averaged traces that show up in the tree
   *  as virtual sweeps. Persisted per-file in Electron prefs. Users
   *  can navigate to them like real sweeps; they're NOT targets for
   *  analyses (analysis windows have their own in-built averaging). */
  averagedSweeps: Record<string, AveragedSweep[]>

  /** Navigation pointer into `averagedSweeps` for the CURRENTLY-VIEWED
   *  averaged sweep, or null if a real sweep is on screen. When
   *  non-null, TraceViewer sources its trace data from the stored
   *  AveragedSweep rather than hitting the backend. */
  currentAveragedSweep: { group: number; series: number; id: string } | null

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
  saveSeriesAxisRange: (group: number, series: number, ranges: {
    x?: { min: number; max: number }
    y?: { min: number; max: number }
    stim?: { min: number; max: number }
  }) => void
  getSeriesAxisRange: (group: number, series: number) => {
    x?: { min: number; max: number }
    y?: { min: number; max: number }
    stim?: { min: number; max: number }
  } | null
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

  // Excluded-sweep controls (see `excludedSweeps` slice above).
  toggleSweepExcluded: (group: number, series: number, sweep: number) => void
  clearExcludedSweeps: (group: number, series: number) => void
  isSweepExcluded: (group: number, series: number, sweep: number) => boolean
  /** Returns the list of sweep indices in [0, totalSweeps) that are NOT
   *  in the excluded set for (group, series). Use this wherever a
   *  "run on all sweeps" call would previously pass null / undefined —
   *  send the explicit complement list instead so excluded sweeps
   *  never reach the backend. */
  includedSweepsFor: (group: number, series: number, totalSweeps: number) => number[]
  /** Same but applied to a caller-supplied list (e.g. a user-selected
   *  range). Filters out any entries that are in the excluded set. */
  filterExcludedSweeps: (group: number, series: number, sweeps: number[]) => number[]

  // Multi-selection in the tree (session-only, per series).
  handleSweepSelection: (
    group: number, series: number, sweep: number,
    modifier: 'shift' | 'cmd' | 'none',
  ) => void
  clearSweepSelection: (group: number, series: number) => void
  isSweepSelected: (group: number, series: number, sweep: number) => boolean

  // Averaged virtual-sweep actions.
  createAveragedSweep: (
    group: number, series: number, trace: number,
    sweepIndices: number[], label?: string,
  ) => Promise<string | null>
  deleteAveragedSweep: (group: number, series: number, id: string) => void
  renameAveragedSweep: (group: number, series: number, id: string, label: string) => void
  /** Navigate to an averaged sweep — puts its values into the
   *  TraceViewer and flips currentAveragedSweep to track it. */
  selectAveragedSweep: (group: number, series: number, id: string) => void

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
  /** Append a manually-measured burst (from a left-click in the sweep
   *  viewer). The burst is pre-populated by the backend; we just
   *  splice it into the current list, sort, and broadcast. */
  addManualBurst: (group: number, series: number, burst: BurstRecord) => void
  /** Remove the burst whose span contains `timeS` on the given sweep.
   *  If multiple match, removes the one whose peak is closest in time.
   *  No-op when nothing matches. */
  removeBurstAt: (group: number, series: number, sweep: number, timeS: number) => void
  /** Store the burst-detection form state for a given series so the
   *  window can restore it after close/reopen. Broadcast + persisted. */
  setBurstFormParams: (group: number, series: number, params: FieldBurstsParams) => void

  // Field PSP actions
  runFPsp: (
    group: number, series: number, channel: number,
    params: {
      /** Which tab the run was triggered from. Defaults to 'ltp' for
       *  back-compat. The mode determines which slot the result lands
       *  in (keyed `${group}:${series}:${mode}`) and how the window
       *  renders the output. */
      mode?: FPspMode
      /** Optional second (LTP) series in the same group. */
      seriesB?: number | null
      baselineStartS: number
      baselineEndS: number
      volleyStartS: number
      volleyEndS: number
      fepspStartS: number
      fepspEndS: number
      method: FPspMeasurementMethod
      slopeLowPct: number
      slopeHighPct: number
      peakDirection: FPspPeakDirection
      avgN: number
      sweepIndices?: number[] | null
      appendToExisting?: boolean
      /** Pre-detection filter applied per sweep before averaging. */
      filterEnabled?: boolean
      filterType?: 'lowpass' | 'highpass' | 'bandpass'
      filterLow?: number
      filterHigh?: number
      filterOrder?: number
      /** I-O mode only — stored on the entry for display. */
      ioInitialIntensity?: number
      ioIntensityStep?: number
      ioUnit?: string
      ioMetric?: 'slope' | 'amplitude'
      /** PPR mode only — 2nd response cursor windows. When mode is
       *  'ppr' the run fires two parallel `/api/fpsp/run` requests
       *  (one with V1/F1, one with V2/F2) and merges the points
       *  frontend-side into a single entry with ratios computed. */
      volley2StartS?: number
      volley2EndS?: number
      fepsp2StartS?: number
      fepsp2EndS?: number
      pprIsiMs?: number
      pprMetric?: 'amp' | 'slope'
    },
  ) => Promise<void>
  clearFPsp: (mode: FPspMode, group?: number, series?: number) => void
  selectFPspPoint: (mode: FPspMode, group: number, series: number, idx: number | null) => void
  setFPspTimeAxis: (mode: FPspMode, group: number, series: number, axis: FPspTimeAxis) => void
  setFPspNormalize: (mode: FPspMode, group: number, series: number, normalize: boolean) => void
  setFPspNormBaseline: (mode: FPspMode, group: number, series: number, from: number, to: number) => void
  exportFPspCSV: () => Promise<void>

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
      /** When true, the backend skips the .pgf stimulus lookup and
       *  reconstructs Im per sweep from the four manual params below. */
      manualImEnabled?: boolean
      manualImStartS?: number
      manualImEndS?: number
      manualImStartPA?: number
      manualImStepPA?: number
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
  burstFormParams: {},
  ivCurves: {},
  fpspCurves: {},
  cursorAnalyses: {},
  excludedSweeps: {},
  selectedSweeps: {},
  averagedSweeps: {},
  currentAveragedSweep: null,
  cursorWindowUI: (() => {
    const defaults: CursorWindowUI = {
      plotHeight: 220,
      measurementColumns: [
        'sweep', 'slot', 'baseline', 'peak', 'amplitude', 'peak_time',
        'rise_time_20_80', 'half_width', 'area',
      ],
      fitColumns: ['sweep', 'slot', 'fit_function', 'r_squared', 'params'],
      activeTab: 'measurements',
    }
    try {
      const saved = (window as any).electronAPI?.syncPreferences?.cursorWindowUI
      if (saved && typeof saved === 'object') return { ...defaults, ...saved }
    } catch { /* ignore */ }
    return defaults
  })(),
  zoomMode: false,
  // Cursors default OFF so the main viewer stays clean on first open;
  // the user turns them on from the right panel when they need them.
  showCursors: false,
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
      burstFormParams: {},
      ivCurves: {},
      fpspCurves: {},
      cursorAnalyses: {},
      excludedSweeps: {},
      selectedSweeps: {},
      averagedSweeps: {},
      currentAveragedSweep: null,
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
        // Burst-detection form state (survives window close even without
        // a Run). Keyed by "g:s" per recording.
        const savedBurstForm = await _loadPersistedBurstFormParams(recording.filePath)
        if (savedBurstForm) {
          set({ burstFormParams: savedBurstForm })
          try {
            const ch = new BroadcastChannel('neurotrace-sync')
            ch.postMessage({ type: 'burst-form-params-update', burstFormParams: savedBurstForm })
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
        // fPSP curves.
        const savedFPsp = await _loadPersistedFPsp(recording.filePath)
        if (savedFPsp) {
          set({ fpspCurves: savedFPsp })
          try {
            const ch = new BroadcastChannel('neurotrace-sync')
            ch.postMessage({ type: 'fpsp-update', fpspCurves: savedFPsp })
            ch.close()
          } catch { /* ignore */ }
        }
        // Cursor analyses.
        const savedCursor = await _loadPersistedCursors(recording.filePath)
        if (savedCursor) {
          set({ cursorAnalyses: savedCursor })
          try {
            const ch = new BroadcastChannel('neurotrace-sync')
            ch.postMessage({ type: 'cursor-analyses-update', cursorAnalyses: savedCursor })
            ch.close()
          } catch { /* ignore */ }
        }
        // Excluded sweeps (drop-from-analysis markers).
        const savedExcluded = await _loadPersistedExcluded(recording.filePath)
        if (savedExcluded) {
          set({ excludedSweeps: savedExcluded })
          try {
            const ch = new BroadcastChannel('neurotrace-sync')
            ch.postMessage({ type: 'excluded-update', excludedSweeps: savedExcluded })
            ch.close()
          } catch { /* ignore */ }
        }
        // User-created averaged sweeps.
        const savedAveraged = await _loadPersistedAveraged(recording.filePath)
        if (savedAveraged) {
          set({ averagedSweeps: savedAveraged })
          try {
            const ch = new BroadcastChannel('neurotrace-sync')
            ch.postMessage({ type: 'averaged-update', averagedSweeps: savedAveraged })
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
      // Navigating to a real sweep always clears the "we're viewing an
      // averaged virtual sweep" pointer, so the viewer fetches fresh
      // trace data below instead of keeping the averaged Float64Array.
      currentAveragedSweep: null,
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
    const { backendUrl, currentGroup, currentSeries, currentTrace, recording } = get()
    try {
      // Exclude any sweeps the user flagged in the tree — ask the backend
      // for an explicit-list average when exclusions exist, otherwise let
      // it default to "all sweeps" via range 0..N.
      const total = recording?.groups?.[currentGroup]?.series?.[currentSeries]?.sweepCount ?? 0
      const included = get().includedSweepsFor(currentGroup, currentSeries, total)
      let url = `/api/traces/average?group=${currentGroup}&series=${currentSeries}&trace=${currentTrace}&max_points=0`
      if (total > 0 && included.length !== total) {
        url += `&sweeps=${included.join(',')}`
      }
      const data = await apiFetch(backendUrl, url)
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

  // ---- Excluded sweeps ----
  //
  // Persistence lives alongside other per-file slices (bursts, IV, fPSP,
  // cursor analyses): a module-level subscribe below writes
  // `savedExcludedSweeps[filePath]` on every change, and `openFile`
  // restores it on file open. Cross-window sync flows through
  // BroadcastChannel "excluded-update" — the main window's CursorPanel
  // adopts it on receipt, exactly like the other analysis slices.

  toggleSweepExcluded: (group, series, sweep) => {
    const key = `${group}:${series}`
    set((s) => {
      const current = s.excludedSweeps[key] ?? []
      const has = current.includes(sweep)
      const next = has
        ? current.filter((i) => i !== sweep)
        : [...current, sweep].sort((a, b) => a - b)
      const nextMap = { ...s.excludedSweeps, [key]: next }
      // Drop empty entries so the persisted blob stays clean.
      if (next.length === 0) delete nextMap[key]
      return { excludedSweeps: nextMap }
    })
    _broadcastExcludedSweeps(get().excludedSweeps)
  },

  clearExcludedSweeps: (group, series) => {
    const key = `${group}:${series}`
    set((s) => {
      if (!s.excludedSweeps[key]) return s
      const nextMap = { ...s.excludedSweeps }
      delete nextMap[key]
      return { excludedSweeps: nextMap }
    })
    _broadcastExcludedSweeps(get().excludedSweeps)
  },

  isSweepExcluded: (group, series, sweep) => {
    const set = get().excludedSweeps[`${group}:${series}`]
    return !!set && set.includes(sweep)
  },

  includedSweepsFor: (group, series, totalSweeps) => {
    const excluded = get().excludedSweeps[`${group}:${series}`]
    if (!excluded || excluded.length === 0) {
      return Array.from({ length: totalSweeps }, (_, i) => i)
    }
    const ex = new Set(excluded)
    const out: number[] = []
    for (let i = 0; i < totalSweeps; i++) if (!ex.has(i)) out.push(i)
    return out
  },

  filterExcludedSweeps: (group, series, sweeps) => {
    const excluded = get().excludedSweeps[`${group}:${series}`]
    if (!excluded || excluded.length === 0) return sweeps.slice()
    const ex = new Set(excluded)
    return sweeps.filter((i) => !ex.has(i))
  },

  // ---- Multi-selection ---------------------------------------------
  //
  // Behaviour mirrors Finder / VS Code:
  //   - `none` (plain click) → treat as a navigation click; do NOT
  //     clear selection (that's handled in selectSweep).
  //   - `cmd` / Ctrl → toggle the single sweep in/out of selection.
  //   - `shift` → select the contiguous range between the LAST
  //     plain-clicked / shift-anchored sweep and this one.
  // The anchor is tracked as the most recent single-sweep selection
  // in the selectedSweeps list.

  handleSweepSelection: (group, series, sweep, modifier) => {
    const key = `${group}:${series}`
    set((s) => {
      const current = s.selectedSweeps[key] ?? []
      let next: number[]
      if (modifier === 'cmd') {
        next = current.includes(sweep)
          ? current.filter((i) => i !== sweep)
          : [...current, sweep].sort((a, b) => a - b)
      } else if (modifier === 'shift' && current.length > 0) {
        const anchor = current[current.length - 1]
        const lo = Math.min(anchor, sweep)
        const hi = Math.max(anchor, sweep)
        const range: number[] = []
        for (let i = lo; i <= hi; i++) range.push(i)
        next = range
      } else {
        // 'none' or shift-without-anchor: seed selection with this sweep.
        next = [sweep]
      }
      const nextMap = { ...s.selectedSweeps, [key]: next }
      if (next.length === 0) delete nextMap[key]
      return { selectedSweeps: nextMap }
    })
  },

  clearSweepSelection: (group, series) => {
    const key = `${group}:${series}`
    set((s) => {
      if (!s.selectedSweeps[key]) return s
      const nextMap = { ...s.selectedSweeps }
      delete nextMap[key]
      return { selectedSweeps: nextMap }
    })
  },

  isSweepSelected: (group, series, sweep) => {
    const sel = get().selectedSweeps[`${group}:${series}`]
    return !!sel && sel.includes(sweep)
  },

  // ---- Averaged virtual sweeps ------------------------------------
  //
  // `createAveragedSweep` hits the backend's /api/traces/average with an
  // explicit sweeps list, stores the returned trace under (group, series)
  // as a new AveragedSweep, and navigates to it. Persistence + cross-
  // window sync flow through the standard _broadcast + subscribe
  // pattern defined below.

  createAveragedSweep: async (group, series, trace, sweepIndices, label) => {
    const { backendUrl, recording } = get()
    if (sweepIndices.length === 0) {
      set({ error: 'No sweeps selected for averaging.' })
      return null
    }
    try {
      const resp = await apiFetch(
        backendUrl,
        `/api/traces/average?group=${group}&series=${series}&trace=${trace}&sweeps=${sweepIndices.join(',')}&max_points=0`,
      )
      const id = `avg-${Date.now()}-${Math.floor(Math.random() * 10000)}`
      const avg: AveragedSweep = {
        id,
        group, series, trace,
        sourceSweepIndices: sweepIndices.slice(),
        label: label || `Avg ${sweepIndices.length === 1
          ? `sweep ${sweepIndices[0] + 1}`
          : `${sweepIndices.length} sweeps`}`,
        time: resp.time,
        values: resp.values,
        samplingRate: resp.sampling_rate,
        units: resp.units,
        createdAt: Date.now(),
      }
      const key = `${group}:${series}`
      set((s) => ({
        averagedSweeps: {
          ...s.averagedSweeps,
          [key]: [...(s.averagedSweeps[key] ?? []), avg],
        },
      }))
      _broadcastAveragedSweeps(get().averagedSweeps)
      // Navigate to the new averaged sweep so the user can see it right away.
      get().selectAveragedSweep(group, series, id)
      void recording  // may be null in analysis windows; persistence subscribe runs in main only
      return id
    } catch (err: any) {
      set({ error: err.message || 'Failed to create averaged sweep' })
      return null
    }
  },

  deleteAveragedSweep: (group, series, id) => {
    const key = `${group}:${series}`
    set((s) => {
      const list = s.averagedSweeps[key] ?? []
      const next = list.filter((a) => a.id !== id)
      const nextMap = { ...s.averagedSweeps }
      if (next.length === 0) delete nextMap[key]
      else nextMap[key] = next
      // If we're currently viewing the deleted one, clear the pointer.
      const cur = s.currentAveragedSweep
      const clearCurrent = cur && cur.group === group && cur.series === series && cur.id === id
      return {
        averagedSweeps: nextMap,
        ...(clearCurrent ? { currentAveragedSweep: null } : {}),
      }
    })
    _broadcastAveragedSweeps(get().averagedSweeps)
  },

  renameAveragedSweep: (group, series, id, label) => {
    const key = `${group}:${series}`
    set((s) => {
      const list = s.averagedSweeps[key] ?? []
      const next = list.map((a) => a.id === id ? { ...a, label } : a)
      return { averagedSweeps: { ...s.averagedSweeps, [key]: next } }
    })
    _broadcastAveragedSweeps(get().averagedSweeps)
  },

  selectAveragedSweep: (group, series, id) => {
    const list = get().averagedSweeps[`${group}:${series}`] ?? []
    const avg = list.find((a) => a.id === id)
    if (!avg) return
    set({
      currentGroup: group,
      currentSeries: series,
      currentTrace: avg.trace,
      currentAveragedSweep: { group, series, id },
      traceData: {
        time: new Float64Array(avg.time),
        values: new Float64Array(avg.values),
        samplingRate: avg.samplingRate,
        units: avg.units,
        label: avg.label,
      },
    })
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
      const excluded = get().excludedSweeps[`${group}:${series}`] ?? []
      const resp = await apiFetch(backendUrl, '/api/analysis/batch', {
        method: 'POST',
        body: JSON.stringify({
          analysis_type: 'bursts',
          group, series, trace: channel,
          // sweep_end: -1 tells the backend to use ser.sweep_count.
          sweep_start: 0, sweep_end: -1,
          // Backend subtracts these after resolving the range.
          excluded_sweeps: excluded.length > 0 ? excluded : undefined,
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

  addManualBurst: (group, series, burst) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.fieldBursts[key]
      const existing = entry?.bursts ?? []
      const next = [...existing, { ...burst, manual: true }].sort((a, b) => {
        if (a.sweepIndex !== b.sweepIndex) return a.sweepIndex - b.sweepIndex
        return a.startS - b.startS
      })
      // If there's no existing entry yet (user happens to click before any
      // auto-detection has run), create a minimal one so the burst still
      // renders. Thresholds stay null; params are echoed as empty.
      const baseEntry: FieldBurstsData = entry ?? {
        channel: 0,
        bursts: [],
        baselineValue: 0,
        thresholdHigh: null,
        thresholdLow: null,
        selectedIdx: null,
        params: { method: 'threshold', baseline_mode: 'percentile' } as FieldBurstsParams,
      }
      return {
        fieldBursts: {
          ...s.fieldBursts,
          [key]: { ...baseEntry, bursts: next },
        },
      }
    })
    _broadcastBursts(get().fieldBursts, get().fieldBursts[key]?.params ?? { method: 'threshold', baseline_mode: 'percentile' } as FieldBurstsParams)
  },

  removeBurstAt: (group, series, sweep, timeS) => {
    const key = `${group}:${series}`
    set((s) => {
      const entry = s.fieldBursts[key]
      if (!entry) return s
      // Find candidate bursts on the clicked sweep. Prefer bursts whose
      // [startS, endS] span contains the click; fall back to the one
      // whose peak is closest in time within 0.5 s so the click still
      // lands when the user hits the marker dot outside the span.
      let best: { idx: number; dist: number } | null = null
      entry.bursts.forEach((b, i) => {
        if (b.sweepIndex !== sweep) return
        const inside = timeS >= b.startS && timeS <= b.endS
        const peakDist = Math.abs(timeS - b.peakTimeS)
        const dist = inside ? 0 : peakDist
        if (inside || peakDist < 0.5) {
          if (!best || dist < best.dist) best = { idx: i, dist }
        }
      })
      if (!best) return s
      // `best` is narrowed inside the callbacks above; TS doesn't follow
      // the mutation back out so assert it here.
      const removeIdx = (best as { idx: number; dist: number }).idx
      const nextBursts = entry.bursts.filter((_, i) => i !== removeIdx)
      return {
        fieldBursts: {
          ...s.fieldBursts,
          [key]: { ...entry, bursts: nextBursts },
        },
      }
    })
    _broadcastBursts(get().fieldBursts, get().fieldBursts[key]?.params ?? { method: 'threshold', baseline_mode: 'percentile' } as FieldBurstsParams)
  },

  setBurstFormParams: (group, series, params) => {
    const key = `${group}:${series}`
    set((s) => ({
      burstFormParams: { ...s.burstFormParams, [key]: params },
    }))
    _broadcastBurstFormParams(get().burstFormParams)
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
      if (params.manualImEnabled) {
        qs.set('manual_im_enabled', 'true')
        qs.set('manual_im_start_s', String(params.manualImStartS ?? 0))
        qs.set('manual_im_end_s', String(params.manualImEndS ?? 0))
        qs.set('manual_im_start_pa', String(params.manualImStartPA ?? 0))
        qs.set('manual_im_step_pa', String(params.manualImStepPA ?? 0))
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

  // ---- Field PSP analysis ----

  runFPsp: async (group, series, channel, params) => {
    const { backendUrl } = get()
    if (!backendUrl) return
    set({ loading: true, error: null })
    try {
      const mode: FPspMode = params.mode ?? 'ltp'
      // Build a /api/fpsp/run query. The `volS`/`volE`/`fepS`/`fepE`
      // args let us reuse this for both responses in PPR mode.
      const buildQuery = (volS: number, volE: number, fepS: number, fepE: number) => {
        const qs = new URLSearchParams({
          group: String(group),
          series: String(series),
          trace: String(channel),
          baseline_start_s: String(params.baselineStartS),
          baseline_end_s: String(params.baselineEndS),
          volley_start_s: String(volS),
          volley_end_s: String(volE),
          fepsp_start_s: String(fepS),
          fepsp_end_s: String(fepE),
          method: params.method,
          slope_low_pct: String(params.slopeLowPct),
          slope_high_pct: String(params.slopeHighPct),
          peak_direction: params.peakDirection,
          avg_n: String(Math.max(1, Math.round(params.avgN))),
        })
        if (params.seriesB != null) qs.set('series_b', String(params.seriesB))
        if (params.sweepIndices && params.sweepIndices.length > 0) {
          qs.set('sweeps', params.sweepIndices.join(','))
        }
        if (params.filterEnabled) {
          qs.set('filter_enabled', 'true')
          qs.set('filter_type', params.filterType ?? 'lowpass')
          qs.set('filter_low', String(params.filterLow ?? 1))
          qs.set('filter_high', String(params.filterHigh ?? 1000))
          qs.set('filter_order', String(params.filterOrder ?? 4))
        }
        return qs
      }
      // Parse a single backend point-dict into an FPspPoint. Used for
      // the primary response always; the PPR secondary response parses
      // into a "shadow" list that later gets merged into the primary.
      const parsePoint = (p: any): FPspPoint => ({
        sourceSeries: Number(p.source_series ?? series),
        binIndex: Number(p.bin_index ?? 0),
        sweepIndices: (p.sweep_indices ?? []).map((x: any) => Number(x)),
        meanSweepIndex: Number(p.mean_sweep_index ?? 0),
        baseline: Number(p.baseline ?? 0),
        volleyPeak: Number(p.volley_peak ?? 0),
        volleyPeakTs: Number(p.volley_peak_t_s ?? 0),
        volleyAmp: Number(p.volley_amp ?? 0),
        fepspPeak: Number(p.fepsp_peak ?? 0),
        fepspPeakTs: Number(p.fepsp_peak_t_s ?? 0),
        fepspAmp: Number(p.fepsp_amp ?? 0),
        slope: p.slope != null ? Number(p.slope) : null,
        slopeLow: p.slope_low_point
          ? { t: Number(p.slope_low_point.t), v: Number(p.slope_low_point.v) }
          : null,
        slopeHigh: p.slope_high_point
          ? { t: Number(p.slope_high_point.t), v: Number(p.slope_high_point.v) }
          : null,
        ratio: p.ratio != null ? Number(p.ratio) : null,
        flagged: Boolean(p.flagged),
      })

      const qs = buildQuery(
        params.volleyStartS, params.volleyEndS,
        params.fepspStartS, params.fepspEndS,
      )
      // PPR mode: fire the 2nd-response request in parallel with the
      // 1st. Both use the same baseline window + method/filter; only
      // the volley/fepsp windows differ. Merged by binIndex below.
      const wantPPR = mode === 'ppr'
        && params.volley2StartS != null && params.volley2EndS != null
        && params.fepsp2StartS != null && params.fepsp2EndS != null
      const qs2 = wantPPR
        ? buildQuery(
            params.volley2StartS!, params.volley2EndS!,
            params.fepsp2StartS!, params.fepsp2EndS!,
          )
        : null
      const [resp, resp2] = await Promise.all([
        apiFetch(backendUrl, `/api/fpsp/run?${qs}`),
        qs2 ? apiFetch(backendUrl, `/api/fpsp/run?${qs2}`) : Promise.resolve(null),
      ])
      const key = `${group}:${series}:${mode}`
      const existing = get().fpspCurves[key]
      const newPoints: FPspPoint[] = (resp.points ?? []).map(parsePoint)

      // Merge the 2nd-response fields into the primary points (matched
      // on binIndex + sourceSeries). PPR amp/slope ratios are computed
      // in |abs| terms so negative-going fEPSPs give sensibly-signed
      // ratios (both peak amplitudes are negative; R2/R1 is positive).
      if (wantPPR && resp2) {
        const second = new Map<string, any>()
        for (const p of (resp2.points ?? [])) {
          second.set(`${p.source_series}:${p.bin_index}`, p)
        }
        for (const p of newPoints) {
          const s = second.get(`${p.sourceSeries}:${p.binIndex}`)
          if (!s) continue
          p.volleyPeak2 = Number(s.volley_peak ?? 0)
          p.volleyPeakTs2 = Number(s.volley_peak_t_s ?? 0)
          p.volleyAmp2 = Number(s.volley_amp ?? 0)
          p.fepspPeak2 = Number(s.fepsp_peak ?? 0)
          p.fepspPeakTs2 = Number(s.fepsp_peak_t_s ?? 0)
          p.fepspAmp2 = Number(s.fepsp_amp ?? 0)
          p.slope2 = s.slope != null ? Number(s.slope) : null
          p.slopeLow2 = s.slope_low_point
            ? { t: Number(s.slope_low_point.t), v: Number(s.slope_low_point.v) }
            : null
          p.slopeHigh2 = s.slope_high_point
            ? { t: Number(s.slope_high_point.t), v: Number(s.slope_high_point.v) }
            : null
          const a1 = Math.abs(p.fepspAmp)
          const a2 = Math.abs(p.fepspAmp2 ?? 0)
          p.pprAmp = a1 > 0 ? a2 / a1 : null
          const s1 = p.slope != null ? Math.abs(p.slope) : null
          const s2Abs = p.slope2 != null ? Math.abs(p.slope2) : null
          p.pprSlope = (s1 != null && s1 > 0 && s2Abs != null) ? s2Abs / s1 : null
        }
      }

      // For append mode, only rows from the SAME source-series+bin pair
      // get replaced; everything else stays. Keeps points from seriesB
      // intact when the user re-runs on a single seriesA sweep, etc.
      let merged = newPoints
      if (params.appendToExisting && existing) {
        const ids = new Set(newPoints.map((p) => `${p.sourceSeries}:${p.binIndex}`))
        const kept = existing.points.filter(
          (p) => !ids.has(`${p.sourceSeries}:${p.binIndex}`),
        )
        merged = [...kept, ...newPoints].sort((a, b) => {
          if (a.sourceSeries !== b.sourceSeries) return a.sourceSeries - b.sourceSeries
          return a.binIndex - b.binIndex
        })
      }

      const next: FPspData = {
        mode,
        channel,
        responseUnit: String(resp.response_unit ?? existing?.responseUnit ?? ''),
        seriesA: series,
        seriesB: params.seriesB ?? null,
        stimOnsetS: Number(resp.stim_onset_s ?? existing?.stimOnsetS ?? 0),
        sweepIntervalA: Number(resp.sweep_interval_s ?? existing?.sweepIntervalA ?? 0),
        sweepIntervalB: Number(resp.sweep_interval_s_b ?? existing?.sweepIntervalB ?? 0),
        measurementMethod: params.method,
        slopeLowPct: params.slopeLowPct,
        slopeHighPct: params.slopeHighPct,
        peakDirection: params.peakDirection,
        avgN: Math.max(1, Math.round(params.avgN)),
        filterEnabled: Boolean(params.filterEnabled),
        filterType: params.filterType ?? 'lowpass',
        filterLow: Number(params.filterLow ?? 1),
        filterHigh: Number(params.filterHigh ?? 1000),
        filterOrder: Number(params.filterOrder ?? 4),
        baselineStartS: params.baselineStartS,
        baselineEndS: params.baselineEndS,
        volleyStartS: params.volleyStartS,
        volleyEndS: params.volleyEndS,
        fepspStartS: params.fepspStartS,
        fepspEndS: params.fepspEndS,
        timeAxis: existing?.timeAxis ?? 'timestamp',
        normalize: existing?.normalize ?? false,
        normBaselineFrom: existing?.normBaselineFrom ?? 1,
        normBaselineTo: existing?.normBaselineTo ?? Math.max(1, Math.min(10, merged.length)),
        points: merged,
        selectedIdx: null,
        // I-O mode only — preserved on the entry so the scatter plot
        // and results table can show intensities without re-prompting.
        ioInitialIntensity: mode === 'io'
          ? (params.ioInitialIntensity ?? existing?.ioInitialIntensity ?? 0)
          : existing?.ioInitialIntensity,
        ioIntensityStep: mode === 'io'
          ? (params.ioIntensityStep ?? existing?.ioIntensityStep ?? 0)
          : existing?.ioIntensityStep,
        ioUnit: mode === 'io'
          ? (params.ioUnit ?? existing?.ioUnit ?? 'µA')
          : existing?.ioUnit,
        ioMetric: mode === 'io'
          ? (params.ioMetric ?? existing?.ioMetric ?? 'slope')
          : existing?.ioMetric,
        // PPR mode only — echoed onto the entry so reopening the
        // window restores the 5 bands / ISI / metric toggle.
        volley2StartS: mode === 'ppr' ? params.volley2StartS : existing?.volley2StartS,
        volley2EndS: mode === 'ppr' ? params.volley2EndS : existing?.volley2EndS,
        fepsp2StartS: mode === 'ppr' ? params.fepsp2StartS : existing?.fepsp2StartS,
        fepsp2EndS: mode === 'ppr' ? params.fepsp2EndS : existing?.fepsp2EndS,
        pprIsiMs: mode === 'ppr' ? (params.pprIsiMs ?? existing?.pprIsiMs) : existing?.pprIsiMs,
        pprMetric: mode === 'ppr'
          ? (params.pprMetric ?? existing?.pprMetric ?? 'amp')
          : existing?.pprMetric,
      }
      set((s) => ({ fpspCurves: { ...s.fpspCurves, [key]: next }, loading: false }))
      _broadcastFPsp(get().fpspCurves)
    } catch (err: any) {
      set({ error: err.message, loading: false })
    }
  },

  clearFPsp: (mode, group, series) => {
    set((s) => {
      if (group == null || series == null) return { fpspCurves: {} }
      const key = `${group}:${series}:${mode}`
      const { [key]: _dropped, ...rest } = s.fpspCurves
      return { fpspCurves: rest }
    })
    _broadcastFPsp(get().fpspCurves)
  },

  selectFPspPoint: (mode, group, series, idx) => {
    const key = `${group}:${series}:${mode}`
    set((s) => {
      const entry = s.fpspCurves[key]
      if (!entry) return s
      return { fpspCurves: { ...s.fpspCurves, [key]: { ...entry, selectedIdx: idx } } }
    })
  },

  setFPspTimeAxis: (mode, group, series, axis) => {
    const key = `${group}:${series}:${mode}`
    set((s) => {
      const entry = s.fpspCurves[key]
      if (!entry) return s
      return { fpspCurves: { ...s.fpspCurves, [key]: { ...entry, timeAxis: axis } } }
    })
    _broadcastFPsp(get().fpspCurves)
  },

  setFPspNormalize: (mode, group, series, normalize) => {
    const key = `${group}:${series}:${mode}`
    set((s) => {
      const entry = s.fpspCurves[key]
      if (!entry) return s
      return { fpspCurves: { ...s.fpspCurves, [key]: { ...entry, normalize } } }
    })
    _broadcastFPsp(get().fpspCurves)
  },

  setFPspNormBaseline: (mode, group, series, from, to) => {
    const key = `${group}:${series}:${mode}`
    set((s) => {
      const entry = s.fpspCurves[key]
      if (!entry) return s
      const lo = Math.max(1, Math.min(from, to))
      const hi = Math.max(lo, Math.max(from, to))
      return {
        fpspCurves: {
          ...s.fpspCurves,
          [key]: { ...entry, normBaselineFrom: lo, normBaselineTo: hi },
        },
      }
    })
    _broadcastFPsp(get().fpspCurves)
  },

  exportFPspCSV: async () => {
    const { fpspCurves, recording, backendUrl } = get()
    const keys = Object.keys(fpspCurves)
    if (keys.length === 0) return
    let fileName: string = recording?.fileName ?? ''
    if (!fileName && backendUrl) {
      try {
        const info = await fetch(`${backendUrl}/api/files/info`).then((r) => r.ok ? r.json() : null)
        if (info?.fileName) fileName = info.fileName
      } catch { /* ignore */ }
    }
    const header = [
      'file', 'mode', 'group', 'source_series', 'bin_index', 'sweep_indices',
      'io_intensity', 'io_unit',
      'baseline', 'volley_peak', 'volley_peak_t_s', 'volley_amp',
      'fepsp_peak', 'fepsp_peak_t_s', 'fepsp_amp',
      'ratio', 'flagged',
      'slope', 'slope_low_t_s', 'slope_low_v', 'slope_high_t_s', 'slope_high_v',
      'method', 'slope_low_pct', 'slope_high_pct',
      'peak_direction', 'avg_n', 'response_unit', 'stim_onset_s',
      'sweep_interval_s',
    ]
    const rows: string[] = [header.join(',')]
    for (const key of keys) {
      const [g] = key.split(':').map(Number)
      const entry = fpspCurves[key]
      const mode = entry.mode ?? 'ltp'
      entry.points.forEach((p) => {
        const ival = p.sourceSeries === entry.seriesA
          ? entry.sweepIntervalA
          : (entry.sweepIntervalB || 0)
        // I-O: one row per sweep; intensity = initial + sweepIndex * step.
        // Use the first (only) sweep in the bin. For LTP bins containing
        // multiple sweeps, leave intensity blank.
        const ioIntensity =
          mode === 'io' && p.sweepIndices.length === 1 &&
          entry.ioInitialIntensity != null && entry.ioIntensityStep != null
            ? (entry.ioInitialIntensity + p.sweepIndices[0] * entry.ioIntensityStep).toFixed(3)
            : ''
        rows.push([
          JSON.stringify(fileName),
          mode,
          g, p.sourceSeries, p.binIndex,
          JSON.stringify(p.sweepIndices.join(' ')),
          ioIntensity,
          mode === 'io' ? JSON.stringify(entry.ioUnit ?? 'µA') : '',
          p.baseline.toFixed(4),
          p.volleyPeak.toFixed(4),
          p.volleyPeakTs.toFixed(6),
          p.volleyAmp.toFixed(4),
          p.fepspPeak.toFixed(4),
          p.fepspPeakTs.toFixed(6),
          p.fepspAmp.toFixed(4),
          p.ratio != null ? p.ratio.toFixed(3) : '',
          p.flagged ? '1' : '0',
          p.slope != null ? p.slope.toFixed(4) : '',
          p.slopeLow ? p.slopeLow.t.toFixed(6) : '',
          p.slopeLow ? p.slopeLow.v.toFixed(4) : '',
          p.slopeHigh ? p.slopeHigh.t.toFixed(6) : '',
          p.slopeHigh ? p.slopeHigh.v.toFixed(4) : '',
          entry.measurementMethod,
          entry.slopeLowPct.toFixed(1),
          entry.slopeHighPct.toFixed(1),
          entry.peakDirection,
          entry.avgN,
          JSON.stringify(entry.responseUnit),
          entry.stimOnsetS.toFixed(6),
          ival.toFixed(4),
        ].join(','))
      })
    }
    const csv = rows.join('\n')
    const defaultName = (fileName || 'recording').replace(/\.[^.]+$/, '') + '_fpsp.csv'
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

// Burst-detection form state — writes whenever the user tweaks any
// field in the FieldBurstWindow, so closing and reopening the window
// (or restarting the app) restores the same method / params per series.
let _lastPersistedBurstFormRef: Record<string, FieldBurstsParams> | null = null
useAppStore.subscribe((state) => {
  if (state.burstFormParams === _lastPersistedBurstFormRef) return
  _lastPersistedBurstFormRef = state.burstFormParams
  if (state.recording?.filePath) {
    _savePersistedBurstFormParams(state.recording.filePath, state.burstFormParams)
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

// fPSP persistence subscribe.
let _lastPersistedFPspRef: Record<string, FPspData> | null = null
useAppStore.subscribe((state) => {
  if (state.fpspCurves === _lastPersistedFPspRef) return
  _lastPersistedFPspRef = state.fpspCurves
  if (state.recording?.filePath) {
    _savePersistedFPsp(state.recording.filePath, state.fpspCurves)
  }
})

// Cursor-analysis persistence subscribe.
let _lastPersistedCursorRef: Record<string, CursorAnalysisData> | null = null
useAppStore.subscribe((state) => {
  if (state.cursorAnalyses === _lastPersistedCursorRef) return
  _lastPersistedCursorRef = state.cursorAnalyses
  if (state.recording?.filePath) {
    _savePersistedCursors(state.recording.filePath, state.cursorAnalyses)
  }
})

// Excluded-sweeps persistence subscribe.
let _lastPersistedExcludedRef: Record<string, number[]> | null = null
useAppStore.subscribe((state) => {
  if (state.excludedSweeps === _lastPersistedExcludedRef) return
  _lastPersistedExcludedRef = state.excludedSweeps
  if (state.recording?.filePath) {
    _savePersistedExcluded(state.recording.filePath, state.excludedSweeps)
  }
})

// Averaged-sweeps persistence subscribe.
let _lastPersistedAveragedRef: Record<string, AveragedSweep[]> | null = null
useAppStore.subscribe((state) => {
  if (state.averagedSweeps === _lastPersistedAveragedRef) return
  _lastPersistedAveragedRef = state.averagedSweeps
  if (state.recording?.filePath) {
    _savePersistedAveraged(state.recording.filePath, state.averagedSweeps)
  }
})

// Cursor window UI prefs — global (not per-file). Persist via electronAPI
// under 'cursorWindowUI' so the splitter position + selected columns survive
// restarts.
let _lastPersistedCursorUIRef: CursorWindowUI | null = null
useAppStore.subscribe((state) => {
  if (state.cursorWindowUI === _lastPersistedCursorUIRef) return
  _lastPersistedCursorUIRef = state.cursorWindowUI
  const api = window.electronAPI
  if (!api?.getPreferences || !api?.setPreferences) return
  api.getPreferences().then((prefs) => {
    api.setPreferences!({ ...(prefs ?? {}), cursorWindowUI: state.cursorWindowUI }).catch(() => { /* ignore */ })
  }).catch(() => { /* ignore */ })
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
