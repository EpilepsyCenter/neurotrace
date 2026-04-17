import React, { useEffect, useState } from 'react'

/** Number input that doesn't lose focus on every keystroke.
 *
 * Uses ``type="text"`` + ``inputMode="decimal"`` rather than ``type="number"``
 * on purpose: native number inputs format their displayed value with the
 * user's locale, which shows decimal commas (1,5) on European systems and
 * makes the UI inconsistent with our dot-separated tables/CSV. We render the
 * value using JavaScript's default ``String(n)`` (always dot) and accept
 * either dot or comma when parsing so users can type naturally either way.
 *
 * Keeps a local string buffer while focused and only calls
 * ``onChange(numericValue)`` on blur or Enter. Re-syncs from the external
 * value whenever it changes, as long as the input is not focused. */
export function NumInput({
  value,
  onChange,
  step: _step,
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
  /** Kept for API compat; unused now that we render as text. */
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
    // Accept comma OR dot as decimal separator — we normalize either way.
    const n = parseFloat(local.replace(',', '.'))
    if (isFinite(n)) {
      let clamped = n
      if (min != null) clamped = Math.max(min, clamped)
      if (max != null) clamped = Math.min(max, clamped)
      onChange(clamped)
      // Snap the displayed value to the canonical dot form.
      setLocal(String(clamped))
    } else {
      setLocal(String(value))
    }
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      // Matches standard floats incl. optional sign and exponent. The
      // comma variant for the decimal is accepted so a user on a European
      // locale can type naturally; commit() normalizes to dot.
      pattern="^-?\d*([.,]\d*)?([eE][-+]?\d+)?$"
      value={local}
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
