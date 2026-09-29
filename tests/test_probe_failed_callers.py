"""What each caller does with a ProbeError (PV57 T2).

lib.color_provenance.probe_media raises ProbeError(path, reason, detail) when a
file exists and ffprobe cannot read it (T1), so the proxy's input and grade are
unknown. Every caller must turn that into a decided behaviour, never a guess
and never an unhandled 500:

  * POST /api/proxy: a named `probe_failed` error, 503 when a retry can help
    (timeout, killed, spawn), 422 when it cannot (exit, parse, no-stream);
  * run_proxy_job: the job fails with that named error;
  * a batch over a project's items (POST /projects/{id}/proxies, the open's
    look migration): the item is skipped and left as it is, the others carry
    on, and the skip is returned and/or broadcast as `event: probe-failed`;
  * ingest_source: the clip is imported without a proxy, and the failure logged;
  * init: the proxy failure line names the file and the reason;
  * `montaj render`: one line per file the heal could not read, with `blocking`;
  * the heal on open: its probeFailed goes out as `event: probe-failed`.

Only lib.color_provenance.probe_media is faked (the files are stub bytes),
except for init, which runs for real with an ffprobe that fails the
provenance probe alone.
"""
import asyncio
import errno
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

import lib.color_provenance as cp
import serve.routes.projects as pm
import serve.routes.steps as steps_mod
from lib.project_tracks import track_items
from lib.proxy import proxy_path_for

PID = "57575757-5757-4757-8757-575757575757"
SDR = cp.Probe("bt709", "", 1920, 1080, "30/1", 5.0)


@pytest.fixture(autouse=True)
def _clean_state():
    def _reset():
        pm._look_migration_queue.clear()
        pm._look_migration_current = None
        pm._look_migration_worker = None
        pm._probe_failures_held.clear()
    _reset()
    yield
    _reset()


class _Probes:
    """lib.color_provenance.probe_media over stub files: a path in `failing`
    raises ProbeError(path, reason, detail); anything else reads as SDR with no
    marker. Counts calls per path."""

    def __init__(self):
        self.failing: dict[str, tuple[str, str]] = {}
        self.calls: dict[str, int] = {}

    def __call__(self, path, **_):
        path = os.fspath(path)
        self.calls[path] = self.calls.get(path, 0) + 1
        if path in self.failing:
            raise cp.ProbeError(path, *self.failing[path])
        return SDR


@pytest.fixture
def probes(monkeypatch) -> _Probes:
    p = _Probes()
    monkeypatch.setattr(cp, "probe_media", p)
    return p


@pytest.fixture
def workspace(tmp_path, monkeypatch) -> Path:
    ws = Path(os.path.realpath(tmp_path)) / "Montaj"
    ws.mkdir(parents=True)
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    return ws


@pytest.fixture
def encodes(monkeypatch) -> list:
    """Proxy encodes write a stub file instead of running ffmpeg."""
    from serve.jobs import set_done

    done = []

    async def _fake_proxy(job_id, input_path, *, out, tonemap=None):
        done.append((input_path, out))
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(b"proxy")
        set_done(job_id, {"path": out, "skipped": False})

    monkeypatch.setattr(steps_mod, "run_proxy_job", _fake_proxy)
    return done


class _Bus:
    def __init__(self):
        self.frames: list[str] = []

    def publish(self, project_id, frame):
        self.frames.append(frame)

    def events(self, name: str) -> list[dict]:
        head = f"event: {name}\ndata: "
        return [json.loads(f[len(head):]) for f in self.frames if f.startswith(head)]


def _two_clip_project(workspace: Path, *, color_space="sdr_bt709", **fields) -> tuple[Path, str, str]:
    """clip A and clip B, each on the track and in `sources` (twins with the
    same id and src). `fields` go on every item. Returns (dir, a, b)."""
    project_dir = workspace / "proj"
    project_dir.mkdir(parents=True, exist_ok=True)
    a, b = str(project_dir / "a.MOV"), str(project_dir / "b.MOV")
    Path(a).write_bytes(b"a")
    Path(b).write_bytes(b"b")

    def _clip(i, src):
        return {"id": f"clip-{i}", "type": "video", "src": src, "start": 0.0, "end": 5.0, **fields}

    project = {
        "id": PID, "version": "0.2", "status": "draft", "projectType": "video",
        "settings": {"colorSpace": color_space, "resolution": [1080, 1920], "fps": 30},
        "tracks": [[_clip(0, a), _clip(1, b)]],
        "sources": [_clip(0, a), _clip(1, b)],
    }
    (project_dir / "project.json").write_text(json.dumps(project, indent=2))
    return project_dir, a, b


