import React from 'react'
import { useAppStore } from '../../stores/appStore'

/**
 * App footer status bar — every discrete status item is wrapped in a
 * ``<span className="led">`` pill so the Telegraph stylesheet can
 * render them as a strip of indicator lamps:
 *
 *   - ``led ok``   — acquisition happy (backend up, Electron host)
 *   - ``led err``  — fault (backend down, surfaced error, browser
 *                   fallback host)
 *   - ``led off``  — slot is dim / not yet wired (backend still
 *                   starting up)
 *   - bare ``led`` — neutral info readout (recording format, sample
 *                   count, app version) — pill chrome with no glow.
 *
 * Colour / glow live entirely in CSS (see ``telegraph.css``), so
 * component code carries semantics only, not presentation.
 */
export function StatusBar() {
  const { backendReady, recording, traceData, error } = useAppStore()
  // Backend states: connected → ok, connecting → off. If we ever add
  // an explicit error state beyond the generic `error` field, it can
  // flip this to `err`.
  const backendClass = backendReady ? 'led ok' : 'led off'
  const hostClass = window.electronAPI ? 'led ok' : 'led err'

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className={backendClass}>
          {backendReady ? 'Backend connected' : 'Connecting…'}
        </span>
        {recording && (
          <span className="led">
            {recording.format} · {recording.groupCount} group{recording.groupCount === 1 ? '' : 's'}
          </span>
        )}
        {traceData && (
          <span className="led">
            {/* en-US locale for the thousands separator keeps the output
                consistent on European systems where toLocaleString()
                would otherwise render "20.000 Hz" (dot as thousands
                separator), which reads as a decimal. */}
            {traceData.samplingRate.toLocaleString('en-US')} Hz ·{' '}
            {traceData.values.length.toLocaleString('en-US')} samples
          </span>
        )}
      </div>
      <div className="status-bar-right">
        {error && <span className="led err">{error}</span>}
        <span className={hostClass}>
          {window.electronAPI ? 'Electron' : 'Browser'}
        </span>
        <span className="led">NeuroTrace v0.1.0</span>
      </div>
    </div>
  )
}
