import React, { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useAppStore, IVCurveData, IVResponseMetric, CursorPositions } from '../../stores/appStore'
import { NumInput } from '../common/NumInput'

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

export function IVCurveWindow({
  backendUrl: _backendUrl,
  fileInfo,
  currentSweep: _currentSweep,
  mainGroup,
  mainSeries,
  mainTrace,
  cursors,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  currentSweep: number
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
  cursors: CursorPositions
}) {
  const {
    ivCurves,
    runIVCurve, clearIVCurve, selectIVPoint, setIVResponseMetric, exportIVCSV,
    loading, error, setError,
  } = useAppStore()

  // Selections. Preselect from main window on first mount.
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

  // Reset group/series bounds when file changes.
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

  const key = `${group}:${series}`
  const entry = ivCurves[key]

  // Mode + per-sweep range controls. "all" runs every sweep; "range" runs a
  // user-picked half-open [from, to] range; "one" runs just one sweep and
  // appends to the existing table.
  type RunMode = 'all' | 'range' | 'one'
  const [runMode, setRunMode] = useState<RunMode>('all')
  const totalSweeps: number = fileInfo?.groups?.[group]?.series?.[series]?.sweepCount ?? 0
  const [sweepFrom, setSweepFrom] = useState(1)
  const [sweepTo, setSweepTo] = useState(Math.max(1, totalSweeps))
  const [sweepOne, setSweepOne] = useState(1)
  // When series changes, reset the range to the full series.
  useEffect(() => {
    if (totalSweeps > 0) {
      setSweepFrom(1)
      setSweepTo(totalSweeps)
      setSweepOne((s) => Math.min(Math.max(1, s), totalSweeps))
    }
  }, [totalSweeps])

  // Splitter between plot and table.
  const [plotHeight, setPlotHeight] = useState(340)
  const onSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = plotHeight
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY
      setPlotHeight(Math.max(150, Math.min(800, startH + dy)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const onRun = () => {
    // Build the sweep selection based on mode. Backend accepts an optional
    // array of sweep indices; absent = run all.
    let sweepIndices: number[] | null = null
    let appendToExisting = false
    const store = useAppStore.getState()
    if (runMode === 'all') {
      const included = store.includedSweepsFor(group, series, totalSweeps)
      if (included.length !== totalSweeps) sweepIndices = included
    } else if (runMode === 'range') {
      const lo = Math.max(1, Math.min(sweepFrom, totalSweeps))
      const hi = Math.max(lo, Math.min(sweepTo, totalSweeps))
      const range: number[] = []
      for (let i = lo - 1; i <= hi - 1; i++) range.push(i)
      sweepIndices = store.filterExcludedSweeps(group, series, range)
    } else if (runMode === 'one') {
      const sw = Math.max(1, Math.min(sweepOne, totalSweeps))
      sweepIndices = [sw - 1]
      appendToExisting = true
    }
    // Pull the windows from the main-window cursors. baseline = baseline
    // cursor, peak/SS = peak cursor. Set via the main viewer.
    runIVCurve(group, series, channel, {
      baselineStartS: cursors.baselineStart,
      baselineEndS: cursors.baselineEnd,
      peakStartS: cursors.peakStart,
      peakEndS: cursors.peakEnd,
      sweepIndices,
      appendToExisting,
    })
  }
  const onSelectRow = (idx: number) => {
    selectIVPoint(group, series, idx)
    // Jump the main viewer to the sweep this point belongs to.
    const p = entry?.points[idx]
    if (p != null) {
      try {
        const ch = new BroadcastChannel('neurotrace-sync')
        ch.postMessage({ type: 'sweep-update', sweep: p.sweepIndex })
        ch.close()
      } catch { /* ignore */ }
    }
  }

  const metric: IVResponseMetric = entry?.responseMetric ?? 'steady'
  const onMetricChange = (m: IVResponseMetric) => {
    if (!entry) return
    setIVResponseMetric(group, series, m)
  }

  // Linear fit over the current (stim, response) points. Slope = dV/dI for
  // VC data → in that case it's the INVERSE of input resistance (dI/dV),
  // since stim is mV and response is pA: R = 1 / slope × 1000 (to get MΩ).
  // For CC data (stim = pA, response = mV), the slope itself IS R in GΩ
  // (mV / pA = GΩ), which we convert to MΩ via ×1000.
  const fit = useMemo(() => {
    if (!entry || entry.points.length < 2) return null
    const xs: number[] = []
    const ys: number[] = []
    for (const p of entry.points) {
      xs.push(p.stimLevel)
      const r = (entry.responseMetric === 'peak' ? p.transientPeak : p.steadyState) - p.baseline
      ys.push(r)
    }
    const n = xs.length
    const mx = xs.reduce((a, b) => a + b, 0) / n
    const my = ys.reduce((a, b) => a + b, 0) / n
    let num = 0
    let den = 0
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx
      num += dx * (ys[i] - my)
      den += dx * dx
    }
    if (den === 0) return null
    const slope = num / den
    const intercept = my - slope * mx
    // R² for quick sanity.
    let ssRes = 0
    let ssTot = 0
    for (let i = 0; i < n; i++) {
      const yHat = slope * xs[i] + intercept
      ssRes += (ys[i] - yHat) ** 2
      ssTot += (ys[i] - my) ** 2
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1
    // Input resistance interpretation:
    //   VC: stim mV, response pA  → slope (pA/mV) → R = 1000 / slope  [MΩ]
    //   CC: stim pA, response mV  → slope (mV/pA) → R = slope × 1000  [MΩ]
    //   otherwise — not meaningful.
    let rInMOhm: number | null = null
    const stimU = entry.stimUnit.toLowerCase()
    const respU = entry.responseUnit.toLowerCase()
    if (stimU === 'mv' && respU === 'pa' && slope !== 0) {
      rInMOhm = 1000 / slope  // signed; take abs in UI
    } else if (stimU === 'pa' && respU === 'mv') {
      rInMOhm = slope * 1000
    }
    return { slope, intercept, r2, rInMOhm }
  }, [entry])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      padding: 10,
      gap: 10,
      minHeight: 0,
    }}>
      {/* Top bar: selectors */}
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

      {/* Cursor windows (mirrored from the main viewer, read-only here) +
          response-metric dropdown. Drag the cursor bands on the main
          trace to change the measurement windows. */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
        padding: 8,
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg-primary)',
        fontSize: 'var(--font-size-label)',
        fontFamily: 'var(--font-mono)',
      }}>
        <span style={{
          color: 'var(--cursor-baseline)',
          fontWeight: 600,
        }}>
          Baseline:
        </span>
        <span>{cursors.baselineStart.toFixed(4)}s → {cursors.baselineEnd.toFixed(4)}s</span>
        <span style={{
          color: 'var(--cursor-peak)',
          fontWeight: 600,
        }}>
          Peak / SS:
        </span>
        <span>{cursors.peakStart.toFixed(4)}s → {cursors.peakEnd.toFixed(4)}s</span>
        <span style={{
          color: 'var(--text-muted)',
          fontStyle: 'italic',
          fontFamily: 'var(--font-ui)',
        }}>
          drag cursor bands in the main viewer to adjust
        </span>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto',
          fontFamily: 'var(--font-ui)',
        }}>
          <span style={{ color: 'var(--text-muted)' }}>Y metric:</span>
          <select
            value={metric}
            onChange={(e) => onMetricChange(e.target.value as IVResponseMetric)}
            disabled={!entry}
            title="Steady-state = mean of the peak-cursor window. Transient peak = most-deviant sample within the peak-cursor window."
          >
            <option value="steady">Steady-state (mean)</option>
            <option value="peak">Transient peak</option>
          </select>
        </label>
      </div>

      {/* Run controls */}
      <div style={{
        display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
        padding: '6px 8px',
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>Run on:</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
          <input type="radio" name="iv-run-mode" value="all"
            checked={runMode === 'all'}
            onChange={() => setRunMode('all')} />
          all sweeps
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
          <input type="radio" name="iv-run-mode" value="range"
            checked={runMode === 'range'}
            onChange={() => setRunMode('range')} />
          range
        </label>
        {runMode === 'range' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <NumInput value={sweepFrom} step={1} min={1} max={Math.max(1, totalSweeps)}
              onChange={(v) => setSweepFrom(Math.max(1, Math.round(v)))}
              style={{ width: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>–</span>
            <NumInput value={sweepTo} step={1} min={1} max={Math.max(1, totalSweeps)}
              onChange={(v) => setSweepTo(Math.max(1, Math.round(v)))}
              style={{ width: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
              / {totalSweeps || '—'}
            </span>
          </span>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
          <input type="radio" name="iv-run-mode" value="one"
            checked={runMode === 'one'}
            onChange={() => setRunMode('one')} />
          single sweep
        </label>
        {runMode === 'one' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <NumInput value={sweepOne} step={1} min={1} max={Math.max(1, totalSweeps)}
              onChange={(v) => setSweepOne(Math.max(1, Math.round(v)))}
              style={{ width: 48 }} />
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
              / {totalSweeps || '—'}
              {' · appends to table'}
            </span>
          </span>
        )}

        <button
          className="btn btn-primary"
          onClick={onRun}
          disabled={loading || !fileInfo}
          style={{ marginLeft: 8 }}
        >
          {loading ? 'Running…' : 'Run'}
        </button>
        <button className="btn" onClick={() => clearIVCurve(group, series)} disabled={!entry}>
          Clear
        </button>
        <button
          className="btn"
          onClick={() => exportIVCSV()}
          disabled={Object.keys(ivCurves).length === 0}
          style={{ marginLeft: 'auto' }}
        >
          Export CSV
        </button>
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

      {/* Summary — left: point count / pulse window / units; right: slope
          of the linear fit to the I-V curve (input resistance). The fit
          updates as points accumulate across Run invocations. */}
      {entry && (
        <div style={{
          fontSize: 'var(--font-size-label)',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          background: 'var(--bg-primary)',
          padding: '4px 8px',
          borderRadius: 3,
          border: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span>
            <strong style={{ color: 'var(--text-primary)' }}>{entry.points.length}</strong> points ·
            windows BL {entry.baselineStartS.toFixed(3)}→{entry.baselineEndS.toFixed(3)}s ·
            PK {entry.peakStartS.toFixed(3)}→{entry.peakEndS.toFixed(3)}s ·
            stim {entry.stimUnit || '—'} · response {entry.responseUnit || '—'}
          </span>
          {fit && (
            <span style={{
              marginLeft: 'auto',
              color: 'var(--text-primary)',
              display: 'flex',
              gap: 12,
            }}>
              <span title="Slope of the linear fit to the I-V points">
                slope = {formatSlope(fit.slope, entry)} · R² = {fit.r2.toFixed(3)}
              </span>
              {fit.rInMOhm != null && (
                <span
                  style={{ color: 'var(--accent)', fontWeight: 600 }}
                  title="Input resistance derived from the I-V slope"
                >
                  Rin = {Math.abs(fit.rInMOhm).toFixed(1)} MΩ
                </span>
              )}
            </span>
          )}
        </div>
      )}

      {/* Plot + table split */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}>
        <div style={{ height: plotHeight, minHeight: 150, flexShrink: 0 }}>
          <IVPlot entry={entry} heightSignal={plotHeight} onSelectIdx={onSelectRow} fit={fit} />
        </div>

        <div
          onMouseDown={onSplitterMouseDown}
          style={{
            height: 6,
            cursor: 'row-resize',
            background: 'var(--border)',
            flexShrink: 0,
            position: 'relative',
          }}
          title="Drag to resize"
        >
          <div style={{
            position: 'absolute', left: '50%', top: 1,
            transform: 'translateX(-50%)',
            width: 40, height: 4,
            background: 'var(--text-muted)',
            borderRadius: 2, opacity: 0.5,
          }} />
        </div>

        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <IVTable
            entry={entry}
            onSelect={onSelectRow}
          />
        </div>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------------

function formatSlope(slope: number, entry: IVCurveData): string {
  const u = `${entry.responseUnit || '?'}/${entry.stimUnit || '?'}`
  return `${slope.toFixed(4)} ${u}`
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}

function IVPlot({
  entry, heightSignal, onSelectIdx, fit,
}: {
  entry: IVCurveData | undefined
  heightSignal: number
  onSelectIdx: (idx: number) => void
  fit: { slope: number; intercept: number; r2: number; rInMOhm: number | null } | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const selectedRef = useRef<number | null>(null)
  selectedRef.current = entry?.selectedIdx ?? null

  // Build data arrays from the points, sorted by stim level.
  // If a fit is available, also emit the regression line evaluated at the
  // x-extremes — added as a second uPlot series.
  const { xs, ys, yFit, sweepByIdx } = useMemo(() => {
    if (!entry || entry.points.length === 0) {
      return {
        xs: [] as number[], ys: [] as number[],
        yFit: [] as (number | null)[], sweepByIdx: [] as number[],
      }
    }
    const xs: number[] = []
    const ys: number[] = []
    const sweepByIdx: number[] = []
    for (const p of entry.points) {
      xs.push(p.stimLevel)
      const resp = (entry.responseMetric === 'peak' ? p.transientPeak : p.steadyState) - p.baseline
      ys.push(resp)
      sweepByIdx.push(p.sweepIndex)
    }
    const yFit: (number | null)[] = fit
      ? xs.map((x) => fit.slope * x + fit.intercept)
      : xs.map(() => null)
    return { xs, ys, yFit, sweepByIdx }
  }, [entry, fit])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (plotRef.current) {
      plotRef.current.destroy()
      plotRef.current = null
    }
    if (!entry || xs.length === 0) return

    const xLabel = `Stim${entry.stimUnit ? ` (${entry.stimUnit})` : ''}`
    const yLabel = `Response Δ${entry.responseUnit ? ` (${entry.responseUnit})` : ''}`
    const opts: uPlot.Options = {
      width: el.clientWidth || 400,
      height: Math.max(120, el.clientHeight || 180),
      scales: {
        x: { time: false },
        y: {
          range: (_u, dMin, dMax) => {
            // Pad the range and include zero so reversal is visible.
            const lo = Math.min(0, dMin)
            const hi = Math.max(0, dMax)
            const pad = (hi - lo) * 0.1 || 1
            return [lo - pad, hi + pad]
          },
        },
      },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: xLabel, labelSize: 14,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: yLabel, labelSize: 14,
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        {
          label: 'I-V',
          stroke: cssVar('--trace-color-1'),
          width: 1.5,
          points: { size: 6, stroke: cssVar('--trace-color-1'), fill: cssVar('--bg-surface') },
        },
        {
          label: 'fit',
          stroke: cssVar('--accent'),
          width: 1,
          dash: [4, 4],
          points: { show: false },
        },
      ],
      hooks: {
        // Click anywhere: find the nearest data point, select it.
        init: [(u) => {
          u.over.addEventListener('click', () => {
            const idx = u.cursor.idx
            if (idx != null && idx >= 0) onSelectIdx(idx as number)
          })
        }],
        draw: [(u) => drawSelectedMarker(u, selectedRef.current)],
      },
    }
    plotRef.current = new uPlot(opts, [xs, ys, yFit as any], el)

    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    const onWin = () => {
      const u = plotRef.current
      if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
    window.addEventListener('resize', onWin)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWin)
      plotRef.current?.destroy()
      plotRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.points, entry?.responseMetric, entry?.stimUnit, entry?.responseUnit])

  // Re-fit size synchronously on splitter drag.
  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (u && el) u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])

  // Redraw to update the selected-marker highlight.
  useEffect(() => {
    plotRef.current?.redraw()
  }, [entry?.selectedIdx])

  if (!entry || xs.length === 0) {
    return (
      <div style={{
        height: '100%',
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg-primary)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
        fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        {entry ? 'No I-V points for this series.' : 'Click Run to compute the I-V for this series.'}
      </div>
    )
  }

  void sweepByIdx  // kept for potential future use
  return (
    <div style={{
      height: '100%',
      border: '1px solid var(--border)',
      borderRadius: 4,
      background: 'var(--bg-primary)',
    }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

function drawSelectedMarker(u: uPlot, selectedIdx: number | null) {
  if (selectedIdx == null) return
  const xArr = u.data[0] as number[]
  const yArr = u.data[1] as (number | null)[]
  if (selectedIdx < 0 || selectedIdx >= xArr.length) return
  const x = xArr[selectedIdx]
  const y = yArr[selectedIdx]
  if (y == null || !isFinite(x) || !isFinite(y)) return
  const dpr = devicePixelRatio || 1
  const px = u.valToPos(x, 'x', true) / dpr
  const py = u.valToPos(y, 'y', true) / dpr
  const ctx = u.ctx
  // Draw in CSS pixels.
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.beginPath()
  ctx.arc(px, py, 8, 0, Math.PI * 2)
  ctx.fillStyle = cssVar('--accent')
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function IVTable({
  entry, onSelect,
}: {
  entry: IVCurveData | undefined
  onSelect: (idx: number) => void
}) {
  if (!entry || entry.points.length === 0) {
    return (
      <div style={{
        padding: 16, textAlign: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
        border: '1px dashed var(--border)', borderRadius: 4,
      }}>
        {entry ? 'No I-V points.' : 'Click Run to populate the table.'}
      </div>
    )
  }

  const stimUnit = entry.stimUnit || ''
  const respUnit = entry.responseUnit || ''

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
            <Th>#</Th>
            <Th>Sweep</Th>
            <Th>Stim ({stimUnit})</Th>
            <Th>Baseline ({respUnit})</Th>
            <Th>Steady-state ({respUnit})</Th>
            <Th>Transient peak ({respUnit})</Th>
            <Th>Response ({respUnit})</Th>
          </tr>
        </thead>
        <tbody>
          {entry.points.map((p, i) => {
            const resp = (entry.responseMetric === 'peak' ? p.transientPeak : p.steadyState) - p.baseline
            return (
              <tr
                key={i}
                onClick={() => onSelect(i)}
                style={{
                  background: i === entry.selectedIdx ? 'var(--bg-selected, rgba(100,181,246,0.2))' : 'transparent',
                  cursor: 'pointer',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <Td>{i + 1}</Td>
                <Td>{p.sweepIndex + 1}</Td>
                <Td>{p.stimLevel.toFixed(2)}</Td>
                <Td>{p.baseline.toFixed(3)}</Td>
                <Td>{p.steadyState.toFixed(3)}</Td>
                <Td>{p.transientPeak.toFixed(3)}</Td>
                <Td><strong>{resp.toFixed(3)}</strong></Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th style={{ padding: '4px 8px', fontWeight: 600, fontSize: 'var(--font-size-label)' }}>{children}</th>
)
const Td = ({ children }: { children: React.ReactNode }) => (
  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{children}</td>
)