def _read(project_dir: Path) -> dict:
    return json.loads((project_dir / "project.json").read_text())


def _items(project: dict) -> list[dict]:
    return list(track_items(project)[0]) + list(project["sources"])


async def _settle() -> None:
    worker = pm._look_migration_worker
    if worker is not None:
        await worker


# ── POST /api/proxy and run_proxy_job ─────────────────────────────────────────

@pytest.mark.parametrize("reason,status,retryable", [
    ("timeout", 503, True), ("killed", 503, True), ("spawn", 503, True),
    ("exit", 422, False), ("parse", 422, False), ("no-stream", 422, False),
])
def test_proxy_route_names_the_probe_failure(workspace, probes, encodes, reason, status, retryable):
    from starlette.testclient import TestClient
    from serve.server import app

    src = workspace / "clip.MOV"
    src.write_bytes(b"stub")
    probes.failing[str(src)] = (reason, "what ffprobe said")

    with TestClient(app) as client:
        resp = client.post("/api/proxy", json={"input": str(src)})

    assert resp.status_code == status, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "probe_failed"
    assert (detail["path"], detail["reason"], detail["detail"]) == (str(src), reason, "what ffprobe said")
    assert detail["retryable"] is retryable
    assert str(src) in detail["message"] and f"({reason})" in detail["message"]
    assert encodes == []  # no job, no proxy
    assert not Path(proxy_path_for(str(src))).exists()


def test_proxy_route_treats_spawn_enoent_as_not_retryable_422(workspace, probes, encodes):
    """PV57 review nit: 'spawn' is retryable in general (EAGAIN/ENOMEM/EMFILE/
    ENFILE, the machine was briefly short), but ENOENT means there is no
    ffprobe binary at all — an operator problem no client retry fixes, so it
    must be 422, not the 503 a generic 'spawn' gets."""
    from starlette.testclient import TestClient
    from serve.server import app

    src = workspace / "clip.MOV"
    src.write_bytes(b"stub")
    probes.failing[str(src)] = ("spawn", "ffprobe did not start (ENOENT)", errno.ENOENT)

    with TestClient(app) as client:
        resp = client.post("/api/proxy", json={"input": str(src)})

    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["reason"] == "spawn" and detail["retryable"] is False


def test_proxy_job_fails_with_the_named_error(workspace, probes):
    from serve.jobs import create_job, get_job

    src = workspace / "clip.MOV"
    src.write_bytes(b"stub")
    out = proxy_path_for(str(src))
    probes.failing[str(src)] = ("exit", "exit 1: Invalid data found when processing input")

    job_id = create_job()
    asyncio.run(steps_mod.run_proxy_job(job_id, str(src), out=out, tonemap=None))

    job = get_job(job_id)
    assert job["status"] == "error"
    err = job["error"]
    assert err["error"] == "probe_failed"
    assert (err["path"], err["reason"]) == (str(src), "exit")
    assert err["retryable"] is False
    # The message alone is enough to know which file and why.
    assert str(src) in err["message"] and "(exit)" in err["message"]
    assert "Invalid data found" in err["message"]
    assert not Path(out).exists()


# ── a batch over a project's items ────────────────────────────────────────────

def test_ensure_current_proxies_skips_the_unreadable_clip_and_does_the_rest(workspace, probes, encodes):
    old = "/nowhere/a_proxy_hable1.mp4"
    project_dir, a, b = _two_clip_project(workspace)
    project = _read(project_dir)
    for item in _items(project):
        if item["src"] == a:
            item["proxySrc"] = old
    (project_dir / "project.json").write_text(json.dumps(project, indent=2))
    probes.failing[a] = ("exit", "exit 1: moov atom not found")
    bus = _Bus()

    async def _run():
        result = pm._ensure_current_proxies(PID, project_dir, _read(project_dir), bus)
        await _settle()
        return result

    result = asyncio.run(_run())

    # B went ahead; A was skipped, listed once although it has a twin.
    assert result["scheduled"] == 1 and result["alreadyFresh"] == 0
    assert encodes == [(os.path.realpath(b), proxy_path_for(os.path.realpath(b)))]
    [entry] = result["probeFailed"]
    assert entry["error"] == "probe_failed"
    assert (entry["src"], entry["path"], entry["reason"]) == (a, a, "exit")
    assert entry["detail"] == "exit 1: moov atom not found" and entry["retryable"] is False
    # A is left exactly as it was: no proxy made or adopted for it on a guess.
    for item in _items(_read(project_dir)):
        if item["src"] == a:
            assert item["proxySrc"] == old
        else:
            assert item["proxySrc"] == proxy_path_for(os.path.realpath(b))
    assert not Path(proxy_path_for(a)).exists()
    # And the skip went out over SSE, as a named event the app does not show.
    [event] = bus.events("probe-failed")
    assert event == {"op": "proxies", "failures": result["probeFailed"]}
    assert bus.events("log") == []


