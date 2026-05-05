/**
 * Linear interpolation of the displayed trace's y-value at a given
 * time, against a non-uniform (LTTB-decimated) time array. Used by
 * overlay drawing in all viewers so markers sit on the currently
 * displayed trace — filtered, unfiltered, zero-offset, or otherwise —
 * instead of on the raw value the analysis recorded at detection time.
 *
 * Returns null for out-of-range times or unusable inputs so the caller
 * can fall back to the stored y-value (and not draw a wildly wrong
 * marker if e.g. the trace data isn't loaded yet).
 */
export function sampleTraceYAt(
  times: ArrayLike<number> | null | undefined,
  values: ArrayLike<number> | null | undefined,
  t: number,
): number | null {
  if (!times || !values) return null
  const n = times.length
  if (n === 0 || values.length === 0) return null
  if (!isFinite(t)) return null
  if (t <= times[0]) return Number(values[0])
  if (t >= times[n - 1]) return Number(values[n - 1])
  let lo = 0, hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= t) lo = mid
    else hi = mid
  }
  const t0 = times[lo], t1 = times[hi]
  const v0 = Number(values[lo]), v1 = Number(values[hi])
  if (t1 === t0) return v0
  const frac = (t - t0) / (t1 - t0)
  return v0 + frac * (v1 - v0)
}
