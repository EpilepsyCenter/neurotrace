import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  useAppStore,
  CursorPositions,
  EventsData, EventsParams, EventsTemplate, EventRow,
  defaultEventsParams,
} from '../../stores/appStore'
import { useThemeStore } from '../../stores/themeStore'
import { NumInput } from '../common/NumInput'
import {
  Viewport, SetViewport, ViewportBar, ViewportSlider, shiftViewportBy,
} from '../common/ContinuousViewport'

/**
 * Event detection & analysis — Phase 1 (expanded).
 *
 * Core UX:
 *  - Two detection families (Template Matching / Thresholding) sharing
 *    one per-event kinetics pipeline. See backend/analysis/events.py.
 *  - Continuous-sweep viewer with viewport presets + nav arrows +
 *    minimap slider + cursor bands, same pattern as FieldBurstWindow.
 *  - Cursor bands define the "quiet region" for RMS calculation AND
 *    the "event exemplar" region for template fitting. Shared across
 *    all analysis windows via the main app store's `cursors`.
 *  - Per-event manual edits (click → add, click-marker-again → discard)
 *    persist in the store's manualEdits blob; backend replays them on
 *    every re-run.
 *  - Optional pre-detection filter (same Butterworth sosfiltfilt as the
 *    AP / Burst modules) — applied once, so threshold + detection +
 *    kinetics all see the filtered trace.
 *
 * Separate sub-windows (Template Generator + Refinement) open via the
 * `events_template_generator` / `events_template_refinement` views —
 * handled by the parent Electron process, routed in AnalysisWindow.tsx.
 */

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

// Cursor-band colors — match the baseline cursor convention used
// everywhere else in NeuroTrace (FPsp, IV, Cursor, Resistance, AP).
const CURSOR_COLOR = '#64b5f6'   // blue (matches baseline cursors elsewhere)

// ---------------------------------------------------------------------------
// Top-level window
// ---------------------------------------------------------------------------

