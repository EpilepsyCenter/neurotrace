import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useAppStore,
  getMetaStatus,
  SidecarMeta,
  MetaStatus,
} from '../../stores/appStore'
import { TagChipInput } from '../common/TagChipInput'

/**
 * Metadata window — Phase A.2.
 *
 * Two-pane layout:
 *   Left  — list of recording-shaped files in the current folder, each
 *           with a tri-state status dot (red/yellow/green per
 *           ``getMetaStatus``). Clicking a file selects it for editing.
 *           Files without a sidecar still show, greyed out, so the
 *           user can pre-tag a whole cohort before any analysis starts.
 *   Right — single-file editor:
 *             - cell_id text field
 *             - file-level tag chip input (autocomplete from the pool of
 *               tags already used in the folder)
 *             - per-series chip rows (one row per HEKA series), with
 *               their own autocomplete pool
 *             - free-form notes textarea
 *
 * Architecture:
 *   - The "active recording" (the one currently loaded in the main
 *     window) is edited via the store so changes round-trip live to the
 *     main window's status dot and to other analysis windows. The store
 *     subscriber writes the sidecar to disk on a debounced 1s timer.
 *   - Other files in the folder are edited "off-store": we read their
 *     sidecar directly via the Electron IPC, edit a local copy, and
 *     write it back with ``writeSidecar``. This lets the user tag the
 *     whole cohort without having to open every file in the main
 *     viewer first.
 *   - Edits to the active file also broadcast a ``meta-update`` so any
 *     other open analysis window (and the main toolbar's status dot)
 *     re-render immediately.
 *
 * The Cohort Analysis module (Phase B) will read from these tags to
 * group cells; the consistency checker (Phase A.4) flags near-duplicate
 * tag spellings inside the same folder.
 */

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

interface FolderEntry {
  filePath: string
  fileName: string
  hasSidecar: boolean
  meta: SidecarMeta | null
}

const STATUS_COLORS: Record<MetaStatus, string> = {
  red: '#ef4444',
  yellow: '#eab308',
  green: '#22c55e',
}

const STATUS_TITLES: Record<MetaStatus, string> = {
  red: 'No file-level tags yet',
  yellow: 'File tags set; no series tagged yet',
  green: 'File tags set and ≥1 series tagged',
}