def test_generate_previews_route_returns_the_skips(workspace, probes, encodes):
    from starlette.testclient import TestClient
    from serve.server import app

    project_dir, a, b = _two_clip_project(workspace)
    probes.failing[a] = ("timeout", "no answer in 30 s, 2 tries")

    with TestClient(app) as client:
        resp = client.post(f"/api/projects/{PID}/proxies")

    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["scheduled"] == 1 and body["alreadyFresh"] == 0
    [entry] = body["probeFailed"]
    assert (entry["error"], entry["src"], entry["reason"], entry["retryable"]) == \
        ("probe_failed", a, "timeout", True)


def test_open_look_migration_skips_the_unreadable_clip_and_migrates_the_rest(workspace, probes, encodes):
    """Both clips point at an old-look proxy. B's is cleared and re-encoded; A,
    whose provenance cannot be read, keeps its pointer until the next open."""
    project_dir, a, b = _two_clip_project(workspace)
    project = _read(project_dir)
    stale = {}
    for item in _items(project):
        stale[item["src"]] = item["proxySrc"] = str(Path(item["src"]).with_suffix("")) + "_proxy_hable1.mp4"
        Path(item["proxySrc"]).write_bytes(b"old-look proxy")
    (project_dir / "project.json").write_text(json.dumps(project, indent=2))
    probes.failing[a] = ("killed", "killed by SIGKILL, 2 tries")
    bus = _Bus()

    async def _run():
        body = await pm.migrate_project_look(PID, project_dir, _read(project_dir), bus)
        await _settle()
        return body

    asyncio.run(_run())

    assert encodes == [(os.path.realpath(b), proxy_path_for(os.path.realpath(b)))]
    for item in _items(_read(project_dir)):
        if item["src"] == a:
            assert item["proxySrc"] == stale[a]
        else:
            assert item["proxySrc"] == proxy_path_for(os.path.realpath(b))
    [event] = bus.events("probe-failed")
    assert event["op"] == "look migration"
    assert [(f["src"], f["path"], f["reason"]) for f in event["failures"]] == [(a, a, "killed")]


def test_a_failed_file_is_not_probed_again_on_the_event_loop(workspace, probes, encodes):
    """The warm (off the loop) already asked ffprobe about A and it failed. The
    synchronous pass right after, which runs ON the event loop, does not ask
    again, for A or its twin: a timeout there would stall serve for a minute.
    The hold is short, so the next operation asks again."""
    project_dir, a, b = _two_clip_project(workspace)
    probes.failing[a] = ("timeout", "no answer in 30 s, 2 tries")

    async def _run():
        await pm._warm_proxy_inputs(pm._video_srcs(_read(project_dir)))
        result = pm._ensure_current_proxies(PID, project_dir, _read(project_dir), None)
        await _settle()
        return result

    result = asyncio.run(_run())
    assert [f["src"] for f in result["probeFailed"]] == [a]
    assert probes.calls[a] == 1  # the warm's; neither A nor its twin re-asked on the loop

    # Positive control: with the hold over, the next warm asks again, and so
    # does the pass on the loop (once: the twin is skipped as already failed).
    pm._probe_failures_held.clear()
    hold = pm._PROBE_FAILURE_HOLD_S
    pm._PROBE_FAILURE_HOLD_S = 0.0
    try:
        result = asyncio.run(_run())
    finally:
        pm._PROBE_FAILURE_HOLD_S = hold
    assert [f["src"] for f in result["probeFailed"]] == [a]
    assert probes.calls[a] == 3

    # And once A reads, the next operation makes its proxy.
    probes.failing.pop(a)
    pm._probe_failures_held.clear()
    result = asyncio.run(_run())
    assert result["probeFailed"] == [] and result["scheduled"] == 1


