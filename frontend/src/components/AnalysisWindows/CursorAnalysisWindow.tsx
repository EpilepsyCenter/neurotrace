import React, { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useAppStore, CursorPositions } from '../../stores/appStore'
import { NumInput } from '../common/NumInput'

// Stimfit-style cursor-analysis window.
//
// The user defines ONE baseline window and up to 10 "slots", each of which
// owns a peak cursor pair and (optionally) a fit cursor pair + fit function.
// Results come back as one row per (sweep × slot), or one aggregate row per
// slot when ``average=true``.

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

type FitFunction = { id: string; label: string; params: string[] }

interface CursorPair { start: number; end: number }

interface Slot {
  enabled: boolean
  peak: CursorPair
  fit: CursorPair | null
  fitFunction: string | null
}

interface SlotMeasurement {
  slot: number
  sweep: number
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

const MAX_SLOTS = 10

// 10 visually distinct slot colors — same palette used for overlays so the
// bands in the mini-viewer match their row in the results table.
const SLOT_COLORS = [
  '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#a855f7',
  '#06b6d4', '#eab308', '#ec4899', '#14b8a6', '#8b5cf6',
]

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

function defaultSlot(peakStart: number, peakEnd: number): Slot {
  return {
    enabled: false,
    peak: { start: peakStart, end: peakEnd },
    fit: null,
    fitFunction: null,
  }
}

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

  // Tree selection.
  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
  const [channel, setChannel] = useState(mainTrace ?? 0)
  const hasSyncedRef = useRef(false)
  useEffect(() => {
    if (hasSyncedRef.current) return
    if (mainGroup == null && mainSeries == null && mainTrace == null) return
    hasSyncedRef.current = true
    if (mainGroup != null) setGroup(mainGroup)
    if (mainSeries != null) setSeries(mainSeries)
    if (mainTrace != null) setChannel(mainTrace)
  }, [mainGroup, mainSeries, mainTrace])