export function MetadataWindow({ backendUrl, fileInfo }: {
  backendUrl: string
  fileInfo: FileInfo | null
}) {
  void backendUrl  // not yet — folder-scan endpoint comes in A.4

  const recording = useAppStore((s) => s.recording)
  const storeMeta = useAppStore((s) => s.recordingMeta)
  const setRecordingMeta = useAppStore((s) => s.setRecordingMeta)
  const setSeriesTags = useAppStore((s) => s.setSeriesTags)

  // Folder listing (left pane) and the cached meta for files that
  // *aren't* the active recording. The active recording's meta always
  // comes from `storeMeta`; everything else lives in this map.
  const [folder, setFolder] = useState<string | null>(null)
  const [entries, setEntries] = useState<FolderEntry[]>([])
  const [otherMeta, setOtherMeta] = useState<Record<string, SidecarMeta | null>>({})
  const [otherGroups, setOtherGroups] = useState<Record<string, any[] | null>>({})

  // Which file is currently being edited in the right pane. When null
  // we fall back to the active recording. When a non-active file is
  // selected we edit its sidecar directly via writeSidecar.
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  // Batch-tag selection (Phase A.3). The right pane switches to a
  // batch-edit view whenever ``checked`` is non-empty. Tags committed
  // in batch mode are *added* to every checked file's existing tag
  // list — additive merge, never overwriting or removing.
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [batchProgress, setBatchProgress] = useState<{
    total: number
    done: number
    errors: string[]
  } | null>(null)

  // Save status indicator for the off-store ("other") files.
  const [savingPath, setSavingPath] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Consistency-checker modal (Phase A.4). Opens on demand; computes
  // near-duplicate tag clusters across every sidecar in the folder
  // so the user can fix typos cohort-wide before running analyses.
  const [consistencyOpen, setConsistencyOpen] = useState(false)

  // Broadcast channel — for live meta-update sync to the main window
  // when the user edits the active recording's tags.
  const channelRef = useRef<BroadcastChannel | null>(null)
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('neurotrace-sync')
      channelRef.current = ch
      return () => ch.close()
    } catch { /* no-op */ }
  }, [])

  // ------------------------------------------------------------------
  // Folder listing
  // ------------------------------------------------------------------
  const refreshFolder = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.listFolderRecordings) return
    // Anchor: active recording's path. If nothing loaded, try the most
    // recent file from preferences (Phase A.1 spec — "most recent is
    // fine"). A future iteration can add an "Open folder…" button.
    let anchor = recording?.filePath ?? null
    if (!anchor) {
      try {
        const prefs = await api.getPreferences()
        const recent = (prefs?.recentFiles as string[] | undefined)?.[0]
        if (recent) anchor = recent
      } catch { /* ignore */ }
    }
    if (!anchor) {
      setFolder(null)
      setEntries([])
      return
    }
    const result = await api.listFolderRecordings(anchor)
    setFolder(result.folder)
    setEntries(result.entries.map((e) => ({
      filePath: e.filePath,
      fileName: e.fileName,
      hasSidecar: e.hasSidecar,
      meta: (e.meta as SidecarMeta | null) ?? null,
    })))
    // Seed the off-store meta cache so the right pane can edit any
    // file in the folder without re-reading its sidecar on every
    // selection.
    setOtherMeta((prev) => {
      const next = { ...prev }
      for (const e of result.entries) {
        if (e.filePath !== recording?.filePath) {
          next[e.filePath] = (e.meta as SidecarMeta | null) ?? null
        }
      }
      return next
    })
  }, [recording?.filePath])

  useEffect(() => {
    refreshFolder()
  }, [refreshFolder])

  // ------------------------------------------------------------------
  // Active selection helpers
  // ------------------------------------------------------------------
  const activePath = selectedPath ?? recording?.filePath ?? null
  const isActiveRecording = activePath === recording?.filePath
  const activeMeta: SidecarMeta | null = isActiveRecording
    ? storeMeta
    : (activePath ? (otherMeta[activePath] ?? null) : null)

  // For per-series chip rows we need the recording's group/series
  // tree. The active recording's tree comes from `recording.groups`.
  // For non-active files we don't have the tree (we'd have to load
  // the file in the backend) — fall back to whatever series_tags
  // already exist in their sidecar so users can at least see + edit
  // existing per-series tags. New per-series tags require opening
  // the file in the main window.
  const activeGroups: any[] | null = isActiveRecording
    ? (recording?.groups ?? null)
    : (activePath ? (otherGroups[activePath] ?? null) : null)

  // ------------------------------------------------------------------
  // Tag suggestion pools — collected from every sidecar in the folder
  // so tag autocomplete spans the whole cohort (the main reason
  // people want a metadata module).
  // ------------------------------------------------------------------
  const { fileTagPool, seriesTagPool } = useMemo(() => {
    const fileSet = new Set<string>()
    const seriesSet = new Set<string>()
    const consume = (m: SidecarMeta | null | undefined) => {
      if (!m) return
      for (const t of m.group_tags ?? []) fileSet.add(t)
      for (const tags of Object.values(m.series_tags ?? {})) {
        for (const t of tags) seriesSet.add(t)
      }
    }
    consume(storeMeta)
    for (const e of entries) consume(e.meta)
    for (const m of Object.values(otherMeta)) consume(m)
    return {
      fileTagPool: Array.from(fileSet).sort(),
      seriesTagPool: Array.from(seriesSet).sort(),
    }
  }, [storeMeta, entries, otherMeta])

  // ------------------------------------------------------------------
  // Edit helpers — branch on whether we're editing the active record
  // or an off-store sidecar
  // ------------------------------------------------------------------
  const broadcastMetaUpdate = useCallback((meta: SidecarMeta | null) => {
    channelRef.current?.postMessage({
      type: 'meta-update',
      recordingMeta: meta,
    })
  }, [])

  /** Apply an updater to the meta of the file at ``path``. Routes
   *  through the store for the active recording (so the disk write
   *  goes through the existing debounced subscriber) and through a
   *  direct sidecar read-modify-write for any other file. */
  const updateMetaFor = useCallback(async (
    path: string,
    updater: (prev: SidecarMeta) => SidecarMeta,
  ) => {
    if (path === recording?.filePath) {
      const prev = useAppStore.getState().recordingMeta ?? {}
      const next = updater(prev)
      // Replace wholesale — `setRecordingMeta` does a shallow merge,
      // which doesn't work for deletions (e.g. clearing all chips).
      // Use the store directly to set the new object.
      useAppStore.setState({ recordingMeta: next })
      broadcastMetaUpdate(next)
      // Reflect in left-pane entry too so the status dot updates.
      setEntries((es) => es.map((e) => e.filePath === path
        ? { ...e, hasSidecar: true, meta: next }
        : e))
      return
    }
    // Off-store: read sidecar, mutate, write back.
    const api = window.electronAPI
    if (!api?.readSidecar || !api?.writeSidecar) return
    setSavingPath(path)
    setSaveError(null)
    try {
      const existing = (await api.readSidecar(path)) ?? {}
      const prevMeta = (existing.meta as SidecarMeta | undefined) ?? {}
      const nextMeta = updater(prevMeta)
      const payload = {
        ...existing,
        format: 'neurotrace-sidecar',
        version: existing.version ?? 2,
        meta: nextMeta,
      }
      const ok = await api.writeSidecar(path, payload)
      if (!ok) throw new Error('writeSidecar returned false')
      setOtherMeta((m) => ({ ...m, [path]: nextMeta }))
      setEntries((es) => es.map((e) => e.filePath === path
        ? { ...e, hasSidecar: true, meta: nextMeta }
        : e))
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingPath(null)
    }
  }, [recording?.filePath, broadcastMetaUpdate])
  // ------------------------------------------------------------------
  // Batch-tag actions (Phase A.3)
  // ------------------------------------------------------------------
  const toggleChecked = useCallback((path: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const checkAll = useCallback(() => {
    setChecked(new Set(entries.map((e) => e.filePath)))
  }, [entries])

  const clearChecked = useCallback(() => setChecked(new Set()), [])

  /** Apply a meta-updater to every checked file in sequence. Routes
   *  through the same ``updateMetaFor`` helper used for single-file
   *  edits — that means the active recording's batch update goes
   *  through the store (and the auto-save subscriber + broadcast),
   *  while every other file gets a direct sidecar read-modify-write.
   *  Errors are collected per-file and displayed at the end without
   *  aborting the batch. */
  const runBatch = useCallback(async (
    updater: (prev: SidecarMeta) => SidecarMeta,
  ) => {
    const paths = Array.from(checked)
    if (paths.length === 0) return
    setBatchProgress({ total: paths.length, done: 0, errors: [] })
    const errors: string[] = []
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i]
      try {
        await updateMetaFor(p, updater)
      } catch (err) {
        errors.push(`${p.split(/[/\\]/).pop()}: ${err instanceof Error ? err.message : String(err)}`)
      }
      setBatchProgress({ total: paths.length, done: i + 1, errors })
    }
    // Hold the completion banner briefly so the user sees "done N/N",
    // then collapse.
    window.setTimeout(() => setBatchProgress(null), 1500)
  }, [checked, updateMetaFor])

  // setRecordingMeta + setSeriesTags are kept in scope above as a
  // documented API surface; we currently bypass them in favor of
  // direct setState calls so wholesale replacements (e.g. clearing
  // an array) work without the merge-then-strip dance. Reference
  // them here so TS doesn't flag them as unused imports.
  void setRecordingMeta
  void setSeriesTags

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  void fileInfo  // currently mirrored via `recording`

  if (!folder) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', padding: 24, color: 'var(--text-muted)',
        fontStyle: 'italic',
      }}>
        Open a recording to start tagging — the metadata window scans
        the active file's folder for cohorts.
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      fontSize: 'var(--font-size-base)',
    }}>
      {/* Top bar — folder context */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        color: 'var(--text-muted)',
        fontSize: 'var(--font-size-base)',
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Folder:</span>
        <span style={{
          fontFamily: 'var(--font-mono)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          flex: 1,
        }} title={folder}>{folder}</span>
        <button
          className="btn"
          onClick={() => setConsistencyOpen(true)}
          title="Find near-duplicate tags across the folder (e.g. typos, case variants)"
          style={{ padding: '2px 8px', fontSize: 'var(--font-size-base)' }}
        >Consistency check</button>
        <button
          className="btn"
          onClick={() => refreshFolder()}
          title="Re-scan folder for sidecars"
          style={{ padding: '2px 8px', fontSize: 'var(--font-size-base)' }}
        >Refresh</button>
      </div>

      {consistencyOpen && (
        <ConsistencyCheckModal
          activeFilePath={recording?.filePath ?? null}
          activeMeta={storeMeta}
          entries={entries}
          otherMeta={otherMeta}
          onClose={() => setConsistencyOpen(false)}
          onRename={async (oldTag, newTag) => {
            // Apply across every file in the folder. Replaces the tag
            // case-insensitively in both file_tags and series_tags.
            const oldLower = oldTag.toLowerCase()
            const renameMeta = (m: SidecarMeta): SidecarMeta => {
              const next: SidecarMeta = { ...m }
              if (next.group_tags) {
                const replaced = next.group_tags.map((t) =>
                  t.toLowerCase() === oldLower ? newTag : t)
                // Dedupe in case the canonical name was already
                // present alongside the variant.
                const seen = new Set<string>()
                const dedup: string[] = []
                for (const t of replaced) {
                  const k = t.toLowerCase()
                  if (seen.has(k)) continue
                  seen.add(k)
                  dedup.push(t)
                }
                if (dedup.length === 0) delete next.group_tags
                else next.group_tags = dedup
              }
              if (next.series_tags) {
                const map: Record<string, string[]> = {}
                for (const [k, tags] of Object.entries(next.series_tags)) {
                  const replaced = tags.map((t) =>
                    t.toLowerCase() === oldLower ? newTag : t)
                  const seen = new Set<string>()
                  const dedup: string[] = []
                  for (const t of replaced) {
                    const lk = t.toLowerCase()
                    if (seen.has(lk)) continue
                    seen.add(lk)
                    dedup.push(t)
                  }
                  if (dedup.length > 0) map[k] = dedup
                }
                if (Object.keys(map).length === 0) delete next.series_tags
                else next.series_tags = map
              }
              return next
            }
            for (const e of entries) {
              await updateMetaFor(e.filePath, renameMeta)
            }
          }}
        />
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left pane — file list */}
        <div style={{
          width: 300,
          borderRight: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          overflowY: 'auto',
          flexShrink: 0,
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Batch-selection header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 8px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-primary)',
            fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)',
            flexShrink: 0,
          }}>
            <span style={{ flex: 1 }}>
              {checked.size > 0
                ? `${checked.size} selected`
                : `${entries.length} file${entries.length === 1 ? '' : 's'}`}
            </span>
            <button
              className="btn"
              onClick={checkAll}
              disabled={entries.length === 0 || checked.size === entries.length}
              title="Select every file in the folder"
              style={{ fontSize: 'var(--font-size-xs)', padding: '1px 6px' }}
            >All</button>
            <button
              className="btn"
              onClick={clearChecked}
              disabled={checked.size === 0}
              title="Clear batch selection"
              style={{ fontSize: 'var(--font-size-xs)', padding: '1px 6px' }}
            >Clear</button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
          {entries.length === 0 ? (
            <div style={{
              padding: 16, color: 'var(--text-muted)',
              fontStyle: 'italic',
            }}>No recordings in this folder.</div>
          ) : entries.map((e) => {
            const meta = e.filePath === recording?.filePath ? storeMeta : e.meta
            const status = getMetaStatus(meta)
            const isSelected = e.filePath === activePath
            const isActive = e.filePath === recording?.filePath
            const isChecked = checked.has(e.filePath)
            return (
              <div
                key={e.filePath}
                onClick={() => setSelectedPath(e.filePath)}
                title={e.filePath}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 8px',
                  borderBottom: '1px solid var(--border-subtle, var(--border))',
                  cursor: 'pointer',
                  background: isSelected ? 'var(--bg-tertiary)' : 'transparent',
                  fontFamily: 'var(--font-mono)',
                  opacity: e.hasSidecar || isActive ? 1 : 0.65,
                }}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleChecked(e.filePath)}
                  onClick={(ev) => ev.stopPropagation()}
                  title="Include in batch tagging"
                  style={{ cursor: 'pointer', flexShrink: 0 }}
                />
                <span
                  title={STATUS_TITLES[status]}
                  style={{
                    width: 9, height: 9, borderRadius: '50%',
                    background: STATUS_COLORS[status],
                    flexShrink: 0,
                    boxShadow: '0 0 0 1px rgba(0,0,0,0.25)',
                  }}
                />
                <span style={{
                  flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>{e.fileName}</span>
                {isActive && (
                  <span style={{
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-sans)',
                  }}>open</span>
                )}
              </div>
            )
          })}
          </div>
        </div>

        {/* Right pane — single-file editor or batch editor */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: '12px 16px',
          minWidth: 0,
        }}>
          {checked.size > 0 ? (
            <BatchEditor
              checkedPaths={Array.from(checked)}
              fileTagSuggestions={fileTagPool}
              progress={batchProgress}
              onCancelSelection={clearChecked}
              onApplyFileTags={(tags) => runBatch((prev) => {
                const existing = new Set(prev.group_tags ?? [])
                for (const t of tags) existing.add(t)
                if (existing.size === 0) {
                  const next = { ...prev }
                  delete next.group_tags
                  return next
                }
                return { ...prev, group_tags: Array.from(existing) }
              })}
              onRemoveFileTags={(tags) => runBatch((prev) => {
                const drop = new Set(tags.map((t) => t.toLowerCase()))
                const kept = (prev.group_tags ?? [])
                  .filter((t) => !drop.has(t.toLowerCase()))
                const next = { ...prev }
                if (kept.length === 0) delete next.group_tags
                else next.group_tags = kept
                return next
              })}
            />
          ) : !activePath ? (
            <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Select a recording from the left to edit its tags.
            </div>
          ) : (
            <FileEditor
              filePath={activePath}
              fileName={activePath.split(/[/\\]/).pop() ?? activePath}
              meta={activeMeta}
              groups={activeGroups}
              isActiveRecording={isActiveRecording}
              fileTagSuggestions={fileTagPool}
              seriesTagSuggestions={seriesTagPool}
              saving={savingPath === activePath}
              saveError={savingPath === null ? saveError : null}
              onUpdate={(updater) => updateMetaFor(activePath, updater)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Right-pane editor for a single file. Stateless — driven by `meta`
// from the parent and reports edits via `onUpdate`.
// ---------------------------------------------------------------------
function FileEditor({
  filePath, fileName, meta, groups,
  isActiveRecording,
  fileTagSuggestions, seriesTagSuggestions,
  saving, saveError,
  onUpdate,
}: {
  filePath: string
  fileName: string
  meta: SidecarMeta | null
  groups: any[] | null
  isActiveRecording: boolean
  fileTagSuggestions: string[]
  seriesTagSuggestions: string[]
  saving: boolean
  saveError: string | null
  onUpdate: (updater: (prev: SidecarMeta) => SidecarMeta) => void
}) {
  void filePath  // not currently displayed — fileName carries the label
  const fileTags = meta?.group_tags ?? []
  const seriesTags = meta?.series_tags ?? {}
  const cellId = meta?.cell_id ?? ''
  const notes = meta?.notes ?? ''

  // Fall back to whatever series_tags keys exist in the sidecar when
  // we don't have the recording's group tree (off-store edit).
  type SeriesRow = { groupIndex: number; seriesIndex: number; label: string }
  const seriesRows: SeriesRow[] = useMemo(() => {
    if (groups && groups.length > 0) {
      const rows: SeriesRow[] = []
      for (const g of groups) {
        const gIdx = g.index as number
        const gLabel = g.label as string | undefined
        for (const s of g.series ?? []) {
          rows.push({
            groupIndex: gIdx,
            seriesIndex: s.index,
            label: gLabel ? `${gLabel} / ${s.label}` : s.label,
          })
        }
      }
      return rows
    }
    // Off-store fallback: derive rows from the stored series_tags map.
    return Object.keys(seriesTags).map((k) => {
      const [g, s] = k.split(':').map(Number)
      return {
        groupIndex: g,
        seriesIndex: s,
        label: `Group ${g + 1} / Series ${s + 1}`,
      }
    }).sort((a, b) =>
      a.groupIndex - b.groupIndex || a.seriesIndex - b.seriesIndex)
  }, [groups, seriesTags])

  const updateField = <K extends keyof SidecarMeta>(key: K, value: SidecarMeta[K]) => {
    onUpdate((prev) => {
      const next: SidecarMeta = { ...prev }
      if (value === undefined || value === '' ||
          (Array.isArray(value) && value.length === 0)) {
        delete next[key]
      } else {
        next[key] = value
      }
      return next
    })
  }

  const updateSeriesTags = (group: number, series: number, tags: string[]) => {
    onUpdate((prev) => {
      const next: SidecarMeta = { ...prev }
      const map = { ...(next.series_tags ?? {}) }
      const key = `${group}:${series}`
      const cleaned = tags.map((t) => t.trim()).filter(Boolean)
      if (cleaned.length === 0) delete map[key]
      else map[key] = cleaned
      if (Object.keys(map).length === 0) delete next.series_tags
      else next.series_tags = map
      return next
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
      {/* File header */}
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        paddingBottom: 6, borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-base)',
          fontWeight: 600,
        }}>{fileName}</span>
        {!isActiveRecording && (
          <span style={{
            fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}>not open in main window — editing sidecar directly</span>
        )}
        {saving && (
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
            saving…
          </span>
        )}
        {saveError && (
          <span style={{ fontSize: 'var(--font-size-xs)', color: '#ef4444' }} title={saveError}>
            save failed
          </span>
        )}
      </div>

      {/* Cell ID */}
      <Field label="Cell ID" hint="Optional human-readable identifier for this recording (e.g. cell_42).">
        <input
          type="text"
          value={cellId}
          onChange={(e) => updateField('cell_id', e.target.value)}
          placeholder="cell_42"
          style={{
            width: '100%', padding: '4px 8px',
            border: '1px solid var(--border)', borderRadius: 3,
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--font-size-base)',
          }}
        />
      </Field>

      {/* File-level tags */}
      <Field
        label="File tags"
        hint="Recording-level attributes (genotype, sex, age, treatment…). Type a tag and press Enter or comma to add."
      >
        <TagChipInput
          value={fileTags}
          onChange={(next) => updateField('group_tags', next)}
          suggestions={fileTagSuggestions}
          placeholder="add tag…"
        />
      </Field>

      {/* Per-series tags */}
      <Field
        label="Per-series tags"
        hint="Mark which series captured what (e.g. test_pulse, IV, evoked). Drag the main viewer's tree to load a series, then add tags here."
      >
        {seriesRows.length === 0 ? (
          <div style={{
            color: 'var(--text-muted)', fontStyle: 'italic',
            padding: '4px 0', fontSize: 'var(--font-size-xs)',
          }}>
            {isActiveRecording
              ? 'This recording has no series.'
              : 'Open this file in the main window to tag its series.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {seriesRows.map((row) => {
              const key = `${row.groupIndex}:${row.seriesIndex}`
              const tags = seriesTags[key] ?? []
              return (
                <div key={key} style={{
                  display: 'grid',
                  gridTemplateColumns: '160px 1fr',
                  alignItems: 'center', gap: 8,
                }}>
                  <span
                    title={key}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--font-size-xs)',
                      color: 'var(--text-muted)',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >{row.label}</span>
                  <TagChipInput
                    value={tags}
                    onChange={(next) => updateSeriesTags(row.groupIndex, row.seriesIndex, next)}
                    suggestions={seriesTagSuggestions}
                    inline
                    placeholder="add tag…"
                  />
                </div>
              )
            })}
          </div>
        )}
      </Field>

      {/* Notes */}
      <Field label="Notes" hint="Free-form notes — quality issues, atypical conditions, anything that doesn't fit a tag.">
        <textarea
          value={notes}
          onChange={(e) => updateField('notes', e.target.value)}
          placeholder="any free-form notes about this recording…"
          rows={4}
          style={{
            width: '100%', padding: '6px 8px',
            border: '1px solid var(--border)', borderRadius: 3,
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--font-size-base)',
            resize: 'vertical',
          }}
        />
      </Field>
    </div>
  )
}

