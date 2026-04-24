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
  const {
    recording, currentGroup, currentSeries, currentSweep,
    selectSweep,
    excludedSweeps, toggleSweepExcluded, clearExcludedSweeps,
    selectedSweeps, handleSweepSelection, clearSweepSelection,
    averagedSweeps, deleteAveragedSweep, selectAveragedSweep,
    renameAveragedSweep, currentAveragedSweep,
  } = useAppStore()
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set([0]))
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set())
  const [hoveredSweep, setHoveredSweep] = useState<string | null>(null)
  const [hoveredAvg, setHoveredAvg] = useState<string | null>(null)
  const [editingAvg, setEditingAvg] = useState<string | null>(null)

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
    clearSweepSelection(gIdx, sIdx)
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
              const seriesKey = `${group.index}:${series.index}`
              const excludedList = excludedSweeps[seriesKey] ?? []
              const excludedCount = excludedList.length
              const selectedList = selectedSweeps[seriesKey] ?? []
              const averagedList = averagedSweeps[seriesKey] ?? []

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

                    <span className="tree-node-label"
                      style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {series.label || `Series ${series.index + 1}`}
                    </span>

                    {selectedList.length > 0 && (
                      <span
                        title={`${selectedList.length} sweep${selectedList.length === 1 ? '' : 's'} selected — click a sweep to clear`}
                        style={{
                          fontSize: '0.7em', fontWeight: 700,
                          color: '#1976d2',
                          padding: '0 4px', borderRadius: 2,
                          background: 'rgba(33, 150, 243, 0.18)',
                        }}
                      >
                        {selectedList.length} sel
                      </span>
                    )}

                    {excludedCount > 0 && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation()
                          clearExcludedSweeps(group.index, series.index)
                        }}
                        title={`${excludedCount} sweep${excludedCount === 1 ? '' : 's'} excluded — click to restore all`}
                        style={{
                          fontSize: '0.7em', fontWeight: 700,
                          color: '#e65100',
                          padding: '0 4px', borderRadius: 2,
                          background: 'rgba(255, 152, 0, 0.18)',
                          cursor: 'pointer',
                        }}
                      >
                        {excludedCount}⊘
                      </span>
                    )}

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
                    const isSweepSelected =
                      isSelected && currentSweep === sweep.index && !currentAveragedSweep
                    const isMultiSelected = selectedList.includes(sweep.index)
                    const isExcluded = excludedList.includes(sweep.index)
                    const hoverKey = `${group.index}-${series.index}-${sweep.index}`
                    const isHovered = hoveredSweep === hoverKey

                    return (
                      <div
                        key={sweep.index}
                        onClick={(e) => {
                          e.stopPropagation()
                          const modifier: 'shift' | 'cmd' | 'none' =
                            e.shiftKey ? 'shift'
                            : (e.metaKey || e.ctrlKey) ? 'cmd'
                            : 'none'
                          if (modifier !== 'none') {
                            // Multi-selection — do NOT navigate.
                            handleSweepSelection(group.index, series.index, sweep.index, modifier)
                          } else {
                            // Plain click → navigate + clear multi-selection.
                            clearSweepSelection(group.index, series.index)
                            selectSweep(group.index, series.index, sweep.index)
                          }
                        }}
                        onMouseEnter={() => setHoveredSweep(hoverKey)}
                        onMouseLeave={() =>
                          setHoveredSweep((cur) => (cur === hoverKey ? null : cur))
                        }
                        style={{
                          padding: '2px 8px 2px 48px',
                          cursor: 'pointer',
                          fontSize: 'var(--font-size-xs)',
                          background: isSweepSelected
                            ? 'var(--accent-dim)'
                            : isMultiSelected
                              ? 'rgba(33, 150, 243, 0.14)'
                              : 'transparent',
                          color: isSweepSelected
                            ? 'white'
                            : isExcluded
                              ? 'var(--text-muted)'
                              : 'var(--text-secondary)',
                          textDecoration: isExcluded ? 'line-through' : 'none',
                          opacity: isExcluded && !isSweepSelected ? 0.55 : 1,
                          userSelect: 'none',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          borderLeft: isMultiSelected
                            ? '2px solid #2196f3'
                            : '2px solid transparent',
                        }}
                        className="tree-row"
                      >
                        <span className="tree-node-label"
                          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {sweep.label || `Sweep ${sweep.index + 1}`}
                        </span>
                        {(isExcluded || isHovered) && (
                          <span
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleSweepExcluded(group.index, series.index, sweep.index)
                            }}
                            title={
                              isExcluded
                                ? 'Click to include this sweep in analyses'
                                : 'Click to exclude this sweep from all analyses'
                            }
                            style={{
                              flexShrink: 0,
                              color: isExcluded
                                ? (isSweepSelected ? 'white' : '#ff9800')
                                : 'var(--text-muted)',
                              fontSize: '0.9em',
                              padding: '0 2px',
                              lineHeight: 1,
                              opacity: isExcluded ? 1 : 0.7,
                            }}
                          >
                            ⊘
                          </span>
                        )}
                      </div>
                    )
                  })}

                  {/* Averaged virtual sweeps — appear below real sweeps
                      with a small divider. Italic label + Σ badge so they
                      visually stand out from recorded sweeps. */}
                  {isExpanded && averagedList.length > 0 && (
                    <div style={{
                      margin: '3px 12px 3px 48px',
                      borderTop: '1px dashed var(--border)',
                    }} />
                  )}
                  {isExpanded && averagedList.map((avg) => {
                    const isAvgSelected =
                      currentAveragedSweep != null &&
                      currentAveragedSweep.group === group.index &&
                      currentAveragedSweep.series === series.index &&
                      currentAveragedSweep.id === avg.id
                    const hovKey = `avg-${avg.id}`
                    const isHovered = hoveredAvg === hovKey
                    const isEditing = editingAvg === avg.id

                    return (
                      <div
                        key={avg.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (isEditing) return
                          selectAveragedSweep(group.index, series.index, avg.id)
                        }}
                        onMouseEnter={() => setHoveredAvg(hovKey)}
                        onMouseLeave={() => setHoveredAvg((cur) => (cur === hovKey ? null : cur))}
                        style={{
                          padding: '2px 8px 2px 48px',
                          cursor: isEditing ? 'text' : 'pointer',
                          fontSize: 'var(--font-size-xs)',
                          fontStyle: 'italic',
                          background: isAvgSelected ? 'var(--accent-dim)' : 'transparent',
                          color: isAvgSelected ? 'white' : 'var(--text-secondary)',
                          userSelect: 'none',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                        className="tree-row"
                      >
                        <span style={{
                          fontSize: '0.7em', fontWeight: 700,
                          color: isAvgSelected ? '#fff' : '#7b1fa2',
                          padding: '0 4px', borderRadius: 2,
                          background: isAvgSelected
                            ? 'rgba(255,255,255,0.2)'
                            : 'rgba(156, 39, 176, 0.16)',
                          flexShrink: 0,
                          fontStyle: 'normal',
                        }}>Σ</span>
                        {isEditing ? (
                          <input
                            autoFocus
                            type="text"
                            defaultValue={avg.label}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                renameAveragedSweep(group.index, series.index, avg.id, (e.target as HTMLInputElement).value)
                                setEditingAvg(null)
                              } else if (e.key === 'Escape') {
                                setEditingAvg(null)
                              }
                            }}
                            onBlur={(e) => {
                              renameAveragedSweep(group.index, series.index, avg.id, e.target.value)
                              setEditingAvg(null)
                            }}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              flex: 1, fontSize: 'inherit', fontFamily: 'inherit',
                              padding: '0 2px', background: 'var(--bg-primary)',
                              color: 'var(--text-primary)',
                              border: '1px solid var(--accent)', borderRadius: 2,
                            }}
                          />
                        ) : (
                          <span
                            className="tree-node-label"
                            onDoubleClick={(e) => { e.stopPropagation(); setEditingAvg(avg.id) }}
                            title={`Sources: sweeps ${avg.sourceSweepIndices.map((i) => i + 1).join(', ')} — double-click to rename`}
                            style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {avg.label}
                          </span>
                        )}
                        {isHovered && !isEditing && (
                          <span
                            onClick={(e) => {
                              e.stopPropagation()
                              if (window.confirm(`Delete averaged sweep "${avg.label}"?`)) {
                                deleteAveragedSweep(group.index, series.index, avg.id)
                              }
                            }}
                            title="Delete this averaged sweep"
                            style={{
                              flexShrink: 0,
                              color: isAvgSelected ? '#fff' : 'var(--text-muted)',
                              fontSize: '0.9em',
                              padding: '0 4px',
                              lineHeight: 1,
                              fontStyle: 'normal',
                            }}
                          >
                            ✕
                          </span>
                        )}
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
