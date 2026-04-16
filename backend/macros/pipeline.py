"""Visual pipeline execution engine.

Executes a node graph defined as JSON from the React Flow frontend.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from readers.models import Recording
from analysis.base import get_analysis
from utils.filters import lowpass_filter, highpass_filter, bandpass_filter


def execute_pipeline(
    pipeline: dict,
    recording: Recording,
    group: int,
    series: int,
    sweep: int,
    trace: int,
) -> dict:
    """Execute a visual analysis pipeline.

    Pipeline format:
    {
        "nodes": [
            {"id": "1", "type": "input", "data": {"source": "current_trace"}},
            {"id": "2", "type": "filter", "data": {"filter_type": "lowpass", "cutoff": 1000}},
            {"id": "3", "type": "analysis", "data": {"analysis_type": "cursors", "params": {...}}},
            {"id": "4", "type": "output", "data": {"output_type": "table"}},
        ],
        "edges": [
            {"source": "1", "target": "2"},
            {"source": "2", "target": "3"},
            {"source": "3", "target": "4"},
        ]
    }
    """
    nodes = {n["id"]: n for n in pipeline.get("nodes", [])}
    edges = pipeline.get("edges", [])

    # Build adjacency list
    adj: dict[str, list[str]] = {}
    for edge in edges:
        adj.setdefault(edge["source"], []).append(edge["target"])

    # Find root nodes (no incoming edges)
    targets = {e["target"] for e in edges}
    roots = [n for n in nodes if n not in targets]

    # Execute in topological order
    outputs: dict[str, Any] = {}
    results: list[dict] = []

    def process_node(node_id: str):
        if node_id in outputs:
            return outputs[node_id]

        node = nodes[node_id]
        node_type = node.get("type", "")
        data = node.get("data", {})

        # Get input from parent nodes
        parent_edges = [e for e in edges if e["target"] == node_id]
        input_data = None
        if parent_edges:
            parent_id = parent_edges[0]["source"]
            input_data = process_node(parent_id)

        if node_type == "input":
            # Load trace data
            source = data.get("source", "current_trace")
            tr = recording.groups[group].series_list[series].sweeps[sweep].traces[trace]
            output = {"data": tr.data.copy(), "sampling_rate": tr.sampling_rate, "units": tr.units}

        elif node_type == "filter":
            if input_data is None:
                raise ValueError(f"Filter node {node_id} has no input")
            signal = input_data["data"]
            sr = input_data["sampling_rate"]
            ft = data.get("filter_type", "lowpass")
            cutoff = data.get("cutoff", 1000)

            if ft == "lowpass":
                filtered = lowpass_filter(signal, cutoff, sr)
            elif ft == "highpass":
                filtered = highpass_filter(signal, cutoff, sr)
            elif ft == "bandpass":
                filtered = bandpass_filter(signal, data.get("low", 1), data.get("high", 100), sr)
            else:
                filtered = signal

            output = {**input_data, "data": filtered}

        elif node_type == "analysis":
            if input_data is None:
                raise ValueError(f"Analysis node {node_id} has no input")
            analysis_type = data.get("analysis_type", "cursors")
            params = data.get("params", {})
            analysis = get_analysis(analysis_type)
            result = analysis.run(input_data["data"], input_data["sampling_rate"], params)
            output = {"result": result, **input_data}

        elif node_type == "math":
            if input_data is None:
                raise ValueError(f"Math node {node_id} has no input")
            op = data.get("operation", "none")
            signal = input_data["data"]

            if op == "abs":
                signal = np.abs(signal)
            elif op == "diff":
                signal = np.diff(signal, prepend=signal[0])
            elif op == "cumsum":
                signal = np.cumsum(signal)
            elif op == "normalize":
                signal = (signal - np.mean(signal)) / (np.std(signal) + 1e-10)
            elif op == "detrend":
                from scipy.signal import detrend
                signal = detrend(signal)
            elif op == "multiply":
                signal = signal * data.get("factor", 1.0)
            elif op == "add":
                signal = signal + data.get("offset", 0.0)

            output = {**input_data, "data": signal}

        elif node_type == "output":
            output_type = data.get("output_type", "table")
            result_data = input_data.get("result", {}) if input_data else {}
            results.append({
                "node_id": node_id,
                "output_type": output_type,
                "data": result_data,
            })
            output = input_data

        else:
            output = input_data

        outputs[node_id] = output
        return output

    # Process all nodes starting from roots
    for root in roots:
        process_node(root)

    # Also process any unvisited nodes
    for node_id in nodes:
        if node_id not in outputs:
            process_node(node_id)

    return {
        "success": True,
        "results": results,
        "n_nodes_processed": len(outputs),
    }
