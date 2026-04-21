import React, { useEffect, useRef, useState } from 'react'
import { useAppStore, STIMULUS_TRACE_INDEX, ChannelInfo } from '../../stores/appStore'

/** Row for one selectable channel in the dropdown. */
interface Row {
  index: number       // recorded channel index, or STIMULUS_TRACE_INDEX for stimulus
  label: string
  units: string
  kind: 'voltage' | 'current' | 'other' | 'stimulus'
  color: string
  visible: boolean
}

// Palette-style colour assignment — primary series colour for channel 0,
// secondary colours for channels 1+. Stimulus uses its own CSS variable.
function colorForChannel(idx: number): string {
  // Reuse the trace/overlay palette roughly. These vars are already defined
  // in the CSS theme for TraceViewer.
  const vars = ['--trace-color-1', '--trace-color-2', '--trace-color-3', '--trace-color-4', '--trace-color-5']
  const name = vars[idx % vars.length]
  return `var(${name})`
}

export function TracesDropdown() {
  const {
    recording, currentGroup, currentSeries,
    getVisibleTraces, toggleTraceVisible,
  } = useAppStore()

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const series = recording?.groups[currentGroup]?.series[currentSeries]
  if (!series) return null

  const channels: ChannelInfo[] = series.channels ?? []
  const hasStim = !!series.stimulus
  const visible = getVisibleTraces(currentGroup, currentSeries)
  const visibleSet = new Set(visible)

  const rows: Row[] = [
    ...channels.map((ch) => ({
      index: ch.index,
      label: ch.label,
      units: ch.units,
      kind: ch.kind as Row['kind'],
      color: colorForChannel(ch.index),
      visible: visibleSet.has(ch.index),
    })),
    ...(hasStim
      ? [{
          index: STIMULUS_TRACE_INDEX,
          label: 'Stimulus',
          units: series.stimulus?.unit ?? '',
          kind: 'stimulus' as Row['kind'],
          color: 'var(--stimulus-color)',
          visible: visibleSet.has(STIMULUS_TRACE_INDEX),
        }]
      : []),
  ]

  // Don't render the button if there's nothing selectable (shouldn't happen
  // in practice, but defensive).
  if (rows.length === 0) return null

  const visibleCount = rows.filter((r) => r.visible).length

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        className="btn"
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: '4px 12px',
          fontSize: 'var(--font-size-sm)',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
        title="Show or hide individual traces (voltage, current, stimulus, auxiliary channels)"
      >
        Traces ({visibleCount}) <span style={{ fontSize: 11 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            minWidth: 220,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            zIndex: 100,
            padding: 4,
          }}
        >
          {rows.map((r) => (
            <label
              key={r.index}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 6px',
                cursor: 'pointer',
                userSelect: 'none',
                borderRadius: 3,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover, var(--bg-primary))'
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'transparent'
              }}
            >
              <input
                type="checkbox"
                checked={r.visible}
                onChange={() => toggleTraceVisible(currentGroup, currentSeries, r.index)}
                style={{ margin: 0, accentColor: r.color }}
              />
              <span
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  background: r.color,
                  borderRadius: 2,
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, fontSize: 'var(--font-size-xs)' }}>
                {r.label}
              </span>
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
                {r.units}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
