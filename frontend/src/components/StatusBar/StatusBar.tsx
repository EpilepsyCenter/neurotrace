import React from 'react'
import { useAppStore } from '../../stores/appStore'

export function StatusBar() {
  const { backendReady, recording, traceData, error } = useAppStore()

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span style={{ color: backendReady ? 'var(--success)' : 'var(--error)' }}>
          {backendReady ? 'Backend connected' : 'Connecting...'}
        </span>
        {recording && (
          <span>
            {recording.format} | {recording.groupCount} group(s)
          </span>
        )}
        {traceData && (
          <span>
            {/* en-US locale for the thousands separator keeps the output
                consistent on European systems where toLocaleString() would
                otherwise render "20.000 Hz" (dot as thousands separator),
                which reads as a decimal. */}
            {traceData.samplingRate.toLocaleString('en-US')} Hz | {traceData.values.length.toLocaleString('en-US')} samples
          </span>
        )}
      </div>
      <div className="status-bar-right">
        {error && <span style={{ color: 'var(--error)' }}>{error}</span>}
        <span style={{ color: window.electronAPI ? 'var(--success)' : 'var(--error)' }}>
          {window.electronAPI ? 'Electron' : 'Browser'}
        </span>
        <span>NeuroTrace v0.1.0</span>
      </div>
    </div>
  )
}