export function EventDetectionWindow({
  backendUrl, fileInfo, mainGroup, mainSeries, mainTrace, cursors,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
  cursors: CursorPositions
}) {
  const {
    eventsAnalyses, eventsTemplates,
    runEvents, clearEvents, selectEvent, addManualEvent, removeEvent,
    computeEventsRms,
    saveEventsTemplate, deleteEventsTemplate, selectEventsTemplate,
    setCursors,
    loading, error, setError,
  } = useAppStore()
  const theme = useThemeStore((s) => s.theme)
  const fontSize = useThemeStore((s) => s.fontSize)

  // ---- Top-row selectors ----
  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
  const [channel, setChannel] = useState(mainTrace ?? 0)
  const [sweep, setSweep] = useState(0)
  const hasSyncedMainRef = useRef(false)
  useEffect(() => {
    if (hasSyncedMainRef.current) return
    if (mainGroup == null && mainSeries == null && mainTrace == null) return
    hasSyncedMainRef.current = true
    if (mainGroup != null) setGroup(mainGroup)
    if (mainSeries != null) setSeries(mainSeries)
    if (mainTrace != null) setChannel(mainTrace)
  }, [mainGroup, mainSeries, mainTrace])
  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    if (ser && series >= ser.length) setSeries(0)
  }, [fileInfo, group, series])
  const channels = useMemo(
    () => channelsForSeries(fileInfo, group, series),
    [fileInfo, group, series],
  )
  useEffect(() => {
    if (channels.length > 0 && channel >= channels.length) setChannel(0)
  }, [channels, channel])
  const totalSweeps: number = fileInfo?.groups?.[group]?.series?.[series]?.sweepCount ?? 0
  useEffect(() => {
    if (sweep >= totalSweeps && totalSweeps > 0) setSweep(0)
  }, [totalSweeps, sweep])

  // ---- Viewport (viewport-based fetch + navigation) ----
  const [viewport, setViewport] = useState<Viewport>({ tStart: 0, tEnd: 10 })
  const [sweepDurationS, setSweepDurationS] = useState(0)
  useEffect(() => {
    // On sweep change, reset viewport to first 10 s or full sweep.
    setViewport({ tStart: 0, tEnd: sweepDurationS > 0 ? Math.min(10, sweepDurationS) : 10 })
  }, [group, series, sweep, sweepDurationS])
  const shiftViewport = useCallback((factor: number) => {
    setViewport((v) => shiftViewportBy(v, sweepDurationS, factor))
  }, [sweepDurationS])
  const goHome = useCallback(() => {
    setViewport((v) => v ? { tStart: 0, tEnd: v.tEnd - v.tStart } : v)
  }, [])
  const goEnd = useCallback(() => {
    setViewport((v) => {
      if (!v || sweepDurationS <= 0) return v
      const w = v.tEnd - v.tStart
      return { tStart: Math.max(0, sweepDurationS - w), tEnd: sweepDurationS }
    })
  }, [sweepDurationS])

  // ---- Form state ----
  const [params, setParams] = useState<EventsParams>(() => defaultEventsParams())
  const key = `${group}:${series}`
  const entry: EventsData | undefined = eventsAnalyses[key]
  const rehydratedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!entry) return
    if (rehydratedKeyRef.current === key) return
    rehydratedKeyRef.current = key
    setParams(entry.params)
    setChannel(entry.channel)
    setSweep(entry.sweep)
  }, [entry, key])

  const activeTemplateId = params.templateId ?? eventsTemplates.selectedId
  const activeTemplate: EventsTemplate | null =
    (activeTemplateId && eventsTemplates.entries[activeTemplateId]) || null
  useEffect(() => {
    if (params.templateId == null && eventsTemplates.selectedId) {
      setParams((p) => ({ ...p, templateId: eventsTemplates.selectedId }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventsTemplates.selectedId])
  useEffect(() => {
    if (activeTemplate) {
      setParams((p) => ({ ...p, peakDirection: activeTemplate.direction }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTemplate?.id])

  // ---- Splitters (persisted under eventsWindowUI) ----
  const [leftPanelWidth, setLeftPanelWidth] = useState(340)
  const [plotHeight, setPlotHeight] = useState(360)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.getPreferences) return
        const prefs = (await api.getPreferences()) as Record<string, any> | undefined
        const ui = prefs?.eventsWindowUI
        if (cancelled || !ui) return
        if (typeof ui.leftPanelWidth === 'number'
            && ui.leftPanelWidth >= 240 && ui.leftPanelWidth <= 600) {
          setLeftPanelWidth(ui.leftPanelWidth)
        }
        if (typeof ui.plotHeight === 'number'
            && ui.plotHeight >= 150 && ui.plotHeight <= 800) {
          setPlotHeight(ui.plotHeight)
        }
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [])
  const writeUIPref = useCallback(async (patch: Record<string, any>) => {
    try {
      const api = window.electronAPI
      if (!api?.getPreferences || !api?.setPreferences) return
      const prefs = (await api.getPreferences()) ?? {}
      const next = { ...(prefs.eventsWindowUI ?? {}), ...patch }
      await api.setPreferences({ ...prefs, eventsWindowUI: next })
    } catch { /* ignore */ }
  }, [])

  // Session handoff — whenever the main events window's group /
  // series / channel / sweep / viewport / filter changes, we stamp a
  // snapshot under `eventsWindowSession` in Electron prefs. Sub-
  // windows (template generator, refinement) read it on mount so
  // they open on the SAME view the user was looking at in the main
  // window, with the SAME filter applied — no scrolling back to
  // find the event they were inspecting. Also broadcast the session
  // on every change so already-open sub-windows can pick up live
  // changes.
  const writeEventsSession = useCallback(async (patch: Record<string, any>) => {
    try {
      const api = window.electronAPI
      if (!api?.getPreferences || !api?.setPreferences) return
      const prefs = (await api.getPreferences()) ?? {}
      const next = { ...(prefs.eventsWindowSession ?? {}), ...patch }
      await api.setPreferences({ ...prefs, eventsWindowSession: next })
      // Notify any open sub-windows.
      try {
        const ch = new BroadcastChannel('neurotrace-sync')
        ch.postMessage({ type: 'events-session-update', eventsWindowSession: next })
        ch.close()
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }, [])
  useEffect(() => {
    // Debounced write on state change — ~100 ms so rapid scrolling
    // doesn't hammer prefs.
    const id = setTimeout(() => {
      writeEventsSession({
        group, series, channel, sweep,
        viewport: viewport ? { tStart: viewport.tStart, tEnd: viewport.tEnd } : null,
        filter: {
          enabled: params.filterEnabled,
          type: params.filterType,
          low: params.filterLow,
          high: params.filterHigh,
          order: params.filterOrder,
        },
      })
    }, 100)
    return () => clearTimeout(id)
  }, [group, series, channel, sweep, viewport,
      params.filterEnabled, params.filterType,
      params.filterLow, params.filterHigh, params.filterOrder,
      writeEventsSession])
  const onLeftSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = leftPanelWidth
    let latest = startW
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(240, Math.min(600, startW + (ev.clientX - startX)))
      setLeftPanelWidth(latest)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      writeUIPref({ leftPanelWidth: latest })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  const onSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = plotHeight
    let latest = startH
    const onMove = (ev: MouseEvent) => {
      latest = Math.max(150, Math.min(800, startH + (ev.clientY - startY)))
      setPlotHeight(latest)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      writeUIPref({ plotHeight: latest })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // ---- Cursor handling ----
  const updateCursors = useCallback((next: Partial<CursorPositions>) => {
    setCursors(next)
    // Broadcast to the main window so its cursor bands move in lockstep.
    try {
      const ch = new BroadcastChannel('neurotrace-sync')
      const merged = { ...useAppStore.getState().cursors, ...next }
      ch.postMessage({ type: 'cursor-update', cursors: merged })
      ch.close()
    } catch { /* ignore */ }
  }, [setCursors])

  /** Centre the baseline cursor pair in the middle 20% of the current
   *  viewer range — i.e. x range = [0.4·len, 0.6·len] inside viewport. */
  const bringCursorsToView = useCallback(() => {
    const vp = viewport ?? { tStart: 0, tEnd: sweepDurationS || 10 }
    const len = Math.max(1e-3, vp.tEnd - vp.tStart)
    const start = vp.tStart + 0.40 * len
    const end = vp.tStart + 0.60 * len
    updateCursors({ baselineStart: start, baselineEnd: end })
  }, [viewport, sweepDurationS, updateCursors])

  // ---- Run ----
  const onRun = async () => {
    const template = params.method.startsWith('template_') ? activeTemplate : null
    if (params.method.startsWith('template_') && !template) {
      setError('Select or generate a template first.')
      return
    }
    await runEvents(group, series, channel, sweep, params, template)
  }

  // ---- Open sub-windows ----
  const openTemplateGenerator = async () => {
    const api = window.electronAPI
    if (api?.openAnalysisWindow) {
      await api.openAnalysisWindow('events_template_generator')
    }
  }
  const openTemplateRefinement = async () => {
    if (!entry || entry.events.length < 2) {
      setError('Run detection first; need ≥ 2 events to refine.')
      return
    }
    const api = window.electronAPI
    if (api?.openAnalysisWindow) {
      await api.openAnalysisWindow('events_template_refinement')
    }
  }

  // ---- Viewer-side actions ----
  const onAddEventAtTime = useCallback(async (timeS: number) => {
    if (!entry) {
      await runEvents(group, series, channel, sweep, params, activeTemplate)
    }
    await addManualEvent(group, series, timeS)
  }, [entry, group, series, channel, sweep, params, activeTemplate,
      runEvents, addManualEvent])
  const onDiscardEvent = useCallback(async (idx: number) => {
    await removeEvent(group, series, idx)
  }, [group, series, removeEvent])

  // Compute the filter payload once for action calls that need it.
  const filterPayload = useMemo(() => ({
    enabled: params.filterEnabled, type: params.filterType,
    low: params.filterLow, high: params.filterHigh, order: params.filterOrder,
  }), [params.filterEnabled, params.filterType, params.filterLow,
      params.filterHigh, params.filterOrder])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 10, gap: 10, minHeight: 0,
    }}>
      {/* Top selectors */}
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0,
        background: 'var(--bg-secondary)',
        padding: '6px 10px',
        borderRadius: 4,
        border: '1px solid var(--border)',
      }}>
        <Field label="Group">
          <select value={group} onChange={(e) => setGroup(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups ?? []).map((g: any, i: number) => (
              <option key={i} value={i}>{g.label || `G${i + 1}`}</option>
            ))}
          </select>
        </Field>
        <Field label="Series">
          <select value={series} onChange={(e) => setSeries(Number(e.target.value))} disabled={!fileInfo}>
            {(fileInfo?.groups?.[group]?.series ?? []).map((s: any, i: number) => (
              <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
            ))}
          </select>
        </Field>
        <Field label="Channel">
          <select value={channel} onChange={(e) => setChannel(Number(e.target.value))}
                  disabled={channels.length === 0}>
            {channels.map((c: any) => (
              <option key={c.index} value={c.index}>{c.label} ({c.units})</option>
            ))}
          </select>
        </Field>
        <Field label="Sweep">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <button className="btn" style={{ padding: '2px 8px' }}
              onClick={() => setSweep((s) => Math.max(0, s - 1))}
              disabled={sweep <= 0 || totalSweeps === 0} title="Previous sweep">←</button>
            <span style={{
              minWidth: 58, textAlign: 'center',
              fontSize: 'var(--font-size-label)', color: 'var(--text-muted)',
            }}>
              {totalSweeps > 0 ? `${sweep + 1} / ${totalSweeps}` : '— / —'}
            </span>
            <button className="btn" style={{ padding: '2px 8px' }}
              onClick={() => setSweep((s) => Math.min(totalSweeps - 1, s + 1))}
              disabled={sweep >= totalSweeps - 1 || totalSweeps === 0} title="Next sweep">→</button>
          </span>
        </Field>
      </div>

      {/* Two-column body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, gap: 0 }}>
        {/* LEFT PANEL */}
        <div style={{
          width: leftPanelWidth, flexShrink: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8,
          background: 'var(--bg-secondary)',
          padding: 8, borderRadius: 4, border: '1px solid var(--border)',
        }}>
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8,
            paddingRight: 4,
          }}>
            {/* Method card */}
            <Card title="Detection method">
              <Row label="Method">
                <select value={params.method} style={{ width: '100%' }}
                  onChange={(e) => setParams((p) => ({
                    ...p, method: e.target.value as EventsParams['method'],
                  }))}>
                  <option value="template_correlation">Template — correlation</option>
                  <option value="template_deconvolution">Template — deconvolution</option>
                  <option value="threshold">Thresholding</option>
                </select>
              </Row>
              <Row label="Peak direction">
                <select value={params.peakDirection} style={{ width: '100%' }}
                  onChange={(e) => setParams((p) => ({
                    ...p, peakDirection: e.target.value as 'negative' | 'positive',
                  }))}>
                  <option value="negative">Negative</option>
                  <option value="positive">Positive</option>
                </select>
              </Row>
            </Card>

            {/* Filter card */}
            <FilterCard params={params} setParams={setParams} />

            {/* Template card */}
            {params.method.startsWith('template_') && (
              <TemplatePanel
                templates={eventsTemplates.entries}
                activeTemplateId={activeTemplateId}
                activeTemplate={activeTemplate}
                onPickTemplate={(id) => {
                  setParams((p) => ({ ...p, templateId: id }))
                  selectEventsTemplate(id)
                }}
                onOpenGenerator={openTemplateGenerator}
                onOpenRefinement={openTemplateRefinement}
                canRefine={(entry?.events.length ?? 0) >= 2}
              />
            )}

            {/* Detection algorithm cutoff */}
            {params.method === 'template_correlation' && (
              <Card title="Correlation cutoff">
                <Row label="Cutoff (r)">
                  <NumInput value={params.correlationCutoff} step={0.05} min={-1} max={1}
                    onChange={(v) => setParams((p) => ({ ...p, correlationCutoff: v }))} />
                </Row>
                <HelpText>Typical 0.3–0.6. Raise to miss noise, lower to catch smaller events.</HelpText>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={params.showDetectionMeasure}
                    onChange={(e) => setParams((p) => ({ ...p, showDetectionMeasure: e.target.checked }))} />
                  <span>Show correlation trace</span>
                </label>
              </Card>
            )}
            {params.method === 'template_deconvolution' && (
              <Card title="Deconvolution cutoff">
                <Row label="Cutoff (σ)">
                  <NumInput value={params.deconvCutoffSd} step={0.25} min={0.5}
                    onChange={(v) => setParams((p) => ({ ...p, deconvCutoffSd: v }))} />
                </Row>
                <Row label="Low (Hz)">
                  <NumInput value={params.deconvLowHz} step={0.1} min={0}
                    onChange={(v) => setParams((p) => ({ ...p, deconvLowHz: v }))} />
                </Row>
                <Row label="High (Hz)">
                  <NumInput value={params.deconvHighHz} step={10} min={1}
                    onChange={(v) => setParams((p) => ({ ...p, deconvHighHz: v }))} />
                </Row>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={params.showDetectionMeasure}
                    onChange={(e) => setParams((p) => ({ ...p, showDetectionMeasure: e.target.checked }))} />
                  <span>Show filtered deconvolution</span>
                </label>
                <HelpText>
                  Overlay the deconvolution trace beneath the viewer with
                  a horizontal line at the cutoff — lets you tune the
                  σ and low/high cutoffs visually.
                </HelpText>
              </Card>
            )}

            {/* Threshold card */}
            {params.method === 'threshold' && (
              <ThresholdPanel
                params={params}
                onParamsChange={setParams}
                cursors={cursors}
                onBringCursorsToView={bringCursorsToView}
                onComputeRms={async () => {
                  if (cursors.baselineEnd <= cursors.baselineStart) {
                    setError('Cursor region is empty — use "Cursors to view" first.')
                    return
                  }
                  try {
                    const r = await computeEventsRms(
                      group, series, channel, sweep,
                      cursors.baselineStart, cursors.baselineEnd,
                      filterPayload,
                    )
                    setParams((p) => ({
                      ...p,
                      rmsRegion: {
                        startS: cursors.baselineStart,
                        endS: cursors.baselineEnd,
                      },
                      rmsValue: r.rms,
                      rmsBaselineMean: r.baselineMean,
                    }))
                  } catch (err: any) {
                    setError(err.message ?? String(err))
                  }
                }}
              />
            )}

            {/* Kinetics card */}
            <Card title="Kinetics">
              <Row label="Baseline search (ms)">
                <NumInput value={params.baselineSearchMs} step={1} min={1}
                  onChange={(v) => setParams((p) => ({ ...p, baselineSearchMs: v }))} />
              </Row>
              <Row label="Avg baseline (ms)">
                <NumInput value={params.avgBaselineMs} step={0.1} min={0.1}
                  onChange={(v) => setParams((p) => ({ ...p, avgBaselineMs: v }))} />
              </Row>
              <Row label="Avg peak (ms)">
                <NumInput value={params.avgPeakMs} step={0.1} min={0.1}
                  onChange={(v) => setParams((p) => ({ ...p, avgPeakMs: v }))} />
              </Row>
              <Row label="Rise low %">
                <NumInput value={params.riseLowPct} step={5} min={0} max={100}
                  onChange={(v) => setParams((p) => ({ ...p, riseLowPct: v }))} />
              </Row>
              <Row label="Rise high %">
                <NumInput value={params.riseHighPct} step={5} min={0} max={100}
                  onChange={(v) => setParams((p) => ({ ...p, riseHighPct: v }))} />
              </Row>
              <Row label="Decay %">
                <NumInput value={params.decayPct} step={1} min={1} max={99}
                  onChange={(v) => setParams((p) => ({ ...p, decayPct: v }))} />
              </Row>
              <Row label="Decay search (ms)">
                <NumInput value={params.decaySearchMs} step={5} min={1}
                  onChange={(v) => setParams((p) => ({ ...p, decaySearchMs: v }))} />
              </Row>
            </Card>

            {/* Exclusion card */}
            <Card title="Exclusion">
              <Row label="Min |amp|">
                <NumInput value={params.amplitudeMinAbs} step={1} min={0}
                  onChange={(v) => setParams((p) => ({ ...p, amplitudeMinAbs: v }))} />
              </Row>
              <Row label="Max |amp|">
                <NumInput value={params.amplitudeMaxAbs} step={50} min={1}
                  onChange={(v) => setParams((p) => ({ ...p, amplitudeMaxAbs: v }))} />
              </Row>
              <Row label="Min IEI (ms)">
                <NumInput value={params.minIeiMs} step={1} min={0}
                  onChange={(v) => setParams((p) => ({ ...p, minIeiMs: v }))} />
              </Row>
            </Card>
          </div>

          {/* Pinned Run footer */}
          <div style={{
            flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6,
            padding: 8, border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-primary)',
          }}>
            <button className="btn btn-primary" onClick={onRun}
              disabled={loading || !fileInfo}
              style={{
                width: '100%', padding: '8px 0',
                fontSize: 'var(--font-size-sm)', fontWeight: 600,
              }}>
              {loading ? 'Running…' : 'Run'}
            </button>
            <div style={{
              display: 'flex', gap: 6, marginTop: 2,
              borderTop: '1px solid var(--border)', paddingTop: 6,
            }}>
              <button className="btn" onClick={() => clearEvents(group, series)}
                disabled={!entry}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Clear
              </button>
              <button className="btn"
                onClick={() => exportEventsCSV(entry, fileInfo?.fileName ?? 'recording')}
                disabled={!entry || entry.events.length === 0}
                style={{ flex: 1, fontSize: 'var(--font-size-label)' }}>
                Export CSV
              </button>
            </div>
          </div>
          {error && (
            <div style={{
              flexShrink: 0, padding: '6px 10px',
              background: 'var(--bg-error, #5c1b1b)',
              color: '#fff', borderRadius: 3,
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 'var(--font-size-xs)',
            }}>
              <span style={{ flex: 1 }}>⚠ {error}</span>
              <button className="btn" onClick={() => setError(null)}
                style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}>
                dismiss
              </button>
            </div>
          )}
        </div>

        {/* Vertical splitter */}
        <div onMouseDown={onLeftSplitMouseDown} title="Drag to resize"
          style={{
            width: 3, flexShrink: 0, cursor: 'col-resize',
            background: 'var(--border)', position: 'relative',
          }}>
          <div style={{
            position: 'absolute', top: '50%', left: 0,
            transform: 'translateY(-50%)',
            width: 2, height: 40, background: 'var(--text-muted)',
            borderRadius: 1, opacity: 0.5,
          }} />
        </div>

        {/* RIGHT PANEL */}
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column', minHeight: 0,
          paddingLeft: 8,
        }}>
          {/* Main viewer. The detection-measure trace (correlation r or
              filtered deconvolution) is now drawn as a SECOND series
              on the same plot — with its own right-hand Y axis —
              instead of in a stacked subplot. Matches EE. */}
          <div style={{ height: plotHeight, minHeight: 180, flexShrink: 0 }}>
            <EventsSweepViewer
              backendUrl={backendUrl}
              group={group} series={series} channel={channel} sweep={sweep}
              entry={entry}
              params={params}
              activeTemplate={activeTemplate}
              cursors={cursors}
              updateCursors={updateCursors}
              viewport={viewport}
              setViewport={setViewport}
              sweepDurationS={sweepDurationS}
              setSweepDurationS={setSweepDurationS}
              shiftViewport={shiftViewport}
              goHome={goHome}
              goEnd={goEnd}
              theme={theme} fontSize={fontSize}
              heightSignal={plotHeight}
              onAddEvent={onAddEventAtTime}
              onDiscardEvent={onDiscardEvent}
            />
          </div>

          {/* Horizontal splitter */}
          <div onMouseDown={onSplitMouseDown} title="Drag to resize"
            style={{
              height: 3, cursor: 'row-resize', background: 'var(--border)',
              flexShrink: 0, position: 'relative',
            }}>
            <div style={{
              position: 'absolute', left: '50%', top: 0,
              transform: 'translateX(-50%)',
              width: 40, height: 2, background: 'var(--text-muted)',
              borderRadius: 1, opacity: 0.5,
            }} />
          </div>

          {/* Results */}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            marginTop: 6,
            border: '1px solid var(--border)', borderRadius: 4,
          }}>
            <EventsResultsTable
              entry={entry}
              onSelect={(idx) => selectEvent(group, series, idx)}
              onDiscard={(idx) => onDiscardEvent(idx)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers (small UI primitives)
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: 8, border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
      fontSize: 'var(--font-size-label)',
    }}>
      <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>{title}</span>
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color: 'var(--text-muted)', flex: 1 }}>{label}</span>
      <span style={{ minWidth: 80 }}>{children}</span>
    </label>
  )
}

