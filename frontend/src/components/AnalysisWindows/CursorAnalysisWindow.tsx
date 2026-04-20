import React, { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  useAppStore, CursorPositions,
  CursorAnalysisData, CursorSlotConfig, CursorMeasurement,
} from '../../stores/appStore'
import { NumInput } from '../common/NumInput'

// Stimfit-style cursor-analysis window.
//
// Architecture:
//  - Configuration + results live in the app store under
//    ``cursorAnalyses[filePath]`` so state survives closing/reopening the
//    window and is persisted per-recording via Electron prefs.
//  - Global UI (splitter height, selected columns, active tab) lives in
//    ``cursorWindowUI`` — not per-file.
//  - The slot table only renders ``slotCount`` rows (user-controlled,
//    defaulting to 1). Disabled slots beyond that remain in state so
//    toggling the count doesn't reset their windows.

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

type FitFunction = { id: string; label: string; params: string[] }

const MAX_SLOTS = 10

// 10 visually distinct slot colors, reused across the slot table, band
// overlays on the mini-viewer, and the slot swatch in the results table.
const SLOT_COLORS = [
  '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#a855f7',
  '#06b6d4', '#eab308', '#ec4899', '#14b8a6', '#8b5cf6',
]

// ---- Column definitions ----------------------------------------------------
//
// Each tab knows the columns it can display; the user picks which ones are
// visible via the Columns ▾ popover. "sweep" and "slot" are always on.

type ColDef = {
  id: string
  label: string
  width?: number
  /** Extract the cell's string representation for a measurement row. */
  value: (m: CursorMeasurement, ctx: { traceUnit: string; fitFunctions: FitFunction[] }) => React.ReactNode
}

const MEAS_COLUMNS: ColDef[] = [
  { id: 'sweep', label: 'Sweep', value: (m) => m.sweep === -1 ? 'avg' : String(m.sweep + 1) },
  { id: 'slot', label: 'Slot', value: (m) => (
    <span style={{
      display: 'inline-block', width: 14, height: 14, borderRadius: 2,
      background: SLOT_COLORS[m.slot % SLOT_COLORS.length],
      color: '#000', fontWeight: 700, textAlign: 'center',
      lineHeight: '14px', fontSize: 10,
    }}>{m.slot + 1}</span>
  ) },
  { id: 'baseline', label: 'Baseline', value: (m) => fmt(m.baseline, 3) },
  { id: 'baseline_sd', label: 'BL SD', value: (m) => fmt(m.baseline_sd, 3) },
  { id: 'peak', label: 'Peak', value: (m) => fmt(m.peak, 3) },
  { id: 'amplitude', label: 'Amp', value: (m) => fmt(m.amplitude, 3) },
  { id: 'peak_time', label: 't_peak (ms)', value: (m) => fmtMs(m.peak_time) },
  { id: 'time_to_peak', label: 'time-to-peak (ms)', value: (m) => fmtMs(m.time_to_peak) },
  { id: 'rise_time_10_90', label: 'RT 10–90 (ms)', value: (m) => fmtMs(m.rise_time_10_90) },
  { id: 'rise_time_20_80', label: 'RT 20–80 (ms)', value: (m) => fmtMs(m.rise_time_20_80) },
  { id: 'half_width', label: 't½ (ms)', value: (m) => fmtMs(m.half_width) },
  { id: 'max_slope_rise', label: 'Rise slope', value: (m) => fmt(m.max_slope_rise, 2) },
  { id: 'max_slope_decay', label: 'Decay slope', value: (m) => fmt(m.max_slope_decay, 2) },
  { id: 'rise_decay_ratio', label: 'R/D', value: (m) => fmt(m.rise_decay_ratio, 3) },
  { id: 'area', label: 'Area', value: (m) => fmt(m.area, 3) },
  { id: 'ap_threshold', label: 'AP thr', value: (m) => fmt(m.ap_threshold, 3) },
  { id: 'ap_threshold_time', label: 'AP thr time (ms)', value: (m) => fmtMs(m.ap_threshold_time) },
]

const FIT_COLUMNS: ColDef[] = [
  { id: 'sweep', label: 'Sweep', value: (m) => m.sweep === -1 ? 'avg' : String(m.sweep + 1) },
  { id: 'slot', label: 'Slot', value: (m) => (
    <span style={{
      display: 'inline-block', width: 14, height: 14, borderRadius: 2,
      background: SLOT_COLORS[m.slot % SLOT_COLORS.length],
      color: '#000', fontWeight: 700, textAlign: 'center',
      lineHeight: '14px', fontSize: 10,
    }}>{m.slot + 1}</span>
  ) },
  { id: 'fit_function', label: 'Function', value: (m, ctx) => {
    if (!m.fit) return '—'
    const f = ctx.fitFunctions.find((x) => x.id === m.fit!.function)
    return f?.label ?? m.fit.function
  } },
  { id: 'r_squared', label: 'R²', value: (m) => fmt(m.fit?.r_squared, 4) },
  { id: 'rss', label: 'RSS', value: (m) => fmt(m.fit?.rss, 4) },
  { id: 'params', label: 'Params', value: (m) => m.fit
    ? Object.entries(m.fit.params).map(([k, v]) => `${k}=${v.toPrecision(4)}`).join(', ')
    : '—',
  },
]

// ---- Helpers ---------------------------------------------------------------

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

function makeDefaultSlots(peakStart: number, peakEnd: number): CursorSlotConfig[] {
  return Array.from({ length: MAX_SLOTS }, (_, i) => ({
    enabled: i === 0,
    peak: { start: peakStart, end: peakEnd },
    fit: null,
    fitFunction: null,
    fitOptions: null,
  }))
}

