import { useEffect } from 'react'

/**
 * Replaces native HTML ``[title]`` tooltips with a styled custom one.
 *
 * Strategy:
 *   1. On ``mouseover`` for any element with a ``title`` attribute,
 *      lift the title into a custom data attribute so the OS-default
 *      tooltip never fires.
 *   2. Render a single floating ``.tooltip`` element positioned near
 *      the cursor, populated with the lifted text.
 *   3. On ``mouseout`` (or scroll / click) hide the tooltip and
 *      restore the original ``title`` so screen readers still see it.
 *
 * Mount once at the app root via ``useGlobalTooltips()``.
 */
const STORE_ATTR = 'data-orig-title'

export function useGlobalTooltips() {
  useEffect(() => {
    let el: HTMLElement | null = null
    let activeTarget: HTMLElement | null = null
    let showTimer: number | undefined
    let hideTimer: number | undefined

    function ensureTooltip(): HTMLElement {
      if (el && document.body.contains(el)) return el
      el = document.createElement('div')
      el.className = 'tooltip'
      el.setAttribute('role', 'tooltip')
      document.body.appendChild(el)
      return el
    }

    function findTitled(target: EventTarget | null): HTMLElement | null {
      let cur = target as HTMLElement | null
      while (cur && cur !== document.body) {
        if (cur.hasAttribute('title') || cur.hasAttribute(STORE_ATTR)) {
          return cur
        }
        cur = cur.parentElement
      }
      return null
    }

    function position(ev: MouseEvent) {
      if (!el) return
      const pad = 12
      const r = el.getBoundingClientRect()
      let x = ev.clientX + 14
      let y = ev.clientY + 18
      if (x + r.width + pad > window.innerWidth) x = window.innerWidth - r.width - pad
      if (y + r.height + pad > window.innerHeight) y = ev.clientY - r.height - 12
      if (y < pad) y = pad
      if (x < pad) x = pad
      el.style.left = `${x}px`
      el.style.top = `${y}px`
    }

    function show(target: HTMLElement, ev: MouseEvent) {
      // Lift title → data-orig-title so the OS tooltip never fires
      const native = target.getAttribute('title')
      if (native != null) {
        target.setAttribute(STORE_ATTR, native)
        target.removeAttribute('title')
      }
      const text = target.getAttribute(STORE_ATTR) ?? ''
      if (!text.trim()) return
      const node = ensureTooltip()
      node.textContent = text
      activeTarget = target
      position(ev)
      // Fade-in next frame so transition triggers
      window.clearTimeout(hideTimer)
      hideTimer = undefined
      window.requestAnimationFrame(() => node.classList.add('tooltip-visible'))
    }

    function hide() {
      if (!el) return
      el.classList.remove('tooltip-visible')
      // Restore title so SR / accessibility tools see it
      if (activeTarget) {
        const stored = activeTarget.getAttribute(STORE_ATTR)
        if (stored != null && !activeTarget.hasAttribute('title')) {
          activeTarget.setAttribute('title', stored)
        }
        activeTarget = null
      }
    }

    function onOver(ev: MouseEvent) {
      const target = findTitled(ev.target)
      if (!target) return
      window.clearTimeout(showTimer)
      showTimer = window.setTimeout(() => show(target, ev), 320)
    }

    function onOut(ev: MouseEvent) {
      const target = findTitled(ev.target)
      if (!target) return
      // Only hide if leaving the active titled element
      const related = ev.relatedTarget as Node | null
      if (related && target.contains(related)) return
      window.clearTimeout(showTimer)
      showTimer = undefined
      hide()
    }

    function onMove(ev: MouseEvent) {
      if (el && el.classList.contains('tooltip-visible')) {
        position(ev)
      }
    }

    function onScroll() {
      window.clearTimeout(showTimer)
      showTimer = undefined
      hide()
    }

    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout',  onOut,  true)
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mousedown', onScroll, true)
    document.addEventListener('wheel',     onScroll, { capture: true, passive: true })
    window.addEventListener('blur', onScroll)
    window.addEventListener('keydown', onScroll, true)

    return () => {
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout',  onOut,  true)
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mousedown', onScroll, true)
      document.removeEventListener('wheel',     onScroll, { capture: true } as EventListenerOptions)
      window.removeEventListener('blur', onScroll)
      window.removeEventListener('keydown', onScroll, true)
      if (el && el.parentNode) el.parentNode.removeChild(el)
      el = null
    }
  }, [])
}
