import React, { useRef, useEffect, useCallback, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useAppStore, CursorPositions } from '../../stores/appStore'
import { useThemeStore } from '../../stores/themeStore'

type DragEdge =
  | 'baselineStart' | 'baselineEnd'
  | 'peakStart' | 'peakEnd'
  | 'fitStart' | 'fitEnd'

/** What we're dragging: a single edge, or an entire region */
type DragTarget =
  | { kind: 'edge'; key: DragEdge }
  | { kind: 'region'; startKey: DragEdge; endKey: DragEdge; anchorVal: number; origStart: number; origEnd: number }
  | null

/** Reads a CSS custom property from :root computed style */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const CURSOR_DEFS: {
  startKey: keyof CursorPositions
  endKey: keyof CursorPositions
  fillVar: string
  lineVar: string
  label: string
  visKey: 'baseline' | 'peak' | 'fit'
}[] = [
  { startKey: 'baselineStart', endKey: 'baselineEnd', fillVar: '--cursor-baseline-fill', lineVar: '--cursor-baseline', label: 'BL', visKey: 'baseline' },
  { startKey: 'peakStart', endKey: 'peakEnd', fillVar: '--cursor-peak-fill', lineVar: '--cursor-peak', label: 'PK', visKey: 'peak' },
  { startKey: 'fitStart', endKey: 'fitEnd', fillVar: '--cursor-fit-fill', lineVar: '--cursor-fit', label: 'FT', visKey: 'fit' },
]

const SNAP_PX = 8