function defaultData(cursors: CursorPositions, selection: {
  group: number; series: number; trace: number
}): CursorAnalysisData {
  return {
    group: selection.group,
    series: selection.series,
    trace: selection.trace,
    slotCount: 1,
    baseline: { start: cursors.baselineStart, end: cursors.baselineEnd },
    baselineMethod: 'mean',
    computeAP: false,
    apSlope: 20,
    slots: makeDefaultSlots(cursors.peakStart, cursors.peakEnd),
    runMode: 'all',
    sweepFrom: 1,
    sweepTo: 1,
    sweepOne: 1,
    average: false,
    measurements: [],
    traceUnit: '',
  }
}

function fmt(v: number | undefined | null, digits = 3): string {
  if (v == null || !isFinite(v)) return '—'
  return v.toFixed(digits)
}
function fmtMs(v: number | undefined | null): string {
  if (v == null || !isFinite(v)) return '—'
  return (v * 1000).toFixed(3)
}

function triggerDownload(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CursorAnalysisWindow({
  backendUrl,
  fileInfo,
  mainGroup,
  mainSeries,
  mainTrace,
  cursors,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
  cursors: CursorPositions
}) {
  const { error, setError } = useAppStore()
  const recording = useAppStore((s) => s.recording)
  const filePath = recording?.filePath ?? ''

  // ---- Resolve the blob for the current file -------------------------------
  //
  // Read the store's entry for this file; if missing, seed from defaults +
  // the main viewer's cursor positions. Write back into the store whenever
  // anything changes, which also triggers electron-prefs persistence.

  const dataFromStore = useAppStore((s) => (filePath ? s.cursorAnalyses[filePath] : undefined))
  const [localData, setLocalData] = useState<CursorAnalysisData>(() =>
    dataFromStore ?? defaultData(cursors, {
      group: mainGroup ?? 0,
      series: mainSeries ?? 0,
      trace: mainTrace ?? 0,
    }),
  )
  // On file change, re-seed from the persisted blob (or defaults).
  const loadedForFileRef = useRef<string | null>(null)
  useEffect(() => {
    if (!filePath) return
    if (loadedForFileRef.current === filePath) return
    loadedForFileRef.current = filePath
    const existing = useAppStore.getState().cursorAnalyses[filePath]
    setLocalData(
      existing ?? defaultData(cursors, {
        group: mainGroup ?? 0,
        series: mainSeries ?? 0,
        trace: mainTrace ?? 0,
      }),
    )
  }, [filePath, cursors, mainGroup, mainSeries, mainTrace])

  // Push every change back into the store (debounced via React's batching).
  useEffect(() => {
    if (!filePath) return
    useAppStore.setState((s) => ({
      cursorAnalyses: { ...s.cursorAnalyses, [filePath]: localData },
    }))
  }, [localData, filePath])

  // ---- Global UI prefs (splitter, columns, active tab) ---------------------

  const ui = useAppStore((s) => s.cursorWindowUI)
  const setUI = (patch: Partial<typeof ui>) => {
    useAppStore.setState((s) => ({ cursorWindowUI: { ...s.cursorWindowUI, ...patch } }))
  }

  // ---- Fit function catalog (loaded once per window) -----------------------

  const [fitFunctions, setFitFunctions] = useState<FitFunction[]>([])
  useEffect(() => {
    if (!backendUrl) return
    fetch(`${backendUrl}/api/cursors/functions`)
      .then((r) => r.json())
      .then((d) => setFitFunctions(d.functions ?? []))
      .catch(() => { /* ignore */ })
  }, [backendUrl])

  // ---- Preview trace for the mini-viewer -----------------------------------

  const totalSweeps: number = fileInfo?.groups?.[localData.group]?.series?.[localData.series]?.sweepCount ?? 0
  const [previewData, setPreviewData] = useState<{ time: number[]; values: number[] } | null>(null)
  const previewSweep = useMemo(() => {
    if (localData.runMode === 'one') return Math.max(0, Math.min(totalSweeps - 1, localData.sweepOne - 1))
    if (localData.runMode === 'range') return Math.max(0, Math.min(totalSweeps - 1, localData.sweepFrom - 1))
    return 0
  }, [localData.runMode, localData.sweepFrom, localData.sweepOne, totalSweeps])
  useEffect(() => {
    if (!backendUrl || !fileInfo || totalSweeps === 0) { setPreviewData(null); return }
    let cancelled = false
    const qs = new URLSearchParams({
      group: String(localData.group),
      series: String(localData.series),
      trace: String(localData.trace),
      sweep: String(previewSweep),
      max_points: '4000',
    })
    fetch(`${backendUrl}/api/traces/data?${qs}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setPreviewData({ time: d.time ?? [], values: d.values ?? [] }) })
      .catch(() => { if (!cancelled) setPreviewData(null) })
    return () => { cancelled = true }
  }, [backendUrl, fileInfo, localData.group, localData.series, localData.trace, previewSweep, totalSweeps])

  // ---- Selection handling --------------------------------------------------

  const channels = useMemo(
    () => channelsForSeries(fileInfo, localData.group, localData.series),
    [fileInfo, localData.group, localData.series],
  )

  const patch = (p: Partial<CursorAnalysisData>) => setLocalData((d) => ({ ...d, ...p }))

  // Reset bounds on file change.
  useEffect(() => {
    if (!fileInfo) return
    if (localData.group >= fileInfo.groupCount) patch({ group: 0 })
    const ser = fileInfo.groups?.[localData.group]?.series
    if (ser && localData.series >= ser.length) patch({ series: 0 })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileInfo])
  useEffect(() => {
    if (channels.length > 0 && localData.trace >= channels.length) patch({ trace: 0 })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels.length])
  useEffect(() => {
    if (totalSweeps > 0) {
      patch({
        sweepFrom: 1,
        sweepTo: totalSweeps,
        sweepOne: Math.min(Math.max(1, localData.sweepOne), totalSweeps),
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalSweeps])

  // ---- Running the analysis ------------------------------------------------

  const [running, setRunning] = useState(false)
  const onRun = async () => {
    if (!backendUrl || !fileInfo) return
    setRunning(true)
    setError(null)
    try {
      let sweepIndices: number[] | null = null
      if (localData.runMode === 'range') {
        const lo = Math.max(1, Math.min(localData.sweepFrom, totalSweeps))
        const hi = Math.max(lo, Math.min(localData.sweepTo, totalSweeps))
        sweepIndices = []
        for (let i = lo - 1; i <= hi - 1; i++) sweepIndices.push(i)
      } else if (localData.runMode === 'one') {
        const sw = Math.max(1, Math.min(localData.sweepOne, totalSweeps))
        sweepIndices = [sw - 1]
      }
      // Only send slots within the visible slotCount; disabled-but-hidden
      // slots beyond slotCount stay in state but shouldn't contribute.
      const visibleSlots = localData.slots.slice(0, localData.slotCount)
      const body = {
        group: localData.group,
        series: localData.series,
        trace: localData.trace,
        sweeps: sweepIndices,
        average: localData.average,
        baseline: localData.baseline,
        baseline_method: localData.baselineMethod,
        slots: visibleSlots.map((s) => ({
          enabled: s.enabled,
          peak: s.peak,
          fit: s.fit,
          fit_function: s.fit && s.fitFunction ? s.fitFunction : null,
          fit_options: s.fitOptions ? {
            maxfev: s.fitOptions.maxfev,
            ftol: s.fitOptions.ftol,
            xtol: s.fitOptions.xtol,
            initial_guess: s.fitOptions.initialGuess ?? null,
          } : null,
        })),
        compute_ap: localData.computeAP,
        ap_slope_vs: localData.apSlope,
      }
      const resp = await fetch(`${backendUrl}/api/cursors/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: 'Run failed' }))
        throw new Error(err.detail || 'Run failed')
      }
      const data = await resp.json()
      patch({
        measurements: data.measurements ?? [],
        traceUnit: data.trace_unit ?? '',
      })
    } catch (err: any) {
      setError(err.message || 'Run failed')
    } finally {
      setRunning(false)
    }
  }

  const onClear = () => patch({ measurements: [] })

  // ---- CSV export ----------------------------------------------------------

  const onExportCSV = () => {
    if (localData.measurements.length === 0) return
    // Always export every possible column — CSV is for downstream analysis,
    // not for display.
    const allCols = [...new Set([...MEAS_COLUMNS.map((c) => c.id), ...FIT_COLUMNS.map((c) => c.id)])]
    const header = allCols.join(',')
    const rows = localData.measurements.map((m) =>
      allCols.map((id) => {
        switch (id) {
          case 'sweep': return m.sweep === -1 ? 'avg' : String(m.sweep + 1)
          case 'slot': return String(m.slot + 1)
          case 'baseline': return fmt(m.baseline, 6)
          case 'baseline_sd': return fmt(m.baseline_sd, 6)
          case 'peak': return fmt(m.peak, 6)
          case 'amplitude': return fmt(m.amplitude, 6)
          case 'peak_time': return fmt(m.peak_time, 6)
          case 'time_to_peak': return fmt(m.time_to_peak, 6)
          case 'rise_time_10_90': return fmt(m.rise_time_10_90, 6)
          case 'rise_time_20_80': return fmt(m.rise_time_20_80, 6)
          case 'half_width': return fmt(m.half_width, 6)
          case 'max_slope_rise': return fmt(m.max_slope_rise, 6)
          case 'max_slope_decay': return fmt(m.max_slope_decay, 6)
          case 'rise_decay_ratio': return fmt(m.rise_decay_ratio, 6)
          case 'area': return fmt(m.area, 6)
          case 'ap_threshold': return fmt(m.ap_threshold, 6)
          case 'ap_threshold_time': return fmt(m.ap_threshold_time, 6)
          case 'fit_function': return m.fit?.function ?? ''
          case 'r_squared': return fmt(m.fit?.r_squared, 6)
          case 'rss': return fmt(m.fit?.rss, 6)
          case 'params': return m.fit
            ? Object.entries(m.fit.params).map(([k, v]) => `${k}=${v.toFixed(6)}`).join(';')
            : ''
          default: return ''
        }
      }).join(','),
    )
    const csv = [header, ...rows].join('\n')
    const name = (fileInfo?.fileName ?? 'cursor_analysis').replace(/\.[^.]+$/, '') + '_cursors.csv'
    triggerDownload(new Blob([csv], { type: 'text/csv' }), name)
  }

  // ---- Splitter ------------------------------------------------------------

  const onSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = ui.plotHeight
    const onMove = (ev: MouseEvent) => {
      setUI({ plotHeight: Math.max(120, Math.min(700, startH + (ev.clientY - startY))) })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ---- Slot helpers --------------------------------------------------------

  const updateSlot = (i: number, p: Partial<CursorSlotConfig>) => {
    setLocalData((d) => ({
      ...d,
      slots: d.slots.map((s, k) => (k === i ? { ...s, ...p } : s)),
    }))
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 10, gap: 8, minHeight: 0,
    }}>
      {/* --- Selectors + run bar --------------------------------------- */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Field label="Group">
          <select value={localData.group} onChange={(e) => patch({ group: Number(e.target.value) })} disabled={!fileInfo}>
            {(fileInfo?.groups ?? []).map((g: any, i: number) => (
              <option key={i} value={i}>{g.label || `G${i + 1}`}</option>
            ))}
          </select>
        </Field>
        <Field label="Series">
          <select value={localData.series} onChange={(e) => patch({ series: Number(e.target.value) })} disabled={!fileInfo}>
            {(fileInfo?.groups?.[localData.group]?.series ?? []).map((s: any, i: number) => (
              <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
            ))}
          </select>
        </Field>
        <Field label="Channel">
          <select value={localData.trace} onChange={(e) => patch({ trace: Number(e.target.value) })} disabled={channels.length === 0}>
            {channels.map((c: any) => (
              <option key={c.index} value={c.index}>{c.label} ({c.units})</option>
            ))}
          </select>
        </Field>
      </div>

      <div style={{
        display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
        padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>Run on:</span>
        {(['all', 'range', 'one'] as const).map((m) => (
          <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
            <input type="radio" name="cursor-run-mode" value={m}
              checked={localData.runMode === m} onChange={() => patch({ runMode: m })} />
            {m === 'all' ? 'all sweeps' : m === 'range' ? 'range' : 'single sweep'}
          </label>
        ))}
        {localData.runMode === 'range' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <NumInput value={localData.sweepFrom} step={1} min={1} max={Math.max(1, totalSweeps)}
              onChange={(v) => patch({ sweepFrom: Math.max(1, Math.round(v)) })} style={{ width: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>–</span>
            <NumInput value={localData.sweepTo} step={1} min={1} max={Math.max(1, totalSweeps)}
              onChange={(v) => patch({ sweepTo: Math.max(1, Math.round(v)) })} style={{ width: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
              / {totalSweeps || '—'}
            </span>
          </span>
        )}
        {localData.runMode === 'one' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <NumInput value={localData.sweepOne} step={1} min={1} max={Math.max(1, totalSweeps)}
              onChange={(v) => patch({ sweepOne: Math.max(1, Math.round(v)) })} style={{ width: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
              / {totalSweeps || '—'}
            </span>
          </span>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 12, fontSize: 'var(--font-size-label)' }}>
          <input type="checkbox" checked={localData.average}
            onChange={(e) => patch({ average: e.target.checked })} />
          Average selected sweeps first
        </label>
        <button className="btn btn-primary" onClick={onRun}
          disabled={running || !fileInfo} style={{ marginLeft: 'auto' }}>
          {running ? 'Running…' : 'Run'}
        </button>
        <button className="btn" onClick={onClear} disabled={localData.measurements.length === 0}>Clear</button>
        <button className="btn" onClick={onExportCSV} disabled={localData.measurements.length === 0}>
          Export CSV
        </button>
      </div>

      {/* --- Baseline + slot count + AP mode --------------------------- */}
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
        padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', fontSize: 'var(--font-size-label)',
      }}>
        <span style={{ fontWeight: 600, color: 'var(--cursor-baseline)' }}>Baseline</span>
        <NumInput value={localData.baseline.start} step={0.001}
          onChange={(v) => patch({ baseline: { ...localData.baseline, start: v } })} style={{ width: 70 }} />
        <span style={{ color: 'var(--text-muted)' }}>→</span>
        <NumInput value={localData.baseline.end} step={0.001}
          onChange={(v) => patch({ baseline: { ...localData.baseline, end: v } })} style={{ width: 70 }} />
        <span style={{ color: 'var(--text-muted)' }}>s</span>
        <label style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          Method:
          <select value={localData.baselineMethod}
            onChange={(e) => patch({ baselineMethod: e.target.value as 'mean' | 'median' })}>
            <option value="mean">mean</option>
            <option value="median">median</option>
          </select>
        </label>
        <button
          className="btn"
          style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}
          onClick={() => patch({ baseline: { start: cursors.baselineStart, end: cursors.baselineEnd } })}
          title="Copy baseline cursor values from the main viewer"
        >
          ← main
        </button>
        <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
        <label style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          Slots:
          <NumInput value={localData.slotCount} step={1} min={1} max={MAX_SLOTS}
            onChange={(v) => patch({ slotCount: Math.max(1, Math.min(MAX_SLOTS, Math.round(v))) })}
            style={{ width: 44 }} />
        </label>
        <span style={{ marginLeft: 'auto' }}>
          <label style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <input type="checkbox" checked={localData.computeAP}
              onChange={(e) => patch({ computeAP: e.target.checked })} />
            AP mode (threshold at
            <NumInput value={localData.apSlope} step={1}
              onChange={(v) => patch({ apSlope: v })} style={{ width: 44 }} />
            V/s)
          </label>
        </span>
      </div>

      {/* --- Slot table (only the first slotCount rows) ---------------- */}
      <div style={{
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', padding: '4px 6px',
        overflow: 'auto', flexShrink: 0,
      }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontSize: 'var(--font-size-label)', fontFamily: 'var(--font-mono)',
        }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
              <Th>#</Th>
              <Th>On</Th>
              <Th>Peak start</Th>
              <Th>Peak end</Th>
              <Th>Fit start</Th>
              <Th>Fit end</Th>
              <Th>Fit function</Th>
              <Th>Fit opts</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {localData.slots.slice(0, localData.slotCount).map((slot, i) => (
              <SlotRow
                key={i}
                index={i}
                slot={slot}
                fitFunctions={fitFunctions}
                cursors={cursors}
                onChange={(p) => updateSlot(i, p)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {error && (
        <div style={{
          padding: '6px 10px',
          background: 'var(--bg-error, #5c1b1b)',
          color: '#fff',
          borderRadius: 3,
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 'var(--font-size-xs)',
        }}>
          <span style={{ flex: 1 }}>⚠ {error}</span>
          <button className="btn" onClick={() => setError(null)}
            style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}>dismiss</button>
        </div>
      )}

      {/* --- Viewer + tabs split --------------------------------------- */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ height: ui.plotHeight, minHeight: 120, flexShrink: 0, position: 'relative' }}>
          <MiniViewer
            data={previewData}
            heightSignal={ui.plotHeight}
            baseline={localData.baseline}
            slots={localData.slots.slice(0, localData.slotCount)}
            traceUnit={localData.traceUnit}
            measurements={localData.measurements}
            previewSweep={previewSweep}
            onBaselineChange={(b) => patch({ baseline: b })}
            onSlotChange={updateSlot}
          />
        </div>

        <div onMouseDown={onSplitterMouseDown}
          style={{ height: 6, cursor: 'row-resize', background: 'var(--border)', flexShrink: 0, position: 'relative' }}>
          <div style={{
            position: 'absolute', left: '50%', top: 1, transform: 'translateX(-50%)',
            width: 40, height: 4, background: 'var(--text-muted)',
            borderRadius: 2, opacity: 0.5,
          }} />
        </div>

        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ResultsTabs
            activeTab={ui.activeTab}
            setActiveTab={(t) => setUI({ activeTab: t })}
            measurements={localData.measurements}
            traceUnit={localData.traceUnit}
            fitFunctions={fitFunctions}
            measurementColumns={ui.measurementColumns}
            fitColumns={ui.fitColumns}
            setMeasurementColumns={(c) => setUI({ measurementColumns: c })}
            setFitColumns={(c) => setUI({ fitColumns: c })}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}

// ---- Slot row with per-slot fit-options popover ---------------------------

function SlotRow({
  index, slot, fitFunctions, cursors, onChange,
}: {
  index: number
  slot: CursorSlotConfig
  fitFunctions: FitFunction[]
  cursors: CursorPositions
  onChange: (patch: Partial<CursorSlotConfig>) => void
}) {
  const color = SLOT_COLORS[index % SLOT_COLORS.length]
  const fitEnabled = slot.fit != null
  const [optsOpen, setOptsOpen] = useState(false)
  const activeFn = fitFunctions.find((f) => f.id === (slot.fitFunction ?? 'mono_exp'))

  return (
    <>
      <tr style={{ borderTop: '1px solid var(--border)', opacity: slot.enabled ? 1 : 0.55 }}>
        <Td>
          <span style={{
            display: 'inline-block', width: 16, height: 16, borderRadius: 3,
            background: color, textAlign: 'center', color: '#000', fontWeight: 700,
            fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: '16px',
          }}>{index + 1}</span>
        </Td>
        <Td>
          <input type="checkbox" checked={slot.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })} />
        </Td>
        <Td>
          <NumInput value={slot.peak.start} step={0.001}
            onChange={(v) => onChange({ peak: { ...slot.peak, start: v } })} style={{ width: 65 }} />
        </Td>
        <Td>
          <NumInput value={slot.peak.end} step={0.001}
            onChange={(v) => onChange({ peak: { ...slot.peak, end: v } })} style={{ width: 65 }} />
        </Td>
        <Td>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <input type="checkbox" checked={fitEnabled}
              onChange={(e) => onChange({
                fit: e.target.checked ? { start: slot.peak.start, end: slot.peak.end } : null,
                fitFunction: e.target.checked ? (slot.fitFunction ?? 'mono_exp') : null,
              })} />
            {fitEnabled && slot.fit && (
              <NumInput value={slot.fit.start} step={0.001}
                onChange={(v) => slot.fit && onChange({ fit: { ...slot.fit, start: v } })}
                style={{ width: 65 }} />
            )}
          </label>
        </Td>
        <Td>
          {fitEnabled && slot.fit && (
            <NumInput value={slot.fit.end} step={0.001}
              onChange={(v) => slot.fit && onChange({ fit: { ...slot.fit, end: v } })}
              style={{ width: 65 }} />
          )}
        </Td>
        <Td>
          {fitEnabled && (
            <select
              value={slot.fitFunction ?? 'mono_exp'}
              onChange={(e) => onChange({ fitFunction: e.target.value })}
              style={{ minWidth: 180 }}
            >
              {fitFunctions.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
          )}
        </Td>
        <Td>
          {fitEnabled && (
            <button className="btn" onClick={() => setOptsOpen((v) => !v)}
              style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}
              title="Per-slot fit options (iterations, tolerances, initial guesses)">
              {'\u2699'}
            </button>
          )}
        </Td>
        <Td>
          <button className="btn" title="Copy peak window from main viewer cursor"
            style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}
            onClick={() => onChange({ peak: { start: cursors.peakStart, end: cursors.peakEnd } })}>
            ← main
          </button>
        </Td>
      </tr>
      {optsOpen && fitEnabled && activeFn && (
        <tr>
          <td colSpan={9} style={{
            background: 'var(--bg-secondary)', padding: 8,
            borderTop: '1px dashed var(--border)',
          }}>
            <FitOptionsPopover
              slot={slot}
              fn={activeFn}
              onChange={onChange}
              onClose={() => setOptsOpen(false)}
            />
          </td>
        </tr>
      )}
    </>
  )
}

function FitOptionsPopover({
  slot, fn, onChange, onClose,
}: {
  slot: CursorSlotConfig
  fn: FitFunction
  onChange: (patch: Partial<CursorSlotConfig>) => void
  onClose: () => void
}) {
  const opts = slot.fitOptions ?? {}
  const setOpts = (p: Partial<NonNullable<CursorSlotConfig['fitOptions']>>) =>
    onChange({ fitOptions: { ...opts, ...p } })
  const setGuess = (param: string, value: string) => {
    const n = value.trim() === '' ? null : Number(value)
    const next = { ...(opts.initialGuess ?? {}) }
    if (n == null || !isFinite(n)) delete next[param]
    else next[param] = n
    setOpts({ initialGuess: next })
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--font-size-label)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Fit options · {fn.label}</span>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          max iterations
          <NumInput value={opts.maxfev ?? 5000} step={500} min={100}
            onChange={(v) => setOpts({ maxfev: Math.max(100, Math.round(v)) })} style={{ width: 60 }} />
        </label>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          ftol
          <NumInput value={opts.ftol ?? 1e-8}
            onChange={(v) => setOpts({ ftol: v })} style={{ width: 72 }} />
        </label>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          xtol
          <NumInput value={opts.xtol ?? 1e-8}
            onChange={(v) => setOpts({ xtol: v })} style={{ width: 72 }} />
        </label>
        <button className="btn" onClick={onClose} style={{ marginLeft: 'auto' }}>close</button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-muted)' }}>Initial guess overrides (blank = auto):</span>
        {fn.params.map((p) => {
          const cur = opts.initialGuess?.[p]
          return (
            <label key={p} style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{p}</span>
              <input
                type="text" inputMode="decimal"
                defaultValue={cur == null ? '' : String(cur)}
                onBlur={(e) => setGuess(p, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                placeholder="auto"
                style={{ width: 70 }}
              />
            </label>
          )
        })}
        {opts.initialGuess && Object.keys(opts.initialGuess).length > 0 && (
          <button className="btn" onClick={() => setOpts({ initialGuess: {} })}
            style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}>
            reset all
          </button>
        )}
      </div>
    </div>
  )
}

// ---- Mini-viewer ----------------------------------------------------------

function MiniViewer({
  data, heightSignal, baseline, slots, traceUnit, measurements,
  previewSweep, onBaselineChange, onSlotChange,
}: {
  data: { time: number[]; values: number[] } | null
  heightSignal: number
  baseline: { start: number; end: number }
  slots: CursorSlotConfig[]
  traceUnit: string
  measurements: CursorMeasurement[]
  previewSweep: number
  onBaselineChange: (b: { start: number; end: number }) => void
  onSlotChange: (slotIndex: number, patch: Partial<CursorSlotConfig>) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  // Latest state ref so hook callbacks always see current values.
  const stateRef = useRef({ baseline, slots, measurements, previewSweep })
  stateRef.current = { baseline, slots, measurements, previewSweep }

  // Drag state for cursor edges. Captured on pointerdown near an edge.
  type DragTarget =
    | { kind: 'baseline'; edge: 'start' | 'end' }
    | { kind: 'peak'; slot: number; edge: 'start' | 'end' }
    | { kind: 'fit'; slot: number; edge: 'start' | 'end' }
  const dragRef = useRef<DragTarget | null>(null)

  const resetZoom = () => {
    const u = plotRef.current
    if (!u || !data || data.time.length === 0) return
    u.setScale('x', { min: data.time[0], max: data.time[data.time.length - 1] })
    u.setScale('y', { min: Math.min(...data.values), max: Math.max(...data.values) })
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!data || data.time.length === 0) return

    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(100, el.clientHeight || 180),
      scales: { x: { time: false } },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: 'time (s)', labelSize: 14,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: traceUnit || '', labelSize: 14,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
        },
      ],
      // Enable drag-to-zoom on BOTH axes. The Reset button returns to auto.
      // Cursor-edge dragging intercepts pointerdowns near a band edge and
      // stops propagation so uPlot's zoom doesn't start for those events.
      cursor: { drag: { x: true, y: true, uni: 10 } },
      series: [
        {},
        {
          label: 'trace',
          stroke: cssVar('--trace-color-1'),
          width: 1,
          points: { show: false },
        },
      ],
      hooks: {
        drawClear: [(u) => drawBands(u, stateRef.current)],
        draw: [(u) => drawFits(u, stateRef.current)],
      },
    }
    plotRef.current = new uPlot(opts, [data.time, data.values], el)

    // --- Cursor-edge drag handlers ---
    // uPlot's `over` is the event target used for zoom; we attach listeners
    // in the capture phase so we can stop propagation before uPlot's own
    // handler starts a zoom drag.
    const over = el.querySelector<HTMLDivElement>('.u-over')
    if (over) {
      const xToPx = (x: number) => plotRef.current!.valToPos(x, 'x', false)
      const pxToX = (px: number) => plotRef.current!.posToVal(px, 'x')
      const EDGE_THRESHOLD_PX = 5

      const findEdge = (pxX: number): DragTarget | null => {
        const s = stateRef.current
        const candidates: { target: DragTarget; x: number }[] = []
        candidates.push({ target: { kind: 'baseline', edge: 'start' }, x: xToPx(s.baseline.start) })
        candidates.push({ target: { kind: 'baseline', edge: 'end' }, x: xToPx(s.baseline.end) })
        s.slots.forEach((slot, i) => {
          if (!slot.enabled) return
          candidates.push({ target: { kind: 'peak', slot: i, edge: 'start' }, x: xToPx(slot.peak.start) })
          candidates.push({ target: { kind: 'peak', slot: i, edge: 'end' }, x: xToPx(slot.peak.end) })
          if (slot.fit) {
            candidates.push({ target: { kind: 'fit', slot: i, edge: 'start' }, x: xToPx(slot.fit.start) })
            candidates.push({ target: { kind: 'fit', slot: i, edge: 'end' }, x: xToPx(slot.fit.end) })
          }
        })
        let best: DragTarget | null = null
        let bestDist = EDGE_THRESHOLD_PX + 1
        for (const c of candidates) {
          const d = Math.abs(c.x - pxX)
          if (d < bestDist) { bestDist = d; best = c.target }
        }
        return best
      }

      const onPointerMove = (ev: PointerEvent) => {
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        if (dragRef.current) {
          const x = pxToX(pxX)
          const t = dragRef.current
          const s = stateRef.current
          if (t.kind === 'baseline') {
            onBaselineChange({
              ...s.baseline,
              [t.edge]: x,
            })
          } else if (t.kind === 'peak') {
            const cur = s.slots[t.slot]
            onSlotChange(t.slot, { peak: { ...cur.peak, [t.edge]: x } })
          } else {
            const cur = s.slots[t.slot]
            if (cur.fit) onSlotChange(t.slot, { fit: { ...cur.fit, [t.edge]: x } })
          }
          ev.preventDefault()
          ev.stopPropagation()
        } else {
          // Hover: show the resize cursor when near an edge.
          over.style.cursor = findEdge(pxX) ? 'ew-resize' : ''
        }
      }
      const onPointerDown = (ev: PointerEvent) => {
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const hit = findEdge(pxX)
        if (hit) {
          dragRef.current = hit
          over.setPointerCapture(ev.pointerId)
          ev.stopPropagation()
          ev.preventDefault()
        }
      }
      const onPointerUp = (ev: PointerEvent) => {
        if (dragRef.current) {
          dragRef.current = null
          try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
          ev.stopPropagation()
        }
      }
      over.addEventListener('pointerdown', onPointerDown, true)
      over.addEventListener('pointermove', onPointerMove, true)
      over.addEventListener('pointerup', onPointerUp, true)

      const ro = new ResizeObserver(() => {
        const u = plotRef.current
        if (!u || !el) return
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      })
      ro.observe(el)
      return () => {
        over.removeEventListener('pointerdown', onPointerDown, true)
        over.removeEventListener('pointermove', onPointerMove, true)
        over.removeEventListener('pointerup', onPointerUp, true)
        ro.disconnect()
        plotRef.current?.destroy(); plotRef.current = null
      }
    }
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    return () => { ro.disconnect(); plotRef.current?.destroy(); plotRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])

  useEffect(() => { plotRef.current?.redraw() }, [baseline, slots, measurements])

  if (!data || data.time.length === 0) {
    return (
      <div style={{
        height: '100%', border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 'var(--font-size-label)',
      }}>
        Load a file to preview the trace here.
      </div>
    )
  }

  return (
    <div style={{
      height: '100%', border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)', position: 'relative',
    }}>
      <button
        className="btn"
        onClick={resetZoom}
        title="Reset zoom (auto range)"
        style={{
          position: 'absolute', top: 4, right: 4, zIndex: 2,
          padding: '1px 8px', fontSize: 'var(--font-size-label)',
        }}
      >
        Reset
      </button>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

