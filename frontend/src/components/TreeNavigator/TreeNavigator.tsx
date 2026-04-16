import React, { useState } from 'react'
import { useAppStore, SeriesInfo } from '../../stores/appStore'

/** Guess recording type from series label, protocol, or units */
function guessRecordingType(series: SeriesInfo): 'vc' | 'cc' | 'field' | 'unknown' {
  const label = (series.label || '').toLowerCase()
  const protocol = (series.protocol || '').toLowerCase()
  const combined = label + ' ' + protocol

  if (/\bcc\b|current.?clamp|i.?clamp|c-clamp/.test(combined)) return 'cc'
  if (/\bvc\b|voltage.?clamp|v.?clamp|test.?pulse|i-v|ramp|seal/.test(combined)) return 'vc'
  if (/field|fepsp|epsp|pop.?spike|lfp|extracell/.test(combined)) return 'field'

  if (series.holding !== undefined && series.holding !== null) return 'vc'
  return 'unknown'
}

const TYPE_COLORS: Record<string, string> = {
  vc: 'var(--trace-color-1)',
  cc: 'var(--trace-color-2)',
  field: 'var(--trace-color-3)',
  unknown: 'var(--text-secondary)',
}

const TYPE_LABELS: Record<string, string> = {
  vc: 'VC',
  cc: 'CC',
  field: 'FP',
  unknown: '',
}

export function TreeNavigator() {
  const { recording, currentGroup, currentSeries, currentSweep, selectSweep } = useAppStore()
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set([0]))
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set())

  const toggleGroup = (idx: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  const toggleSeries = (gIdx: number, sIdx: number) => {
    const key = `${gIdx}-${sIdx}`
    setExpandedSeries((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const handleSeriesClick = (gIdx: number, sIdx: number) => {
    toggleSeries(gIdx, sIdx)
    selectSweep(gIdx, sIdx, 0)
  }

  if (!recording) {
    return (
      <div className="panel">
        <div className="panel-title">Navigator</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)', fontStyle: 'italic' }}>
          No file loaded
        </p>
      </div>
    )
  }

  return (
    <div style={{ fontSize: 'var(--font-size-sm)' }}>
      <div style={{ padding: '8px 12px 4px', fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)' }}>
        {recording.fileName}
      </div>

      {recording.groups.map((group) => (
        <div key={group.index}>
          <div
            onClick={() => toggleGroup(group.index)}
            style={{
              padding: '4px 12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              userSelect: 'none',
            }}
            className="tree-row"
          >
            <span style={{ fontSize: '0.7em', width: 12, color: 'var(--text-muted)' }}>
              {expandedGroups.has(group.index) ? '\u25BC' : '\u25B6'}
            </span>
            <span style={{ fontWeight: 600 }}>{group.label || `Group ${group.index + 1}`}</span>
            <span style={{ color: 'var(--text-muted)', marginLeft: 'auto', fontSize: 'var(--font-size-label)' }}>
              {group.seriesCount} series
            </span>
          </div>

          {expandedGroups.has(group.index) &&
            group.series.map((series) => {
              const recType = guessRecordingType(series)
              const isSelected = currentGroup === group.index && currentSeries === series.index
              const isExpanded = expandedSeries.has(`${group.index}-${series.index}`)

              return (
                <div key={series.index}>
                  <div
                    onClick={() => handleSeriesClick(group.index, series.index)}
                    style={{
                      padding: '3px 12px 3px 24px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      background: isSelected ? 'var(--bg-surface)' : 'transparent',
                      borderLeft: `3px solid ${isSelected ? TYPE_COLORS[recType] : 'transparent'}`,
                      userSelect: 'none',
                    }}
                    className="tree-row"
                  >
                    <span style={{ fontSize: '0.7em', width: 12, color: 'var(--text-muted)' }}>
                      {isExpanded ? '\u25BC' : '\u25B6'}
                    </span>

                    <span style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: TYPE_COLORS[recType],
                      flexShrink: 0,
                    }} />

                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {series.label || `Series ${series.index + 1}`}
                    </span>

                    {TYPE_LABELS[recType] && (
                      <span style={{
                        fontSize: '0.75em', fontWeight: 600, color: TYPE_COLORS[recType],
                        padding: '0 4px', borderRadius: 2,
                        background: `${TYPE_COLORS[recType]}18`,
                      }}>
                        {TYPE_LABELS[recType]}
                      </span>
                    )}

                    <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-label)', flexShrink: 0 }}>
                      {series.sweepCount}sw
                    </span>
                  </div>

                  {isSelected && (
                    <div style={{
                      padding: '2px 12px 4px 44px',
                      fontSize: 'var(--font-size-label)',
                      color: 'var(--text-muted)',
                      display: 'flex',
                      gap: 10,
                    }}>
                      {series.rs != null && <span>Rs: {series.rs.toFixed(1)}M\u03A9</span>}
                      {series.cm != null && <span>Cm: {series.cm.toFixed(1)}pF</span>}
                      {series.holding != null && <span>Vh: {series.holding.toFixed(0)}mV</span>}
                    </div>
                  )}

                  {isExpanded && series.sweeps.map((sweep) => {
                    const isSweepSelected = isSelected && currentSweep === sweep.index
                    return (
                      <div
                        key={sweep.index}
                        onClick={(e) => {
                          e.stopPropagation()
                          selectSweep(group.index, series.index, sweep.index)
                        }}
                        style={{
                          padding: '2px 12px 2px 48px',
                          cursor: 'pointer',
                          fontSize: 'var(--font-size-xs)',
                          background: isSweepSelected ? 'var(--accent-dim)' : 'transparent',
                          color: isSweepSelected ? 'white' : 'var(--text-secondary)',
                          userSelect: 'none',
                        }}
                        className="tree-row"
                      >
                        {sweep.label || `Sweep ${sweep.index + 1}`}
                      </div>
                    )
                  })}
                </div>
              )
            })}
        </div>
      ))}
    </div>
  )
}
