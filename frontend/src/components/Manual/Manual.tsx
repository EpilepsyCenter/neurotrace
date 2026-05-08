import React, { useEffect, useMemo, useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import manualMd from '../../../../docs/MANUAL.md?raw'
import { Icon } from '../common/Icon'

// Bundle every PNG / JPG / SVG sitting in docs/screenshots/ so that
// markdown ``![alt](screenshots/foo.png)`` references resolve to the
// hashed asset URL Vite emits at build time. Without this the
// `<img src="screenshots/foo.png">` we render is resolved relative to
// the Electron page URL — which is somewhere under ``frontend/dist/``
// where ``screenshots/`` doesn't exist, so every image silently 404s.
const screenshotModules = import.meta.glob<string>(
  '../../../../docs/screenshots/*.{png,jpg,jpeg,svg,webp}',
  { eager: true, query: '?url', import: 'default' }
)
const screenshotByName: Record<string, string> = {}
for (const [path, url] of Object.entries(screenshotModules)) {
  const name = path.split('/').pop()
  if (name) screenshotByName[name] = url
}

/**
 * Local user manual viewer. Bundled at build time via Vite's
 * ``?raw`` import — no runtime fs read, no network — so the manual
 * is always the version that shipped with the running build.
 *
 * The component is intended to be hosted inside an Electron analysis
 * window (``view=manual``). It provides:
 *
 *   - A left-hand table of contents auto-generated from the markdown
 *     headings (H1 / H2 / H3). Clicking jumps to the section.
 *   - A search box that filters the TOC by heading text.
 *   - A scrolling content pane with the full manual rendered via
 *     ``react-markdown`` + GFM (tables, autolinks).
 *   - Heading IDs are slugified so deep links (#-anchors) work and
 *     the TOC can ``scrollIntoView`` reliably.
 */

interface Heading {
  level: number
  text: string
  id: string
}

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

function extractHeadings(md: string): Heading[] {
  const out: Heading[] = []
  const seen = new Map<string, number>()
  // Skip headings that fall inside fenced code blocks
  const lines = md.split('\n')
  let inFence = false
  for (const line of lines) {
    if (line.startsWith('```')) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const level = m[1].length
    const text = m[2].replace(/`/g, '')
    let id = slugify(text)
    const dup = seen.get(id) ?? 0
    if (dup > 0) id = `${id}-${dup}`
    seen.set(slugify(text), dup + 1)
    out.push({ level, text, id })
  }
  return out
}

export function Manual() {
  const headings = useMemo(() => extractHeadings(manualMd), [])
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // After every render, walk the rendered headings inside the
  // content pane and set ``id`` attributes that match the slugs
  // produced by ``extractHeadings``. Doing this in the DOM (rather
  // than via react-markdown component overrides) keeps the TOC's
  // ID generation and the rendered ID generation in lockstep —
  // any drift between them silently breaks click-to-jump, which
  // is exactly what was happening before.
  useEffect(() => {
    const root = contentRef.current
    if (!root) return
    const headers = root.querySelectorAll<HTMLElement>('h1, h2, h3')
    const seen = new Map<string, number>()
    headers.forEach((h) => {
      const text = (h.textContent ?? '').trim()
      if (!text) return
      const base = slugify(text)
      const dup = seen.get(base) ?? 0
      const id = dup > 0 ? `${base}-${dup}` : base
      seen.set(base, dup + 1)
      h.id = id
    })
  })

  // Auto-update active section as the user scrolls.
  useEffect(() => {
    const root = contentRef.current
    if (!root) return
    const onScroll = () => {
      const headers = root.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id]')
      let current: string | null = null
      const offset = root.getBoundingClientRect().top + 60
      for (const h of Array.from(headers)) {
        if (h.getBoundingClientRect().top <= offset) current = h.id
        else break
      }
      setActiveId(current)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => root.removeEventListener('scroll', onScroll)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return headings
    return headings.filter((h) => h.text.toLowerCase().includes(q))
  }, [headings, query])

  const jumpTo = (id: string) => {
    const el = contentRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="manual">
      <aside className="manual-toc">
        <div className="manual-toc-search">
          <Icon name="chevron-down" size={12} className="manual-toc-icon" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <nav className="manual-toc-list">
          {filtered.length === 0 && (
            <div className="manual-toc-empty">No matches.</div>
          )}
          {filtered.map((h) => (
            <button
              key={`${h.id}-${h.level}`}
              className={`manual-toc-row level-${h.level} ${activeId === h.id ? 'active' : ''}`}
              onClick={() => jumpTo(h.id)}
              title={h.text}
            >
              <span className="manual-toc-tick" />
              <span className="manual-toc-label">{h.text}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="manual-content" ref={contentRef}>
        <article>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a
                  href={href}
                  onClick={(e) => {
                    if (href?.startsWith('http')) {
                      e.preventDefault()
                      if (window.electronAPI?.openExternal) {
                        window.electronAPI.openExternal(href)
                      } else {
                        window.open(href, '_blank')
                      }
                    }
                  }}
                >
                  {children}
                </a>
              ),
              img: ({ src, alt }) => {
                const srcStr = typeof src === 'string' ? src : ''
                // External or already-resolved URLs pass through untouched.
                if (!srcStr.startsWith('screenshots/')) {
                  return <img src={srcStr} alt={alt ?? ''} loading="lazy" />
                }
                const name = srcStr.slice('screenshots/'.length)
                const url = screenshotByName[name]
                if (url) {
                  return <img src={url} alt={alt ?? ''} loading="lazy" />
                }
                // Screenshot referenced but not yet captured — render a
                // neutral placeholder rather than a broken <img>.
                return (
                  <span className="manual-img-missing" role="img" aria-label={alt ?? ''}>
                    <span className="k">Screenshot pending</span>
                    <span className="v">{name}</span>
                  </span>
                )
              },
            }}
          >
            {manualMd}
          </ReactMarkdown>
        </article>
      </main>
    </div>
  )
}