  // Reset bounds on file change.
  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    if (ser && series >= ser.length) setSeries(0)
  }, [fileInfo, group, series])

  const channels = useMemo(() => channelsForSeries(fileInfo, group, series), [fileInfo, group, series])
  useEffect(() => {
    if (channels.length > 0 && channel >= channels.length) setChannel(0)
  }, [channels, channel])

  const totalSweeps: number = fileInfo?.groups?.[group]?.series?.[series]?.sweepCount ?? 0

  // Sweep selection — same three modes as IVCurveWindow, plus an "average"
  // toggle that collapses the selection into a single averaged trace.
  type RunMode = 'all' | 'range' | 'one'
  const [runMode, setRunMode] = useState<RunMode>('all')
  const [sweepFrom, setSweepFrom] = useState(1)
  const [sweepTo, setSweepTo] = useState(Math.max(1, totalSweeps))
  const [sweepOne, setSweepOne] = useState(1)
  const [average, setAverage] = useState(false)
  useEffect(() => {
    if (totalSweeps > 0) {
      setSweepFrom(1)
      setSweepTo(totalSweeps)
      setSweepOne((s) => Math.min(Math.max(1, s), totalSweeps))
    }
  }, [totalSweeps])

  // Baseline window — seeded from the global cursor on first mount, then
  // lives independently (users can override via the two NumInputs or a
  // "from main" button).
  const [baseline, setBaseline] = useState<CursorPair>({
    start: cursors.baselineStart,
    end: cursors.baselineEnd,
  })
  const [baselineMethod, setBaselineMethod] = useState<'mean' | 'median'>('mean')
  const seededBaselineRef = useRef(false)
  useEffect(() => {
    if (seededBaselineRef.current) return
    seededBaselineRef.current = true
    setBaseline({ start: cursors.baselineStart, end: cursors.baselineEnd })
  }, [cursors.baselineStart, cursors.baselineEnd])

  // Slots. Slot 0 enabled by default and seeded from the main peak cursor;
  // remaining slots start disabled with the same default window so the user
  // can quickly toggle them on.
  const [slots, setSlots] = useState<Slot[]>(() =>
    Array.from({ length: MAX_SLOTS }, (_, i) => {
      const s = defaultSlot(cursors.peakStart, cursors.peakEnd)
      if (i === 0) s.enabled = true
      return s
    }),
  )

  // AP-mode toggle + threshold slope.
  const [computeAP, setComputeAP] = useState(false)
  const [apSlope, setApSlope] = useState(20.0)

  // Fit function catalog (loaded once per window).
  const [fitFunctions, setFitFunctions] = useState<FitFunction[]>([])
  useEffect(() => {
    if (!backendUrl) return
    fetch(`${backendUrl}/api/cursors/functions`)
      .then((r) => r.json())
      .then((d) => setFitFunctions(d.functions ?? []))
      .catch(() => { /* ignore */ })
  }, [backendUrl])

  // Results.
  const [running, setRunning] = useState(false)
  const [measurements, setMeasurements] = useState<SlotMeasurement[]>([])
  const [traceUnit, setTraceUnit] = useState('')
  const [lastFitByKey, setLastFitByKey] = useState<Map<string, SlotMeasurement>>(new Map())

  // Mini-viewer trace data (the first sweep in the selection, or the average).
  const [previewData, setPreviewData] = useState<{ time: number[]; values: number[] } | null>(null)
  const previewSweep = useMemo(() => {
    if (runMode === 'one') return Math.max(0, Math.min(totalSweeps - 1, sweepOne - 1))
    if (runMode === 'range') return Math.max(0, Math.min(totalSweeps - 1, sweepFrom - 1))
    return 0
  }, [runMode, sweepFrom, sweepOne, totalSweeps])
  useEffect(() => {
    if (!backendUrl || !fileInfo || totalSweeps === 0) { setPreviewData(null); return }
    let cancelled = false
    const qs = new URLSearchParams({
      group: String(group),
      series: String(series),
      trace: String(channel),
      sweep: String(previewSweep),
      max_points: '4000',
    })
    fetch(`${backendUrl}/api/traces/data?${qs}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setPreviewData({ time: d.time ?? [], values: d.values ?? [] }) })
      .catch(() => { if (!cancelled) setPreviewData(null) })
    return () => { cancelled = true }
  }, [backendUrl, fileInfo, group, series, channel, previewSweep, totalSweeps])

  // ---- Run ----
  const onRun = async () => {
    if (!backendUrl || !fileInfo) return
    setRunning(true)
    setError(null)
    try {
      let sweepIndices: number[] | null = null
      if (runMode === 'range') {
        const lo = Math.max(1, Math.min(sweepFrom, totalSweeps))
        const hi = Math.max(lo, Math.min(sweepTo, totalSweeps))
        sweepIndices = []
        for (let i = lo - 1; i <= hi - 1; i++) sweepIndices.push(i)
      } else if (runMode === 'one') {
        const sw = Math.max(1, Math.min(sweepOne, totalSweeps))
        sweepIndices = [sw - 1]
      }
      const body = {
        group, series, trace: channel,
        sweeps: sweepIndices,
        average,
        baseline,
        baseline_method: baselineMethod,
        slots: slots.map((s) => ({
          enabled: s.enabled,
          peak: s.peak,
          fit: s.fit,
          fit_function: s.fit && s.fitFunction ? s.fitFunction : null,
        })),
        compute_ap: computeAP,
        ap_slope_vs: apSlope,
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
      setMeasurements(data.measurements ?? [])
      setTraceUnit(data.trace_unit ?? '')
      // Remember the most recent fit per (sweep, slot) so the mini-viewer
      // can overlay fit curves without re-fetching.
      const fits = new Map<string, SlotMeasurement>()
      for (const m of (data.measurements ?? []) as SlotMeasurement[]) {
        if (m.fit) fits.set(`${m.sweep}:${m.slot}`, m)
      }
      setLastFitByKey(fits)
    } catch (err: any) {
      setError(err.message || 'Run failed')
    } finally {
      setRunning(false)
    }
  }

  const onClear = () => { setMeasurements([]); setLastFitByKey(new Map()) }

  const onExportCSV = async () => {
    if (measurements.length === 0) return
    const header = [
      'sweep', 'slot', 'baseline', 'baseline_sd', 'peak', 'peak_time', 'amplitude',
      'time_to_peak', 'rise_time_10_90', 'rise_time_20_80', 'half_width',
      'max_slope_rise', 'max_slope_decay', 'rise_decay_ratio', 'area',
      'ap_threshold', 'ap_threshold_time',
      'fit_function', 'fit_r2', 'fit_rss', 'fit_params',
    ]
    const rows = measurements.map((m) => [
      m.sweep === -1 ? 'avg' : String(m.sweep + 1),
      String(m.slot + 1),
      fmt(m.baseline, 6), fmt(m.baseline_sd, 6),
      fmt(m.peak, 6), fmt(m.peak_time, 6), fmt(m.amplitude, 6),
      fmt(m.time_to_peak, 6),
      fmt(m.rise_time_10_90, 6), fmt(m.rise_time_20_80, 6),
      fmt(m.half_width, 6),
      fmt(m.max_slope_rise, 6), fmt(m.max_slope_decay, 6),
      fmt(m.rise_decay_ratio, 6), fmt(m.area, 6),
      fmt(m.ap_threshold, 6), fmt(m.ap_threshold_time, 6),
      m.fit?.function ?? '',
      fmt(m.fit?.r_squared, 4), fmt(m.fit?.rss, 6),
      m.fit ? Object.entries(m.fit.params).map(([k, v]) => `${k}=${v.toFixed(6)}`).join(';') : '',
    ])
    const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n')
    const name = (fileInfo?.fileName ?? 'cursor_analysis').replace(/\.[^.]+$/, '') + '_cursors.csv'
    const api = window.electronAPI
    if (api?.saveFileDialog) {
      const path = await api.saveFileDialog(name, [{ name: 'CSV', extensions: ['csv'] }])
      if (!path) return
      // Fall through to write via the backend's /api/results endpoint, which
      // has filesystem access. Simpler: post a blob URL download instead —
      // avoids needing a new backend endpoint.
      const blob = new Blob([csv], { type: 'text/csv' })
      triggerDownload(blob, name)
    } else {
      triggerDownload(new Blob([csv], { type: 'text/csv' }), name)
    }
  }

  // ---- Slot edits ----
  const updateSlot = (i: number, patch: Partial<Slot>) => {
    setSlots((prev) => prev.map((s, k) => (k === i ? { ...s, ...patch } : s)))
  }

  // Splitter between mini-viewer and results table.
  const [plotHeight, setPlotHeight] = useState(220)
  const onSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = plotHeight
    const onMove = (ev: MouseEvent) => {
      setPlotHeight(Math.max(120, Math.min(600, startH + (ev.clientY - startY))))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 10, gap: 8, minHeight: 0,
    }}>
      {/* Top selectors */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Field label="Group">
          <select value={group} onChange={(e) => setGroup(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups ?? []).map((g: any, i: number) => (
              <option key={i} value={i}>{g.label || `G${i + 1}`}</option>
            ))}
          </select>
        </Field>
        <Field label="Series">
          <select value={series} onChange={(e) => setSeries(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => (
              <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
            ))}
          </select>
        </Field>
        <Field label="Channel">
          <select value={channel} onChange={(e) => setChannel(Number(e.target.value))} disabled={channels.length === 0}>
            {channels.map((c: any) => (
              <option key={c.index} value={c.index}>{c.label} ({c.units})</option>
            ))}
          </select>
        </Field>
      </div>

      {/* Sweep selection + average toggle */}
      <div style={{
        display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
        padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>Run on:</span>
        <RunModeRadios runMode={runMode} setRunMode={setRunMode} />
        {runMode === 'range' && (
          <RangeSpan from={sweepFrom} to={sweepTo} total={totalSweeps} setFrom={setSweepFrom} setTo={setSweepTo} />
        )}
        {runMode === 'one' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <NumInput value={sweepOne} step={1} min={1} max={Math.max(1, totalSweeps)}
              onChange={(v) => setSweepOne(Math.max(1, Math.round(v)))} style={{ width: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
              / {totalSweeps || '—'}
            </span>
          </span>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 12, fontSize: 'var(--font-size-label)' }}>
          <input type="checkbox" checked={average} onChange={(e) => setAverage(e.target.checked)} />
          Average selected sweeps first
        </label>
        <button className="btn btn-primary" onClick={onRun}
          disabled={running || !fileInfo} style={{ marginLeft: 'auto' }}>
          {running ? 'Running…' : 'Run'}
        </button>
        <button className="btn" onClick={onClear} disabled={measurements.length === 0}>Clear</button>
        <button className="btn" onClick={onExportCSV} disabled={measurements.length === 0}>
          Export CSV
        </button>
      </div>

      {/* Baseline + AP settings */}
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
        padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', fontSize: 'var(--font-size-label)',
      }}>
        <span style={{ fontWeight: 600, color: 'var(--cursor-baseline)' }}>Baseline</span>
        <NumInput value={baseline.start} step={0.001}
          onChange={(v) => setBaseline((b) => ({ ...b, start: v }))} style={{ width: 70 }} />
        <span style={{ color: 'var(--text-muted)' }}>→</span>
        <NumInput value={baseline.end} step={0.001}
          onChange={(v) => setBaseline((b) => ({ ...b, end: v }))} style={{ width: 70 }} />
        <span style={{ color: 'var(--text-muted)' }}>s</span>
        <label style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          Method:
          <select value={baselineMethod} onChange={(e) => setBaselineMethod(e.target.value as any)}>
            <option value="mean">mean</option>
            <option value="median">median</option>
          </select>
        </label>
        <button
          className="btn"
          style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}
          onClick={() => setBaseline({ start: cursors.baselineStart, end: cursors.baselineEnd })}
          title="Copy baseline cursor values from the main viewer"
        >
          ← main
        </button>
        <span style={{ marginLeft: 'auto' }}>
          <label style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <input type="checkbox" checked={computeAP} onChange={(e) => setComputeAP(e.target.checked)} />
            AP mode (threshold at
            <NumInput value={apSlope} step={1} onChange={(v) => setApSlope(v)} style={{ width: 44 }} />
            V/s)
          </label>
        </span>
      </div>

      {/* Slots table */}
      <div style={{
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)', padding: '4px 6px',
        overflow: 'auto', maxHeight: 260, flexShrink: 0,
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
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {slots.map((slot, i) => (
              <SlotRow
                key={i}
                index={i}
                slot={slot}
                fitFunctions={fitFunctions}
                cursors={cursors}
                onChange={(patch) => updateSlot(i, patch)}
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

      {/* Mini-viewer + results split */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ height: plotHeight, minHeight: 120, flexShrink: 0 }}>
          <MiniViewer
            data={previewData}
            heightSignal={plotHeight}
            baseline={baseline}
            slots={slots}
            traceUnit={traceUnit}
            fitByKey={lastFitByKey}
            previewSweep={previewSweep}
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

        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <ResultsTable measurements={measurements} traceUnit={traceUnit} fitFunctions={fitFunctions} />
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

function RunModeRadios({
  runMode, setRunMode,
}: {
  runMode: 'all' | 'range' | 'one'
  setRunMode: (m: 'all' | 'range' | 'one') => void
}) {
  return (
    <>
      {(['all', 'range', 'one'] as const).map((m) => (
        <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
          <input type="radio" name="cursor-run-mode" value={m}
            checked={runMode === m} onChange={() => setRunMode(m)} />
          {m === 'all' ? 'all sweeps' : m === 'range' ? 'range' : 'single sweep'}
        </label>
      ))}
    </>
  )
}

function RangeSpan({
  from, to, total, setFrom, setTo,
}: {
  from: number; to: number; total: number
  setFrom: (n: number) => void; setTo: (n: number) => void
}) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
      <NumInput value={from} step={1} min={1} max={Math.max(1, total)}
        onChange={(v) => setFrom(Math.max(1, Math.round(v)))} style={{ width: 48 }} />
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>–</span>
      <NumInput value={to} step={1} min={1} max={Math.max(1, total)}
        onChange={(v) => setTo(Math.max(1, Math.round(v)))} style={{ width: 48 }} />
      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
        / {total || '—'}
      </span>
    </span>
  )
}

function SlotRow({
  index, slot, fitFunctions, cursors, onChange,
}: {
  index: number
  slot: Slot
  fitFunctions: FitFunction[]
  cursors: CursorPositions
  onChange: (patch: Partial<Slot>) => void
}) {
  const color = SLOT_COLORS[index % SLOT_COLORS.length]
  const fitEnabled = slot.fit != null
  return (
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
        <button className="btn" title="Copy peak window from main viewer cursor"
          style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}
          onClick={() => onChange({ peak: { start: cursors.peakStart, end: cursors.peakEnd } })}>
          ← main
        </button>
      </Td>
    </tr>
  )
}

function MiniViewer({
  data, heightSignal, baseline, slots, traceUnit, fitByKey, previewSweep,
}: {
  data: { time: number[]; values: number[] } | null
  heightSignal: number
  baseline: CursorPair
  slots: Slot[]
  traceUnit: string
  fitByKey: Map<string, SlotMeasurement>
  previewSweep: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const bandsRef = useRef({ baseline, slots, fitByKey, previewSweep })
  bandsRef.current = { baseline, slots, fitByKey, previewSweep }

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
      cursor: { drag: { x: false, y: false } },
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
        drawClear: [(u) => drawBands(u, bandsRef.current)],
        draw: [(u) => drawFits(u, bandsRef.current)],
      },
    }
    plotRef.current = new uPlot(opts, [data.time, data.values], el)

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

  // Any band or fit change → just redraw.
  useEffect(() => { plotRef.current?.redraw() }, [baseline, slots, fitByKey])

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
      background: 'var(--bg-primary)',
    }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

function drawBands(
  u: uPlot,
  state: { baseline: CursorPair; slots: Slot[]; fitByKey: Map<string, SlotMeasurement>; previewSweep: number },
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
  // Baseline first (behind everything)
  drawBand(state.baseline.start, state.baseline.end, '#888', 0.12, 'BL')
  // Enabled slots
  state.slots.forEach((s, i) => {
    if (!s.enabled) return
    const color = SLOT_COLORS[i % SLOT_COLORS.length]
    drawBand(s.peak.start, s.peak.end, color, 0.18, `P${i + 1}`)
    if (s.fit) drawBand(s.fit.start, s.fit.end, color, 0.08, `F${i + 1}`)
  })
}

function drawFits(
  u: uPlot,
  state: { baseline: CursorPair; slots: Slot[]; fitByKey: Map<string, SlotMeasurement>; previewSweep: number },
) {
  const ctx = u.ctx
  const dpr = devicePixelRatio || 1
  state.slots.forEach((s, i) => {
    if (!s.enabled || !s.fit) return
    // Prefer the fit from the currently-previewed sweep; fall back to any
    // available fit (e.g. the averaged-trace fit has sweep = -1).
    const key = `${state.previewSweep}:${i}`
    const altKey = `-1:${i}`
    const m = state.fitByKey.get(key) ?? state.fitByKey.get(altKey)
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

function ResultsTable({
  measurements, traceUnit, fitFunctions,
}: {
  measurements: SlotMeasurement[]
  traceUnit: string
  fitFunctions: FitFunction[]
}) {
  if (measurements.length === 0) {
    return (
      <div style={{
        padding: 16, textAlign: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
        border: '1px dashed var(--border)', borderRadius: 4,
        height: '100%',
      }}>
        Click Run to populate the results table.
      </div>
    )
  }

  const fnLabel = (id?: string) => id ? (fitFunctions.find((f) => f.id === id)?.label ?? id) : ''

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 4,
      overflow: 'auto', height: '100%',
    }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: 'var(--font-size-label)', fontFamily: 'var(--font-mono)',
      }}>
        <thead>
          <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left', position: 'sticky', top: 0 }}>
            <Th>Sweep</Th>
            <Th>Slot</Th>
            <Th>Baseline ({traceUnit})</Th>
            <Th>Peak</Th>
            <Th>Amp</Th>
            <Th>t<sub>peak</sub> (ms)</Th>
            <Th>RT 10–90 (ms)</Th>
            <Th>RT 20–80 (ms)</Th>
            <Th>t½ (ms)</Th>
            <Th>Rise slope</Th>
            <Th>Decay slope</Th>
            <Th>R/D</Th>
            <Th>Area</Th>
            <Th>AP thr</Th>
            <Th>Fit</Th>
            <Th>R²</Th>
            <Th>Params</Th>
          </tr>
        </thead>
        <tbody>
          {measurements.map((m, i) => (
            <tr key={i} style={{
              borderTop: '1px solid var(--border)',
              background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
            }}>
              <Td>{m.sweep === -1 ? 'avg' : m.sweep + 1}</Td>
              <Td>
                <span style={{
                  display: 'inline-block', width: 14, height: 14, borderRadius: 2,
                  background: SLOT_COLORS[m.slot % SLOT_COLORS.length],
                  color: '#000', fontWeight: 700, textAlign: 'center', lineHeight: '14px',
                  fontSize: 10,
                }}>{m.slot + 1}</span>
              </Td>
              <Td>{fmt(m.baseline, 3)}</Td>
              <Td>{fmt(m.peak, 3)}</Td>
              <Td>{fmt(m.amplitude, 3)}</Td>
              <Td>{fmtMs(m.peak_time)}</Td>
              <Td>{fmtMs(m.rise_time_10_90)}</Td>
              <Td>{fmtMs(m.rise_time_20_80)}</Td>
              <Td>{fmtMs(m.half_width)}</Td>
              <Td>{fmt(m.max_slope_rise, 2)}</Td>
              <Td>{fmt(m.max_slope_decay, 2)}</Td>
              <Td>{fmt(m.rise_decay_ratio, 3)}</Td>
              <Td>{fmt(m.area, 3)}</Td>
              <Td>{fmt(m.ap_threshold, 3)}</Td>
              <Td>{fnLabel(m.fit?.function)}</Td>
              <Td>{fmt(m.fit?.r_squared, 4)}</Td>
              <Td style={{ whiteSpace: 'normal', maxWidth: 260 }}>
                {m.fit ? Object.entries(m.fit.params).map(([k, v]) =>
                  `${k}=${v.toPrecision(4)}`).join(', ') : ''}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const Th = ({ children }: { children?: React.ReactNode }) => (
  <th style={{ padding: '4px 8px', fontWeight: 600, fontSize: 'var(--font-size-label)', whiteSpace: 'nowrap' }}>
    {children}
  </th>
)
const Td = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', ...style }}>{children}</td>
)

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
