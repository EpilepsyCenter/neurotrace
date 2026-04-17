import React, { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useAppStore, BurstRecord, FieldBurstsData, FieldBurstsParams } from '../../stores/appStore'
import { NumInput } from '../common/NumInput'

const MARKER_COLORS = {
  baseline: '#9e9e9e',
  peak: '#e57373',
  decay: '#ffb74d',
  end: '#81c784',
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

interface FileInfo {
  fileName: string | null
  format: string | null
  groupCount: number
  groups: any[]
}

type Method = 'threshold' | 'oscillation' | 'isi'
type BaselineMode = 'percentile' | 'robust' | 'rolling' | 'fixed_start'

/** Default params per method + baseline mode. Centralized so the form can
 *  reset cleanly when the user switches methods. */
/** Shared filter + noise defaults applied to every method. Epileptiform
 *  recordings typically want a 1–50 Hz bandpass to kill drift + HF noise
 *  before detection; this also makes the SD-based noise estimate tight. */
const FILTER_NOISE_DEFAULTS = {
  filter_enabled: true,
  filter_type: 'bandpass' as const,
  filter_low: 1,
  filter_high: 50,
  filter_order: 4,
  noise_method: 'sd' as const,  // classical SD; user can switch to MAD
}

function defaultParamsFor(method: Method, baseline_mode: BaselineMode): FieldBurstsParams {
  if (method === 'threshold') {
    return {
      method, baseline_mode,
      ...FILTER_NOISE_DEFAULTS,
      n_sd: 2.0,
      smooth_ms: 10,
      min_duration_ms: 50,
      min_gap_ms: 100,
      baseline_percentile: 10,
      baseline_window_s: 5,
      baseline_end_s: 1,
      pre_burst_window_ms: 100,
    }
  }
  if (method === 'oscillation') {
    return {
      method, baseline_mode,
      // Oscillation method has its own bandpass; pre-filter off by default.
      ...FILTER_NOISE_DEFAULTS,
      filter_enabled: false,
      low_freq: 4,
      high_freq: 30,
      n_sd: 2.0,
      smooth_ms: 50,
      min_duration_ms: 100,
      min_gap_ms: 200,
      baseline_percentile: 10,
      baseline_window_s: 5,
      baseline_end_s: 1,
      pre_burst_window_ms: 100,
    }
  }
  // isi
  return {
    method, baseline_mode: 'percentile',
    ...FILTER_NOISE_DEFAULTS,
    spike_threshold: 0,  // 0 = auto (MAD-based)
    min_spike_dist_ms: 2,
    max_isi_ms: 100,
    min_spikes_per_burst: 3,
    pre_burst_window_ms: 100,
  }
}

/** One row for the Nth recorded channel of the selected series. */
function channelsForSeries(fileInfo: FileInfo | null, group: number, series: number): any[] {
  return fileInfo?.groups?.[group]?.series?.[series]?.channels ?? []
}

export function FieldBurstWindow({
  backendUrl,
  fileInfo,
  currentSweep,
  mainGroup,
  mainSeries,
  mainTrace,
}: {
  backendUrl: string
  fileInfo: FileInfo | null
  currentSweep: number
  mainGroup: number | null
  mainSeries: number | null
  mainTrace: number | null
}) {
  const {
    fieldBursts,
    runFieldBurstsOnSweep, runFieldBurstsOnSeries,
    clearFieldBursts, selectFieldBurst, exportFieldBurstsCSV,
    loading, error, setError,
  } = useAppStore()

  // Selections. Start from the main window's current selection on first
  // mount; afterwards the user can change them here without being
  // hijacked by further main-window navigation.
  const [group, setGroup] = useState(mainGroup ?? 0)
  const [series, setSeries] = useState(mainSeries ?? 0)
  const [channel, setChannel] = useState(mainTrace ?? 0)
  const hasSyncedRef = useRef(false)
  useEffect(() => {
    if (hasSyncedRef.current) return
    if (mainGroup == null && mainSeries == null && mainTrace == null) return
    hasSyncedRef.current = true
    if (mainGroup != null) setGroup(mainGroup)
    if (mainSeries != null) setSeries(mainSeries)
    if (mainTrace != null) setChannel(mainTrace)
  }, [mainGroup, mainSeries, mainTrace])
  const [method, setMethod] = useState<Method>('threshold')
  const [baselineMode, setBaselineMode] = useState<BaselineMode>('percentile')
  const [params, setParams] = useState<FieldBurstsParams>(defaultParamsFor('threshold', 'percentile'))

  // Draggable splitter between mini-viewer and table.
  const [miniHeight, setMiniHeight] = useState(340)
  const onSplitterMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = miniHeight
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY
      setMiniHeight(Math.max(150, Math.min(800, startH + dy)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Reset params when method or baseline-mode changes.
  useEffect(() => {
    setParams(defaultParamsFor(method, baselineMode))
  }, [method, baselineMode])

  // Reset group/series if the file changes and the previous indices are gone.
  useEffect(() => {
    if (!fileInfo) return
    if (group >= fileInfo.groupCount) setGroup(0)
    const ser = fileInfo.groups?.[group]?.series
    if (ser && series >= ser.length) setSeries(0)
  }, [fileInfo, group, series])

  const channels = useMemo(() => channelsForSeries(fileInfo, group, series), [fileInfo, group, series])

  // Reset channel if the previous one no longer exists.
  useEffect(() => {
    if (channels.length > 0 && channel >= channels.length) setChannel(0)
  }, [channels, channel])

  const key = `${group}:${series}`
  const entry = fieldBursts[key]

  const onParamChange = (name: string, value: number) => {
    setParams((p) => ({ ...p, [name]: value }))
  }
  const onParamChangeRaw = (name: string, value: string | boolean) => {
    setParams((p) => ({ ...p, [name]: value }))
  }

  const onRunSweep = () => {
    runFieldBurstsOnSweep(group, series, currentSweep, channel, params)
  }
  const onRunSeries = () => {
    runFieldBurstsOnSeries(group, series, channel, params)
  }

  const onSelectRow = (idx: number) => {
    selectFieldBurst(group, series, idx)
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      padding: 10,
      gap: 10,
      minHeight: 0,
    }}>
      {/* Top bar: selectors */}
      <TopBar
        fileInfo={fileInfo}
        group={group} setGroup={setGroup}
        series={series} setSeries={setSeries}
        channels={channels} channel={channel} setChannel={setChannel}
        method={method} setMethod={setMethod}
        baselineMode={baselineMode} setBaselineMode={setBaselineMode}
      />

      {/* Params form */}
      <ParamsForm
        method={method}
        baselineMode={baselineMode}
        params={params}
        onChange={onParamChange}
        onChangeRaw={onParamChangeRaw}
      />

      {/* Run buttons */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-primary" onClick={onRunSweep} disabled={loading || !fileInfo}>
          {loading ? 'Running…' : `Run on sweep ${currentSweep + 1}`}
        </button>
        <button className="btn" onClick={onRunSeries} disabled={loading || !fileInfo}>
          Run on series
        </button>
        <button className="btn" onClick={() => clearFieldBursts(group, series)} disabled={!entry}>
          Clear
        </button>
        <button
          className="btn"
          onClick={() => exportFieldBurstsCSV()}
          disabled={Object.keys(fieldBursts).length === 0}
          style={{ marginLeft: 'auto' }}
        >
          Export CSV
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          padding: '6px 10px',
          background: 'var(--bg-error, #5c1b1b)',
          color: '#fff',
          borderRadius: 3,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 'var(--font-size-xs)',
        }}>
          <span style={{ flex: 1 }}>⚠ {error}</span>
          <button
            className="btn"
            onClick={() => setError(null)}
            style={{ padding: '1px 6px', fontSize: 'var(--font-size-label)' }}
          >dismiss</button>
        </div>
      )}

      {/* Baseline + threshold + signal summary. Displayed after any run so
          the user can see why detection returned few or zero bursts. */}
      {entry && (
        <div style={{
          fontSize: 'var(--font-size-label)',
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          background: 'var(--bg-primary)',
          padding: '4px 8px',
          borderRadius: 3,
          border: '1px solid var(--border)',
          lineHeight: 1.6,
        }}>
          <div>
            <strong style={{ color: 'var(--text-primary)' }}>{entry.bursts.length}</strong> bursts
            {' · '}baseline = {entry.baselineValue.toFixed(3)}
            {entry.thresholdHigh != null && ` · thr ↑ ${entry.thresholdHigh.toFixed(3)}`}
            {entry.thresholdLow != null && ` · thr ↓ ${entry.thresholdLow.toFixed(3)}`}
          </div>
          {entry.diag && (
            <div style={{ color: 'var(--text-muted)' }}>
              signal: median {entry.diag.median.toFixed(3)}, MAD {entry.diag.mad.toFixed(3)},
              range [{entry.diag.min.toFixed(3)}, {entry.diag.max.toFixed(3)}],
              max |dev| {entry.diag.maxAbsDev.toFixed(3)} · {entry.diag.durationS.toFixed(1)} s
              {' '}({entry.diag.nSamples.toString()} samples)
            </div>
          )}
          {entry.bursts.length === 0 && entry.diag && entry.thresholdHigh != null && (
            <div style={{ color: 'var(--accent)', fontStyle: 'italic' }}>
              No bursts above threshold. Max |signal − baseline| = {Math.max(
                Math.abs(entry.diag.max - entry.baselineValue),
                Math.abs(entry.diag.min - entry.baselineValue),
              ).toFixed(3)} · threshold at {Math.abs(entry.thresholdHigh - entry.baselineValue).toFixed(3)}.
              Try lowering <code>n_sd</code>, switching baseline mode, or raising <code>baseline_percentile</code>.
            </div>
          )}
        </div>
      )}

      {/* Split area: mini-viewer (top, resizable) + table (bottom, scroll).
          The flex:1 parent keeps them filling whatever vertical space remains
          below the header rows. minHeight:0 is required so children can
          actually shrink and the table's internal scroll takes effect. */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}>
        <div style={{ height: miniHeight, minHeight: 150, flexShrink: 0 }}>
          <BurstMiniViewer
            backendUrl={backendUrl}
            entry={entry}
            group={group}
            series={series}
            channel={channel}
            // When the parent's height changes (splitter drag, window resize
            // relayouting), re-flow uPlot in the child. Needed because
            // ResizeObserver fires asynchronously and can miss fast drag.
            heightSignal={miniHeight}
          />
        </div>

        {/* Draggable splitter */}
        <div
          onMouseDown={onSplitterMouseDown}
          style={{
            height: 6,
            cursor: 'row-resize',
            background: 'var(--border)',
            flexShrink: 0,
            position: 'relative',
          }}
          title="Drag to resize"
        >
          <div style={{
            position: 'absolute',
            left: '50%',
            top: 1,
            transform: 'translateX(-50%)',
            width: 40,
            height: 4,
            background: 'var(--text-muted)',
            borderRadius: 2,
            opacity: 0.5,
          }} />
        </div>

        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <BurstTable
            bursts={entry?.bursts ?? []}
            selectedIdx={entry?.selectedIdx ?? null}
            onSelect={onSelectRow}
          />
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

