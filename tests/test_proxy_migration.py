"""Manual proxy migration (POST /projects/{id}/proxies).

Old projects have video items with no editing proxy (`proxySrc`), or a stale one
(pre-vivid `_proxy_hable1`, or a dangling pointer whose file was cleaned). This
endpoint heals all three at once by reusing the SP6b look-migration background
queue: it never encodes in the request — units are queued and land in
project.json over SSE as they finish.

Harness mirrors tests/test_look_migration.py: encodes are mocked (nothing spawns
ffmpeg), the module-level queue is reset by an autouse fixture, and the route
coroutine / sync helper are driven directly with asyncio.run.
"""
import asyncio
import json
import os
from pathlib import Path

import pytest

import serve.routes.projects as projects_mod
from serve.routes.projects import _ensure_current_proxies
from lib.proxy import PROXY_LOOK, proxy_path_for

PID = "55555555-5555-4555-8555-555555555555"
PID2 = "66666666-6666-4666-8666-666666666666"


@pytest.fixture(autouse=True)
def _clean_state():
    projects_mod._look_migration_queue.clear()
    projects_mod._look_migration_current = None
    projects_mod._look_migration_worker = None
    yield
    projects_mod._look_migration_queue.clear()
    projects_mod._look_migration_current = None
    projects_mod._look_migration_worker = None


# ---------------------------------------------------------------------------
# Fixtures + mocks (proxy-only — this endpoint never touches normalize/probe)
# ---------------------------------------------------------------------------

class _Encodes:
    """Records every mocked proxy encode and writes the artifact it would make."""

    def __init__(self):
        self.proxy: list[tuple[str, str]] = []   # (input, out)
        self.gate: asyncio.Event | None = None   # set to stall encodes mid-flight


@pytest.fixture
def encodes(monkeypatch) -> _Encodes:
    from serve.jobs import set_done
    import serve.routes.steps as steps_mod

    rec = _Encodes()

    async def _fake_proxy(job_id, input_path, *, out, tonemap=None):
        rec.proxy.append((input_path, out))
        if rec.gate is not None:
            await rec.gate.wait()
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(b"proxy")
        set_done(job_id, {"path": out, "skipped": False})

    monkeypatch.setattr(steps_mod, "run_proxy_job", _fake_proxy)
    return rec


@pytest.fixture
def workspace(tmp_path, monkeypatch) -> Path:
    """Workspace root, realpath'd — proxy_path_for compares realpaths to decide
    sibling placement vs the _proxycache fallback."""
    ws = Path(os.path.realpath(tmp_path)) / "Montaj"
    ws.mkdir(parents=True)
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    return ws


def _make_project(workspace: Path, project_id: str, name: str = "proj") -> tuple[Path, Path]:
    """Project dir with one source clip on disk. Returns (project_dir, src)."""
    project_dir = workspace / name
    project_dir.mkdir(parents=True, exist_ok=True)
    src = project_dir / "clip.MOV"
    src.write_bytes(b"source")
    project = {
        "id": project_id,
        "version": "0.2",
        "status": "draft",
        "projectType": "video",
        "settings": {"colorSpace": "sdr_bt709", "resolution": [1080, 1920], "fps": 30},
        "tracks": [[{"id": "clip-0", "type": "video", "src": str(src),
                     "start": 0.0, "end": 5.0, "inPoint": 0.0, "outPoint": 5.0}]],
        "sources": [{"id": "clip-0", "type": "video", "src": str(src),
                     "start": 0.0, "end": 5.0}],
    }
    _write(project_dir, project)
    return project_dir, src


def _write(project_dir: Path, project: dict) -> None:
    (project_dir / "project.json").write_text(json.dumps(project, indent=2))


def _read(project_dir: Path) -> dict:
    return json.loads((project_dir / "project.json").read_text())


def _set_fields(project_dir: Path, **fields) -> None:
    """Set the same fields on every video item (tracks + sources mirror)."""
    project = _read(project_dir)
    for group in list(project["tracks"]) + [project["sources"]]:
        for item in group:
            item.update(fields)
    _write(project_dir, project)


def _item(project: dict, track: int = 0, index: int = 0) -> dict:
    return project["tracks"][track][index]


def _fresh_proxy(src: Path) -> Path:
    """The current-look proxy for `src`, present on disk and newer than `src`."""
    out = Path(proxy_path_for(os.path.realpath(str(src))))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(b"proxy")
    return out


