"""File management API endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from readers.heka_reader import HekaReader
from readers.abf_reader import AbfReader
from readers.neo_reader import NeoReader
from readers.models import Recording

router = APIRouter()

# In-memory storage for the currently loaded recording
_current_recording: Recording | None = None

READERS = [HekaReader(), AbfReader(), NeoReader()]


def get_current_recording() -> Recording:
    if _current_recording is None:
        raise HTTPException(status_code=400, detail="No file loaded")
    return _current_recording


class OpenFileRequest(BaseModel):
    file_path: str


@router.post("/open")
async def open_file(req: OpenFileRequest):
    global _current_recording

    file_path = req.file_path

    for reader in READERS:
        if reader.can_read(file_path):
            try:
                _current_recording = reader.read(file_path)
                return _current_recording.to_dict()
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Error reading file: {e}")

    raise HTTPException(status_code=400, detail=f"Unsupported file format: {file_path}")


@router.get("/info")
async def file_info():
    if _current_recording is None:
        return {"fileName": None, "format": None, "groupCount": 0, "groups": []}
    return _current_recording.to_dict()


@router.post("/close")
async def close_file():
    global _current_recording
    _current_recording = None
    return {"status": "closed"}
