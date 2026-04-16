import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useThemeStore } from './stores/themeStore'
import { CursorPositions } from './stores/appStore'
import { ResistanceWindow } from './components/AnalysisWindows/ResistanceWindow'

/**
 * Shell for all analysis windows. Runs in a separate Electron BrowserWindow.
 *
 * Responsibilities:
 * - Initialize theme
 * - Connect to the Python backend
 * - Listen for cursor updates from the main window via BroadcastChannel
 * - Route to the correct analysis component based on `view` prop
 */

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

export function AnalysisWindow({ view }: { view: string }) {
  const { initTheme } = useThemeStore()
  const [backendUrl, setBackendUrl] = useState('')
  const [backendReady, setBackendReady] = useState(false)
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null)
  const [cursors, setCursors] = useState<CursorPositions>({
    baselineStart: 0,
    baselineEnd: 0.01,
    peakStart: 0.01,
    peakEnd: 0.05,
    fitStart: 0.01,
    fitEnd: 0.1,
  })
  const [currentSweep, setCurrentSweep] = useState(0)
  const cursorsRef = useRef(cursors)
  cursorsRef.current = cursors

  // Initialize
  useEffect(() => {
    initTheme();
    (async () => {
      const url = window.electronAPI
        ? await window.electronAPI.getBackendUrl()
        : 'http://localhost:8321'
      setBackendUrl(url)

      // Wait for backend
      for (let i = 0; i < 60; i++) {
        try {
          const resp = await fetch(`${url}/health`)
          if (resp.ok) { setBackendReady(true); break }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 500))
      }
    })()
  }, [initTheme])

  // Poll file info
  const refreshFileInfo = useCallback(async () => {
    if (!backendUrl) return
    try {
      const resp = await fetch(`${backendUrl}/api/files/info`)
      if (resp.ok) {
        const data = await resp.json()
        setFileInfo(data)
      }
    } catch { /* ignore */ }
  }, [backendUrl])

  useEffect(() => {
    if (!backendReady) return
    refreshFileInfo()
    const id = setInterval(refreshFileInfo, 3000)
    return () => clearInterval(id)
  }, [backendReady, refreshFileInfo])

  // Listen for cursor + sweep updates from the main window
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('neurotrace-sync')

      ch.onmessage = (ev) => {
        if (ev.data?.type === 'cursor-update' && ev.data.cursors) {
          setCursors(ev.data.cursors)
        }
        if (ev.data?.type === 'sweep-update' && ev.data.sweep != null) {
          setCurrentSweep(ev.data.sweep)
        }
        if (ev.data?.type === 'state-update') {
          if (ev.data.cursors) setCursors(ev.data.cursors)
          if (ev.data.sweep != null) setCurrentSweep(ev.data.sweep)
        }
      }

      // Request current state
      ch.postMessage({ type: 'state-request' })

      return () => ch.close()
    } catch { /* BroadcastChannel not available */ }
  }, [])

  const TITLES: Record<string, string> = {
    resistance: 'Rs / Rin / Cm',
    iv: 'I-V Curve',
    events: 'Event Detection',
    bursts: 'Burst Detection',
    kinetics: 'Kinetics & Fitting',
    field_potential: 'Field Potential',
    spectral: 'Spectral Analysis',
  }

  const title = TITLES[view] || view

  if (!backendReady) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: 'var(--bg-primary)',
        color: 'var(--text-muted)',
      }}>
        Connecting to backend...
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 12px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
        fontSize: 'var(--font-size-sm)',
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span style={{ color: 'var(--text-muted)' }}>
          {fileInfo?.fileName || 'No file loaded'}
        </span>
      </div>

      {/* Analysis content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {view === 'resistance' ? (
          <ResistanceWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            cursors={cursors}
            currentSweep={currentSweep}
          />
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}>
            {title} — coming soon
          </div>
        )}
      </div>
    </div>
  )
}
