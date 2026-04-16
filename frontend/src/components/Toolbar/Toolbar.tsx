import React, { useEffect, useState, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useThemeStore, FONT_FAMILIES, MONO_FONTS, FONT_SIZES } from '../../stores/themeStore'

const ANALYSIS_TYPES = [
  { type: 'resistance', label: 'Rs / Rin / Cm' },
  { type: 'iv', label: 'I-V Curve' },
  { type: 'events', label: 'Event Detection' },
  { type: 'bursts', label: 'Burst Detection' },
  { type: 'kinetics', label: 'Kinetics & Fitting' },
  { type: 'field_potential', label: 'Field Potential' },
  { type: 'spectral', label: 'Spectral Analysis' },
]

export function Toolbar() {
  const {
    recording, openFile, loading,
    currentSweep, currentSeries, currentGroup, currentTrace,
    selectSweep,
    showOverlay, toggleOverlay, overlayAllSweeps, clearOverlays,
    showAverage, toggleAverage, loadAverageTrace,
    zoomMode, toggleZoomMode,
  } = useAppStore()

  const {
    theme, setTheme,
    fontFamily, setFontFamily,
    monoFont, setMonoFont,
    fontSize, setFontSize,
  } = useThemeStore()

  const [showSettings, setShowSettings] = useState(false)
  const [showAnalyses, setShowAnalyses] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  const analysesRef = useRef<HTMLDivElement>(null)

  const totalSweeps = recording?.groups[currentGroup]?.series[currentSeries]?.sweepCount ?? 0

  // Close popovers on outside click
  useEffect(() => {
    if (!showSettings && !showAnalyses) return
    const onClick = (e: MouseEvent) => {
      if (showSettings && settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false)
      }
      if (showAnalyses && analysesRef.current && !analysesRef.current.contains(e.target as Node)) {
        setShowAnalyses(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showSettings, showAnalyses])

  const handleOpenFile = async () => {
    let filePath: string | null = null
    if (window.electronAPI) {
      filePath = await window.electronAPI.openFileDialog()
    } else {
      filePath = prompt('Enter file path:')
    }
    if (filePath) await openFile(filePath)
  }

  const handlePrevSweep = () => {
    if (currentSweep > 0) selectSweep(currentGroup, currentSeries, currentSweep - 1, currentTrace)
  }

  const handleNextSweep = () => {
    if (currentSweep < totalSweeps - 1) selectSweep(currentGroup, currentSeries, currentSweep + 1, currentTrace)
  }

  const handleOverlayAll = async () => {
    if (showOverlay) clearOverlays()
    else await overlayAllSweeps()
  }

  const handleAverage = async () => {
    if (showAverage) toggleAverage()
    else await loadAverageTrace()
  }

  const handleOpenAnalysis = async (type: string) => {
    setShowAnalyses(false)
    if (window.electronAPI?.openAnalysisWindow) {
      await window.electronAPI.openAnalysisWindow(type)
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (!recording) return

      switch (e.key) {
        case 'ArrowLeft': case ',':
          e.preventDefault(); handlePrevSweep(); break
        case 'ArrowRight': case '.':
          e.preventDefault(); handleNextSweep(); break
        case 'Home':
          e.preventDefault(); selectSweep(currentGroup, currentSeries, 0, currentTrace); break
        case 'End':
          e.preventDefault(); selectSweep(currentGroup, currentSeries, totalSweeps - 1, currentTrace); break
        case 'o':
          if (!e.ctrlKey && !e.metaKey) handleOverlayAll(); break
        case 'a':
          if (!e.ctrlKey && !e.metaKey) handleAverage(); break
        case 'z':
          if (!e.ctrlKey && !e.metaKey) toggleZoomMode(); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button className="btn" onClick={handleOpenFile} disabled={loading}>Open File</button>
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group">
        <span className="toolbar-label">Sweep:</span>
        <button className="btn" onClick={handlePrevSweep} disabled={!recording || currentSweep === 0} title="Previous (Left)">&larr;</button>
        <span style={{ minWidth: 60, textAlign: 'center', fontSize: 'var(--font-size-sm)' }}>
          {recording ? `${currentSweep + 1} / ${totalSweeps}` : '-- / --'}
        </span>
        <button className="btn" onClick={handleNextSweep} disabled={!recording || currentSweep >= totalSweeps - 1} title="Next (Right)">&rarr;</button>
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group">
        <button className={`btn ${showOverlay ? 'btn-primary' : ''}`} onClick={handleOverlayAll} disabled={!recording || loading} title="Overlay all sweeps (O)">Overlay</button>
        <button className={`btn ${showAverage ? 'btn-primary' : ''}`} onClick={handleAverage} disabled={!recording || loading} title="Show average (A)">Average</button>
        <button className={`btn ${zoomMode ? 'btn-primary' : ''}`} onClick={toggleZoomMode} title="Drag-to-zoom mode (Z)">Zoom</button>
      </div>

      <div className="toolbar-separator" />

      {/* Analyses dropdown */}
      <div style={{ position: 'relative' }} ref={analysesRef}>
        <button
          className="btn"
          onClick={() => setShowAnalyses(!showAnalyses)}
          disabled={!recording}
          title="Open an analysis window"
        >
          Analyses {'\u25BE'}
        </button>

        {showAnalyses && (
          <div className="settings-popover" style={{ left: 0, right: 'auto', width: 200 }}>
            {ANALYSIS_TYPES.map((a) => (
              <button
                key={a.type}
                onClick={() => handleOpenAnalysis(a.type)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '6px 10px',
                  background: 'none',
                  border: 'none',
                  textAlign: 'left',
                  color: 'var(--text-primary)',
                  fontSize: 'var(--font-size-sm)',
                  fontFamily: 'var(--font-ui)',
                  cursor: 'pointer',
                  borderRadius: 4,
                }}
                className="analysis-menu-item"
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="toolbar-separator" />

      <div className="toolbar-group">
        <span className="toolbar-label">{recording ? recording.fileName : 'No file loaded'}</span>
      </div>

      {loading && (
        <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: 'var(--font-size-sm)' }}>Loading...</span>
      )}

      {/* Settings gear */}
      <div style={{ marginLeft: 'auto', position: 'relative' }} ref={settingsRef}>
        <button
          className="btn"
          onClick={() => setShowSettings(!showSettings)}
          title="Settings"
          style={{ fontSize: 15, padding: '3px 8px', lineHeight: 1 }}
        >
          {'\u2699'}
        </button>

        {showSettings && (
          <div className="settings-popover">
            <div className="settings-section">
              <div className="settings-label">Theme</div>
              <div className="theme-toggle">
                <button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>{'\u2600'} Light</button>
                <button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>{'\u263E'} Dark</button>
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-label">UI Font</div>
              <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)} style={{ width: '100%' }}>
                {FONT_FAMILIES.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            <div className="settings-section">
              <div className="settings-label">Code Font</div>
              <select value={monoFont} onChange={(e) => setMonoFont(e.target.value)} style={{ width: '100%' }}>
                {MONO_FONTS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            <div className="settings-section">
              <div className="settings-label">Font Size</div>
              <div className="font-size-row">
                {FONT_SIZES.map((sz) => (
                  <button key={sz} className={fontSize === sz ? 'active' : ''} onClick={() => setFontSize(sz)} style={{ fontSize: sz - 1 }}>{sz}</button>
                ))}
              </div>
            </div>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4, fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
              <div style={{ fontFamily: 'var(--font-ui)', marginBottom: 2 }}>UI preview: The quick brown fox</div>
              <div style={{ fontFamily: 'var(--font-mono)' }}>Code: fn(x) =&gt; x * 2</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
