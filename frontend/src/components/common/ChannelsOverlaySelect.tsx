import React, { useEffect, useRef, useState } from 'react'

/**
 * Multi-select channels dropdown for the analysis windows.
 *
 * Differs from the main viewer's TracesDropdown in two ways:
 *   - The **primary** channel (the analysis target) is always shown
 *     and can't be hidden — it's the top subplot in the stacked
 *     mini-viewer and the only one cursor bands are drawn on. Other
 *     channels act purely as display overlays beneath it.
 *   - State is local (per-window), passed in/out as `overlay` array.
 *     The primary channel number is controlled by its usual "Channel"
 *     state and is selected via the first row's highlight + radio.
 *
 * A synthetic "stimulus" row is offered when `hasStimulus` is true —
 * checking it overlays the reconstructed stimulus protocol waveform.
 *
 * Button label summarises: "Channel: Vm +1 overlay" style, so the
 * user can tell at a glance how many extras are wired in.
 */

export interface ChannelOption {
  index: number
  label: string
  units: string
}

export const STIMULUS_OVERLAY_KEY = -9999

export function ChannelsOverlaySelect({
  channels,
  primary,
  onPrimaryChange,
  overlay,
  onOverlayChange,
  hasStimulus,
}: {
  channels: ChannelOption[]
  /** Index of the analysis-target channel (top subplot). Always
   *  visible, cursor bands are drawn on this one. */
  primary: number
  onPrimaryChange: (index: number) => void
  /** Extra channels to display as stacked subplots below the primary.
   *  Entries are channel indices, or `STIMULUS_OVERLAY_KEY` for the
   *  reconstructed stimulus protocol. Order matters — the array order
   *  is the vertical stacking order from top to bottom. */
  overlay: number[]
  onOverlayChange: (next: number[]) => void
  hasStimulus: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const primaryChan = channels.find((c) => c.index === primary)
  const primaryLabel = primaryChan ? primaryChan.label : '—'

  const overlaySet = new Set(overlay)
  const toggle = (idx: number) => {
    if (idx === primary) return  // primary is locked-on
    onOverlayChange(
      overlaySet.has(idx)
        ? overlay.filter((o) => o !== idx)
        : [...overlay, idx],
    )
  }

  const overlayCount = overlay.length
  const buttonText = overlayCount === 0
    ? primaryLabel
    : `${primaryLabel} +${overlayCount}`

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column' }}>
      <span style={{ color: 'var(--text-muted)', marginBottom: 2, fontSize: 'var(--font-size-label)' }}>
        Channel
      </span>
      <button
        className="btn"
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: '3px 10px',
          fontSize: 'var(--font-size-label)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 120,
        }}
        title="Pick the analysis target (primary) and any extra channels to overlay as stacked subplots below."
      >
        <span style={{ flex: 1, textAlign: 'left' }}>{buttonText}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            minWidth: 240,
            background: 'var(--bg-surface, var(--bg-primary))',
            border: '1px solid var(--border)',
            borderRadius: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            zIndex: 100,
            padding: 4,
          }}
        >
          <div style={{
            padding: '3px 6px', fontSize: 'var(--font-size-label)',
            color: 'var(--text-muted)',
          }}>
            Primary (analysis target):
          </div>
          {channels.map((c) => (
            <label
              key={`p-${c.index}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '3px 6px', cursor: 'pointer', userSelect: 'none',
                borderRadius: 3,
                background: c.index === primary ? 'var(--bg-secondary)' : 'transparent',
              }}
            >
              <input
                type="radio"
                name="overlay-primary"
                checked={c.index === primary}
                onChange={() => onPrimaryChange(c.index)}
                style={{ margin: 0 }}
              />
              <span style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>{c.label}</span>
              <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
                {c.units}
              </span>
            </label>
          ))}
          {(channels.length > 1 || hasStimulus) && (
            <>
              <div style={{
                padding: '6px 6px 3px',
                fontSize: 'var(--font-size-label)',
                color: 'var(--text-muted)',
                borderTop: '1px solid var(--border)',
                marginTop: 4,
              }}>
                Overlays (display only):
              </div>
              {channels.map((c) => {
                if (c.index === primary) return null
                return (
                  <label
                    key={`o-${c.index}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '3px 6px', cursor: 'pointer', userSelect: 'none',
                      borderRadius: 3,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={overlaySet.has(c.index)}
                      onChange={() => toggle(c.index)}
                      style={{ margin: 0 }}
                    />
                    <span style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>{c.label}</span>
                    <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--text-muted)' }}>
                      {c.units}
                    </span>
                  </label>
                )
              })}
              {hasStimulus && (
                <label
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '3px 6px', cursor: 'pointer', userSelect: 'none',
                    borderRadius: 3,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={overlaySet.has(STIMULUS_OVERLAY_KEY)}
                    onChange={() => toggle(STIMULUS_OVERLAY_KEY)}
                    style={{ margin: 0 }}
                  />
                  <span style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                    ⚙ Stimulus (from protocol)
                  </span>
                </label>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
