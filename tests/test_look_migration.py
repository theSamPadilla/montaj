"""Look migration at project open (SP6b T9).

Opening a project heals FIELD-level look staleness: `proxySrc` / `normalizedSrc`
pointing at old-look artifacts that still exist on disk, so every filename-based
freshness check short-circuits on a path that is fresh by mtime and wrong by
look. GET /projects/{id} repoints or clears those fields, returns the migrated
body immediately, and queues the re-encodes in the background.

Conventions follow tests/test_render_async.py: route coroutines are driven
directly with `asyncio.run`, module-level scheduling state is reset by an
autouse fixture, and the encodes are mocked — nothing here spawns ffmpeg.
"""
import asyncio
import json
import os
from pathlib import Path

import pytest

import serve.routes.projects as projects_mod
from serve.routes.projects import get_project
from lib.project_tracks import track_items

PID = "55555555-5555-4555-8555-555555555555"
PID2 = "66666666-6666-4666-8666-666666666666"

HDR_INFO = {"color_transfer": "arib-std-b67", "codec": "hevc", "pix_fmt": "yuv420p10le"}
SDR_INFO = {"color_transfer": "bt709", "codec": "h264", "pix_fmt": "yuv420p"}


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
# Fixture project + mocks
# ---------------------------------------------------------------------------

class _Encodes:
    """Records every mocked encode and writes the artifact it would produce."""

    def __init__(self):
        self.proxy: list[tuple[str, str]] = []      # (input, out)
        self.normalize: list[tuple[str, str]] = []  # (input, out)
        self.gate: asyncio.Event | None = None      # set to stall encodes mid-flight

    @property
    def total(self) -> int:
        return len(self.proxy) + len(self.normalize)


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

    async def _fake_normalize(job_id, input_path, color_space, *, out=None):
        rec.normalize.append((input_path, out))
        if rec.gate is not None:
            await rec.gate.wait()
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(b"master")
        set_done(job_id, {"path": out, "skipped": False})

    monkeypatch.setattr(steps_mod, "run_proxy_job", _fake_proxy)
    monkeypatch.setattr(steps_mod, "run_normalize_job", _fake_normalize)
    return rec


@pytest.fixture
def probe_hdr(monkeypatch):
    """Every source probes as HLG unless the test overrides the mapping."""
    import lib.normalize as normalize_mod

    by_path: dict[str, dict] = {}

    def _fake_probe(path):
        return by_path.get(str(path), HDR_INFO)

    monkeypatch.setattr(normalize_mod, "probe_video", _fake_probe)
    return by_path


@pytest.fixture
def workspace(tmp_path, monkeypatch) -> Path:
    """Workspace root, realpath'd — lib.proxy.proxy_path_for compares realpaths
    to decide sibling placement vs the _proxycache fallback."""
    ws = Path(os.path.realpath(tmp_path)) / "Montaj"
    ws.mkdir(parents=True)
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    return ws


def _make_project(workspace: Path, project_id: str, name: str = "proj", *,
                  color_space: str = "sdr_bt709") -> tuple[Path, Path]:
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
        "settings": {"colorSpace": color_space, "resolution": [1080, 1920], "fps": 30},
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


def _legacy_artifacts(src: Path) -> tuple[Path, Path]:
    """Pre-SP6b artifacts beside `src`: a hable1 proxy and an untagged
    tone-mapped master, both present on disk (which is exactly why a
    filename-based freshness check never fires for them)."""
    stem = src.with_suffix("")
    proxy = Path(f"{stem}_proxy_hable1.mp4")
    master = Path(f"{stem}_normalized_sdr_bt709.mp4")
    proxy.write_bytes(b"old-proxy")
    master.write_bytes(b"old-master")
    return proxy, master


def _item(project: dict, track: int = 0, index: int = 0) -> dict:
    # Shape-tolerant: `project["tracks"][track]` is a bare item list before the
    # T6 lazy shape migration runs (raw fixtures, or a project read straight
    # off disk pre-open) and `{"id", "items"}` after (the body `get_project`
    # returns, or a re-read of a project.json it already touched).
    return track_items(project)[track][index]