def test_warm_does_not_renew_a_hold_from_a_cache_hit_only_a_fresh_probe_extends_it(
        workspace, probes, encodes, monkeypatch):
    """PV57 review (RISK): _warm_proxy_inputs used to re-hold every failure it
    SAW, including ones only read from an existing hold with no fresh probe —
    so steady activity (a warm every few seconds, always inside the 10s
    window) kept re-stamping the hold's expiry to "now" forever, and a file
    that had become readable again stayed skipped. Only a FRESH probe failure
    (one _proxy_input_for itself just held) may push the expiry out."""

    class _FakeClock:
        t = 0.0

        def monotonic(self):
            return self.t

    project_dir, a, b = _two_clip_project(workspace)
    probes.failing[a] = ("timeout", "no answer in 30 s, 2 tries")
    clock = _FakeClock()
    monkeypatch.setattr(pm, "time", clock)

    async def _warm():
        await pm._warm_proxy_inputs(pm._video_srcs(_read(project_dir)))

    asyncio.run(_warm())
    assert probes.calls[a] == 1
    first_stamp = pm._probe_failures_held[a][0]
    assert first_stamp == 0.0

    # 8s later: still inside the ORIGINAL 10s hold. A cache hit inside
    # _proxy_input_for — no fresh probe — so the stamp must not move to 8.
    clock.t = 8.0
    asyncio.run(_warm())
    assert probes.calls[a] == 1, "read from the hold, not re-probed"
    assert pm._probe_failures_held[a][0] == first_stamp, "a cache hit must not renew the hold"

    # 11s after the ORIGINAL failure (t=0): that hold has expired, so a real
    # probe happens — and, still failing, sets a fresh stamp.
    clock.t = 11.0
    asyncio.run(_warm())
    assert probes.calls[a] == 2, "the hold had expired and was probed again"
    assert pm._probe_failures_held[a][0] == 11.0

    # The file now reads: the next warm clears the hold.
    probes.failing.pop(a)
    clock.t = 22.0
    asyncio.run(_warm())
    assert a not in pm._probe_failures_held


def test_serve_ingest_keeps_the_clip_and_does_not_say_no_proxy_needed(workspace, probes, encodes, monkeypatch):
    """serve's import: the clip lands, its proxy is skipped, and the import log
    does not claim no proxy was needed."""
    from serve.routes.projects import _IngestJob, _run_ingest_detached

    project_dir, a, b = _two_clip_project(workspace)
    project = _read(project_dir)
    project["tracks"], project["sources"] = [{"id": "t0", "items": []}], []
    (project_dir / "project.json").write_text(json.dumps(project))
    monkeypatch.setattr(pm, "ingest_source", lambda *a_, **k: {"type": "video", "src": a, "start": 0.0,
                                                               "end": 0.0, "sourceDuration": 5.0})
    probes.failing[a] = ("exit", "exit 1: moov atom not found")
    bus = _Bus()
    job = _IngestJob()

    async def _run():
        await _run_ingest_detached(PID, project_dir, "/elsewhere/a.MOV", "sdr_bt709", bus, job)
        await _settle()

    asyncio.run(_run())

    assert job.status == "done", job.error
    assert [s["src"] for s in _read(project_dir)["sources"]] == [a]
    assert "proxySrc" not in _read(project_dir)["sources"][0]
    assert encodes == []
    said = [e["message"] for e in bus.events("log")]
    assert "[ingest] proxy could not be queued" in said
    assert "[ingest] no proxy needed" not in said
    [event] = bus.events("probe-failed")
    assert [f["src"] for f in event["failures"]] == [a]


# ── ingest ────────────────────────────────────────────────────────────────────

def test_ingest_keeps_the_clip_and_skips_only_its_proxy(tmp_path, monkeypatch, probes, capsys):
    import lib.ingest as ing

    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    src = tmp_path / "incoming" / "shot.MOV"
    src.parent.mkdir()
    src.write_bytes(b"stub")
    proj = tmp_path / "proj"
    proj.mkdir()
    staged = str(proj / "shot.MOV")
    info = {"codec": "h264", "pix_fmt": "yuv420p", "color_transfer": "bt709", "display_width": 1920,
            "display_height": 1080, "has_audio": True}
    monkeypatch.setattr(ing, "probe_video", lambda _p: info)
    monkeypatch.setattr(ing, "is_normalized", lambda *_a: True)
    monkeypatch.setattr(ing, "get_duration", lambda _p: 5.0)
    made = []
    monkeypatch.setattr(ing, "make_proxy", lambda *a, **k: made.append(a))
    probes.failing[staged] = ("timeout", "no answer in 30 s, 2 tries")

    clip = ing.ingest_source(str(proj), str(src), "sdr_bt709")

    assert clip["src"] == staged and clip["sourceDuration"] == 5.0
    assert clip["sourceWidth"] == 1920
    assert "proxySrc" not in clip
    assert made == []
    err = capsys.readouterr().err
    assert f"ffprobe could not read {staged} (timeout)" in err


