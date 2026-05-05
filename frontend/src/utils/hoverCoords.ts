import type uPlot from 'uplot'
import { useAppStore } from '../stores/appStore'

export type HoverCoordOptions = {
  unitsRef?: { current: string | undefined | null }
  xUnit?: string
  xDigits?: number
  yDigits?: number
}

function createTip(container: HTMLElement): HTMLDivElement {
  // Mini-viewers rebuild the uPlot instance on data change, calling
  // attachHoverCoords each time. Strip any prior tip we left in this
  // container so badges don't multiply during pan/rebuild storms.
  const prior = container.querySelectorAll('[data-hover-coords-tip="1"]')
  prior.forEach((n) => n.remove())
  const tip = document.createElement('div')
  tip.setAttribute('data-hover-coords-tip', '1')
  tip.style.position = 'absolute'
  tip.style.display = 'none'
  tip.style.pointerEvents = 'none'
  tip.style.zIndex = '15'
  tip.style.padding = '2px 6px'
  tip.style.background = 'rgba(0, 0, 0, 0.72)'
  tip.style.color = '#fff'
  tip.style.fontSize = 'var(--font-size-label)'
  tip.style.fontFamily = 'var(--font-mono)'
  tip.style.borderRadius = '3px'
  tip.style.whiteSpace = 'nowrap'
  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative'
  }
  container.appendChild(tip)
  return tip
}

/**
 * Attach a hover-coord tooltip to a uPlot opts object before construction.
 * Mutates `opts.hooks.setCursor` to prepend our hook (so it composes with
 * any existing setCursor hooks the caller already has). Returns a function
 * the caller invokes AFTER `new uPlot(...)` runs, passing the container
 * element so the tooltip <div> can be appended.
 *
 * Visibility tracks `useAppStore.showCoordinates` live (no rebuild needed).
 */
export function attachHoverCoords(
  opts: any,
  options: HoverCoordOptions = {},
): (container: HTMLElement) => void {
  let tip: HTMLDivElement | null = null
  const xUnit = options.xUnit ?? 's'
  const xDigits = options.xDigits ?? 3
  const yDigits = options.yDigits ?? 3

  const hook = (u: uPlot) => {
    if (!tip) return
    const enabled = useAppStore.getState().showCoordinates
    if (!enabled) {
      tip.style.display = 'none'
      return
    }
    const left = u.cursor.left
    const top = u.cursor.top
    const idx = u.cursor.idx
    if (
      left == null || top == null || idx == null ||
      (left as number) < 0 || (top as number) < 0 || !isFinite(idx as number)
    ) {
      tip.style.display = 'none'
      return
    }
    const xs = (u.data[0] as unknown as number[])?.[idx as number]
    const ys = (u.data[1] as unknown as (number | null)[])?.[idx as number]
    if (xs == null || ys == null || !isFinite(xs as number) || !isFinite(ys as number)) {
      tip.style.display = 'none'
      return
    }
    const dpr = devicePixelRatio || 1
    const plotRight = u.bbox.width / dpr
    const approxTipW = 110
    const approxTipH = 22
    const offsetX = 12
    const offsetY = 14
    const nearRight = (left as number) + offsetX + approxTipW > plotRight
    const nearTop = (top as number) - offsetY - approxTipH < 0
    tip.style.display = 'block'
    tip.style.left = nearRight
      ? `${(left as number) - offsetX - approxTipW}px`
      : `${(left as number) + offsetX}px`
    tip.style.top = nearTop
      ? `${(top as number) + offsetY + 10}px`
      : `${(top as number) - offsetY - approxTipH}px`
    const yUnit = options.unitsRef?.current ? ` ${options.unitsRef.current}` : ''
    tip.textContent =
      `${(xs as number).toFixed(xDigits)} ${xUnit}  ·  ${(ys as number).toFixed(yDigits)}${yUnit}`
  }

  if (!opts.hooks) opts.hooks = {}
  const existing = opts.hooks.setCursor
  if (Array.isArray(existing)) {
    opts.hooks.setCursor = [hook, ...existing]
  } else if (typeof existing === 'function') {
    opts.hooks.setCursor = [hook, existing]
  } else {
    opts.hooks.setCursor = [hook]
  }

  return (container: HTMLElement) => {
    tip = createTip(container)
  }
}