function TopBar({
  fileInfo, group, setGroup, series, setSeries,
  channels, channel, setChannel,
  method, setMethod,
  baselineMode, setBaselineMode,
}: {
  fileInfo: FileInfo | null
  group: number; setGroup: (n: number) => void
  series: number; setSeries: (n: number) => void
  channels: any[]; channel: number; setChannel: (n: number) => void
  method: Method; setMethod: (m: Method) => void
  baselineMode: BaselineMode; setBaselineMode: (m: BaselineMode) => void
}) {
  const groups = fileInfo?.groups ?? []
  const seriesList = fileInfo?.groups?.[group]?.series ?? []

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <Field label="Group">
        <select value={group} onChange={(e) => setGroup(Number(e.target.value))} disabled={!fileInfo}>
          {groups.map((g: any, i: number) => (
            <option key={i} value={i}>{g.label || `G${i + 1}`}</option>
          ))}
        </select>
      </Field>
      <Field label="Series">
        <select value={series} onChange={(e) => setSeries(Number(e.target.value))} disabled={!fileInfo}>
          {seriesList.map((s: any, i: number) => (
            <option key={i} value={i}>{s.label || `S${i + 1}`} ({s.sweepCount} sw)</option>
          ))}
        </select>
      </Field>
      <Field label="Channel">
        <select value={channel} onChange={(e) => setChannel(Number(e.target.value))} disabled={channels.length === 0}>
          {channels.map((c: any) => (
            <option key={c.index} value={c.index}>{c.label} ({c.units})</option>
          ))}
        </select>
      </Field>
      <Field label="Method">
        <select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
          <option value="threshold">Threshold</option>
          <option value="oscillation">Oscillation envelope</option>
          <option value="isi">ISI clustering</option>
        </select>
      </Field>
      {method !== 'isi' && (
        <Field label="Baseline">
          <select value={baselineMode} onChange={(e) => setBaselineMode(e.target.value as BaselineMode)}>
            <option value="percentile">Percentile (default)</option>
            <option value="robust">Robust (median + MAD)</option>
            <option value="rolling">Rolling median</option>
            <option value="fixed_start">Fixed start</option>
          </select>
        </Field>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      {children}
    </label>
  )
}

function ParamsForm({
  method, baselineMode, params, onChange, onChangeRaw,
}: {
  method: Method
  baselineMode: BaselineMode
  params: FieldBurstsParams
  onChange: (name: string, v: number) => void
  onChangeRaw: (name: string, v: string | boolean) => void
}) {
  const p = (k: string) => Number(params[k] ?? 0)
  const filterEnabled = Boolean(params.filter_enabled)
  const noiseMethod = String(params.noise_method ?? 'sd')
  const filterType = String(params.filter_type ?? 'bandpass')

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: 8,
      border: '1px solid var(--border)',
      borderRadius: 4,
      background: 'var(--bg-primary)',
    }}>
      {/* --- Pre-detection filter --- */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-label)' }}>
          <input
            type="checkbox"
            checked={filterEnabled}
            onChange={(e) => onChangeRaw('filter_enabled', e.target.checked)}
          />
          <span style={{ fontWeight: 600 }}>Pre-detection filter</span>
        </label>
        {filterEnabled && (
          <>
            <select
              value={filterType}
              onChange={(e) => onChangeRaw('filter_type', e.target.value)}
              style={{ fontSize: 'var(--font-size-label)' }}
            >
              <option value="bandpass">Bandpass</option>
              <option value="lowpass">Lowpass</option>
              <option value="highpass">Highpass</option>
            </select>
            {(filterType === 'highpass' || filterType === 'bandpass') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                <span style={{ color: 'var(--text-muted)' }}>low</span>
                <NumInput value={p('filter_low')} step={0.1} min={0}
                  onChange={(v) => onChange('filter_low', v)}
                  style={{ width: 60 }} />
                <span style={{ color: 'var(--text-muted)' }}>Hz</span>
              </label>
            )}
            {(filterType === 'lowpass' || filterType === 'bandpass') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
                <span style={{ color: 'var(--text-muted)' }}>high</span>
                <NumInput value={p('filter_high')} step={1} min={1}
                  onChange={(v) => onChange('filter_high', v)}
                  style={{ width: 60 }} />
                <span style={{ color: 'var(--text-muted)' }}>Hz</span>
              </label>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)' }}>
              <span style={{ color: 'var(--text-muted)' }}>order</span>
              <NumInput value={p('filter_order')} step={1} min={1} max={8}
                onChange={(v) => onChange('filter_order', Math.max(1, Math.min(8, Math.round(v))))}
                style={{ width: 40 }} />
            </label>
          </>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-label)', marginLeft: 'auto' }}>
          <span style={{ color: 'var(--text-muted)' }}>Noise</span>
          <select
            value={noiseMethod}
            onChange={(e) => onChangeRaw('noise_method', e.target.value)}
            style={{ fontSize: 'var(--font-size-label)' }}
            title="SD: classical standard deviation. MAD: robust to outliers. MAD-diff: robust to outliers AND drift."
          >
            <option value="sd">SD</option>
            <option value="mad">MAD</option>
            <option value="mad_diff">MAD-diff</option>
          </select>
        </label>
      </div>

      {/* --- Method + baseline knobs --- */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: 6,
        borderTop: '1px solid var(--border)',
        paddingTop: 6,
      }}>
      {/* Method-specific knobs */}
      {(method === 'threshold' || method === 'oscillation') && (
        <>
          <ParamRow label="n_sd" value={p('n_sd')} step={0.1} min={0}
            onChange={(v) => onChange('n_sd', v)} />
          <ParamRow label="smooth (ms)" value={p('smooth_ms')} step={1} min={1}
            onChange={(v) => onChange('smooth_ms', v)} />
          <ParamRow label="min dur (ms)" value={p('min_duration_ms')} step={1} min={1}
            onChange={(v) => onChange('min_duration_ms', v)} />
          <ParamRow label="min gap (ms)" value={p('min_gap_ms')} step={1} min={0}
            onChange={(v) => onChange('min_gap_ms', v)} />
        </>
      )}
      {method === 'oscillation' && (
        <>
          <ParamRow label="band low (Hz)" value={p('low_freq')} step={1} min={0}
            onChange={(v) => onChange('low_freq', v)} />
          <ParamRow label="band high (Hz)" value={p('high_freq')} step={1} min={1}
            onChange={(v) => onChange('high_freq', v)} />
        </>
      )}
      {method === 'isi' && (
        <>
          <ParamRow label="spike thr (abs)" value={p('spike_threshold')} step={0.1} min={0}
            onChange={(v) => onChange('spike_threshold', v)} />
          <ParamRow label="min dist (ms)" value={p('min_spike_dist_ms')} step={0.1} min={0}
            onChange={(v) => onChange('min_spike_dist_ms', v)} />
          <ParamRow label="max ISI (ms)" value={p('max_isi_ms')} step={1} min={1}
            onChange={(v) => onChange('max_isi_ms', v)} />
          <ParamRow label="min spikes/burst" value={p('min_spikes_per_burst')} step={1} min={2}
            onChange={(v) => onChange('min_spikes_per_burst', Math.max(2, Math.round(v)))} />
        </>
      )}

      {/* Baseline-mode-specific knobs */}
      {method !== 'isi' && baselineMode === 'percentile' && (
        <ParamRow label="percentile (%)" value={p('baseline_percentile')} step={1} min={0} max={100}
          onChange={(v) => onChange('baseline_percentile', Math.max(0, Math.min(100, v)))} />
      )}
      {method !== 'isi' && baselineMode === 'rolling' && (
        <ParamRow label="window (s)" value={p('baseline_window_s')} step={0.5} min={0.1}
          onChange={(v) => onChange('baseline_window_s', v)} />
      )}
      {method !== 'isi' && baselineMode === 'fixed_start' && (
        <ParamRow label="baseline end (s)" value={p('baseline_end_s')} step={0.1} min={0.01}
          onChange={(v) => onChange('baseline_end_s', v)} />
      )}

      {/* Pre-burst baseline window — applies to all methods (per-burst
          amplitude is computed as |signal − mean(pre-burst window)|). */}
      <ParamRow
        label="pre-burst (ms)"
        value={p('pre_burst_window_ms')}
        step={10} min={1}
        onChange={(v) => onChange('pre_burst_window_ms', v)}
      />
      </div>{/* /method knobs grid */}
    </div>
  )
}

