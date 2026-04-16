# LTP/LTD Analysis
# Compute fEPSP slope for each sweep, normalize to baseline, plot over time

import numpy as np

# Configuration
baseline_sweeps = range(0, 10)  # first 10 sweeps as baseline
n = stf.n_sweeps()

stf.set_cursors(peak_start=0.005, peak_end=0.025)

# Measure all slopes
slopes = []
for i in range(n):
    stf.select(sweep=i)
    r = stf.measure("field_potential", measure="slope")
    slopes.append(r.get("slope", 0))

slopes = np.array(slopes)

# Normalize to baseline mean
baseline_mean = np.mean(slopes[list(baseline_sweeps)])
normalized = (slopes / baseline_mean) * 100 if baseline_mean != 0 else slopes

# Results
results = []
for i in range(n):
    results.append({
        "sweep": i + 1,
        "slope": round(slopes[i], 4),
        "normalized_%": round(normalized[i], 1),
    })

stf.to_table(results)
stf.plot(normalized, label="Normalized fEPSP slope (%)")

# Summary
last_5min = normalized[-5:] if len(normalized) >= 5 else normalized
print(f"Baseline slope: {baseline_mean:.4f}")
print(f"Last 5 sweeps: {np.mean(last_5min):.1f}% of baseline")
change = np.mean(last_5min) - 100
print(f"{'LTP' if change > 10 else 'LTD' if change < -10 else 'No change'}: {change:+.1f}%")