async def _settle() -> None:
    """Let the background queue drain to completion."""
    worker = projects_mod._look_migration_worker
    if worker is not None:
        await worker


def _open_and_settle(project_id: str, project_dir: Path) -> dict:
    async def _run():
        body = await get_project(project_id, project_dir=project_dir)
        await _settle()
        return body
    return asyncio.run(_run())


# ---------------------------------------------------------------------------
# The migration pass
# ---------------------------------------------------------------------------

def test_open_clears_stale_fields_and_returns_migrated_body(workspace, encodes, probe_hdr):
    project_dir, src = _make_project(workspace, PID)
    proxy, master = _legacy_artifacts(src)
    _set_fields(project_dir, proxySrc=str(proxy), normalizedSrc=str(master))

    async def _run():
        body = await get_project(PID, project_dir=project_dir)
        # Read back with no await in between: this is the state the open itself
        # committed, before any queued encode has had a chance to run.
        return body, _read(project_dir)

    body, committed = asyncio.run(_run())

    # The response body is the migrated project — the stale pointers are gone.
    item = _item(body)
    assert "proxySrc" not in item
    assert "normalizedSrc" not in item
    # ...and the clearing is persisted, not just returned.
    on_disk = _item(committed)
    assert "proxySrc" not in on_disk
    assert "normalizedSrc" not in on_disk
    # The old artifacts are left on disk — migration repoints, `montaj clean` deletes.
    assert proxy.exists() and master.exists()


def test_open_schedules_one_proxy_and_one_normalize_job(workspace, encodes, probe_hdr):
    from lib.look import MASTER_LOOK
    from lib.proxy import PROXY_FORMAT

    project_dir, src = _make_project(workspace, PID)
    proxy, master = _legacy_artifacts(src)
    _set_fields(project_dir, proxySrc=str(proxy), normalizedSrc=str(master))

    _open_and_settle(PID, project_dir)

    assert len(encodes.proxy) == 1, encodes.proxy
    assert len(encodes.normalize) == 1, encodes.normalize
    assert encodes.proxy[0][1].endswith(f"_proxy_{MASTER_LOOK}_{PROXY_FORMAT}.mp4")
    assert encodes.normalize[0][1].endswith(f"_normalized_sdr_bt709_{MASTER_LOOK}.mp4")
    # Both encode from the item's source, never from the stale artifact.
    assert encodes.proxy[0][0] == os.path.realpath(src)
    assert encodes.normalize[0][0] == str(src)


def test_completion_writes_fresh_paths_back(workspace, encodes, probe_hdr):
    from lib.look import MASTER_LOOK
    from lib.proxy import PROXY_FORMAT

    project_dir, src = _make_project(workspace, PID)
    proxy, master = _legacy_artifacts(src)
    _set_fields(project_dir, proxySrc=str(proxy), normalizedSrc=str(master))

    _open_and_settle(PID, project_dir)

    project = _read(project_dir)
    item = _item(project)
    assert item["proxySrc"].endswith(f"_proxy_{MASTER_LOOK}_{PROXY_FORMAT}.mp4")
    assert item["normalizedSrc"].endswith(f"_normalized_sdr_bt709_{MASTER_LOOK}.mp4")
    assert Path(item["proxySrc"]).exists()
    assert Path(item["normalizedSrc"]).exists()
    # The `sources` mirror is healed too — cli/commands/clean.py walks both, so
    # leaving one half stale would resurrect the pointer this pass just fixed.
    assert project["sources"][0]["proxySrc"] == item["proxySrc"]
    assert project["sources"][0]["normalizedSrc"] == item["normalizedSrc"]


def test_second_open_schedules_nothing(workspace, encodes, probe_hdr):
    project_dir, src = _make_project(workspace, PID)
    proxy, master = _legacy_artifacts(src)
    _set_fields(project_dir, proxySrc=str(proxy), normalizedSrc=str(master))

    _open_and_settle(PID, project_dir)
    after_first = encodes.total
    first_body = _read(project_dir)

    _open_and_settle(PID, project_dir)

    assert encodes.total == after_first, "second open re-scheduled a migrated project"
    assert _read(project_dir) == first_body, "second open rewrote a migrated project"


