import React, { useEffect, useState } from 'react'
import { currentViewRef, useTraceExportStore } from '../../stores/traceExportStore'

interface Props {
  backendUrl: string
  /** Pixel position (relative to viewport) where the menu should anchor. */
  x: number
  y: number
  onClose: () => void
  onOpenExport: () => void
}

/**
 * Right-click menu over the preview. Quick "copy to clipboard" actions
 * for paste-into-Illustrator (SVG) and paste-into-Slack-or-doc (PNG)
 * workflows, plus shortcuts to the existing Fit and Export dialogs.
 *
 * Both copy actions hit the same /api/trace_export/render endpoint as
 * the Export modal, with the live view snapshot wired in so the
 * clipboard image matches what's on screen.
 */
export function PreviewContextMenu({ backendUrl, x, y, onClose, onOpenExport }: Props) {
  const [busy, setBusy] = useState<'svg' | 'png' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Close on outside click / Esc.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('[data-preview-context-menu]')) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function buildPayload(fmt: 'svg' | 'png') {
    const s = useTraceExportStore.getState()
    const viewRanges = currentViewRef.ranges
    const axesWithLiveView = s.axes.map((a) => {
      const v = viewRanges[a.id]
      if (!v) return a
      return { ...a, auto_limits: false, min: v.min, max: v.max }
    })
    const xView = viewRanges['x']
    return {
      items: s.items.map((i) => ({
        id: i.id, file_path: i.file_path,
        group: i.group, series: i.series, trace: i.trace,
        sweeps: i.sweeps,
        show_individuals: i.show_individuals,
        show_mean: i.show_mean,
        style: i.style,
        x_offset: i.x_offset, y_offset: i.y_offset,
        x_range: i.x_range,
        axis_id: i.axis_id,
        display_name: i.display_name,
      })),
      series_cfgs: s.seriesCfgs,
      axes: axesWithLiveView,
      scalebar: s.scalebar,
      legend: s.legend,
      axis_style: s.axisStyle,
      panel_layout: s.panelLayout,
      width_cm: s.width_cm, height_cm: s.height_cm,
      dpi: s.dpi,
      format: fmt,
      figure_x_range: xView ? [xView.min, xView.max] : null,
    }
  }

  async function copySvg() {
    setBusy('svg'); setError(null); setSuccess(null)
    try {
      const resp = await fetch(`${backendUrl}/api/trace_export/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload('svg')),
      })
      if (!resp.ok) throw new Error(`Render failed: ${resp.status}`)
      const svg = await resp.text()
      // Try the structured-clipboard path first (Illustrator on macOS
      // and Inkscape on Linux both honor image/svg+xml). Fall back to
      // plain-text writeText for apps that only accept text — paste
      // into Illustrator usually works either way.
      let copied = false
      try {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
          const blob = new Blob([svg], { type: 'image/svg+xml' })
          await navigator.clipboard.write([
            new ClipboardItem({
              'image/svg+xml': blob,
              'text/plain': new Blob([svg], { type: 'text/plain' }),
            }),
          ])
          copied = true
        }
      } catch {
        // ClipboardItem path failed (browser support, MIME rejection,
        // etc.) — fall through to writeText.
      }
      if (!copied) await navigator.clipboard.writeText(svg)
      setSuccess('SVG copied — paste in Illustrator')
      setTimeout(onClose, 800)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function copyPng() {
    setBusy('png'); setError(null); setSuccess(null)
    try {
      const resp = await fetch(`${backendUrl}/api/trace_export/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload('png')),
      })
      if (!resp.ok) throw new Error(`Render failed: ${resp.status}`)
      const buf = await resp.arrayBuffer()
      const blob = new Blob([buf], { type: 'image/png' })
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        throw new Error('Image clipboard not available in this build.')
      }
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ])
      setSuccess('PNG copied to clipboard')
      setTimeout(onClose, 800)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  // Clamp the menu inside the viewport so it doesn't render off-screen.
  const W = 220
  const H = 200
  const left = Math.min(x, window.innerWidth - W - 4)
  const top = Math.min(y, window.innerHeight - H - 4)

  return (
    <div
      data-preview-context-menu
      style={{
        position: 'fixed', left, top, zIndex: 200,
        minWidth: W,
        background: 'var(--bg-primary)',
        border: '1px solid var(--border)',
        borderRadius: 4,
        boxShadow: '0 6px 20px rgba(0,0,0,0.22)',
        fontSize: 'var(--font-size-sm)',
        fontFamily: 'var(--font-ui)',
        overflow: 'hidden',
      }}
    >
      <MenuItem
        label="Copy SVG"
        hint="paste into Illustrator / Inkscape"
        busy={busy === 'svg'}
        onClick={copySvg}
      />
      <MenuItem
        label="Copy PNG"
        hint="paste into Slack / Doc / etc."
        busy={busy === 'png'}
        onClick={copyPng}
      />
      <Divider />
      <MenuItem
        label="Export…"
        hint="open the full export dialog"
        onClick={() => { onOpenExport(); onClose() }}
      />
      <MenuItem
        label="Reset zoom"
        hint="press R anytime"
        onClick={() => {
          window.dispatchEvent(new CustomEvent('trace-export-fit'))
          onClose()
        }}
      />
      {(error || success) && (
        <div style={{
          padding: '4px 8px',
          fontSize: 11,
          background: error ? 'rgba(200,80,80,0.18)' : 'rgba(80,180,120,0.18)',
          color: error ? 'var(--text-primary)' : 'var(--text-primary)',
          borderTop: '1px solid var(--border)',
        }}>
          {error ?? success}
        </div>
      )}
    </div>
  )
}

function MenuItem({ label, hint, onClick, busy }: {
  label: string; hint?: string; onClick: () => void; busy?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '6px 10px',
        background: 'transparent',
        border: 'none',
        color: 'var(--text-primary)',
        cursor: busy ? 'wait' : 'pointer',
        fontSize: 'var(--font-size-sm)',
        fontFamily: 'var(--font-ui)',
      }}
      onMouseEnter={(e) => { if (!busy) (e.currentTarget.style.background = 'var(--bg-active)') }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 500 }}>{busy ? `${label}…` : label}</span>
        {hint && (
          <span style={{ color: 'var(--text-muted)', fontSize: 11, marginLeft: 'auto' }}>{hint}</span>
        )}
      </div>
    </button>
  )
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)' }} />
}
