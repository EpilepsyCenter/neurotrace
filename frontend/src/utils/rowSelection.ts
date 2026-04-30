/**
 * Multi-row selection + TSV-copy machinery shared across every result
 * table in the app (events / AP / IV / FPsp / bursts / cursor /
 * resistance). The hook owns selection state; the row click handlers
 * implement the standard click / shift-click / cmd-or-ctrl-click
 * semantics. TSV copy is a separate helper so each table can plug
 * in its own column extractor without coupling the hook to a
 * particular row shape.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface RowSelectionApi {
  /** Indexes currently selected, sorted ascending. */
  selectedIndexes: number[]
  /** Quick predicate for row-level styling. */
  isSelected: (i: number) => boolean
  /** Handle a row click event. Branches on shift / meta keys for the
   *  usual range / toggle semantics. Plain click selects exactly one
   *  row + sets the anchor for future shift-clicks. */
  onRowClick: (i: number, ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void
  /** Drop the current selection. Called by table components when
   *  the underlying row list changes shape (analysis re-run, filter
   *  toggle, etc.) so we don't keep stale indexes selected. */
  clear: () => void
  /** Force a single-row selection programmatically — e.g. when the
   *  user right-clicks a row that wasn't already selected, we promote
   *  it to a single-row selection so the context menu's "Copy" acts
   *  on what they're pointing at. */
  setSelected: (indexes: number[]) => void
}

export function useRowSelection(rowCount: number): RowSelectionApi {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const anchorRef = useRef<number | null>(null)

  // Drop indexes that fell off the end of the row list. Avoids stale
  // pointers carrying across analysis re-runs.
  useEffect(() => {
    setSelected((prev) => {
      let dirty = false
      const next = new Set<number>()
      for (const i of prev) {
        if (i < rowCount) next.add(i)
        else dirty = true
      }
      return dirty ? next : prev
    })
  }, [rowCount])

  const onRowClick = useCallback((i: number, ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (ev.shiftKey && anchorRef.current != null) {
      const lo = Math.min(anchorRef.current, i)
      const hi = Math.max(anchorRef.current, i)
      const next = new Set<number>()
      for (let k = lo; k <= hi; k++) next.add(k)
      setSelected(next)
      return
    }
    if (ev.metaKey || ev.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(i)) next.delete(i)
        else next.add(i)
        return next
      })
      anchorRef.current = i
      return
    }
    setSelected(new Set([i]))
    anchorRef.current = i
  }, [])

  const isSelected = useCallback((i: number) => selected.has(i), [selected])
  const selectedIndexes = useMemo(() => {
    const arr = Array.from(selected)
    arr.sort((a, b) => a - b)
    return arr
  }, [selected])
  const clear = useCallback(() => {
    setSelected(new Set())
    anchorRef.current = null
  }, [])
  const setSelectedImperative = useCallback((indexes: number[]) => {
    setSelected(new Set(indexes))
    anchorRef.current = indexes[indexes.length - 1] ?? null
  }, [])

  return {
    selectedIndexes,
    isSelected,
    onRowClick,
    clear,
    setSelected: setSelectedImperative,
  }
}

/** Build a tab-separated-values string from a header row + per-row
 *  cell arrays. Each cell is coerced to string; ``null`` /
 *  ``undefined`` render as the empty string. Cells that contain
 *  tabs / newlines / quotes are wrapped in quotes the way standard
 *  TSV-paste-into-Excel expects. */
export function buildTSV(header: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const escape = (cell: string | number | null | undefined): string => {
    if (cell == null) return ''
    const s = typeof cell === 'string' ? cell : String(cell)
    if (s.includes('\t') || s.includes('\n') || s.includes('"')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  const lines: string[] = []
  if (header.length > 0) lines.push(header.map(escape).join('\t'))
  for (const row of rows) lines.push(row.map(escape).join('\t'))
  return lines.join('\n')
}

/** Copy a string to the clipboard. Falls back to the legacy execCommand
 *  path when navigator.clipboard isn't available (older Electron
 *  contexts). Returns true on success so callers can flash a toast. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
