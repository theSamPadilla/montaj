"""Conformed audio cache endpoints: POST /api/audio/conform, GET /api/audio/conformed."""
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from serve import audio_conform
from serve.common import _allowed_file_roots, _is_under, bad_request, forbidden

router = APIRouter(prefix="/api")


class ConformBody(BaseModel):
    paths: list[str]


def _checked(path: str) -> Path:
    """Same scope rule as /api/files: the resolved path must sit under an allowed root."""
    if not path or not Path(path).is_absolute():
        raise bad_request("bad_path", f"Absolute path required: {path}")
    try:
        resolved = Path(path).resolve()
    except OSError:
        raise forbidden("forbidden", "Path is outside the allowed roots")
    if not any(_is_under(resolved, root) for root in _allowed_file_roots()):
        raise forbidden("forbidden", "Path is outside the allowed roots")
    return resolved


@router.post("/audio/conform")
def conform(body: ConformBody):
    resolved = [(p, _checked(p)) for p in body.paths]  # refuse the whole request on any bad path
    return {"results": [{"path": p, **audio_conform.start(r)} for p, r in resolved]}


@router.get("/audio/conformed")
def conformed(path: str):
    return {"path": path, **audio_conform.lookup(_checked(path))}
