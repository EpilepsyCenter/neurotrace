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

  // ---- Cross-window navigate ("Zoom to" + table-click from the
  // detached Browser window). The browser sends
  // { type: 'events-navigate-to', timeS, windowS } and we centre our
  // viewport on that timestamp. A small default window (60 ms) lets
  // the user see rise + decay without having to zoom manually.
  useEffect(() => {
    try {
      const ch = new BroadcastChannel('neurotrace-sync')
      ch.onmessage = (ev) => {
        if (ev.data?.type !== 'events-navigate-to') return
        const t = Number(ev.data.timeS)
        const w = Number(ev.data.windowS ?? 0.06)
        if (!isFinite(t) || !isFinite(w) || w <= 0) return
        setViewport((cur) => {
          // Preserve the user's current zoom level when sensible: if
          // the request's window fits in the current viewport, just
          // re-centre; otherwise override with the requested window.
          const curLen = cur ? cur.tEnd - cur.tStart : 0
          const useLen = curLen > 0 && curLen <= 2 * w ? curLen : w
          const dur = sweepDurationS
          let start = t - useLen / 2
          let end = t + useLen / 2
          if (dur > 0) {
            if (start < 0) { end -= start; start = 0 }
            if (end > dur) { start -= (end - dur); end = dur }
            start = Math.max(0, start)
          } else {
            start = Math.max(0, start)
          }
          return { tStart: start, tEnd: end }
        })
      }
      return () => ch.close()
    } catch { /* ignore */ }
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
  // Bottom-pane tab — "table" (events results), "overlay" (all events
  // aligned on peak/foot), or "histogram" (amplitude distribution).
  // Matches EE's tab row below the viewer.
  // Bottom pane is now just the quick-reference views that belong
  // next to the detection controls. The heavy per-event browser + the
  // all-events overlay moved to their own Electron window (see the
  // "Open browser window" button in the results header).
  const [bottomTab, setBottomTab] = useState<
    'table' | 'histogram' | 'rate' | 'ampvstime' | 'iei'
  >('table')
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
  const openEventsBrowser = async () => {
    if (!entry || entry.events.length === 0) {
      setError('Run detection first to open the browser.')
      return
    }
    const api = window.electronAPI
    if (api?.openAnalysisWindow) {
      await api.openAnalysisWindow('events_browser')
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
                additionalTemplateIds={params.additionalTemplateIds ?? []}
                onPickTemplate={(id) => {
                  setParams((p) => ({ ...p, templateId: id }))
                  selectEventsTemplate(id)
                }}
                onPickAdditional={(idx, id) => {
                  setParams((p) => {
                    const next = [...(p.additionalTemplateIds ?? [])]
                    if (id == null) {
                      next.splice(idx, 1)
                    } else {
                      next[idx] = id
                    }
                    // Keep compact — drop any undefined slots.
                    return { ...p, additionalTemplateIds: next.filter(Boolean) }
                  })
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
              {/* Rise-time convention — standard presets (10–90 is the
                  classic e-phys default, 20–80 is less noise-sensitive,
                  37–63 is the "1 τ" span). Custom unlocks the two
                  number fields. Whatever pair is active feeds the per-
                  event `rise_time_ms` calculation. */}
              <Row label="Rise convention">
                <select style={{ width: '100%' }}
                  value={(() => {
                    const lo = params.riseLowPct, hi = params.riseHighPct
                    if (lo === 10 && hi === 90) return '10-90'
                    if (lo === 20 && hi === 80) return '20-80'
                    if (lo === 37 && hi === 63) return '37-63'
                    return 'custom'
                  })()}
                  onChange={(e) => {
                    const v = e.target.value
                    if (v === '10-90') setParams((p) => ({ ...p, riseLowPct: 10, riseHighPct: 90 }))
                    else if (v === '20-80') setParams((p) => ({ ...p, riseLowPct: 20, riseHighPct: 80 }))
                    else if (v === '37-63') setParams((p) => ({ ...p, riseLowPct: 37, riseHighPct: 63 }))
                    // 'custom' leaves the current values in place — user
                    // edits the two fields below, which show inline once
                    // the preset no longer matches.
                  }}>
                  <option value="10-90">10–90 % (default)</option>
                  <option value="20-80">20–80 % (noise-robust)</option>
                  <option value="37-63">37–63 % (1 τ span)</option>
                  <option value="custom">Custom…</option>
                </select>
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

            {/* Exclusion card — matches EE's Exclusion panel. Events
                outside any of these bounds get dropped from the table.
                Null = filter off. Manual-added events bypass these
                guards, so users can force-include a marginal event. */}
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
              <OptionalNumRow
                label="Max AUC" value={params.aucMinAbs} step={0.01} min={0}
                onChange={(v) => setParams((p) => ({ ...p, aucMinAbs: v }))}
                title="Drop events whose integrated area is below this value" />
              <OptionalNumRow
                label="Max rise (ms)" value={params.riseMaxMs} step={0.5} min={0.1}
                onChange={(v) => setParams((p) => ({ ...p, riseMaxMs: v }))}
                title="Drop events with rise time exceeding this value" />
              <OptionalNumRow
                label="Max decay (ms)" value={params.decayMaxMs} step={1} min={0.1}
                onChange={(v) => setParams((p) => ({ ...p, decayMaxMs: v }))}
                title="Drop events with decay time exceeding this value" />
              <OptionalNumRow
                label="Max FWHM (ms)" value={params.fwhmMaxMs} step={1} min={0.1}
                onChange={(v) => setParams((p) => ({ ...p, fwhmMaxMs: v }))}
                title="Drop events with half-width exceeding this value" />
            </Card>

            {/* Skip regions — up to 5 time ranges where detection is
                suppressed (stimulus artifacts, perfusion switches).
                Each entry is independently toggleable so users can
                A/B detection with and without a given region. Drawn
                as red bands on the main viewer; drag edges / bands
                to adjust like the baseline cursors. Sweep-duration-
                anchored, so they persist across re-runs. */}
            <SkipRegionsCard
              params={params}
              setParams={setParams}
              sweepDurationS={sweepDurationS}
              viewport={viewport}
            />
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
              {loading
                ? 'Running…'
                : params.sweepMode === 'all'
                  ? `Run on all sweeps (${totalSweeps})`
                  : 'Run'}
            </button>
            {/* Sweep-mode dropdown — sits directly under the Run
                button so the "what am I about to run on?" is right
                next to the action. Same pattern as the other analysis
                windows. Excluded sweeps (from the CursorPanel) are
                automatically skipped when 'all' is chosen. */}
            <label style={{
              display: 'flex', alignItems: 'center', gap: 4,
              fontSize: 'var(--font-size-label)',
            }}>
              <span style={{ color: 'var(--text-muted)', flex: 1 }}>Run on</span>
              <select value={params.sweepMode} style={{ minWidth: 140 }}
                onChange={(e) => setParams((p) => ({
                  ...p, sweepMode: e.target.value as 'current' | 'all',
                }))}>
                <option value="current">Current sweep only</option>
                <option value="all">All sweeps ({totalSweeps})</option>
              </select>
            </label>
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
              setParams={setParams}
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

          {/* Summary stats — single-line headline, live-updating. */}
          <EventsSummaryBar entry={entry} />

          {/* Bottom tabs: Results (table) / Overlay / Histogram. Tabs
              let us add views without growing the already-busy main
              window vertically. Each tab fills the remaining flex
              space below the summary bar. */}
          <div style={{
            flex: 1, minHeight: 0,
            display: 'flex', flexDirection: 'column',
            marginTop: 4,
            border: '1px solid var(--border)', borderRadius: 4,
            background: 'var(--bg-primary)',
          }}>
            <div style={{
              display: 'flex', gap: 2,
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
              padding: '2px 2px 0 2px',
            }}>
              {(['table', 'histogram', 'iei', 'rate', 'ampvstime'] as const).map((k) => (
                <button key={k} className="btn"
                  onClick={() => setBottomTab(k)}
                  style={{
                    padding: '3px 10px',
                    fontSize: 'var(--font-size-label)',
                    background: bottomTab === k
                      ? 'var(--bg-primary)' : 'transparent',
                    borderBottom: bottomTab === k
                      ? '2px solid var(--accent, #64b5f6)' : '2px solid transparent',
                    borderRadius: '3px 3px 0 0',
                  }}>
                  {k === 'table' ? 'Results'
                    : k === 'histogram' ? 'Amp hist'
                    : k === 'iei' ? 'IEI hist'
                    : k === 'rate' ? 'Rate'
                    : 'Amp vs time'}
                </button>
              ))}
              <span style={{ flex: 1 }} />
              {/* Open the detached Browser + Overlay window. Lives
                  flush-right on the tab bar for easy one-click access
                  once the user has run detection. */}
              <button className="btn"
                onClick={openEventsBrowser}
                disabled={!entry || entry.events.length === 0}
                title="Open the detached Browser & Overlay window"
                style={{
                  padding: '3px 10px', marginBottom: 2,
                  fontSize: 'var(--font-size-label)',
                  alignSelf: 'center',
                }}>
                Open browser + overlay…
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              {bottomTab === 'table' && (
                <div style={{ height: '100%', overflow: 'auto' }}>
                  <EventsResultsTable
                    entry={entry}
                    onSelect={(idx) => {
                      // Mark selected + zoom to event. In cross-sweep
                      // mode the clicked row may belong to a different
                      // sweep than the one currently shown — switch to
                      // that sweep first so the viewport applies to
                      // the right trace.
                      selectEvent(group, series, idx)
                      const e = entry?.events[idx]
                      if (e) {
                        if (e.sweep !== sweep) setSweep(e.sweep)
                        const useLen = viewport
                          && viewport.tEnd - viewport.tStart > 0
                          && viewport.tEnd - viewport.tStart <= 0.12
                            ? viewport.tEnd - viewport.tStart
                            : 0.06
                        let start = e.peakTimeS - useLen / 2
                        let end = e.peakTimeS + useLen / 2
                        const dur = sweepDurationS
                        if (dur > 0) {
                          if (start < 0) { end -= start; start = 0 }
                          if (end > dur) { start -= (end - dur); end = dur }
                          start = Math.max(0, start)
                        } else { start = Math.max(0, start) }
                        setViewport({ tStart: start, tEnd: end })
                      }
                    }}
                    onDiscard={(idx) => onDiscardEvent(idx)}
                  />
                </div>
              )}
              {/* Browser + Overlay tabs were moved to a dedicated
                  Electron window — see the "Open browser + overlay"
                  button on this tab bar. */}
              {bottomTab === 'histogram' && (
                <AmplitudeHistogram
                  entry={entry}
                  heightSignal={plotHeight}
                />
              )}
              {bottomTab === 'rate' && (
                <EventRatePlot
                  entry={entry}
                  heightSignal={plotHeight}
                />
              )}
              {bottomTab === 'ampvstime' && (
                <AmpVsTimeScatter
                  entry={entry}
                  heightSignal={plotHeight}
                />
              )}
              {bottomTab === 'iei' && (
                <IEIHistogram
                  entry={entry}
                  heightSignal={plotHeight}
                />
              )}
            </div>
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

/** A nullable-number row with a small checkbox-style enable toggle.
 *  Null = filter off (checkbox unchecked); number = filter on with
 *  that value. Lets the user turn each kinetic-max filter on or off
 *  without having to nuke the value when disabling. */
function OptionalNumRow({
  label, value, step, min, onChange, title,
}: {
  label: string
  value: number | null
  step?: number; min?: number
  onChange: (v: number | null) => void
  title?: string
}) {
  const enabled = value != null
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}
           title={title}>
      <input type="checkbox" checked={enabled}
        onChange={(e) => onChange(e.target.checked
          ? (value ?? (step ?? 1) * 10) : null)} />
      <span style={{
        color: enabled ? undefined : 'var(--text-muted)',
        flex: 1, opacity: enabled ? 1 : 0.6,
      }}>{label}</span>
      <span style={{ minWidth: 80 }}>
        <NumInput
          value={value ?? 0}
          step={step} min={min}
          onChange={(v) => onChange(v)}
        />
      </span>
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
// Skip-regions card — up to 5 time ranges where detection is
// suppressed. Each has its own enable checkbox + start / end inputs
// + delete button. "From cursors" sets the region to the current
// baseline cursor span so users don't always have to type numbers.
// The regions also draw as translucent red bands on the main events
// viewer, with edge/band drag support (see SkipRegionHandle refs).
// ---------------------------------------------------------------------------

const MAX_SKIP_REGIONS = 5

function SkipRegionsCard({
  params, setParams, sweepDurationS, viewport,
}: {
  params: EventsParams
  setParams: React.Dispatch<React.SetStateAction<EventsParams>>
  sweepDurationS: number
  viewport: Viewport
}) {
  const regions = params.skipRegions ?? []
  const [collapsed, setCollapsed] = useState(true)
  const { cursors } = useAppStore()
  // Collapsed by default — skip regions are a power-user feature, no
  // need to take sidebar space until the user cares. Count badge on
  // the header tells them at a glance whether any are configured.
  const enabledCount = regions.filter((r) => r.enabled).length

  const update = (i: number, patch: Partial<typeof regions[number]>) => {
    setParams((p) => {
      const next = [...(p.skipRegions ?? [])]
      next[i] = { ...next[i], ...patch }
      return { ...p, skipRegions: next }
    })
  }
  const addRegion = () => {
    setParams((p) => {
      const prev = p.skipRegions ?? []
      if (prev.length >= MAX_SKIP_REGIONS) return p
      // Place the new region in the middle 20% of the current view,
      // so the user can see it immediately and drag to refine.
      const vp = viewport ?? { tStart: 0, tEnd: sweepDurationS || 10 }
      const len = Math.max(1e-3, vp.tEnd - vp.tStart)
      const startS = vp.tStart + 0.40 * len
      const endS = vp.tStart + 0.60 * len
      return {
        ...p,
        skipRegions: [...prev, { enabled: true, startS, endS }],
      }
    })
    setCollapsed(false)
  }
  const removeRegion = (i: number) => {
    setParams((p) => ({
      ...p,
      skipRegions: (p.skipRegions ?? []).filter((_, k) => k !== i),
    }))
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: 8, border: '1px solid var(--border)', borderRadius: 4,
      background: 'var(--bg-primary)',
      fontSize: 'var(--font-size-label)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        cursor: 'pointer',
      }} onClick={() => setCollapsed((v) => !v)}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
          Skip regions {enabledCount > 0 ? `(${enabledCount})` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{
          color: 'var(--text-muted)',
          transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s',
          display: 'inline-block',
        }}>▾</span>
      </div>
      {!collapsed && (
        <>
          {regions.length === 0 && (
            <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Detection is never suppressed. Add a region to exclude a
              time range — useful for stimulus artifacts.
            </span>
          )}
          {regions.map((r, i) => (
            <div key={i} style={{
              display: 'flex', flexDirection: 'column', gap: 4,
              padding: 6, borderRadius: 3,
              background: r.enabled ? 'rgba(229,115,115,0.1)' : 'var(--bg-secondary)',
              border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={r.enabled}
                  onChange={(e) => update(i, { enabled: e.target.checked })} />
                <span style={{ fontWeight: 600, flex: 1 }}>Region {i + 1}</span>
                <button className="btn"
                  title="Set this region to the current baseline-cursor span"
                  onClick={() => update(i, {
                    startS: Math.min(cursors.baselineStart, cursors.baselineEnd),
                    endS: Math.max(cursors.baselineStart, cursors.baselineEnd),
                  })}
                  style={{ padding: '1px 6px', fontSize: 10 }}>
                  from cursors
                </button>
                <button className="btn"
                  onClick={() => removeRegion(i)}
                  style={{ padding: '1px 6px', fontSize: 10 }}
                  title="Remove this region">✕</button>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, flex: 1 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Start (s)</span>
                  <NumInput value={r.startS} step={0.1} min={0}
                    onChange={(v) => update(i, { startS: v })} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 3, flex: 1 }}>
                  <span style={{ color: 'var(--text-muted)' }}>End (s)</span>
                  <NumInput value={r.endS} step={0.1} min={0}
                    onChange={(v) => update(i, { endS: v })} />
                </label>
              </div>
            </div>
          ))}
          <button className="btn"
            disabled={regions.length >= MAX_SKIP_REGIONS}
            onClick={addRegion}
            style={{ padding: '3px 6px', marginTop: 2 }}
            title={regions.length >= MAX_SKIP_REGIONS
              ? `Max ${MAX_SKIP_REGIONS} skip regions`
              : 'Add a new skip region centred in the current view'}>
            + Add region ({regions.length}/{MAX_SKIP_REGIONS})
          </button>
        </>
      )}
    </div>
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
      {/* Detrend (rolling-median subtraction) — applied BEFORE the
          Butterworth filter. Both can be on at once: detrend handles
          slow drift, filter handles high-frequency noise. */}
      <div style={{
        marginTop: 4, paddingTop: 4,
        borderTop: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}
          title="Subtract a rolling median before detection; flattens slow drift">
          <input type="checkbox" checked={params.detrendEnabled}
            onChange={(e) => setParams((p) => ({ ...p, detrendEnabled: e.target.checked }))} />
          <span>Detrend (rolling median)</span>
        </label>
        {params.detrendEnabled && (
          <Row label="Window (ms)">
            <NumInput value={params.detrendWindowMs} step={50} min={10}
              onChange={(v) => setParams((p) => ({ ...p, detrendWindowMs: v }))} />
          </Row>
        )}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Template panel
// ---------------------------------------------------------------------------

/** Miniature SVG preview of a biexponential template, rendered over a
 *  fixed 60 × 18 viewport. Handy for library listings where users
 *  want to pick by shape ("the fast one" / "the slow one") before
 *  looking at coefficients. */
function TemplateThumbnail({
  template, width = 60, height = 18, stroke = '#64b5f6',
}: {
  template: EventsTemplate
  width?: number; height?: number; stroke?: string
}) {
  const { b0, b1, tauRiseMs, tauDecayMs, widthMs } = template
  const n = 64
  const ys: number[] = []
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (widthMs / 1000.0)
    const rise = 1 - Math.exp(-t / Math.max(tauRiseMs / 1000, 1e-6))
    const decay = Math.exp(-t / Math.max(tauDecayMs / 1000, 1e-6))
    const y = b0 + b1 * rise * decay
    ys.push(y)
    if (y < lo) lo = y
    if (y > hi) hi = y
  }
  if (hi === lo) { hi = lo + 1 }
  const pts = ys.map((y, i) => {
    const x = (i / (n - 1)) * width
    const py = height - ((y - lo) / (hi - lo)) * (height - 2) - 1
    return `${x.toFixed(1)},${py.toFixed(1)}`
  }).join(' ')
  return (
    <svg width={width} height={height}
         style={{ verticalAlign: 'middle', flexShrink: 0 }}>
      <polyline points={pts}
        fill="none" stroke={stroke} strokeWidth={1.2} />
    </svg>
  )
}

function TemplatePanel({
  templates, activeTemplateId, activeTemplate,
  additionalTemplateIds,
  onPickTemplate,
  onPickAdditional,
  onOpenGenerator, onOpenRefinement,
  canRefine,
}: {
  templates: Record<string, EventsTemplate>
  activeTemplateId: string | null
  activeTemplate: EventsTemplate | null
  additionalTemplateIds: string[]
  onPickTemplate: (id: string) => void
  /** Set the additional-template slot at ``index`` (0 or 1). Passing
   *  ``null`` clears that slot; the rest shift down to keep the list
   *  compact. */
  onPickAdditional: (index: number, id: string | null) => void
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
  const libEntries = Object.values(templates)
  const usedIds = new Set(
    [activeTemplateId, ...additionalTemplateIds].filter(Boolean) as string[])
  // Second slot is always visible; third only when the second is set,
  // so users aren't confronted with empty rows they don't need.
  const slot2 = additionalTemplateIds[0] ?? null
  const slot3 = additionalTemplateIds[1] ?? null
  return (
    <Card title="Template">
      <Row label="Primary">
        <select value={activeTemplateId ?? ''} style={{ width: '100%' }}
          onChange={(e) => { if (e.target.value) onPickTemplate(e.target.value) }}>
          <option value="" disabled>— pick —</option>
          {libEntries.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </Row>
      {activeTemplate && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <TemplateThumbnail template={activeTemplate}
            stroke={activeTemplate.direction === 'negative' ? '#e57373' : '#64b5f6'} />
          <div style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
            fontSize: 'var(--font-size-label)',
            lineHeight: 1.5,
          }}>
            τ {activeTemplate.tauRiseMs.toFixed(2)} / {activeTemplate.tauDecayMs.toFixed(1)} ms<br />
            b0 {activeTemplate.b0.toFixed(1)} · b1 {activeTemplate.b1.toFixed(1)}
          </div>
        </div>
      )}
      {/* Additional slots — EE-style 2nd and 3rd templates that get
          merged into detection. Primary template carries the overlay;
          additional ones contribute peaks via pointwise-max (corr) or
          union (deconv). */}
      <Row label="+ 2nd">
        <select value={slot2 ?? ''} style={{ width: '100%' }}
          onChange={(e) => onPickAdditional(0, e.target.value || null)}>
          <option value="">— none —</option>
          {libEntries
            .filter((t) => !usedIds.has(t.id) || t.id === slot2)
            .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Row>
      {slot2 && (
        <Row label="+ 3rd">
          <select value={slot3 ?? ''} style={{ width: '100%' }}
            onChange={(e) => onPickAdditional(1, e.target.value || null)}>
            <option value="">— none —</option>
            {libEntries
              .filter((t) => !usedIds.has(t.id) || t.id === slot3)
              .map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Row>
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
        {/* Library import/export — JSON round-trip for sharing
            templates between datasets / users. */}
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn" onClick={() => exportTemplatesJSON(templates)}
            disabled={libEntries.length === 0}
            style={{ flex: 1, padding: '3px 6px', fontSize: 'var(--font-size-label)' }}
            title="Download all library templates as a JSON file">
            Export JSON
          </button>
          <button className="btn" onClick={() => importTemplatesJSON()}
            style={{ flex: 1, padding: '3px 6px', fontSize: 'var(--font-size-label)' }}
            title="Load templates from a JSON file, merging into the library">
            Import JSON
          </button>
        </div>
      </div>
    </Card>
  )
}

/** Download the whole template library as a JSON file. */
function exportTemplatesJSON(entries: Record<string, EventsTemplate>) {
  const payload = {
    format: 'neurotrace-event-templates',
    version: 1,
    templates: Object.values(entries),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'neurotrace_event_templates.json'
  a.click()
  URL.revokeObjectURL(url)
}

/** Open a file picker for a JSON template file and merge into the
 *  library. Duplicate IDs are skipped (existing entries win); duplicate
 *  names get a suffix. */
function importTemplatesJSON() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'
  input.onchange = () => {
    const f = input.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        const items: any[] = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.templates) ? parsed.templates : []
        const store = useAppStore.getState()
        const existing = store.eventsTemplates.entries
        const existingNames = new Set(Object.values(existing).map((t) => t.name))
        let imported = 0
        for (const raw of items) {
          if (!raw || typeof raw !== 'object') continue
          const id = typeof raw.id === 'string' && raw.id.length > 0
            ? raw.id : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
          if (existing[id]) continue          // don't clobber existing
          let name = typeof raw.name === 'string' ? raw.name : 'Imported template'
          if (existingNames.has(name)) name = `${name} (imported)`
          const t: EventsTemplate = {
            id,
            name,
            b0: Number(raw.b0 ?? 0),
            b1: Number(raw.b1 ?? -30),
            tauRiseMs: Number(raw.tauRiseMs ?? 0.5),
            tauDecayMs: Number(raw.tauDecayMs ?? 5),
            widthMs: Number(raw.widthMs ?? 30),
            direction: raw.direction === 'positive' ? 'positive' : 'negative',
          }
          store.saveEventsTemplate(t)
          existingNames.add(name)
          imported++
        }
        alert(`Imported ${imported} template${imported === 1 ? '' : 's'}.`)
      } catch (e) {
        alert(`Import failed: ${e}`)
      }
    }
    reader.readAsText(f)
  }
  input.click()
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
  backendUrl, group, series, channel, sweep, entry, params, setParams,
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
  /** Updater for params — needed so skip-region edge / band drags
   *  can write back the new start / end times. */
  setParams: React.Dispatch<React.SetStateAction<EventsParams>>
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
  // Route pointer-handler callbacks through refs so changing their
  // identity (e.g. the parent re-creating onAddEvent when `entry`
  // updates) doesn't tear down and rebuild the uPlot instance. Event
  // add/discard is a frequent action in normal use — without this, the
  // whole plot + event listeners get reconstructed on every edit.
  const onAddEventRef = useRef(onAddEvent)
  onAddEventRef.current = onAddEvent
  const onDiscardEventRef = useRef(onDiscardEvent)
  onDiscardEventRef.current = onDiscardEvent
  const setParamsRef = useRef(setParams)
  setParamsRef.current = setParams
  const setViewportRef = useRef(setViewport)
  setViewportRef.current = setViewport
  const updateCursorsRef = useRef(updateCursors)
  updateCursorsRef.current = updateCursors

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

    // Skip-region bands (translucent red). Drawn only for regions the
    // user has enabled; disabled ones are kept as outlined ghosts so
    // the user can still see where they'd fall when toggling. Drag
    // edges / bands like the baseline cursor — see pointer handler.
    const skips = p.skipRegions ?? []
    if (skips.length > 0) {
      for (let i = 0; i < skips.length; i++) {
        const r = skips[i]
        if (r.endS <= r.startS) continue
        const a = u.valToPos(r.startS, 'x', true)
        const b = u.valToPos(r.endS, 'x', true)
        if (!isFinite(a) || !isFinite(b)) continue
        ctx.save()
        if (r.enabled) {
          ctx.globalAlpha = 0.18
          ctx.fillStyle = '#e57373'
          ctx.fillRect(
            Math.min(a, b), u.bbox.top,
            Math.abs(b - a), u.bbox.height,
          )
          ctx.globalAlpha = 0.85
          ctx.strokeStyle = '#e57373'
          ctx.lineWidth = 1.5 * dpr
        } else {
          ctx.globalAlpha = 0.35
          ctx.strokeStyle = '#e57373'
          ctx.lineWidth = 1 * dpr
          ctx.setLineDash([4 * dpr, 3 * dpr])
        }
        ctx.beginPath()
        ctx.moveTo(a, u.bbox.top); ctx.lineTo(a, u.bbox.top + u.bbox.height)
        ctx.moveTo(b, u.bbox.top); ctx.lineTo(b, u.bbox.top + u.bbox.height)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1
        ctx.fillStyle = '#e57373'
        ctx.font = `bold ${10 * dpr}px ${cssVar('--font-mono')}`
        ctx.fillText(`skip ${i + 1}${r.enabled ? '' : ' (off)'}`,
          Math.min(a, b) + 2 * dpr, u.bbox.top + 24 * dpr)
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
        | { kind: 'skip-edge'; index: number; edge: 'start' | 'end' }
        | { kind: 'skip-band'; index: number; startPxX: number; startStart: number; startEnd: number }
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
      // Hit-test any enabled skip region. Only enabled regions are
      // draggable — disabled ones show as dashed ghosts and ignore
      // pointer events, so toggling a region off doesn't stop you
      // from click-adding events inside it.
      const findSkipHit = (pxX: number) => {
        const u = plotRef.current!
        const skips = paramsRef.current.skipRegions ?? []
        for (let i = 0; i < skips.length; i++) {
          const r = skips[i]
          if (!r.enabled || r.endS <= r.startS) continue
          const aPx = u.valToPos(r.startS, 'x', false)
          const bPx = u.valToPos(r.endS, 'x', false)
          const [lo, hi] = aPx <= bPx ? [aPx, bPx] : [bPx, aPx]
          if (Math.abs(pxX - aPx) <= EDGE_PX) {
            return { kind: 'skip-edge' as const, index: i, edge: 'start' as const }
          }
          if (Math.abs(pxX - bPx) <= EDGE_PX) {
            return { kind: 'skip-edge' as const, index: i, edge: 'end' as const }
          }
          if (pxX >= lo + EDGE_PX && pxX <= hi - EDGE_PX) {
            return { kind: 'skip-band' as const, index: i }
          }
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

        // Priority 1b: skip-region band / edge. Checked AFTER baseline
        // cursor so baseline cursor hits always win when both overlap
        // — users reach for the blue band more often.
        const sh = findSkipHit(pxX)
        if (sh) {
          const skips = paramsRef.current.skipRegions ?? []
          const r = skips[sh.index]
          if (sh.kind === 'skip-band') {
            drag = {
              kind: 'skip-band', index: sh.index,
              startPxX: pxX, startStart: r.startS, startEnd: r.endS,
            }
            over.style.cursor = 'move'
          } else {
            drag = { kind: 'skip-edge', index: sh.index, edge: sh.edge }
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
              onDiscardEventRef.current(hit)
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
          // Hover-cursor-shape hint: edge→resize, band→move. Check
          // skip regions first so you see the ew-resize cursor when
          // hovering a skip edge (otherwise it'd fall through to no
          // cursor and users wouldn't realise they can drag).
          const sHit = findSkipHit(pxX)
          if (sHit) {
            over.style.cursor = sHit.kind === 'skip-edge' ? 'ew-resize' : 'move'
            return
          }
          const hit = findCursorHit(pxX)
          over.style.cursor = !hit ? '' : (hit.kind === 'cursor-edge' ? 'ew-resize' : 'move')
          return
        }
        if (drag.kind === 'cursor-edge') {
          const x = pxToX(pxX)
          updateCursorsRef.current(drag.edge === 'start'
            ? { baselineStart: x }
            : { baselineEnd: x })
          return
        }
        if (drag.kind === 'cursor-band') {
          const dx = pxToX(pxX) - pxToX(drag.startPxX)
          updateCursorsRef.current({
            baselineStart: drag.startStart + dx,
            baselineEnd: drag.startEnd + dx,
          })
          return
        }
        if (drag.kind === 'skip-edge') {
          const x = pxToX(pxX)
          const idx = drag.index
          const edge = drag.edge
          setParamsRef.current((p) => {
            const next = [...(p.skipRegions ?? [])]
            if (!next[idx]) return p
            if (edge === 'start') {
              // Prevent start from crossing end — clamp to end-ε.
              next[idx] = { ...next[idx], startS: Math.min(x, next[idx].endS - 1e-4) }
            } else {
              next[idx] = { ...next[idx], endS: Math.max(x, next[idx].startS + 1e-4) }
            }
            return { ...p, skipRegions: next }
          })
          return
        }
        if (drag.kind === 'skip-band') {
          const dx = pxToX(pxX) - pxToX(drag.startPxX)
          const idx = drag.index
          const ns = drag.startStart + dx
          const ne = drag.startEnd + dx
          setParamsRef.current((p) => {
            const next = [...(p.skipRegions ?? [])]
            if (!next[idx]) return p
            next[idx] = { ...next[idx], startS: ns, endS: ne }
            return { ...p, skipRegions: next }
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
          setViewportRef.current({ tStart: nx[0], tEnd: nx[1] })
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
          if (isFinite(tClick)) onAddEventRef.current(tClick)
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
          setViewportRef.current({ tStart: nMin, tEnd: nMax })
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
    // NOTE: pointer-handler callbacks are routed through refs above so
    // we can leave them out of the deps. Otherwise every state change
    // in the parent that touches `entry` / `params` would re-create
    // the callbacks and force a full uPlot teardown + rebuild — which
    // is what made adding a manual event or scrolling with many markers
    // feel like the whole trace was being recomputed.
  }, [data, dm, drawOverlays])

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

// ---------------------------------------------------------------------------
// Summary stats — single-line headline above the table. Mirrors EE's
// "Summary" pane: n events, mean amp ± SD, mean rise / decay / FWHM,
// frequency (Hz), mean IEI. Computed inline from entry.events; updates
// live as the user discards / adds manual events.
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN
  let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]
  return s / xs.length
}
function sd(xs: number[]): number {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  let s = 0; for (let i = 0; i < xs.length; i++) { const d = xs[i] - m; s += d * d }
  return Math.sqrt(s / (xs.length - 1))
}

function EventsSummaryBar({ entry }: { entry: EventsData | undefined }) {
  if (!entry || entry.events.length === 0) return null
  const amps = entry.events.map((e) => e.amplitude)
  const rises = entry.events.map((e) => e.riseTimeMs).filter((v): v is number => v != null)
  const decays = entry.events.map((e) => e.decayTimeMs).filter((v): v is number => v != null)
  const fwhms = entry.events.map((e) => e.halfWidthMs).filter((v): v is number => v != null)
  const iei: number[] = []
  for (let i = 1; i < entry.events.length; i++) {
    iei.push(entry.events[i].peakTimeS - entry.events[i - 1].peakTimeS)
  }
  // Use totalLengthS for cross-sweep rates — in single-sweep mode it
  // equals sweepLengthS, so there's no behaviour change there.
  const denomS = entry.totalLengthS || entry.sweepLengthS
  const freqHz = denomS > 0 ? entry.events.length / denomS : NaN
  const u = entry.units
  const fmt = (v: number, p = 2) => (Number.isFinite(v) ? v.toFixed(p) : '—')
  const cell: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 1,
    fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)',
    padding: '3px 8px', borderRight: '1px solid var(--border)',
    whiteSpace: 'nowrap',
  }
  const lbl: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 10 }
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', flexWrap: 'wrap',
      background: 'var(--bg-primary)',
      borderTop: '1px solid var(--border)',
      borderBottom: '1px solid var(--border)',
    }}>
      <div style={cell}>
        <span style={lbl}>n events</span>
        <span>{entry.events.length}</span>
      </div>
      <div style={cell}>
        <span style={lbl}>rate (Hz)</span>
        <span>{fmt(freqHz, 2)}</span>
      </div>
      <div style={cell}>
        <span style={lbl}>Amp ({u})</span>
        <span>{fmt(mean(amps))} ± {fmt(sd(amps))}</span>
      </div>
      <div style={cell}>
        <span style={lbl}>Rise (ms)</span>
        <span>{fmt(mean(rises))} ± {fmt(sd(rises))}</span>
      </div>
      <div style={cell}>
        <span style={lbl}>Decay (ms)</span>
        <span>{fmt(mean(decays))} ± {fmt(sd(decays))}</span>
      </div>
      <div style={cell}>
        <span style={lbl}>FWHM (ms)</span>
        <span>{fmt(mean(fwhms))} ± {fmt(sd(fwhms))}</span>
      </div>
      <div style={{ ...cell, borderRight: 'none' }}>
        <span style={lbl}>IEI (ms)</span>
        <span>{fmt(mean(iei) * 1000, 1)} ± {fmt(sd(iei) * 1000, 1)}</span>
      </div>
    </div>
  )
}


// ---------------------------------------------------------------------------
// Amplitude histogram — distribution of event amplitudes with a
// Gaussian fit to the bulk. Useful QC for "am I catching the shoulder
// or the noise?". Counts are per-bin; Gaussian and cutoff line drawn
// in overlay. Computed entirely client-side from entry.events.
// ---------------------------------------------------------------------------

function AmplitudeHistogram({
  entry, heightSignal,
}: {
  entry: EventsData | undefined
  heightSignal: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)

  const stats = useMemo(() => {
    if (!entry || entry.events.length < 5) return null
    const amps = entry.events.map((e) => e.amplitude)
    const n = amps.length
    const m = mean(amps)
    const s = sd(amps) || 1
    const nBins = Math.max(8, Math.min(40, Math.round(Math.sqrt(n))))
    const lo = Math.min(...amps), hi = Math.max(...amps)
    const pad = (hi - lo) * 0.05 || 1
    const minE = lo - pad, maxE = hi + pad
    const bw = (maxE - minE) / nBins
    const counts = new Array<number>(nBins).fill(0)
    for (const a of amps) {
      const k = Math.max(0, Math.min(nBins - 1, Math.floor((a - minE) / bw)))
      counts[k]++
    }
    const centers = new Array<number>(nBins)
    for (let i = 0; i < nBins; i++) centers[i] = minE + (i + 0.5) * bw
    // Gaussian curve — not re-fit; just plot N(μ,σ) scaled to max count.
    const peakCount = Math.max(...counts) || 1
    const gauss = centers.map((x) =>
      peakCount * Math.exp(-0.5 * ((x - m) / s) ** 2))
    return { centers, counts, gauss, mean: m, sd: s, n }
  }, [entry])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!stats) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      // Bars via uPlot paths: use a "bars" pattern by drawing line from
      // bar-top to zero with wide width. Simpler: custom draw hook.
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: {
          x: { time: false },
          y: { range: (_u, _dmin, dmax) => [0, Math.max(1, dmax * 1.1)] },
        },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: `Amplitude (${entry?.units ?? ''})`, labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 50,
            label: 'count',
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [
          {},
          { stroke: cssVar('--trace-color-1'), width: 1.5 },
        ],
        hooks: {
          draw: [(u) => {
            // Draw bars under the line.
            const ctx = u.ctx
            const dpr = devicePixelRatio || 1
            const bw = stats.centers.length > 1
              ? stats.centers[1] - stats.centers[0] : 1
            ctx.save()
            ctx.fillStyle = 'rgba(100,181,246,0.35)'
            for (let i = 0; i < stats.centers.length; i++) {
              const x0 = u.valToPos(stats.centers[i] - bw / 2, 'x', true)
              const x1 = u.valToPos(stats.centers[i] + bw / 2, 'x', true)
              const y0 = u.valToPos(0, 'y', true)
              const y1 = u.valToPos(stats.counts[i], 'y', true)
              ctx.fillRect(Math.min(x0, x1), y1, Math.abs(x1 - x0), y0 - y1)
            }
            // Vertical line at mean.
            const mx = u.valToPos(stats.mean, 'x', true)
            ctx.strokeStyle = '#e57373'
            ctx.lineWidth = 1.5 * dpr
            ctx.setLineDash([4 * dpr, 3 * dpr])
            ctx.beginPath()
            ctx.moveTo(mx, u.bbox.top)
            ctx.lineTo(mx, u.bbox.top + u.bbox.height)
            ctx.stroke()
            ctx.restore()
          }],
        },
      }
      const data: uPlot.AlignedData = [stats.centers, stats.gauss]
      plotRef.current = new uPlot(opts, data, container)
    })
    return () => cancelAnimationFrame(frame)
  }, [stats, entry?.units])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const u = plotRef.current, el = containerRef.current
    if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
  }, [heightSignal])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      minHeight: 0, gap: 6, padding: 6,
    }}>
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center',
        fontSize: 'var(--font-size-label)', flexShrink: 0,
        fontFamily: 'var(--font-mono)',
      }}>
        {stats
          ? (
            <>
              <span>n = {stats.n}</span>
              <span>μ = {stats.mean.toFixed(2)} {entry?.units}</span>
              <span>σ = {stats.sd.toFixed(2)} {entry?.units}</span>
            </>
          )
          : <span style={{ color: 'var(--text-muted)' }}>Need ≥ 5 events.</span>}
      </div>
      <div ref={containerRef} style={{
        flex: 1, minHeight: 0,
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Event rate plot — histogram of event peak times in N bins across
// the sweep duration, reported in Hz. Useful for detecting wash-in /
// wash-out effects over a recording. Bin width is user-adjustable.
// ---------------------------------------------------------------------------

function EventRatePlot({
  entry, heightSignal,
}: {
  entry: EventsData | undefined
  heightSignal: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [binS, setBinS] = useState(5)

  const stats = useMemo(() => {
    if (!entry || entry.events.length === 0 || entry.sweepLengthS <= 0) return null
    const T = entry.sweepLengthS
    const n = Math.max(1, Math.ceil(T / binS))
    const counts = new Array<number>(n).fill(0)
    for (const e of entry.events) {
      const k = Math.max(0, Math.min(n - 1, Math.floor(e.peakTimeS / binS)))
      counts[k]++
    }
    const centers = new Array<number>(n)
    const rates = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      centers[i] = (i + 0.5) * binS
      rates[i] = counts[i] / binS  // Hz
    }
    return { centers, rates }
  }, [entry, binS])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!stats) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: {
          x: { time: false },
          y: { range: (_u, _dmin, dmax) => [0, Math.max(1, dmax * 1.1)] },
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
            size: 50, label: 'Rate (Hz)',
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [{}, { stroke: cssVar('--trace-color-1'), width: 1.5 }],
        hooks: {
          draw: [(u) => {
            // Bars: cleaner PSTH look than a line.
            const ctx = u.ctx
            const bw = stats.centers.length > 1
              ? stats.centers[1] - stats.centers[0] : binS
            ctx.save()
            ctx.fillStyle = 'rgba(100,181,246,0.35)'
            for (let i = 0; i < stats.centers.length; i++) {
              const x0 = u.valToPos(stats.centers[i] - bw / 2, 'x', true)
              const x1 = u.valToPos(stats.centers[i] + bw / 2, 'x', true)
              const y0 = u.valToPos(0, 'y', true)
              const y1 = u.valToPos(stats.rates[i], 'y', true)
              ctx.fillRect(Math.min(x0, x1), y1, Math.abs(x1 - x0), y0 - y1)
            }
            ctx.restore()
          }],
        },
      }
      const payload: uPlot.AlignedData = [stats.centers, stats.rates]
      plotRef.current = new uPlot(opts, payload, container)
    })
    return () => cancelAnimationFrame(frame)
  }, [stats, binS])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const u = plotRef.current, el = containerRef.current
    if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
  }, [heightSignal])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      gap: 6, padding: 6, minHeight: 0,
    }}>
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        fontSize: 'var(--font-size-label)', flexShrink: 0,
      }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>Bin (s)</span>
          <NumInput value={binS} step={1} min={0.5} onChange={setBinS} />
        </label>
        {stats && (
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {stats.centers.length} bins
          </span>
        )}
      </div>
      <div ref={containerRef} style={{
        flex: 1, minHeight: 0,
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }}>
        {(!entry || entry.events.length === 0) && (
          <div style={{
            padding: 16, textAlign: 'center',
            color: 'var(--text-muted)', fontStyle: 'italic',
            fontSize: 'var(--font-size-label)',
          }}>
            Run detection to see the event rate vs time.
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Amplitude-vs-time scatter — one dot per event, x = peak time, y =
// amplitude. Reveals rundown / washout / drug effects at a glance.
// ---------------------------------------------------------------------------

function AmpVsTimeScatter({
  entry, heightSignal,
}: {
  entry: EventsData | undefined
  heightSignal: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)

  const data = useMemo(() => {
    if (!entry || entry.events.length === 0) return null
    const xs: number[] = []
    const ys: number[] = []
    for (const e of entry.events) {
      xs.push(e.peakTimeS)
      ys.push(e.amplitude)
    }
    return { xs, ys }
  }, [entry])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!data) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: { x: { time: false }, y: { auto: true } },
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
            size: 55, label: `Amplitude (${entry?.units ?? ''})`,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        // No connecting line — draw dots directly in hooks.draw.
        series: [{}, { points: { show: false }, stroke: 'rgba(0,0,0,0)' }],
        hooks: {
          draw: [(u) => {
            const ctx = u.ctx
            const dpr = devicePixelRatio || 1
            ctx.save()
            ctx.fillStyle = 'rgba(100,181,246,0.7)'
            for (let i = 0; i < data.xs.length; i++) {
              const px = u.valToPos(data.xs[i], 'x', true)
              const py = u.valToPos(data.ys[i], 'y', true)
              if (!isFinite(px) || !isFinite(py)) continue
              ctx.beginPath()
              ctx.arc(px, py, 2.5 * dpr, 0, 2 * Math.PI)
              ctx.fill()
            }
            ctx.restore()
          }],
        },
      }
      plotRef.current = new uPlot(opts, [data.xs, data.ys], container)
    })
    return () => cancelAnimationFrame(frame)
  }, [data, entry?.units])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const u = plotRef.current, el = containerRef.current
    if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
  }, [heightSignal])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      gap: 6, padding: 6, minHeight: 0,
    }}>
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        fontSize: 'var(--font-size-label)', flexShrink: 0,
        fontFamily: 'var(--font-mono)',
      }}>
        {data
          ? <span>n = {data.xs.length}</span>
          : <span style={{ color: 'var(--text-muted)' }}>Run detection first.</span>}
      </div>
      <div ref={containerRef} style={{
        flex: 1, minHeight: 0,
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// IEI histogram — distribution of inter-event intervals (ms). Bimodal
// distributions or long-tail shapes reveal bursting / refractory
// effects that mean rate alone can't show.
// ---------------------------------------------------------------------------

function IEIHistogram({
  entry, heightSignal,
}: {
  entry: EventsData | undefined
  heightSignal: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [binMs, setBinMs] = useState<number | null>(null)  // null = auto

  const stats = useMemo(() => {
    if (!entry || entry.events.length < 2) return null
    const iei: number[] = []
    for (let i = 1; i < entry.events.length; i++) {
      iei.push((entry.events[i].peakTimeS - entry.events[i - 1].peakTimeS) * 1000)
    }
    if (iei.length === 0) return null
    const lo = 0
    const hi = Math.max(...iei) * 1.05
    const n = iei.length
    // Freedman–Diaconis would be nicer; √n is close enough for a
    // quick-look tab and doesn't need sorting.
    const nBins = Math.max(8, Math.min(60, Math.round(Math.sqrt(n))))
    const autoBw = (hi - lo) / nBins
    const bw = binMs && binMs > 0 ? binMs : autoBw
    const nBinsFinal = Math.max(1, Math.ceil((hi - lo) / bw))
    const counts = new Array<number>(nBinsFinal).fill(0)
    for (const v of iei) {
      const k = Math.max(0, Math.min(nBinsFinal - 1, Math.floor((v - lo) / bw)))
      counts[k]++
    }
    const centers = new Array<number>(nBinsFinal)
    for (let i = 0; i < nBinsFinal; i++) centers[i] = lo + (i + 0.5) * bw
    const meanIei = iei.reduce((s, v) => s + v, 0) / iei.length
    return { centers, counts, bw, n, meanIei }
  }, [entry, binMs])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) { plotRef.current.destroy(); plotRef.current = null }
    if (!stats) return
    const frame = requestAnimationFrame(() => {
      const w = Math.max(container.clientWidth, 200)
      const h = Math.max(container.clientHeight, 120)
      const opts: uPlot.Options = {
        width: w, height: h,
        legend: { show: false },
        scales: {
          x: { time: false },
          y: { range: (_u, _dmin, dmax) => [0, Math.max(1, dmax * 1.1)] },
        },
        axes: [
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            label: 'IEI (ms)', labelSize: 14,
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          },
          { stroke: cssVar('--chart-axis'),
            grid: { stroke: cssVar('--chart-grid'), width: 1 },
            ticks: { stroke: cssVar('--chart-tick'), width: 1 },
            size: 50, label: 'count',
            font: `${cssVar('--font-size-xs')} ${cssVar('--font-mono')}`,
          },
        ],
        cursor: { drag: { x: false, y: false } },
        series: [{}, { points: { show: false }, stroke: 'rgba(0,0,0,0)' }],
        hooks: {
          draw: [(u) => {
            const ctx = u.ctx
            const dpr = devicePixelRatio || 1
            ctx.save()
            ctx.fillStyle = 'rgba(100,181,246,0.4)'
            for (let i = 0; i < stats.centers.length; i++) {
              const x0 = u.valToPos(stats.centers[i] - stats.bw / 2, 'x', true)
              const x1 = u.valToPos(stats.centers[i] + stats.bw / 2, 'x', true)
              const y0 = u.valToPos(0, 'y', true)
              const y1 = u.valToPos(stats.counts[i], 'y', true)
              ctx.fillRect(Math.min(x0, x1), y1, Math.abs(x1 - x0), y0 - y1)
            }
            // Vertical line at the mean IEI — quick anchor for
            // comparing against 1 / rate.
            const mx = u.valToPos(stats.meanIei, 'x', true)
            ctx.strokeStyle = '#e57373'
            ctx.lineWidth = 1.5 * dpr
            ctx.setLineDash([4 * dpr, 3 * dpr])
            ctx.beginPath()
            ctx.moveTo(mx, u.bbox.top)
            ctx.lineTo(mx, u.bbox.top + u.bbox.height)
            ctx.stroke()
            ctx.restore()
          }],
        },
      }
      plotRef.current = new uPlot(opts, [stats.centers, stats.counts], container)
    })
    return () => cancelAnimationFrame(frame)
  }, [stats])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (u && el.clientWidth > 0 && el.clientHeight > 0) {
        u.setSize({ width: el.clientWidth, height: el.clientHeight })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const u = plotRef.current, el = containerRef.current
    if (u && el && el.clientWidth > 0 && el.clientHeight > 0) {
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
  }, [heightSignal])

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      gap: 6, padding: 6, minHeight: 0,
    }}>
      <div style={{
        display: 'flex', gap: 8, alignItems: 'center',
        fontSize: 'var(--font-size-label)', flexShrink: 0,
      }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--text-muted)' }}>Bin (ms)</span>
          <NumInput value={binMs ?? 0} step={5} min={0}
            onChange={(v) => setBinMs(v <= 0 ? null : v)} />
          <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
            {binMs == null ? '(auto)' : ''}
          </span>
        </label>
        {stats && (
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            n = {stats.n} · mean = {stats.meanIei.toFixed(1)} ms
          </span>
        )}
      </div>
      <div ref={containerRef} style={{
        flex: 1, minHeight: 0,
        border: '1px solid var(--border)', borderRadius: 4,
        background: 'var(--bg-primary)',
      }}>
        {(!entry || entry.events.length < 2) && (
          <div style={{
            padding: 16, textAlign: 'center',
            color: 'var(--text-muted)', fontStyle: 'italic',
            fontSize: 'var(--font-size-label)',
          }}>
            Need ≥ 2 events to form intervals.
          </div>
        )}
      </div>
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
  // Cross-sweep detection → show a Sweep column so rows are
  // unambiguously placed. Single-sweep skips the column to keep the
  // table compact.
  const multiSweep = (entry.sweepsAnalysed?.length ?? 1) > 1
  const headers = multiSweep
    ? ['#', 'Sweep', 'Time (s)', `Amp (${unit})`, 'Rise (ms)', 'Decay (ms)',
        'τ rise (ms)', 'τ decay (ms)',
        'FWHM (ms)', `AUC (${unit}·s)`, 'IEI (ms)', '']
    : ['#', 'Time (s)', `Amp (${unit})`, 'Rise (ms)', 'Decay (ms)',
        'τ rise (ms)', 'τ decay (ms)',
        'FWHM (ms)', `AUC (${unit}·s)`, 'IEI (ms)', '']
  return (
    <table style={{
      width: '100%', borderCollapse: 'collapse',
      fontSize: 'var(--font-size-xs)', fontFamily: 'var(--font-mono)',
    }}>
      <thead>
        <tr>
          {headers.map((h, i) => (
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
        {entry.events.map((e: EventRow, i: number) => {
          // IEI only meaningful within the same sweep — don't span
          // the sweep boundary in multi-sweep mode.
          const prev = i === 0 ? null : entry.events[i - 1]
          const iei = prev && (!multiSweep || prev.sweep === e.sweep)
            ? (e.peakTimeS - prev.peakTimeS) * 1000
            : null
          return (
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
              {multiSweep && <td style={td}>{e.sweep + 1}</td>}
              <td style={td}>{e.peakTimeS.toFixed(4)}</td>
              <td style={td}>{e.amplitude.toFixed(2)}</td>
              <td style={td}>{e.riseTimeMs != null ? e.riseTimeMs.toFixed(2) : '—'}</td>
              <td style={td}>{e.decayTimeMs != null ? e.decayTimeMs.toFixed(2) : '—'}</td>
              <td style={td}>{e.biexpTauRiseMs != null ? e.biexpTauRiseMs.toFixed(2) : '—'}</td>
              <td style={td}>{e.decayTauMs != null ? e.decayTauMs.toFixed(2) : '—'}</td>
              <td style={td}>{e.halfWidthMs != null ? e.halfWidthMs.toFixed(2) : '—'}</td>
              <td style={td}>{e.auc != null ? e.auc.toFixed(4) : '—'}</td>
              <td style={td}>{iei != null ? iei.toFixed(1) : '—'}</td>
              <td style={{ ...td, textAlign: 'right' }}>
                <button className="btn" onClick={(ev) => { ev.stopPropagation(); onDiscard(i) }}
                  style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}
                  title="Remove this event from the results">
                  ✕
                </button>
              </td>
            </tr>
          )
        })}
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
    'Rise_ms', 'Decay_ms',
    'BiexpTauRise_ms', 'BiexpTauDecay_ms', 'Biexp_b0', 'Biexp_b1',
    'DecayTau_ms', 'FWHM_ms', `AUC_${unit}·s`,
    'IEI_ms',
    'Manual',
  ]
  const rows = entry.events.map((e, i) => {
    const iei = i === 0
      ? ''
      : ((e.peakTimeS - entry.events[i - 1].peakTimeS) * 1000).toFixed(3)
    return [
      i + 1, e.sweep,
      e.peakTimeS.toFixed(6), e.footTimeS.toFixed(6),
      e.peakVal.toFixed(4), e.baselineVal.toFixed(4), e.amplitude.toFixed(4),
      e.riseTimeMs ?? '', e.decayTimeMs ?? '',
      e.biexpTauRiseMs ?? '', e.biexpTauDecayMs ?? '',
      e.biexpB0 ?? '', e.biexpB1 ?? '',
      e.decayTauMs ?? '', e.halfWidthMs ?? '',
      e.auc ?? '',
      iei,
      e.manual ? 1 : 0,
    ]
  })
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
