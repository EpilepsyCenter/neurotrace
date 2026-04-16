# Event Frequency Over Time
# Detect events in each sweep and plot frequency over time

import numpy as np

results = []
n = stf.n_sweeps()

for i in range(n):
    stf.select(sweep=i)
    r = stf.measure("events", method="threshold", direction="negative")
    freq = r.get("frequency_hz", 0)
    n_events = r.get("n_events", 0)
    results.append({
        "sweep": i + 1,
        "n_events": n_events,
        "frequency_hz": round(freq, 2),
        "mean_amplitude": round(r.get("mean_amplitude", 0), 2),
    })
    print(f"Sweep {i+1}: {n_events} events, {freq:.1f} Hz")

stf.to_table(results)

# Plot frequency over time
freqs = [r["frequency_hz"] for r in results]
stf.plot(freqs, label="Event Frequency (Hz)")
print(f"\nMean frequency: {np.mean(freqs):.1f} Hz")