export function TraceViewer() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const dragRef = useRef<DragTarget>(null)

  // Keep a mutable ref to the latest cursors so draw callbacks always see
  // current values without needing to be recreated.
  const cursorsRef = useRef<CursorPositions>(useAppStore.getState().cursors)
  const showCursorsRef = useRef<boolean>(useAppStore.getState().showCursors)
  const cursorVisRef = useRef(useAppStore.getState().cursorVisibility)

  const {
    traceData, cursors, setCursors,
    overlayEntries, showOverlay,
    averageTrace, showAverage,
    zoomMode,
    showStimulusOverlay, toggleStimulusOverlay,
    showCursors,
    cursorVisibility,
    sweepStimulusSegments,
    sweepStimulusUnit,
  } = useAppStore()

  // Current series' stimulus info, if any.
  const stimulus = useAppStore((s) => {
    if (!s.recording) return null
    return s.recording.groups[s.currentGroup]?.series[s.currentSeries]?.stimulus ?? null
  })

  // Show stimulus checkbox whenever per-sweep or series-level stimulus data exists.
  const hasStimulus = (sweepStimulusSegments && sweepStimulusSegments.length > 0) ||
    (!!stimulus && (stimulus.segments?.length > 0 || stimulus.pulseEnd > stimulus.pulseStart))

  // Subscribe to theme so chart rebuilds on theme/font change
  const theme = useThemeStore((s) => s.theme)
  const fontUI = useThemeStore((s) => s.fontFamily)
  const fontSize = useThemeStore((s) => s.fontSize)
  const monoFont = useThemeStore((s) => s.monoFont)

  // Sync the refs every render
  cursorsRef.current = cursors
  showCursorsRef.current = showCursors
  cursorVisRef.current = cursorVisibility

  const [hoverCursor, setHoverCursor] = useState<string>('')

  // ================================================================
  // Draw cursor overlays on the transparent canvas.
  // Reads from refs only — no stale closures.
  // ================================================================
  function drawCursors() {
    const u = plotRef.current
    const canvas = canvasRef.current
    if (!u || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = devicePixelRatio || 1

    // Match canvas backing-store size to its CSS layout size
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr
      canvas.height = cssH * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    // If cursors are globally hidden, just clear and return.
    if (!showCursorsRef.current) return

    // uPlot bbox is in CSS pixels — use directly, no dpr division.
    const { left, top, width: pw, height: ph } = u.bbox
    const by = top / dpr
    const bh = ph / dpr

    const cur = cursorsRef.current

    for (const def of CURSOR_DEFS) {
      // Skip individually hidden cursors
      if (!cursorVisRef.current[def.visKey]) continue

      const startVal = cur[def.startKey]
      const endVal = cur[def.endKey]

      const x0 = u.valToPos(startVal, 'x', true) / dpr
      const x1 = u.valToPos(endVal, 'x', true) / dpr

      if (!isFinite(x0) || !isFinite(x1)) continue

      // Filled region — read colors from CSS custom properties
      ctx.fillStyle = cssVar(def.fillVar)
      ctx.fillRect(x0, by, x1 - x0, bh)

      // Dashed vertical edge lines
      ctx.strokeStyle = cssVar(def.lineVar)
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 3])

      ctx.beginPath()
      ctx.moveTo(x0, by); ctx.lineTo(x0, by + bh)
      ctx.stroke()

      ctx.beginPath()
      ctx.moveTo(x1, by); ctx.lineTo(x1, by + bh)
      ctx.stroke()

      ctx.setLineDash([])

      // Label
      ctx.fillStyle = cssVar(def.lineVar)
      ctx.font = `${cssVar('--font-size-label')} ${cssVar('--font-ui')}`
      ctx.fillText(def.label, x0 + 3, by + 12)
    }
  }

  // Index of the stimulus series in the data array (when present), so we
  // can run auto-zoom only on that series' values.
  const stimSeriesIdxRef = useRef<number | null>(null)

  // ================================================================
  // Build uPlot data arrays from current state
  // ================================================================
  const buildSeriesData = useCallback((): { data: uPlot.AlignedData; seriesOpts: uPlot.Series[]; stimIdx: number | null } => {
    if (!traceData) return { data: [[]], seriesOpts: [], stimIdx: null }

    const time = Array.from(traceData.time)
    const columns: number[][] = [time]
    const seriesOpts: uPlot.Series[] = [{}]

    // Primary trace
    columns.push(Array.from(traceData.values))
    seriesOpts.push({
      label: traceData.label || 'Trace',
      stroke: cssVar('--trace-color-1'),
      width: 1.5,
      scale: 'y',
    })

    // Overlay sweeps
    if (showOverlay && overlayEntries.length > 0) {
      for (const entry of overlayEntries) {
        const vals = new Array(time.length)
        const src = entry.data.values
        for (let i = 0; i < time.length; i++) vals[i] = i < src.length ? src[i] : null
        columns.push(vals)
        seriesOpts.push({
          label: entry.data.label,
          stroke: entry.color,
          width: 1,
          scale: 'y',
        } as uPlot.Series)
      }
    }

    // Average trace
    if (showAverage && averageTrace) {
      const vals = new Array(time.length)
      const src = averageTrace.values
      for (let i = 0; i < time.length; i++) vals[i] = i < src.length ? src[i] : null
      columns.push(vals)
      seriesOpts.push({
        label: 'Average',
        stroke: cssVar('--trace-average'),
        width: 2.5,
        scale: 'y',
        dash: [6, 3],
      })
    }

    // Stimulus overlay — uses per-sweep segments from the /api/traces/stimulus
    // endpoint (which applies the .pgf increment math for the current sweep).
    // Falls back to the series-level stimulus for backwards compatibility.
    let stimIdx: number | null = null
    if (showStimulusOverlay) {
      const n = time.length
      // Prefer per-sweep segments (has correct I-V step levels per sweep)
      const segs = sweepStimulusSegments ?? stimulus?.segments
      const stimUnit = sweepStimulusUnit || stimulus?.unit || ''
      let stimVals: (number | null)[] | null = null

      if (segs && segs.length > 0) {
        stimVals = new Array(n).fill(0)
        for (let i = 0; i < n; i++) {
          const t = time[i]
          for (let s = 0; s < segs.length; s++) {
            if (t >= segs[s].start && t < segs[s].end) {
              stimVals[i] = segs[s].level
              break
            }
          }
        }
      } else if (stimulus && stimulus.pulseEnd > stimulus.pulseStart) {
        stimVals = new Array(n).fill(0)
        for (let i = 0; i < n; i++) {
          const t = time[i]
          if (t >= stimulus.pulseStart && t < stimulus.pulseEnd) {
            stimVals[i] = stimulus.vStepAbsolute
          }
        }
      }

      if (stimVals) {
        stimIdx = columns.length
        columns.push(stimVals as any)
        seriesOpts.push({
          label: `Stim (${stimUnit})`,
          stroke: cssVar('--stimulus-color'),
          width: 1.75,
          scale: 'stim',
        } as uPlot.Series)
      }
    }

    return { data: columns as unknown as uPlot.AlignedData, seriesOpts, stimIdx }
  }, [traceData, overlayEntries, showOverlay, averageTrace, showAverage, theme, showStimulusOverlay, stimulus, sweepStimulusSegments])

  // ================================================================
  // Create / recreate uPlot when data or overlays change
  // ================================================================
  useEffect(() => {
    if (!containerRef.current || !traceData) return

    // Tear down previous instance
    if (plotRef.current) {
      plotRef.current.destroy()
      plotRef.current = null
    }

    const container = containerRef.current
    const { data, seriesOpts, stimIdx } = buildSeriesData()
    stimSeriesIdxRef.current = stimIdx

    // Build axis list — always has Time (bottom) + Y data (left).
    // Adds Stim (right) when the stimulus overlay is enabled.
    const axes: uPlot.Axis[] = [
      {
        stroke: cssVar('--chart-axis'),
        grid: { stroke: cssVar('--chart-grid'), width: 1 },
        ticks: { stroke: cssVar('--chart-tick'), width: 1 },
        label: 'Time (s)',
        labelSize: 16,
        font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
        labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
      },
      {
        stroke: cssVar('--chart-axis'),
        grid: { stroke: cssVar('--chart-grid'), width: 1 },
        ticks: { stroke: cssVar('--chart-tick'), width: 1 },
        label: traceData.units || 'Value',
        labelSize: 16,
        font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
        labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
        scale: 'y',
      },
    ]

    // Build scales object. The `stim` scale is only present when needed.
    const scales: uPlot.Scales = {
      x: { time: false },
      y: {},
    }

    if (stimIdx !== null && stimulus) {
      // The stimulus overlay is drawn as "0 baseline + pulse at
      // vStepAbsolute", so the natural Y range is [0, vStepAbsolute] (or
      // flipped if the pulse is negative).
      //
      // Default window: ±20 mV (or ±200 pA) centered on 0, unless the
      // absolute pulse level sticks outside that window — then auto-range
      // with 20% padding around the pulse level.
      const DEFAULT_HALF: Record<string, number> = { mV: 20, pA: 200 }
      const halfWindow = DEFAULT_HALF[stimulus.unit] ?? 20

      const pulse = stimulus.vStepAbsolute
      const needed = Math.abs(pulse)

      if (needed <= halfWindow) {
        scales.stim = { range: () => [-halfWindow, halfWindow] }
      } else {
        const pad = needed * 0.2 || 1
        const lo = Math.min(0, pulse) - pad
        const hi = Math.max(0, pulse) + pad
        scales.stim = { range: () => [lo, hi] }
      }

      // Right-side axis in the stimulus color
      axes.push({
        stroke: cssVar('--stimulus-color'),
        grid: { show: false },
        ticks: { stroke: cssVar('--chart-tick'), width: 1 },
        label: `Stim (${stimulus.unit})`,
        labelSize: 16,
        font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
        labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
        scale: 'stim',
        side: 1,
      })
    }

    const opts: uPlot.Options = {
      width: container.clientWidth,
      height: container.clientHeight,
      cursor: {
        drag: {
          x: zoomMode,
          y: zoomMode,
          uni: 50,
        },
        focus: { prox: 30 },
      },
      scales,
      axes,
      series: seriesOpts,
      hooks: {
        draw: [() => drawCursors()],
      },
    }

    plotRef.current = new uPlot(opts, data, container)
    drawCursors()

    // Cleanup on unmount or before next recreation
    return () => {
      plotRef.current?.destroy()
      plotRef.current = null
    }
  }, [traceData, buildSeriesData, theme, fontUI, fontSize, monoFont, zoomMode, showStimulusOverlay, stimulus]) // deliberately NOT including cursors

  // ================================================================
  // Repaint cursor canvas when cursor positions or visibility change
  // (no plot rebuild)
  // ================================================================
  useEffect(() => {
    drawCursors()
  }, [cursors, showCursors, cursorVisibility])

  // ================================================================
  // Listen for axis range commands from the CursorPanel
  // ================================================================
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('neurotrace-axis-range')
      ch.onmessage = (ev) => {
        if (ev.data?.type === 'set-axis-range') {
          const u = plotRef.current
          if (!u) return
          if (ev.data.x) u.setScale('x', { min: ev.data.x.min, max: ev.data.x.max })
          if (ev.data.y) u.setScale('y', { min: ev.data.y.min, max: ev.data.y.max })
        }
      }
      return () => ch.close()
    } catch { /* ignore */ }
  }, [])

  // ================================================================
  // Resize: keep uPlot and canvas in sync with container
  // ================================================================
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !container) return
      const w = container.clientWidth
      const h = container.clientHeight
      if (w > 0 && h > 0) {
        // setSize triggers uPlot's draw hook, which calls drawCursors()
        u.setSize({ width: w, height: h })
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, []) // stable — reads plotRef.current at call time

  // ================================================================
  // Draggable cursor edges + region drag
  // ================================================================
  const valFromClientX = (clientX: number): number | null => {
    const u = plotRef.current
    if (!u || !containerRef.current) return null
    const rect = containerRef.current.getBoundingClientRect()
    const cssPx = clientX - rect.left
    const canvasPx = cssPx * (devicePixelRatio || 1)
    return u.posToVal(canvasPx, 'x')
  }

  /**
   * Hit-test cursor edges and regions.
   * Priority: edge snap (within SNAP_PX) > region interior > nothing.
   * Returns null when cursors are globally hidden.
   */
  const hitTest = (clientX: number): { type: 'edge'; key: DragEdge } | { type: 'region'; def: typeof CURSOR_DEFS[0] } | null => {
    if (!showCursors) return null
    const u = plotRef.current
    if (!u || !containerRef.current) return null
    const rect = containerRef.current.getBoundingClientRect()
    const cssPx = clientX - rect.left
    const dpr = devicePixelRatio || 1
    const cur = cursorsRef.current

    // First pass: check edge snapping (highest priority)
    let bestEdge: DragEdge | null = null
    let bestDist = SNAP_PX
    const vis = cursorVisRef.current

    for (const def of CURSOR_DEFS) {
      if (!vis[def.visKey]) continue
      const x0 = u.valToPos(cur[def.startKey], 'x', true) / dpr
      const x1 = u.valToPos(cur[def.endKey], 'x', true) / dpr
      if (!isFinite(x0) || !isFinite(x1)) continue

      const d0 = Math.abs(cssPx - x0)
      const d1 = Math.abs(cssPx - x1)
      if (d0 < bestDist) { bestDist = d0; bestEdge = def.startKey }
      if (d1 < bestDist) { bestDist = d1; bestEdge = def.endKey }
    }

    if (bestEdge) return { type: 'edge', key: bestEdge }

    // Second pass: check if inside a region
    for (const def of CURSOR_DEFS) {
      if (!vis[def.visKey]) continue
      const x0 = u.valToPos(cur[def.startKey], 'x', true) / dpr
      const x1 = u.valToPos(cur[def.endKey], 'x', true) / dpr
      if (!isFinite(x0) || !isFinite(x1)) continue

      const lo = Math.min(x0, x1)
      const hi = Math.max(x0, x1)
      if (cssPx >= lo && cssPx <= hi) {
        return { type: 'region', def }
      }
    }

    return null
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const hit = hitTest(e.clientX)
    if (!hit) return

    e.preventDefault()
    e.stopPropagation()

    if (hit.type === 'edge') {
      dragRef.current = { kind: 'edge', key: hit.key }
    } else {
      // Region drag: record anchor position and original start/end values
      const val = valFromClientX(e.clientX)
      if (val === null) return
      const cur = cursorsRef.current
      dragRef.current = {
        kind: 'region',
        startKey: hit.def.startKey as DragEdge,
        endKey: hit.def.endKey as DragEdge,
        anchorVal: val,
        origStart: cur[hit.def.startKey],
        origEnd: cur[hit.def.endKey],
      }
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current
    if (drag) {
      const val = valFromClientX(e.clientX)
      if (val === null) return

      if (drag.kind === 'edge') {
        setCursors({ [drag.key]: Math.max(0, val) })
      } else {
        // Region drag: shift both ends by the same delta
        const delta = val - drag.anchorVal
        const newStart = Math.max(0, drag.origStart + delta)
        const newEnd = Math.max(0, drag.origEnd + delta)
        setCursors({ [drag.startKey]: newStart, [drag.endKey]: newEnd })
      }
    } else {
      // Update hover cursor style
      const hit = hitTest(e.clientX)
      let cur = ''
      if (hit?.type === 'edge') cur = 'col-resize'
      else if (hit?.type === 'region') cur = 'grab'
      if (cur !== hoverCursor) setHoverCursor(cur)
    }
  }

  const handleMouseUp = () => { dragRef.current = null }

  // ================================================================
  // Axis zoom controls
  // ================================================================

  /** Zoom an axis by the given factor. factor < 1 zooms in, > 1 zooms out. */
  const zoomScale = (key: 'x' | 'y' | 'stim', factor: number) => {
    const u = plotRef.current
    if (!u) return
    const s = u.scales[key]
    if (!s || s.min == null || s.max == null) return
    const mid = (s.min + s.max) / 2
    const half = ((s.max - s.min) / 2) * factor
    u.setScale(key, { min: mid - half, max: mid + half })
  }

  /** Zoom an axis centered on a specific value (for wheel zoom). */
  const zoomScaleAt = (key: 'x' | 'y' | 'stim', factor: number, anchor: number) => {
    const u = plotRef.current
    if (!u) return
    const s = u.scales[key]
    if (!s || s.min == null || s.max == null) return
    const lo = anchor - (anchor - s.min) * factor
    const hi = anchor + (s.max - anchor) * factor
    u.setScale(key, { min: lo, max: hi })
  }

  /** Auto-range an axis to fit its data. */
  const autoScale = (key: 'x' | 'y' | 'stim') => {
    const u = plotRef.current
    if (!u) return

    if (key === 'x') {
      // x uses data[0]
      const arr = u.data[0] as number[] | undefined
      if (!arr || arr.length === 0) return
      const first = arr[0]
      const last = arr[arr.length - 1]
      if (!isFinite(first) || !isFinite(last) || first === last) return
      u.setScale('x', { min: first, max: last })
      return
    }

    // Determine which data series indices belong to this scale
    const indices: number[] = []
    if (key === 'y') {
      const stimIdx = stimSeriesIdxRef.current
      for (let i = 1; i < u.data.length; i++) {
        if (i === stimIdx) continue
        indices.push(i)
      }
    } else {
      const stimIdx = stimSeriesIdxRef.current
      if (stimIdx != null) indices.push(stimIdx)
    }

    let min = Infinity
    let max = -Infinity
    for (const idx of indices) {
      const arr = u.data[idx] as (number | null)[] | undefined
      if (!arr) continue
      for (const v of arr) {
        if (v == null || !isFinite(v)) continue
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    if (!isFinite(min) || !isFinite(max) || max === min) return
    const pad = (max - min) * 0.05
    u.setScale(key, { min: min - pad, max: max + pad })
  }

  // ================================================================
  // Mouse wheel zoom near axes
  // ================================================================
  // When the mouse hovers near the bottom (x-axis), left (y-axis), or right
  // (stim axis) edge of the plot, the wheel zooms that scale. Anywhere else,
  // we let the wheel scroll the page normally.
  // Mouse wheel zoom:
  //   Scroll         → zoom X axis (anchored at cursor position)
  //   Option + scroll → zoom Y axis
  //   Shift + scroll  → zoom Stimulus axis (if visible)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    const u = plotRef.current
    if (!u || !containerRef.current || !traceData) return

    e.preventDefault()
    const factor = e.deltaY < 0 ? 0.85 : 1.176

    if (e.altKey) {
      // Option/Alt + scroll → zoom Y
      zoomScale('y', factor)
    } else if (e.shiftKey && stimSeriesIdxRef.current != null) {
      // Shift + scroll → zoom Stimulus axis
      zoomScale('stim', factor)
    } else {
      // Default scroll → zoom X, anchored at mouse position
      const rect = containerRef.current.getBoundingClientRect()
      const cssPx = e.clientX - rect.left
      const canvasPx = cssPx * (devicePixelRatio || 1)
      const val = u.posToVal(canvasPx, 'x')
      if (isFinite(val)) {
        zoomScaleAt('x', factor, val)
      } else {
        zoomScale('x', factor)
      }
    }
  }, [traceData])

  // Outer wrapper is a column flex: control bar + plot container.
  // The plot container is ALWAYS rendered so containerRef stays stable,
  // which is critical for the ResizeObserver to attach correctly.
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* --- Control bar --- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '3px 8px',
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border)',
          fontSize: 'var(--font-size-xs)',
          flexShrink: 0,
          minHeight: 26,
        }}
      >
        {hasStimulus && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={showStimulusOverlay}
              onChange={toggleStimulusOverlay}
              style={{ margin: 0, accentColor: 'var(--stimulus-color)' }}
            />
            <span style={{ color: 'var(--stimulus-color)', fontWeight: 600 }}>Show stimulus</span>
          </label>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* X-axis zoom */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>X:</span>
            <button
              className="zoom-btn"
              onClick={() => zoomScale('x', 0.8)}
              disabled={!traceData}
              title="Zoom in X"
            >+</button>
            <button
              className="zoom-btn"
              onClick={() => zoomScale('x', 1.25)}
              disabled={!traceData}
              title="Zoom out X"
            >−</button>
            <button
              className="zoom-btn"
              onClick={() => autoScale('x')}
              disabled={!traceData}
              title="Auto-range X"
            >auto</button>
          </div>

          {/* Data Y-axis zoom */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>
              {traceData?.units || 'Y'}:
            </span>
            <button
              className="zoom-btn"
              onClick={() => zoomScale('y', 0.8)}
              disabled={!traceData}
              title="Zoom in Y"
            >+</button>
            <button
              className="zoom-btn"
              onClick={() => zoomScale('y', 1.25)}
              disabled={!traceData}
              title="Zoom out Y"
            >−</button>
            <button
              className="zoom-btn"
              onClick={() => autoScale('y')}
              disabled={!traceData}
              title="Auto-range Y"
            >auto</button>
          </div>

          {/* Stim Y-axis zoom — only when overlay is visible */}
          {hasStimulus && showStimulusOverlay && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <span style={{ color: 'var(--stimulus-color)', marginRight: 4 }}>
                {stimulus!.unit}:
              </span>
              <button
                className="zoom-btn"
                onClick={() => zoomScale('stim', 0.8)}
                title="Zoom in stimulus"
              >+</button>
              <button
                className="zoom-btn"
                onClick={() => zoomScale('stim', 1.25)}
                title="Zoom out stimulus"
              >−</button>
              <button
                className="zoom-btn"
                onClick={() => autoScale('stim')}
                title="Auto-range stimulus"
              >auto</button>
            </div>
          )}
        </div>
      </div>

      {/* --- Plot container --- */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          cursor: traceData
            ? (dragRef.current?.kind === 'region' ? 'grabbing'
               : dragRef.current?.kind === 'edge' ? 'col-resize'
               : hoverCursor || undefined)
            : undefined,
        }}
        onMouseDown={traceData ? handleMouseDown : undefined}
        onMouseMove={traceData ? handleMouseMove : undefined}
        onMouseUp={traceData ? handleMouseUp : undefined}
        onMouseLeave={traceData ? handleMouseUp : undefined}
        onWheel={traceData ? handleWheel : undefined}
      >
        {!traceData && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              textAlign: 'center',
              color: 'var(--text-muted)',
              zIndex: 20,
            }}
          >
            <div>
              <p style={{ fontSize: 'var(--font-size-base)', marginBottom: 8 }}>No trace loaded</p>
              <p style={{ fontSize: 'var(--font-size-sm)' }}>Open a file to view electrophysiology data</p>
            </div>
          </div>
        )}
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: 10,
          }}
        />
      </div>
    </div>
  )
}
