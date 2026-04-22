import React, { useRef, useEffect, useCallback, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useAppStore, CursorPositions, STIMULUS_TRACE_INDEX } from '../../stores/appStore'
import { useThemeStore } from '../../stores/themeStore'
import { ViewportBar, ViewportSlider } from './ViewportBar'

// Palette for non-primary recorded channels. Must match TracesDropdown.
const ADDITIONAL_CHANNEL_COLOR_VARS = [
  '--trace-color-2', '--trace-color-3', '--trace-color-4', '--trace-color-5',
]
function colorForChannel(idx: number): string {
  const name = idx === 0
    ? '--trace-color-1'
    : ADDITIONAL_CHANNEL_COLOR_VARS[(idx - 1) % ADDITIONAL_CHANNEL_COLOR_VARS.length]
  return cssVar(name)
}

type DragEdge =
  | 'baselineStart' | 'baselineEnd'
  | 'peakStart' | 'peakEnd'
  | 'fitStart' | 'fitEnd'

/** What we're dragging: a single edge, an entire region, or panning the view */
type DragTarget =
  | { kind: 'edge'; key: DragEdge }
  | { kind: 'region'; startKey: DragEdge; endKey: DragEdge; anchorVal: number; origStart: number; origEnd: number }
  | { kind: 'pan'; lastClientX: number; lastClientY: number }
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
  // Burst-marker refs — drawCursors reads these on every paint without
  // rebuilding itself.
  const fieldBurstsRef = useRef(useAppStore.getState().fieldBursts)
  const currentSweepRef = useRef(useAppStore.getState().currentSweep)
  const showBurstMarkersRef = useRef(useAppStore.getState().showBurstMarkers)
  // AP-marker refs — same pattern as bursts. Drawn always when an
  // entry exists for the current group/series; toggle could be added
  // later mirroring the bursts checkbox.
  const apAnalysesRef = useRef(useAppStore.getState().apAnalyses)
  // Latest traceData snapshot — read from drawCursors when painting
  // counting-only (no kinetics) AP markers, so we can look up the
  // y-value at a peak time without relying on react render cycles.
  const traceDataRef = useRef(useAppStore.getState().traceData)
  const showCoordinatesRef = useRef(useAppStore.getState().showCoordinates)
  const coordTooltipRef = useRef<HTMLDivElement>(null)

  // Tracks whether the CURRENT plot instance was built in Full (null viewport)
  // mode. Used in cleanup so we only persist x-range as the "Full-mode saved
  // range" when the plot actually rendered in Full mode — prevents a viewport
  // change (which flips store.viewport → null synchronously) from racing ahead
  // of the data-refetch and saving the stale windowed x-range as Full.
  const builtInFullModeRef = useRef<boolean>(false)

  const {
    traceData, cursors, setCursors,
    overlayEntries, showOverlay,
    averageTrace, showAverage,
    zoomMode,
    showCursors,
    cursorVisibility,
    sweepStimulusSegments,
    sweepStimulusUnit,
    zeroOffset,
    additionalTraces,
    currentTrace,
    currentSweep,
    fieldBursts,
    showBurstMarkers,
    apAnalyses,
    showCoordinates,
    toggleCoordinates,
  } = useAppStore()

  // Visible-trace set for the current series — includes recorded channel
  // indices plus the stimulus sentinel. Drives which series the plot draws.
  const visibleTracesForSeries = useAppStore((s) =>
    s.getVisibleTraces(s.currentGroup, s.currentSeries),
  )

  // Current series' stimulus info, if any.
  const stimulus = useAppStore((s) => {
    if (!s.recording) return null
    return s.recording.groups[s.currentGroup]?.series[s.currentSeries]?.stimulus ?? null
  })

  // Stimulus is drawn when it's in the visible set AND there is actual
  // stimulus data to draw.
  const stimulusDataPresent =
    (sweepStimulusSegments && sweepStimulusSegments.length > 0) ||
    (!!stimulus && (stimulus.segments?.length > 0 || stimulus.pulseEnd > stimulus.pulseStart))
  const showStimulusOverlay =
    stimulusDataPresent && visibleTracesForSeries.includes(STIMULUS_TRACE_INDEX)

  // Subscribe to theme so chart rebuilds on theme/font change
  const theme = useThemeStore((s) => s.theme)
  const fontUI = useThemeStore((s) => s.fontFamily)
  const fontSize = useThemeStore((s) => s.fontSize)
  const monoFont = useThemeStore((s) => s.monoFont)

  // Sync the refs every render
  cursorsRef.current = cursors
  showCursorsRef.current = showCursors
  cursorVisRef.current = cursorVisibility
  fieldBurstsRef.current = fieldBursts
  currentSweepRef.current = currentSweep
  showBurstMarkersRef.current = showBurstMarkers
  apAnalysesRef.current = apAnalyses
  traceDataRef.current = traceData
  showCoordinatesRef.current = showCoordinates

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

    // uPlot bbox is in CSS pixels — use directly, no dpr division.
    const { left, top, width: pw, height: ph } = u.bbox
    const by = top / dpr
    const bh = ph / dpr
    const bx = left / dpr
    const bw = pw / dpr

    // --- Cursor overlays --- (gated by the cursors visibility toggle)
    if (showCursorsRef.current) {
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
    } // end cursors block

    // ---- Burst markers ----
    // Burst dots + baseline/threshold lines render INDEPENDENTLY of the
    // cursor-visibility toggle — they're their own layer, gated by the
    // `Bursts` checkbox in the sidebar.
    //
    // Burst records carry RAW signal y values. If zero-offset is on the
    // displayed trace has been DC-shifted by `currentZeroOffset`; markers
    // must shift by the same amount to stay visually aligned with the trace.
    if (!showBurstMarkersRef.current) return
    const st = useAppStore.getState()
    const fbKey = `${st.currentGroup}:${st.currentSeries}`
    const fb = fieldBurstsRef.current[fbKey]
    const yOffset = st.zeroOffset ? st.currentZeroOffset : 0
    if (fb) {
      // Horizontal dashed lines spanning the plot: detection baseline and
      // thresholds from the last detection run on this series.
      const hLine = (y: number, color: string, label: string) => {
        const py = u.valToPos(y - yOffset, 'y', true) / dpr
        if (!isFinite(py)) return
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.setLineDash([5, 4])
        ctx.beginPath()
        ctx.moveTo(bx, py)
        ctx.lineTo(bx + bw, py)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = color
        ctx.font = `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`
        ctx.fillText(label, bx + 4, py - 3)
      }
      hLine(fb.baselineValue, 'rgba(158,158,158,0.8)', 'baseline')
      if (fb.thresholdHigh != null) {
        hLine(fb.thresholdHigh, 'rgba(229,115,115,0.7)', 'thr ↑')
      }
      if (fb.thresholdLow != null && fb.thresholdLow !== fb.thresholdHigh) {
        hLine(fb.thresholdLow, 'rgba(229,115,115,0.7)', 'thr ↓')
      }
    }
    if (fb && fb.bursts.length > 0) {
      const xScale = u.scales.x
      const xMin = xScale?.min ?? -Infinity
      const xMax = xScale?.max ?? Infinity
      const sweep = currentSweepRef.current
      const selected = fb.selectedIdx
      const colors = {
        baseline: '#9e9e9e',   // neutral grey
        peak: '#e57373',       // red
        decay: '#ffb74d',      // orange
        end: '#81c784',        // green
      }

      for (let i = 0; i < fb.bursts.length; i++) {
        const b = fb.bursts[i]
        if (b.sweepIndex !== sweep) continue
        if (b.endS < xMin || b.startS > xMax) continue

        const toPx = (x: number, y: number): [number, number] => {
          const px = u.valToPos(x, 'x', true) / dpr
          const py = u.valToPos(y - yOffset, 'y', true) / dpr
          return [px, py]
        }
        const peakY = b.preBurstBaseline + b.peakSigned
        const [px0, py0] = toPx(b.startS, b.preBurstBaseline)
        const [px1, py1] = toPx(b.peakTimeS, peakY)
        const [px3, py3] = toPx(b.endS, b.preBurstBaseline)
        const decayCoord =
          b.decayHalfTimeMs != null
            ? toPx(
                b.peakTimeS + b.decayHalfTimeMs / 1000,
                b.preBurstBaseline + b.peakSigned * 0.5,
              )
            : null

        const isSel = i === selected
        const r = isSel ? 6 : 4

        const drawDot = (px: number, py: number, color: string) => {
          if (!isFinite(px) || !isFinite(py)) return
          ctx.beginPath()
          ctx.arc(px, py, r, 0, 2 * Math.PI)
          ctx.fillStyle = color
          ctx.fill()
          ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.6)'
          ctx.lineWidth = isSel ? 2 : 1
          ctx.stroke()
        }

        drawDot(px0, py0, colors.baseline)
        drawDot(px1, py1, colors.peak)
        if (decayCoord) drawDot(decayCoord[0], decayCoord[1], colors.decay)
        drawDot(px3, py3, colors.end)

        // Faint vertical bar from pre-baseline to peak to anchor the group
        // visually; muted so it doesn't fight the trace.
        ctx.strokeStyle = 'rgba(229,115,115,0.35)'
        ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(px1, py0)
        ctx.lineTo(px1, py1)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    // ---- Action-Potential markers ----
    // Same approach as bursts — independent layer, reads the
    // current group/series's AP entry and draws spike-peak dots
    // (plus threshold dots when kinetics were measured) on the
    // current sweep. Y-values are raw signal so subtract yOffset
    // when zero-offset is on.
    const apKey = `${st.currentGroup}:${st.currentSeries}`
    const ap = apAnalysesRef.current[apKey]
    if (ap) {
      const xScale2 = u.scales.x
      const xMin2 = xScale2?.min ?? -Infinity
      const xMax2 = xScale2?.max ?? Infinity
      const sweep = currentSweepRef.current
      // Per-sweep peak times are the cheapest source — they exist
      // even when kinetics weren't measured. perSpike adds threshold,
      // amplitude, etc. when available; we use it to also dot the
      // threshold for visual context.
      const ps = ap.perSweep.find((p) => p.sweep === sweep)
      const peakTimes = ps?.peakTimes ?? []
      const sweepSpikes = ap.perSpike.filter((sp) => sp.sweep === sweep)
      const drawAPDot = (px: number, py: number, color: string, manual: boolean = false) => {
        if (!isFinite(px) || !isFinite(py)) return
        ctx.beginPath()
        ctx.arc(px, py, 4, 0, 2 * Math.PI)
        ctx.fillStyle = color
        ctx.fill()
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1
        ctx.stroke()
        if (manual) {
          ctx.beginPath()
          ctx.arc(px, py, 7, 0, 2 * Math.PI)
          ctx.strokeStyle = color
          ctx.lineWidth = 1.2
          ctx.stroke()
        }
      }
      if (sweepSpikes.length > 0) {
        // Color scheme matches the AP-window viewer's legend:
        //   peak       = #e57373 (red)
        //   threshold  = #9e9e9e (grey)
        //   FWHM tips  = #ffeb3b (yellow)
        //   fAHP       = #ffb74d (orange)
        //   mAHP       = #ff7043 (darker orange)
        const td = traceDataRef.current
        const tt = td?.time
        const tv = td?.values
        for (const sp of sweepSpikes) {
          if (sp.peakT < xMin2 || sp.peakT > xMax2) continue
          // Peak (always)
          const px = u.valToPos(sp.peakT, 'x', true) / dpr
          const py = u.valToPos(sp.peakVm - yOffset, 'y', true) / dpr
          drawAPDot(px, py, '#e57373', sp.manual)
          // Threshold (when kinetics measured)
          if (sp.thresholdT !== 0 || sp.thresholdVm !== 0) {
            const tpx = u.valToPos(sp.thresholdT, 'x', true) / dpr
            const tpy = u.valToPos(sp.thresholdVm - yOffset, 'y', true) / dpr
            drawAPDot(tpx, tpy, '#9e9e9e')
          }
          // FWHM crossings — find them on the main viewer's trace
          // data using the same walk-the-samples approach as the
          // AP window. Adds two small yellow dots + a dashed line
          // at the half-amplitude level.
          if (
            sp.halfWidthS != null && sp.amplitudeMv > 0 &&
            tt && tv && tt.length > 0
          ) {
            const halfV = sp.thresholdVm + sp.amplitudeMv / 2
            const tLo = sp.thresholdT
            const tHi = sp.peakT + sp.halfWidthS + 0.005
            const findCross = (t0: number, t1: number, ascending: boolean): number | null => {
              let prevT = -Infinity, prevV = NaN
              for (let i = 0; i < tt.length; i++) {
                const t = tt[i]
                if (t < t0) { prevT = t; prevV = tv[i]; continue }
                if (t > t1) break
                const v = tv[i]
                const above = v >= halfV
                if (isFinite(prevV)) {
                  const wasAbove = prevV >= halfV
                  if (ascending && !wasAbove && above) {
                    const frac = (halfV - prevV) / (v - prevV)
                    return prevT + frac * (t - prevT)
                  }
                  if (!ascending && wasAbove && !above) {
                    const frac = (halfV - prevV) / (v - prevV)
                    return prevT + frac * (t - prevT)
                  }
                }
                prevT = t; prevV = v
              }
              return null
            }
            const tLeft = findCross(tLo, sp.peakT, true)
            const tRight = findCross(sp.peakT, tHi, false)
            if (tLeft != null && tRight != null) {
              const pxL = u.valToPos(tLeft, 'x', true) / dpr
              const pyL = u.valToPos(halfV - yOffset, 'y', true) / dpr
              const pxR = u.valToPos(tRight, 'x', true) / dpr
              const pyR = u.valToPos(halfV - yOffset, 'y', true) / dpr
              if (isFinite(pxL) && isFinite(pyL) && isFinite(pxR) && isFinite(pyR)) {
                ctx.save()
                ctx.strokeStyle = '#ffeb3b'
                ctx.lineWidth = 1
                ctx.setLineDash([3, 3])
                ctx.beginPath()
                ctx.moveTo(pxL, pyL); ctx.lineTo(pxR, pyR)
                ctx.stroke()
                ctx.setLineDash([])
                ctx.restore()
                drawAPDot(pxL, pyL, '#ffeb3b')
                drawAPDot(pxR, pyR, '#ffeb3b')
              }
            }
          }
          // fAHP
          if (sp.fahpVm != null && sp.fahpT != null) {
            const px2 = u.valToPos(sp.fahpT, 'x', true) / dpr
            const py2 = u.valToPos(sp.fahpVm - yOffset, 'y', true) / dpr
            drawAPDot(px2, py2, '#ffb74d')
          }
          // mAHP
          if (sp.mahpVm != null && sp.mahpT != null) {
            const px3 = u.valToPos(sp.mahpT, 'x', true) / dpr
            const py3 = u.valToPos(sp.mahpVm - yOffset, 'y', true) / dpr
            drawAPDot(px3, py3, '#ff7043')
          }
        }
      } else if (peakTimes.length > 0) {
        // Counting-only fallback: dot at peak time using the
        // displayed-trace y-value (kinetics weren't measured so we
        // don't know peak Vm to a high precision).
        const td = traceDataRef.current
        if (td && td.time && td.values) {
          for (const t of peakTimes) {
            if (t < xMin2 || t > xMax2) continue
            // Nearest sample (linear scan — typical sweeps have a few
            // hundred AP markers max; binary search would be premature).
            let nearestIdx = 0
            let bestDist = Infinity
            for (let i = 0; i < td.time.length; i++) {
              const d = Math.abs(td.time[i] - t)
              if (d < bestDist) { bestDist = d; nearestIdx = i }
            }
            const y = td.values[nearestIdx]
            const px = u.valToPos(t, 'x', true) / dpr
            const py = u.valToPos(y, 'y', true) / dpr
            drawAPDot(px, py, '#e57373', false)
          }
        }
      }
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

    // Zero offset is now applied server-side (per-sweep, from the first ~3ms
    // of the full sweep) — frontend does no subtraction of its own.

    // Visibility for the current series.
    const primaryVisible = visibleTracesForSeries.includes(currentTrace)

    // Primary trace (the channel `currentTrace` points at — always the one
    // analyses run on). Hidden iff the user has it unchecked in the dropdown.
    columns.push(Array.from(traceData.values))
    seriesOpts.push({
      label: traceData.label || 'Trace',
      stroke: colorForChannel(currentTrace),
      width: 1.5,
      scale: 'y',
      show: primaryVisible,
    } as uPlot.Series)

    // Additional recorded channels the user has turned on.
    const primaryUnits = traceData.units || ''
    for (const chIdx of visibleTracesForSeries) {
      if (chIdx < 0 || chIdx === currentTrace) continue
      const td = additionalTraces[chIdx]
      if (!td) continue  // fetch may still be in flight
      // Align to the primary time array by index (backend returns same length
      // decimation for the same viewport). If lengths differ (rare edge on
      // boundary fetches), pad with nulls.
      const vals = new Array(time.length)
      const src = td.values
      for (let i = 0; i < time.length; i++) vals[i] = i < src.length ? src[i] : null
      columns.push(vals)
      const sameUnits = (td.units || '') === primaryUnits
      seriesOpts.push({
        label: td.label || `Ch ${chIdx + 1}`,
        stroke: colorForChannel(chIdx),
        width: 1.25,
        scale: sameUnits ? 'y' : 'y_alt',
      } as uPlot.Series)
    }

    // Overlay sweeps — data already reflects zero_offset from the server.
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

    // Average trace. The main trace's `time` array is typically the
    // backend's LTTB-decimated time (non-uniform) — we can't just
    // align the average's samples by index because the x axis sample
    // positions don't correspond. Interpolate the average onto the
    // main time axis instead.
    if (showAverage && averageTrace) {
      const avgT = averageTrace.time
      const avgV = averageTrace.values
      const vals: (number | null)[] = new Array(time.length).fill(null)
      if (avgT.length > 0 && avgV.length > 0) {
        // avgT is uniform (arange(n)/sr from the backend), so a linear
        // interpolation is fine and cheap. Walk both arrays in parallel.
        const nA = avgT.length
        let j = 0
        for (let i = 0; i < time.length; i++) {
          const t = time[i]
          if (t < avgT[0] || t > avgT[nA - 1]) {
            vals[i] = null
            continue
          }
          while (j < nA - 1 && avgT[j + 1] < t) j++
          if (j >= nA - 1) {
            vals[i] = avgV[nA - 1]
          } else {
            const span = avgT[j + 1] - avgT[j]
            if (span <= 0) {
              vals[i] = avgV[j]
            } else {
              const frac = (t - avgT[j]) / span
              vals[i] = avgV[j] + frac * (avgV[j + 1] - avgV[j])
            }
          }
        }
      }
      columns.push(vals as any)
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
  }, [traceData, overlayEntries, showOverlay, averageTrace, showAverage, theme, showStimulusOverlay, stimulus, sweepStimulusSegments, zeroOffset, visibleTracesForSeries, additionalTraces, currentTrace])

  // ================================================================
  // Track which series we last built the plot for, so we can save/restore ranges
  const lastSeriesRef = useRef<string | null>(null)
  const currentGroup = useAppStore((s) => s.currentGroup)
  const currentSeries = useAppStore((s) => s.currentSeries)
  const saveSeriesAxisRange = useAppStore((s) => s.saveSeriesAxisRange)
  const getSeriesAxisRange = useAppStore((s) => s.getSeriesAxisRange)

  // Create / recreate uPlot when data or overlays change
  // ================================================================
  useEffect(() => {
    if (!containerRef.current || !traceData) return

    // Save the current axis ranges before tearing down. X is persisted only
    // when the plot we're tearing down rendered in Full mode — otherwise
    // the "saved" x would be a viewport-window slice, which would wrongly
    // shrink the next Full-mode view when we rebuild. Y persists in both
    // modes (it's orthogonal to viewport).
    const prevKey = lastSeriesRef.current
    if (plotRef.current && prevKey) {
      const u = plotRef.current
      const xs = u.scales.x
      const ys = u.scales.y
      const stimS = u.scales.stim
      const [pg, ps] = prevKey.split(':').map(Number)
      const ranges: any = {}
      if (builtInFullModeRef.current && xs && xs.min != null && xs.max != null) {
        ranges.x = { min: xs.min, max: xs.max }
      }
      if (ys && ys.min != null && ys.max != null) {
        ranges.y = { min: ys.min, max: ys.max }
      }
      if (stimS && stimS.min != null && stimS.max != null) {
        ranges.stim = { min: stimS.min, max: stimS.max }
      }
      saveSeriesAxisRange(pg, ps, ranges)
    }

    lastSeriesRef.current = `${currentGroup}:${currentSeries}`

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
    //
    // X and Y `range` hooks read the CURRENT store on every call (not a
    // closure snapshot), so user actions (Apply ranges, drag-zoom, zoom-
    // controls) that save to the store immediately take effect on the next
    // draw. The setScale hook (below, in `hooks`) writes the store whenever
    // the user changes a scale, keeping the two in lock-step.
    const scales: uPlot.Scales = {
      x: {
        time: false,
        range: (_u, dataMin, dataMax) => {
          const vp = useAppStore.getState().viewport
          if (vp) return [vp.start, vp.end]
          const savedX = useAppStore.getState().getSeriesAxisRange(currentGroup, currentSeries)?.x
          if (savedX) return [savedX.min, savedX.max]
          return [dataMin, dataMax]
        },
      },
      y: {
        range: (_u, dataMin, dataMax) => {
          const savedY = useAppStore.getState().getSeriesAxisRange(currentGroup, currentSeries)?.y
          if (savedY) {
            // Sanity check: if the saved range doesn't cover any of the data
            // (e.g. user switched to a series with a completely different Y
            // baseline), fall through to auto-fit instead of showing an empty
            // plot. Triggers when the data is entirely outside the saved
            // range, or when the saved range covers < 5% of the data span.
            const dataSpan = dataMax - dataMin
            const savedSpan = savedY.max - savedY.min
            const entirelyOutside = dataMax < savedY.min || dataMin > savedY.max
            const savedTooNarrow =
              dataSpan > 0 && savedSpan > 0 && savedSpan < 0.05 * dataSpan
            if (!entirelyOutside && !savedTooNarrow) {
              return [savedY.min, savedY.max]
            }
            // fall through to auto behavior below
          }
          // In zero-offset mode with no saved range, default to symmetric
          // around 0 based on the currently-drawn data.
          if (zeroOffset) {
            const primary = data[1] as number[] | undefined
            let maxAbs = 0
            if (primary) {
              for (const v of primary) {
                if (v != null && isFinite(v)) {
                  const a = Math.abs(v)
                  if (a > maxAbs) maxAbs = a
                }
              }
            }
            const pad = maxAbs * 1.1 || 1
            return [-pad, pad]
          }
          return [dataMin, dataMax]
        },
      },
    }

    // Add y_alt scale + right-side axis if any visible additional channel
    // uses different units from the primary. (Iterate via series opts — the
    // scale name is already assigned in buildSeriesData.)
    const hasAltScale = seriesOpts.some((s) => (s as any).scale === 'y_alt')
    if (hasAltScale) {
      // Find the first series on 'y_alt' to label the axis with its units.
      const altSeriesIdx = seriesOpts.findIndex((s) => (s as any).scale === 'y_alt')
      const altCols: any = data[altSeriesIdx]
      void altCols  // unused — kept for clarity
      // We don't know per-series units inside here, but additionalTraces
      // does. Find the first additional channel with different units.
      let altUnits = ''
      for (const chIdx of visibleTracesForSeries) {
        if (chIdx < 0 || chIdx === currentTrace) continue
        const td = additionalTraces[chIdx]
        if (td && td.units !== traceData.units) {
          altUnits = td.units
          break
        }
      }
      scales.y_alt = {
        range: (_u, dataMin, dataMax) => [dataMin, dataMax],
      }
      axes.push({
        stroke: cssVar('--chart-axis'),
        grid: { show: false },
        ticks: { stroke: cssVar('--chart-tick'), width: 1 },
        label: altUnits || 'Alt',
        labelSize: 16,
        font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
        labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
        scale: 'y_alt',
        side: 1,
      })
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

      // Default range: ±halfWindow centered on 0 (small pulses), else
      // 20% pad around the pulse level.
      const defaultRange: [number, number] = needed <= halfWindow
        ? [-halfWindow, halfWindow]
        : (() => {
            const pad = needed * 0.2 || 1
            return [Math.min(0, pulse) - pad, Math.max(0, pulse) + pad]
          })()

      // Reads saved stim range live from the store (if any), so stim zooms
      // persist across sweep/series changes the same way X/Y do.
      scales.stim = {
        range: () => {
          const saved = useAppStore.getState()
            .getSeriesAxisRange(currentGroup, currentSeries)?.stim
          if (saved) return [saved.min, saved.max]
          return defaultRange
        },
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
          // We intercept the drag-zoom via the `setSelect` hook (below) and
          // drive the scale changes ourselves, so disable uPlot's built-in
          // auto-setScale. This lets us route X through the viewport system
          // (triggering a re-fetch at higher resolution) rather than letting
          // uPlot fight our X range hook.
          setScale: false,
          // No `uni` threshold — any rectangle drag zooms both axes.
        },
        focus: { prox: 30 },
      },
      scales,
      axes,
      series: seriesOpts,
      hooks: {
        draw: [() => drawCursors()],
        // Coordinate tooltip that follows the cursor. Position + content
        // come from uPlot's cursor state; visibility is gated by the
        // "Show/hide coordinates" toolbar toggle (read via ref so this
        // hook doesn't need to rebuild when the flag flips).
        setCursor: [
          (u: uPlot) => {
            const tip = coordTooltipRef.current
            if (!tip) return
            if (!showCoordinatesRef.current) {
              tip.style.display = 'none'
              return
            }
            const left = u.cursor.left
            const top = u.cursor.top
            const idx = u.cursor.idx
            if (
              left == null || top == null || idx == null ||
              left < 0 || top < 0 || !isFinite(idx as number)
            ) {
              tip.style.display = 'none'
              return
            }
            const xs = (u.data[0] as unknown as number[])?.[idx as number]
            const ys = (u.data[1] as unknown as (number | null)[])?.[idx as number]
            if (xs == null || ys == null || !isFinite(xs) || !isFinite(ys as number)) {
              tip.style.display = 'none'
              return
            }
            // Position the tooltip offset from the cursor so the OS mouse
            // arrow (which extends down-right from its tip) doesn't sit on
            // top of it. Default: above-right of the cursor. Flip below
            // when near the top edge; flip left when near the right edge.
            const dpr = devicePixelRatio || 1
            const plotRight = u.bbox.width / dpr
            const approxTipW = 110
            const approxTipH = 22
            const offsetX = 12
            const offsetY = 14
            const nearRight = left + offsetX + approxTipW > plotRight
            const nearTop = top - offsetY - approxTipH < 0
            tip.style.display = 'block'
            tip.style.left = nearRight
              ? `${left - offsetX - approxTipW}px`
              : `${left + offsetX}px`
            tip.style.top = nearTop
              ? `${top + offsetY + 10}px`          // below cursor
              : `${top - offsetY - approxTipH}px`  // above cursor (default)
            tip.textContent = `${(xs as number).toFixed(3)} s  ·  ${(ys as number).toFixed(3)}${traceData?.units ? ' ' + traceData.units : ''}`
          },
        ],
        // Drag-zoom rectangle completed: apply it ourselves.
        // Route X through the viewport system so we refetch at the zoomed
        // resolution; apply Y directly via setScale + persist to the store.
        setSelect: [
          (u: uPlot) => {
            const sel = u.select
            if (!sel || sel.width < 2 || sel.height < 2) {
              // Too small — treat as click, just clear selection
              u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
              return
            }
            // Pixel rect → data-space bounds. Y is inverted on screen.
            const xMin = u.posToVal(sel.left, 'x')
            const xMax = u.posToVal(sel.left + sel.width, 'x')
            const yMax = u.posToVal(sel.top, 'y')
            const yMin = u.posToVal(sel.top + sel.height, 'y')

            const st = useAppStore.getState()

            // X: viewport-mode routes to setViewport (triggers refetch).
            //    Full-mode uses u.setScale directly.
            if (st.viewport) {
              st.setViewport({ start: xMin, end: xMax })
            } else if (isFinite(xMin) && isFinite(xMax) && xMax > xMin) {
              u.setScale('x', { min: xMin, max: xMax })
            }

            // Y: set the scale now AND save to store so rebuilds preserve it.
            if (isFinite(yMin) && isFinite(yMax) && yMax > yMin) {
              u.setScale('y', { min: yMin, max: yMax })
              const cur = st.getSeriesAxisRange(currentGroup, currentSeries)
              st.saveSeriesAxisRange(currentGroup, currentSeries, {
                ...cur,
                y: { min: yMin, max: yMax },
              })
            }

            // Clear the visual selection rectangle.
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
          },
        ],
        // When the user drag-zooms on X (zoom mode), uPlot calls setScale('x')
        // with the new bounds. Since our X range hook would otherwise force
        // the scale back to the current viewport on the next redraw, we sync
        // the viewport to the user's zoom selection here. This both persists
        // the zoom AND triggers a refetch at the right resolution.
        setScale: [
          (u: uPlot, key: string) => {
            const st = useAppStore.getState()

            if (key === 'x') {
              const vp = st.viewport
              if (!vp) return  // Full mode — uPlot manages X freely
              const xs = u.scales.x
              if (xs?.min == null || xs?.max == null) return
              const EPS = 1e-6
              // Snap: scale matches viewport, nothing to do.
              if (Math.abs(xs.min - vp.start) < EPS && Math.abs(xs.max - vp.end) < EPS) return
              const newLen = xs.max - xs.min
              if (newLen <= 0 || !isFinite(newLen)) return
              // Mid-pan: update state only, no fetch per-frame. Clamp in
              // the same way setViewport does, otherwise pan past the
              // edges puts the store in an out-of-bounds state.
              if (dragRef.current?.kind === 'pan') {
                const dur = st.sweepDuration
                let start = xs.min
                let end = xs.max
                if (dur > 0) {
                  start = Math.max(0, Math.min(start, dur))
                  end = Math.max(start, Math.min(end, dur))
                }
                useAppStore.setState({ viewport: { start, end } })
              } else {
                // Drag-zoom, Apply-ranges, or zoom-button: deliberate viewport
                // change — update + refetch at higher resolution (setViewport
                // clamps internally).
                st.setViewport({ start: xs.min, end: xs.max })
              }
              return
            }

            if (key === 'y') {
              const ys = u.scales.y
              if (ys?.min == null || ys?.max == null) return
              // Persist the Y range to the store so the range hook returns it
              // on subsequent rebuilds (viewport scroll, etc). Without this,
              // drag-zooms on Y would be wiped when the data next changes.
              const EPS = 1e-6
              const cur = st.getSeriesAxisRange(currentGroup, currentSeries)
              const sameY =
                cur?.y &&
                Math.abs(cur.y.min - ys.min) < EPS &&
                Math.abs(cur.y.max - ys.max) < EPS
              if (sameY) return
              st.saveSeriesAxisRange(currentGroup, currentSeries, {
                ...cur,
                y: { min: ys.min, max: ys.max },
              })
            }
          },
        ],
      },
    }

    plotRef.current = new uPlot(opts, data, container)

    // Remember what viewport mode this plot was built with — used by cleanup.
    builtInFullModeRef.current = !useAppStore.getState().viewport

    // Scale ranges are handled by the `range` hooks in the scales config
    // above — no post-creation setScale needed. The hooks read viewport and
    // saved-range state, so the initial draw uses the correct bounds.

    drawCursors()

    // Cleanup on unmount or before next recreation
    return () => {
      // Save ranges before cleanup — carefully.
      //
      // X is only saved as the Full-mode range when the plot we're tearing
      // down was ACTUALLY rendered in Full mode. If the user just clicked
      // "Full" (viewport flipped to null synchronously) but the plot still
      // has a windowed x-scale on screen, saving x here would record the
      // windowed range and the next Full-mode rebuild would wrongly apply
      // it, shrinking the view to the old window.
      //
      // Y always persists regardless of viewport mode.
      const u = plotRef.current
      if (u) {
        const xs = u.scales.x
        const ys = u.scales.y
        const stimS = u.scales.stim
        const ranges: any = {}
        if (builtInFullModeRef.current && xs && xs.min != null && xs.max != null) {
          ranges.x = { min: xs.min, max: xs.max }
        }
        if (ys && ys.min != null && ys.max != null) {
          ranges.y = { min: ys.min, max: ys.max }
        }
        if (stimS && stimS.min != null && stimS.max != null) {
          ranges.stim = { min: stimS.min, max: stimS.max }
        }
        saveSeriesAxisRange(currentGroup, currentSeries, ranges)
      }
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
  }, [cursors, showCursors, cursorVisibility, fieldBursts, currentSweep, zeroOffset, showBurstMarkers, apAnalyses])

  // Hide the coordinate tooltip immediately when the toggle flips off.
  useEffect(() => {
    if (!showCoordinates && coordTooltipRef.current) {
      coordTooltipRef.current.style.display = 'none'
    }
  }, [showCoordinates])

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
          // Read current group/series from the store, not closure — the
          // listener is installed once and must survive series switches.
          const st = useAppStore.getState()
          const g = st.currentGroup
          const s = st.currentSeries
          if (ev.data.x) {
            if (st.viewport) {
              st.setViewport({ start: ev.data.x.min, end: ev.data.x.max })
            } else {
              const cur = st.getSeriesAxisRange(g, s) ?? {}
              st.saveSeriesAxisRange(g, s, {
                ...cur, x: { min: ev.data.x.min, max: ev.data.x.max },
              })
              u.setScale('x', { min: ev.data.x.min, max: ev.data.x.max })
            }
          }
          if (ev.data.y) {
            const cur = st.getSeriesAxisRange(g, s) ?? {}
            st.saveSeriesAxisRange(g, s, {
              ...cur, y: { min: ev.data.y.min, max: ev.data.y.max },
            })
            u.setScale('y', { min: ev.data.y.min, max: ev.data.y.max })
          }
        }
      }
      return () => ch.close()
    } catch { /* ignore */ }
  }, [])

  // ================================================================
  // Keyboard viewport navigation:
  //   ←  / →             scroll by one window
  //   Shift-← / Shift-→  scroll by two windows (fast)
  //   Home / End          jump to start / end
  // ================================================================
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when the user is typing in an input
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

      const st = useAppStore.getState()
      if (!st.viewport) return
      const len = st.viewport.end - st.viewport.start
      const step = e.shiftKey ? 2 * len : len
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        st.scrollViewport(-step)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        st.scrollViewport(step)
      } else if (e.key === 'Home') {
        e.preventDefault()
        st.setViewportStart(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        st.setViewportStart(Math.max(0, st.sweepDuration - len))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ================================================================
  // Resize: keep uPlot and canvas in sync with container
  // ================================================================
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Debounced max_points update: when the plot is resized, the ideal
    // resolution for the current viewport is ~ pixel-width × DPR. We don't
    // want to re-fetch on every frame of a resize drag, so we coalesce.
    let resizeTimer: number | null = null

    const observer = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !container) return
      const w = container.clientWidth
      const h = container.clientHeight
      if (w > 0 && h > 0) {
        // setSize triggers uPlot's draw hook, which calls drawCursors()
        u.setSize({ width: w, height: h })

        // Tie fetch resolution to display resolution (×2 for min/max-style
        // density, no point going higher).
        const dpr = window.devicePixelRatio || 1
        const targetPoints = Math.max(500, Math.floor(w * dpr * 2))
        const state = useAppStore.getState()
        if (targetPoints !== state.viewportMaxPoints) {
          if (resizeTimer !== null) window.clearTimeout(resizeTimer)
          resizeTimer = window.setTimeout(() => {
            const latest = useAppStore.getState()
            latest.setViewportMaxPoints(targetPoints)
            // Only re-fetch if a viewport is set (otherwise the full sweep
            // is already shown and max_points=0 behavior is fine).
            if (latest.viewport) {
              latest.refetchViewport().catch(() => { /* ignore */ })
            }
          }, 150)
        }
      }
    })

    observer.observe(container)
    return () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      observer.disconnect()
    }
  }, []) // stable — reads plotRef.current at call time

  // Keyboard: Left/Right scrolls the viewport by one window
  // (Shift+arrow = half-window for overlap).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when the user is typing in an input/textarea
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const state = useAppStore.getState()
      if (!state.viewport) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const len = state.viewport.end - state.viewport.start
      const step = e.shiftKey ? len / 2 : len
      state.scrollViewport(e.key === 'ArrowLeft' ? -step : step)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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

    if (hit) {
      e.preventDefault()
      e.stopPropagation()

      if (hit.type === 'edge') {
        dragRef.current = { kind: 'edge', key: hit.key }
      } else {
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
    } else if (!zoomMode) {
      // No cursor hit and zoom mode is off — start panning the view.
      // When zoom mode is on, let uPlot handle the drag-to-zoom instead.
      e.preventDefault()
      dragRef.current = { kind: 'pan', lastClientX: e.clientX, lastClientY: e.clientY }
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current
    if (drag) {
      if (drag.kind === 'edge') {
        const val = valFromClientX(e.clientX)
        if (val !== null) setCursors({ [drag.key]: Math.max(0, val) })
      } else if (drag.kind === 'region') {
        const val = valFromClientX(e.clientX)
        if (val !== null) {
          const delta = val - drag.anchorVal
          setCursors({ [drag.startKey]: Math.max(0, drag.origStart + delta), [drag.endKey]: Math.max(0, drag.origEnd + delta) })
        }
      } else if (drag.kind === 'pan') {
        // Pan: convert pixel delta to axis value delta and shift both scales.
        //
        // X in viewport mode MUST NOT go through u.setScale('x', ...) — the
        // X range hook would read the current (stale) viewport from the
        // store and clobber the shift. We update the viewport state in the
        // store directly; the range hook reads the fresh value on next draw.
        // (Refetch is deferred to mouseup via handleMouseUp to avoid one
        // fetch per mousemove.)
        const u = plotRef.current
        if (u && containerRef.current) {
          const dpr = devicePixelRatio || 1
          const dxPx = (e.clientX - drag.lastClientX) * dpr
          const dyPx = (e.clientY - drag.lastClientY) * dpr

          // X pan: convert pixel delta to value delta
          const xScale = u.scales.x
          if (xScale && xScale.min != null && xScale.max != null) {
            const plotW = u.bbox.width
            const xRange = xScale.max - xScale.min
            const dxVal = -(dxPx / plotW) * xRange
            const newMin = xScale.min + dxVal
            const newMax = xScale.max + dxVal

            const st = useAppStore.getState()
            if (st.viewport) {
              // Clamp to sweep edges so we can't pan off-end and poison the
              // viewport store.
              const dur = st.sweepDuration
              let start = newMin
              let end = newMax
              if (dur > 0) {
                start = Math.max(0, Math.min(start, dur))
                end = Math.max(start, Math.min(end, dur))
              }
              // Write viewport FIRST so the X range hook reads the new
              // values when uPlot calls it during the setScale below.
              useAppStore.setState({ viewport: { start, end } })
              u.setScale('x', { min: start, max: end })
            } else {
              // Full mode: the X range hook returns savedX if present, which
              // would clobber the shifted values here. Write savedX in the
              // store FIRST, then setScale — the hook reads fresh and
              // returns the panned range.
              const cur = st.getSeriesAxisRange(currentGroup, currentSeries) ?? {}
              st.saveSeriesAxisRange(currentGroup, currentSeries, {
                ...cur,
                x: { min: newMin, max: newMax },
              })
              u.setScale('x', { min: newMin, max: newMax })
            }
          }

          // Y pan — setScale observer rewrites savedY from u.scales.y, so
          // the range hook returns the shifted range on next draw.
          const yScale = u.scales.y
          if (yScale && yScale.min != null && yScale.max != null) {
            const plotH = u.bbox.height
            const yRange = yScale.max - yScale.min
            const dyVal = (dyPx / plotH) * yRange  // positive dy = move up = decrease values shown
            u.setScale('y', { min: yScale.min + dyVal, max: yScale.max + dyVal })
          }

          drag.lastClientX = e.clientX
          drag.lastClientY = e.clientY
        }
      }
    } else {
      const hit = hitTest(e.clientX)
      let cur = ''
      if (hit?.type === 'edge') cur = 'col-resize'
      else if (hit?.type === 'region') cur = 'grab'
      if (cur !== hoverCursor) setHoverCursor(cur)
    }
  }

  const handleMouseUp = () => {
    const wasPanning = dragRef.current?.kind === 'pan'
    dragRef.current = null
    // If we just finished panning in a viewport mode, fire a single refetch
    // so the data matches the new viewport at proper resolution.
    if (wasPanning && useAppStore.getState().viewport) {
      useAppStore.getState().refetchViewport().catch(() => { /* ignore */ })
    }
  }

  // ================================================================
  // Axis zoom controls
  // ================================================================

  /** Zoom an axis by the given factor. factor < 1 zooms in, > 1 zooms out. */
  /** Apply a new scale range, routing through the right persistence path so
   *  the range hook doesn't clobber the update.
   *
   *  X in viewport mode  → setViewport (refetch at new bounds).
   *  X in Full mode      → update savedX in the store, then u.setScale. The
   *                        range hook reads savedX fresh and returns the new
   *                        bounds; if we skipped the store write, the hook
   *                        would return the STALE savedX and the setScale
   *                        would appear to do nothing.
   *  Y (always)          → update savedY in store, then u.setScale. Same
   *                        reasoning as Full-mode X.
   *  stim                → u.setScale directly (no persistence layer).
   */
  const applyScale = (key: 'x' | 'y' | 'stim', min: number, max: number) => {
    const u = plotRef.current
    if (!u) return
    if (!isFinite(min) || !isFinite(max) || max <= min) return
    const st = useAppStore.getState()
    if (key === 'x' && st.viewport) {
      st.setViewport({ start: min, end: max })
      return
    }
    if (key === 'x') {
      const cur = st.getSeriesAxisRange(currentGroup, currentSeries) ?? {}
      st.saveSeriesAxisRange(currentGroup, currentSeries, { ...cur, x: { min, max } })
      u.setScale('x', { min, max })
      return
    }
    if (key === 'y') {
      const cur = st.getSeriesAxisRange(currentGroup, currentSeries) ?? {}
      st.saveSeriesAxisRange(currentGroup, currentSeries, { ...cur, y: { min, max } })
      u.setScale('y', { min, max })
      return
    }
    if (key === 'stim') {
      // Persist stim range per-series so zooming the stimulus axis survives
      // sweep switches (same pattern as X and Y).
      const cur = st.getSeriesAxisRange(currentGroup, currentSeries) ?? {}
      st.saveSeriesAxisRange(currentGroup, currentSeries, { ...cur, stim: { min, max } })
      u.setScale('stim', { min, max })
      return
    }
    u.setScale(key, { min, max })
  }

  const zoomScale = (key: 'x' | 'y' | 'stim', factor: number) => {
    const u = plotRef.current
    if (!u) return
    const s = u.scales[key]
    if (!s || s.min == null || s.max == null) return
    const mid = (s.min + s.max) / 2
    const half = ((s.max - s.min) / 2) * factor
    applyScale(key, mid - half, mid + half)
  }

  /** Zoom an axis centered on a specific value (for wheel zoom). */
  const zoomScaleAt = (key: 'x' | 'y' | 'stim', factor: number, anchor: number) => {
    const u = plotRef.current
    if (!u) return
    const s = u.scales[key]
    if (!s || s.min == null || s.max == null) return
    const lo = anchor - (anchor - s.min) * factor
    const hi = anchor + (s.max - anchor) * factor
    applyScale(key, lo, hi)
  }

  /** Auto-range an axis to fit its data. */
  const autoScale = (key: 'x' | 'y' | 'stim') => {
    const u = plotRef.current
    if (!u) return

    if (key === 'x') {
      const st = useAppStore.getState()
      // Viewport mode: "auto X" = expand the viewport to the whole sweep.
      // Staying in viewport mode means mouse pan + zoom keep working through
      // the viewport system (properly refetched data), instead of flipping
      // to Full mode where you pan through a decimated 5000-point view of
      // the whole sweep with no sensible mid-drag refetch.
      if (st.viewport && st.sweepDuration > 0) {
        st.setViewport({ start: 0, end: st.sweepDuration })
        return
      }
      // Full mode: clear the saved X range so the hook returns [dataMin, dataMax].
      const cur = st.getSeriesAxisRange(currentGroup, currentSeries) ?? {}
      if (cur.x) {
        const { x: _x, ...rest } = cur
        st.saveSeriesAxisRange(currentGroup, currentSeries, rest)
      }
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
    // Persist the result so it survives sweep switches. For 'stim', clear
    // the saved range entirely so the range hook falls back to the
    // protocol-derived default on the next rebuild (simplest "reset" UX).
    const st = useAppStore.getState()
    const cur = st.getSeriesAxisRange(currentGroup, currentSeries) ?? {}
    if (key === 'y') {
      st.saveSeriesAxisRange(currentGroup, currentSeries, { ...cur, y: { min: min - pad, max: max + pad } })
    } else if (key === 'stim') {
      const { stim: _stim, ...rest } = cur
      st.saveSeriesAxisRange(currentGroup, currentSeries, rest)
    }
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
        {/* TracesDropdown now lives in the main Toolbar (before the
            Overlay / Average group) so it's discoverable at first
            glance. Kept the import around for the badge below. */}

        {/* "This sweep is excluded" badge. Click to restore. */}
        <ExcludedSweepBadge />

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Coordinate-tooltip toggle — shows x/y readout near the cursor
              when hovering over the trace. */}
          <button
            className="zoom-btn"
            onClick={toggleCoordinates}
            disabled={!traceData}
            title={showCoordinates ? 'Hide hover coordinates' : 'Show hover coordinates (x, y)'}
            style={showCoordinates ? {
              background: 'var(--accent)',
              borderColor: 'var(--accent)',
              color: '#fff',
            } : undefined}
          >
            x,y
          </button>

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

          {/* Stim Y-axis zoom — only when stimulus is a visible trace */}
          {showStimulusOverlay && stimulus && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <span style={{ color: 'var(--stimulus-color)', marginRight: 4 }}>
                {stimulus.unit}:
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

      {/* --- Viewport bar (window size, scroll, time readout) --- */}
      <ViewportBar />

      {/* --- Plot container --- */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          cursor: traceData
            ? (dragRef.current?.kind === 'pan' ? 'move'
               : dragRef.current?.kind === 'region' ? 'grabbing'
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
        {/* Hover coordinate tooltip — positioned by the setCursor hook. */}
        <div
          ref={coordTooltipRef}
          style={{
            position: 'absolute',
            display: 'none',
            pointerEvents: 'none',
            zIndex: 15,
            padding: '2px 6px',
            background: 'rgba(0, 0, 0, 0.72)',
            color: '#fff',
            fontSize: 'var(--font-size-label)',
            fontFamily: 'var(--font-mono)',
            borderRadius: 3,
            whiteSpace: 'nowrap',
          }}
        />
      </div>

      {/* --- Viewport scroll slider --- */}
      <ViewportSlider />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Excluded-sweep badge — rendered inline in the TraceViewer control bar.
// Shows only when the currently-displayed sweep is in the exclusion set;
// click to restore that sweep into the active analysis pool.
// ---------------------------------------------------------------------------

function ExcludedSweepBadge() {
  const group = useAppStore((s) => s.currentGroup)
  const series = useAppStore((s) => s.currentSeries)
  const sweep = useAppStore((s) => s.currentSweep)
  const isExcluded = useAppStore((s) => s.isSweepExcluded(group, series, sweep))
  const toggleSweepExcluded = useAppStore((s) => s.toggleSweepExcluded)
  if (!isExcluded) return null
  return (
    <button
      onClick={() => toggleSweepExcluded(group, series, sweep)}
      title="This sweep is excluded from analyses — click to restore it."
      style={{
        fontSize: 'var(--font-size-label)',
        fontWeight: 600,
        color: '#fff',
        background: '#e65100',
        border: 'none',
        padding: '2px 8px',
        borderRadius: 3,
        cursor: 'pointer',
        lineHeight: 1.4,
      }}
    >
      ⊘ Excluded — click to restore
    </button>
  )
}
