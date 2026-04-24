import React, { useEffect, useMemo, useState, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useThemeStore, FONT_FAMILIES, MONO_FONTS, FONT_SIZES, PaletteName } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import { TracesDropdown } from '../TraceViewer/TracesDropdown'

const ANALYSIS_TYPES = [
  { type: 'cursors', label: 'Cursor Measurements' },
  { type: 'resistance', label: 'Rs / Rin / Cm' },
  { type: 'iv', label: 'I-V Curve' },
  { type: 'action_potential', label: 'Action Potentials' },
  { type: 'events', label: 'Event Detection' },
  { type: 'bursts', label: 'Burst Detection' },
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
    selectedSweeps, includedSweepsFor, filterExcludedSweeps,
    createAveragedSweep,
  } = useAppStore()
  void toggleOverlay  // currently unused; reference retained to keep the prop picked

  const {
    theme, setTheme,
    palette, setPalette,
    fontFamily, setFontFamily,
    monoFont, setMonoFont,
    fontSize, setFontSize,
  } = useThemeStore()

  const [showSettings, setShowSettings] = useState(false)
  const [showAnalyses, setShowAnalyses] = useState(false)
  const [showAverageMenu, setShowAverageMenu] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  const analysesRef = useRef<HTMLDivElement>(null)
  const averageRef = useRef<HTMLDivElement>(null)

  // State for the Average popover.
  const selectedList = selectedSweeps[`${currentGroup}:${currentSeries}`] ?? []
  const [avgMode, setAvgMode] = useState<'all' | 'selected' | 'range'>('all')
  const [avgFrom, setAvgFrom] = useState(1)
  const [avgTo, setAvgTo] = useState(1)
  const [avgLabel, setAvgLabel] = useState('')

  const totalSweeps = recording?.groups[currentGroup]?.series[currentSeries]?.sweepCount ?? 0

  // Close popovers on outside click
  useEffect(() => {
    if (!showSettings && !showAnalyses && !showAverageMenu) return
    const onClick = (e: MouseEvent) => {
      if (showSettings && settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false)
      }
      if (showAnalyses && analysesRef.current && !analysesRef.current.contains(e.target as Node)) {
        setShowAnalyses(false)
      }
      if (showAverageMenu && averageRef.current && !averageRef.current.contains(e.target as Node)) {
        setShowAverageMenu(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [showSettings, showAnalyses, showAverageMenu])

  // Reset popover defaults every time it opens.
  useEffect(() => {
    if (!showAverageMenu) return
    setAvgFrom(1)
    setAvgTo(Math.max(1, totalSweeps))
    setAvgMode(selectedList.length >= 2 ? 'selected' : 'all')
    setAvgLabel('')
  }, [showAverageMenu, totalSweeps, selectedList.length])

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

  // handleAverage was the old show/hide toggle for the overlay-style
  // average. Superseded by the popover below that creates a permanent
  // averaged sweep in the tree. Retained for legacy callers; silence
  // the unused warnings.
  void showAverage; void toggleAverage; void loadAverageTrace

  // Chosen sweep indices for the Average popover, based on the mode.
  // Always filters out excluded sweeps.
  const chosenSweeps = useMemo<number[]>(() => {
    if (!recording) return []
    if (avgMode === 'all') {
      return includedSweepsFor(currentGroup, currentSeries, totalSweeps)
    }
    if (avgMode === 'selected') {
      return filterExcludedSweeps(currentGroup, currentSeries, selectedList)
    }
    // range
    const lo = Math.max(1, Math.min(avgFrom, totalSweeps))
    const hi = Math.max(lo, Math.min(avgTo, totalSweeps))
    const raw: number[] = []
    for (let i = lo - 1; i <= hi - 1; i++) raw.push(i)
    return filterExcludedSweeps(currentGroup, currentSeries, raw)
  }, [avgMode, avgFrom, avgTo, currentGroup, currentSeries, totalSweeps, selectedList, recording, includedSweepsFor, filterExcludedSweeps])

  const defaultLabel = useMemo(() => {
    if (avgMode === 'all') return `Avg all (${chosenSweeps.length})`
    if (avgMode === 'selected') return `Avg sel (${chosenSweeps.length})`
    const lo = Math.max(1, Math.min(avgFrom, totalSweeps))
    const hi = Math.max(lo, Math.min(avgTo, totalSweeps))
    return `Avg ${lo}–${hi}`
  }, [avgMode, avgFrom, avgTo, chosenSweeps.length, totalSweeps])

  const handleCreateAverage = async () => {
    if (!recording || chosenSweeps.length === 0) return
    const label = avgLabel.trim() || defaultLabel
    await createAveragedSweep(currentGroup, currentSeries, currentTrace, chosenSweeps, label)
    setShowAverageMenu(false)
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
          if (!e.ctrlKey && !e.metaKey) setShowAverageMenu((v) => !v); break
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
        {/* Traces dropdown — front-and-centre so users discover the
            stimulus-overlay and multi-channel visibility controls
            without hunting. */}
        <TracesDropdown />

        <button className={`btn ${showOverlay ? 'btn-primary' : ''}`} onClick={handleOverlayAll} disabled={!recording || loading} title="Overlay all sweeps (O)">Overlay</button>

        {/* Average: click shows a popover to pick the sweeps to average.
            Result is written into the tree as a virtual sweep and
            navigated to immediately. */}
        <div style={{ position: 'relative' }} ref={averageRef}>
          <button
            className={`btn ${showAverageMenu ? 'btn-primary' : ''}`}
            onClick={() => setShowAverageMenu((v) => !v)}
            disabled={!recording || loading}
            title="Create an averaged trace from all / selected / range of sweeps (A)"
          >
            Average {'\u25BE'}
          </button>

          {showAverageMenu && (
            <div className="settings-popover" style={{ left: 0, right: 'auto', width: 280, padding: 10 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
                Create averaged sweep from:
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 'var(--font-size-sm)' }}>
                <input
                  type="radio" name="avg-mode"
                  checked={avgMode === 'all'} onChange={() => setAvgMode('all')}
                />
                All sweeps
                <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
                  ({includedSweepsFor(currentGroup, currentSeries, totalSweeps).length})
                </span>
              </label>
              <label style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0',
                fontSize: 'var(--font-size-sm)',
                opacity: selectedList.length < 2 ? 0.55 : 1,
              }}>
                <input
                  type="radio" name="avg-mode"
                  disabled={selectedList.length < 2}
                  checked={avgMode === 'selected'} onChange={() => setAvgMode('selected')}
                />
                Selected
                <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 'var(--font-size-label)' }}>
                  ({filterExcludedSweeps(currentGroup, currentSeries, selectedList).length})
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 'var(--font-size-sm)' }}>
                <input
                  type="radio" name="avg-mode"
                  checked={avgMode === 'range'} onChange={() => setAvgMode('range')}
                />
                Range
                <NumInput
                  value={avgFrom} min={1} max={Math.max(1, totalSweeps)} step={1}
                  onChange={(v) => { setAvgMode('range'); setAvgFrom(Math.max(1, Math.round(v))) }}
                  style={{ width: 48 }}
                />
                <span style={{ color: 'var(--text-muted)' }}>–</span>
                <NumInput
                  value={avgTo} min={1} max={Math.max(1, totalSweeps)} step={1}
                  onChange={(v) => { setAvgMode('range'); setAvgTo(Math.max(1, Math.round(v))) }}
                  style={{ width: 48 }}
                />
              </label>
              <div style={{ marginTop: 8, fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>Label:</div>
              <input
                type="text"
                value={avgLabel} placeholder={defaultLabel}
                onChange={(e) => setAvgLabel(e.target.value)}
                style={{
                  width: '100%', padding: '3px 6px', marginTop: 2,
                  fontSize: 'var(--font-size-sm)',
                  background: 'var(--bg-primary)', color: 'var(--text-primary)',
                  border: '1px solid var(--border)', borderRadius: 3,
                }}
              />
              <div style={{
                marginTop: 8, fontSize: 'var(--font-size-label)',
                color: chosenSweeps.length === 0 ? 'var(--error)' : 'var(--text-muted)',
              }}>
                {chosenSweeps.length === 0
                  ? 'No sweeps selected (all may be excluded)'
                  : `Averaging ${chosenSweeps.length} sweep${chosenSweeps.length === 1 ? '' : 's'}`}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => setShowAverageMenu(false)}>Cancel</button>
                <button
                  className="btn btn-primary"
                  onClick={handleCreateAverage}
                  disabled={chosenSweeps.length === 0}
                >
                  Create
                </button>
              </div>
            </div>
          )}
        </div>

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
            {/* Palette — two full colour sets, each with its own
                dark / light sub-theme. Switching here flips the
                ``data-palette`` attribute on <html>, which scopes the
                Telegraph overrides in telegraph.css on or off. */}
            <div className="settings-section">
              <div className="settings-label">Palette</div>
              <div className="theme-toggle">
                {(['classic', 'telegraph'] as const).map((p) => (
                  <button key={p}
                    className={palette === p ? 'active' : ''}
                    onClick={() => setPalette(p as PaletteName)}
                    title={p === 'classic'
                      ? 'Original blueish / neutral-grey palette'
                      : 'Warm amber-on-near-black, mono-heavy, uppercase titles'}>
                    {p === 'classic' ? 'Classic' : 'Telegraph'}
                  </button>
                ))}
              </div>
            </div>
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
