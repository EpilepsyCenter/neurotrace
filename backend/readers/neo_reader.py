"""Generic reader using the Neo library for 50+ electrophysiology formats."""

from __future__ import annotations

import os

import numpy as np

from .base import BaseReader
from .models import Recording, Group, Series, Sweep, Trace

# File extension to Neo IO class mapping
NEO_FORMAT_MAP = {
    ".wcp": "WinWcpIO",
    ".axgd": "AxographIO",
    ".axgx": "AxographIO",
    ".smr": "Spike2IO",
    ".h5": "NeoHdf5IO",
    ".nwb": "NWBIO",
    ".nix": "NixIO",
    ".mcd": "MicromedIO",
    ".plx": "PlexonIO",
    ".nev": "BlackrockIO",
    ".ns5": "BlackrockIO",
    ".edf": "EdfIO",
    ".bdf": "EdfIO",
    ".rhd": "IntanIO",
    ".rhs": "IntanIO",
}


class NeoReader(BaseReader):
    """Reader wrapping Neo library for broad format support."""

    @staticmethod
    def can_read(file_path: str) -> bool:
        ext = os.path.splitext(file_path)[1].lower()
        return ext in NEO_FORMAT_MAP

    def read(self, file_path: str) -> Recording:
        import neo

        ext = os.path.splitext(file_path)[1].lower()
        io_class_name = NEO_FORMAT_MAP.get(ext)
        if not io_class_name:
            raise ValueError(f"Unsupported format: {ext}")

        # Dynamically get the Neo IO class
        io_class = getattr(neo.io, io_class_name, None)
        if io_class is None:
            # Try rawio
            io_class = getattr(neo.rawio, io_class_name, None)
        if io_class is None:
            raise ValueError(f"Neo IO class not found: {io_class_name}")

        reader = io_class(filename=file_path)
        block = reader.read_block(lazy=False)

        recording = Recording(
            file_path=file_path,
            file_name=os.path.basename(file_path),
            format=io_class_name.replace("IO", ""),
        )

        # Neo structure: Block > Segment (≈ sweep/trial) > AnalogSignal
        # We map: Block → Group, Segments grouped by protocol → Series, Segment → Sweep
        group = Group(index=0, label=block.name or "Recording")

        # For simplicity, put all segments in one series
        series = Series(index=0, label="Series 1")

        for seg_idx, segment in enumerate(block.segments):
            sweep = Sweep(index=seg_idx, label=f"Sweep {seg_idx + 1}")

            for sig in segment.analogsignals:
                data = np.array(sig).flatten().astype(np.float64)
                sr = float(sig.sampling_rate.rescale("Hz").magnitude)
                units = str(sig.units.dimensionality)

                # Clean up units
                if "A" in units:
                    units = "pA"
                elif "V" in units:
                    units = "mV"

                trace = Trace(
                    data=data,
                    sampling_rate=sr,
                    units=units,
                    label=sig.name or f"Signal {sig_idx}",
                )
                sweep.traces.append(trace)

            series.sweeps.append(sweep)

        group.series_list.append(series)
        recording.groups.append(group)

        return recording
