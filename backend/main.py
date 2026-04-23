"""NeuroTrace Python Backend — FastAPI server for electrophysiology analysis."""

import argparse
import sys
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.files import router as files_router
from api.traces import router as traces_router
from api.analysis import router as analysis_router
from api.macros import router as macros_router
from api.resistance import router as resistance_router
from api.results import router as results_router
from api.iv import router as iv_router
from api.fpsp import router as fpsp_router
from api.cursors import router as cursors_router
from api.bursts import router as bursts_router
from api.ap import router as ap_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup/shutdown."""
    print("NeuroTrace backend starting...")
    yield
    print("NeuroTrace backend shutting down...")


app = FastAPI(title="NeuroTrace Backend", version="0.2.3", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(files_router, prefix="/api/files", tags=["files"])
app.include_router(traces_router, prefix="/api/traces", tags=["traces"])
app.include_router(analysis_router, prefix="/api/analysis", tags=["analysis"])
app.include_router(macros_router, prefix="/api/macros", tags=["macros"])
app.include_router(resistance_router, prefix="/api/resistance", tags=["resistance"])
app.include_router(results_router, prefix="/api/results", tags=["results"])
app.include_router(iv_router, prefix="/api/iv", tags=["iv"])
app.include_router(fpsp_router, prefix="/api/fpsp", tags=["fpsp"])
app.include_router(cursors_router, prefix="/api/cursors", tags=["cursors"])
app.include_router(bursts_router, prefix="/api/bursts", tags=["bursts"])
app.include_router(ap_router, prefix="/api/ap", tags=["ap"])


@app.get("/health")
async def health():
    return {"status": "ok", "version": "0.2.3"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8321)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
