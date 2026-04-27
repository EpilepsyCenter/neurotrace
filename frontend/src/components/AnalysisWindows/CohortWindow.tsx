import React, { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Cohort Analysis window — Phase B.2 deliverable.
 *
 * Three-step entry surface:
 *   1. Pick a folder of `.neurotrace` sidecars.
 *   2. Pick an analysis type (filtered to those the backend extractor
 *      registry knows about).
 *   3. Hit "Aggregate" → backend walks the folder, runs the per-cell
 *      extractor, returns a flat per-cell row table that this window
 *      previews raw.
 *
 * Later phases bolt on:
 *   - B.3: comparison shape (within / between), tag picker,
 *     design preview ("the test we'll run is …")
 *   - B.4: Pingouin stats runner
 *   - B.5: metric tree + per-cell subsampling controls
 *   - B.6: graph panel (dot plots + ECDF / time-series overlays)
 *   - B.7: stats table panel
 *   - B.8: export (Prism / Excel / _cells.xlsx)
 *   - B.9: .neurocohort session save/load
 *
 * Until the wizard arrives in B.3, the right-pane "preview" exists
 * to prove the backend round-trip end-to-end and to give the user
 * a sanity check that their cells extracted correctly before the
 * statistics layer lands.
 */

interface AnalysesIndex {
  analyses: string[]
  default_metrics: Record<string, { scalars: string[]; distributions: string[] }>
}

interface SkippedFile {
  file_path: string
  file_name?: string
}

interface AggregateError {
  file_path: string
  series_key?: string
  reason: string
}

interface Cell {
  file_path: string
  file_name: string
  cell_id: string | null
  group_tags: string[]
  series_tags: Record<string, string[]>
  series_key: string
  series_specific_tags: string[]
  scalars: Record<string, number | null>
  distributions: Record<string, number[]>
  meta: Record<string, unknown>
}

interface AggregateResponse {
  analysis_type: string
  folder: string
  cells: Cell[]
  errors: AggregateError[]
  skipped_no_meta: SkippedFile[]
  skipped_no_analysis: SkippedFile[]
  summary: {
    n_cells: number
    n_files_scanned: number
    n_files_filtered_out: number
  }
}

// Display names for the analysis-type dropdown. Sourced server-side
// would be cleaner long-term, but this list rarely changes and the
// display strings are UI concerns the backend doesn't need to ship.
const ANALYSIS_LABELS: Record<string, string> = {
  events: 'Events (spontaneous PSCs / minis)',
  ap: 'Action Potentials',
  iv_curves: 'I-V Curve',
  bursts: 'Bursts',
  cursors: 'Cursor Measurements',
  fpsp_io: 'fPSP — Input-Output',
  fpsp_ppr: 'fPSP — Paired-Pulse Ratio',
  fpsp_ltp: 'fPSP — LTP / LTD',
}

export function CohortWindow({ backendUrl }: { backendUrl: string }) {
  const [folder, setFolder] = useState<string | null>(null)
  const [analyses, setAnalyses] = useState<AnalysesIndex | null>(null)
  const [analysisType, setAnalysisType] = useState<string>('events')
  const [aggResult, setAggResult] = useState<AggregateResponse | null>(null)
  const [aggLoading, setAggLoading] = useState(false)
  const [aggError, setAggError] = useState<string | null>(null)

  // ------------------------------------------------------------------
  // Load supported analyses on mount so the dropdown is populated.
  // No fallback — if the backend can't answer, the user sees an empty
  // dropdown + an error, which is the truthful UX (we can't aggregate
  // anyway without the backend).
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!backendUrl) return
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch(`${backendUrl}/api/cohort/analyses`)
        if (!resp.ok) return
        const data = (await resp.json()) as AnalysesIndex
        if (cancelled) return
        setAnalyses(data)
        // Pin the dropdown to the first analysis the backend knows about
        // when the default ('events') isn't in the list (would happen
        // only if extractors get reshuffled).
        if (!data.analyses.includes(analysisType) && data.analyses.length > 0) {
          setAnalysisType(data.analyses[0])
        }
      } catch { /* swallow — UI shows the empty state */ }
    })()
    return () => { cancelled = true }
    // intentionally only re-run on backendUrl change; we don't want
    // re-fetching every time the user toggles analysisType in the
    // dropdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl])

  // Restore the most recent folder from prefs so the user doesn't
  // re-pick on every window open. We persist back via the same key
  // after a successful aggregation.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const api = window.electronAPI
      if (!api?.getPreferences) return
      try {
        const prefs = await api.getPreferences()
        if (cancelled) return
        const recent = (prefs?.cohortLastFolder as string | undefined) ?? null
        if (recent) setFolder(recent)
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [])

  const persistFolder = useCallback(async (f: string) => {
    const api = window.electronAPI
    if (!api?.getPreferences || !api?.setPreferences) return
    try {
      const prefs = (await api.getPreferences()) ?? {}
      await api.setPreferences({ ...prefs, cohortLastFolder: f })
    } catch { /* ignore */ }
  }, [])

  // ------------------------------------------------------------------
  // Folder picker — uses the new ``open-folder-dialog`` IPC. On the
  // chance the IPC is missing (older preload), we fall back to a
  // text-edit affordance the user can paste into.
  // ------------------------------------------------------------------
  const pickFolder = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.openFolderDialog) {
      const typed = window.prompt('Folder path:', folder ?? '')
      if (typed) setFolder(typed)
      return
    }
    const picked = await api.openFolderDialog(folder ?? undefined)
    if (picked) setFolder(picked)
  }, [folder])

  // ------------------------------------------------------------------
  // Run aggregation. Surfaces backend errors verbatim so the user can
  // see whether it was a parse failure, an unknown analysis, etc.
  // ------------------------------------------------------------------
  const runAggregate = useCallback(async () => {
    if (!folder || !backendUrl) return
    setAggLoading(true)
    setAggError(null)
    setAggResult(null)
    try {
      const resp = await fetch(`${backendUrl}/api/cohort/aggregate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, analysis_type: analysisType }),
      })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(`HTTP ${resp.status}: ${text || resp.statusText}`)
      }
      const data = (await resp.json()) as AggregateResponse
      setAggResult(data)
      persistFolder(folder)
    } catch (err) {
      setAggError(err instanceof Error ? err.message : String(err))
    } finally {
      setAggLoading(false)
    }
  }, [folder, backendUrl, analysisType, persistFolder])

  // ------------------------------------------------------------------
  // Derived: union of scalar metric names across all cells, used to
  // build the preview-table column header. Cells with missing metrics
  // (extractor returned None for that cell) render an em-dash in
  // their cell so the table is rectangular even with sparse data.
  // ------------------------------------------------------------------
  const scalarColumns: string[] = useMemo(() => {
    if (!aggResult) return []
    const seen = new Set<string>()
    for (const c of aggResult.cells) {
      for (const k of Object.keys(c.scalars)) seen.add(k)
    }
    // Preserve curated DEFAULT_METRICS order at the front, then any
    // remaining metrics alphabetically. Makes the preview consistent
    // with what the metric tree (B.5) will show as pre-checked.
    const curated = analyses?.default_metrics?.[aggResult.analysis_type]?.scalars ?? []
    const front = curated.filter((k) => seen.has(k))
    const remaining = Array.from(seen)
      .filter((k) => !front.includes(k))
      .sort()
    return [...front, ...remaining]
  }, [aggResult, analyses])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      fontSize: 'var(--font-size-base)',
    }}>
      {/* ---- Top toolbar — folder + analysis-type pickers + run ---- */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center',
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexWrap: 'wrap',
      }}>
        <span style={{ fontWeight: 600 }}>Folder:</span>
        <button
          className="btn"
          onClick={pickFolder}
          style={{ padding: '4px 10px' }}
        >Pick…</button>
        <span style={{
          flex: 1, minWidth: 200,
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--font-size-sm)',
          color: folder ? 'var(--text-primary)' : 'var(--text-muted)',
          fontStyle: folder ? 'normal' : 'italic',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={folder ?? ''}>
          {folder ?? 'no folder picked'}
        </span>

        <span style={{ fontWeight: 600, marginLeft: 12 }}>Analysis:</span>
        <select
          value={analysisType}
          onChange={(e) => setAnalysisType(e.target.value)}
          disabled={!analyses || analyses.analyses.length === 0}
          style={{
            padding: '4px 8px',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 3,
            fontSize: 'var(--font-size-base)',
            minWidth: 200,
          }}
        >
          {analyses?.analyses.map((a) => (
            <option key={a} value={a}>
              {ANALYSIS_LABELS[a] ?? a}
            </option>
          ))}
        </select>

        <button
          className="btn"
          onClick={runAggregate}
          disabled={!folder || aggLoading}
          style={{
            padding: '4px 16px', fontWeight: 600,
            background: 'var(--accent, #3b82f6)', color: '#fff',
            border: 'none',
            opacity: !folder || aggLoading ? 0.6 : 1,
          }}
        >{aggLoading ? 'Aggregating…' : 'Aggregate'}</button>
      </div>

      {/* ---- Main pane — aggregation result preview ---- */}
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 14px' }}>
        {aggError && (
          <div style={{
            padding: '10px 14px',
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid #ef4444',
            borderRadius: 4,
            color: '#ef4444',
            marginBottom: 12,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--font-size-sm)',
          }}>{aggError}</div>
        )}

        {!aggResult && !aggError && !aggLoading && (
          <EmptyState />
        )}

        {aggResult && (
          <>
            <ResultSummary result={aggResult} />
            <CellTable cells={aggResult.cells} columns={scalarColumns} />
            <SkippedSection result={aggResult} />
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Pre-aggregation empty state — points the user to the "Aggregate"
// button and explains what's about to happen, since the wizard
// doesn't exist yet.
// ---------------------------------------------------------------------
function EmptyState() {
  return (
    <div style={{
      padding: '32px 16px',
      color: 'var(--text-muted)',
      lineHeight: 1.6,
      maxWidth: 640,
    }}>
      <div style={{ fontSize: 'var(--font-size-base)', marginBottom: 8 }}>
        Pick the folder of <code style={mono}>.neurotrace</code> sidecars you
        want to aggregate, choose an analysis type, then click <b>Aggregate</b>.
      </div>
      <div style={{ fontSize: 'var(--font-size-sm)' }}>
        The backend will walk every recording in the folder, pull per-cell
        scalars + distributions for the chosen analysis, and surface skipped
        files (no tags / no analysis run) so you can fix them before running
        statistics.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Top-of-result summary banner: cell count + scanned count + skip
// counts. Quick at-a-glance check that the aggregator saw what the
// user expected before they scroll into the cell table.
// ---------------------------------------------------------------------
function ResultSummary({ result }: { result: AggregateResponse }) {
  const { cells, summary, skipped_no_meta, skipped_no_analysis, errors } = result
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '8px 12px',
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 4,
      marginBottom: 12,
      fontSize: 'var(--font-size-sm)',
      flexWrap: 'wrap',
    }}>
      <Pill
        label={`${cells.length} cell${cells.length === 1 ? '' : 's'}`}
        color="#22c55e"
      />
      <Pill
        label={`${summary.n_files_scanned} scanned`}
        color="var(--text-muted)"
      />
      {skipped_no_meta.length > 0 && (
        <Pill
          label={`${skipped_no_meta.length} no tags`}
          color="#ef4444"
          tooltip="These files have no file-level tags. Open them in the metadata window and add at least one tag."
        />
      )}
      {skipped_no_analysis.length > 0 && (
        <Pill
          label={`${skipped_no_analysis.length} no analysis`}
          color="#eab308"
          tooltip={`These files don't carry results for ${result.analysis_type}.`}
        />
      )}
      {errors.length > 0 && (
        <Pill
          label={`${errors.length} error${errors.length === 1 ? '' : 's'}`}
          color="#ef4444"
          tooltip="Click to inspect — see the section below."
        />
      )}
    </div>
  )
}

