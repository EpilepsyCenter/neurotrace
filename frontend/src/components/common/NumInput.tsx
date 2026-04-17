import React, { useEffect, useState } from 'react'

/** Number input that doesn't lose focus on every keystroke.
 *
 * The raw `<input type="number" value={state} onChange={parseFloat}>` pattern
 * breaks multi-digit / decimal / negative typing because intermediate states
 * like "-" or "." or "" fail to parse, causing the committed value (and
 * input.value) to snap back on every keystroke.
 *
 * This wrapper keeps a local string buffer while focused and only calls
 * ``onChange(numericValue)`` on blur or Enter. It also re-syncs from the
 * external value whenever it changes, as long as the input is not focused. */
export function NumInput({
  value,
  onChange,
  step,
  min,
  max,
  placeholder,
  style,
  disabled,
  title,
  className,
}: {
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  placeholder?: string
  style?: React.CSSProperties
  disabled?: boolean
  title?: string
  className?: string
}) {
  const [local, setLocal] = useState(String(value))
  const [focused, setFocused] = useState(false)

  // Sync from external value when NOT focused (store changed elsewhere)
  useEffect(() => {
    if (!focused) setLocal(String(value))
  }, [value, focused])

  const commit = () => {
    const n = parseFloat(local)
    if (isFinite(n)) onChange(n)
    else setLocal(String(value))
  }

  return (
    <input
      type="number"
      value={local}
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      style={style}
      disabled={disabled}
      title={title}
      className={className}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}