def test_second_open_while_jobs_in_flight_schedules_nothing(workspace, encodes, probe_hdr):
    """Two sibling projects share one lazy source (the clips fan-out). Opening
    both while the first encode is still running must not start a second one —
    and BOTH projects must still get the completed path written back."""
    shared_dir = workspace / ".sources" / "abc"
    shared_dir.mkdir(parents=True)
    shared_src = shared_dir / "original.MOV"
    shared_src.write_bytes(b"source")
    stale_proxy = shared_dir / "original_proxy_hable1.mp4"
    stale_proxy.write_bytes(b"old-proxy")

    dirs = []
    for pid, name in ((PID, "child-a"), (PID2, "child-b")):
        project_dir, _ = _make_project(workspace, pid, name)
        project = _read(project_dir)
        for group in list(project["tracks"]) + [project["sources"]]:
            for item in group:
                item["src"] = str(shared_src)
                item["proxySrc"] = str(stale_proxy)
        _write(project_dir, project)
        dirs.append(project_dir)

    async def _run():
        encodes.gate = asyncio.Event()
        await get_project(PID, project_dir=dirs[0])
        # First encode is queued; let the worker actually enter it, then open
        # the sibling while it is still stalled on the gate.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert len(encodes.proxy) == 1
        await get_project(PID2, project_dir=dirs[1])
        assert len(encodes.proxy) == 1, "sibling open started a duplicate encode"
        encodes.gate.set()
        await _settle()

    asyncio.run(_run())

    assert len(encodes.proxy) == 1
    expected = encodes.proxy[0][1]
    for project_dir in dirs:
        assert _item(_read(project_dir))["proxySrc"] == expected


def test_sdr_source_schedules_nothing(workspace, encodes, probe_hdr):
    """An untagged master of an SDR source is a live colour-conformance master,
    not a stale tone-map — it carries no look and must be left alone."""
    project_dir, src = _make_project(workspace, PID)
    _, master = _legacy_artifacts(src)
    probe_hdr[str(src)] = SDR_INFO
    _set_fields(project_dir, normalizedSrc=str(master))

    _open_and_settle(PID, project_dir)

    assert encodes.total == 0
    assert _item(_read(project_dir))["normalizedSrc"] == str(master)


def test_hdr_project_master_untouched(workspace, encodes, probe_hdr):
    """The tone-map (and its look tag) only exists on the HDR→SDR path. An HDR
    project's masters are never tagged, so there is nothing to migrate."""
    project_dir, src = _make_project(workspace, PID, color_space="hdr_hlg")
    stem = src.with_suffix("")
    master = Path(f"{stem}_normalized_hdr_hlg.mp4")
    master.write_bytes(b"hdr-master")
    _set_fields(project_dir, normalizedSrc=str(master))

    _open_and_settle(PID, project_dir)

    assert encodes.total == 0
    assert _item(_read(project_dir))["normalizedSrc"] == str(master)


def test_missing_source_is_skipped(workspace, encodes, probe_hdr):
    """Bounded: an item whose source is gone has nothing to re-encode from. It
    must not crash the open and must not queue work."""
    project_dir, src = _make_project(workspace, PID)
    proxy, master = _legacy_artifacts(src)
    _set_fields(project_dir, proxySrc=str(proxy), normalizedSrc=str(master))
    src.unlink()

    body = _open_and_settle(PID, project_dir)

    assert encodes.total == 0
    item = _item(body)
    assert item["proxySrc"] == str(proxy)
    assert item["normalizedSrc"] == str(master)


