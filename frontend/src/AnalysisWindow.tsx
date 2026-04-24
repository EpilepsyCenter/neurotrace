import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useThemeStore } from './stores/themeStore'
import { CursorPositions, useAppStore } from './stores/appStore'
import { ResistanceWindow } from './components/AnalysisWindows/ResistanceWindow'
import { FieldBurstWindow } from './components/AnalysisWindows/FieldBurstWindow'
import { IVCurveWindow } from './components/AnalysisWindows/IVCurveWindow'
import { FPspWindow } from './components/AnalysisWindows/FPspWindow'
import { CursorAnalysisWindow } from './components/AnalysisWindows/CursorAnalysisWindow'
import { APWindow } from './components/AnalysisWindows/APWindow'
import { EventDetectionWindow } from './components/AnalysisWindows/EventDetectionWindow'
import { EventsTemplateGeneratorWindow } from './components/AnalysisWindows/EventsTemplateGeneratorWindow'
import { EventsTemplateRefinementWindow } from './components/AnalysisWindows/EventsTemplateRefinementWindow'

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
  // Current tree selection mirrored from the main window, so analysis
  // windows can preselect the right group/series/trace without the user
  // having to pick it again.
  const [mainGroup, setMainGroup] = useState<number | null>(null)
  const [mainSeries, setMainSeries] = useState<number | null>(null)
  const [mainTrace, setMainTrace] = useState<number | null>(null)
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
      // The analysis window runs in a separate Electron BrowserWindow with
      // its own Zustand store instance. Inject the backend URL into that
      // store so any store actions the analysis components call (e.g. the
      // burst-detection actions on `useAppStore`) build absolute URLs — if
      // we skip this the relative "/api/..." path falls back to the Vite
      // dev-server origin and you get a 404 "Not Found".
      useAppStore.setState({ backendUrl: url, backendReady: true })

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
        if (ev.data?.type === 'selection-update') {
          if (ev.data.group != null) setMainGroup(ev.data.group)
          if (ev.data.series != null) setMainSeries(ev.data.series)
          if (ev.data.trace != null) setMainTrace(ev.data.trace)
        }
        if (ev.data?.type === 'state-update') {
          if (ev.data.cursors) setCursors(ev.data.cursors)
          if (ev.data.sweep != null) setCurrentSweep(ev.data.sweep)
          if (ev.data.group != null) setMainGroup(ev.data.group)
          if (ev.data.series != null) setMainSeries(ev.data.series)
          if (ev.data.trace != null) setMainTrace(ev.data.trace)
          if (ev.data.fieldBursts) {
            useAppStore.setState({ fieldBursts: ev.data.fieldBursts })
          }
          if (ev.data.burstFormParams) {
            useAppStore.setState({ burstFormParams: ev.data.burstFormParams })
          }
          if (ev.data.ivCurves) {
            useAppStore.setState({ ivCurves: ev.data.ivCurves })
          }
          if (ev.data.fpspCurves) {
            useAppStore.setState({ fpspCurves: ev.data.fpspCurves })
          }
          if (ev.data.cursorAnalyses) {
            useAppStore.setState({ cursorAnalyses: ev.data.cursorAnalyses })
          }
          if (ev.data.apAnalyses) {
            useAppStore.setState({ apAnalyses: ev.data.apAnalyses })
          }
          if (ev.data.eventsAnalyses) {
            useAppStore.setState({ eventsAnalyses: ev.data.eventsAnalyses })
          }
          if (ev.data.eventsTemplates) {
            useAppStore.setState({ eventsTemplates: ev.data.eventsTemplates })
          }
          if (ev.data.excludedSweeps) {
            useAppStore.setState({ excludedSweeps: ev.data.excludedSweeps })
          }
          if (ev.data.averagedSweeps) {
            useAppStore.setState({ averagedSweeps: ev.data.averagedSweeps })
          }
        }
        if (ev.data?.type === 'iv-update' && ev.data.ivCurves) {
          useAppStore.setState({ ivCurves: ev.data.ivCurves })
        }
        if (ev.data?.type === 'fpsp-update' && ev.data.fpspCurves) {
          useAppStore.setState({ fpspCurves: ev.data.fpspCurves })
        }
        if (ev.data?.type === 'cursor-analyses-update' && ev.data.cursorAnalyses) {
          useAppStore.setState({ cursorAnalyses: ev.data.cursorAnalyses })
        }
        if (ev.data?.type === 'ap-update' && ev.data.apAnalyses) {
          useAppStore.setState({ apAnalyses: ev.data.apAnalyses })
        }
        // Event-detection cross-window sync: sub-windows (template
        // generator, refine) save/select/delete templates into their
        // own store instance; the parent main events window listens
        // for these to keep its Template library dropdown in lockstep.
        if (ev.data?.type === 'events-templates-update' && ev.data.eventsTemplates) {
          useAppStore.setState({ eventsTemplates: ev.data.eventsTemplates })
        }
        if (ev.data?.type === 'events-update' && ev.data.eventsAnalyses) {
          useAppStore.setState({ eventsAnalyses: ev.data.eventsAnalyses })
        }
        if (ev.data?.type === 'excluded-update' && ev.data.excludedSweeps) {
          useAppStore.setState({ excludedSweeps: ev.data.excludedSweeps })
        }
        if (ev.data?.type === 'averaged-update' && ev.data.averagedSweeps) {
          useAppStore.setState({ averagedSweeps: ev.data.averagedSweeps })
        }
        // Burst-detection form-state broadcast from another window (e.g.
        // the main window pushing freshly-loaded prefs on file open).
        if (ev.data?.type === 'burst-form-params-update' && ev.data.burstFormParams) {
          useAppStore.setState({ burstFormParams: ev.data.burstFormParams })
        }
      }

      // Request current state
      ch.postMessage({ type: 'state-request' })

      return () => ch.close()
    } catch { /* BroadcastChannel not available */ }
  }, [])

  const TITLES: Record<string, string> = {
    cursors: 'Cursor Measurements',
    resistance: 'Rs / Rin / Cm',
    iv: 'I-V Curve',
    action_potential: 'Action Potentials',
    events: 'Event Detection',
    events_template_generator: 'Events — Template Generator',
    events_template_refinement: 'Events — Refine Template',
    bursts: 'Burst Detection',
    kinetics: 'Kinetics & Fitting',
    field_potential: 'Field PSP',
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
        ) : view === 'bursts' ? (
          <FieldBurstWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            currentSweep={currentSweep}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
          />
        ) : view === 'iv' ? (
          <IVCurveWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            currentSweep={currentSweep}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
            cursors={cursors}
          />
        ) : view === 'field_potential' ? (
          <FPspWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
            cursors={cursors}
          />
        ) : view === 'cursors' ? (
          <CursorAnalysisWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
            cursors={cursors}
          />
        ) : view === 'action_potential' ? (
          <APWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
          />
        ) : view === 'events' ? (
          <EventDetectionWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
            cursors={cursors}
          />
        ) : view === 'events_template_generator' ? (
          <EventsTemplateGeneratorWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
            mainGroup={mainGroup}
            mainSeries={mainSeries}
            mainTrace={mainTrace}
            cursors={cursors}
          />
        ) : view === 'events_template_refinement' ? (
          <EventsTemplateRefinementWindow
            backendUrl={backendUrl}
            fileInfo={fileInfo}
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
