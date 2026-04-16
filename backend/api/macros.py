"""Macro execution API — run Python scripts and visual pipelines."""

from __future__ import annotations

import io
import sys
import traceback
from contextlib import redirect_stdout, redirect_stderr

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.files import get_current_recording
from macros.api import create_macro_api

router = APIRouter()


class MacroRunRequest(BaseModel):
    code: str


class PipelineRunRequest(BaseModel):
    pipeline: dict  # Node graph definition
    group: int = 0
    series: int = 0
    sweep: int = 0
    trace: int = 0


@router.post("/run")
async def run_macro(req: MacroRunRequest):
    """Execute a Python macro script."""
    rec = get_current_recording()

    # Create the macro API context
    stf_api = create_macro_api(rec)

    # Capture stdout/stderr
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()

    # Build execution namespace
    namespace = {
        "stf": stf_api,
        "np": __import__("numpy"),
        "numpy": __import__("numpy"),
        "scipy": __import__("scipy"),
        "__builtins__": __builtins__,
    }

    try:
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            exec(compile(req.code, "<macro>", "exec"), namespace)

        output = stdout_buf.getvalue()
        errors = stderr_buf.getvalue()

        result = {
            "output": output + (f"\n{errors}" if errors else ""),
            "success": True,
        }

        # Include any results the macro sent to the table
        if hasattr(stf_api, "_table_results") and stf_api._table_results:
            result["table_results"] = stf_api._table_results

        return result

    except Exception as e:
        tb = traceback.format_exc()
        return {
            "output": stdout_buf.getvalue(),
            "error": f"{type(e).__name__}: {e}\n{tb}",
            "success": False,
        }


@router.post("/pipeline/run")
async def run_pipeline(req: PipelineRunRequest):
    """Execute a visual analysis pipeline."""
    rec = get_current_recording()

    try:
        from macros.pipeline import execute_pipeline
        result = execute_pipeline(req.pipeline, rec, req.group, req.series, req.sweep, req.trace)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Pipeline error: {e}")
