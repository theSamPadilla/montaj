"""Which files in a project an AI provider made: `assets/.generated.json`.

A generate step declares `"provenance"` in its schema: a fixed `"provider"`
(kling_generate: `"kling"`), or `"providerParam"`, the param that picks one
(generate_image's `provider`, generate_music's `vendor`). When serve runs such
a step and its output lands in a project's folder, it records the file here,
keyed by its path relative to the project folder (so a moved project keeps
it), in the shape project items already use for `generation`:
`{provider, model, prompt, step, at}`. `provider` is the connector id
(kling, fal, kinovi, gemini, openai, elevenlabs, tripo).

project.json is never touched: a generated file becomes a project item only
later, when the agent adds it, and this record is how the app tells it from an
imported one. One writer (serve), so no races with project saves. A project
with no record has no generated files, as far as anyone knows. A run outside
serve (the CLI) is not recorded.
"""
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

RECORD_NAME = ".generated.json"
ASSETS_DIR = "assets"
_PROMPT_MAX = 2000
_RECORD_MAX_BYTES = 4 * 1024 * 1024

_lock = threading.Lock()


def _param_default(schema: dict, name: str):
    for p in schema.get("params") or []:
        if p.get("name") == name:
            return p.get("default")
    return None


def entry_for(name: str, schema: dict, body: dict, result) -> dict | None:
    """The record's entry for one run of step `name`, or None when the step
    declares no provenance or no provider can be told."""
    prov = schema.get("provenance")
    if not isinstance(prov, dict):
        return None
    provider = prov.get("provider")
    if not provider and isinstance(prov.get("providerParam"), str):
        param = prov["providerParam"]
        provider = body.get(param) or _param_default(schema, param)
    if not isinstance(provider, str) or not provider:
        return None
    model = result.get("model") if isinstance(result, dict) else None
    if not isinstance(model, str) or not model:
        model = body.get("model") or _param_default(schema, "model")
    entry = {"provider": provider, "step": name, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    if isinstance(model, str) and model:
        entry["model"] = model
    prompt = body.get("prompt") or body.get("text")
    if isinstance(prompt, str) and prompt.strip():
        entry["prompt"] = prompt[:_PROMPT_MAX]
    return entry


def output_path(result, body: dict) -> str | None:
    """The file the run made: the result's `out` or `path`, else the `out` param."""
    if isinstance(result, dict):
        for key in ("out", "path"):
            v = result.get(key)
            if isinstance(v, str) and v:
                return v
    v = body.get("out")
    return v if isinstance(v, str) and v else None


def project_dir_containing(path: str, workspace: str) -> Path | None:
    """The nearest folder above `path` with a project.json, inside `workspace`
    (symlinks followed), or None."""
    ws = Path(os.path.realpath(workspace))
    here = Path(os.path.realpath(path)).parent
    while here != ws and ws in here.parents:
        if (here / "project.json").is_file():
            return here
        here = here.parent
    return None


def read(project_dir: Path) -> dict:
    """The record: {relative path: entry}. Missing, unreadable or not an object: {}."""
    p = Path(project_dir) / ASSETS_DIR / RECORD_NAME
    try:
        if p.stat().st_size > _RECORD_MAX_BYTES:
            return {}
        data = json.loads(p.read_text())
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, dict)} if isinstance(data, dict) else {}


def record(project_dir: Path, out_path: str, entry: dict) -> str | None:
    """Add `out_path` (a file inside `project_dir`) to the record; returns its
    key, or None when the file is not inside the project folder. Written whole
    to a temp file and replaced, under a lock, so concurrent steps never lose
    an entry and a reader never sees half a file."""
    pdir = Path(os.path.realpath(project_dir))
    real = Path(os.path.realpath(out_path))
    if pdir not in real.parents:
        return None
    key = real.relative_to(pdir).as_posix()
    assets = pdir / ASSETS_DIR
    with _lock:
        assets.mkdir(exist_ok=True)
        data = read(pdir)
        data[key] = entry
        target = assets / RECORD_NAME
        tmp = assets / f"{RECORD_NAME}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        try:
            tmp.write_text(json.dumps(data, indent=2))
            os.replace(tmp, target)
        except BaseException:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise
    return key
