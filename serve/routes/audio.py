"""Conformed audio cache endpoints: POST /api/audio/conform, GET /api/audio/conformed.
The export mix's loudness for the editor preview (§660): POST /api/projects/{id}/mix-loudness."""
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from serve import audio_conform, mix_loudness
from serve.common import _allowed_file_roots, _is_under, bad_request, forbidden, get_project_dir

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
    if resolved.exists() and not resolved.is_file():
        raise bad_request("not_a_file", f"Not a regular file: {path}")
    return resolved


@router.post("/audio/conform")
def conform(body: ConformBody):
    resolved = [(p, _checked(p)) for p in body.paths]  # refuse the whole request on any bad path
    return {"results": [{"path": p, **audio_conform.start(r)} for p, r in resolved]}


@router.get("/audio/conformed")
def conformed(path: str):
    return {"path": path, **audio_conform.lookup(_checked(path))}


@router.post("/projects/{project_id}/mix-loudness")
def mix_loudness_status(project_dir: Path = Depends(get_project_dir)):
    """`{status: running|ready|silent|failed|off}`; `ready` adds `inputI`, `targetI`
    and `gainDb` (target - inputI, the level the export's loudnorm brings the mix
    to). Starts the measurement, or joins it, or answers from the cache: ask again
    until it is not `running`. See serve/mix_loudness.py."""
    return mix_loudness.start(project_dir)