function Pill({ label, color, tooltip }: { label: string; color: string; tooltip?: string }) {
  return (
    <span
      title={tooltip}
      style={{
        padding: '2px 8px',
        borderRadius: 10,
        background: 'var(--bg-tertiary, rgba(120,120,120,0.15))',
        color, fontWeight: 600,
        cursor: tooltip ? 'help' : 'default',
        fontFamily: 'var(--font-mono)',
      }}
    >{label}</span>
  )
}

// ---------------------------------------------------------------------
// Per-cell preview table. Sticky header row; rows are scrollable in
// the parent container. Numbers are formatted to 4 sig figs to keep
// the table dense without losing precision; nulls render as em-dash.
// ---------------------------------------------------------------------
function CellTable({ cells, columns }: { cells: Cell[]; columns: string[] }) {
  if (cells.length === 0) {
    return (
      <div style={{
        padding: 16, color: 'var(--text-muted)',
        fontStyle: 'italic',
      }}>
        No cells contributed. Check the skip / error sections below.
      </div>
    )
  }
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 4,
      overflow: 'auto',
      maxHeight: '60vh',
    }}>
      <table style={{
        borderCollapse: 'collapse',
        width: '100%',
        fontSize: 'var(--font-size-sm)',
        fontFamily: 'var(--font-mono)',
      }}>
        <thead style={{
          position: 'sticky', top: 0, zIndex: 1,
          background: 'var(--bg-secondary)',
        }}>
          <tr>
            <Th>File</Th>
            <Th>Cell ID</Th>
            <Th>Series</Th>
            <Th>File tags</Th>
            <Th>Series tags</Th>
            {columns.map((c) => <Th key={c}>{c}</Th>)}
          </tr>
        </thead>
        <tbody>
          {cells.map((cell, i) => (
            <tr key={`${cell.file_path}::${cell.series_key}`}
                style={{
                  background: i % 2 === 0 ? 'transparent'
                    : 'var(--bg-tertiary, rgba(120,120,120,0.06))',
                }}>
              <Td title={cell.file_path}>{cell.file_name}</Td>
              <Td>{cell.cell_id ?? '—'}</Td>
              <Td>{cell.series_key}</Td>
              <Td>{cell.group_tags.join(', ')}</Td>
              <Td>{cell.series_specific_tags.join(', ') || '—'}</Td>
              {columns.map((col) => {
                const v = cell.scalars[col]
                return <Td key={col} numeric>{fmtScalar(v)}</Td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{
      textAlign: 'left',
      padding: '6px 8px',
      borderBottom: '1px solid var(--border)',
      fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>{children}</th>
  )
}

function Td({ children, title, numeric }: {
  children: React.ReactNode; title?: string; numeric?: boolean
}) {
  return (
    <td title={title}
        style={{
          padding: '4px 8px',
          borderBottom: '1px solid var(--border-subtle, var(--border))',
          textAlign: numeric ? 'right' : 'left',
          maxWidth: 220,
          overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
      {children}
    </td>
  )
}

function fmtScalar(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  // 4-sig-fig display with sensible exponent fallback for very
  // small / very large numbers (e.g. tau in s vs Hz). The cohort
  // table is preview-grade, not publication-grade.
  if (Math.abs(v) >= 1000 || (Math.abs(v) > 0 && Math.abs(v) < 0.001)) {
    return v.toExponential(2)
  }
  // 4 sig figs equivalent: precision based on magnitude.
  const decimals = Math.abs(v) >= 100 ? 1
    : Math.abs(v) >= 10 ? 2
    : Math.abs(v) >= 1 ? 3
    : 4
  return v.toFixed(decimals)
}

// ---------------------------------------------------------------------
// Skip + error section — collapsible lists of files the aggregator
// dropped, with the concrete reason. The metadata-tag prompt and
// the events / AP / etc. analysis windows are how the user actually
// fixes these; this section just makes the situation legible.
// ---------------------------------------------------------------------
function SkippedSection({ result }: { result: AggregateResponse }) {
  const { skipped_no_meta, skipped_no_analysis, errors } = result
  const total = skipped_no_meta.length + skipped_no_analysis.length + errors.length
  const [expanded, setExpanded] = useState(false)
  if (total === 0) return null
  return (
    <div style={{ marginTop: 14 }}>
      <button
        onClick={() => setExpanded((x) => !x)}
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          padding: 0, marginBottom: 6,
          color: 'var(--text-muted)',
          fontSize: 'var(--font-size-sm)',
        }}
      >
        {expanded ? '▼' : '▶'} {total} file{total === 1 ? '' : 's'} skipped or failed — details
      </button>
      {expanded && (
        <div style={{
          padding: '8px 12px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 'var(--font-size-sm)',
          fontFamily: 'var(--font-mono)',
        }}>
          {skipped_no_meta.length > 0 && (
            <SkipList
              title="No file-level tags"
              hint="Open these in the metadata window and add at least one file tag."
              items={skipped_no_meta.map((s) => s.file_name ?? s.file_path)}
            />
          )}
          {skipped_no_analysis.length > 0 && (
            <SkipList
              title={`No ${result.analysis_type} results`}
              hint="These files haven't had this analysis run yet."
              items={skipped_no_analysis.map((s) => s.file_name ?? s.file_path)}
            />
          )}
          {errors.length > 0 && (
            <SkipList
              title="Errors"
              hint="Backend extractor failed for these slices."
              items={errors.map((e) =>
                `${e.file_path.split(/[/\\]/).pop()}${e.series_key ? ' (' + e.series_key + ')' : ''}: ${e.reason}`)}
              error
            />
          )}
        </div>
      )}
    </div>
  )
}

function SkipList({ title, hint, items, error }: {
  title: string; hint: string; items: string[]; error?: boolean
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        fontWeight: 600,
        color: error ? '#ef4444' : 'var(--text-primary)',
        marginBottom: 2,
        fontFamily: 'var(--font-sans, inherit)',
        fontSize: 'var(--font-size-sm)',
      }}>{title} ({items.length})</div>
      <div style={{
        color: 'var(--text-muted)',
        fontSize: 'var(--font-size-xs)',
        marginBottom: 4,
        fontFamily: 'var(--font-sans, inherit)',
      }}>{hint}</div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  )
}

const mono: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  background: 'var(--bg-tertiary, rgba(120,120,120,0.15))',
  padding: '0 4px',
  borderRadius: 2,
}
