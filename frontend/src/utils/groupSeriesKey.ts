/**
 * Shared helper for converting our internal 0-indexed analysis storage
 * keys to the 1-indexed form HEKA's UI shows the user.
 *
 * Sidecar JSONs key analyses + series_tags by ``${group}:${series}``
 * (or ``${group}:${series}:${subtype}`` for FPsp), with ``group`` and
 * ``series`` as 0-based array indices. The TreeNavigator already
 * displays "Group 1, Series 1" (1-indexed) — these helpers keep
 * everywhere else consistent so users never see the off-by-one.
 *
 * Storage stays 0-indexed (the runners + readers operate on real array
 * indices); only user-facing strings shift.
 */

/** Convert a 0-indexed storage key (``"0:3"``, ``"0:3:ltp"``) to its
 *  1-indexed display form (``"1:4"``, ``"1:4:ltp"``). Non-numeric or
 *  malformed input is returned unchanged so callers can pass arbitrary
 *  strings safely. */
export function displayGroupSeries(key: string): string {
  const parts = key.split(':')
  if (parts.length < 2) return key
  const g = Number(parts[0])
  const s = Number(parts[1])
  if (!Number.isFinite(g) || !Number.isFinite(s)) return key
  const head = `${g + 1}:${s + 1}`
  return parts.length > 2 ? `${head}:${parts.slice(2).join(':')}` : head
}
