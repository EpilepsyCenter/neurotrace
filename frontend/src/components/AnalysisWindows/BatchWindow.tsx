/**
 * Batch Analysis window — Phase 4b.
 *
 * Workflow:
 *   1. Pick a TEMPLATE file (an already-analyzed recording).
 *   2. The window scans its .neurotrace sidecar and derives a "recipe
 *      set": for every analysis blob in `analyses.*`, look up the
 *      ``${group}:${series}`` key in `meta.series_tags` and record
 *      ``(tag → analysis_type, params, channel)``. Manual events /
 *      kinetic edits are NOT carried — batch detects fresh.
 *   3. User picks a TARGET FOLDER. The window scans every recording
 *      and (lazily) reads each one's tree + sidecar tags.
 *   4. Cohort-style table: rows = files, columns = recipes (one per
 *      tag the template covers). Per-recipe checkbox lets the user
 *      opt files in / out. Files with NO tag matching any template
 *      recipe show greyed-out with a "tag this file first" hint.
 *   5. Run → sequential per-file, per-recipe; progress + per-file log;
 *      results land in each target's sidecar (so the cohort module
 *      picks them up afterwards).
 *
 * This file ships steps 1 and 2 — the recipe extraction + template
 * picker. Folder/table and the run loop come in subsequent commits.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { displayGroupSeries } from '../../utils/groupSeriesKey'

// All analysis-data shapes share a similar "blob keyed by group:series"
// pattern. We don't need their full type info here; we only inspect
// `params` (where present) and the key. Cast loosely to keep this
// window decoupled from the per-analysis data definitions.
type AnyBlob = Record<string, unknown>

interface SidecarMetaShape {
  group_tags?: string[]
  series_tags?: Record<string, string[]>
}

interface SidecarShape {
  format?: string
  meta?: SidecarMetaShape
  analyses?: {
    events?: Record<string, AnyBlob>
    bursts?: Record<string, AnyBlob>
    ap?: Record<string, AnyBlob>
    iv_curves?: Record<string, AnyBlob>
    fpsp_curves?: Record<string, AnyBlob>
    cursor_analyses?: Record<string, AnyBlob>
    resistance?: Record<string, AnyBlob[]>
  }
  forms?: Record<string, AnyBlob>
}

/** One entry in the template's recipe set. The batch runner uses this
 *  to drive per-file detection: for each target file, find every
 *  series whose tags include ``tag``, and run ``analysisType`` on
 *  it with ``params`` + ``channel``. */
export interface BatchRecipe {
  /** Series tag from the template that anchors this recipe. The
   *  batch runner matches target files by tag, not by group/series
   *  index — so a target file with the same protocol on different
   *  group/series indices still picks up the right analysis. */
  tag: string
  /** Which analysis to run (events / bursts / ap / iv / fpsp / etc.). */
  analysisType: string
  /** Source ``${group}:${series}`` key in the template — surfaced in
   *  the UI so the user can verify which series of the template the
   *  recipe came from. */
  sourceKey: string
  /** Optional analysis-specific subtype carried in the storage key.
   *  Currently only FPsp uses this (3-part keys ``g:s:mode`` with
   *  ``mode`` ∈ {ltp, io, ppr}); other analyses leave it null. The
   *  runner uses this to dispatch to the right FPsp endpoint. */
  subtype: string | null
  /** Snapshot of the template's params blob for that analysis +
   *  series. Shape varies by analysis type. */
  params: AnyBlob
  /** Channel the template's analysis ran on. The batch runner uses
   *  this index on each target file unless overridden later. */
  channel: number | null
  /** For analyses that span multiple series (FPsp LTP needs a baseline
   *  series AND a post-tetanus one), this captures the tags of any
   *  *secondary* series the template references. The runner uses these
   *  to remap the secondary series indices on a target file via tag
   *  match. Keyed by role (``'B'`` for FPsp.seriesB, future roles for
   *  other analyses). Empty when the recipe needs only the primary
   *  series. */
  secondaryTags: Record<string, string[]>
}