function ParamRow({
  label, value, step, min, max, onChange,
}: {
  label: string; value: number; step: number; min?: number; max?: number
  onChange: (v: number) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--font-size-label)' }}>
      <span style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{label}</span>
      <NumInput value={value} step={step} min={min} max={max} onChange={onChange} />
    </label>
  )
}

/** Zoomed plot of the currently-selected burst, with per-burst markers
 *  (baseline / peak / decay½ / end) and dashed horizontal lines for the
 *  detection baseline and upper/lower thresholds. */
function BurstMiniViewer({
  backendUrl, entry, group, series, channel, heightSignal,
}: {
  backendUrl: string
  entry: FieldBurstsData | undefined
  group: number
  series: number
  channel: number
  heightSignal?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const selected: BurstRecord | null =
    entry && entry.selectedIdx != null && entry.selectedIdx < entry.bursts.length
      ? entry.bursts[entry.selectedIdx]
      : null

  const [data, setData] = useState<{ time: Float64Array; values: Float64Array } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Fetch trace data around the selected burst — using the SAME filter
  // config that was used for detection, so the displayed trace lines up
  // with the burst markers (which carry filtered-signal y values).
  useEffect(() => {
    if (!selected || !backendUrl) {
      setData(null)
      return
    }
    const durS = Math.max(selected.endS - selected.startS, 0.05)
    const tStart = Math.max(0, selected.startS - durS * 2)
    const tEnd = selected.endS + durS * 2
    const p = (entry?.params ?? {}) as Record<string, any>
    const parts = [
      `group=${group}`,
      `series=${series}`,
      `sweep=${selected.sweepIndex}`,
      `trace=${channel}`,
      `t_start=${tStart}`,
      `t_end=${tEnd}`,
      `max_points=4000`,
    ]
    if (p.filter_enabled) {
      parts.push(`filter_type=${p.filter_type ?? 'bandpass'}`)
      if (p.filter_low != null) parts.push(`filter_low=${p.filter_low}`)
      if (p.filter_high != null) parts.push(`filter_high=${p.filter_high}`)
      if (p.filter_order != null) parts.push(`filter_order=${p.filter_order}`)
    }
    const url = `${backendUrl}/api/traces/data?${parts.join('&')}`
    let cancelled = false
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return
        setData({
          time: new Float64Array(d.time ?? []),
          values: new Float64Array(d.values ?? []),
        })
        setErr(null)
      })
      .catch((e) => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [selected, backendUrl, group, series, channel, entry?.params])

  // Build / rebuild the uPlot instance when data arrives or size changes.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (plotRef.current) {
      plotRef.current.destroy()
      plotRef.current = null
    }
    if (!data || data.time.length === 0) return

    const opts: uPlot.Options = {
      width: container.clientWidth || 400,
      height: Math.max(120, container.clientHeight || 180),
      scales: { x: { time: false }, y: {} },
      axes: [
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
        },
        {
          stroke: cssVar('--chart-axis'),
          grid: { stroke: cssVar('--chart-grid'), width: 1 },
          ticks: { stroke: cssVar('--chart-tick'), width: 1 },
          font: `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`,
        },
      ],
      cursor: { drag: { x: false, y: false } },
      series: [
        {},
        {
          label: 'trace',
          stroke: cssVar('--trace-color-1'),
          width: 1.25,
        },
      ],
      hooks: {
        draw: [() => drawMiniOverlay(plotRef.current, overlayRef.current, entry, selected)],
      },
    }
    const payload: uPlot.AlignedData = [
      Array.from(data.time),
      Array.from(data.values),
    ]
    plotRef.current = new uPlot(opts, payload, container)
    drawMiniOverlay(plotRef.current, overlayRef.current, entry, selected)
  }, [data, entry, selected])

  // Re-draw overlay when entry's thresholds change without a data fetch.
  useEffect(() => {
    drawMiniOverlay(plotRef.current, overlayRef.current, entry, selected)
  }, [entry, selected])

  // Keep uPlot sized to its container. `selected` is a dep because the
  // containerRef div is only rendered once a burst is selected — the
  // observer needs to (re)attach after that mount.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const u = plotRef.current
      if (!u || !el) return
      const w = el.clientWidth
      const h = el.clientHeight
      if (w > 0 && h > 0) u.setSize({ width: w, height: h })
    })
    ro.observe(el)
    // Also observe the window so Electron resize fires even when the
    // ResizeObserver doesn't tick synchronously.
    const onWindowResize = () => {
      const u = plotRef.current
      if (!u || !el) return
      u.setSize({ width: el.clientWidth, height: el.clientHeight })
    }
    window.addEventListener('resize', onWindowResize)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onWindowResize)
    }
  }, [selected != null])

  // Explicit resize drive when the parent pushes a new `heightSignal` (e.g.
  // the user is dragging the splitter between the mini-viewer and the
  // table). ResizeObserver is async; this ticks synchronously each render.
  useEffect(() => {
    const u = plotRef.current
    const el = containerRef.current
    if (!u || !el) return
    u.setSize({ width: el.clientWidth, height: el.clientHeight })
  }, [heightSignal])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      border: '1px solid var(--border)',
      borderRadius: 4,
      background: 'var(--bg-primary)',
      position: 'relative',
    }}>
      {!selected ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: 'var(--text-muted)',
          fontStyle: 'italic',
          fontSize: 'var(--font-size-label)',
        }}>
          Select a burst in the table below to preview it here.
        </div>
      ) : (
        <>
          <div style={{
            padding: '3px 8px',
            fontSize: 'var(--font-size-label)',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
          }}>
            <span>burst #{(entry?.selectedIdx ?? 0) + 1}</span>
            <span>sweep {selected.sweepIndex + 1}</span>
            <span>t {selected.startS.toFixed(3)} → {selected.endS.toFixed(3)} s</span>
            <span>peak {selected.peakAmplitude.toFixed(3)}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <LegendDot color={MARKER_COLORS.baseline} label="baseline" />
              <LegendDot color={MARKER_COLORS.peak} label="peak" />
              <LegendDot color={MARKER_COLORS.decay} label="½ decay" />
              <LegendDot color={MARKER_COLORS.end} label="return" />
            </span>
          </div>
          <div ref={containerRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            {/* Overlay canvas nested INSIDE the uPlot container so its
                pixel coordinates line up with the uPlot bbox (dots would
                otherwise be shifted down by the height of the header row). */}
            <canvas
              ref={overlayRef}
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                zIndex: 5,
                width: '100%',
                height: '100%',
              }}
            />
          </div>
          {err && (
            <div style={{
              position: 'absolute', top: 30, left: 10,
              color: '#f44336', fontSize: 'var(--font-size-label)',
            }}>fetch: {err}</div>
          )}
        </>
      )}
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: color, border: '1px solid rgba(255,255,255,0.6)',
      }} />
      {label}
    </span>
  )
}

