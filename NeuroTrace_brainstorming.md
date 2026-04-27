# NeuroTrace — Brainstorming Summary
*April 21, 2026*

---

## What is NeuroTrace

A cross-platform desktop app for in vitro patch clamp and field recording analysis. Electron frontend, Python backend. Built primarily around HEKA support.

---

## Market Position

**Primary competitor:** Easy Electrophysiology (EE)

**Key differentiators vs EE:**
- Field potential / fEPSP analysis — EE does not have this
- Burst analysis with multiple detection options — EE does not have this
- First-class HEKA .dat support — EE is weak here
- Paired-pulse ratio module (to be added)
- Input-output curve module (to be added)
- Cross-platform including Linux

**Addressable user base:**
- In vitro patch clamp labs (HEKA and Molecular Devices/Axon users)
- LTP/LTD labs
- Hippocampal/cortical oscillation labs
- Epilepsy in vitro models
- Pharmacology labs screening compounds on network activity

**Target positioning statement:**
*"The only modern cross-platform tool for in vitro patch clamp AND field recordings, with first-class HEKA support."*

---

## Feature Set (Current or Planned)

**Patch clamp:**
- IV curves
- AP properties (threshold, amplitude, half-width, AHP)
- Mini event detection (mEPSC/mIPSC)
- Burst analysis (multiple detection methods)
- Curve fitting (separate dedicated module)

**Field recordings:**
- fEPSP slope analysis
- LTP/LTD time course
- Input-output curves (stimulus intensity vs fEPSP slope — no curve fitting needed in this module, handled by separate curve fitting module)
- Paired-pulse ratio (single ISI and multi-ISI curves)

**File format support:**
- HEKA .dat (primary, robust)
- ABF / Axon (reads well, analysis modules need full testing)
- Others TBD

**Export:**
- CSV (current)
- GraphPad Prism .pzfx (designed, implemented — see below)

---

## Prism Export

Built using the `pzfx` Python library (v0.3.1). A `PrismExporter` class was designed with dedicated methods for each analysis type:

- `fepsp_timecourse` — XY table, time vs normalized slope, multiple groups
- `input_output` — stimulus intensity vs fEPSP slope per animal
- `paired_pulse` — ISI vs PPR per group
- `iv_curve` — voltage vs current per cell
- `ap_properties` — grouped column table per cell
- `mini_summary` — frequency, amplitude, kinetics per cell
- `burst_summary` — frequency, duration, spikes/burst, IBI per recording
- `full_experiment` — multiple tables in a single .pzfx file

**Design principle:** always export raw replicates, never pre-summarized mean±SEM. Prism calculates statistics from raw values. This is correct scientific practice and gives labs full analytical flexibility.

---

## JSON Persistence Architecture

**Concept:** every analysis result and its parameters saved automatically to a JSON sidecar file alongside the recording file. No user action required — silent, like a sidecar file.

**JSON schema per recording:**
```json
{
  "neurotrace_version": "1.0.0",
  "created": "ISO timestamp",
  "recording": {
    "source_file": "filename.dat",
    "format": "HEKA",
    "date_recorded": "date"
  },
  "analyses": {
    "analysis_name": {
      "timestamp": "ISO timestamp",
      "parameters": { ... },
      "results": { ... }
    }
  }
}
```

**Multi-file Prism export flow:**
1. User selects multiple JSON files or a folder
2. NeuroTrace groups results by analysis type
3. Each analysis type → one Prism table, columns = recordings
4. Writes single .pzfx file

**Open design questions:**
- Overwrite vs append when same analysis is re-run with different parameters (recommendation: keep last run initially)
- Parameter mismatch warnings when grouping across recordings (e.g. different voltage ranges in IO curves)

**Analysis log table:** worth adding as an extra sheet in every exported .pzfx — software version, date, source files, all parameters used. Low cost to implement, gets cited in Methods sections.

---

## Business Model

**Target:** academic-only initially, industry later.

**Recommended model: academic free, commercial paid**

- **Academic:** completely free, no registration, no restrictions. Maximizes adoption and citations.
- **Commercial (CROs, pharma, biotech):** €1,500–3,000/year per site license
- **Optional academic lab support license:** €150–200/year, no gated features, for grant-funded labs who want to support development

**Realistic revenue expectation:** €5,000–15,000/year within 2–3 years of launch. Meaningful supplement, not a salary.

**Industry validation requirements** (cross that bridge when a customer appears, not speculatively):
- Basic IQ/OQ documentation — weeks of work, satisfies smaller biotech/CRO
- Full software validation package — months of work, needed for serious CROs
- 21 CFR Part 11 compliance — significant effort, only if large pharma asks

---

## Go-to-Market Strategy

**Phase 1 — Internal beta:**
- Test all analysis modules end-to-end with both HEKA and ABF files
- Fix ABF gotchas (units/scaling, episodic vs gap-free, multi-channel, ABF1 vs ABF2)
- Internal HEKA colleagues at Lund

**Phase 2 — External beta:**
- 3-5 labs via Molecular Devices network
- Ask for representative ABF files before even mentioning NeuroTrace
- Compare outputs against Clampfit as ground truth

**Phase 3 — Publication:**
- Methods paper: JOSS (low barrier, citable DOI) or Journal of Neuroscience Methods (more visibility)
- Include worked example of complete field recording workflow: IO curve → PPR → LTP time course
- Benchmarking of event/burst detection vs existing tools = citation magnet

**Phase 4 — Public launch:**
- Minimal landing page: download link + "commercial licensing" email
- No complex infrastructure needed initially

**Timeline:** roughly 6–12 months of part-time work to reach public launch.

**Key insight:** one respected PI adopting it at a good institution matters more than any marketing. Word of mouth in this community is everything.

---

## Immediate Technical Priorities

1. Test all analysis modules with ABF files end-to-end
2. Implement JSON persistence (Python backend, automatic after every analysis)
3. Implement multi-file grouping and Prism export
4. Add paired-pulse ratio module
5. Add input-output curve module (slope only, curve fitting handled by existing separate module)
6. Internal beta with HEKA colleagues

---

## Ongoing Good Practices

- Keep a changelog from day one — becomes validation documentation later
- Composable module design — IO module stays clean, curve fitting is separate
- Never pre-summarize data before export
- Parameter mismatch warnings before multi-file export

---

*Next brainstorming topics when relevant: landing page content, methods paper structure, beta feedback process*
