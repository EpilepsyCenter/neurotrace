# Batch Resistance Analysis
# Compute Rs and Rin for every sweep in the current series

import numpy as np

results = []
n = stf.n_sweeps()
stf.set_cursors(baseline_start=0, baseline_end=0.005, peak_start=0.005, peak_end=0.02)

for i in range(n):
    stf.select(sweep=i)
    r = stf.measure("resistance", v_step=5.0)
    results.append({
        "sweep": i + 1,
        "Rs (MOhm)": r.get("rs"),
        "Rin (MOhm)": r.get("rin"),
        "Cm (pF)": r.get("cm"),
    })
    if r.get("rs"):
        print(f"Sweep {i+1}: Rs={r['rs']:.1f} MOhm, Rin={r.get('rin', 0):.1f} MOhm")

stf.to_table(results)
print(f"\nProcessed {n} sweeps")