/** Paints dots and dashed threshold/baseline lines on the overlay canvas,
 *  sized to the uPlot instance's current bbox. */
function drawMiniOverlay(
  u: uPlot | null,
  canvas: HTMLCanvasElement | null,
  entry: FieldBurstsData | undefined,
  selected: BurstRecord | null,
) {
  if (!u || !canvas || !selected) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = devicePixelRatio || 1
  const cssW = canvas.clientWidth
  const cssH = canvas.clientHeight
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  const left = u.bbox.left / dpr
  const right = left + u.bbox.width / dpr

  const toPx = (x: number, y: number): [number, number] => [
    u.valToPos(x, 'x', true) / dpr,
    u.valToPos(y, 'y', true) / dpr,
  ]

  // Dashed horizontal lines: pre-burst baseline, detection thresholds.
  const hLine = (y: number, color: string, label: string) => {
    const py = u.valToPos(y, 'y', true) / dpr
    if (!isFinite(py)) return
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(left, py)
    ctx.lineTo(right, py)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = color
    ctx.font = `${cssVar('--font-size-label')} ${cssVar('--font-mono')}`
    ctx.fillText(label, left + 4, py - 3)
  }

  hLine(selected.preBurstBaseline, 'rgba(158,158,158,0.8)', 'pre-baseline')
  if (entry?.thresholdHigh != null) {
    hLine(entry.thresholdHigh, 'rgba(229,115,115,0.7)', 'thr ↑')
  }
  if (entry?.thresholdLow != null && entry.thresholdLow !== entry.thresholdHigh) {
    hLine(entry.thresholdLow, 'rgba(229,115,115,0.7)', 'thr ↓')
  }

  // Per-burst dots.
  const peakY = selected.preBurstBaseline + selected.peakSigned
  const [px0, py0] = toPx(selected.startS, selected.preBurstBaseline)
  const [px1, py1] = toPx(selected.peakTimeS, peakY)
  const [px3, py3] = toPx(selected.endS, selected.preBurstBaseline)
  const decay =
    selected.decayHalfTimeMs != null
      ? toPx(
          selected.peakTimeS + selected.decayHalfTimeMs / 1000,
          selected.preBurstBaseline + selected.peakSigned * 0.5,
        )
      : null

  const drawDot = (px: number, py: number, color: string) => {
    if (!isFinite(px) || !isFinite(py)) return
    ctx.beginPath()
    ctx.arc(px, py, 6, 0, 2 * Math.PI)
    ctx.fillStyle = color
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  drawDot(px0, py0, MARKER_COLORS.baseline)
  drawDot(px1, py1, MARKER_COLORS.peak)
  if (decay) drawDot(decay[0], decay[1], MARKER_COLORS.decay)
  drawDot(px3, py3, MARKER_COLORS.end)
}

function BurstTable({
  bursts, selectedIdx, onSelect,
}: {
  bursts: BurstRecord[]
  selectedIdx: number | null
  onSelect: (idx: number) => void
}) {
  if (bursts.length === 0) {
    return (
      <div style={{
        padding: 16,
        textAlign: 'center',
        color: 'var(--text-muted)',
        fontStyle: 'italic',
        fontSize: 'var(--font-size-label)',
        border: '1px dashed var(--border)',
        borderRadius: 4,
      }}>
        No bursts detected yet. Configure params above and run on a sweep or series.
      </div>
    )
  }

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 4,
      overflow: 'auto',
      height: '100%',
    }}>
      <table style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 'var(--font-size-label)',
        fontFamily: 'var(--font-mono)',
      }}>
        <thead>
          <tr style={{ background: 'var(--bg-secondary)', textAlign: 'left', position: 'sticky', top: 0 }}>
            <Th>#</Th>
            <Th>Sweep</Th>
            <Th>t_start (s)</Th>
            <Th>Dur (ms)</Th>
            <Th>Pre-baseline</Th>
            <Th>Peak (Δ)</Th>
            <Th>Rise 10-90 (ms)</Th>
            <Th>Decay t₅₀ (ms)</Th>
            <Th>Integral (·s)</Th>
            <Th>Freq (Hz)</Th>
            <Th>Peak t (s)</Th>
          </tr>
        </thead>
        <tbody>
          {bursts.map((b, i) => (
            <tr
              key={i}
              onClick={() => onSelect(i)}
              style={{
                background: i === selectedIdx ? 'var(--bg-selected, rgba(100,181,246,0.2))' : 'transparent',
                cursor: 'pointer',
                borderTop: '1px solid var(--border)',
              }}
            >
              <Td>{i + 1}</Td>
              <Td>{b.sweepIndex + 1}</Td>
              <Td>{b.startS.toFixed(3)}</Td>
              <Td>{b.durationMs.toFixed(1)}</Td>
              <Td>{b.preBurstBaseline.toFixed(3)}</Td>
              <Td>{b.peakAmplitude.toFixed(3)}</Td>
              <Td>{b.riseTime10_90Ms != null ? b.riseTime10_90Ms.toFixed(1) : '—'}</Td>
              <Td>{b.decayHalfTimeMs != null ? b.decayHalfTimeMs.toFixed(1) : '—'}</Td>
              <Td>{b.integral.toFixed(4)}</Td>
              <Td>{b.meanFrequencyHz != null ? b.meanFrequencyHz.toFixed(1) : '—'}</Td>
              <Td>{b.peakTimeS.toFixed(3)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const Th = ({ children }: { children: React.ReactNode }) => (
  <th style={{ padding: '4px 8px', fontWeight: 600, fontSize: 'var(--font-size-label)' }}>{children}</th>
)
const Td = ({ children }: { children: React.ReactNode }) => (
  <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{children}</td>
)
