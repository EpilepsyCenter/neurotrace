import React, { useState, useEffect, useRef, useCallback } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { CursorPositions, StimulusInfo } from '../../stores/appStore'
import { useThemeStore } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function fmt(v: number | null | undefined, digits: number, unit: string): string {
  if (v == null || !isFinite(v)) return '—'
  return `${v.toFixed(digits)} ${unit}`
}

interface MeasurementRow {
  series: string
  sweep: number | string
  rs: number | null
  rin: number | null
  cm: number | null
  tau: number | null
  fit_r_squared: number | null
  source: string
}

interface Props {
  backendUrl: string
  fileInfo: any
  cursors: CursorPositions
  currentSweep: number
}

export function ResistanceWindow({ backendUrl, fileInfo, cursors, currentSweep }: Props) {
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)

  const [currentGroup, setCurrentGroup] = useState(0)
  const [currentSeries, setCurrentSeries] = useState(0)
  const [vStep, setVStep] = useState(5)
  const [avgFrom, setAvgFrom] = useState(1)
  const [avgTo, setAvgTo] = useState(1)
  const [nExp, setNExp] = useState(2)
  const [fitDurationMs, setFitDurationMs] = useState(5.0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [measurements, setMeasurements] = useState<MeasurementRow[]>([])

  // Trace data for embedded viewer
  const [traceTime, setTraceTime] = useState<number[] | null>(null)
  const [traceValues, setTraceValues] = useState<number[] | null>(null)
  const [fitTime, setFitTime] = useState<number[] | null>(null)
  const [fitValues, setFitValues] = useState<number[] | null>(null)
  const [fitStartOffset, setFitStartOffset] = useState(0) // samples from pulse_start
  const [traceLabel, setTraceLabel] = useState('')

  const traceChartRef = useRef<HTMLDivElement>(null)
  const tracePlotRef = useRef<uPlot | null>(null)

  // Derived
  const groups = fileInfo?.groups || []
  const seriesList = groups[currentGroup]?.series || []
  const currentSeriesInfo = seriesList[currentSeries]
  const totalSweeps = currentSeriesInfo?.sweepCount ?? 0
  const stimulus: StimulusInfo | null = currentSeriesInfo?.stimulus ?? null
  const filePath = fileInfo?.filePath || ''

  // Auto-populate V_step from stimulus
  useEffect(() => {
    if (stimulus) setVStep(Number(stimulus.vStepAbsolute.toFixed(2)))
  }, [stimulus?.vStepAbsolute])

  // Auto-populate sweep range
  useEffect(() => {
    if (totalSweeps > 0) { setAvgFrom(1); setAvgTo(totalSweeps) }
  }, [currentGroup, currentSeries, totalSweeps])

  // Fetch persisted results on mount (global per file, not per series)
  const fetchStored = useCallback(async () => {
    if (!backendUrl || !filePath) return
    try {
      const resp = await fetch(`${backendUrl}/api/results/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysis_type: 'resistance', file_path: filePath, group: 0, series: 0 }),
      })
      if (resp.ok) {
        const data = await resp.json()
        setMeasurements(data.measurements || [])
      }
    } catch { /* ignore */ }
  }, [backendUrl, filePath])

  useEffect(() => { fetchStored() }, [fetchStored])

  const storeRows = async (rows: MeasurementRow[]) => {
    try {
      await fetch(`${backendUrl}/api/results/store`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis_type: 'resistance', file_path: filePath,
          group: 0, series: 0,
          slot: 'measurements', data: rows,
        }),
      })
    } catch { /* ignore */ }
  }

  // ---- Load trace for embedded viewer ----
  const loadTrace = useCallback(async (sweepIdx: number) => {
    if (!backendUrl) return
    try {
      const resp = await fetch(
        `${backendUrl}/api/traces/data?group=${currentGroup}&series=${currentSeries}&sweep=${sweepIdx}&trace=0&max_points=0`
      )
      if (resp.ok) {
        const data = await resp.json()
        setTraceTime(data.time)
        setTraceValues(data.values)
        setTraceLabel(`Sweep ${sweepIdx + 1}`)
      }
    } catch { /* ignore */ }
  }, [backendUrl, currentGroup, currentSeries])

  useEffect(() => {
    if (totalSweeps > 0) loadTrace(currentSweep)
  }, [currentSweep, loadTrace, totalSweeps])

  // ---- Common analysis params ----
  const analysisParams = () => ({
    v_step: vStep, n_exp: nExp, fit_duration_ms: fitDurationMs,
  })

  // Current series label for tagging rows
  const seriesLabel = `${currentSeries + 1}: ${currentSeriesInfo?.label || 'Series'}`

  const toRow = (m: any, source: string, sweep: number | string): MeasurementRow => ({
    series: seriesLabel,
    sweep,
    rs: m.rs ?? null,
    rin: m.rin ?? null,
    cm: m.cm ?? null,
    tau: m.tau ?? null,
    fit_r_squared: m.fit_r_squared ?? null,
    source,
  })

  const applyFit = (m: any) => {
    if (m.fit_time_ms && m.fit_values) {
      setFitTime(m.fit_time_ms)
      setFitValues(m.fit_values)
      setFitStartOffset(m.fit_start_offset ?? 0)
    } else {
      setFitTime(null); setFitValues(null); setFitStartOffset(0)
    }
  }

  // ---- API: single sweep ----
  const runSingle = async (sweepIdx: number) => {
    setLoading(true); setError(null)
    try {
      const resp = await fetch(`${backendUrl}/api/analysis/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis_type: 'resistance',
          group: currentGroup, series: currentSeries, sweep: sweepIdx, trace: 0,
          cursors, params: analysisParams(),
        }),
      })
      if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText)
      const data = await resp.json()
      const row = toRow(data.measurement, `sweep ${sweepIdx + 1}`, sweepIdx + 1)
      setMeasurements((prev) => [...prev, row])
      await storeRows([row])
      applyFit(data.measurement)
    } catch (err: any) { setError(err.message) }
    setLoading(false)
  }

  // ---- API: averaged ----
  const runAveraged = async () => {
    setLoading(true); setError(null)
    try {
      const from = Math.max(1, Math.min(avgFrom, totalSweeps))
      const to = Math.max(from, Math.min(avgTo, totalSweeps))
      const indices: number[] = []
      for (let i = from - 1; i <= to - 1; i++) indices.push(i)

      // Load the averaged trace for the viewer
      const trResp = await fetch(
        `${backendUrl}/api/traces/average?group=${currentGroup}&series=${currentSeries}&trace=0&sweep_start=${from - 1}&sweep_end=${to}&max_points=0`
      )
      if (trResp.ok) {
        const td = await trResp.json()
        setTraceTime(td.time); setTraceValues(td.values); setTraceLabel(`Avg ${from}–${to}`)
      }

      const resp = await fetch(`${backendUrl}/api/analysis/run_averaged`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis_type: 'resistance',
          group: currentGroup, series: currentSeries, trace: 0,
          sweep_indices: indices, cursors, params: analysisParams(),
        }),
      })
      if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText)
      const data = await resp.json()
      const row = toRow(data.measurement, `avg ${from}–${to}`, `avg ${from}–${to}`)
      setMeasurements((prev) => [...prev, row])
      await storeRows([row])
      applyFit(data.measurement)
    } catch (err: any) { setError(err.message) }
    setLoading(false)
  }

  // ---- API: all sweeps (batch → per-sweep rows in the table) ----
  const runAllSweeps = async () => {
    setLoading(true); setError(null)
    try {
      const resp = await fetch(`${backendUrl}/api/analysis/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis_type: 'resistance',
          group: currentGroup, series: currentSeries, trace: 0,
          sweep_start: 0, sweep_end: totalSweeps,
          cursors, params: analysisParams(),
        }),
      })
      if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText)
      const data = await resp.json()

      const rows: MeasurementRow[] = (data.results || []).map((r: any) => {
        const swIdx = r.sweep_index ?? 0
        return toRow(r, `sweep ${swIdx + 1}`, swIdx + 1)
      })

      setMeasurements((prev) => [...prev, ...rows])
      await storeRows(rows)
    } catch (err: any) { setError(err.message) }
    setLoading(false)
  }

  const clearResults = async () => {
    setMeasurements([]); setFitTime(null); setFitValues(null)
    try {
      await fetch(`${backendUrl}/api/results/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysis_type: 'resistance', file_path: filePath, group: 0, series: 0 }),
      })
    } catch { /* ignore */ }
  }

  // ---- Embedded trace chart with fit overlay ----
  useEffect(() => {
    const container = traceChartRef.current
    if (!container || !traceTime || !traceValues) {
      if (tracePlotRef.current) { tracePlotRef.current.destroy(); tracePlotRef.current = null }
      return
    }

    const frameId = requestAnimationFrame(() => {
      if (tracePlotRef.current) { tracePlotRef.current.destroy(); tracePlotRef.current = null }

      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 100)

      const plotData: uPlot.AlignedData = [traceTime, traceValues]
      const series: uPlot.Series[] = [
        {},
        { label: 'Trace', stroke: cssVar('--trace-color-1'), width: 1.5, scale: 'y' },
      ]

      // Overlay exponential fit if available
      if (fitTime && fitValues && fitTime.length > 0) {
        // Fit time is in ms relative to the peak position.
        // Peak is at fitStartOffset samples after pulse_start cursor.
        const sr = traceTime.length > 1 ? 1 / (traceTime[1] - traceTime[0]) : 10000
        const peakTimeS = cursors.peakStart + fitStartOffset / sr
        const fitTimeS = fitTime.map((t) => peakTimeS + t / 1000)
        const lastRow = measurements[measurements.length - 1]
        // We need the baseline to shift the fit (which is baseline-subtracted) back to raw
        // For simplicity, get it from the trace itself at the baseline cursor region
        const blIdx0 = Math.max(0, Math.round(cursors.baselineStart / (traceTime[1] - traceTime[0])))
        const blIdx1 = Math.max(blIdx0 + 1, Math.round(cursors.baselineEnd / (traceTime[1] - traceTime[0])))
        let bl = 0
        if (blIdx1 <= traceValues.length) {
          let sum = 0
          for (let i = blIdx0; i < blIdx1; i++) sum += traceValues[i]
          bl = sum / (blIdx1 - blIdx0)
        }

        const fitInterp = new Array(traceTime.length).fill(null)
        let fi = 0
        for (let i = 0; i < traceTime.length; i++) {
          const t = traceTime[i]
          if (t >= fitTimeS[0] && t <= fitTimeS[fitTimeS.length - 1]) {
            while (fi < fitTimeS.length - 1 && fitTimeS[fi + 1] < t) fi++
            if (fi < fitTimeS.length - 1) {
              const frac = (t - fitTimeS[fi]) / (fitTimeS[fi + 1] - fitTimeS[fi])
              fitInterp[i] = fitValues[fi] + frac * (fitValues[fi + 1] - fitValues[fi]) + bl
            }
          }
        }
        plotData.push(fitInterp as any)
        series.push({ label: 'Fit', stroke: cssVar('--stimulus-color'), width: 2.5, scale: 'y' })
      }

      const opts: uPlot.Options = {
        width: w, height: h,
        cursor: { drag: { x: true, y: true, uni: 50 } },
        scales: { x: { time: false }, y: {} },
        axes: [
          { stroke: cssVar('--chart-axis'), grid: { stroke: cssVar('--chart-grid'), width: 1 }, ticks: { stroke: cssVar('--chart-tick'), width: 1 }, label: 'Time (s)', labelSize: 14, font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`, labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}` },
          { stroke: cssVar('--chart-axis'), grid: { stroke: cssVar('--chart-grid'), width: 1 }, ticks: { stroke: cssVar('--chart-tick'), width: 1 }, label: 'pA', labelSize: 14, font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`, labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`, scale: 'y' },
        ],
        series,
      }

      tracePlotRef.current = new uPlot(opts, plotData, container)
    })

    return () => { cancelAnimationFrame(frameId); tracePlotRef.current?.destroy(); tracePlotRef.current = null }
  }, [traceTime, traceValues, fitTime, fitValues, fitStartOffset, theme, fontSize, cursors.peakStart, cursors.baselineStart, cursors.baselineEnd])

  // Resize observer
  useEffect(() => {
    const el = traceChartRef.current
    if (!el) return
    const obs = new ResizeObserver(() => {
      const u = tracePlotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0)
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // ---- CSV export ----
  const exportCSV = () => {
    const cols = ['Series', 'Sweep', 'Rs (MΩ)', 'Rin (MΩ)', 'Cm (pF)', 'τ (ms)', 'R²']
    const rows = measurements.map((r) =>
      [r.series, r.sweep, fmt(r.rs, 2, ''), fmt(r.rin, 2, ''), fmt(r.cm, 2, ''), fmt(r.tau, 3, ''), r.fit_r_squared?.toFixed(4) ?? ''].join(',')
    )
    const csv = [cols.join(','), ...rows].join('\n')
    navigator.clipboard.writeText(csv)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ---- Settings ---- */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, background: 'var(--bg-secondary)' }}>
        {/* Series */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', minWidth: 45 }}>Series:</label>
          <select
            value={`${currentGroup}-${currentSeries}`}
            onChange={(e) => { const [g, s] = e.target.value.split('-').map(Number); setCurrentGroup(g); setCurrentSeries(s); setFitTime(null); setFitValues(null) }}
            style={{ flex: 1 }}
          >
            {groups.map((g: any) => g.series.map((s: any) => (
              <option key={`${g.index}-${s.index}`} value={`${g.index}-${s.index}`}>
                {g.label} / {s.label} ({s.sweepCount} sw)
              </option>
            )))}
          </select>
        </div>

        {/* Params row */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', display: 'block' }}>
              V<sub>step</sub> (mV) {stimulus && <span style={{ color: 'var(--accent)' }}>auto</span>}
            </label>
            <NumInput value={vStep} step={1} onChange={setVStep} style={{ width: 65 }} />
          </div>
          <div>
            <label style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', display: 'block' }}>Exp fit</label>
            <select value={nExp} onChange={(e) => setNExp(Number(e.target.value))} style={{ width: 65 }}>
              <option value={1}>Mono</option>
              <option value={2}>Bi</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', display: 'block' }}>Fit (ms)</label>
            <NumInput value={fitDurationMs} step={0.5} min={0.5} max={50} onChange={setFitDurationMs} style={{ width: 55 }} />
          </div>
          <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', background: 'var(--bg-primary)', padding: '3px 6px', borderRadius: 3, border: '1px solid var(--border)', lineHeight: 1.5 }}>
            BL: {cursors.baselineStart.toFixed(3)}→{cursors.baselineEnd.toFixed(3)}s
            <br/>PK: {cursors.peakStart.toFixed(3)}→{cursors.peakEnd.toFixed(3)}s
          </div>
        </div>

        {/* Run buttons */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => runSingle(currentSweep)} disabled={loading || totalSweeps === 0}>
            {loading ? 'Running…' : `Sweep ${currentSweep + 1}`}
          </button>
          <NumInput value={avgFrom} min={1} max={totalSweeps} step={1} onChange={(v) => setAvgFrom(Math.max(1, Math.round(v)))} style={{ width: 42 }} />
          <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>–</span>
          <NumInput value={avgTo} min={1} max={totalSweeps} step={1} onChange={(v) => setAvgTo(Math.max(1, Math.round(v)))} style={{ width: 42 }} />
          <button className="btn" onClick={runAveraged} disabled={loading || totalSweeps === 0}>Averaged</button>
          <button className="btn" onClick={runAllSweeps} disabled={loading || totalSweeps === 0}>All sweeps</button>
          {measurements.length > 0 && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <button className="btn" onClick={exportCSV}>Copy CSV</button>
              <button className="btn" onClick={clearResults}>Clear</button>
            </div>
          )}
        </div>

        {error && <div style={{ color: 'var(--error)', fontSize: 'var(--font-size-xs)' }}>{error}</div>}
      </div>

      {/* ---- Content: trace + table side by side ---- */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: trace viewer */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }}>
          <div style={{ padding: '3px 8px', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', background: 'var(--bg-secondary)', flexShrink: 0 }}>
            {traceLabel || 'No trace'}
            {fitTime && <span style={{ color: 'var(--stimulus-color)', marginLeft: 8 }}>● Fit ({nExp === 1 ? 'mono' : 'bi'}-exp, {fitDurationMs}ms)</span>}
          </div>
          <div ref={traceChartRef} style={{ flex: 1, minHeight: 120 }} />
        </div>

        {/* Right: results table */}
        <div style={{ width: 480, minWidth: 400, overflow: 'auto' }}>
          {measurements.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-xs)' }}>
              <thead>
                <tr>
                  {['Series', 'Sweep', 'Rs (MΩ)', 'Rin (MΩ)', 'Cm (pF)', 'τ (ms)', 'R²'].map((h) => (
                    <th key={h} style={{ padding: '3px 5px', textAlign: 'left', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 500, position: 'sticky', top: 0, background: 'var(--bg-primary)', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {measurements.map((row, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--bg-secondary)' }}>
                    <td style={{ padding: '2px 5px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.series}>{row.series}</td>
                    <td style={{ padding: '2px 5px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{row.sweep}</td>
                    <td style={{ padding: '2px 5px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)' }}>{fmt(row.rs, 1, '')}</td>
                    <td style={{ padding: '2px 5px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)' }}>{fmt(row.rin, 1, '')}</td>
                    <td style={{ padding: '2px 5px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)' }}>{fmt(row.cm, 1, '')}</td>
                    <td style={{ padding: '2px 5px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)' }}>{fmt(row.tau, 2, '')}</td>
                    <td style={{ padding: '2px 5px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)' }}>{row.fit_r_squared != null ? row.fit_r_squared.toFixed(3) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: 12, color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 'var(--font-size-xs)' }}>
              Results accumulate here as you run analyses.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
