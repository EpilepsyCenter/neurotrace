/**
 * uPlot draw-hook helpers for the live scalebar preview.
 *
 * Mirrors the auto-pick + L-shape render logic in
 * ``backend/export/scalebar.py`` so what the user sees in the
 * uPlot panel is what matplotlib will draw at export time.
 *
 * The values (and unit ladder) here MUST match the backend's
 * ladder; if you tune one, tune both.
 */
import type uPlot from 'uplot'
import type { ScalebarCfg, YAxis } from '../../stores/traceExportStore'

const TIME_UNITS: Array<{ label: string; scale: number }> = [
  { label: 'min', scale: 60 },
  { label: 's', scale: 1 },
  { label: 'ms', scale: 1e-3 },
  { label: 'µs', scale: 1e-6 },
]
const NICE_STEPS = [1, 2, 5]

function niceValue(target: number): number {
  if (target <= 0 || !Number.isFinite(target)) return 1
  const exp = Math.floor(Math.log10(target))
  const base = 10 ** exp
  const candidates: number[] = []
  for (const s of NICE_STEPS) candidates.push(s * base)
  for (const s of NICE_STEPS) candidates.push(s * base * 10)
  const feasible = candidates.filter((c) => c <= target)
  return feasible.length ? Math.max(...feasible) : candidates[0]
}

export function autoTimeScalebar(tRange: number): { value: number; unit: string } {
  if (tRange <= 0) return { value: 1e-3, unit: 'ms' }
  const target = tRange * 0.25
  for (const { label, scale } of TIME_UNITS) {
    if (target >= scale) {
      return { value: niceValue(target / scale) * scale, unit: label }
    }
  }
  const last = TIME_UNITS[TIME_UNITS.length - 1]
  return { value: niceValue(target / last.scale) * last.scale, unit: last.label }
}

export function autoYScalebar(yRange: number, unit: string): { value: number; unit: string } {
  if (yRange <= 0) return { value: 1, unit }
  return { value: niceValue(yRange * 0.25), unit }
}

function timeUnitFactor(unit: string): number {
  const hit = TIME_UNITS.find((u) => u.label === unit)
  return hit ? 1 / hit.scale : 1
}

function fmtValue(v: number): string {
  if (v === Math.round(v)) return String(Math.round(v))
  // Strip trailing zeros, keep up to 3 sig figs.
  return v.toPrecision(3).replace(/\.?0+$/, '')
}

interface DrawOpts {
  cfg: ScalebarCfg
  axes: YAxis[]
  /** uPlot scale-key for time. Always ``"x"`` in our setup. */
}

/**
 * Build a uPlot `hooks.draw` callback that paints the L-shape
 * scalebar over the plot canvas.
 *
 * Called once per redraw — uPlot rebuilds on data change in our
 * pattern, so this fires whenever the figure config changes.
 */