def test_fresh_artifacts_are_repointed_without_encoding(workspace, encodes, probe_hdr):
    """The current-look artifacts already exist (a sibling project encoded them,
    or a previous migration did). Repoint the fields; encode nothing."""
    from lib.look import MASTER_LOOK
    from lib.proxy import PROXY_FORMAT

    project_dir, src = _make_project(workspace, PID)
    proxy, master = _legacy_artifacts(src)
    stem = src.with_suffix("")
    fresh_proxy = Path(f"{stem}_proxy_{MASTER_LOOK}_{PROXY_FORMAT}.mp4")
    fresh_master = Path(f"{stem}_normalized_sdr_bt709_{MASTER_LOOK}.mp4")
    fresh_proxy.write_bytes(b"proxy")
    fresh_master.write_bytes(b"master")
    _set_fields(project_dir, proxySrc=str(proxy), normalizedSrc=str(master))

    _open_and_settle(PID, project_dir)

    assert encodes.total == 0
    item = _item(_read(project_dir))
    assert item["proxySrc"] == str(fresh_proxy)
    assert item["normalizedSrc"] == str(fresh_master)


def test_window_cache_is_not_migrated(workspace, encodes, probe_hdr):
    """`normalizedSrc` can be a per-window cache (lazy import). Its timing is
    anchored by `normalizedInPoint`, so swapping in a full-source master would
    play the wrong window. Only a field naming THIS item's own full-source
    master is migrated."""
    project_dir, src = _make_project(workspace, PID)
    window = src.parent / "clip_window_0.mp4"
    window.write_bytes(b"window")
    _set_fields(project_dir, normalizedSrc=str(window), normalizedInPoint=12.0)

    _open_and_settle(PID, project_dir)

    assert encodes.total == 0
    assert _item(_read(project_dir))["normalizedSrc"] == str(window)


def test_missing_current_look_master_is_regenerated(workspace, encodes, probe_hdr):
    """`montaj clean` can delete a master out from under a live pointer. A
    field naming the CURRENT look's master whose file is gone is stale by
    absence — regenerate it (no probe needed: the tag proves it was tone-mapped)."""
    from lib.look import MASTER_LOOK

    project_dir, src = _make_project(workspace, PID)
    stem = src.with_suffix("")
    tagged = Path(f"{stem}_normalized_sdr_bt709_{MASTER_LOOK}.mp4")
    _set_fields(project_dir, normalizedSrc=str(tagged))  # never written to disk

    _open_and_settle(PID, project_dir)

    assert len(encodes.normalize) == 1
    assert _item(_read(project_dir))["normalizedSrc"] == str(tagged)
    assert tagged.exists()


def test_missing_proxy_file_is_regenerated(workspace, encodes, probe_hdr):
    """Same for a deleted proxy: the name is current-look but the file is gone."""
    from lib.look import MASTER_LOOK
    from lib.proxy import PROXY_FORMAT

    project_dir, src = _make_project(workspace, PID)
    stem = src.with_suffix("")
    tagged = Path(f"{stem}_proxy_{MASTER_LOOK}_{PROXY_FORMAT}.mp4")
    _set_fields(project_dir, proxySrc=str(tagged))  # never written to disk

    _open_and_settle(PID, project_dir)

    assert len(encodes.proxy) == 1
    assert _item(_read(project_dir))["proxySrc"] == str(tagged)


def test_current_look_proxy_without_format_tag_is_stale(workspace, encodes, probe_hdr):
    """Regression: the name-only triage used to test only
    `f"_proxy_{PROXY_LOOK}" not in basename` — and `..._proxy_vivid1.mp4`
    (current LOOK, but from before the AV1->H.264 proxy-format switch)
    CONTAINS `_proxy_vivid1`, so every existing AV1-generation proxy was
    wrongly judged current and never replaced. The triage now tests the full
    `_proxy_<look>_<format>` tag, so this exact on-disk file must still be
    treated as stale and re-encoded to the H.264 name."""
    from lib.look import MASTER_LOOK
    from lib.proxy import PROXY_FORMAT

    project_dir, src = _make_project(workspace, PID)
    stem = src.with_suffix("")
    untagged_format = Path(f"{stem}_proxy_{MASTER_LOOK}.mp4")  # current look, old format
    untagged_format.write_bytes(b"old-format-proxy")
    _set_fields(project_dir, proxySrc=str(untagged_format))

    _open_and_settle(PID, project_dir)

    assert len(encodes.proxy) == 1, encodes.proxy
    new_proxy = _item(_read(project_dir))["proxySrc"]
    assert new_proxy.endswith(f"_proxy_{MASTER_LOOK}_{PROXY_FORMAT}.mp4")
    assert new_proxy != str(untagged_format)
    # The stale AV1-generation file is left on disk — migration repoints,
    # `montaj clean` deletes it.
    assert untagged_format.exists()