async def _settle() -> None:
    """Let the background queue drain to completion."""
    worker = projects_mod._look_migration_worker
    if worker is not None:
        await worker


def _trigger(project_dir: Path, project_id: str = PID, broadcaster=None) -> dict:
    async def _run():
        project = _read(project_dir)
        result = _ensure_current_proxies(project_id, project_dir, project, broadcaster)
        await _settle()
        return result
    return asyncio.run(_run())


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_missing_proxy_is_encoded_and_written_back(workspace, encodes):
    """No `proxySrc` at all → one encode; the fresh path lands on completion."""
    project_dir, src = _make_project(workspace, PID)

    result = _trigger(project_dir)

    assert result == {"scheduled": 1, "alreadyFresh": 0}
    assert len(encodes.proxy) == 1
    assert encodes.proxy[0][0] == os.path.realpath(src)
    assert encodes.proxy[0][1].endswith(f"_proxy_{PROXY_LOOK}.mp4")
    project = _read(project_dir)
    assert _item(project)["proxySrc"] == encodes.proxy[0][1]
    # The `sources` mirror is healed too.
    assert project["sources"][0]["proxySrc"] == encodes.proxy[0][1]


def test_fresh_proxy_on_disk_is_repointed_without_encoding(workspace, encodes):
    """The current-look proxy already exists but the field never named it →
    repoint, no encode, counted alreadyFresh."""
    project_dir, src = _make_project(workspace, PID)
    fresh = _fresh_proxy(src)

    result = _trigger(project_dir)

    assert result == {"scheduled": 0, "alreadyFresh": 1}
    assert encodes.proxy == []
    project = _read(project_dir)
    assert _item(project)["proxySrc"] == str(fresh)
    assert project["sources"][0]["proxySrc"] == str(fresh)


def test_all_fresh_and_pointed_changes_nothing(workspace, encodes):
    """Every source already has a fresh proxy it points at → counts only, and
    project.json is left byte-for-byte unchanged (no rewrite)."""
    project_dir, src = _make_project(workspace, PID)
    # Add a second, independent source so alreadyFresh proves per-source counting.
    src2 = project_dir / "clip2.MOV"
    src2.write_bytes(b"source2")
    project = _read(project_dir)
    project["tracks"][0].append({"id": "clip-1", "type": "video", "src": str(src2),
                                 "start": 5.0, "end": 10.0, "inPoint": 0.0, "outPoint": 5.0})
    project["sources"].append({"id": "clip-1", "type": "video", "src": str(src2),
                               "start": 5.0, "end": 10.0})
    _write(project_dir, project)
    out1, out2 = _fresh_proxy(src), _fresh_proxy(src2)
    # Point each clip (both tracks + sources copies) at its own fresh proxy.
    project = _read(project_dir)
    for group in list(project["tracks"]) + [project["sources"]]:
        for item in group:
            item["proxySrc"] = str(out1) if item["id"] == "clip-0" else str(out2)
    _write(project_dir, project)
    before = (project_dir / "project.json").read_text()

    result = _trigger(project_dir)

    assert result == {"scheduled": 0, "alreadyFresh": 2}
    assert encodes.proxy == []
    assert (project_dir / "project.json").read_text() == before


def test_stale_old_look_proxy_is_re_encoded_and_repointed(workspace, encodes):
    """Superset: a pre-vivid `_proxy_hable1` pointer (file present on disk) is
    stale by look — re-encode to the current `_proxy_<PROXY_LOOK>` and repoint."""
    project_dir, src = _make_project(workspace, PID)
    stale = Path(f"{src.with_suffix('')}_proxy_hable1.mp4")
    stale.write_bytes(b"old-proxy")
    _set_fields(project_dir, proxySrc=str(stale))

    result = _trigger(project_dir)

    assert result == {"scheduled": 1, "alreadyFresh": 0}
    assert len(encodes.proxy) == 1
    new = encodes.proxy[0][1]
    assert new.endswith(f"_proxy_{PROXY_LOOK}.mp4") and new != str(stale)
    assert _item(_read(project_dir))["proxySrc"] == new
    # The stale file is left on disk — migration repoints, `montaj clean` deletes.
    assert stale.exists()