# ── init ──────────────────────────────────────────────────────────────────────

def test_init_logs_the_probe_failure_with_its_reason(tmp_path):
    """init for real, with an ffprobe that fails only the provenance probe (the
    one asking for format_tags=comment,encoder). The import succeeds without
    a proxy, and the proxy line says which file and why."""
    from lib.common import ffmpeg_bin, ffprobe_bin

    src = tmp_path / "clip.mp4"
    subprocess.run([ffmpeg_bin(), "-y", "-v", "error",
                    "-f", "lavfi", "-i", "color=red:size=320x240:rate=30:duration=1",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)],
                   check=True, capture_output=True, timeout=60)
    wrapper = tmp_path / "ffprobe.sh"
    wrapper.write_text(
        "#!/bin/bash\n"
        'for a in "$@"; do\n'
        '  case "$a" in *format_tags=comment,encoder*)\n'
        "    echo 'fake provenance probe failure' >&2; exit 1;;\n"
        "  esac\n"
        "done\n"
        f'exec "{ffprobe_bin()}" "$@"\n')
    wrapper.chmod(0o755)
    ws = tmp_path / "ws"
    ws.mkdir()

    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "project" / "init.py"), "--clips", str(src), "--prompt", "test"],
        capture_output=True, text=True, timeout=300,
        env={**os.environ, "MONTAJ_WORKSPACE_DIR": str(ws), "MONTAJ_FFPROBE": str(wrapper)})

    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip().splitlines()[-1]).read_text())
    item = track_items(project)[0][0]
    assert "proxySrc" not in item
    [line] = [ln for ln in result.stderr.splitlines() if "proxy FAILED" in ln]
    assert f"ffprobe could not read {item['src']} (exit)" in line
    assert "fake provenance probe failure" in line


# ── montaj render ─────────────────────────────────────────────────────────────

def test_cli_render_logs_each_unreadable_file_with_blocking(tmp_path, monkeypatch, capsys):
    import project.render as render_mod

    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "project.json").write_text(json.dumps({"settings": {"colorSpace": "hdr_hlg"}}))
    clip, original, pool = str(proj / "clip.MOV"), str(proj / "IMG_1.MOV"), str(proj / "IMG_2.MOV")
    healed = {"probeFailed": [
        {"pass": "marker", "id": "clip-0", "src": clip, "path": original, "reason": "timeout",
         "detail": "no answer in 30 s, 2 tries", "blocking": True},
        {"pass": "legacy", "id": None, "src": clip, "path": pool, "reason": "exit",
         "detail": "exit 1: moov atom not found", "blocking": False},
    ]}
    monkeypatch.setattr(cp, "ensure_color_provenance", lambda d: healed)
    monkeypatch.setattr(render_mod.os, "execvpe", lambda *a: None)

    render_mod.main(project_path=str(proj / "project.json"))

    lines = [json.loads(ln)["progress"] for ln in capsys.readouterr().err.splitlines()
             if ln.startswith("{") and "could not read" in ln]
    assert len(lines) == 2
    assert original in lines[0] and "(timeout: no answer in 30 s, 2 tries)" in lines[0]
    assert "blocking" in lines[0] and "not blocking" not in lines[0] and clip in lines[0]
    assert pool in lines[1] and "(exit: exit 1: moov atom not found)" in lines[1]
    assert "not blocking" in lines[1]


# ── the heal on open ──────────────────────────────────────────────────────────

def test_heal_on_open_broadcasts_its_probe_failures(tmp_path, monkeypatch):
    """A heal that only deferred (nothing to write) still says which files it
    could not read. The project is returned as it was."""
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    project = {"id": PID, "settings": {"colorSpace": "hdr_hlg"}, "tracks": [], "sources": []}
    (project_dir / "project.json").write_text(json.dumps(project))
    failed = [{"pass": "marker", "id": "clip-0", "src": "/p/clip.MOV", "path": "/p/IMG_1.MOV",
               "reason": "timeout", "detail": "no answer in 30 s, 2 tries", "blocking": True}]
    plan = {**cp._new_result(project_dir), "colorSpace": "hdr_hlg", "probeFailed": failed}
    monkeypatch.setattr(cp, "plan_color_provenance", lambda d: plan)
    bus = _Bus()

    out = asyncio.run(pm.ensure_project_color_provenance(PID, project_dir, project, bus))

    assert out is project
    assert bus.events("probe-failed") == [{"op": "colour provenance", "failures": failed}]
    assert bus.events("log") == []
