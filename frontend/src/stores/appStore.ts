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

export interface SeriesInfo {
  index: number
  label: string
  sweepCount: number
  sweeps: SweepInfo[]
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

  // Cursors
  cursors: CursorPositions

  // Measurements
  results: MeasurementResult[]

  // Resistance analysis
  resistanceResult: ResistanceResult | null
  resistanceMonitor: ResistanceMonitorData | null

  // UI state
  zoomMode: boolean
  showStimulusOverlay: boolean
  showCursors: boolean
  loading: boolean
  error: string | null

  // Actions
  toggleZoomMode: () => void
  toggleStimulusOverlay: () => void
  toggleCursors: () => void
  resetCursorsToDefaults: () => void
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
}

const OVERLAY_COLORS = [
  '#64b5f6', '#81c784', '#ffb74d', '#e57373', '#ba68c8',
  '#4dd0e1', '#aed581', '#ffd54f', '#ff8a65', '#ce93d8',
  '#4fc3f7', '#a5d6a7', '#fff176', '#ef9a9a', '#b39ddb',
]

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

  cursors: {
    baselineStart: 0,
    baselineEnd: 0.01,
    peakStart: 0.01,
    peakEnd: 0.05,
    fitStart: 0.01,
    fitEnd: 0.1,
  },

  results: [],
  resistanceResult: null,
  resistanceMonitor: null,
  zoomMode: false,
  showStimulusOverlay: true,
  showCursors: true,
  loading: false,
  error: null,

  toggleZoomMode: () => set((s) => ({ zoomMode: !s.zoomMode })),
  toggleStimulusOverlay: () => set((s) => ({ showStimulusOverlay: !s.showStimulusOverlay })),
  toggleCursors: () => set((s) => ({ showCursors: !s.showCursors })),

  resetCursorsToDefaults: () => {
    const { traceData } = get()
    if (!traceData) return
    const duration = traceData.values.length / traceData.samplingRate
    set({
      cursors: {
        baselineStart: 0,
        baselineEnd: 0.2 * duration,
        peakStart: 0.3 * duration,
        peakEnd: 0.5 * duration,
        fitStart: 0.6 * duration,
        fitEnd: 0.8 * duration,
      },
    })
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
      const data = await apiFetch(
        backendUrl,
        `/api/traces/data?group=${group}&series=${series}&sweep=${sweep}&trace=${trace}&max_points=0`
      )
      set({
        traceData: {
          time: new Float64Array(data.time),
          values: new Float64Array(data.values),
          samplingRate: data.sampling_rate,
          units: data.units,
          label: data.label,
        },
      })
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
    const { backendUrl, currentGroup, currentSeries, currentTrace, overlayEntries } = get()
    if (overlayEntries.some((e) => e.sweep === sweep)) return
    try {
      const data = await apiFetch(
        backendUrl,
        `/api/traces/data?group=${currentGroup}&series=${currentSeries}&sweep=${sweep}&trace=${currentTrace}&max_points=0`
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
    const { recording, currentGroup, currentSeries, currentTrace, backendUrl } = get()
    if (!recording) return
    const ser = recording.groups[currentGroup]?.series[currentSeries]
    if (!ser) return

    set({ loading: true })
    const entries: OverlayEntry[] = []
    for (let i = 0; i < ser.sweepCount; i++) {
      try {
        const data = await apiFetch(
          backendUrl,
          `/api/traces/data?group=${currentGroup}&series=${currentSeries}&sweep=${i}&trace=${currentTrace}&max_points=0`
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
}))

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
