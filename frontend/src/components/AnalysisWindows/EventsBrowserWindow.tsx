import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  useAppStore,
  EventsData, EventRow,
} from '../../stores/appStore'
import { useThemeStore } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'

/**
 * Events — Browser & Overlay window.
 *
 * Separate Electron window that owns the two heavier event-analysis
 * views (per-event browser + all-events overlay). Tied to the main
 * Event Detection window via the same ``eventsWindowSession`` prefs
 * slot + BroadcastChannel that the Template Refine window uses, so
 * navigating in the main window (e.g. switching series) updates which
 * analysis entry this window browses.
 *
 * Why a separate window: these views are big — the overlay stacks
 * every event, the browser keeps its own sub-trace plot alive per
 * selection — and users want to keep them on a second monitor beside
 * the main trace + results. Matches EE's detachable panels.
 *
 * Both plots support:
 *   - Scroll wheel to zoom X (Alt+wheel zooms Y)
 *   - Drag to pan
 *   - Double-click to reset to auto-range
 *
 * The browser tab honours the pre-detection filter (with a toggle so
 * users can A/B raw vs filtered), and draws peak / foot / decay
 * markers plus the rise 20/80 crossings and the half-amplitude bar —
 * the same set EE shows on page 29 of the manual.
 */

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

export function EventsBrowserWindow({
  backendUrl, fileInfo,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
}) {
  void fileInfo
  const eventsAnalyses = useAppStore((s) => s.eventsAnalyses)
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)
  void theme; void fontSize

  // Follow the main events window's (group, series) via the shared
  // prefs snapshot + live broadcast. Same pattern as the Refinement
  // window — no backend round-trips, all cross-window sync goes
  // through BroadcastChannel messages.
  const [sessionKey, setSessionKey] = useState<string | null>(null)
  useEffect(() => {
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const s = prefs?.eventsWindowSession
        if (s && typeof s.group === 'number' && typeof s.series === 'number') {
          setSessionKey(`${s.group}:${s.series}`)
        }
      } catch { /* ignore */ }
    })()
    try {
      const ch = new BroadcastChannel('neurotrace-sync')
      ch.onmessage = (ev) => {
        if (ev.data?.type === 'events-session-update' && ev.data.eventsWindowSession) {
          const s = ev.data.eventsWindowSession
          if (typeof s.group === 'number' && typeof s.series === 'number') {
            setSessionKey(`${s.group}:${s.series}`)
          }
        }
      }
      return () => ch.close()
    } catch { /* ignore */ }
  }, [])

  // Fallback to "the series with the most events" if no session exists
  // yet (user opened the browser without ever having the main events
  // window focused). Matches the Refinement window's defensive default.
  const entry: EventsData | undefined = useMemo(() => {
    if (sessionKey && eventsAnalyses[sessionKey]) return eventsAnalyses[sessionKey]
    const entries = Object.values(eventsAnalyses)
    if (entries.length === 0) return undefined
    return entries.reduce((best, cur) =>
      (cur.events.length > (best?.events.length ?? 0) ? cur : best), entries[0])
  }, [eventsAnalyses, sessionKey])

  const selectEvent = useAppStore((s) => s.selectEvent)
  const removeEvent = useAppStore((s) => s.removeEvent)

  const [tab, setTab] = useState<'browser' | 'overlay'>('browser')

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 10, gap: 10, minHeight: 0,
    }}>
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0,
        background: 'var(--bg-secondary)',
        padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)',
        fontSize: 'var(--font-size-label)',
      }}>
        <span style={{ fontWeight: 600 }}>Events browser</span>
        {entry ? (
          <span style={{ color: 'var(--text-muted)' }}>
            G{entry.group} / S{entry.series} · {entry.events.length} detected events
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>
            No events detected — run detection in the main Events window first.
          </span>
        )}
      </div>

      {/* Tab bar — Browser | Overlay. Only these two views live here;
          Results / Histogram / Rate stay in the main events window. */}
      <div style={{
        display: 'flex', gap: 2,
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        {(['browser', 'overlay'] as const).map((k) => (
          <button key={k} className="btn" onClick={() => setTab(k)}
            style={{
              padding: '4px 14px', fontSize: 'var(--font-size-label)',
              background: tab === k ? 'var(--bg-primary)' : 'transparent',
              borderBottom: tab === k
                ? '2px solid var(--accent, #64b5f6)'
                : '2px solid transparent',
              borderRadius: '3px 3px 0 0',
            }}>
            {k === 'browser' ? 'Browser' : 'Overlay'}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'browser' && (
          <EventBrowserPanel
            backendUrl={backendUrl}
            entry={entry}
            onSelect={(idx) => entry && selectEvent(entry.group, entry.series, idx)}
            onDiscard={(idx) => entry && removeEvent(entry.group, entry.series, idx)}
          />
        )}
        {tab === 'overlay' && (
          <AllEventsOverlayPanel
            backendUrl={backendUrl}
            entry={entry}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared zoom / pan behaviour — wheel-to-zoom, drag-to-pan, dbl-click
// to reset. Attached to uPlot's over layer. Returns a teardown fn.
// ---------------------------------------------------------------------------

function attachZoomPan(u: uPlot): () => void {
  const over = (u as any).over as HTMLDivElement
  if (!over) return () => {}
  type Drag = {
    startPxX: number; startPxY: number
    xMin: number; xMax: number; yMin: number; yMax: number
    panning: boolean
  }
  let drag: Drag | null = null
  const THRESHOLD = 3

  const onPointerDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return
    const xMin = u.scales.x.min, xMax = u.scales.x.max
    const yMin = u.scales.y.min, yMax = u.scales.y.max
    if (xMin == null || xMax == null || yMin == null || yMax == null) return
    const rect = over.getBoundingClientRect()
    drag = {
      startPxX: ev.clientX - rect.left,
      startPxY: ev.clientY - rect.top,
      xMin, xMax, yMin, yMax, panning: false,
    }
    over.setPointerCapture(ev.pointerId)
  }
  const onPointerMove = (ev: PointerEvent) => {
    if (!drag) return
    const rect = over.getBoundingClientRect()
    const dxPx = (ev.clientX - rect.left) - drag.startPxX
    const dyPx = (ev.clientY - rect.top) - drag.startPxY
    if (!drag.panning && Math.abs(dxPx) < THRESHOLD && Math.abs(dyPx) < THRESHOLD) return
    drag.panning = true
    const bboxW = u.bbox.width / (devicePixelRatio || 1)
    const bboxH = u.bbox.height / (devicePixelRatio || 1)
    const dx = -(dxPx / bboxW) * (drag.xMax - drag.xMin)
    const dy = (dyPx / bboxH) * (drag.yMax - drag.yMin)
    u.setScale('x', { min: drag.xMin + dx, max: drag.xMax + dx })
    u.setScale('y', { min: drag.yMin + dy, max: drag.yMax + dy })
    over.style.cursor = 'grabbing'
  }
  const onPointerUp = (ev: PointerEvent) => {
    if (!drag) return
    drag = null
    try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
    over.style.cursor = ''
  }
  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault()
    const rect = over.getBoundingClientRect()
    const pxX = ev.clientX - rect.left
    const pxY = ev.clientY - rect.top
    const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
    if (ev.altKey) {
      const yMin = u.scales.y.min, yMax = u.scales.y.max
      if (yMin == null || yMax == null) return
      const yAt = u.posToVal(pxY, 'y')
      u.setScale('y', {
        min: yAt - (yAt - yMin) * factor,
        max: yAt + (yMax - yAt) * factor,
      })
    } else {
      const xMin = u.scales.x.min, xMax = u.scales.x.max
      if (xMin == null || xMax == null) return
      const xAt = u.posToVal(pxX, 'x')
      u.setScale('x', {
        min: xAt - (xAt - xMin) * factor,
        max: xAt + (xMax - xAt) * factor,
      })
    }
  }
  const onDblClick = (_ev: MouseEvent) => {
    // Reset to auto-range.
    u.setScale('x', { min: null as any, max: null as any })
    u.setScale('y', { min: null as any, max: null as any })
  }

  over.addEventListener('pointerdown', onPointerDown)
  over.addEventListener('pointermove', onPointerMove)
  over.addEventListener('pointerup', onPointerUp)
  over.addEventListener('pointercancel', onPointerUp)
  over.addEventListener('wheel', onWheel, { passive: false })
  over.addEventListener('dblclick', onDblClick)

  return () => {
    over.removeEventListener('pointerdown', onPointerDown)
    over.removeEventListener('pointermove', onPointerMove)
    over.removeEventListener('pointerup', onPointerUp)
    over.removeEventListener('pointercancel', onPointerUp)
    over.removeEventListener('wheel', onWheel)
    over.removeEventListener('dblclick', onDblClick)
  }
}

// ---------------------------------------------------------------------------
// Browser panel — single-event zoomed view with EE-style kinetics
// markers (peak, foot, decay endpoint, 20/80 rise crossings,
// half-amplitude bar). Optionally fetches the trace through the
// pre-detection filter so the user can A/B raw vs filtered shape.
// ---------------------------------------------------------------------------

function EventBrowserPanel({
  backendUrl, entry,
  onSelect, onDiscard,
}: {
  backendUrl: string
  entry: EventsData | undefined
  onSelect: (idx: number) => void
  onDiscard: (idx: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [preMs, setPreMs] = useState(10)
  const [winMs, setWinMs] = useState(60)
  const [respectFilter, setRespectFilter] = useState(true)

  const idx = entry?.selectedIdx ?? (entry && entry.events.length > 0 ? 0 : null)
  const ev: EventRow | null = entry && idx != null && idx >= 0 && idx < entry.events.length
    ? entry.events[idx]
    : null

  // Keyboard nav — ← / → step through events. Ignores inputs so
  // users can type into the window/pre fields without flipping events.
  useEffect(() => {
    if (!entry) return
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT'
                || t.tagName === 'TEXTAREA')) return
      if (e.key === 'ArrowRight') {
        const cur = entry.selectedIdx ?? -1
        const nxt = Math.min(entry.events.length - 1, cur + 1)
        if (nxt !== cur) onSelect(nxt); e.preventDefault()
      } else if (e.key === 'ArrowLeft') {
        const cur = entry.selectedIdx ?? 0
        const nxt = Math.max(0, cur - 1)
        if (nxt !== cur) onSelect(nxt); e.preventDefault()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [entry, onSelect])

  const [winData, setWinData] = useState<{
    time: number[]; values: (number | null)[]
  } | null>(null)
  useEffect(() => {
    if (!backendUrl || !entry || !ev) { setWinData(null); return }
    const after = Math.max(1, winMs - preMs)
    // Re-use the /overlay endpoint in single-event mode. The endpoint
    // already honours the pre-detection filter flag we pass through —
    // so the same code path handles both raw and filtered views.
    const filterParams = respectFilter && entry.params.filterEnabled ? {
      filter_enabled: true,
      filter_type: entry.params.filterType,
      filter_low: entry.params.filterLow,
      filter_high: entry.params.filterHigh,
      filter_order: entry.params.filterOrder,
    } : {}
    fetch(`${backendUrl}/api/events/overlay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group: entry.group, series: entry.series,
        sweep: entry.sweep, trace: entry.channel,
        events: [{
          peak_idx: ev.peakIdx, foot_idx: ev.footIdx,
          baseline_val: ev.baselineVal,
        }],
        align: 'peak',
        window_before_ms: preMs,
        window_after_ms: after,
        baseline_subtract: false,
        ...filterParams,
      }),
    }).then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((d) => {
        const row = (d.traces?.[0] ?? []) as (number | null)[]
        setWinData({
          time: (d.time_s ?? []).map((x: any) => Number(x)),
          values: row.map((x) => x == null ? null : Number(x)),
        })
      })
      .catch(() => setWinData(null))
  }, [backendUrl, entry, ev, preMs, winMs, respectFilter])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let teardown: (() => void) | null = null
    if (plotRef.current) {
      plotRef.current.destroy()
      plotRef.current = null
    }
    if (!winData || winData.time.length === 0 || !ev || !entry) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      const sr = entry.samplingRate || 1
      const footOff = (ev.footIdx - ev.peakIdx) / sr
      const decayOff = ev.decayEndpointIdx != null
        ? (ev.decayEndpointIdx - ev.peakIdx) / sr : null
      // 20 / 80 rise crossings — find them by scanning winData.values
      // from peak backward (rise goes baseline → peak). Matches how
      // `rise_time_ms` is computed on the backend, so the dots
      // coincide with the reported rise time.
      const amp = ev.amplitude
      let rise20Off: number | null = null
      let rise80Off: number | null = null
      let halfLeft: number | null = null
      let halfRight: number | null = null
      if (amp !== 0) {
        const t20 = ev.baselineVal + 0.20 * amp
        const t80 = ev.baselineVal + 0.80 * amp
        const halfV = ev.baselineVal + 0.50 * amp
        const upward = amp > 0
        // Find the sample nearest t=0 (the peak) in winData.
        let peakI = 0, bestDT = Infinity
        for (let i = 0; i < winData.time.length; i++) {
          const dt = Math.abs(winData.time[i])
          if (dt < bestDT) { bestDT = dt; peakI = i }
        }
        // Walk backward from peak to find last sample on peak-side of each.
        const onPeakSide = (v: number, target: number) =>
          upward ? v >= target : v <= target
        const findBwd = (target: number): number | null => {
          for (let i = peakI - 1; i >= 0; i--) {
            const v = winData.values[i]
            if (v == null) continue
            if (!onPeakSide(v, target)) return winData.time[i + 1]
          }
          return null
        }
        // Walk forward from peak (decay side) for half-amplitude right.
        const findFwd = (target: number): number | null => {
          for (let i = peakI + 1; i < winData.time.length; i++) {
            const v = winData.values[i]
            if (v == null) continue
            if (!onPeakSide(v, target)) return winData.time[i - 1]
          }
          return null
        }
        rise20Off = findBwd(t20)
        rise80Off = findBwd(t80)
        halfLeft = findBwd(halfV)
        halfRight = findFwd(halfV)
      }
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: { x: { time: false }, y: { auto: true } },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            values: (_u, vals) => vals.map((v) => (v * 1000).toFixed(1)),
            label: 'Time (ms, 0 = peak)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 55, label: entry.units,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [{}, { stroke: cssVar('--trace-color-1'), width: 1.5, spanGaps: false }],
        hooks: {
          draw: [(u) => {
            const ctx = u.ctx
            const dpr = devicePixelRatio || 1
            // Baseline horizontal line (gray dashed).
            const byPos = u.valToPos(ev.baselineVal, 'y', true)
            ctx.save()
            ctx.strokeStyle = 'rgba(158,158,158,0.7)'
            ctx.setLineDash([4 * dpr, 3 * dpr])
            ctx.lineWidth = 1 * dpr
            ctx.beginPath()
            ctx.moveTo(u.bbox.left, byPos)
            ctx.lineTo(u.bbox.left + u.bbox.width, byPos)
            ctx.stroke()
            ctx.setLineDash([])
            // Half-amplitude bar (yellow dashed between left / right
            // half crossings). EE's "FWHM" display on page 29.
            if (halfLeft != null && halfRight != null && amp !== 0) {
              const halfV = ev.baselineVal + 0.50 * amp
              const hyPos = u.valToPos(halfV, 'y', true)
              const hxL = u.valToPos(halfLeft, 'x', true)
              const hxR = u.valToPos(halfRight, 'x', true)
              ctx.strokeStyle = '#ffeb3b'
              ctx.setLineDash([4 * dpr, 3 * dpr])
              ctx.lineWidth = 1.25 * dpr
              ctx.beginPath()
              ctx.moveTo(hxL, hyPos); ctx.lineTo(hxR, hyPos)
              ctx.stroke()
              ctx.setLineDash([])
              // FWHM crossing dots — sit on the trace, so keep them a
              // touch smaller than the foot/peak anchors but still
              // clearly visible (matching the 20/80 rise dots).
              ctx.fillStyle = '#ffeb3b'
              ctx.strokeStyle = '#ffffff'
              ctx.lineWidth = 1 * dpr
              ctx.beginPath(); ctx.arc(hxL, hyPos, 4 * dpr, 0, 2 * Math.PI)
              ctx.fill(); ctx.stroke()
              ctx.beginPath(); ctx.arc(hxR, hyPos, 4 * dpr, 0, 2 * Math.PI)
              ctx.fill(); ctx.stroke()
            }
            // Radii in CSS pixels (multiplied by dpr inside drawDot).
            // Matches the burst markers on the main TraceViewer so the
            // browser doesn't feel visually secondary. Peak is biggest
            // (the event's primary anchor); kinetic markers a touch
            // smaller; rise 20 / 80 and half-amplitude crossings are
            // fine dots because they're on the already-visible trace
            // rather than the baseline reference line.
            const drawDot = (x: number, y: number, color: string, r: number = 5) => {
              if (!isFinite(x) || !isFinite(y)) return
              ctx.fillStyle = color
              ctx.beginPath(); ctx.arc(x, y, r * dpr, 0, 2 * Math.PI); ctx.fill()
              ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5 * dpr; ctx.stroke()
            }
            // Foot (gray) — same size as burst baseline dots.
            drawDot(u.valToPos(footOff, 'x', true), byPos, '#9e9e9e', 5)
            // 20/80 rise (cyan / teal) on the rising edge. Slightly
            // smaller because they sit ON the trace line — too big and
            // they'd obscure the rising edge shape.
            if (rise20Off != null && amp !== 0) {
              const t20 = ev.baselineVal + 0.20 * amp
              drawDot(u.valToPos(rise20Off, 'x', true),
                      u.valToPos(t20, 'y', true), '#4dd0e1', 4)
            }
            if (rise80Off != null && amp !== 0) {
              const t80 = ev.baselineVal + 0.80 * amp
              drawDot(u.valToPos(rise80Off, 'x', true),
                      u.valToPos(t80, 'y', true), '#26a69a', 4)
            }
            // Peak (red) — biggest, primary anchor for the event.
            const pxPos = u.valToPos(0, 'x', true)
            const pyPos = u.valToPos(ev.peakVal, 'y', true)
            drawDot(pxPos, pyPos, '#e57373', 6)
            // Decay endpoint (purple)
            if (decayOff != null) {
              drawDot(u.valToPos(decayOff, 'x', true), byPos, '#ab47bc', 5)
            }
            ctx.restore()
          }],
        },
      }
      const payload: uPlot.AlignedData = [
        winData.time as any, winData.values as any,
      ]
      plotRef.current = new uPlot(opts, payload, container)
      teardown = attachZoomPan(plotRef.current!)
    })
    return () => {
      cancelAnimationFrame(frame)
      if (teardown) teardown()
    }
  }, [winData, ev, entry])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (!entry || entry.events.length === 0) {
    return (
      <div style={{
        padding: 16, textAlign: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        Run detection in the main Events window to browse events here.
      </div>
    )
  }

  const unit = entry.units
  const cur = (idx ?? 0) + 1
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      gap: 6, minHeight: 0,
    }}>
      {/* Nav strip */}
      <div style={{
        display: 'flex', gap: 6, alignItems: 'center',
        fontSize: 'var(--font-size-label)', flexShrink: 0,
      }}>
        <button className="btn" onClick={() => onSelect(Math.max(0, (idx ?? 0) - 1))}
          disabled={(idx ?? 0) <= 0}
          style={{ padding: '3px 10px' }} title="Previous event (←)">← Prev</button>
        <span style={{
          fontFamily: 'var(--font-mono)', minWidth: 60, textAlign: 'center',
        }}>{cur} / {entry.events.length}</span>
        <button className="btn" onClick={() => onSelect(Math.min(entry.events.length - 1, (idx ?? 0) + 1))}
          disabled={(idx ?? 0) >= entry.events.length - 1}
          style={{ padding: '3px 10px' }} title="Next event (→)">Next →</button>
        <span style={{ flex: 1 }} />
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
               title="When on, the plot shows the trace AFTER the pre-detection filter has been applied (same signal the detector sees). When off, shows the raw unfiltered sweep.">
          <input type="checkbox" checked={respectFilter}
            onChange={(e) => setRespectFilter(e.target.checked)} />
          <span>Filter{entry.params.filterEnabled
            ? '' : ' (off in detection)'}</span>
        </label>
        {ev && (
          <button className="btn"
            onClick={() => {
              // Tell the main events window to re-centre its viewer
              // on this event. Keeps the detached browser useful
              // for QC: poke through events here, hit "Go to event"
              // to see the same event in the main window's context
              // (cursors, markers, trace neighbours). The main
              // window's BroadcastChannel listener consumes this.
              if (!ev) return
              try {
                const ch = new BroadcastChannel('neurotrace-sync')
                ch.postMessage({
                  type: 'events-navigate-to',
                  timeS: ev.peakTimeS,
                  windowS: 0.06,
                })
                ch.close()
              } catch { /* ignore */ }
            }}
            style={{ padding: '3px 10px' }}
            title="Recentre the main Events window's viewer on this event">
            Go to event
          </button>
        )}
        {ev && (
          <button className="btn" onClick={() => idx != null && onDiscard(idx)}
            style={{ padding: '3px 10px' }} title="Remove this event">
            Discard
          </button>
        )}
      </div>

      {/* Kinetics card + mini plot side-by-side */}
      <div style={{
        display: 'flex', gap: 8, flex: 1, minHeight: 0,
      }}>
        <div style={{
          width: 200, flexShrink: 0,
          padding: 8, border: '1px solid var(--border)', borderRadius: 4,
          background: 'var(--bg-primary)',
          fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)',
          lineHeight: 1.7, overflow: 'auto',
        }}>
          {ev && (
            <>
              <div>t<sub>peak</sub> = {ev.peakTimeS.toFixed(4)} s</div>
              <div>amp = {ev.amplitude.toFixed(2)} {unit}</div>
              <div>baseline = {ev.baselineVal.toFixed(2)} {unit}</div>
              <div>peak = {ev.peakVal.toFixed(2)} {unit}</div>
              <div style={{
                marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--border)',
              }} />
              <div>rise {ev.riseTimeMs != null ? ev.riseTimeMs.toFixed(2) : '—'} ms</div>
              <div>decay {ev.decayTimeMs != null ? ev.decayTimeMs.toFixed(2) : '—'} ms</div>
              <div>τ<sub>decay</sub> {ev.decayTauMs != null ? ev.decayTauMs.toFixed(2) : '—'} ms</div>
              <div>FWHM {ev.halfWidthMs != null ? ev.halfWidthMs.toFixed(2) : '—'} ms</div>
              <div>AUC {ev.auc != null ? ev.auc.toFixed(3) : '—'} {unit}·s</div>
              <div style={{
                marginTop: 6, color: ev.manual ? '#ffb74d' : 'var(--text-muted)',
                fontStyle: 'italic',
              }}>{ev.manual ? 'manual' : 'auto-detected'}</div>
              <div style={{
                marginTop: 10, paddingTop: 6, borderTop: '1px solid var(--border)',
                color: 'var(--text-muted)', fontFamily: 'var(--font-ui)',
                fontSize: 10, lineHeight: 1.35,
              }}>
                Legend: <span style={{ color: '#e57373' }}>●</span> peak&nbsp;
                <span style={{ color: '#9e9e9e' }}>●</span> foot&nbsp;
                <span style={{ color: '#4dd0e1' }}>●</span> 20%&nbsp;
                <span style={{ color: '#26a69a' }}>●</span> 80%&nbsp;
                <span style={{ color: '#ffeb3b' }}>●</span> FWHM&nbsp;
                <span style={{ color: '#ab47bc' }}>●</span> end
              </div>
            </>
          )}
        </div>
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{
            display: 'flex', gap: 8, alignItems: 'center',
            fontSize: 'var(--font-size-label)', flexShrink: 0,
          }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)' }}>Before (ms)</span>
              <NumInput value={preMs} step={1} min={1}
                onChange={(v) => setPreMs(Math.max(1, Math.min(winMs - 1, v)))} />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)' }}>Total (ms)</span>
              <NumInput value={winMs} step={5} min={10}
                onChange={(v) => setWinMs(Math.max(preMs + 1, v))} />
            </label>
            <span style={{ flex: 1 }} />
            <span style={{
              color: 'var(--text-muted)', fontSize: 10, fontStyle: 'italic',
            }}>scroll = zoom X · Alt+scroll = zoom Y · drag = pan · dbl-click = reset</span>
          </div>
          <div ref={containerRef} style={{
            flex: 1, minHeight: 0,
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-primary)',
          }} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overlay panel — all events aligned on peak (or foot), with mean and
// ±1 SD envelope. Supports zoom/pan; toggle to honour the pre-detection
// filter for the same A/B comparison the browser offers.
// ---------------------------------------------------------------------------

function AllEventsOverlayPanel({
  backendUrl, entry,
}: {
  backendUrl: string
  entry: EventsData | undefined
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [data, setData] = useState<{
    time: number[]; traces: (number | null)[][]
    mean: (number | null)[]; sdLo: (number | null)[]; sdHi: (number | null)[]
    nIncluded: number
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [alignMode, setAlignMode] = useState<'peak' | 'foot'>('peak')
  const [beforeMs, setBeforeMs] = useState(5)
  const [afterMs, setAfterMs] = useState(50)
  const [respectFilter, setRespectFilter] = useState(true)

  useEffect(() => {
    if (!backendUrl || !entry || entry.events.length === 0) {
      setData(null); return
    }
    const t = setTimeout(() => {
      setLoading(true); setErr(null)
      const filterParams = respectFilter && entry.params.filterEnabled ? {
        filter_enabled: true,
        filter_type: entry.params.filterType,
        filter_low: entry.params.filterLow,
        filter_high: entry.params.filterHigh,
        filter_order: entry.params.filterOrder,
      } : {}
      fetch(`${backendUrl}/api/events/overlay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group: entry.group, series: entry.series,
          sweep: entry.sweep, trace: entry.channel,
          events: entry.events.map((e) => ({
            peak_idx: e.peakIdx, foot_idx: e.footIdx,
            baseline_val: e.baselineVal,
          })),
          align: alignMode,
          window_before_ms: beforeMs,
          window_after_ms: afterMs,
          baseline_subtract: true,
          ...filterParams,
        }),
      }).then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
        .then((d) => {
          setData({
            time: (d.time_s ?? []).map((x: any) => Number(x)),
            traces: (d.traces ?? []).map((row: any[]) =>
              row.map((x) => x == null ? null : Number(x))),
            mean: (d.mean ?? []).map((x: any) => x == null ? null : Number(x)),
            sdLo: (d.sd_lo ?? []).map((x: any) => x == null ? null : Number(x)),
            sdHi: (d.sd_hi ?? []).map((x: any) => x == null ? null : Number(x)),
            nIncluded: Number(d.n_included ?? 0),
          })
          setLoading(false)
        })
        .catch((e) => { setErr(String(e)); setLoading(false); setData(null) })
    }, 150)
    return () => clearTimeout(t)
  }, [backendUrl, entry, alignMode, beforeMs, afterMs, respectFilter])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let teardown: (() => void) | null = null
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!data || data.time.length === 0) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      const aligned: uPlot.AlignedData = [
        data.time as any,
        ...(data.traces.map((row) => row as any) as any[]),
        data.mean as any,
      ]
      const seriesDefs: uPlot.Series[] = [{}]
      for (let i = 0; i < data.traces.length; i++) {
        seriesDefs.push({
          stroke: 'rgba(128,128,128,0.35)', width: 0.8, spanGaps: false,
        })
      }
      seriesDefs.push({ stroke: '#e57373', width: 2, spanGaps: false })
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: { x: { time: false }, y: { auto: true } },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: `Time (ms, 0 = ${alignMode})`, labelSize: 14,
            values: (_u, vals) => vals.map((v) => (v * 1000).toFixed(0)),
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 55, label: 'Δ baseline',
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series: seriesDefs,
        hooks: {
          draw: [(u) => {
            if (data.sdLo.length !== data.time.length
                || data.sdHi.length !== data.time.length) return
            const ctx = u.ctx
            ctx.save()
            ctx.fillStyle = 'rgba(229, 115, 115, 0.18)'
            ctx.beginPath()
            let started = false
            for (let i = 0; i < data.time.length; i++) {
              const v = data.sdHi[i]
              if (v == null) continue
              const px = u.valToPos(data.time[i], 'x', true)
              const py = u.valToPos(v, 'y', true)
              if (!started) { ctx.moveTo(px, py); started = true }
              else ctx.lineTo(px, py)
            }
            for (let i = data.time.length - 1; i >= 0; i--) {
              const v = data.sdLo[i]
              if (v == null) continue
              const px = u.valToPos(data.time[i], 'x', true)
              const py = u.valToPos(v, 'y', true)
              ctx.lineTo(px, py)
            }
            ctx.closePath()
            ctx.fill()
            ctx.restore()
          }],
        },
      }
      plotRef.current = new uPlot(opts, aligned, container)
      teardown = attachZoomPan(plotRef.current!)
    })
    return () => {
      cancelAnimationFrame(frame)
      if (teardown) teardown()
    }
  }, [data, alignMode])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      minHeight: 0, gap: 6,
    }}>
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        fontSize: 'var(--font-size-label)', flexShrink: 0,
      }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>Align</span>
          <select value={alignMode}
            onChange={(e) => setAlignMode(e.target.value as 'peak' | 'foot')}>
            <option value="peak">peak</option>
            <option value="foot">foot</option>
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>Before (ms)</span>
          <NumInput value={beforeMs} step={1} min={1} onChange={setBeforeMs} />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>After (ms)</span>
          <NumInput value={afterMs} step={5} min={5} onChange={setAfterMs} />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
               title="Apply the pre-detection filter before overlaying">
          <input type="checkbox" checked={respectFilter}
            onChange={(e) => setRespectFilter(e.target.checked)} />
          <span>Filter</span>
        </label>
        {data && (
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {data.nIncluded} / {entry?.events.length ?? 0} events
          </span>
        )}
        {loading && <span style={{ color: 'var(--text-muted)' }}>loading…</span>}
        {err && <span style={{ color: '#e57373' }}>⚠ {err}</span>}
        <span style={{ flex: 1 }} />
        <span style={{
          color: 'var(--text-muted)', fontSize: 10, fontStyle: 'italic',
        }}>scroll = zoom · drag = pan · dbl-click = reset</span>
      </div>
      <div ref={containerRef} style={{
        flex: 1, minHeight: 0,
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }}>
        {(!entry || entry.events.length === 0) && (
          <div style={{
            padding: 16, textAlign: 'center',
            color: 'var(--text-muted)', fontStyle: 'italic',
            fontSize: 'var(--font-size-label)',
          }}>
            Run detection to see the event overlay.
          </div>
        )}
      </div>
    </div>
  )
}
