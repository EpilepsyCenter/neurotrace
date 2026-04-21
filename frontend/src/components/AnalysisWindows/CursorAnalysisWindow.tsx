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
  // NB: AP-specific columns (ap_threshold / ap_threshold_time) live in
  // the backend response but are not surfaced here — action-potential
  // analysis gets its own dedicated window; this one is the Stimfit-
  // style single/peak cursor measurement suite.
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
  // Inherit display settings from the main viewer: filter config +
  // zero-offset. The main viewer's values seed a LOCAL copy here that
  // the user can edit independently (so tweaking the filter for this
  // window doesn't disturb the main viewer).
  const mainFilter = useAppStore((s) => s.filter)
  const mainZeroOffset = useAppStore((s) => s.zeroOffset)
  const [localFilter, setLocalFilter] = useState(() => ({ ...mainFilter }))
  const [applyZero, setApplyZero] = useState<boolean>(() => mainZeroOffset)
  // Re-seed from the main viewer whenever it changes — keeps the window
  // behaving as an "inherited preview" by default. If the user has
  // explicitly pinned different values, they can re-edit.
  useEffect(() => { setLocalFilter({ ...mainFilter }) }, [
    mainFilter.enabled, mainFilter.type, mainFilter.lowCutoff, mainFilter.highCutoff, mainFilter.order,
  ])
  useEffect(() => setApplyZero(mainZeroOffset), [mainZeroOffset])

  // ---- Resolve the blob for the current (group, series) --------------------
  //
  // The store is keyed by "group:series" — same pattern as FPsp / IV /
  // bursts. The analysis window can't see `recording.filePath` (it's
  // only populated in the main window's store), so file-level
  // persistence is handled there: the main window loads per-file
  // blobs from electron prefs on file open, saves on every change,
  // and broadcasts the whole `cursorAnalyses` map to this window via
  // the `neurotrace-sync` BroadcastChannel. We just read/write the
  // store by (group, series) key; main handles disk.

  const [localData, setLocalData] = useState<CursorAnalysisData>(() => {
    const g = mainGroup ?? 0
    const s = mainSeries ?? 0
    const t = mainTrace ?? 0
    const existing = useAppStore.getState().cursorAnalyses[`${g}:${s}`]
    return existing ?? defaultData(cursors, { group: g, series: s, trace: t })
  })

  // Current key. Recomputes on every render so group/series swaps take
  // effect immediately.
  const storeKey = `${localData.group}:${localData.series}`

  // When the store's entry for the current key changes under us (e.g.
  // state-request round-trip after window reopen delivers the saved
  // blob), adopt it. The `syncedOnceRef` gate makes sure we do this
  // exactly once on first arrival so user edits aren't clobbered.
  const dataFromStore = useAppStore((s) => s.cursorAnalyses[storeKey])
  const syncedOnceRef = useRef(false)
  useEffect(() => {
    if (syncedOnceRef.current) return
    if (!dataFromStore) return
    syncedOnceRef.current = true
    setLocalData(dataFromStore)
  }, [dataFromStore])

  // When the user switches group or series, swap localData to that
  // (group, series) pair's stored blob if one exists; otherwise keep
  // the current form so they can build a new analysis on the new
  // series without starting from scratch.
  const lastKeyRef = useRef(storeKey)
  useEffect(() => {
    if (lastKeyRef.current === storeKey) return
    lastKeyRef.current = storeKey
    const existing = useAppStore.getState().cursorAnalyses[storeKey]
    if (existing) setLocalData(existing)
  }, [storeKey])

  // Mirror every change into the store under the current key, AND
  // broadcast the full map to the main window so its store can
  // persist to electron prefs (only the main window knows the
  // current recording.filePath).
  //
  // CRITICAL: we skip the very first mirror run. On mount the
  // state-update broadcast from the main window (which carries the
  // previously-persisted `cursorAnalyses`) hasn't arrived yet, so
  // `localData` is still at its defaults. Mirroring that back would
  // broadcast defaults to main, which would persist them over the
  // real data — making the window appear to "lose" everything after
  // a close-reopen cycle. By skipping the first run we wait for
  // either the sync effect to populate `localData` from the incoming
  // store data (in which case the next mirror run writes the same
  // data back — a no-op) or an actual user edit.
  const firstMirrorRef = useRef(true)
  useEffect(() => {
    if (firstMirrorRef.current) {
      firstMirrorRef.current = false
      return
    }
    const next = { ...useAppStore.getState().cursorAnalyses, [storeKey]: localData }
    useAppStore.setState({ cursorAnalyses: next })
    try {
      const ch = new BroadcastChannel('neurotrace-sync')
      ch.postMessage({ type: 'cursor-analyses-update', cursorAnalyses: next })
      ch.close()
    } catch { /* ignore */ }
  }, [localData, storeKey])

  // ---- Global UI prefs (splitter + columns persist via the store).
  //      ActiveTab is a LOCAL useState so it's immune to any store-
  //      subscription or persistence issue — simpler flow for a value
  //      that only needs to survive within this window session.

  const ui = useAppStore((s) => s.cursorWindowUI)
  const setUI = (patch: Partial<typeof ui>) => {
    useAppStore.setState((s) => ({ cursorWindowUI: { ...s.cursorWindowUI, ...patch } }))
  }
  const [activeTab, setActiveTab] = useState<'measurements' | 'fit'>(ui.activeTab)

  // Memoize the visible slots slice so the MiniViewer's `slots` prop has
  // a stable reference across parent re-renders (e.g. the /api/files/info
  // poll fires every 3 s, which was otherwise triggering a redraw that
  // snapped any user zoom back to auto-fit).
  const visibleSlots = useMemo(
    () => localData.slots.slice(0, localData.slotCount),
    [localData.slots, localData.slotCount],
  )

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
  const [previewData, setPreviewData] = useState<{ time: number[]; values: number[]; zeroOffset: number } | null>(null)
  const previewSweep = useMemo(() => {
    if (localData.runMode === 'one') return Math.max(0, Math.min(totalSweeps - 1, localData.sweepOne - 1))
    if (localData.runMode === 'range') return Math.max(0, Math.min(totalSweeps - 1, localData.sweepFrom - 1))
    return 0
  }, [localData.runMode, localData.sweepFrom, localData.sweepOne, totalSweeps])
  // Depend on stable primitive identifiers rather than the whole fileInfo
  // object — the parent shell re-fetches `/api/files/info` every 3 s and
  // hands down a fresh object each time. Without this, the plot below
  // would destroy-and-recreate on every poll and visibly flicker.
  const fileName = fileInfo?.fileName ?? null
  useEffect(() => {
    if (!backendUrl || !fileName || totalSweeps === 0) { setPreviewData(null); return }
    let cancelled = false
    const qs = new URLSearchParams({
      group: String(localData.group),
      series: String(localData.series),
      trace: String(localData.trace),
      sweep: String(previewSweep),
      max_points: '4000',
    })
    if (localFilter.enabled) {
      qs.set('filter_type', localFilter.type)
      qs.set('filter_low', String(localFilter.lowCutoff))
      qs.set('filter_high', String(localFilter.highCutoff))
      qs.set('filter_order', String(localFilter.order))
    }
    if (applyZero) qs.set('zero_offset', 'true')
    fetch(`${backendUrl}/api/traces/data?${qs}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setPreviewData({
          time: d.time ?? [],
          values: d.values ?? [],
          zeroOffset: Number(d.zero_offset ?? 0),
        })
      })
      .catch(() => { if (!cancelled) setPreviewData(null) })
    return () => { cancelled = true }
  }, [
    backendUrl, fileName,
    localData.group, localData.series, localData.trace, previewSweep, totalSweeps,
    applyZero,
    localFilter.enabled, localFilter.type, localFilter.lowCutoff, localFilter.highCutoff, localFilter.order,
  ])

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
      const store = useAppStore.getState()
      if (localData.runMode === 'all') {
        const included = store.includedSweepsFor(localData.group, localData.series, totalSweeps)
        if (included.length !== totalSweeps) sweepIndices = included
      } else if (localData.runMode === 'range') {
        const lo = Math.max(1, Math.min(localData.sweepFrom, totalSweeps))
        const hi = Math.max(lo, Math.min(localData.sweepTo, totalSweeps))
        const range: number[] = []
        for (let i = lo - 1; i <= hi - 1; i++) range.push(i)
        sweepIndices = store.filterExcludedSweeps(localData.group, localData.series, range)
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
        // AP-threshold detection is handled by a dedicated AP analysis
        // window; always off here.
        compute_ap: false,
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
      {/* --- Selectors (group / series / channel / sweep navigator) ---- */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
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
        <Field label="Sweep (preview)">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <button className="btn" disabled={totalSweeps === 0 || localData.sweepOne <= 1}
              onClick={() => patch({
                runMode: 'one',
                sweepOne: Math.max(1, localData.sweepOne - 1),
              })}
              style={{ padding: '2px 8px' }} title="Previous sweep">
              ←
            </button>
            <NumInput value={localData.sweepOne} step={1} min={1} max={Math.max(1, totalSweeps)}
              onChange={(v) => patch({
                runMode: 'one',
                sweepOne: Math.max(1, Math.min(totalSweeps, Math.round(v))),
              })}
              style={{ width: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
              / {totalSweeps || '—'}
            </span>
            <button className="btn" disabled={totalSweeps === 0 || localData.sweepOne >= totalSweeps}
              onClick={() => patch({
                runMode: 'one',
                sweepOne: Math.min(totalSweeps, localData.sweepOne + 1),
              })}
              style={{ padding: '2px 8px' }} title="Next sweep">
              →
            </button>
          </span>
        </Field>
      </div>

      {/* --- Filter (seeded from main viewer, editable locally) + zero offset */}
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
        padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', fontSize: 'var(--font-size-label)',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
          <input type="checkbox" checked={localFilter.enabled}
            onChange={(e) => setLocalFilter((f) => ({ ...f, enabled: e.target.checked }))} />
          Filter
        </label>
        <select value={localFilter.type} disabled={!localFilter.enabled}
          onChange={(e) => setLocalFilter((f) => ({ ...f, type: e.target.value as any }))}>
          <option value="lowpass">Lowpass</option>
          <option value="highpass">Highpass</option>
          <option value="bandpass">Bandpass</option>
        </select>
        {(localFilter.type === 'highpass' || localFilter.type === 'bandpass') && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ color: 'var(--text-muted)' }}>Low</span>
            <NumInput value={localFilter.lowCutoff} step={1} min={0.1}
              onChange={(v) => setLocalFilter((f) => ({ ...f, lowCutoff: v }))}
              style={{ width: 60 }} />
            <span style={{ color: 'var(--text-muted)' }}>Hz</span>
          </span>
        )}
        {(localFilter.type === 'lowpass' || localFilter.type === 'bandpass') && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ color: 'var(--text-muted)' }}>High</span>
            <NumInput value={localFilter.highCutoff} step={100} min={1}
              onChange={(v) => setLocalFilter((f) => ({ ...f, highCutoff: v }))}
              style={{ width: 70 }} />
            <span style={{ color: 'var(--text-muted)' }}>Hz</span>
          </span>
        )}
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ color: 'var(--text-muted)' }}>Order</span>
          <NumInput value={localFilter.order} step={1} min={1} max={8}
            onChange={(v) => setLocalFilter((f) => ({ ...f, order: Math.max(1, Math.min(8, Math.round(v))) }))}
            style={{ width: 44 }} />
        </span>
        <button className="btn" title="Copy filter settings from the main viewer"
          style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}
          onClick={() => setLocalFilter({ ...mainFilter })}>
          ← main
        </button>
        <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          title="Subtract a baseline computed from the first ~3 ms of the sweep">
          <input type="checkbox" checked={applyZero}
            onChange={(e) => setApplyZero(e.target.checked)} />
          Zero offset
        </label>
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

      {/* --- Baseline + slot count ------------------------------------ */}
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
        <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
        <label style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          Cursor pairs:
          <NumInput value={localData.slotCount} step={1} min={1} max={MAX_SLOTS}
            onChange={(v) => patch({ slotCount: Math.max(1, Math.min(MAX_SLOTS, Math.round(v))) })}
            style={{ width: 44 }} />
        </label>
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
            slots={visibleSlots}
            traceUnit={localData.traceUnit}
            measurements={localData.measurements}
            previewSweep={previewSweep}
            displayYOffset={previewData?.zeroOffset ?? 0}
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
            activeTab={activeTab}
            setActiveTab={setActiveTab}
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
      </tr>
      {optsOpen && fitEnabled && activeFn && (
        <tr>
          <td colSpan={8} style={{
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
  previewSweep, displayYOffset, onBaselineChange, onSlotChange,
}: {
  data: { time: number[]; values: number[]; zeroOffset?: number } | null
  heightSignal: number
  baseline: { start: number; end: number }
  slots: CursorSlotConfig[]
  traceUnit: string
  measurements: CursorMeasurement[]
  previewSweep: number
  /** Offset subtracted from the displayed trace (applied backend-side).
   *  Fit overlays — which are computed on raw data — are shifted by the
   *  same amount so they land on the visible trace. */
  displayYOffset: number
  onBaselineChange: (b: { start: number; end: number }) => void
  onSlotChange: (slotIndex: number, patch: Partial<CursorSlotConfig>) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  // Latest state ref so hook callbacks (drawBands, drawFits, event
  // handlers) always see current values without needing to tear down
  // and rebuild uPlot on every cursor change.
  const stateRef = useRef({ baseline, slots, measurements, previewSweep, displayYOffset })
  stateRef.current = { baseline, slots, measurements, previewSweep, displayYOffset }
  const callbacksRef = useRef({ onBaselineChange, onSlotChange })
  callbacksRef.current = { onBaselineChange, onSlotChange }
  // Keep the latest data reachable from the mount-effect's handlers
  // (they're attached once and see the initial closure forever).
  const dataRef = useRef(data)
  dataRef.current = data
  // --- THE ZOOM-PERSISTENCE MECHANISM --------------------------------
  //
  // These refs hold the scale ranges the plot should display. They
  // are wired into uPlot via `scale.range` functions below: uPlot
  // calls those functions on every draw to determine the axis
  // extents, so whatever's in the refs becomes the visible range.
  // Nothing uPlot does internally (setData, redraw, commit) ever
  // auto-ranges around them. Updates flow in exactly one direction:
  //
  //   user wheel/pan/Reset  →  update ref  →  u.redraw()  →
  //     range fn returns ref  →  axis displays that range.
  //
  // When a ref is `null`, the range function falls back to a
  // data-derived auto-fit (and stashes it in the ref so subsequent
  // draws are stable). That's how the very first draw gets a
  // sensible view, and how Reset restores auto-fit.
  const xRangeRef = useRef<[number, number] | null>(null)
  const yRangeRef = useRef<[number, number] | null>(null)
  // "Have we seen real (non-placeholder) data yet?" — the range
  // functions below must not stash anything while we're still drawing
  // against the mount-time placeholder, otherwise the refs would
  // lock to the placeholder's bogus Y range and the real trace
  // would render offscreen once it arrives.
  const hasRealDataRef = useRef(false)

  // Drag state: cursor edges, whole-band moves, and plot panning.
  type DragTarget =
    | { kind: 'baseline-edge'; edge: 'start' | 'end' }
    | { kind: 'baseline-band'; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'peak-edge'; slot: number; edge: 'start' | 'end' }
    | { kind: 'peak-band'; slot: number; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'fit-edge'; slot: number; edge: 'start' | 'end' }
    | { kind: 'fit-band'; slot: number; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'pan'; startX: number; xMin: number; xMax: number; startY: number; yMin: number; yMax: number }
  const dragRef = useRef<DragTarget | null>(null)

  const resetZoom = () => {
    const u = plotRef.current
    if (!u) return
    // Null the refs so the range functions re-auto-fit on the next
    // draw. Then setScale the current data's extents to force that
    // draw to happen now and re-run the range fns (bare redraw()
    // won't re-invoke them).
    xRangeRef.current = null
    yRangeRef.current = null
    const d = u.data as unknown as [number[], number[]] | undefined
    if (!d || !d[0] || d[0].length === 0) { u.redraw(); return }
    const xs = d[0], ys = d[1]
    const xmin = xs[0], xmax = xs[xs.length - 1]
    let ymin = Infinity, ymax = -Infinity
    for (const v of ys) { if (v < ymin) ymin = v; if (v > ymax) ymax = v }
    if (isFinite(xmin) && isFinite(xmax) && xmax > xmin) {
      u.setScale('x', { min: xmin, max: xmax })
    }
    if (isFinite(ymin) && isFinite(ymax) && ymin !== ymax) {
      const pad = (ymax - ymin) * 0.05
      u.setScale('y', { min: ymin - pad, max: ymax + pad })
    }
  }

  // --- PLOT LIFECYCLE ------------------------------------------------
  //
  // The plot is created ONCE and lives until the axis label (traceUnit)
  // changes or the component unmounts. Sweep/filter/zero-offset changes
  // push new samples via `u.setData(payload, true)` — uPlot preserves
  // any explicit X/Y scales the user set (via wheel/pan/drag) and
  // re-auto-fits any scale that's still in auto mode. This is the
  // native zoom-persistence mechanism; the old destroy-and-rebuild
  // pattern forced us to manually save/restore scales and was
  // fundamentally fragile.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(100, el.clientHeight || 180),
      scales: {
        x: {
          time: false,
          range: (_u, dataMin, dataMax) => {
            if (xRangeRef.current) return xRangeRef.current
            const lo = isFinite(dataMin) ? dataMin : 0
            const hi = isFinite(dataMax) && dataMax > lo ? dataMax : lo + 1
            const r: [number, number] = [lo, hi]
            // Only stash once we're looking at real data, otherwise
            // the placeholder mount would lock the axis to [0, 1].
            if (hasRealDataRef.current) xRangeRef.current = r
            return r
          },
        },
        y: {
          range: (_u, dataMin, dataMax) => {
            if (yRangeRef.current) return yRangeRef.current
            let r: [number, number]
            if (!isFinite(dataMin) || !isFinite(dataMax) || dataMin === dataMax) {
              r = [0, 1]
            } else {
              const pad = (dataMax - dataMin) * 0.05
              r = [dataMin - pad, dataMax + pad]
            }
            if (hasRealDataRef.current) yRangeRef.current = r
            return r
          },
        },
      },
      axes: [
        {
          stroke: cssVar('--chart-axis') || '#888',
          grid: { stroke: cssVar('--chart-grid') || '#2a2a2a', width: 1 },
          ticks: { stroke: cssVar('--chart-tick') || '#444', width: 1 },
          label: 'time (s)', labelSize: 14,
          font: `${cssVar('--font-size-label') || '11px'} ${cssVar('--font-mono') || 'monospace'}`,
        },
        {
          stroke: cssVar('--chart-axis') || '#888',
          grid: { stroke: cssVar('--chart-grid') || '#2a2a2a', width: 1 },
          ticks: { stroke: cssVar('--chart-tick') || '#444', width: 1 },
          label: traceUnit || '', labelSize: 14,
          font: `${cssVar('--font-size-label') || '11px'} ${cssVar('--font-mono') || 'monospace'}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        {
          label: 'trace',
          stroke: cssVar('--trace-color-1') || '#4a9ede',
          width: 1,
          points: { show: false },
        },
      ],
      hooks: {
        drawClear: [(u) => drawBands(u, stateRef.current)],
        draw: [(u) => drawFits(u, stateRef.current)],
      },
    }
    // Build the plot with whatever data we currently have. If data
    // isn't ready yet, use a 2-point placeholder so uPlot has a valid
    // initial geometry — real data will arrive via the setData effect
    // below as soon as the fetch completes. Scale locking is handled
    // entirely by the range functions in opts.scales; no explicit
    // setScale is needed here.
    const initial = dataRef.current
    const initialHasData = !!(initial && initial.time.length > 0)
    // Flip the "real data" flag BEFORE constructing the plot so the
    // range functions (which uPlot calls during construction) stash
    // their initial fit into the refs. If data is still null, we
    // leave the flag false and let the data-update effect below flip
    // it when real data first arrives.
    hasRealDataRef.current = initialHasData
    const payload: uPlot.AlignedData = initialHasData
      ? [Array.from(initial!.time), Array.from(initial!.values)]
      : [[0, 1], [0, 0]]
    plotRef.current = new uPlot(opts, payload, el)

    const over = el.querySelector<HTMLDivElement>('.u-over')
    const EDGE_THRESHOLD_PX = 6

    const xToPx = (x: number) => plotRef.current!.valToPos(x, 'x', false)
    const pxToX = (px: number) => plotRef.current!.posToVal(px, 'x')
    const pxToY = (py: number) => plotRef.current!.posToVal(py, 'y')

    const hasData = () => {
      const d = plotRef.current?.data as unknown as [number[], number[]] | undefined
      return !!d && !!d[0] && d[0].length > 0
    }
    // Returns the best cursor-hit for the given pixel X. Priority:
    //  1. edge hit (within EDGE_THRESHOLD_PX of either end of a band)
    //  2. band hit (between the two edges → whole-band move)
    //  3. null (empty plot area → pan)
    //
    // Bands are enumerated in overlay draw order so slots higher in the
    // list win ties (matches what the user sees on top).
    type CursorHit =
      | { kind: 'edge'; target: DragTarget }
      | { kind: 'band'; target: DragTarget }
    const findCursorHit = (pxX: number): CursorHit | null => {
      const s = stateRef.current
      const ranges: Array<{
        start: number; end: number
        edge: (e: 'start' | 'end') => DragTarget
        band: (startPxX: number) => DragTarget
      }> = []
      ranges.push({
        start: s.baseline.start, end: s.baseline.end,
        edge: (e) => ({ kind: 'baseline-edge', edge: e }),
        band: (startPxX) => ({
          kind: 'baseline-band', startPxX,
          startStart: s.baseline.start, startEnd: s.baseline.end,
        }),
      })
      s.slots.forEach((slot, i) => {
        if (!slot.enabled) return
        ranges.push({
          start: slot.peak.start, end: slot.peak.end,
          edge: (e) => ({ kind: 'peak-edge', slot: i, edge: e }),
          band: (startPxX) => ({
            kind: 'peak-band', slot: i, startPxX,
            startStart: slot.peak.start, startEnd: slot.peak.end,
          }),
        })
        if (slot.fit) {
          const f = slot.fit
          ranges.push({
            start: f.start, end: f.end,
            edge: (e) => ({ kind: 'fit-edge', slot: i, edge: e }),
            band: (startPxX) => ({
              kind: 'fit-band', slot: i, startPxX,
              startStart: f.start, startEnd: f.end,
            }),
          })
        }
      })
      // 1) Edge hit — scan all ranges, pick the nearest edge within threshold.
      let bestEdge: { dist: number; target: DragTarget } | null = null
      for (const r of ranges) {
        const pxStart = xToPx(r.start)
        const pxEnd = xToPx(r.end)
        const ds = Math.abs(pxStart - pxX)
        const de = Math.abs(pxEnd - pxX)
        if (ds < EDGE_THRESHOLD_PX && (!bestEdge || ds < bestEdge.dist)) {
          bestEdge = { dist: ds, target: r.edge('start') }
        }
        if (de < EDGE_THRESHOLD_PX && (!bestEdge || de < bestEdge.dist)) {
          bestEdge = { dist: de, target: r.edge('end') }
        }
      }
      if (bestEdge) return { kind: 'edge', target: bestEdge.target }
      // 2) Inside-a-band hit — last one added wins (topmost in draw order).
      for (let i = ranges.length - 1; i >= 0; i--) {
        const r = ranges[i]
        const pxStart = xToPx(r.start)
        const pxEnd = xToPx(r.end)
        const lo = Math.min(pxStart, pxEnd)
        const hi = Math.max(pxStart, pxEnd)
        if (pxX > lo && pxX < hi) {
          return { kind: 'band', target: r.band(pxX) }
        }
      }
      return null
    }
    const onPointerDown = (ev: PointerEvent) => {
      if (!over || !hasData()) return
      const rect = over.getBoundingClientRect()
      const pxX = ev.clientX - rect.left
      const hit = findCursorHit(pxX)
      if (hit) {
        dragRef.current = hit.target
      } else {
        // Empty plot area → pan.
        const u = plotRef.current!
        const xMin = u.scales.x.min, xMax = u.scales.x.max
        const yMin = u.scales.y.min, yMax = u.scales.y.max
        if (xMin == null || xMax == null || yMin == null || yMax == null) return
        dragRef.current = {
          kind: 'pan',
          startX: pxX,
          xMin, xMax,
          startY: ev.clientY - rect.top,
          yMin, yMax,
        }
      }
      over.setPointerCapture(ev.pointerId)
      ev.preventDefault()
    }
    const onPointerMove = (ev: PointerEvent) => {
      if (!over) return
      const rect = over.getBoundingClientRect()
      const pxX = ev.clientX - rect.left
      const pxY = ev.clientY - rect.top
      const t = dragRef.current
      if (!t) {
        // Hover: use the hit kind to pick the right affordance.
        const hit = findCursorHit(pxX)
        over.style.cursor = !hit ? 'grab'
          : hit.kind === 'edge' ? 'ew-resize'
          : 'move'
        return
      }
      if (t.kind === 'pan') {
        const u = plotRef.current!
        const x = pxToX(pxX)
        const x0 = u.posToVal(t.startX, 'x')
        const y = pxToY(pxY)
        const y0 = u.posToVal(t.startY, 'y')
        const dx = x - x0
        const dy = y - y0
        xRangeRef.current = [t.xMin - dx, t.xMax - dx]
        yRangeRef.current = [t.yMin - dy, t.yMax - dy]
        u.setScale('x', { min: xRangeRef.current[0], max: xRangeRef.current[1] })
        u.setScale('y', { min: yRangeRef.current[0], max: yRangeRef.current[1] })
        over.style.cursor = 'grabbing'
        return
      }
      const x = pxToX(pxX)
      const s = stateRef.current
      const cb = callbacksRef.current
      // Helper for whole-band moves — shifts both edges by the same x delta.
      const shift = (bandStart: number, pxStart: number) => {
        const dx = pxToX(pxX) - pxToX(pxStart)
        return dx
      }
      switch (t.kind) {
        case 'baseline-edge':
          cb.onBaselineChange({ ...s.baseline, [t.edge]: x }); break
        case 'baseline-band': {
          const dx = shift(t.startStart, t.startPxX)
          cb.onBaselineChange({ start: t.startStart + dx, end: t.startEnd + dx })
          over.style.cursor = 'move'
          break
        }
        case 'peak-edge': {
          const cur = s.slots[t.slot]
          cb.onSlotChange(t.slot, { peak: { ...cur.peak, [t.edge]: x } })
          break
        }
        case 'peak-band': {
          const dx = shift(t.startStart, t.startPxX)
          cb.onSlotChange(t.slot, { peak: { start: t.startStart + dx, end: t.startEnd + dx } })
          over.style.cursor = 'move'
          break
        }
        case 'fit-edge': {
          const cur = s.slots[t.slot]
          if (cur.fit) cb.onSlotChange(t.slot, { fit: { ...cur.fit, [t.edge]: x } })
          break
        }
        case 'fit-band': {
          const dx = shift(t.startStart, t.startPxX)
          cb.onSlotChange(t.slot, { fit: { start: t.startStart + dx, end: t.startEnd + dx } })
          over.style.cursor = 'move'
          break
        }
      }
    }
    const onPointerUp = (ev: PointerEvent) => {
      if (dragRef.current && over) {
        dragRef.current = null
        try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
        over.style.cursor = ''
      }
    }
    // Scroll-wheel zoom — X by default, Y when Alt/Option is held
    // (same modifier as the main TraceViewer). Zooms around the
    // pointer position so the user's focus stays in view.
    const onWheel = (ev: WheelEvent) => {
      if (!over || !hasData()) return
      const u = plotRef.current!
      ev.preventDefault()
      const rect = over.getBoundingClientRect()
      const pxX = ev.clientX - rect.left
      const pxY = ev.clientY - rect.top
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
      const xMin = u.scales.x.min, xMax = u.scales.x.max
      const yMin = u.scales.y.min, yMax = u.scales.y.max
      if (xMin == null || xMax == null || yMin == null || yMax == null) return
      if (ev.altKey) {
        const yAtCur = u.posToVal(pxY, 'y')
        yRangeRef.current = [
          yAtCur - (yAtCur - yMin) * factor,
          yAtCur + (yMax - yAtCur) * factor,
        ]
        xRangeRef.current = [xMin, xMax]
      } else {
        const xAtCur = u.posToVal(pxX, 'x')
        xRangeRef.current = [
          xAtCur - (xAtCur - xMin) * factor,
          xAtCur + (xMax - xAtCur) * factor,
        ]
        yRangeRef.current = [yMin, yMax]
      }
      // setScale forces uPlot to re-evaluate the scale (via the range
      // function, which now returns the new ref values). A bare
      // u.redraw() won't re-run range fns — it just repaints using
      // the previously-computed scale cache.
      u.setScale('x', { min: xRangeRef.current[0], max: xRangeRef.current[1] })
      u.setScale('y', { min: yRangeRef.current[0], max: yRangeRef.current[1] })
    }
    if (over) {
      over.addEventListener('pointerdown', onPointerDown)
      over.addEventListener('pointermove', onPointerMove)
      over.addEventListener('pointerup', onPointerUp)
      over.addEventListener('pointercancel', onPointerUp)
      over.addEventListener('wheel', onWheel, { passive: false })
    }

    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    return () => {
      // savedX/YRef are kept up to date by the setScale hook above — no
      // need to re-capture here. We just tear the plot + listeners down.
      if (over) {
        over.removeEventListener('pointerdown', onPointerDown)
        over.removeEventListener('pointermove', onPointerMove)
        over.removeEventListener('pointerup', onPointerUp)
        over.removeEventListener('pointercancel', onPointerUp)
        over.removeEventListener('wheel', onWheel)
      }
      ro.disconnect()
      plotRef.current?.destroy(); plotRef.current = null
    }
  // Plot is only rebuilt when the Y-axis label changes (channel /
  // unit change). Everything else — sweep switch, filter, zero-offset
  // — flows through setData below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceUnit])

  // --- DATA UPDATES --------------------------------------------------
  //
  // Push new samples into the existing plot. We pass
  // `resetScales=false` so uPlot never runs its autorange path — and
  // even if it did, it wouldn't matter, because the range functions
  // in opts.scales always return xRangeRef.current / yRangeRef.current
  // when those are set. Scales only change when the user
  // zooms/pans/clicks Reset, which update the refs explicitly.
  useEffect(() => {
    const u = plotRef.current
    if (!u || !data || data.time.length === 0) return
    const payload: uPlot.AlignedData = [
      Array.from(data.time),
      Array.from(data.values),
    ]
    const firstRealData = !hasRealDataRef.current
    u.setData(payload, false)
    if (firstRealData) {
      // Simulate a Reset-button click now that real data has arrived —
      // the initial mount drew against a placeholder so the axes
      // aren't sized for the real trace yet. This runs exactly once;
      // from here on sweep/filter changes flow through setData
      // without touching scales.
      hasRealDataRef.current = true
      xRangeRef.current = null
      yRangeRef.current = null
      const xmin = data.time[0]
      const xmax = data.time[data.time.length - 1]
      let ymin = Infinity, ymax = -Infinity
      for (const v of data.values) { if (v < ymin) ymin = v; if (v > ymax) ymax = v }
      if (isFinite(xmin) && isFinite(xmax) && xmax > xmin) {
        u.setScale('x', { min: xmin, max: xmax })
      }
      if (isFinite(ymin) && isFinite(ymax) && ymin !== ymax) {
        const pad = (ymax - ymin) * 0.05
        u.setScale('y', { min: ymin - pad, max: ymax + pad })
      }
    }
  }, [data])

  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])

  // Redraw on cursor / slot / result changes so bands and fit overlays
  // track the latest state. stateRef has already been updated above.
  useEffect(() => { plotRef.current?.redraw() }, [baseline, slots, measurements, previewSweep, displayYOffset])

  return (
    <div style={{
      height: '100%', border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)', position: 'relative',
    }}>
      <button
        className="btn"
        onClick={resetZoom}
        title="Reset zoom — rescales X and Y to the full sweep"
        style={{
          position: 'absolute', top: 4, right: 4, zIndex: 2,
          padding: '1px 8px', fontSize: 'var(--font-size-label)',
        }}
      >
        Reset
      </button>
      <span style={{
        position: 'absolute', top: 6, left: 10, zIndex: 2,
        fontSize: 'var(--font-size-label)', color: 'var(--text-muted)',
        fontStyle: 'italic', pointerEvents: 'none',
      }}>
        scroll = zoom X · ⌥ scroll = zoom Y · drag empty area = pan · drag inside a band = move · drag an edge = resize
      </span>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
      {(!data || data.time.length === 0) && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-muted)', fontStyle: 'italic',
          fontSize: 'var(--font-size-label)',
          pointerEvents: 'none',
        }}>
          Load a file to preview the trace here.
        </div>
      )}
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
    displayYOffset: number
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
  // Keep baseline green and fit purple so the palette matches the main
  // viewer; peak bands still cycle per-slot so the 10 slots are
  // distinguishable. CSS vars resolve at draw time so the theme honors
  // dark/light mode.
  const baselineColor = cssVar('--cursor-baseline') || '#4caf50'
  const fitColor = cssVar('--cursor-fit') || '#9c27b0'
  drawBand(state.baseline.start, state.baseline.end, baselineColor, 0.16, 'BL')
  state.slots.forEach((s, i) => {
    if (!s.enabled) return
    const color = SLOT_COLORS[i % SLOT_COLORS.length]
    drawBand(s.peak.start, s.peak.end, color, 0.18, `P${i + 1}`)
    if (s.fit) drawBand(s.fit.start, s.fit.end, fitColor, 0.14, `F${i + 1}`)
  })
}

