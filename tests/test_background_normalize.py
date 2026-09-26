"""Background colour conversion for projects created through serve.

With no normalize mode chosen, POST /api/run runs init lazy (no transcode) and
serve queues eager's conversions on the look-migration queue. A finished
conversion swaps `src` on every item using that source and queues the new
file's proxy; opening the project joins a queued conversion instead of starting
another; export never waits, because render.js conforms inline anything still on
its original.

Harness mirrors tests/test_look_migration.py: encodes and probes are mocked
(nothing spawns ffmpeg), the module-level queue is reset by an autouse fixture,
and coroutines are driven with asyncio.run.
"""
import asyncio
import json
import os
from pathlib import Path

import pytest

import serve.routes.projects as projects_mod
from serve.routes.projects import (
    BACKGROUND_NORMALIZE_KEY,
    _ensure_background_normalize,
    get_project,
)
from lib.normalize import normalized_output_path
from lib.project_tracks import track_items
from lib.proxy import proxy_path_for

PID = "77777777-7777-4777-8777-777777777777"


@pytest.fixture(autouse=True)
def _clean_state():
    projects_mod._look_migration_queue.clear()
    projects_mod._look_migration_current = None
    projects_mod._look_migration_worker = None
    yield
    projects_mod._look_migration_queue.clear()
    projects_mod._look_migration_current = None
    projects_mod._look_migration_worker = None


class _Encodes:
    def __init__(self):
        self.proxy: list[tuple[str, str]] = []
        self.normalize: list[tuple[str, str]] = []
        self.gate: asyncio.Event | None = None
        self.fail_normalize = False


@pytest.fixture
def encodes(monkeypatch) -> _Encodes:
    from serve.jobs import set_done, set_error
    import serve.routes.steps as steps_mod

    rec = _Encodes()

    async def _fake_proxy(job_id, input_path, *, out, tonemap=None):
        rec.proxy.append((input_path, out))
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(b"proxy")
        set_done(job_id, {"path": out, "skipped": False})

    async def _fake_normalize(job_id, input_path, color_space, *, out=None):
        rec.normalize.append((input_path, out))
        if rec.gate is not None:
            await rec.gate.wait()
        if rec.fail_normalize:
            set_error(job_id, {"error": "normalize_failed", "message": "boom"})
            return
        Path(out).write_bytes(b"converted")
        set_done(job_id, {"path": out, "skipped": False})

    monkeypatch.setattr(steps_mod, "run_proxy_job", _fake_proxy)
    monkeypatch.setattr(steps_mod, "run_normalize_job", _fake_normalize)
    return rec


@pytest.fixture
def probes(monkeypatch) -> dict:
    """Every source probes as SDR and NON-conformant (an SDR screen recording in
    an HLG project) unless a test lists it in `conformant`. Counts probes."""
    import lib.normalize as normalize_mod

    state = {"conformant": set(), "count": 0}

    def _fake_probe(path):
        state["count"] += 1
        return {"color_transfer": "bt709", "codec": "h264", "pix_fmt": "yuv420p"}

    def _fake_is_normalized(path, info, color_space):
        return str(path) in state["conformant"]

    monkeypatch.setattr(normalize_mod, "probe_video", _fake_probe)
    monkeypatch.setattr(normalize_mod, "is_normalized", _fake_is_normalized)
    return state


@pytest.fixture
def workspace(tmp_path, monkeypatch) -> Path:
    ws = Path(os.path.realpath(tmp_path)) / "Montaj"
    ws.mkdir(parents=True)
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    return ws


def _make_project(workspace: Path, *, lazy: bool = True) -> tuple[Path, Path]:
    """A freshly created (init --normalize lazy) HLG project with one clip whose
    original proxy already landed."""
    project_dir = workspace / "proj"
    project_dir.mkdir(parents=True, exist_ok=True)
    src = project_dir / "screen.MP4"
    src.write_bytes(b"source")
    old_proxy = Path(proxy_path_for(str(src)))
    old_proxy.write_bytes(b"proxy")
    settings = {"colorSpace": "hdr_hlg", "resolution": [3840, 2160], "fps": 30}
    if lazy:
        settings["normalize"] = "lazy"
    item = {"id": "clip-0", "type": "video", "src": str(src), "proxySrc": str(old_proxy),
            "start": 0.0, "end": 5.0, "inPoint": 0.0, "outPoint": 5.0}
    project = {
        "id": PID, "version": "0.2", "status": "draft", "projectType": "video",
        "settings": settings,
        "tracks": [{"id": "main", "items": [dict(item)]}],
        "sources": [dict(item)],
    }
    (project_dir / "project.json").write_text(json.dumps(project, indent=2))
    return project_dir, src


