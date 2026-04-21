import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  CursorPositions, StimulusInfo, useAppStore,
} from '../../stores/appStore'
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

// Cursor band colors mirror the other analysis windows for consistency.
const BASELINE_COLOR_VAR = '--cursor-baseline'
const PEAK_COLOR_VAR = '--cursor-peak'
const FIT_COLOR_VAR = '--cursor-fit'

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

  // Which sweep the embedded viewer is showing. Initialised from the main
  // window's current sweep and then updated locally via the prev/next
  // arrows. Kept independent so skimming here doesn't yank the main
  // viewer around.
  const [previewSweep, setPreviewSweep] = useState(currentSweep)

  // Trace data for the embedded viewer
  const [traceTime, setTraceTime] = useState<number[] | null>(null)
  const [traceValues, setTraceValues] = useState<number[] | null>(null)
  const [fitTime, setFitTime] = useState<number[] | null>(null)
  const [fitValues, setFitValues] = useState<number[] | null>(null)
  const [fitStartOffset, setFitStartOffset] = useState(0)
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

  // Exclusion state — mirror from store so we can show a tiny badge on
  // the preview sweep when it's excluded (run on it is still allowed).
  const isPreviewExcluded = useAppStore((s) =>
    s.isSweepExcluded(currentGroup, currentSeries, previewSweep))

  // Auto-populate V_step from stimulus
  useEffect(() => {
    if (stimulus) setVStep(Number(stimulus.vStepAbsolute.toFixed(2)))
  }, [stimulus?.vStepAbsolute])

  // Auto-populate sweep range
  useEffect(() => {
    if (totalSweeps > 0) { setAvgFrom(1); setAvgTo(totalSweeps) }
  }, [currentGroup, currentSeries, totalSweeps])

  // If the main window's sweep changes, follow — but only once; don't
  // fight the user once they start using the prev/next arrows here.
  const mainSyncedRef = useRef(false)
  useEffect(() => {
    if (mainSyncedRef.current) return
    mainSyncedRef.current = true
    setPreviewSweep(currentSweep)
  }, [currentSweep])

  // Clamp previewSweep when series changes
  useEffect(() => {
    setPreviewSweep((s) => Math.max(0, Math.min(s, totalSweeps - 1)))
  }, [currentGroup, currentSeries, totalSweeps])

  // Fetch persisted results on mount (global per file)
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

  // Drive the viewer off previewSweep (not currentSweep) so the local
  // arrows actually do something.
  useEffect(() => {
    if (totalSweeps > 0) loadTrace(previewSweep)
  }, [previewSweep, loadTrace, totalSweeps])

  // Cursor changes from drag → push up to the main store AND broadcast
  // so the main trace viewer moves its bands in lockstep.
  const updateCursors = useCallback((next: Partial<CursorPositions>) => {
    useAppStore.getState().setCursors(next)
    try {
      const ch = new BroadcastChannel('neurotrace-sync')
      const merged = { ...useAppStore.getState().cursors, ...next }
      ch.postMessage({ type: 'cursor-update', cursors: merged })
      ch.close()
    } catch { /* ignore */ }
  }, [])

  // ---- Common analysis params ----
  const analysisParams = () => ({
    v_step: vStep, n_exp: nExp, fit_duration_ms: fitDurationMs,
  })

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
      const rawRange: number[] = []
      for (let i = from - 1; i <= to - 1; i++) rawRange.push(i)
      const indices = useAppStore.getState()
        .filterExcludedSweeps(currentGroup, currentSeries, rawRange)
      if (indices.length === 0) {
        throw new Error('No non-excluded sweeps in the chosen range.')
      }

      const trResp = await fetch(
        `${backendUrl}/api/traces/average?group=${currentGroup}&series=${currentSeries}&trace=0&sweeps=${indices.join(',')}&max_points=0`
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
      const excluded = useAppStore.getState()
        .excludedSweeps[`${currentGroup}:${currentSeries}`] ?? []
      const resp = await fetch(`${backendUrl}/api/analysis/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysis_type: 'resistance',
          group: currentGroup, series: currentSeries, trace: 0,
          sweep_start: 0, sweep_end: totalSweeps,
          excluded_sweeps: excluded.length > 0 ? excluded : undefined,
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

  // ---------------------------------------------------------------
  // Embedded trace chart — now with draggable cursor bands and
  // locked-zoom pan/wheel, same pattern as the Cursor analysis
  // window's mini-viewer.
  // ---------------------------------------------------------------

  // Keep the latest cursors reachable from the hook closures below
  // (they're attached once at plot mount and must always see current
  // values without tearing down uPlot on every drag).
  const cursorsRef = useRef(cursors)
  cursorsRef.current = cursors

  // Refs that back the uPlot scale range functions — same locked-
  // zoom pattern that actually works. Null means "auto-fit next
  // draw, then stash the result".
  const xRangeRef = useRef<[number, number] | null>(null)
  const yRangeRef = useRef<[number, number] | null>(null)
  const hasRealDataRef = useRef(false)

  // Drag state
  type DragTarget =
    | { kind: 'baseline-edge'; edge: 'start' | 'end' }
    | { kind: 'baseline-band'; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'peak-edge'; edge: 'start' | 'end' }
    | { kind: 'peak-band'; startPxX: number; startStart: number; startEnd: number }
    | { kind: 'pan'; startX: number; xMin: number; xMax: number; startY: number; yMin: number; yMax: number }
  const dragRef = useRef<DragTarget | null>(null)

  const resetZoom = () => {
    const u = tracePlotRef.current
    if (!u) return
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

  // Compute the interpolated fit overlay array whenever fit values /
  // cursors / trace change. Done here (not inside the plot effect) so
  // the plot effect can stay pinned to [traceTime, traceValues].
  const fitOverlayValues = useMemo<Array<number | null> | null>(() => {
    if (!traceTime || !traceValues || !fitTime || !fitValues || fitTime.length === 0) {
      return null
    }
    const sr = traceTime.length > 1 ? 1 / (traceTime[1] - traceTime[0]) : 10000
    const peakTimeS = cursors.peakStart + fitStartOffset / sr
    const fitTimeS = fitTime.map((t) => peakTimeS + t / 1000)
    const blIdx0 = Math.max(0, Math.round(cursors.baselineStart * sr))
    const blIdx1 = Math.max(blIdx0 + 1, Math.round(cursors.baselineEnd * sr))
    let bl = 0
    if (blIdx1 <= traceValues.length) {
      let sum = 0
      for (let i = blIdx0; i < blIdx1; i++) sum += traceValues[i]
      bl = sum / (blIdx1 - blIdx0)
    }
    const fitInterp: Array<number | null> = new Array(traceTime.length).fill(null)
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
    return fitInterp
  }, [traceTime, traceValues, fitTime, fitValues, fitStartOffset,
      cursors.peakStart, cursors.baselineStart, cursors.baselineEnd])

  // Draw the cursor bands + fit line. Runs every redraw.
  const drawOverlays = (u: uPlot) => {
    const cur = cursorsRef.current
    const ctx = u.ctx
    const yTop = u.bbox.top
    const yBot = u.bbox.top + u.bbox.height
    const drawBand = (xs: number, xe: number, colorVar: string, label: string) => {
      const px0 = u.valToPos(xs, 'x', true)
      const px1 = u.valToPos(xe, 'x', true)
      ctx.save()
      ctx.globalAlpha = 0.18
      ctx.fillStyle = cssVar(colorVar) || '#888'
      ctx.fillRect(Math.min(px0, px1), yTop, Math.abs(px1 - px0), yBot - yTop)
      ctx.globalAlpha = 1
      ctx.fillStyle = cssVar(colorVar) || '#888'
      const dpr = devicePixelRatio || 1
      ctx.font = `bold ${10 * dpr}px ${cssVar('--font-mono')}`
      ctx.fillText(label, Math.min(px0, px1) + 2 * dpr, yTop + 12 * dpr)
      ctx.restore()
    }
    drawBand(cur.baselineStart, cur.baselineEnd, BASELINE_COLOR_VAR, 'BL')
    drawBand(cur.peakStart, cur.peakEnd, PEAK_COLOR_VAR, 'PK')
  }

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

      // Build the payload. Second series is the fit overlay.
      const payload: uPlot.AlignedData = fitOverlayValues
        ? [traceTime, traceValues, fitOverlayValues as any]
        : [traceTime, traceValues]

      const series: uPlot.Series[] = [
        {},
        { label: 'Trace', stroke: cssVar('--trace-color-1'), width: 1.5, scale: 'y' },
      ]
      if (fitOverlayValues) {
        series.push({
          label: 'Fit', stroke: cssVar(FIT_COLOR_VAR) || '#9c27b0',
          width: 2.5, scale: 'y', points: { show: false },
        })
      }

      // First real data → flip the flag so the range fns stash their
      // initial fit. Reset button and sweep switches do not clear
      // refs, so the user's zoom survives sweep navigation.
      hasRealDataRef.current = true

      const opts: uPlot.Options = {
        width: w, height: h,
        scales: {
          x: {
            time: false,
            range: (_u, dataMin, dataMax) => {
              if (xRangeRef.current) return xRangeRef.current
              const lo = isFinite(dataMin) ? dataMin : 0
              const hi = isFinite(dataMax) && dataMax > lo ? dataMax : lo + 1
              const r: [number, number] = [lo, hi]
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
            stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'Time (s)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
          },
          {
            stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'pA', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
            labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
            scale: 'y',
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series,
        hooks: {
          draw: [(u) => drawOverlays(u)],
        },
      }

      tracePlotRef.current = new uPlot(opts, payload, container)

      // --- wire up drag-to-move cursors + pan + wheel-zoom ---
      const u = tracePlotRef.current
      const over = container.querySelector<HTMLDivElement>('.u-over')
      const EDGE_THRESHOLD_PX = 6

      const xToPx = (x: number) => u.valToPos(x, 'x', false)
      const pxToX = (px: number) => u.posToVal(px, 'x')
      const pxToY = (py: number) => u.posToVal(py, 'y')

      const findHit = (pxX: number): DragTarget | null => {
        const cur = cursorsRef.current
        const pairs: Array<{
          start: number; end: number
          edge: (e: 'start' | 'end') => DragTarget
          band: (startPxX: number) => DragTarget
        }> = [
          {
            start: cur.baselineStart, end: cur.baselineEnd,
            edge: (e) => ({ kind: 'baseline-edge', edge: e }),
            band: (startPxX) => ({
              kind: 'baseline-band', startPxX,
              startStart: cur.baselineStart, startEnd: cur.baselineEnd,
            }),
          },
          {
            start: cur.peakStart, end: cur.peakEnd,
            edge: (e) => ({ kind: 'peak-edge', edge: e }),
            band: (startPxX) => ({
              kind: 'peak-band', startPxX,
              startStart: cur.peakStart, startEnd: cur.peakEnd,
            }),
          },
        ]
        // Edge hits first.
        let best: { dist: number; target: DragTarget } | null = null
        for (const r of pairs) {
          const ds = Math.abs(xToPx(r.start) - pxX)
          const de = Math.abs(xToPx(r.end) - pxX)
          if (ds < EDGE_THRESHOLD_PX && (!best || ds < best.dist)) {
            best = { dist: ds, target: r.edge('start') }
          }
          if (de < EDGE_THRESHOLD_PX && (!best || de < best.dist)) {
            best = { dist: de, target: r.edge('end') }
          }
        }
        if (best) return best.target
        // Whole-band hits — later pair wins.
        for (let i = pairs.length - 1; i >= 0; i--) {
          const r = pairs[i]
          const p0 = xToPx(r.start), p1 = xToPx(r.end)
          const lo = Math.min(p0, p1), hi = Math.max(p0, p1)
          if (pxX > lo && pxX < hi) return r.band(pxX)
        }
        return null
      }

      const onPointerDown = (ev: PointerEvent) => {
        if (!over) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const hit = findHit(pxX)
        if (hit) {
          dragRef.current = hit
        } else {
          // Empty area → pan.
          const xMin = u.scales.x.min, xMax = u.scales.x.max
          const yMin = u.scales.y.min, yMax = u.scales.y.max
          if (xMin == null || xMax == null || yMin == null || yMax == null) return
          dragRef.current = {
            kind: 'pan',
            startX: pxX, xMin, xMax,
            startY: ev.clientY - rect.top, yMin, yMax,
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
          const hit = findHit(pxX)
          over.style.cursor = !hit ? 'grab'
            : (hit.kind === 'baseline-edge' || hit.kind === 'peak-edge') ? 'ew-resize'
            : 'move'
          return
        }
        if (t.kind === 'pan') {
          const x = pxToX(pxX)
          const x0 = u.posToVal(t.startX, 'x')
          const y = pxToY(pxY)
          const y0 = u.posToVal(t.startY, 'y')
          const dx = x - x0, dy = y - y0
          xRangeRef.current = [t.xMin - dx, t.xMax - dx]
          yRangeRef.current = [t.yMin - dy, t.yMax - dy]
          u.setScale('x', { min: xRangeRef.current[0], max: xRangeRef.current[1] })
          u.setScale('y', { min: yRangeRef.current[0], max: yRangeRef.current[1] })
          over.style.cursor = 'grabbing'
          return
        }
        const x = pxToX(pxX)
        const cur = cursorsRef.current
        const shift = (pxStart: number) => pxToX(pxX) - pxToX(pxStart)
        switch (t.kind) {
          case 'baseline-edge':
            updateCursors({ [t.edge === 'start' ? 'baselineStart' : 'baselineEnd']: x } as Partial<CursorPositions>)
            break
          case 'baseline-band': {
            const dx = shift(t.startPxX)
            updateCursors({ baselineStart: t.startStart + dx, baselineEnd: t.startEnd + dx })
            over.style.cursor = 'move'
            break
          }
          case 'peak-edge':
            updateCursors({ [t.edge === 'start' ? 'peakStart' : 'peakEnd']: x } as Partial<CursorPositions>)
            break
          case 'peak-band': {
            const dx = shift(t.startPxX)
            updateCursors({ peakStart: t.startStart + dx, peakEnd: t.startEnd + dx })
            over.style.cursor = 'move'
            break
          }
        }
        void cur // silence ts
      }

      const onPointerUp = (ev: PointerEvent) => {
        if (dragRef.current && over) {
          dragRef.current = null
          try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
          over.style.cursor = ''
        }
      }

      const onWheel = (ev: WheelEvent) => {
        if (!over) return
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
      ;(tracePlotRef.current as any)._teardownResistance = () => {
        if (over) {
          over.removeEventListener('pointerdown', onPointerDown)
          over.removeEventListener('pointermove', onPointerMove)
          over.removeEventListener('pointerup', onPointerUp)
          over.removeEventListener('pointercancel', onPointerUp)
          over.removeEventListener('wheel', onWheel)
        }
      }
    })

    return () => {
      cancelAnimationFrame(frameId)
      const teardown = (tracePlotRef.current as any)?._teardownResistance
      if (teardown) teardown()
      tracePlotRef.current?.destroy()
      tracePlotRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceTime, traceValues, fitOverlayValues])

  // Redraw when cursors change (so the band overlays follow the drag
  // without rebuilding the whole plot).
  useEffect(() => { tracePlotRef.current?.redraw() }, [cursors])

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

  // Redraw on theme change — band colors resolve at draw time via cssVar.
  useEffect(() => { tracePlotRef.current?.redraw() }, [theme, fontSize])

  // ---- CSV export ----
  const exportCSV = () => {
    const cols = ['Series', 'Sweep', 'Rs (MΩ)', 'Rin (MΩ)', 'Cm (pF)', 'τ (ms)', 'R²']
    const rows = measurements.map((r) =>
      [r.series, r.sweep, fmt(r.rs, 2, ''), fmt(r.rin, 2, ''), fmt(r.cm, 2, ''), fmt(r.tau, 3, ''), r.fit_r_squared?.toFixed(4) ?? ''].join(',')
    )
    const csv = [cols.join(','), ...rows].join('\n')
    navigator.clipboard.writeText(csv)
  }

  // ---- Prev / next sweep navigation ----
  const goPrev = () => setPreviewSweep((s) => Math.max(0, s - 1))
  const goNext = () => setPreviewSweep((s) => Math.min(totalSweeps - 1, s + 1))

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
          <div style={{
            fontSize: 'var(--font-size-label)', color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)', background: 'var(--bg-primary)',
            padding: '3px 6px', borderRadius: 3, border: '1px solid var(--border)', lineHeight: 1.5,
          }}>
            <span style={{ color: cssVar(BASELINE_COLOR_VAR) || '#4caf50', fontWeight: 600 }}>BL</span>{' '}
            {cursors.baselineStart.toFixed(3)}→{cursors.baselineEnd.toFixed(3)}s
            <br/>
            <span style={{ color: cssVar(PEAK_COLOR_VAR) || '#2196f3', fontWeight: 600 }}>PK</span>{' '}
            {cursors.peakStart.toFixed(3)}→{cursors.peakEnd.toFixed(3)}s
          </div>
        </div>

        {/* Run row — prev/next arrows + single-sweep + averaged + all */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn" onClick={goPrev}
            disabled={previewSweep <= 0 || totalSweeps === 0}
            title="Previous sweep"
            style={{ padding: '2px 8px' }}
          >←</button>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', minWidth: 58, textAlign: 'center' }}>
            {totalSweeps > 0 ? `${previewSweep + 1} / ${totalSweeps}` : '— / —'}
          </span>
          <button
            className="btn" onClick={goNext}
            disabled={previewSweep >= totalSweeps - 1 || totalSweeps === 0}
            title="Next sweep"
            style={{ padding: '2px 8px' }}
          >→</button>
          <button className="btn btn-primary" onClick={() => runSingle(previewSweep)} disabled={loading || totalSweeps === 0}>
            {loading ? 'Running…' : `Run sweep ${previewSweep + 1}`}
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
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', position: 'relative' }}>
          <div style={{
            padding: '3px 8px', fontSize: 'var(--font-size-xs)',
            color: 'var(--text-muted)', background: 'var(--bg-secondary)',
            flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span>{traceLabel || 'No trace'}</span>
            {isPreviewExcluded && (
              <span style={{
                fontSize: 'var(--font-size-label)', fontWeight: 600,
                color: '#fff', background: '#e65100',
                padding: '1px 6px', borderRadius: 3,
              }}>
                ⊘ Excluded
              </span>
            )}
            {fitTime && (
              <span style={{ color: cssVar(FIT_COLOR_VAR) || '#9c27b0', marginLeft: 'auto' }}>
                ● Fit ({nExp === 1 ? 'mono' : 'bi'}-exp, {fitDurationMs}ms)
              </span>
            )}
            <button
              className="btn"
              onClick={resetZoom}
              style={{ padding: '1px 8px', fontSize: 'var(--font-size-label)', marginLeft: fitTime ? 0 : 'auto' }}
              title="Reset zoom to full sweep"
            >
              Reset
            </button>
          </div>
          <div ref={traceChartRef} style={{ flex: 1, minHeight: 120 }} />
          <div style={{
            position: 'absolute', bottom: 4, left: 10, zIndex: 2,
            fontSize: 'var(--font-size-label)', color: 'var(--text-muted)',
            fontStyle: 'italic', pointerEvents: 'none',
          }}>
            scroll = zoom X · ⌥ scroll = zoom Y · drag empty = pan · drag band = move · drag edge = resize
          </div>
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