def test_overlay_track_video_items_are_migrated(workspace, encodes, probe_hdr):
    """`proxySrc` lives on overlay-track video items too — the pass walks every
    track, not just tracks[0]."""
    project_dir, src = _make_project(workspace, PID)
    overlay_src = project_dir / "presenter.MOV"
    overlay_src.write_bytes(b"source")
    stale = project_dir / "presenter_proxy_hable1.mp4"
    stale.write_bytes(b"old-proxy")

    project = _read(project_dir)
    project["tracks"].append([
        {"id": "logo", "type": "image", "src": str(project_dir / "logo.png"),
         "start": 0.0, "end": 5.0},
        {"id": "presenter", "type": "video", "src": str(overlay_src),
         "start": 0.0, "end": 5.0, "proxySrc": str(stale)},
    ])
    _write(project_dir, project)

    _open_and_settle(PID, project_dir)

    assert len(encodes.proxy) == 1
    assert encodes.proxy[0][0] == os.path.realpath(overlay_src)
    overlay_item = _item(_read(project_dir), track=1, index=1)
    assert overlay_item["proxySrc"] == encodes.proxy[0][1]
    # The image item alongside it is untouched.
    assert _item(_read(project_dir), track=1, index=0) == {
        "id": "logo", "type": "image", "src": str(project_dir / "logo.png"),
        "start": 0.0, "end": 5.0,
    }


def test_proxy_opt_out_is_honoured(workspace, encodes, probe_hdr):
    """`settings.proxy: false` is an explicit opt-out of proxy machinery; a
    background look refresh must not override it."""
    project_dir, src = _make_project(workspace, PID)
    proxy, _ = _legacy_artifacts(src)
    project = _read(project_dir)
    project["settings"]["proxy"] = False
    _write(project_dir, project)
    _set_fields(project_dir, proxySrc=str(proxy))

    _open_and_settle(PID, project_dir)

    assert encodes.total == 0
    assert _item(_read(project_dir))["proxySrc"] == str(proxy)


def test_clean_project_is_not_rewritten(workspace, encodes, probe_hdr):
    """A project with no artifact fields at all: no probe, no jobs, and LOOK
    migration itself makes no change. The one write this open still performs
    is T6's lazy track-shape convergence (`_make_project` writes the legacy
    `tracks: [[item]]` shape) — that pass is independent of look migration, so
    the file after open must be exactly the shape-normalized `before`, nothing
    more."""
    from lib.project_tracks import normalize_tracks

    project_dir, src = _make_project(workspace, PID)
    before = json.loads((project_dir / "project.json").read_text())
    expected = normalize_tracks(before)

    body = _open_and_settle(PID, project_dir)

    assert encodes.total == 0
    assert json.loads((project_dir / "project.json").read_text()) == expected
    assert body == expected


def test_failed_encode_leaves_field_cleared(workspace, encodes, probe_hdr, monkeypatch):
    """A failed background encode degrades to "no cache" — preview and render
    both fall back to `src`. It must never leave a pointer at the stale file."""
    import serve.routes.steps as steps_mod
    from serve.jobs import set_error

    async def _failing(job_id, input_path, *, out, tonemap=None):
        set_error(job_id, {"error": "step_failed", "message": "boom"})

    monkeypatch.setattr(steps_mod, "run_proxy_job", _failing)

    project_dir, src = _make_project(workspace, PID)
    proxy, _ = _legacy_artifacts(src)
    _set_fields(project_dir, proxySrc=str(proxy))

    _open_and_settle(PID, project_dir)

    assert "proxySrc" not in _item(_read(project_dir))