/** Parse an analysis-storage key into its (group, series, subtype)
 *  parts. Most analyses key by ``${group}:${series}`` (2 parts);
 *  FPsp adds a 3rd ``mode`` component. Tag lookups always use just
 *  the first two parts since series-level tags don't know about
 *  analysis subtypes. */
function parseAnalysisKey(key: string): {
  groupSeries: string
  subtype: string | null
} {
  const parts = key.split(':')
  if (parts.length >= 3) {
    return { groupSeries: `${parts[0]}:${parts[1]}`, subtype: parts.slice(2).join(':') }
  }
  return { groupSeries: key, subtype: null }
}

// displayGroupSeries lives in src/utils/groupSeriesKey.ts — shared
// with the cohort window so 1-indexed display stays consistent.

/** Pull a channel index out of an analysis blob — different analyses
 *  store it under slightly different field names. Returns ``null`` if
 *  not found (template might omit it for some analysis types). */
function pickChannel(blob: AnyBlob): number | null {
  const c = (blob as any).channel
  if (typeof c === 'number') return c
  const t = (blob as any).trace
  if (typeof t === 'number') return t
  return null
}

/** Pull the params sub-object from an analysis blob. Events / bursts
 *  store params under ``.params``; other analyses inline their fields
 *  on the blob itself. We snapshot the whole blob in those cases —
 *  the runner knows which fields apply to which analysis. */
function pickParams(blob: AnyBlob): AnyBlob {
  const p = (blob as any).params
  if (p && typeof p === 'object') return p as AnyBlob
  return blob
}

/** Walk every analysis slot in the sidecar and emit a recipe per
 *  (analysis, group:series) entry that has at least one series tag.
 *  Untagged analyses are skipped — they can't be matched against
 *  target files in the tag-driven flow. */
export function extractRecipes(sidecar: SidecarShape): {
  recipes: BatchRecipe[]
  warnings: string[]
} {
  const warnings: string[] = []
  const recipes: BatchRecipe[] = []
  const meta = sidecar.meta ?? {}
  const seriesTags = meta.series_tags ?? {}
  const analyses = sidecar.analyses ?? {}

  // Per-type emit. For ``resistance`` the value is an array; we still
  // tag once per (group:series) key — only the params/forms differ.
  const emit = (type: string, blobs: Record<string, AnyBlob | AnyBlob[]> | undefined) => {
    if (!blobs) return
    for (const [key, raw] of Object.entries(blobs)) {
      // FPsp keys analyses 3-part (``g:s:mode``); strip the subtype
      // before looking up series_tags, which only ever uses g:s.
      const { groupSeries, subtype } = parseAnalysisKey(key)
      const tags = seriesTags[groupSeries] ?? []
      if (tags.length === 0) {
        warnings.push(`${type} on ${displayGroupSeries(key)} has no series tags on ${displayGroupSeries(groupSeries)} — skipped (tag the series in the template, then re-pick).`)
        continue
      }
      // ``raw`` is either the analysis blob (most analyses) or an
      // array (resistance). For arrays we use the first row to read
      // channel; params come from sidecar.forms.<type> if present
      // (resistance keeps form state in the top-level forms slot).
      const blob: AnyBlob = Array.isArray(raw)
        ? ((sidecar.forms?.[type] as AnyBlob | undefined) ?? {})
        : raw
      const channel = pickChannel(Array.isArray(raw) ? (raw[0] ?? {}) : raw)
      const params = pickParams(blob)

      // Capture secondary-series tags. FPsp LTP mode references a
      // post-tetanus series via params.seriesB; the runner needs to
      // find an equivalent series in the target file by tag, since
      // raw indices won't carry across files. Other analyses leave
      // ``secondaryTags`` empty — they're single-series.
      const secondaryTags: Record<string, string[]> = {}
      if (type === 'fpsp_curves' && subtype === 'ltp') {
        const groupNum = Number(parseAnalysisKey(key).groupSeries.split(':')[0])
        const seriesB = (blob as any).seriesB
        if (typeof seriesB === 'number' && Number.isFinite(seriesB)) {
          const bKey = `${groupNum}:${seriesB}`
          const bTags = seriesTags[bKey] ?? []
          if (bTags.length > 0) {
            secondaryTags['B'] = bTags
          } else {
            warnings.push(`fpsp_curves [ltp] on ${displayGroupSeries(groupSeries)} references seriesB ${displayGroupSeries(bKey)} but that series has no tags. Tag the post-tetanus series so target files can match it.`)
          }
        }
      }

      // Emit one recipe per tag on the series — multiple tags = the
      // recipe matches any of those tags on a target file.
      for (const tag of tags) {
        recipes.push({
          tag, analysisType: type, sourceKey: key,
          subtype, params, channel, secondaryTags,
        })
      }
    }
  }

  emit('events', analyses.events as any)
  emit('bursts', analyses.bursts as any)
  emit('ap', analyses.ap as any)
  emit('iv_curves', analyses.iv_curves as any)
  emit('fpsp_curves', analyses.fpsp_curves as any)
  emit('cursor_analyses', analyses.cursor_analyses as any)
  emit('resistance', analyses.resistance as any)

  return { recipes, warnings }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  backendUrl: string
}

