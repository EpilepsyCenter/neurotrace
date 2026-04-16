import React, { useEffect, useCallback } from 'react'
import { useAppStore } from './stores/appStore'
import { useThemeStore } from './stores/themeStore'
import { useLayoutStore } from './stores/layoutStore'
import { TreeNavigator } from './components/TreeNavigator/TreeNavigator'
import { TraceViewer } from './components/TraceViewer/TraceViewer'
import { CursorPanel } from './components/CursorPanel/CursorPanel'
import { Toolbar } from './components/Toolbar/Toolbar'
import { StatusBar } from './components/StatusBar/StatusBar'
import { ResizeHandle } from './components/ResizeHandle/ResizeHandle'

const MIN_SIDEBAR = 160
const MIN_TRACE = 200

function clamp(val: number, min: number, max: number) {
  return Math.max(min, Math.min(max, val))
}

export default function App() {
  const { initBackend } = useAppStore()
  const { initTheme } = useThemeStore()
  const {
    leftCollapsed, rightCollapsed, focusMode,
    leftWidth, rightWidth,
    toggleLeft, toggleRight, toggleFocus,
    setLeftWidth, setRightWidth,
    initLayout, persistLayout,
  } = useLayoutStore()

  useEffect(() => {
    initTheme()
    initLayout()
    initBackend()
  }, [initTheme, initLayout, initBackend])

  // --- Keyboard shortcuts for panel toggles ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      switch (e.key) {
        case 'F1': e.preventDefault(); toggleLeft(); break
        case 'F2': e.preventDefault(); toggleRight(); break
        case 'f':
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            toggleFocus()
          }
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleLeft, toggleRight, toggleFocus])

  const leftHidden = focusMode || leftCollapsed
  const rightHidden = focusMode || rightCollapsed

  const onResizeLeft = useCallback((delta: number) => {
    const current = useLayoutStore.getState().leftWidth
    setLeftWidth(clamp(current + delta, MIN_SIDEBAR, window.innerWidth * 0.35))
  }, [setLeftWidth])

  const onResizeRight = useCallback((delta: number) => {
    const current = useLayoutStore.getState().rightWidth
    setRightWidth(clamp(current - delta, MIN_SIDEBAR, window.innerWidth * 0.35))
  }, [setRightWidth])

  return (
    <div className="app">
      <Toolbar />
      <div className="app-main">
        {/* ---- Left sidebar ---- */}
        {leftHidden ? (
          <div
            className="collapsed-strip collapsed-strip-v"
            onClick={focusMode ? toggleFocus : toggleLeft}
            title="Show navigator (F1)"
          >
            <span>Navigator</span>
          </div>
        ) : (
          <>
            <div className="app-sidebar" style={{ width: leftWidth, minWidth: MIN_SIDEBAR }}>
              <div className="panel-header-bar">
                <button
                  className="collapse-btn"
                  onClick={toggleLeft}
                  title="Collapse (F1)"
                >{'\u25C0'}</button>
              </div>
              <TreeNavigator />
            </div>
            <ResizeHandle direction="horizontal" onResize={onResizeLeft} onResizeEnd={persistLayout} />
          </>
        )}

        {/* ---- Center: Trace viewer fills all remaining space ---- */}
        <div className="app-center">
          <div className="app-trace-area" style={{ minHeight: MIN_TRACE }}>
            <TraceViewer />

            {/* ---- Right sidebar: cursors only ---- */}
            {rightHidden ? (
              <div
                className="collapsed-strip collapsed-strip-v"
                onClick={focusMode ? toggleFocus : toggleRight}
                title="Show cursors (F2)"
              >
                <span>Cursors</span>
              </div>
            ) : (
              <>
                <ResizeHandle direction="horizontal" onResize={onResizeRight} onResizeEnd={persistLayout} />
                <div className="app-cursor-sidebar" style={{ width: rightWidth, minWidth: MIN_SIDEBAR }}>
                  <div className="panel-header-bar" style={{ justifyContent: 'flex-end' }}>
                    <button
                      className="collapse-btn"
                      onClick={toggleRight}
                      title="Collapse (F2)"
                    >{'\u25B6'}</button>
                  </div>
                  <CursorPanel />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <StatusBar />
    </div>
  )
}