export function makeScalebarDrawHook(opts: DrawOpts): (u: uPlot) => void {
  const { cfg, axes } = opts
  return (u: uPlot) => {
    if (!cfg.enabled) return
    const ctx = u.ctx
    const dpr = window.devicePixelRatio || 1

    // Plotting area in canvas pixels (uPlot bbox is already DPR-scaled).
    const left = u.bbox.left
    const top = u.bbox.top
    const width = u.bbox.width
    const height = u.bbox.height

    // Time bar — value is in seconds (the x-scale unit). Auto-pick if no override.
    const xMin = u.scales.x.min ?? 0
    const xMax = u.scales.x.max ?? 1
    const tRange = xMax - xMin
    const xPick = cfg.x_value && cfg.x_value > 0
      ? { value: cfg.x_value, unit: cfg.x_unit ?? 's' }
      : autoTimeScalebar(tRange)

    // Anchor in plot coords (axes-fraction). uPlot bbox is in canvas pixels.
    const isRight = cfg.corner.includes('r')
    const isBottom = cfg.corner.includes('b')
    const padX = cfg.pad_x * width
    const padY = cfg.pad_y * height
    const anchorX = isRight ? left + width - padX : left + padX
    const anchorY = isBottom ? top + height - padY : top + padY

    // Map seconds → pixels using the x-scale.
    const xPerSec = width / Math.max(tRange, 1e-9)
    const xBarLenPx = xPick.value * xPerSec

    // Time bar
    ctx.save()
    ctx.lineCap = 'butt'
    ctx.strokeStyle = cfg.color
    ctx.lineWidth = cfg.thickness_pt * dpr
    ctx.beginPath()
    if (isRight) {
      ctx.moveTo(anchorX, anchorY)
      ctx.lineTo(anchorX - xBarLenPx, anchorY)
    } else {
      ctx.moveTo(anchorX, anchorY)
      ctx.lineTo(anchorX + xBarLenPx, anchorY)
    }
    ctx.stroke()

    if (cfg.show_labels) {
      ctx.fillStyle = cfg.color
      ctx.font = `${cfg.font_size * dpr}px var(--font-mono, monospace)`
      ctx.textAlign = 'center'
      ctx.textBaseline = isBottom ? 'top' : 'bottom'
      const labelX = isRight ? anchorX - xBarLenPx / 2 : anchorX + xBarLenPx / 2
      const labelY = isBottom
        ? anchorY + cfg.label_gap_pt * dpr
        : anchorY - cfg.label_gap_pt * dpr
      ctx.fillText(
        `${fmtValue(xPick.value * timeUnitFactor(xPick.unit))} ${xPick.unit}`,
        labelX, labelY,
      )
    }

    // Y bars — one per axis, all anchored at the same x as the time bar's
    // free end (so the L-shapes share a corner).
    const xBarFreeEnd = isRight ? anchorX - xBarLenPx : anchorX + xBarLenPx
    const yBarX = isRight ? anchorX : anchorX

    for (const axis of axes) {
      const scale = u.scales[axis.id]
      if (!scale || scale.min == null || scale.max == null) continue
      const yMin = scale.min as number
      const yMax = scale.max as number
      const yRange = yMax - yMin
      const override = cfg.y_overrides[axis.id]
      const yPick = override?.value && override.value > 0
        ? { value: override.value, unit: override.unit ?? axis.unit }
        : autoYScalebar(yRange, axis.unit)
      const pxPerY = height / Math.max(yRange, 1e-12)
      const yBarLenPx = yPick.value * pxPerY

      ctx.beginPath()
      // Anchor: at corner, extend toward plot interior on the y-axis.
      // Bottom-* corners → bar grows upward; top-* corners → grows downward.
      if (isBottom) {
        ctx.moveTo(yBarX, anchorY)
        ctx.lineTo(yBarX, anchorY - yBarLenPx)
      } else {
        ctx.moveTo(yBarX, anchorY)
        ctx.lineTo(yBarX, anchorY + yBarLenPx)
      }
      ctx.stroke()

      if (cfg.show_labels) {
        ctx.textAlign = isRight ? 'right' : 'left'
        ctx.textBaseline = 'middle'
        const labelX = isRight
          ? yBarX - cfg.label_gap_pt * dpr
          : yBarX + cfg.label_gap_pt * dpr
        const labelY = isBottom
          ? anchorY - yBarLenPx / 2
          : anchorY + yBarLenPx / 2
        ctx.save()
        ctx.translate(labelX, labelY)
        ctx.rotate(-Math.PI / 2)
        ctx.textAlign = 'center'
        ctx.textBaseline = isRight ? 'bottom' : 'top'
        ctx.fillText(`${fmtValue(yPick.value)} ${yPick.unit}`, 0, 0)
        ctx.restore()
      }
    }

    // Suppress unused-var warning for xBarFreeEnd — it's there for
    // clarity in case a future variant wants to draw the corner dot.
    void xBarFreeEnd
    ctx.restore()
  }
}