export function BatchWindow({ backendUrl }: Props) {
  void backendUrl  // used in later phases (folder scan, run loop)
  // Active recording in the parent window (if any). Used to pre-load
  // the currently-open file as the template — most users land here
  // right after analysing a file and want to apply it across the rest
  // of the folder.
  const recording = useAppStore((s) => s.recording)
  const [templatePath, setTemplatePath] = useState<string | null>(null)
  const [templateMeta, setTemplateMeta] = useState<SidecarMetaShape | null>(null)
  const [recipes, setRecipes] = useState<BatchRecipe[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Raw sidecar fields surfaced under "Detected analyses" so the user
  // can see what the sidecar actually contains when no recipes were
  // produced (catches the common "tagged file-level only, not series-
  // level" misconfiguration). Empty when the template hasn't loaded.
  const [diagAnalyses, setDiagAnalyses] = useState<string[]>([])
  const [diagSeriesTags, setDiagSeriesTags] = useState<Record<string, string[]>>({})

  /** Load + parse a template path. Shared by the explicit picker and
   *  the "pre-load active recording" effect below. */
  const loadTemplate = useCallback(async (path: string) => {
    const api = window.electronAPI
    if (!api?.readSidecar) return
    setTemplatePath(path)
    setLoading(true)
    setLoadError(null)
    setRecipes([])
    setWarnings([])
    setDiagAnalyses([])
    setDiagSeriesTags({})
    try {
      const sidecar = (await api.readSidecar(path)) as SidecarShape | null
      if (!sidecar || sidecar.format !== 'neurotrace-sidecar') {
        throw new Error('No NeuroTrace sidecar found for this file. Open + analyse it once first.')
      }
      const { recipes, warnings } = extractRecipes(sidecar)
      // Always commit the diagnostic + meta state, even with 0 recipes
      // — the user needs to see what the sidecar actually contains so
      // the warnings point at the right series. The throw-on-empty
      // earlier swallowed that detail and produced a generic error.
      setTemplateMeta(sidecar.meta ?? null)
      setDiagSeriesTags(sidecar.meta?.series_tags ?? {})
      const a = sidecar.analyses ?? {}
      const found: string[] = []
      const probe = (label: string, slot: any) => {
        if (slot && typeof slot === 'object') {
          const keys = Object.keys(slot)
          if (keys.length > 0) {
            // Translate 0-indexed storage keys to the HEKA-natural
            // 1-indexed form before showing the user — keeps the
            // diagnostic strings consistent with the tree labels.
            found.push(`${label}: ${keys.map(displayGroupSeries).join(', ')}`)
          }
        }
      }
      probe('events', a.events); probe('bursts', a.bursts); probe('ap', a.ap)
      probe('iv_curves', a.iv_curves); probe('fpsp_curves', a.fpsp_curves)
      probe('cursor_analyses', a.cursor_analyses); probe('resistance', a.resistance)
      setDiagAnalyses(found)
      setRecipes(recipes)
      setWarnings(warnings)
    } catch (err: any) {
      setLoadError(String(err?.message ?? err))
      setTemplateMeta(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Pre-load the active recording on first mount, if there is one. The
  // user can override via "Change template…". Tracked by a ref so we
  // don't re-pre-load if the active file changes mid-session — that
  // would clobber a deliberate template pick.
  const preloadDoneRef = useRef(false)
  useEffect(() => {
    if (preloadDoneRef.current) return
    if (recording?.filePath) {
      preloadDoneRef.current = true
      void loadTemplate(recording.filePath)
    }
  }, [recording?.filePath, loadTemplate])

  const pickTemplate = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.openFileDialog) return
    const path = await api.openFileDialog()
    if (!path) return
    await loadTemplate(path)
  }, [loadTemplate])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      fontFamily: 'var(--font-ui)', fontSize: 'var(--font-size-base)',
    }}>
      {/* Top bar — always visible. Houses the template picker + (later
          in this phase) the folder picker, run button, etc. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 10px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600 }}>Template:</span>
        <span style={{
          fontFamily: 'var(--font-mono)', flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: templatePath ? 'var(--text-primary)' : 'var(--text-muted)',
        }} title={templatePath ?? undefined}>
          {templatePath
            ? templatePath.split(/[/\\]/).pop()
            : 'No template selected'}
        </span>
        <button className="btn btn-primary" onClick={pickTemplate}>
          {templatePath ? 'Change template…' : 'Pick template…'}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
        {!templatePath ? (
          <div style={{
            color: 'var(--text-muted)', fontStyle: 'italic',
            padding: 24, textAlign: 'center',
          }}>
            Pick a recording you've already analysed and tagged. The
            batch module reads its sidecar to derive a per-tag recipe
            set, then applies the same recipes to every target file
            you select.
          </div>
        ) : loading ? (
          <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Reading template…
          </div>
        ) : loadError ? (
          <div style={{ color: '#e57373' }}>⚠ {loadError}</div>
        ) : (
          <RecipeList
            recipes={recipes}
            warnings={warnings}
            meta={templateMeta}
            diagAnalyses={diagAnalyses}
            diagSeriesTags={diagSeriesTags}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Recipe list — read-only summary of what the template will do.
// ---------------------------------------------------------------------------

const ANALYSIS_LABELS: Record<string, string> = {
  events: 'Events',
  bursts: 'Bursts',
  ap: 'Action potentials',
  iv_curves: 'I-V curve',
  fpsp_curves: 'Field PSP',
  cursor_analyses: 'Cursor measurements',
  resistance: 'Resistance',
}

/** Map a secondary-series role key to a human label per analysis +
 *  subtype. Currently only FPsp LTP uses this — role 'B' is the
 *  post-tetanus series. Unknown role keys fall back to themselves. */
function roleLabel(analysisType: string, subtype: string | null, role: string): string {
  if (analysisType === 'fpsp_curves' && subtype === 'ltp' && role === 'B') {
    return 'post-tetanus'
  }
  return role
}

function RecipeList({
  recipes, warnings, meta, diagAnalyses, diagSeriesTags,
}: {
  recipes: BatchRecipe[]
  warnings: string[]
  meta: SidecarMetaShape | null
  /** Lines like "events: 0:1, 0:3" — every analysis blob present in
   *  the sidecar, regardless of tag status. Used in the empty-recipe
   *  state so users can see WHICH series have analyses but no tags. */
  diagAnalyses: string[]
  /** Raw series_tags dump — same purpose as ``diagAnalyses`` but for
   *  the tag side. Helps spot the "tagged the wrong series" case. */
  diagSeriesTags: Record<string, string[]>
}) {
  // Group recipes by (analysisType, subtype, sourceKey) — that's the
  // unit-of-work for the runner. A given source-key may collect
  // multiple tags (the user can tag a series with several names) and
  // we want all of them visible as "match this OR that tag" on the
  // right-hand side. Grouping by source-key dedupes the recipe rows
  // even when a series has multiple tags.
  type Group = {
    analysisType: string
    subtype: string | null
    sourceKey: string
    channel: number | null
    primaryTags: string[]
    secondaryTags: Record<string, string[]>
  }
  const grouped = new Map<string, Group>()
  for (const r of recipes) {
    const k = `${r.analysisType}|${r.subtype ?? ''}|${r.sourceKey}`
    let g = grouped.get(k)
    if (!g) {
      g = {
        analysisType: r.analysisType,
        subtype: r.subtype,
        sourceKey: r.sourceKey,
        channel: r.channel,
        primaryTags: [],
        secondaryTags: r.secondaryTags ?? {},
      }
      grouped.set(k, g)
    }
    if (!g.primaryTags.includes(r.tag)) g.primaryTags.push(r.tag)
  }
  const groups = Array.from(grouped.values())
  groups.sort((a, b) =>
    a.analysisType.localeCompare(b.analysisType)
    || (a.subtype ?? '').localeCompare(b.subtype ?? '')
    || a.sourceKey.localeCompare(b.sourceKey))

  const fileTags = meta?.group_tags ?? []

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 12,
      maxWidth: 720,
    }}>
      {fileTags.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center',
          fontSize: 'var(--font-size-label)',
        }}>
          <span style={{ color: 'var(--text-muted)', marginRight: 4 }}>
            File-level tags:
          </span>
          {fileTags.map((t) => (
            <span key={t} style={{
              padding: '1px 6px',
              border: '1px solid var(--border)',
              borderRadius: 10,
              background: 'var(--bg-secondary)',
              fontFamily: 'var(--font-mono)',
            }}>{t}</span>
          ))}
        </div>
      )}

      {recipes.length === 0 && (
        <div style={{
          padding: '10px 12px',
          border: '1px solid #e57373',
          borderRadius: 4,
          background: 'rgba(229,115,115,0.08)',
          fontSize: 'var(--font-size-label)',
          lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: '#e57373' }}>
            No usable recipes derived from this template
          </div>
          <div style={{ marginBottom: 6 }}>
            Recipes need <strong>series-level tags</strong>: each (group:series)
            with an analysis must carry at least one tag in the file's
            metadata. File-level tags alone aren't enough — they say
            "what cell this is", not "what this series captures".
          </div>
          {diagAnalyses.length > 0 ? (
            <>
              <div style={{ marginTop: 8, fontWeight: 600 }}>
                Analyses found in this sidecar:
              </div>
              <ul style={{
                margin: '4px 0', paddingLeft: 18,
                fontFamily: 'var(--font-mono)',
              }}>
                {diagAnalyses.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            </>
          ) : (
            <div style={{ marginTop: 8, fontStyle: 'italic' }}>
              No analyses found in the sidecar — open + run an
              analysis on this file before using as a template.
            </div>
          )}
          {Object.keys(diagSeriesTags).length > 0 ? (
            <>
              <div style={{ marginTop: 8, fontWeight: 600 }}>
                Series-level tags currently set:
              </div>
              <ul style={{
                margin: '4px 0', paddingLeft: 18,
                fontFamily: 'var(--font-mono)',
              }}>
                {Object.entries(diagSeriesTags).map(([k, ts]) => (
                  <li key={k}>{displayGroupSeries(k)}: {ts.join(', ')}</li>
                ))}
              </ul>
              <div style={{ marginTop: 4, fontStyle: 'italic' }}>
                If the (group:series) keys above don't match the
                analyses, open Tags… and add tags to the right series.
              </div>
            </>
          ) : (
            <div style={{ marginTop: 8, fontStyle: 'italic' }}>
              No series-level tags at all. Open Tags…, expand this
              file's series rows, and tag the analysed ones.
            </div>
          )}
        </div>
      )}
      {recipes.length > 0 && (
      <div>
        <div style={{
          fontWeight: 600, marginBottom: 6,
          color: 'var(--text-primary)',
        }}>
          Detected recipes ({groups.length})
        </div>
        <div style={{
          border: '1px solid var(--border)', borderRadius: 4,
          background: 'var(--bg-primary)',
          overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1.5fr 2fr 1fr',
            padding: '6px 10px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            fontSize: 'var(--font-size-label)',
            color: 'var(--text-muted)',
            fontWeight: 600,
          }}>
            <span>Analysis</span>
            <span>Matches series tagged…</span>
            <span style={{ textAlign: 'right' }}>Source</span>
          </div>
          {/* Rows */}
          {groups.map((g, i) => (
            <div key={i} style={{
              display: 'grid',
              gridTemplateColumns: '1.5fr 2fr 1fr',
              padding: '6px 10px',
              borderBottom: i < groups.length - 1
                ? '1px solid var(--border-subtle, var(--border))' : 'none',
              alignItems: 'center',
              fontSize: 'var(--font-size-label)',
            }}>
              {/* Left: analysis type + subtype */}
              <span>
                <span style={{ fontWeight: 600 }}>
                  {ANALYSIS_LABELS[g.analysisType] ?? g.analysisType}
                </span>
                {g.subtype && (
                  <span style={{
                    marginLeft: 6,
                    padding: '0 6px',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    background: 'var(--bg-secondary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--font-size-xs)',
                    fontWeight: 500,
                    color: 'var(--text-muted)',
                  }}>{g.subtype}</span>
                )}
              </span>
              {/* Middle: tags. Primary tags on top, secondary tags
                  (LTP post-tetanus etc.) below with role label. */}
              <span style={{
                display: 'flex', flexDirection: 'column', gap: 3,
              }}>
                <span style={{
                  display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center',
                }}>
                  {g.primaryTags.map((t) => (
                    <span key={t} style={{
                      padding: '0 7px',
                      border: '1px solid var(--accent, #64b5f6)',
                      borderRadius: 10,
                      background: 'var(--bg-secondary)',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 600,
                      color: 'var(--accent, #64b5f6)',
                    }}>{t}</span>
                  ))}
                </span>
                {Object.entries(g.secondaryTags).map(([role, tags]) => (
                  <span key={role} style={{
                    display: 'flex', flexWrap: 'wrap', gap: 4,
                    alignItems: 'center', fontSize: 'var(--font-size-xs)',
                  }}>
                    <span style={{
                      color: 'var(--text-muted)', fontStyle: 'italic',
                    }}>
                      + secondary ({roleLabel(g.analysisType, g.subtype, role)}):
                    </span>
                    {tags.map((t) => (
                      <span key={t} style={{
                        padding: '0 6px',
                        border: '1px dashed var(--accent, #64b5f6)',
                        borderRadius: 10,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--accent, #64b5f6)',
                      }}>{t}</span>
                    ))}
                  </span>
                ))}
              </span>
              {/* Right: source key + channel */}
              <span style={{
                textAlign: 'right',
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--font-size-xs)',
              }}>
                {displayGroupSeries(g.sourceKey)}
                {g.channel != null ? ` · ch ${g.channel + 1}` : ''}
              </span>
            </div>
          ))}
        </div>
      </div>
      )}

      {warnings.length > 0 && (
        <div style={{
          padding: '8px 10px',
          border: '1px solid #ffb74d',
          borderRadius: 4,
          background: 'rgba(255,183,77,0.08)',
          fontSize: 'var(--font-size-label)',
        }}>
          <div style={{
            fontWeight: 600, marginBottom: 4, color: '#ffb74d',
          }}>
            ⚠ {warnings.length} warning{warnings.length === 1 ? '' : 's'}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      <div style={{
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        Next step: pick a target folder. Files matching at least one
        recipe tag will be selectable for batch processing.
      </div>
    </div>
  )
}