function drawBands(
  u: uPlot,
  state: {
    baseline: { start: number; end: number }
    slots: CursorSlotConfig[]
    measurements: CursorMeasurement[]
    previewSweep: number
  },
) {
  const ctx = u.ctx
  const dpr = devicePixelRatio || 1
  const yTop = u.bbox.top
  const yBot = u.bbox.top + u.bbox.height
  const drawBand = (xs: number, xe: number, color: string, alpha: number, label?: string) => {
    const px0 = u.valToPos(xs, 'x', true)
    const px1 = u.valToPos(xe, 'x', true)
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    ctx.fillRect(Math.min(px0, px1), yTop, Math.abs(px1 - px0), yBot - yTop)
    if (label) {
      ctx.globalAlpha = 1
      ctx.fillStyle = color
      ctx.font = `bold ${10 * dpr}px ${cssVar('--font-mono')}`
      ctx.fillText(label, Math.min(px0, px1) + 2 * dpr, yTop + 12 * dpr)
    }
    ctx.restore()
  }
  drawBand(state.baseline.start, state.baseline.end, '#888', 0.12, 'BL')
  state.slots.forEach((s, i) => {
    if (!s.enabled) return
    const color = SLOT_COLORS[i % SLOT_COLORS.length]
    drawBand(s.peak.start, s.peak.end, color, 0.18, `P${i + 1}`)
    if (s.fit) drawBand(s.fit.start, s.fit.end, color, 0.08, `F${i + 1}`)
  })
}

