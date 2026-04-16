import React, { useCallback, useRef, useEffect } from 'react'

interface ResizeHandleProps {
  /** 'horizontal' drags left-right (resizes width), 'vertical' drags up-down (resizes height) */
  direction: 'horizontal' | 'vertical'
  /** Called continuously during drag with the delta in px since drag start */
  onResize: (delta: number) => void
  /** Called once when drag ends */
  onResizeEnd?: () => void
}

export function ResizeHandle({ direction, onResize, onResizeEnd }: ResizeHandleProps) {
  const startPos = useRef(0)
  const dragging = useRef(false)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const current = direction === 'horizontal' ? ev.clientX : ev.clientY
      const delta = current - startPos.current
      startPos.current = current
      onResize(delta)
    }

    const onMouseUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      onResizeEnd?.()
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [direction, onResize, onResizeEnd])

  const isHoriz = direction === 'horizontal'

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        ...(isHoriz
          ? { width: 5, cursor: 'col-resize', minWidth: 5 }
          : { height: 5, cursor: 'row-resize', minHeight: 5 }),
        background: 'transparent',
        position: 'relative',
        flexShrink: 0,
        zIndex: 5,
      }}
    >
      {/* Visible line on hover */}
      <div
        className="resize-handle-line"
        style={{
          position: 'absolute',
          ...(isHoriz
            ? { top: 0, bottom: 0, left: 2, width: 1 }
            : { left: 0, right: 0, top: 2, height: 1 }),
          background: 'var(--border)',
          transition: 'background 0.15s',
        }}
      />
    </div>
  )
}