function HelpText({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      color: 'var(--text-muted)', fontStyle: 'italic',
      fontSize: 'var(--font-size-label)',
    }}>
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Filter card (same shape as AP / Burst)
// ---------------------------------------------------------------------------

function FilterCard({
  params, setParams,
}: {
  params: EventsParams
  setParams: React.Dispatch<React.SetStateAction<EventsParams>>
}) {
  return (
    <Card title="Pre-detection filter">
      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input type="checkbox" checked={params.filterEnabled}
          onChange={(e) => setParams((p) => ({ ...p, filterEnabled: e.target.checked }))} />
        <span style={{ fontWeight: 600 }}>Enable</span>
      </label>
      {params.filterEnabled && (
        <>
          <Row label="Type">
            <select value={params.filterType} style={{ width: '100%' }}
              onChange={(e) => setParams((p) => ({
                ...p, filterType: e.target.value as 'lowpass' | 'highpass' | 'bandpass',
              }))}>
              <option value="bandpass">Bandpass</option>
              <option value="lowpass">Lowpass</option>
              <option value="highpass">Highpass</option>
            </select>
          </Row>
          {(params.filterType === 'highpass' || params.filterType === 'bandpass') && (
            <Row label="Low (Hz)">
              <NumInput value={params.filterLow} step={0.5} min={0}
                onChange={(v) => setParams((p) => ({ ...p, filterLow: v }))} />
            </Row>
          )}
          {(params.filterType === 'lowpass' || params.filterType === 'bandpass') && (
            <Row label="High (Hz)">
              <NumInput value={params.filterHigh} step={10} min={1}
                onChange={(v) => setParams((p) => ({ ...p, filterHigh: v }))} />
            </Row>
          )}
          <Row label="Order">
            <NumInput value={params.filterOrder} step={1} min={1} max={8}
              onChange={(v) => setParams((p) => ({
                ...p, filterOrder: Math.max(1, Math.min(8, Math.round(v))),
              }))} />
          </Row>
        </>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Template panel
// ---------------------------------------------------------------------------

function TemplatePanel({
  templates, activeTemplateId, activeTemplate,
  onPickTemplate,
  onOpenGenerator, onOpenRefinement,
  canRefine,
}: {
  templates: Record<string, EventsTemplate>
  activeTemplateId: string | null
  activeTemplate: EventsTemplate | null
  onPickTemplate: (id: string) => void
  onOpenGenerator: () => void
  onOpenRefinement: () => void
  canRefine: boolean
}) {
  // Main-window template panel is READ-ONLY: library picker + a
  // compact coefficient readout + buttons to open the dedicated
  // generator / refinement sub-windows. All editing (fit, coefficient
  // tweaks, save-as, delete) lives in the template generator —
  // matches EE's pattern where Generate Template is a separate
  // window from the main Events Analysis panel.
  return (
    <Card title="Template">
      <Row label="Library">
        <select value={activeTemplateId ?? ''} style={{ width: '100%' }}
          onChange={(e) => { if (e.target.value) onPickTemplate(e.target.value) }}>
          <option value="" disabled>— pick —</option>
          {Object.values(templates).map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </Row>
      {activeTemplate && (
        <div style={{
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)',
          fontSize: 'var(--font-size-label)',
          lineHeight: 1.6,
        }}>
          τ rise = {activeTemplate.tauRiseMs.toFixed(2)} ms ·
          τ decay = {activeTemplate.tauDecayMs.toFixed(2)} ms<br />
          b0 = {activeTemplate.b0.toFixed(2)} ·
          b1 = {activeTemplate.b1.toFixed(2)} ·
          width = {activeTemplate.widthMs.toFixed(0)} ms
        </div>
      )}
      <div style={{
        marginTop: 6, paddingTop: 6,
        borderTop: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <button className="btn btn-primary" onClick={onOpenGenerator}
          style={{ padding: '4px 10px', fontSize: 'var(--font-size-label)' }}>
          Open template generator…
        </button>
        <button className="btn" onClick={onOpenRefinement} disabled={!canRefine}
          style={{ padding: '3px 10px', fontSize: 'var(--font-size-label)' }}
          title={canRefine ? 'Fit a biexp to the average of detected events'
            : 'Run detection first (need ≥ 2 events)'}>
          Open refine template…
        </button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Threshold panel
// ---------------------------------------------------------------------------

function ThresholdPanel({
  params, onParamsChange, cursors, onBringCursorsToView, onComputeRms,
}: {
  params: EventsParams
  onParamsChange: React.Dispatch<React.SetStateAction<EventsParams>>
  cursors: CursorPositions
  onBringCursorsToView: () => void
  onComputeRms: () => void
}) {
  return (
    <Card title="Threshold">
      <Row label="Mode">
        <select value={params.thresholdMode} style={{ width: '100%' }}
          onChange={(e) => onParamsChange((p) => ({
            ...p, thresholdMode: e.target.value as 'rms' | 'linear',
          }))}>
          <option value="rms">RMS of quiet region</option>
          <option value="linear">Linear value</option>
        </select>
      </Row>
      {params.thresholdMode === 'rms' ? (
        <>
          <HelpText>
            Drag the blue cursor band on the viewer to cover a quiet
            section, then Compute RMS.
          </HelpText>
          <div style={{
            fontFamily: 'var(--font-mono)', color: CURSOR_COLOR,
            fontSize: 'var(--font-size-label)',
          }}>
            {cursors.baselineStart.toFixed(3)} → {cursors.baselineEnd.toFixed(3)} s
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="btn" onClick={onBringCursorsToView}
              style={{ flex: 1, padding: '2px 6px', fontSize: 'var(--font-size-label)' }}
              title="Center the cursor band in the middle 20% of the current view">
              Cursors to view
            </button>
            <button className="btn" onClick={onComputeRms}
              style={{ flex: 1, padding: '2px 6px', fontSize: 'var(--font-size-label)' }}>
              Compute RMS
            </button>
          </div>
          {params.rmsValue != null && (
            <HelpText>
              baseline = {params.rmsBaselineMean?.toFixed(3)},{' '}
              RMS = {params.rmsValue.toFixed(3)}
            </HelpText>
          )}
          <Row label="× RMS">
            <NumInput value={params.rmsMultiplier} step={0.5} min={0.5}
              onChange={(v) => onParamsChange((p) => ({ ...p, rmsMultiplier: v }))} />
          </Row>
        </>
      ) : (
        <Row label="Threshold">
          <NumInput value={params.linearThreshold} step={1}
            onChange={(v) => onParamsChange((p) => ({ ...p, linearThreshold: v }))} />
        </Row>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Continuous-sweep viewer with full navigation, cursor bands, and event markers
// ---------------------------------------------------------------------------

function EventsSweepViewer({
  backendUrl, group, series, channel, sweep, entry, params,
  activeTemplate,
  cursors, updateCursors,
  viewport, setViewport, sweepDurationS, setSweepDurationS,
  shiftViewport, goHome, goEnd,
  theme, fontSize, heightSignal,
  onAddEvent, onDiscardEvent,
}: {
  backendUrl: string
  group: number; series: number; channel: number; sweep: number
  entry: EventsData | undefined
  params: EventsParams
  /** Active biexp template — needed so the viewer can refetch the
   *  detection-measure overlay on viewport / template changes. */
  activeTemplate: EventsTemplate | null
  cursors: CursorPositions
  updateCursors: (next: Partial<CursorPositions>) => void
  viewport: Viewport
  setViewport: SetViewport
  sweepDurationS: number
  setSweepDurationS: React.Dispatch<React.SetStateAction<number>>
  shiftViewport: (factor: number) => void
  goHome: () => void
  goEnd: () => void
  theme: string; fontSize: number
  heightSignal: number
  onAddEvent: (timeS: number) => void
  onDiscardEvent: (idx: number) => void
}) {
  void theme; void fontSize
  const rootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const primedDiscardIdxRef = useRef<number | null>(null)
  const cursorsRef = useRef(cursors)
  cursorsRef.current = cursors
  const entryRef = useRef(entry)
  entryRef.current = entry
  const paramsRef = useRef(params)
  paramsRef.current = params

  const [data, setData] = useState<{
    time: Float64Array; values: Float64Array
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** Detection-measure overlay (correlation r or filtered
   *  deconvolution) for the current viewport. Fetched on-demand at
   *  full sampling-rate resolution when the user has the "Show
   *  detection measure" toggle on. Drawn as a second uPlot series
   *  with its own right-hand Y axis, NOT a stacked subplot. */
  const [dm, setDm] = useState<import('../../stores/appStore').EventsDetectionMeasure | null>(null)
  const dmRef = useRef(dm)
  dmRef.current = dm
  const fetchDm = useAppStore((s) => s.fetchEventsDetectionMeasure)

  // Fetch data for the current viewport. Full original sampling rate
  // (max_points=0) — for long viewports uPlot will manage its own
  // rendering decimation, and for zoomed-in windows we get the full
  // temporal resolution needed for accurate event placement.
  useEffect(() => {
    if (!backendUrl) { setData(null); return }
    const parts: string[] = [
      `group=${group}`, `series=${series}`, `sweep=${sweep}`,
      `trace=${channel}`, `max_points=0`,
    ]
    if (viewport) {
      parts.push(`t_start=${viewport.tStart}`)
      parts.push(`t_end=${viewport.tEnd}`)
    }
    // Pre-detection filter — feed the same params through the traces
    // endpoint so the viewer shows the trace the detector will see.
    if (params.filterEnabled) {
      parts.push(`filter_type=${params.filterType}`)
      parts.push(`filter_low=${params.filterLow}`)
      parts.push(`filter_high=${params.filterHigh}`)
      parts.push(`filter_order=${params.filterOrder}`)
    }
    const url = `${backendUrl}/api/traces/data?${parts.join('&')}`
    let cancelled = false
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return
        const n = Number(d.n_samples ?? 0)
        const sr = Number(d.sampling_rate ?? 1)
        const durationS = sr > 0 ? n / sr : Number(d.duration ?? 0)
        if (durationS > 0 && Math.abs(durationS - sweepDurationS) > 1e-3) {
          setSweepDurationS(durationS)
        }
        setData({
          time: new Float64Array(d.time ?? []),
          values: new Float64Array(d.values ?? []),
        })
        setErr(null)
      })
      .catch((e) => { if (!cancelled) { setData(null); setErr(String(e)) } })
    return () => { cancelled = true }
  }, [backendUrl, group, series, sweep, channel, viewport,
      params.filterEnabled, params.filterType, params.filterLow,
      params.filterHigh, params.filterOrder, setSweepDurationS, sweepDurationS])

  // Fetch the detection-measure slice for the current viewport at
  // full sampling-rate resolution. Only runs when the toggle is on
  // AND we have a template (deconvolution and correlation both
  // require one). Re-fires on viewport / cutoff / template / filter
  // changes so the overlay always tracks the visible trace.
  useEffect(() => {
    if (!params.showDetectionMeasure
        || !params.method.startsWith('template_')
        || !activeTemplate || !viewport) {
      setDm(null)
      return
    }
    let cancelled = false
    const method = params.method as 'template_correlation' | 'template_deconvolution'
    const cutoff = method === 'template_correlation'
      ? params.correlationCutoff
      : params.deconvCutoffSd
    const filterPayload = params.filterEnabled ? {
      enabled: true, type: params.filterType,
      low: params.filterLow, high: params.filterHigh, order: params.filterOrder,
    } : null
    fetchDm(
      group, series, channel, sweep,
      method, activeTemplate, cutoff, params.peakDirection,
      params.deconvLowHz, params.deconvHighHz,
      viewport.tStart, viewport.tEnd,
      filterPayload,
    )
      .then((out) => { if (!cancelled) setDm(out) })
      .catch(() => { if (!cancelled) setDm(null) })
    return () => { cancelled = true }
  }, [
    fetchDm, group, series, channel, sweep,
    viewport,
    params.showDetectionMeasure, params.method,
    params.correlationCutoff, params.deconvCutoffSd,
    params.deconvLowHz, params.deconvHighHz,
    params.peakDirection,
    params.filterEnabled, params.filterType, params.filterLow,
    params.filterHigh, params.filterOrder,
    activeTemplate?.b0, activeTemplate?.b1,
    activeTemplate?.tauRiseMs, activeTemplate?.tauDecayMs,
    activeTemplate?.widthMs,
    activeTemplate,
  ])

  // ---- Overlays drawn inside uPlot's draw hook ----
  const drawOverlays = useCallback((u: uPlot) => {
    const e = entryRef.current
    const p = paramsRef.current
    const c = cursorsRef.current
    const ctx = u.ctx
    const dpr = devicePixelRatio || 1

    // Cursor baseline band (blue) — drag-move / drag-edge on pointerdown below.
    {
      const a = u.valToPos(c.baselineStart, 'x', true)
      const b = u.valToPos(c.baselineEnd, 'x', true)
      if (isFinite(a) && isFinite(b)) {
        ctx.save()
        ctx.globalAlpha = 0.14
        ctx.fillStyle = CURSOR_COLOR
        ctx.fillRect(
          Math.min(a, b), u.bbox.top,
          Math.abs(b - a), u.bbox.height,
        )
        ctx.globalAlpha = 0.85
        ctx.strokeStyle = CURSOR_COLOR
        ctx.lineWidth = 1.5 * dpr
        ctx.beginPath()
        ctx.moveTo(a, u.bbox.top); ctx.lineTo(a, u.bbox.top + u.bbox.height)
        ctx.moveTo(b, u.bbox.top); ctx.lineTo(b, u.bbox.top + u.bbox.height)
        ctx.stroke()
        ctx.globalAlpha = 1
        ctx.fillStyle = CURSOR_COLOR
        ctx.font = `bold ${10 * dpr}px ${cssVar('--font-mono')}`
        ctx.fillText('cursors', Math.min(a, b) + 2 * dpr, u.bbox.top + 12 * dpr)
        ctx.restore()
      }
    }

    // Threshold line (red dashed) for threshold method.
    if (p.method === 'threshold') {
      let threshold: number | null = null
      if (p.thresholdMode === 'linear') {
        threshold = p.linearThreshold
      } else if (p.rmsValue != null) {
        const base = p.rmsBaselineMean ?? 0
        const sign = p.peakDirection === 'negative' ? -1 : 1
        threshold = base + sign * p.rmsMultiplier * p.rmsValue
      }
      if (threshold != null && isFinite(threshold)) {
        const py = u.valToPos(threshold, 'y', true)
        ctx.save()
        ctx.strokeStyle = '#e57373'
        ctx.lineWidth = 1 * dpr
        ctx.setLineDash([6 * dpr, 4 * dpr])
        ctx.beginPath()
        ctx.moveTo(u.bbox.left, py)
        ctx.lineTo(u.bbox.left + u.bbox.width, py)
        ctx.stroke()
        ctx.restore()
      }
    }

    // Event markers — peak (red/orange), foot (gray), decay endpoint
    // (purple). Drawn for every detected event in the visible X
    // range, not just the selected one — users asked to see all
    // three pieces at a glance. Selected event gets a white ring on
    // its peak; primed-for-discard gets a blue ring.
    if (e && e.events.length > 0) {
      const xMin = u.scales.x.min ?? 0
      const xMax = u.scales.x.max ?? 0
      const sr = e.samplingRate || 1
      for (let i = 0; i < e.events.length; i++) {
        const ev = e.events[i]
        if (ev.peakTimeS < xMin || ev.peakTimeS > xMax) continue
        ctx.save()
        // Foot / baseline dot — gray, at (footTimeS, baselineVal)
        const fpx = u.valToPos(ev.footTimeS, 'x', true)
        const fpy = u.valToPos(ev.baselineVal, 'y', true)
        ctx.fillStyle = '#9e9e9e'
        ctx.beginPath()
        ctx.arc(fpx, fpy, 2.5 * dpr, 0, 2 * Math.PI)
        ctx.fill()
        // Decay endpoint dot — purple, at (decay time, trace value there)
        if (ev.decayEndpointIdx != null) {
          const dt = ev.decayEndpointIdx / sr
          // Y for the endpoint dot = the actual trace sample value.
          // We don't have the full trace here (performance) so use
          // the event's baseline as a stand-in — decay-endpoint
          // detection ensures the trace sat near baseline there.
          const dpx = u.valToPos(dt, 'x', true)
          const dpy = u.valToPos(ev.baselineVal, 'y', true)
          ctx.fillStyle = '#ab47bc'
          ctx.beginPath()
          ctx.arc(dpx, dpy, 2.5 * dpr, 0, 2 * Math.PI)
          ctx.fill()
        }
        // Peak dot — red (auto) or orange (manual)
        const px = u.valToPos(ev.peakTimeS, 'x', true)
        const py = u.valToPos(ev.peakVal, 'y', true)
        const color = ev.manual ? '#ffb74d' : '#e57373'
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(px, py, 4 * dpr, 0, 2 * Math.PI)
        ctx.fill()
        if (i === e.selectedIdx) {
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 1.5 * dpr
          ctx.beginPath()
          ctx.arc(px, py, 5 * dpr, 0, 2 * Math.PI)
          ctx.stroke()
        }
        if (primedDiscardIdxRef.current === i) {
          ctx.strokeStyle = '#64b5f6'
          ctx.lineWidth = 2 * dpr
          ctx.beginPath()
          ctx.arc(px, py, 7 * dpr, 0, 2 * Math.PI)
          ctx.stroke()
        }
        ctx.restore()
      }
    }
  }, [])

  // ---- X-range ref (locked-zoom pattern) ----
  const xRangeRef = useRef<[number, number] | null>(null)
  const yRangeRef = useRef<[number, number] | null>(null)
  // When viewport changes externally, snap x-range to viewport. Keep
  // Y unchanged — the user may have manually zoomed Y and scrolling X
  // should never reset that.
  useEffect(() => {
    if (!viewport) return
    xRangeRef.current = [viewport.tStart, viewport.tEnd]
    const u = plotRef.current
    if (u) {
      u.setScale('x', { min: viewport.tStart, max: viewport.tEnd })
    }
  }, [viewport])
  // Reset Y only when the user explicitly switches sweep / group /
  // series / channel — the trace itself changes and old Y range may
  // be wildly off-scale. (Not when viewport shifts within the same
  // sweep.)
  useEffect(() => {
    yRangeRef.current = null
  }, [group, series, channel, sweep])

  // Build / rebuild plot when data changes.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) {
      const teardown = (plotRef.current as any)._teardownEvents
      if (teardown) teardown()
      plotRef.current.destroy()
      plotRef.current = null
    }
    if (!data || data.time.length === 0) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      // Align the detection-measure trace onto the raw trace's X grid
      // so both series share uPlot's single X array. Nearest-neighbor
      // indexing is fast (O(N_trace)) and accurate since the DM's
      // sampling rate is the trace's sampling rate (or strided at a
      // fixed factor) — no real aliasing on resample.
      const dmCurrent = dmRef.current
      let dmAligned: (number | null)[] | null = null
      if (dmCurrent && dmCurrent.values.length > 0) {
        const dmVals = dmCurrent.values
        const dmT0 = dmCurrent.tStartS
        const dmDt = dmCurrent.dtS
        const dmN = dmVals.length
        dmAligned = new Array(data.time.length)
        for (let i = 0; i < data.time.length; i++) {
          const j = Math.round((data.time[i] - dmT0) / dmDt)
          dmAligned[i] = (j >= 0 && j < dmN) ? dmVals[j] : null
        }
      }
      const dmCutoff = dmCurrent?.cutoffLine ?? null
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: {
          x: {
            time: false,
            range: (_u, dataMin, dataMax) => {
              if (xRangeRef.current) return xRangeRef.current
              const lo = isFinite(dataMin) ? dataMin : 0
              const hi = isFinite(dataMax) && dataMax > lo ? dataMax : lo + 1
              const r: [number, number] = [lo, hi]
              xRangeRef.current = r
              return r
            },
          },
          y: {
            range: (_u, dmin, dmax) => {
              if (yRangeRef.current) return yRangeRef.current
              if (!isFinite(dmin) || !isFinite(dmax) || dmin === dmax) return [0, 1]
              const pad = (dmax - dmin) * 0.05
              const r: [number, number] = [dmin - pad, dmax + pad]
              yRangeRef.current = r
              return r
            },
          },
          // Detection-measure scale (right Y axis) — auto-fits so the
          // DM trace uses the full vertical space, independent of the
          // recording's pA/mV range.
          dm: {
            auto: true,
            range: (_u, dmin, dmax) => {
              const cutoff = dmCutoff
              let lo = isFinite(dmin) ? dmin : 0
              let hi = isFinite(dmax) ? dmax : 1
              if (cutoff != null && isFinite(cutoff)) {
                lo = Math.min(lo, cutoff)
                hi = Math.max(hi, cutoff)
              }
              if (hi <= lo) hi = lo + 1
              const pad = (hi - lo) * 0.05
              return [lo - pad, hi + pad]
            },
          },
        },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'Time (s)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 55,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          },
          // Right-hand Y axis for the DM series. Only visible when a
          // DM series is present; otherwise uPlot still allocates
          // space so we gate `show: !!dmAligned`.
          ...(dmAligned ? [{
            scale: 'dm',
            side: 1 as const,
            stroke: '#ffb74d',
            grid: { show: false },
            ticks: { stroke: '#ffb74d', width: 1 },
            size: 55,
            label: dmCurrent?.method === 'deconvolution' ? 'deconv' : 'r',
            labelSize: 12,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          }] : []),
        ],
        cursor: { drag: { x: false, y: false } },
        series: [
          {},
          { stroke: cssVar('--trace-color-1'), width: 1.25 },
          // DM series — only present when dmAligned is populated.
          ...(dmAligned ? [{
            stroke: '#ffb74d',
            width: 1,
            scale: 'dm',
            spanGaps: false,
          }] : []),
        ],
        hooks: {
          draw: [(u) => {
            drawOverlays(u)
            // Draw the DM cutoff as a dashed orange horizontal line
            // on the DM scale so the user can tune the cutoff by eye.
            if (dmAligned && dmCutoff != null) {
              const py = u.valToPos(dmCutoff, 'dm', true)
              if (isFinite(py)) {
                const ctx = u.ctx
                const dpr = devicePixelRatio || 1
                ctx.save()
                ctx.strokeStyle = '#ffb74d'
                ctx.lineWidth = 1 * dpr
                ctx.setLineDash([6 * dpr, 4 * dpr])
                ctx.beginPath()
                ctx.moveTo(u.bbox.left, py)
                ctx.lineTo(u.bbox.left + u.bbox.width, py)
                ctx.stroke()
                ctx.restore()
              }
            }
          }],
        },
      }
      const payload: uPlot.AlignedData = dmAligned
        ? [Array.from(data.time), Array.from(data.values), dmAligned as any]
        : [Array.from(data.time), Array.from(data.values)]
      plotRef.current = new uPlot(opts, payload, container)

      // Attach pointer handlers on uPlot's over layer.
      //
      // Dispatch priority on pointerdown:
      //   1. Hit on cursor edge   → start cursor-edge drag
      //   2. Hit on cursor band   → start cursor-band drag
      //   3. Hit on event marker  → prime / discard
      //   4. Empty space          → potential click-vs-drag —
      //        if the pointer moves > 3 px before release → pan
      //        if the pointer releases without moving     → add event
      //
      // This matches the BurstSweepViewer pattern: plain drag always
      // pans (no shift modifier needed), plain click adds an event.
      const over = (plotRef.current as any).over as HTMLDivElement
      type Drag =
        | { kind: 'cursor-edge'; edge: 'start' | 'end' }
        | { kind: 'cursor-band'; startPxX: number; startStart: number; startEnd: number }
        | {
            kind: 'maybe-pan'
            startPxX: number; startPxY: number
            xMin: number; xMax: number; yMin: number; yMax: number
            panning: boolean
          }
      let drag: Drag | null = null
      const EDGE_PX = 6
      const DRAG_THRESHOLD_PX = 3

      const pxToX = (px: number) => {
        const u = plotRef.current!
        return u.posToVal(px, 'x')
      }
      const findCursorHit = (pxX: number) => {
        const u = plotRef.current!
        const c = cursorsRef.current
        const aPx = u.valToPos(c.baselineStart, 'x', false)
        const bPx = u.valToPos(c.baselineEnd, 'x', false)
        const [lo, hi] = aPx <= bPx ? [aPx, bPx] : [bPx, aPx]
        if (Math.abs(pxX - aPx) <= EDGE_PX) return { kind: 'cursor-edge' as const, edge: 'start' as const }
        if (Math.abs(pxX - bPx) <= EDGE_PX) return { kind: 'cursor-edge' as const, edge: 'end' as const }
        if (pxX >= lo + EDGE_PX && pxX <= hi - EDGE_PX) {
          return { kind: 'cursor-band' as const }
        }
        return null
      }

      const onPointerDown = (ev: PointerEvent) => {
        if (ev.button !== 0) return
        const u = plotRef.current
        if (!u) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top

        // Priority 1: cursor band / edge.
        const ch = findCursorHit(pxX)
        if (ch) {
          if (ch.kind === 'cursor-band') {
            const c = cursorsRef.current
            drag = {
              kind: 'cursor-band',
              startPxX: pxX, startStart: c.baselineStart, startEnd: c.baselineEnd,
            }
            over.style.cursor = 'move'
          } else {
            drag = { kind: 'cursor-edge', edge: ch.edge }
            over.style.cursor = 'ew-resize'
          }
          over.setPointerCapture(ev.pointerId)
          ev.preventDefault()
          return
        }

        // Priority 2: click near an event marker → prime / discard
        // (no drag state — a plain click toggles prime / confirm).
        const e = entryRef.current
        if (e) {
          let hit = -1
          let hitDist = Infinity
          for (let i = 0; i < e.events.length; i++) {
            const ev0 = e.events[i]
            const mx = u.valToPos(ev0.peakTimeS, 'x', false)
            const my = u.valToPos(ev0.peakVal, 'y', false)
            const d = Math.hypot(mx - pxX, my - pxY)
            if (d < hitDist && d < 10) { hit = i; hitDist = d }
          }
          if (hit >= 0) {
            if (primedDiscardIdxRef.current === hit) {
              primedDiscardIdxRef.current = null
              onDiscardEvent(hit)
            } else {
              primedDiscardIdxRef.current = hit
              plotRef.current?.redraw()
            }
            ev.preventDefault()
            return
          }
        }

        // Priority 3: empty-space — start click-or-pan state.
        const xMin = u.scales.x.min, xMax = u.scales.x.max
        const yMin = u.scales.y.min, yMax = u.scales.y.max
        if (xMin == null || xMax == null || yMin == null || yMax == null) return
        drag = {
          kind: 'maybe-pan',
          startPxX: pxX, startPxY: pxY,
          xMin, xMax, yMin, yMax,
          panning: false,
        }
        over.setPointerCapture(ev.pointerId)
      }

      const onPointerMove = (ev: PointerEvent) => {
        const u = plotRef.current
        if (!u) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        if (!drag) {
          const hit = findCursorHit(pxX)
          over.style.cursor = !hit ? '' : (hit.kind === 'cursor-edge' ? 'ew-resize' : 'move')
          return
        }
        if (drag.kind === 'cursor-edge') {
          const x = pxToX(pxX)
          updateCursors(drag.edge === 'start'
            ? { baselineStart: x }
            : { baselineEnd: x })
          return
        }
        if (drag.kind === 'cursor-band') {
          const dx = pxToX(pxX) - pxToX(drag.startPxX)
          updateCursors({
            baselineStart: drag.startStart + dx,
            baselineEnd: drag.startEnd + dx,
          })
          return
        }
        if (drag.kind === 'maybe-pan') {
          const dxPx = pxX - drag.startPxX
          const dyPx = pxY - drag.startPxY
          if (!drag.panning
              && Math.abs(dxPx) < DRAG_THRESHOLD_PX
              && Math.abs(dyPx) < DRAG_THRESHOLD_PX) {
            return
          }
          drag.panning = true
          const bboxW = u.bbox.width / (devicePixelRatio || 1)
          const bboxH = u.bbox.height / (devicePixelRatio || 1)
          const dx = -(dxPx / bboxW) * (drag.xMax - drag.xMin)
          const dy = (dyPx / bboxH) * (drag.yMax - drag.yMin)
          const nx: [number, number] = [drag.xMin + dx, drag.xMax + dx]
          const ny: [number, number] = [drag.yMin + dy, drag.yMax + dy]
          xRangeRef.current = nx
          yRangeRef.current = ny
          u.setScale('x', { min: nx[0], max: nx[1] })
          u.setScale('y', { min: ny[0], max: ny[1] })
          setViewport({ tStart: nx[0], tEnd: nx[1] })
          over.style.cursor = 'grabbing'
          return
        }
      }
      const onPointerUp = (ev: PointerEvent) => {
        if (!drag) return
        // Narrow before reading .panning.
        const clickCandidate = drag.kind === 'maybe-pan' && !drag.panning
        drag = null
        try { over.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
        over.style.cursor = ''
        // If the pointer never moved past the threshold, treat as a plain
        // click → add a manual event at the click time.
        if (clickCandidate) {
          const rect = over.getBoundingClientRect()
          const pxX = ev.clientX - rect.left
          const tClick = pxToX(pxX)
          primedDiscardIdxRef.current = null
          if (isFinite(tClick)) onAddEvent(tClick)
        }
      }
      const onWheel = (ev: WheelEvent) => {
        ev.preventDefault()
        const u = plotRef.current
        if (!u) return
        const rect = over.getBoundingClientRect()
        const pxX = ev.clientX - rect.left
        const pxY = ev.clientY - rect.top
        const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2
        if (ev.altKey) {
          const yMin = u.scales.y.min, yMax = u.scales.y.max
          if (yMin == null || yMax == null) return
          const yAt = u.posToVal(pxY, 'y')
          yRangeRef.current = [yAt - (yAt - yMin) * factor, yAt + (yMax - yAt) * factor]
          u.setScale('y', { min: yRangeRef.current[0], max: yRangeRef.current[1] })
        } else {
          const xMin = u.scales.x.min, xMax = u.scales.x.max
          if (xMin == null || xMax == null) return
          const xAt = u.posToVal(pxX, 'x')
          const nMin = xAt - (xAt - xMin) * factor
          const nMax = xAt + (xMax - xAt) * factor
          xRangeRef.current = [nMin, nMax]
          u.setScale('x', { min: nMin, max: nMax })
          setViewport({ tStart: nMin, tEnd: nMax })
        }
      }

      over.addEventListener('pointerdown', onPointerDown)
      over.addEventListener('pointermove', onPointerMove)
      over.addEventListener('pointerup', onPointerUp)
      over.addEventListener('pointercancel', onPointerUp)
      over.addEventListener('wheel', onWheel, { passive: false })
      ;(plotRef.current as any)._teardownEvents = () => {
        over.removeEventListener('pointerdown', onPointerDown)
        over.removeEventListener('pointermove', onPointerMove)
        over.removeEventListener('pointerup', onPointerUp)
        over.removeEventListener('pointercancel', onPointerUp)
        over.removeEventListener('wheel', onWheel)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [data, dm, drawOverlays, updateCursors, onAddEvent, onDiscardEvent, setViewport])

  // ResizeObserver: keep uPlot sized to container.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth, h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
  }, [heightSignal])

  // Redraw overlays when cursors / entry / params change.
  useEffect(() => { plotRef.current?.redraw() }, [cursors, entry, params])

  return (
    <div ref={rootRef} style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
      position: 'relative',
    }}>
      <ViewportBar
        viewport={viewport}
        sweepDuration={sweepDurationS}
        setViewport={setViewport}
        shiftViewport={shiftViewport}
        goHome={goHome} goEnd={goEnd}
      />
      <div style={{
        padding: '3px 8px', fontSize: 'var(--font-size-xs)',
        color: 'var(--text-muted)', background: 'var(--bg-secondary)',
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: '1px solid var(--border)',
      }}>
        <span>Sweep {sweep + 1}{entry ? ` · ${entry.events.length} events` : ''}</span>
        <span style={{ marginLeft: 'auto', fontStyle: 'italic' }}>
          drag empty: pan · click empty: add event · click marker:
          prime / discard · drag cursor band: move · wheel: zoom
        </span>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 120 }} />
      <ViewportSlider viewport={viewport} sweepDuration={sweepDurationS} setViewport={setViewport} />
      {err && (
        <div style={{
          position: 'absolute', top: 30, left: 10,
          padding: '4px 8px', background: 'rgba(92, 27, 27, 0.9)',
          color: '#fff', borderRadius: 3,
          fontSize: 'var(--font-size-xs)',
        }}>
          ⚠ Trace load failed: {err}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------

function EventsResultsTable({
  entry,
  onSelect, onDiscard,
}: {
  entry: EventsData | undefined
  onSelect: (idx: number) => void
  onDiscard: (idx: number) => void
}) {
  if (!entry || entry.events.length === 0) {
    return (
      <div style={{
        padding: 16, textAlign: 'center',
        color: 'var(--text-muted)', fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
      }}>
        {entry
          ? 'No events detected. Try lowering the cutoff / amplitude threshold.'
          : 'Run detection to populate the events table.'}
      </div>
    )
  }
  const unit = entry.units
  return (
    <table style={{
      width: '100%', borderCollapse: 'collapse',
      fontSize: 'var(--font-size-xs)', fontFamily: 'var(--font-mono)',
    }}>
      <thead>
        <tr>
          {['#', 'Time (s)', `Amp (${unit})`, 'Rise (ms)', 'Decay (ms)',
            'FWHM (ms)', `AUC (${unit}·s)`, ''].map((h, i) => (
            <th key={i} style={{
              padding: '3px 6px', textAlign: 'left',
              borderBottom: '1px solid var(--border)',
              color: 'var(--text-secondary)', fontWeight: 500,
              position: 'sticky', top: 0,
              background: 'var(--bg-primary)', whiteSpace: 'nowrap',
            }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entry.events.map((e: EventRow, i: number) => (
          <tr key={i}
            onClick={() => onSelect(i)}
            style={{
              cursor: 'pointer',
              background: i === entry.selectedIdx
                ? 'var(--accent-muted, rgba(100,181,246,0.15))'
                : (i % 2 === 0 ? 'transparent' : 'var(--bg-secondary)'),
              fontStyle: e.manual ? 'italic' : 'normal',
            }}>
            <td style={td}>{i + 1}{e.manual ? ' *' : ''}</td>
            <td style={td}>{e.peakTimeS.toFixed(4)}</td>
            <td style={td}>{e.amplitude.toFixed(2)}</td>
            <td style={td}>{e.riseTimeMs != null ? e.riseTimeMs.toFixed(2) : '—'}</td>
            <td style={td}>{e.decayTimeMs != null ? e.decayTimeMs.toFixed(2) : '—'}</td>
            <td style={td}>{e.halfWidthMs != null ? e.halfWidthMs.toFixed(2) : '—'}</td>
            <td style={td}>{e.auc != null ? e.auc.toFixed(4) : '—'}</td>
            <td style={{ ...td, textAlign: 'right' }}>
              <button className="btn" onClick={(ev) => { ev.stopPropagation(); onDiscard(i) }}
                style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}
                title="Remove this event from the results">
                ✕
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const td: React.CSSProperties = {
  padding: '2px 6px',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function exportEventsCSV(entry: EventsData | undefined, fileName: string) {
  if (!entry || entry.events.length === 0) return
  const unit = entry.units
  const header = [
    '#', 'Sweep', 'Time_s', 'Foot_time_s',
    `Peak_${unit}`, `Baseline_${unit}`, `Amplitude_${unit}`,
    'Rise_ms', 'Decay_ms', 'FWHM_ms', `AUC_${unit}·s`,
    'Manual',
  ]
  const rows = entry.events.map((e, i) => [
    i + 1, e.sweep,
    e.peakTimeS.toFixed(6), e.footTimeS.toFixed(6),
    e.peakVal.toFixed(4), e.baselineVal.toFixed(4), e.amplitude.toFixed(4),
    e.riseTimeMs ?? '', e.decayTimeMs ?? '', e.halfWidthMs ?? '',
    e.auc ?? '',
    e.manual ? 1 : 0,
  ])
  const csv = [header.join(','), ...rows.map((r) => r.join(','))].join('\n')
  const name = fileName.replace(/\.[^.]+$/, '') + '_events.csv'
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
