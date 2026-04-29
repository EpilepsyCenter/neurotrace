"""Trace export module — Phase C.

Builds publication-ready figures (SVG / PDF / PNG) and serves
processed sample arrays for the live uPlot preview. The data
processing pipeline lives in :mod:`trace_processing` and is shared
between the live-preview and final-render endpoints so what the
user sees in the live panel is what they'll get in the export.
"""