// ---------------------------------------------------------------------
// Batch editor (Phase A.3)
//
// Shown when the user has ≥1 file checked in the left pane. Two
// staging chip-inputs:
//   - Add tags: chips committed here get merged into every checked
//     file's existing tag list (additive, never replaces).
//   - Remove tags: chips listed here get stripped from every checked
//     file (case-insensitive). Useful for fixing typos across a
//     cohort once the consistency checker (A.4) flags one.
//
// Per-series batch tagging is intentionally NOT included here yet —
// the per-series tag set varies file-by-file (different series
// counts, different protocols). A.3's value is the file-level case
// where users want to mark a whole cohort with shared attributes
// (genotype, treatment, slice batch).
// ---------------------------------------------------------------------
function BatchEditor({
  checkedPaths,
  fileTagSuggestions,
  progress,
  onCancelSelection,
  onApplyFileTags,
  onRemoveFileTags,
}: {
  checkedPaths: string[]
  fileTagSuggestions: string[]
  progress: { total: number; done: number; errors: string[] } | null
  onCancelSelection: () => void
  onApplyFileTags: (tags: string[]) => void
  onRemoveFileTags: (tags: string[]) => void
}) {
  const [addTags, setAddTags] = useState<string[]>([])
  const [removeTags, setRemoveTags] = useState<string[]>([])
  const busy = progress !== null && progress.done < progress.total

  const apply = () => {
    if (addTags.length === 0) return
    onApplyFileTags(addTags)
    setAddTags([])
  }
  const remove = () => {
    if (removeTags.length === 0) return
    onRemoveFileTags(removeTags)
    setRemoveTags([])
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        paddingBottom: 6, borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          fontSize: 'var(--font-size-base)', fontWeight: 600,
        }}>Batch tagging — {checkedPaths.length} file{checkedPaths.length === 1 ? '' : 's'}</span>
        <button
          className="btn"
          onClick={onCancelSelection}
          disabled={busy}
          style={{
            marginLeft: 'auto', fontSize: 'var(--font-size-xs)', padding: '2px 8px',
          }}
        >Cancel selection</button>
      </div>

      <div style={{
        fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)',
        padding: '6px 8px',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 3,
        maxHeight: 100, overflowY: 'auto',
        fontFamily: 'var(--font-mono)',
      }}>
        {checkedPaths.map((p) => (
          <div key={p} style={{
            overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>{p.split(/[/\\]/).pop()}</div>
        ))}
      </div>

      <Field
        label="Add file tags"
        hint="These tags get merged into every selected file's existing list. No file ever loses a tag this way."
      >
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <TagChipInput
              value={addTags}
              onChange={setAddTags}
              suggestions={fileTagSuggestions}
              disabled={busy}
              placeholder="add tag…"
            />
          </div>
          <button
            className="btn"
            onClick={apply}
            disabled={busy || addTags.length === 0}
            style={{
              padding: '4px 12px', fontSize: 'var(--font-size-xs)',
              background: 'var(--accent, #3b82f6)', color: '#fff',
              border: 'none',
            }}
          >Apply</button>
        </div>
      </Field>

      <Field
        label="Remove file tags"
        hint="Listed tags are stripped from every selected file (case-insensitive). Files that don't carry the tag are skipped silently."
      >
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <TagChipInput
              value={removeTags}
              onChange={setRemoveTags}
              suggestions={fileTagSuggestions}
              disabled={busy}
              placeholder="tag to remove…"
            />
          </div>
          <button
            className="btn"
            onClick={remove}
            disabled={busy || removeTags.length === 0}
            style={{ padding: '4px 12px', fontSize: 'var(--font-size-xs)' }}
          >Remove</button>
        </div>
      </Field>

      {progress && (
        <div style={{
          padding: '6px 10px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 3,
          fontSize: 'var(--font-size-xs)',
        }}>
          <div>
            {progress.done < progress.total
              ? `Applying… ${progress.done} / ${progress.total}`
              : progress.errors.length === 0
                ? `Done — updated ${progress.total} file${progress.total === 1 ? '' : 's'}.`
                : `Done with ${progress.errors.length} error${progress.errors.length === 1 ? '' : 's'} (${progress.done - progress.errors.length} updated).`
            }
          </div>
          {progress.errors.length > 0 && (
            <ul style={{
              marginTop: 4, paddingLeft: 18,
              color: '#ef4444', fontFamily: 'var(--font-mono)',
            }}>
              {progress.errors.map((err, i) => <li key={i}>{err}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Consistency checker (Phase A.4)
//
// Scans every sidecar in the folder, collects all tags + occurrences,
// then groups near-duplicates into clusters. A pair is "near" if any
// of:
//   - case-insensitive equal (e.g. "WT" vs "wt")
//   - whitespace / punctuation collapse equal (e.g. "test pulse" vs "test_pulse")
//   - Levenshtein distance ≤ 1 for short tags, ≤ 2 for ≥ 8-char tags
//
// The user picks the canonical form for each cluster and clicks Apply,
// which renames the variants to the canonical form across every
// sidecar in the folder.
// ---------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const m = a.length
  const n = b.length
  // Two-row DP — sufficient for our short tag strings.
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      )
    }
    [prev, curr] = [curr, prev]
  }
  return prev[n]
}

/** Loose equality for clustering — matches case-only and
 *  whitespace/underscore-only differences exactly, plus small edit
 *  distances proportional to length. */
function isNearDuplicate(a: string, b: string): boolean {
  if (a === b) return false
  const al = a.toLowerCase()
  const bl = b.toLowerCase()
  if (al === bl) return true
  const ac = al.replace(/[\s_\-.]/g, '')
  const bc = bl.replace(/[\s_\-.]/g, '')
  if (ac === bc) return true
  const d = levenshtein(ac, bc)
  const maxLen = Math.max(ac.length, bc.length)
  if (maxLen < 4) return false       // too short — false positives explode
  if (maxLen <= 7) return d <= 1
  return d <= 2
}

interface TagOccurrence {
  tag: string
  count: number
  scope: 'file' | 'series' | 'mixed'
}

function ConsistencyCheckModal({
  activeFilePath, activeMeta, entries, otherMeta,
  onClose, onRename,
}: {
  activeFilePath: string | null
  activeMeta: SidecarMeta | null
  entries: FolderEntry[]
  otherMeta: Record<string, SidecarMeta | null>
  onClose: () => void
  onRename: (oldTag: string, newTag: string) => Promise<void>
}) {
  const [working, setWorking] = useState(false)

  // Gather all tags + occurrences across the folder.
  const occurrences: TagOccurrence[] = useMemo(() => {
    const counts = new Map<string, { count: number; scopes: Set<'file' | 'series'> }>()
    const consume = (m: SidecarMeta | null | undefined) => {
      if (!m) return
      for (const t of m.group_tags ?? []) {
        const slot = counts.get(t) ?? { count: 0, scopes: new Set() }
        slot.count += 1
        slot.scopes.add('file')
        counts.set(t, slot)
      }
      for (const tags of Object.values(m.series_tags ?? {})) {
        for (const t of tags) {
          const slot = counts.get(t) ?? { count: 0, scopes: new Set() }
          slot.count += 1
          slot.scopes.add('series')
          counts.set(t, slot)
        }
      }
    }
    consume(activeMeta)
    for (const e of entries) {
      if (e.filePath !== activeFilePath) consume(otherMeta[e.filePath] ?? e.meta)
    }
    return Array.from(counts.entries()).map(([tag, v]) => ({
      tag,
      count: v.count,
      scope: v.scopes.size === 2 ? 'mixed' as const :
        (v.scopes.has('file') ? 'file' as const : 'series' as const),
    }))
  }, [activeFilePath, activeMeta, entries, otherMeta])

  // Cluster near-duplicates with a simple union-find.
  const clusters: TagOccurrence[][] = useMemo(() => {
    const n = occurrences.length
    const parent = Array.from({ length: n }, (_, i) => i)
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]]
        i = parent[i]
      }
      return i
    }
    const union = (a: number, b: number) => {
      const ra = find(a), rb = find(b)
      if (ra !== rb) parent[ra] = rb
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (isNearDuplicate(occurrences[i].tag, occurrences[j].tag)) {
          union(i, j)
        }
      }
    }
    const groups = new Map<number, TagOccurrence[]>()
    for (let i = 0; i < n; i++) {
      const r = find(i)
      const arr = groups.get(r) ?? []
      arr.push(occurrences[i])
      groups.set(r, arr)
    }
    return Array.from(groups.values())
      .filter((g) => g.length >= 2)
      // Sort each cluster: most-frequent first (good default canonical).
      .map((g) => g.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)))
  }, [occurrences])

  // Per-cluster: which variant the user has picked as canonical.
  // Defaults to the most-frequent (first) entry.
  const [picked, setPicked] = useState<Record<number, string>>({})
  const canonicalFor = (idx: number) =>
    picked[idx] ?? clusters[idx]?.[0]?.tag ?? ''

  const applyCluster = async (idx: number) => {
    const cluster = clusters[idx]
    const canon = canonicalFor(idx)
    if (!cluster || !canon) return
    setWorking(true)
    try {
      for (const occ of cluster) {
        if (occ.tag === canon) continue
        await onRename(occ.tag, canon)
      }
    } finally {
      setWorking(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 640, maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          color: 'var(--text-primary)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '8px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
        }}>
          <span style={{ fontWeight: 600, flex: 1 }}>Tag consistency check</span>
          <button
            onClick={onClose}
            disabled={working}
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--text-muted)', cursor: 'pointer',
              fontSize: 18, padding: 0,
            }}
          >×</button>
        </div>

        <div style={{ padding: '10px 14px', overflowY: 'auto' }}>
          {clusters.length === 0 ? (
            <div style={{
              padding: '24px 8px', textAlign: 'center',
              color: 'var(--text-muted)', fontStyle: 'italic',
            }}>
              No near-duplicate tags found across {entries.length} file{entries.length === 1 ? '' : 's'}.
            </div>
          ) : (
            <>
              <div style={{
                fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)',
                marginBottom: 10,
              }}>
                Found {clusters.length} cluster{clusters.length === 1 ? '' : 's'} of
                near-duplicate tags. For each, pick the canonical spelling and
                click Apply to rename the variants across every sidecar in the folder.
              </div>
              {clusters.map((cluster, idx) => {
                const canon = canonicalFor(idx)
                return (
                  <div key={idx} style={{
                    border: '1px solid var(--border)',
                    borderRadius: 3,
                    padding: '8px 10px',
                    marginBottom: 8,
                  }}>
                    <div style={{ marginBottom: 6, fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                      Variants ({cluster.length}):
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {cluster.map((occ) => {
                        const isCanon = occ.tag === canon
                        return (
                          <label key={occ.tag} style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            cursor: 'pointer',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 'var(--font-size-base)',
                          }}>
                            <input
                              type="radio"
                              name={`canon-${idx}`}
                              checked={isCanon}
                              onChange={() => setPicked((p) => ({ ...p, [idx]: occ.tag }))}
                            />
                            <span style={{ flex: 1, fontWeight: isCanon ? 600 : 400 }}>{occ.tag}</span>
                            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
                              {occ.count}× · {occ.scope}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                    <div style={{
                      marginTop: 8, display: 'flex', justifyContent: 'flex-end',
                    }}>
                      <button
                        className="btn"
                        onClick={() => applyCluster(idx)}
                        disabled={working || cluster.every((c) => c.tag === canon)}
                        style={{
                          padding: '3px 10px', fontSize: 'var(--font-size-xs)',
                          background: 'var(--accent, #3b82f6)', color: '#fff',
                          border: 'none',
                        }}
                      >Rename variants → "{canon}"</button>
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>

        <div style={{
          padding: '8px 14px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button
            className="btn"
            onClick={onClose}
            disabled={working}
            style={{ padding: '3px 14px', fontSize: 'var(--font-size-base)' }}
          >Done</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <label style={{
        fontWeight: 600,
        color: 'var(--text-primary)',
        fontSize: 'var(--font-size-base)',
      }}>{label}</label>
      {hint && (
        <span style={{
          fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)',
          marginBottom: 2,
        }}>{hint}</span>
      )}
      {children}
    </div>
  )
}
