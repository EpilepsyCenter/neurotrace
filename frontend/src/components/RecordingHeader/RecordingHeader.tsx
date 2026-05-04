import React from 'react'
import { useAppStore, getMetaStatus } from '../../stores/appStore'

/**
 * Header strip that sits between the toolbar and the trace viewer.
 *
 * Two zones:
 *
 *   LEFT  — identity zone: status dot, filename, file-level tag
 *           chips. Reads at-a-glance: "what file am I looking at,
 *           and what's its tagging state".
 *
 *   RIGHT — telemetry zone: format, group / series / sweep
 *           position, sample rate, sample count. Mono w/ tabular
 *           figures so columns line up between sweeps.
 *
 * Renders ``null`` when no recording is loaded so the trace area is
 * flush with the toolbar.
 */
export function RecordingHeader() {
  const { recording, traceData, currentGroup, currentSeries, currentSweep } =
    useAppStore()

  if (!recording) return null

  const sampleRate = traceData?.samplingRate
  const sampleCount = traceData?.values.length

  return (
    <div className="recording-header" role="contentinfo">
      <div className="recording-header-left">
        <MetaStatusDot />
        <span className="filename" title={recording.filePath}>
          {recording.fileName}
        </span>
        <FileTagChips />
      </div>

      <div className="recording-header-right">
        <span className="key">fmt</span>
        <span className="val">{recording.format}</span>
        <span className="sep">·</span>

        <span className="key">grp</span>
        <span className="val">
          {String(currentGroup + 1).padStart(2, '0')}
        </span>
        <span className="sep">/</span>
        <span className="key">ser</span>
        <span className="val">
          {String(currentSeries + 1).padStart(2, '0')}
        </span>
        <span className="sep">/</span>
        <span className="key">swp</span>
        <span className="val">
          {String(currentSweep + 1).padStart(3, '0')}
        </span>

        {sampleRate != null && (
          <>
            <span className="sep">·</span>
            <span className="val">
              {sampleRate.toLocaleString('en-US')} Hz
            </span>
          </>
        )}

        {sampleCount != null && (
          <>
            <span className="sep">·</span>
            <span className="val">
              {sampleCount.toLocaleString('en-US')} samples
            </span>
          </>
        )}
      </div>
    </div>
  )
}

/** Tag-status dot — green / yellow / red based on file & series
 *  tagging completeness. Moved out of the toolbar so the header
 *  becomes the canonical place to see "is this file ready for
 *  cohort analysis". */
function MetaStatusDot() {
  const meta = useAppStore((s) => s.recordingMeta)
  const groups = useAppStore((s) => s.recording?.groups ?? [])
  const status = getMetaStatus(meta)
  const colour =
    status === 'green' ? 'var(--success)'
      : status === 'yellow' ? 'var(--warning)'
        : 'var(--error)'
  const label = status === 'green' ? 'Tagged'
    : status === 'yellow' ? 'No series tagged'
      : 'Untagged'
  const tooltip = (() => {
    const fileTags = meta?.group_tags ?? []
    const seriesTags = meta?.series_tags ?? {}
    const taggedSeries = Object.values(seriesTags).filter(
      (t) => Array.isArray(t) && t.length > 0).length
    const totalSeries = groups.reduce(
      (acc: number, g: any) => acc + (g.series?.length ?? 0), 0)
    if (status === 'red') {
      return 'No file-level tags. Cohort Analysis needs at least one (e.g. "WT", "male"). Click "Tags…" to add.'
    }
    if (status === 'yellow') {
      return `File tagged with ${fileTags.length} tag${fileTags.length === 1 ? '' : 's'}, but no series tagged yet (0 / ${totalSeries}).`
    }
    return `File tagged with ${fileTags.length} tag${fileTags.length === 1 ? '' : 's'}; ${taggedSeries} of ${totalSeries} series tagged.`
  })()
  return (
    <span
      className="meta-status-dot"
      title={`${label} — ${tooltip}`}
      aria-label={label}
      style={{
        background: colour,
        boxShadow: `0 0 0 1px color-mix(in oklab, ${colour} 60%, transparent), 0 0 6px color-mix(in oklab, ${colour} 50%, transparent)`,
      }}
    />
  )
}

/** File-level tag chips. */
function FileTagChips() {
  const fileTags = useAppStore((s) => s.recordingMeta?.group_tags)
  if (!fileTags || fileTags.length === 0) return null
  const tooltip = fileTags.join(', ')
  return (
    <span className="file-tag-chips" title={tooltip}>
      {fileTags.map((tag, i) => (
        <span className="tag-chip" key={`${tag}-${i}`}>
          {tag}
        </span>
      ))}
    </span>
  )
}
