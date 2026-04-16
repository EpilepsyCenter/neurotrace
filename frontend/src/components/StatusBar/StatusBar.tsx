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
            {traceData.samplingRate.toLocaleString()} Hz | {traceData.values.length.toLocaleString()} samples
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
