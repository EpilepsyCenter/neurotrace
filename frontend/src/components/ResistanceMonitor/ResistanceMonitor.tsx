import React, { useEffect, useRef, useMemo } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useAppStore, ResistanceQuality } from '../../stores/appStore'
import { useThemeStore } from '../../stores/themeStore'

/** Read a CSS custom property value from :root */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const QUALITY_CONFIG: Record<ResistanceQuality, { label: string; color: string; bg: string }> = {
  good:    { label: 'Good',    color: '#ffffff', bg: '#4caf50' },
  warning: { label: 'Warning', color: '#ffffff', bg: '#ff9800' },
  poor:    { label: 'Poor',    color: '#ffffff', bg: '#f44336' },
  unknown: { label: 'Unknown', color: 'var(--text-secondary)', bg: 'var(--bg-surface)' },
}

export function ResistanceMonitor() {
  const { resistanceMonitor, recording, selectSweep } = useAppStore()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)
  const monoFont = useThemeStore((s) => s.monoFont)

  const chartRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)

  // Look up the series label for the header
  const seriesLabel = useMemo(() => {
    if (!resistanceMonitor || !recording) return ''
    const g = recording.groups[resistanceMonitor.group]
    const s = g?.series[resistanceMonitor.series]
    return s?.label ?? `Series ${resistanceMonitor.series + 1}`
  }, [resistanceMonitor, recording])

  // Build & mount uPlot chart
  useEffect(() => {
    if (!chartRef.current || !resistanceMonitor) {
      if (plotRef.current) {
        plotRef.current.destroy()
        plotRef.current = null
      }
      return
    }

    // Destroy previous
    if (plotRef.current) {
      plotRef.current.destroy()
      plotRef.current = null
    }

    // Build data: x = 1-based sweep numbers, y = rs / rin
    // uPlot wants plain arrays (with null for missing)
    const x = resistanceMonitor.sweepIndices.map((i) => i + 1)
    const rsSeries = resistanceMonitor.rs.map((v) => (v == null || !isFinite(v) ? null : v))
    const rinSeries = resistanceMonitor.rin.map((v) => (v == null || !isFinite(v) ? null : v))

    const width = chartRef.current.clientWidth
    const height = chartRef.current.clientHeight

    const opts: uPlot.Options = {
      width: Math.max(width, 200),
      height: Math.max(height, 100),
      scales: {
        x: { time: false },
        rs: { auto: true },
        rin: { auto: true },
      },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: 'Sweep',
          labelSize: 16,
          font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
          incrs: [1, 2, 5, 10, 20, 50, 100],
        },
        {
          scale: 'rs',
          stroke: cssVar('--trace-color-1'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: 'Rs (MΩ)',
          labelSize: 16,
          font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
        },
        {
          scale: 'rin',
          side: 1, // right side
          stroke: cssVar('--trace-color-2'),
          grid: { show: false },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          label: 'Rin (MΩ)',
          labelSize: 16,
          font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          labelFont: `${cssVar('--font-size-sm')} ${cssVar('--font-mono')}`,
        },
      ],
      series: [
        {},
        {
          label: 'Rs',
          stroke: cssVar('--trace-color-1'),
          width: 2,
          points: { size: 6 },
          scale: 'rs',
        },
        {
          label: 'Rin',
          stroke: cssVar('--trace-color-2'),
          width: 2,
          points: { size: 6 },
          scale: 'rin',
        },
      ],
      cursor: {
        drag: { x: false, y: false },
        focus: { prox: 20 },
      },
    }

    const data: uPlot.AlignedData = [x, rsSeries as any, rinSeries as any]
    plotRef.current = new uPlot(opts, data, chartRef.current)

    // Click handler: jump to the nearest sweep
    const onClick = (ev: MouseEvent) => {
      const u = plotRef.current
      if (!u || !chartRef.current || !resistanceMonitor) return
      const rect = chartRef.current.getBoundingClientRect()
      const px = (ev.clientX - rect.left) * (devicePixelRatio || 1)
      const xVal = u.posToVal(px, 'x')
      if (!isFinite(xVal)) return
      // Find nearest sweep index
      let bestIdx = 0
      let bestDist = Infinity
      for (let i = 0; i < x.length; i++) {
        const d = Math.abs(x[i] - xVal)
        if (d < bestDist) { bestDist = d; bestIdx = i }
      }
      const sweepIdx = resistanceMonitor.sweepIndices[bestIdx]
      selectSweep(
        resistanceMonitor.group,
        resistanceMonitor.series,
        sweepIdx,
        resistanceMonitor.trace,
      )
    }

    chartRef.current.addEventListener('click', onClick)

    return () => {
      chartRef.current?.removeEventListener('click', onClick)
      plotRef.current?.destroy()
      plotRef.current = null
    }
  }, [resistanceMonitor, theme, fontSize, monoFont, selectSweep])

  // Handle resize
  useEffect(() => {
    if (!chartRef.current) return
    const observer = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !chartRef.current) return
      const w = chartRef.current.clientWidth
      const h = chartRef.current.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    })
    observer.observe(chartRef.current)
    return () => observer.disconnect()
  }, [])

  if (!resistanceMonitor) {
    return (
      <div className="panel">
        <div className="panel-title">Series / Input Resistance Monitor</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontStyle: 'italic', marginTop: 8 }}>
          Click <b>Run across all sweeps</b> in the Analysis panel to populate this view with Rs/Rin/Cm measurements from every sweep.
        </p>
      </div>
    )
  }

  const q = QUALITY_CONFIG[resistanceMonitor.quality]
  const nValid = resistanceMonitor.rs.filter((v) => v != null).length
  const nTotal = resistanceMonitor.rs.length

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      padding: '8px 12px',
      gap: 8,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          padding: '2px 8px',
          borderRadius: 3,
          background: q.bg,
          color: q.color,
          fontSize: 'var(--font-size-xs)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}>
          {q.label}
        </div>
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
          {seriesLabel} · {nValid}/{nTotal} valid · V<sub>step</sub> = {resistanceMonitor.vStep} mV
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)' }}>
          {resistanceMonitor.meanRs != null && (
            <span><span style={{ color: 'var(--trace-color-1)' }}>●</span>&nbsp;Rs = {resistanceMonitor.meanRs.toFixed(1)} MΩ</span>
          )}
          {resistanceMonitor.meanRin != null && (
            <span><span style={{ color: 'var(--trace-color-2)' }}>●</span>&nbsp;Rin = {resistanceMonitor.meanRin.toFixed(1)} MΩ</span>
          )}
          {resistanceMonitor.maxRsChangePct !== 0 && (
            <span style={{ color: 'var(--text-muted)' }}>
              max Δ Rs = {resistanceMonitor.maxRsChangePct.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      {/* Chart */}
      <div
        ref={chartRef}
        style={{
          flex: 1,
          position: 'relative',
          minHeight: 100,
          cursor: 'pointer',
        }}
        title="Click anywhere to jump to nearest sweep"
      />
    </div>
  )
}