def _read(project_dir: Path) -> dict:
    return json.loads((project_dir / "project.json").read_text())


def _write(project_dir: Path, project: dict) -> None:
    (project_dir / "project.json").write_text(json.dumps(project, indent=2))


def _converted(src: Path) -> str:
    return normalized_output_path(str(src), "hdr_hlg", tonemapped=False)


async def _settle() -> None:
    while projects_mod._look_migration_worker is not None:
        await projects_mod._look_migration_worker


def _create(project_dir: Path) -> None:
    async def _run():
        await _ensure_background_normalize(PID, project_dir, _read(project_dir), None, created=True)
    asyncio.run(_run())


# ---------------------------------------------------------------------------


def test_create_queues_conversion_and_marks_project(workspace, encodes, probes):
    project_dir, src = _make_project(workspace)

    async def _run():
        encodes.gate = asyncio.Event()
        await _ensure_background_normalize(PID, project_dir, _read(project_dir), None, created=True)
        # Nothing waited on the encode: the project is still on its original.
        project = _read(project_dir)
        assert track_items(project)[0][0]["src"] == str(src)
        assert project["settings"][BACKGROUND_NORMALIZE_KEY] is True
        # init's lazy was serve's choice, not the project's.
        assert "normalize" not in project["settings"]
        encodes.gate.set()
        await _settle()

    asyncio.run(_run())
    assert encodes.normalize == [(str(src), _converted(src))]


def test_finished_conversion_swaps_every_item_then_queues_its_proxy(workspace, encodes, probes):
    project_dir, src = _make_project(workspace)
    old_proxy = proxy_path_for(str(src))

    async def _run():
        encodes.gate = asyncio.Event()
        await _ensure_background_normalize(PID, project_dir, _read(project_dir), None, created=True)
        # A host re-lays the timeline meanwhile (new item id, same source).
        project = _read(project_dir)
        relaid = dict(track_items(project)[0][0], id="clip_relaid")
        project["tracks"][0]["items"] = [relaid]
        _write(project_dir, project)
        encodes.gate.set()
        await _settle()

    asyncio.run(_run())

    converted = _converted(src)
    project = _read(project_dir)
    item = track_items(project)[0][0]
    assert item["id"] == "clip_relaid"
    assert item["src"] == converted
    assert project["sources"][0]["src"] == converted
    # The converted file's own proxy was queued and landed on both.
    new_proxy = proxy_path_for(converted)
    assert (converted, new_proxy) in [(i, o) for i, o in encodes.proxy]
    assert item["proxySrc"] == new_proxy != old_proxy
    assert project["sources"][0]["proxySrc"] == new_proxy
    assert BACKGROUND_NORMALIZE_KEY not in project["settings"]


def test_swapped_item_keeps_old_proxy_until_new_one_lands(workspace, encodes, probes, monkeypatch):
    """Between the swap and the new proxy, preview must stay on a proxy — never
    fall back to the 4K converted master."""
    import serve.routes.steps as steps_mod
    from serve.jobs import set_error

    async def _failing_proxy(job_id, input_path, *, out, tonemap=None):
        set_error(job_id, {"error": "step_failed", "message": "boom"})

    monkeypatch.setattr(steps_mod, "run_proxy_job", _failing_proxy)
    project_dir, src = _make_project(workspace)

    async def _run():
        await _ensure_background_normalize(PID, project_dir, _read(project_dir), None, created=True)
        await _settle()

    asyncio.run(_run())

    item = track_items(_read(project_dir))[0][0]
    assert item["src"] == _converted(src)
    assert item["proxySrc"] == proxy_path_for(str(src))