def test_concurrent_write_during_probe_is_not_clobbered(workspace, encodes, monkeypatch):
    """The probe pass is the one await inside the open-time migration, so a PUT
    can land in that window. The commit re-reads instead of dumping the dict it
    read before the probe — otherwise it would silently revert that PUT."""
    import lib.normalize as normalize_mod
    from lib.look import MASTER_LOOK

    project_dir, src = _make_project(workspace, PID)
    _, master = _legacy_artifacts(src)
    _set_fields(project_dir, normalizedSrc=str(master))

    def _probe_then_write(path):
        project = _read(project_dir)
        project["name"] = "renamed mid-probe"
        _write(project_dir, project)
        return HDR_INFO

    monkeypatch.setattr(normalize_mod, "probe_video", _probe_then_write)

    body = _open_and_settle(PID, project_dir)

    project = _read(project_dir)
    assert project["name"] == "renamed mid-probe"
    assert body["name"] == "renamed mid-probe"
    assert _item(project)["normalizedSrc"].endswith(f"_normalized_sdr_bt709_{MASTER_LOOK}.mp4")


def test_migration_broadcasts_both_the_clear_and_the_write_back(workspace, encodes, probe_hdr):
    """Open-time clearing and each completion write-back both go out over SSE, so
    an editor that already has the project open picks the artifacts up live."""
    from serve.routes.projects import migrate_project_look

    class _Broadcaster:
        def __init__(self):
            self.frames = []

        def publish(self, project_id, frame):
            self.frames.append((project_id, frame))

    project_dir, src = _make_project(workspace, PID)
    proxy, _ = _legacy_artifacts(src)
    _set_fields(project_dir, proxySrc=str(proxy))
    bus = _Broadcaster()

    async def _run():
        project = _read(project_dir)
        await migrate_project_look(PID, project_dir, project, bus)
        await _settle()

    asyncio.run(_run())

    assert [pid for pid, _ in bus.frames] == [PID, PID]
    cleared, written = [json.loads(f.split("data: ", 1)[1]) for _, f in bus.frames]
    assert "proxySrc" not in _item(cleared)
    assert _item(written)["proxySrc"] == encodes.proxy[0][1]


def test_http_open_returns_migrated_body(workspace, encodes, probe_hdr):
    """The real route, over HTTP: the response is the migrated project and the
    queued encode lands in project.json without any further client action."""
    import time

    from starlette.testclient import TestClient

    from serve.server import app

    project_dir, src = _make_project(workspace, PID)
    proxy, _ = _legacy_artifacts(src)
    _set_fields(project_dir, proxySrc=str(proxy))

    with TestClient(app) as client:
        resp = client.get(f"/api/projects/{PID}")
        assert resp.status_code == 200, resp.text
        assert "proxySrc" not in _item(resp.json())
        for _ in range(200):
            if _item(_read(project_dir)).get("proxySrc"):
                break
            time.sleep(0.02)

    assert _item(_read(project_dir))["proxySrc"] == encodes.proxy[0][1]


def test_item_removed_before_completion_is_skipped(workspace, encodes, probe_hdr):
    """The project can change between the open that scheduled the encode and the
    encode landing. A target item that vanished is skipped, not resurrected."""
    project_dir, src = _make_project(workspace, PID)
    proxy, _ = _legacy_artifacts(src)
    _set_fields(project_dir, proxySrc=str(proxy))

    async def _run():
        encodes.gate = asyncio.Event()
        await get_project(PID, project_dir=project_dir)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        # The user deletes the clip while the proxy is encoding.
        project = _read(project_dir)
        project["tracks"][0] = []
        project["sources"] = []
        _write(project_dir, project)
        encodes.gate.set()
        await _settle()

    asyncio.run(_run())

    project = _read(project_dir)
    assert project["tracks"][0] == []
    assert project["sources"] == []
