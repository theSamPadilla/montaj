"""Overlay listing + group-creation endpoints.

Owns both /overlays* and /profiles/{name}/overlays* — the second pair is
overlay-scoped (not profile-scoped) so they share scan_overlays.
"""
import asyncio
import json
import logging
import re
import shutil
import sys
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import JSONResponse

from cli.deps import render_runtime_dir
from lib.common import node_child_env
from serve.common import (
    MONTAJ_ROOT,
    _allowed_file_roots,
    _is_under,
    bad_request,
    forbidden,
    not_found,
    resolve_workspace,
    server_error,
)

router = APIRouter(prefix="/api")


def scan_overlays(overlays_dir: Path) -> list[dict]:
    """Scan an overlays directory for overlay entries.

    Supports a flat layout and one level of grouping:
      {overlays_dir}/{name}/{name}.jsx          — ungrouped
      {overlays_dir}/{group}/{name}/{name}.jsx  — grouped

    Each overlay dir must contain {name}.jsx; {name}.json is optional."""
    results = []
    if not overlays_dir.exists():
        return results

    def _entry(subdir: Path, group: str | None) -> dict:
        jsx_path  = subdir / f"{subdir.name}.jsx"
        schema: dict = {}
        json_path = subdir / f"{subdir.name}.json"
        if json_path.exists():
            try:
                schema = json.loads(json_path.read_text())
            except Exception:
                pass
        entry = {
            "name":        subdir.name,
            "description": schema.get("description", ""),
            "props":       schema.get("props", []),
            "jsxPath":     str(jsx_path),
        }
        if group:
            entry["group"] = group
        return entry

    for subdir in sorted(overlays_dir.iterdir()):
        if not subdir.is_dir():
            continue
        if (subdir / f"{subdir.name}.jsx").exists():
            results.append(_entry(subdir, group=None))
        else:
            children = sorted(subdir.iterdir())
            overlay_children = [c for c in children if c.is_dir() and (c / f"{c.name}.jsx").exists()]
            if overlay_children:
                for child in overlay_children:
                    results.append(_entry(child, group=subdir.name))
            else:
                results.append({"group": subdir.name, "empty": True})

    return results


@router.get("/overlays")
async def list_overlays():
    """List all overlays from the global overlay library (~/.montaj/overlays/)."""
    return scan_overlays(Path.home() / ".montaj" / "overlays")


@router.get("/overlays/system")
async def list_system_overlays():
    """List shipped overlay templates packaged with Montaj."""
    return scan_overlays(Path(render_runtime_dir()) / "templates" / "overlays")


@router.post("/overlays/groups", status_code=201)
async def create_overlay_group(body: dict = Body(...)):
    """Create a new group folder inside ~/.montaj/overlays/."""
    name = str(body.get("name", "")).strip()
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise bad_request("invalid_name", "Invalid group name")
    group_dir = Path.home() / ".montaj" / "overlays" / name
    group_dir.mkdir(parents=True, exist_ok=True)
    return {"name": name}


@router.get("/profiles/{name}/overlays")
async def list_profile_overlays(name: str):
    """List overlays from a profile's overlay library (~/.montaj/profiles/{name}/overlays/)."""
    overlays_dir = Path.home() / ".montaj" / "profiles" / name / "overlays"
    return scan_overlays(overlays_dir)


@router.post("/profiles/{name}/overlays/groups", status_code=201)
async def create_profile_overlay_group(name: str, body: dict = Body(...)):
    """Create a new group folder inside ~/.montaj/profiles/{name}/overlays/."""
    group = str(body.get("name", "")).strip()
    if not group or "/" in group or "\\" in group or group.startswith("."):
        raise bad_request("invalid_name", "Invalid group name")
    group_dir = Path.home() / ".montaj" / "profiles" / name / "overlays" / group
    group_dir.mkdir(parents=True, exist_ok=True)
    return {"name": group}


# ── GET /api/overlays/bundle ──────────────────────────────────────────────────

_BUNDLE_TIMEOUT_S = 30
# An editor opening many overlays must not spawn one node per overlay at once.
_BUNDLE_SEMAPHORE = asyncio.Semaphore(4)
_log = logging.getLogger(__name__)
# esbuild message prefix: an absolute POSIX path, then :line:col:
_ESBUILD_LOC = re.compile(r"^(/.+?):(\d+):(\d+): ")


def _watcher_roots() -> list[Path]:
    """Directories serve/watcher.py schedules, spelled as it schedules them."""
    home = Path.home()
    return [resolve_workspace(), home / ".montaj" / "overlays", home / ".montaj" / "profiles"]