function drawFits(
  u: uPlot,
  state: {
    baseline: { start: number; end: number }
    slots: CursorSlotConfig[]
    measurements: CursorMeasurement[]
    previewSweep: number
  },
) {
  const ctx = u.ctx
  const dpr = devicePixelRatio || 1
  // Pick the fit from the currently-previewed sweep first; fall back to the
  // averaged result (sweep = -1) if that's all we have.
  const byKey = new Map<string, CursorMeasurement>()
  for (const m of state.measurements) {
    if (m.fit) byKey.set(`${m.sweep}:${m.slot}`, m)
  }
  state.slots.forEach((s, i) => {
    if (!s.enabled || !s.fit) return
    const key = `${state.previewSweep}:${i}`
    const m = byKey.get(key) ?? byKey.get(`-1:${i}`)
    if (!m?.fit) return
    ctx.save()
    ctx.strokeStyle = SLOT_COLORS[i % SLOT_COLORS.length]
    ctx.lineWidth = 1.5 * dpr
    ctx.setLineDash([4 * dpr, 3 * dpr])
    ctx.beginPath()
    const tArr = m.fit.fit_time
    const vArr = m.fit.fit_values
    for (let k = 0; k < tArr.length; k++) {
      const px = u.valToPos(tArr[k], 'x', true)
      const py = u.valToPos(vArr[k], 'y', true)
      if (k === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()
    ctx.restore()
  })
}

// ---- Results tabs with per-tab column selector ---------------------------

function ResultsTabs({
  activeTab, setActiveTab, measurements, traceUnit, fitFunctions,
  measurementColumns, fitColumns, setMeasurementColumns, setFitColumns,
}: {
  activeTab: 'measurements' | 'fit'
  setActiveTab: (t: 'measurements' | 'fit') => void
  measurements: CursorMeasurement[]
  traceUnit: string
  fitFunctions: FitFunction[]
  measurementColumns: string[]
  fitColumns: string[]
  setMeasurementColumns: (c: string[]) => void
  setFitColumns: (c: string[]) => void
}) {
  const columns = activeTab === 'measurements' ? measurementColumns : fitColumns
  const setColumns = activeTab === 'measurements' ? setMeasurementColumns : setFitColumns
  const allColumns = activeTab === 'measurements' ? MEAS_COLUMNS : FIT_COLUMNS
  // "sweep" and "slot" are always on (required for readability).
  const lockedIds = new Set(['sweep', 'slot'])

  const visible = allColumns.filter((c) => columns.includes(c.id) || lockedIds.has(c.id))

  // Filter fit tab to rows that have a fit; measurements tab shows all rows.
  const rows = activeTab === 'fit'
    ? measurements.filter((m) => m.fit != null)
    : measurements

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 2,
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
      }}>
        {(['measurements', 'fit'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className="btn"
            style={{
              background: activeTab === t ? 'var(--bg-primary)' : 'transparent',
              borderRadius: 0,
              borderBottom: activeTab === t ? '2px solid var(--accent)' : '2px solid transparent',
              padding: '4px 12px',
              fontWeight: activeTab === t ? 600 : 400,
            }}
          >
            {t === 'measurements' ? 'Measurements' : 'Fit'}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <ColumnsButton
          allColumns={allColumns}
          visibleIds={columns}
          lockedIds={lockedIds}
          onChange={setColumns}
        />
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {rows.length === 0 ? (
          <div style={{
            padding: 16, textAlign: 'center',
            color: 'var(--text-muted)', fontStyle: 'italic',
            fontSize: 'var(--font-size-label)', height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {activeTab === 'measurements'
              ? 'Click Run to populate the results table.'
              : 'No fits yet — enable a fit cursor on a slot and click Run.'}
          </div>
        ) : (
          <table style={{
            width: '100%', borderCollapse: 'collapse',
            fontSize: 'var(--font-size-label)', fontFamily: 'var(--font-mono)',
          }}>
            <thead>
              <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left', position: 'sticky', top: 0 }}>
                {visible.map((c) => (
                  <Th key={c.id}>
                    {c.id === 'baseline' ? <>Baseline ({traceUnit})</> : c.label}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((m, i) => (
                <tr key={i} style={{
                  borderTop: '1px solid var(--border)',
                  background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                }}>
                  {visible.map((c) => (
                    <Td key={c.id}>{c.value(m, { traceUnit, fitFunctions })}</Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function ColumnsButton({
  allColumns, visibleIds, lockedIds, onChange,
}: {
  allColumns: ColDef[]
  visibleIds: string[]
  lockedIds: Set<string>
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const toggle = (id: string) => {
    if (lockedIds.has(id)) return
    if (visibleIds.includes(id)) onChange(visibleIds.filter((x) => x !== id))
    else onChange([...visibleIds, id])
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn" onClick={() => setOpen((v) => !v)}
        style={{ padding: '2px 8px', marginRight: 4, fontSize: 'var(--font-size-label)' }}>
        Columns {'\u25BE'}
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: '100%',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)', borderRadius: 4,
          padding: 6, zIndex: 10,
          fontSize: 'var(--font-size-label)',
          minWidth: 200,
          maxHeight: 400, overflow: 'auto',
          boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
        }}>
          {allColumns.map((c) => {
            const locked = lockedIds.has(c.id)
            return (
              <label key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '2px 4px', cursor: locked ? 'default' : 'pointer',
                opacity: locked ? 0.55 : 1,
              }}>
                <input type="checkbox" disabled={locked}
                  checked={locked || visibleIds.includes(c.id)}
                  onChange={() => toggle(c.id)} />
                {c.label}
                {locked && <span style={{ color: 'var(--text-muted)', marginLeft: 'auto', fontSize: 10 }}>required</span>}
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---- Small shared cells ---------------------------------------------------

const Th = ({ children }: { children?: React.ReactNode }) => (
  <th style={{ padding: '4px 8px', fontWeight: 600, fontSize: 'var(--font-size-label)', whiteSpace: 'nowrap' }}>
    {children}
  </th>
)
const Td = ({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) => (
  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', ...style }}>{children}</td>
)
