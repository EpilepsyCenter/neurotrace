"""Native HEKA PatchMaster .dat file parser.

Parses the bundle header, .pul (acquisition tree), .pgf (stimulus tree),
and raw trace data without depending on myokit.

Supports DAT2 (little-endian) bundles from modern PatchMaster (v2x90+).
"""
