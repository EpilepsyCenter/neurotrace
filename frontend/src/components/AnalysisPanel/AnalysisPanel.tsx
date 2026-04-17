import React, { useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { ResistancePanel } from './panels/ResistancePanel'
import { GenericJsonPanel } from './panels/GenericJsonPanel'

export type AnalysisType =
  | 'cursors' | 'resistance' | 'kinetics' | 'events'
  | 'field_potential' | 'bursts' | 'spectral' | 'iv'

const ANALYSIS_OPTIONS: { value: AnalysisType; label: string }[] = [
  { value: 'cursors', label: 'Cursor Measurements' },
  { value: 'resistance', label: 'Rs / Rin / Cm' },
  { value: 'iv', label: 'I-V Curve' },
  { value: 'kinetics', label: 'Kinetics (Fit)' },
  { value: 'events', label: 'Event Detection' },
  { value: 'field_potential', label: 'Field PSP (fEPSP + volley)' },
  { value: 'bursts', label: 'Burst Detection' },
  { value: 'spectral', label: 'Spectral Analysis' },
]

export function AnalysisPanel() {
  const { traceData } = useAppStore()
  const [analysisType, setAnalysisType] = useState<AnalysisType>('resistance')

  const onChangeType = (t: AnalysisType) => {
    setAnalysisType(t)
    // Analyses that have their own dedicated window: open it on selection.
    if (t === 'bursts' && window.electronAPI?.openAnalysisWindow) {
      window.electronAPI.openAnalysisWindow('bursts').catch(() => { /* ignore */ })
    }
    if (t === 'iv' && window.electronAPI?.openAnalysisWindow) {
      window.electronAPI.openAnalysisWindow('iv').catch(() => { /* ignore */ })
    }
    if (t === 'field_potential' && window.electronAPI?.openAnalysisWindow) {
      window.electronAPI.openAnalysisWindow('field_potential').catch(() => { /* ignore */ })
    }
  }

  return (
    <div className="panel" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="panel-title">Analysis</div>
      <select
        value={analysisType}
        onChange={(e) => onChangeType(e.target.value as AnalysisType)}
        style={{ width: '100%', marginBottom: 10 }}
        disabled={!traceData}
      >
        {ANALYSIS_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>

      {!traceData ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontStyle: 'italic' }}>
          Load a trace to run analyses
        </p>
      ) : analysisType === 'resistance' ? (
        <ResistancePanel />
      ) : analysisType === 'bursts' ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontStyle: 'italic' }}>
          Burst detection runs in its own window.{' '}
          <button
            className="btn"
            style={{ padding: '1px 6px', marginLeft: 4, fontSize: 'var(--font-size-label)' }}
            onClick={() => window.electronAPI?.openAnalysisWindow?.('bursts')}
          >
            Open
          </button>
        </p>
      ) : analysisType === 'iv' ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontStyle: 'italic' }}>
          I-V curve analysis runs in its own window.{' '}
          <button
            className="btn"
            style={{ padding: '1px 6px', marginLeft: 4, fontSize: 'var(--font-size-label)' }}
            onClick={() => window.electronAPI?.openAnalysisWindow?.('iv')}
          >
            Open
          </button>
        </p>
      ) : analysisType === 'field_potential' ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontStyle: 'italic' }}>
          Field PSP analysis runs in its own window.{' '}
          <button
            className="btn"
            style={{ padding: '1px 6px', marginLeft: 4, fontSize: 'var(--font-size-label)' }}
            onClick={() => window.electronAPI?.openAnalysisWindow?.('field_potential')}
          >
            Open
          </button>
        </p>
      ) : (
        <GenericJsonPanel analysisType={analysisType} />
      )}
    </div>
  )
}