def test_conformant_sources_queue_nothing_and_leave_no_marker(workspace, encodes, probes):
    project_dir, src = _make_project(workspace)
    probes["conformant"].add(str(src))

    _create(project_dir)

    project = _read(project_dir)
    assert encodes.normalize == []
    assert BACKGROUND_NORMALIZE_KEY not in project["settings"]
    assert "normalize" not in project["settings"]
    assert track_items(project)[0][0]["src"] == str(src)


def test_open_joins_the_queued_conversion(workspace, encodes, probes):
    project_dir, src = _make_project(workspace)

    async def _run():
        encodes.gate = asyncio.Event()
        await _ensure_background_normalize(PID, project_dir, _read(project_dir), None, created=True)
        await asyncio.sleep(0)
        await get_project(PID, project_dir=project_dir)
        await get_project(PID, project_dir=project_dir)
        encodes.gate.set()
        await _settle()

    asyncio.run(_run())

    assert len(encodes.normalize) == 1
    assert track_items(_read(project_dir))[0][0]["src"] == _converted(src)


def test_open_restarts_a_conversion_a_restart_dropped(workspace, encodes, probes):
    """Marker set, queue empty (serve restarted mid-conversion): the open queues it."""
    project_dir, src = _make_project(workspace)
    project = _read(project_dir)
    project["settings"][BACKGROUND_NORMALIZE_KEY] = True
    _write(project_dir, project)

    async def _run():
        await get_project(PID, project_dir=project_dir)
        await _settle()

    asyncio.run(_run())

    assert len(encodes.normalize) == 1
    project = _read(project_dir)
    assert track_items(project)[0][0]["src"] == _converted(src)
    assert BACKGROUND_NORMALIZE_KEY not in project["settings"]


def test_open_without_marker_does_nothing(workspace, encodes, probes):
    """An eager project, or one whose conversions are done, costs no probe."""
    project_dir, _ = _make_project(workspace, lazy=False)

    async def _run():
        await get_project(PID, project_dir=project_dir)
        await _settle()

    asyncio.run(_run())

    assert probes["count"] == 0
    assert encodes.normalize == []


def test_fresh_converted_file_is_swapped_without_encoding(workspace, encodes, probes):
    project_dir, src = _make_project(workspace)
    Path(_converted(src)).write_bytes(b"converted")

    async def _run():
        await _ensure_background_normalize(PID, project_dir, _read(project_dir), None, created=True)
        await _settle()

    asyncio.run(_run())

    project = _read(project_dir)
    assert encodes.normalize == []
    assert track_items(project)[0][0]["src"] == _converted(src)
    assert BACKGROUND_NORMALIZE_KEY not in project["settings"]


def test_failed_conversion_clears_marker_and_leaves_original(workspace, encodes, probes):
    """Export conforms it inline; a marker left set would re-run a doomed
    encode on every open."""
    encodes.fail_normalize = True
    project_dir, src = _make_project(workspace)

    async def _run():
        await _ensure_background_normalize(PID, project_dir, _read(project_dir), None, created=True)
        await _settle()

    asyncio.run(_run())

    project = _read(project_dir)
    assert track_items(project)[0][0]["src"] == str(src)
    assert BACKGROUND_NORMALIZE_KEY not in project["settings"]


def test_render_conforms_inline_to_the_same_path():
    """Export's guard: render.js's normalize pre-pass runs for every video item
    unless a lazy project has a `normalizedSrc` cache, and it writes to the path
    this module's conversion writes, so an in-flight or finished background
    conversion and an export share one artifact."""
    render_js = (Path(projects_mod.MONTAJ_ROOT) / "montaj_assets" / "render" / "render.js").read_text()
    assert "const normalizedPath = await normalizeIfNeeded(item.src, projectColorSpace, tonemapped)" in render_js
    assert "return settings.normalize === 'lazy' && !!item.normalizedSrc" in render_js
    assert "`_normalized_${projectColorSpace}${lookSuffix}.mp4`" in render_js
    assert normalized_output_path("/a/clip.MOV", "hdr_hlg", tonemapped=False) == "/a/clip_normalized_hdr_hlg.mp4"