def test_proxy_opt_out_schedules_nothing(workspace, encodes):
    """`settings.proxy: false` is an explicit opt-out — heal nothing."""
    project_dir, src = _make_project(workspace, PID)
    project = _read(project_dir)
    project["settings"]["proxy"] = False
    _write(project_dir, project)

    result = _trigger(project_dir)

    assert result == {"scheduled": 0, "alreadyFresh": 0}
    assert encodes.proxy == []


def test_missing_source_is_skipped(workspace, encodes):
    """A source gone from disk has nothing to encode from — skip, don't crash,
    don't count."""
    project_dir, src = _make_project(workspace, PID)
    src.unlink()

    result = _trigger(project_dir)

    assert result == {"scheduled": 0, "alreadyFresh": 0}
    assert encodes.proxy == []


def test_retrigger_while_in_flight_starts_no_duplicate(workspace, encodes):
    """Triggering again while a unit is still encoding attaches to it (dedup via
    _look_migration_pending) rather than starting a second encode."""
    project_dir, src = _make_project(workspace, PID)

    async def _run():
        encodes.gate = asyncio.Event()
        _ensure_current_proxies(PID, project_dir, _read(project_dir), None)
        # Let the worker enter the encode and stall on the gate.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert len(encodes.proxy) == 1
        _ensure_current_proxies(PID, project_dir, _read(project_dir), None)
        assert len(encodes.proxy) == 1, "re-trigger started a duplicate encode"
        encodes.gate.set()
        await _settle()

    asyncio.run(_run())

    assert len(encodes.proxy) == 1
    assert _item(_read(project_dir))["proxySrc"] == encodes.proxy[0][1]


def test_http_shape(workspace, encodes):
    """The real route over HTTP: 202 + {scheduled, alreadyFresh} when work is
    queued, and the fresh proxy path lands in project.json without any further
    client action."""
    import time

    from starlette.testclient import TestClient

    from serve.server import app

    project_dir, src = _make_project(workspace, PID)

    with TestClient(app) as client:
        resp = client.post(f"/api/projects/{PID}/proxies")
        assert resp.status_code == 202, resp.text
        assert resp.json() == {"scheduled": 1, "alreadyFresh": 0}
        for _ in range(200):
            if _item(_read(project_dir)).get("proxySrc"):
                break
            time.sleep(0.02)

    project = _read(project_dir)
    assert _item(project)["proxySrc"].endswith(f"_proxy_{PROXY_LOOK}.mp4")
    assert Path(_item(project)["proxySrc"]).exists()


def test_http_all_fresh_returns_200(workspace, encodes):
    """Nothing to do → 200 (not 202), no encode."""
    from starlette.testclient import TestClient

    from serve.server import app

    project_dir, src = _make_project(workspace, PID)
    fresh = _fresh_proxy(src)
    _set_fields(project_dir, proxySrc=str(fresh))

    with TestClient(app) as client:
        resp = client.post(f"/api/projects/{PID}/proxies")
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"scheduled": 0, "alreadyFresh": 1}


def test_completion_broadcasts_write_back_only(workspace, encodes):
    """Each completion broadcasts an SSE frame carrying the new proxySrc. There
    is NO pre-clear frame (the no-pre-clear decision) — only the write-back."""
    class _Broadcaster:
        def __init__(self):
            self.frames = []

        def publish(self, project_id, frame):
            self.frames.append((project_id, frame))

    project_dir, src = _make_project(workspace, PID)
    bus = _Broadcaster()

    _trigger(project_dir, broadcaster=bus)

    assert [pid for pid, _ in bus.frames] == [PID]  # exactly one, the write-back
    written = json.loads(bus.frames[0][1].split("data: ", 1)[1])
    assert _item(written)["proxySrc"] == encodes.proxy[0][1]


def test_out_of_workspace_source_lands_in_proxycache(workspace, encodes):
    """An out-of-workspace source (ad-hoc --clips footage) must not litter the
    user's folder — its proxy goes under <ws>/.sources/_proxycache/<sha1>/."""
    project_dir, _ = _make_project(workspace, PID)
    ext_dir = workspace.parent / "external"
    ext_dir.mkdir()
    ext_src = ext_dir / "footage.MOV"
    ext_src.write_bytes(b"source")
    _set_fields(project_dir, src=str(ext_src))

    result = _trigger(project_dir)

    assert result == {"scheduled": 1, "alreadyFresh": 0}
    out = encodes.proxy[0][1]
    assert out.startswith(str(workspace / ".sources" / "_proxycache"))
    assert _item(_read(project_dir))["proxySrc"] == out