function drawFits(
  u: uPlot,
  state: {
    baseline: { start: number; end: number }
    slots: CursorSlotConfig[]
    measurements: CursorMeasurement[]
    previewSweep: number
    displayYOffset: number
  },
) {
  const ctx = u.ctx
  const dpr = devicePixelRatio || 1
  const byKey = new Map<string, CursorMeasurement>()
  for (const m of state.measurements) {
    if (m.fit) byKey.set(`${m.sweep}:${m.slot}`, m)
  }
  const fitColor = cssVar('--cursor-fit') || '#9c27b0'
  const yShift = state.displayYOffset
  state.slots.forEach((s, i) => {
    if (!s.enabled || !s.fit) return
    const key = `${state.previewSweep}:${i}`
    const m = byKey.get(key) ?? byKey.get(`-1:${i}`)
    if (!m?.fit) return
    ctx.save()
    ctx.strokeStyle = fitColor
    ctx.lineWidth = 2 * dpr
    ctx.beginPath()
    const tArr = m.fit.fit_time
    const vArr = m.fit.fit_values
    for (let k = 0; k < tArr.length; k++) {
      const px = u.valToPos(tArr[k], 'x', true)
      // Shift fit Y values by the same zero-offset the backend applied
      // to the displayed trace, so fit and trace align on screen.
      const py = u.valToPos(vArr[k] - yShift, 'y', true)
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

  const fitCount = measurements.filter((m) => m.fit != null).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'stretch', gap: 0,
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
      }}>
        {([
          { id: 'measurements' as const, label: 'Measurements', count: measurements.length },
          { id: 'fit' as const, label: 'Fit', count: fitCount },
        ]).map((t) => {
          const active = activeTab === t.id
          // Handle via onMouseDown too — some browsers' synthetic click
          // flow can drop the click if the parent tree fires pointer
          // capture / drag handlers during the down-up window. Down
          // fires unconditionally.
          const fire = (e: React.SyntheticEvent) => {
            e.stopPropagation()
            setActiveTab(t.id)
          }
          return (
            <button
              key={t.id}
              type="button"
              onClick={fire}
              onMouseDown={fire}
              style={{
                cursor: 'pointer',
                userSelect: 'none',
                padding: '8px 16px',
                border: 'none',
                borderBottom: active ? '3px solid var(--accent)' : '3px solid transparent',
                background: active ? 'var(--bg-primary)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-muted)',
                fontSize: 'var(--font-size-sm)',
                fontFamily: 'var(--font-ui)',
                fontWeight: active ? 700 : 400,
                outline: 'none',
                minWidth: 110,
              }}
            >
              {t.label}
              {t.count > 0 && (
                <span style={{
                  marginLeft: 6,
                  fontSize: 'var(--font-size-label)',
                  color: 'var(--text-muted)',
                  fontWeight: 400,
                }}>({t.count})</span>
              )}
            </button>
          )
        })}
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', paddingRight: 4 }}>
          <ColumnsButton
            allColumns={allColumns}
            visibleIds={columns}
            lockedIds={lockedIds}
            onChange={setColumns}
          />
        </div>
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