def _watcher_spelling(real: Path) -> str:
    """Spell `real` (a realpath) the way the serve watcher reports that file.

    The editor subscribes to each input by string and the SSE match is exact.
    MEASURED 2026-09-29 on macOS 26 (Darwin 25.6, watchdog 6.0.0, FSEvents):
    an Observer scheduled on symlink `/Users/Shared/montaj-pv49/t2/meas/link`
    (-> `real`) and a write to `link/a/b/x.jsx` reported `event.src_path` as
    `/Users/Shared/montaj-pv49/t2/meas/real/a/b/x.jsx`, the REAL spelling. So
    on darwin the realpath is already what the watcher emits. Elsewhere
    (inotify) the scheduled spelling is what is reported, so rebase the real
    path from `realpath(root)` back onto `root` as scheduled (inferred, not
    measured on this machine).
    """
    if sys.platform == "darwin":
        return str(real)
    for root in _watcher_roots():
        try:
            rel = real.relative_to(root.resolve())
        except ValueError:
            continue
        return str(root / rel)
    return str(real)


@router.get("/overlays/bundle")
async def bundle_overlay(path: str = Query(default="")):
    """Bundle one overlay (and what it imports) for the editor preview.

    Runs montaj_assets/render/preview-bundle.js and returns {code, inputs}.
    Errors: 400 bad_request (missing/relative path), 404 not_found, 403
    forbidden (entry outside the allowed roots) or import_outside_roots (an
    input outside them), 422 build_failed (esbuild message), 504
    bundle_timeout (node exceeded 30 s; the child is killed), 500 otherwise.
    """
    if not path or not Path(path).is_absolute():
        raise bad_request("bad_request", "path must be an absolute file path")
    entry = Path(path)
    if not entry.is_file():
        raise not_found("not_found", f"File not found: {path}")

    roots = _allowed_file_roots()
    if not any(_is_under(entry.resolve(), r) for r in roots):
        raise forbidden("forbidden", f"Path is outside the allowed roots: {path}")

    script = Path(render_runtime_dir()) / "preview-bundle.js"
    if not script.is_file():
        raise server_error("not_found", f"{script.name} not found")
    node_bin = shutil.which("node")
    if not node_bin:
        raise server_error("not_found", "node not found in PATH")

    env = node_child_env()
    env["MONTAJ_ROOT"] = str(MONTAJ_ROOT)

    async with _BUNDLE_SEMAPHORE:
        proc = await asyncio.create_subprocess_exec(
            node_bin, str(script), str(entry),
            cwd=str(MONTAJ_ROOT),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), _BUNDLE_TIMEOUT_S)
        except BaseException as exc:
            # Timeout, client disconnect (CancelledError) or anything else: the
            # node child must not outlive the request.
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()
            if isinstance(exc, asyncio.TimeoutError):
                raise HTTPException(504, detail={
                    "error": "bundle_timeout",
                    "message": f"preview-bundle.js exceeded {_BUNDLE_TIMEOUT_S}s",
                })
            raise

    stdout = (stdout_b or b"").decode("utf-8", errors="replace")
    stderr = (stderr_b or b"").decode("utf-8", errors="replace")

    def _parse() -> dict | None:
        try:
            data = json.loads(stdout.strip().splitlines()[-1])
            return data if isinstance(data, dict) else None
        except (IndexError, ValueError):
            return None

    # Node/esbuild output can quote the text of the file that failed, so no raw
    # stderr or unlocated message ever reaches the response: it goes to the
    # server log, and the client gets a generic message.
    if proc.returncode == 2:
        data = _parse() or {}
        message = data.get("message") or ""
        m = _ESBUILD_LOC.match(message)
        if not m:
            _log.warning("overlay bundle build failed with no parseable location: %s", (message or stderr)[-500:])
            raise HTTPException(422, detail={"error": "build_failed", "message": "build failed"})
        # esbuild echoes the offending token, so a syntax error in a file
        # outside the allowed roots would leak that file's text.
        real = Path(m.group(1)).resolve()
        if not any(_is_under(real, r.resolve()) for r in roots):
            raise forbidden(
                "import_outside_roots",
                f"Overlay imports a file outside the allowed roots: {m.group(1)}",
            )
        message = _watcher_spelling(real) + message[len(m.group(1)):]
        raise HTTPException(422, detail={"error": "build_failed", "message": message})
    if proc.returncode != 0:
        _log.error("preview-bundle.js exit %s: %s", proc.returncode, stderr[-500:])
        raise server_error("bundle_failed", "preview bundle failed")

    data = _parse()
    if not data or not data.get("ok") or not isinstance(data.get("code"), str) \
            or not isinstance(data.get("inputs"), list):
        _log.error("preview-bundle.js returned unparseable output: %s", stdout[-500:])
        raise server_error("bundle_failed", "preview bundle failed")

    real_roots = [r.resolve() for r in roots]
    inputs: list[str] = []
    for raw in data["inputs"]:
        real = Path(raw).resolve()
        if not any(_is_under(real, r) for r in real_roots):
            raise forbidden(
                "import_outside_roots",
                f"Overlay imports a file outside the allowed roots: {raw}",
            )
        inputs.append(_watcher_spelling(real))

    return JSONResponse(
        {"code": data["code"], "inputs": inputs},
        headers={"Cache-Control": "no-store"},
    )
