"""Async render kick, phase tracking, and the /render/status endpoint.

A manual render can be started in async mode (``?async=1``): the handler kicks the
detached worker and returns 202 immediately instead of holding an SSE stream open.
Clients then poll GET /render/status to follow progress (preparing → captions /
rendering → encoding → done) and pick up the output path or error when terminal.

The terminal job is now PERSISTED in ``_render_jobs`` (no longer popped on
completion) so a post-completion status poll can still read it. Reuses the
``_FakeProc``/``_FakeStream`` mocking style from test_render_detach.py.
"""
import asyncio
from pathlib import Path
from unittest.mock import Mock

import pytest

import serve.routes.projects as projects_mod
from serve.routes.projects import (
    _RenderJob,
    _render_phase_for,
    _run_render_detached,
    render_status,
    render_project,
)

PID = "44444444-4444-4444-8444-444444444444"


@pytest.fixture(autouse=True)
def _clean_state():
    projects_mod._active_renders.clear()
    projects_mod._render_procs.clear()
    projects_mod._render_jobs.clear()
    projects_mod._render_task_refs.clear()
    yield
    projects_mod._active_renders.clear()
    projects_mod._render_procs.clear()
    projects_mod._render_jobs.clear()
    projects_mod._render_task_refs.clear()


class _FakeStream:
    """stderr: hands back `lines` then EOF. stdout: returns `blob` on read()."""
    def __init__(self, lines=(), blob=b""):
        self._lines = list(lines)
        self._blob = blob

    async def readline(self):
        return self._lines.pop(0) if self._lines else b""

    async def read(self):
        return self._blob


class _FakeProc:
    def __init__(self, stderr_lines=(), stdout_blob=b"", returncode=0, pid=4242):
        self.stderr = _FakeStream(lines=stderr_lines)
        self.stdout = _FakeStream(blob=stdout_blob)
        self.returncode = returncode
        self.pid = pid
        self.waited = False

    async def wait(self):
        self.waited = True


def _patch_spawn(monkeypatch, proc):
    async def _fake_exec(*args, **kwargs):
        return proc
    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", _fake_exec)


def _reserve(job):
    projects_mod._render_jobs[PID] = job
    projects_mod._active_renders.add(PID)


# ---------------------------------------------------------------------------
# _render_phase_for
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("line,expected", [
    ("[montaj render] bundling segment 2/16 (overlay-1--ov-hook)...", "rendering"),
    ("[render] bundling segment 65/65 (captions)", "rendering"),
    ("rendering captions (900 frames)...", "captions"),
    ("rendering captions chunk 2/3 (300 frames)...", "captions"),
    ("[montaj render] slice 2/3 (10.00-20.00s): capturing 4 overlay window(s)", "rendering"),
    ("[montaj render] rendering 66 segment(s) with Puppeteer...", "rendering"),
    ("rendering overlay-0--s15 (73 frames)...", None),
    ("[montaj render] rendering with Puppeteer...", "rendering"),
    ("[montaj render] composing final video...", "encoding"),
    ("[montaj compose] concatenating 16 segment(s)...", "encoding"),
    ("[montaj render] deriving SDR rendition → x-sdr.mp4...", "sdr_derive"),
    ("some unrelated chatter", None),
    ("", None),
])
def test_render_phase_for(line, expected):
    assert _render_phase_for(line) == expected


def test_render_phase_bundling_captions_is_rendering_not_captions():
    # Changed from the old rule: every segment is bundled before any renders, so
    # the captions bundling line is still the rendering phase.
    assert _render_phase_for("[montaj render] bundling segment 9/16 (captions)...") == "rendering"


# ---------------------------------------------------------------------------
# _run_render_detached persists the terminal job + tracks phase
# ---------------------------------------------------------------------------

def test_detached_render_persists_job_and_sets_phase_done(monkeypatch, tmp_path):
    proc = _FakeProc(
        stderr_lines=[
            b"[montaj render] bundling segment 1/2 (overlay-1)...\n",
            b"[montaj render] composing final video...\n",
        ],
        stdout_blob=b"/scratch/output/render.mp4\n",
        returncode=0,
    )
    _patch_spawn(monkeypatch, proc)
    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"

    asyncio.run(_run_render_detached(PID, ["node", "render.js"], {}, pp, pp, job))

    assert job.status == "done"
    assert job.phase == "done"
    assert job.result == "/scratch/output/render.mp4"
    # The job is NOT popped — it persists for post-completion polling.
    assert projects_mod._render_jobs.get(PID) is job
    # but the proc/slot are still released.
    assert PID not in projects_mod._active_renders
    assert PID not in projects_mod._render_procs


def test_detached_render_phase_reflects_last_marker_mid_run(monkeypatch, tmp_path):
    # stderr ends after a captions bundling line and no encoding line → the
    # last-seen phase is captions when the stream EOFs (returncode nonzero so it
    # never reaches the done override).
    proc = _FakeProc(
        stderr_lines=[
            b"[montaj render] bundling segment 1/4 (overlay-1)...\n",
            b"[montaj render] rendering captions (900 frames)...\n",
        ],
        returncode=1,
    )
    _patch_spawn(monkeypatch, proc)
    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"

    asyncio.run(_run_render_detached(PID, ["node", "render.js"], {}, pp, pp, job))

    assert job.status == "error"
    assert job.phase == "captions"


def test_detached_render_phase_returns_to_rendering_at_the_next_slice(monkeypatch, tmp_path):
    proc = _FakeProc(
        stderr_lines=[
            b"[montaj render] slice 1/3 (0.00-10.00s): capturing 4 overlay window(s)\n",
            b"[montaj render] rendering captions (90 frames)...\n",
            b"[montaj render] slice 2/3 (10.00-20.00s): capturing 4 overlay window(s)\n",
        ],
        returncode=1,
    )
    _patch_spawn(monkeypatch, proc)
    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"

    asyncio.run(_run_render_detached(PID, ["node", "render.js"], {}, pp, pp, job))

    assert job.phase == "rendering"


def test_detached_render_phase_stays_sdr_derive_through_the_sdr_compose(monkeypatch, tmp_path):
    # PV42: the SDR rendition is a second compose, and compose logs
    # "concatenating", which _render_phase_for maps to "encoding". Once the
    # render has reached sdr_derive, later phase lines must not walk the
    # stepper back (returncode nonzero so the done override never runs).
    proc = _FakeProc(
        stderr_lines=[
            b"[montaj render] composing final video...\n",
            b"[montaj render] deriving SDR rendition \xe2\x86\x92 x-sdr.mp4 (per layer)...\n",
            b"[montaj compose] concatenating 3 segment(s)...\n",
        ],
        returncode=1,
    )
    _patch_spawn(monkeypatch, proc)
    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"

    asyncio.run(_run_render_detached(PID, ["node", "render.js"], {}, pp, pp, job))

    assert job.status == "error"
    assert job.phase == "sdr_derive"


# ---------------------------------------------------------------------------
# echo to serve's stderr
# ---------------------------------------------------------------------------

def test_echo_prefix_uses_first_8_chars(capsys):
    projects_mod._echo_render_line("abcdef1234567890", "hello", {"n": 0, "held": 0})
    assert capsys.readouterr().err == "[montaj render abcdef12] hello\n"


def test_echo_cuts_long_lines_to_500(capsys):
    projects_mod._echo_render_line(PID, "x" * 900, {"n": 0, "held": 0})
    err = capsys.readouterr().err
    assert err == f"[montaj render {PID[:8]}] " + "x" * 500 + "\n"


def test_echo_redacts_home_dirs(capsys):
    st = {"n": 0, "held": 0}
    projects_mod._echo_render_line(PID, "wrote /Users/sam/Montaj/x.mp4", st)
    projects_mod._echo_render_line(PID, "in /home/bob/a and C:\\Users\\Al\\v.mp4", st)
    err = capsys.readouterr().err
    assert "wrote ~/Montaj/x.mp4" in err
    assert "in ~/a and ~\\v.mp4" in err
    assert "Users" not in err and "sam" not in err and "bob" not in err


def test_echo_caps_lines_and_reports_held_back(monkeypatch, capsys):
    monkeypatch.setattr(projects_mod, "RENDER_ECHO_MAX_LINES", 3)
    st = {"n": 0, "held": 0}
    for i in range(5):
        projects_mod._echo_render_line(PID, f"line {i}", st)
    projects_mod._echo_render_close(PID, st)
    lines = capsys.readouterr().err.splitlines()
    assert [l.split("] ", 1)[1] for l in lines[:3]] == ["line 0", "line 1", "line 2"]
    assert len(lines) == 4
    assert lines[3] == f"[montaj render {PID[:8]}] \u2026 2 more lines not echoed"


def test_detached_render_echoes_lines_and_keeps_job_lines(monkeypatch, tmp_path, capsys):
    proc = _FakeProc(
        stderr_lines=[
            b"[montaj render] bundling segment 1/2 (overlay-1)...\n",
            b"[montaj render] composing final video...\n",
        ],
        returncode=0,
    )
    _patch_spawn(monkeypatch, proc)
    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"

    asyncio.run(_run_render_detached(PID, ["node", "render.js"], {}, pp, pp, job))

    assert job.lines == [
        "[montaj render] bundling segment 1/2 (overlay-1)...",
        "[montaj render] composing final video...",
    ]
    err = capsys.readouterr().err
    assert f"[montaj render {PID[:8]}] [montaj render] composing final video...\n" in err


# ---------------------------------------------------------------------------
# render_status endpoint
# ---------------------------------------------------------------------------

def test_render_status_idle_when_no_job(tmp_path):
    out = asyncio.run(render_status(PID, project_dir=tmp_path))
    assert out == {"status": "idle"}


def test_render_status_running(tmp_path):
    job = _RenderJob()
    job.phase = "rendering"
    projects_mod._render_jobs[PID] = job

    out = asyncio.run(render_status(PID, project_dir=tmp_path))
    assert out == {"status": "running", "phase": "rendering"}


def test_render_status_done_includes_output_path(tmp_path):
    job = _RenderJob()
    job.status, job.phase, job.result = "done", "done", "/p/output/x.mp4"
    projects_mod._render_jobs[PID] = job

    out = asyncio.run(render_status(PID, project_dir=tmp_path))
    assert out == {
        "status": "done", "phase": "done",
        "outputPath": "/p/output/x.mp4",
        "outputPaths": ["/p/output/x.mp4"],
    }


def test_render_status_done_with_export_both_splits_output_paths(tmp_path):
    # --export both makes render.js print two stdout lines (master, then the
    # derived SDR sibling) — job.result is that two-line blob verbatim.
    job = _RenderJob()
    job.status, job.phase = "done", "done"
    job.result = "/p/output/x.mp4\n/p/output/x-sdr.mp4"
    projects_mod._render_jobs[PID] = job

    out = asyncio.run(render_status(PID, project_dir=tmp_path))
    assert out == {
        "status": "done", "phase": "done",
        "outputPath": "/p/output/x.mp4",  # first line only, compat with single-path readers
        "outputPaths": ["/p/output/x.mp4", "/p/output/x-sdr.mp4"],
    }


def test_render_status_error_includes_error_and_log_tail(tmp_path):
    job = _RenderJob()
    job.status, job.phase, job.result = "error", "rendering", "Render failed (exit 2)"
    job.lines = ["[montaj render] starting", '{"error": "invalid_status", "message": "boom"}']
    projects_mod._render_jobs[PID] = job

    out = asyncio.run(render_status(PID, project_dir=tmp_path))
    assert out == {
        "status": "error",
        "phase": "rendering",
        "error": "Render failed (exit 2)",
        "log": ["[montaj render] starting", '{"error": "invalid_status", "message": "boom"}'],
    }


def test_render_status_error_log_is_capped_to_the_tail(tmp_path):
    job = _RenderJob()
    job.status, job.result = "error", "Render failed (exit 1)"
    job.lines = [f"line {i}" for i in range(200)]
    projects_mod._render_jobs[PID] = job

    out = asyncio.run(render_status(PID, project_dir=tmp_path))
    assert len(out["log"]) == 40
    assert out["log"][0] == "line 160"
    assert out["log"][-1] == "line 199"


def test_render_status_running_and_done_carry_no_log(tmp_path):
    # The log is a failure-diagnosis aid, not a progress feed — SSE already
    # streams lines live for anyone watching a render in flight.
    running = _RenderJob()
    running.phase = "rendering"
    running.lines = ["noisy"]
    projects_mod._render_jobs[PID] = running
    assert "log" not in asyncio.run(render_status(PID, project_dir=tmp_path))

    done = _RenderJob()
    done.status, done.phase, done.result = "done", "done", "/p/output/x.mp4"
    done.lines = ["noisy"]
    projects_mod._render_jobs[PID] = done
    assert "log" not in asyncio.run(render_status(PID, project_dir=tmp_path))


# ---------------------------------------------------------------------------
# Async kick: handler returns 202 instead of an SSE stream
# ---------------------------------------------------------------------------

class _FakeRequest:
    def __init__(self, query, body=None):
        self.query_params = query
        self._body = body

    async def is_disconnected(self):
        return False

    async def json(self):
        # Mirrors Starlette's Request.json(): raises when no body was sent, so
        # the route's `try: body = await request.json() except: pass` pattern
        # sees the same "no body" signal it sees in production.
        if self._body is None:
            raise ValueError("no body")
        return self._body


def _setup_video_project(tmp_path, monkeypatch):
    """Make render_project's non-carousel path runnable without a real subprocess."""
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "project.json").write_text('{"projectType": "video", "name": "My Reel"}')

    # render.js must exist where render_project looks for it.
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "render.js").write_text("// stub")
    monkeypatch.setattr(projects_mod, "render_runtime_dir", lambda: str(runtime))
    monkeypatch.setattr(projects_mod.shutil, "which", lambda b: "/usr/bin/node")

    # Never actually spawn — capture the cmd and leave a never-resolving job.
    captured = {}

    async def _fake_detached(project_id, cmd, env, render_input, project_path, job, **kwargs):
        captured["cmd"] = cmd
        # leave job running (simulates an in-flight render)

    monkeypatch.setattr(projects_mod, "_run_render_detached", _fake_detached)
    return project_dir, captured


def test_async_kick_returns_202(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"})

    resp = asyncio.run(render_project(PID, req, project_dir=project_dir))

    assert resp.status_code == 202
    import json as _json
    body = _json.loads(bytes(resp.body))
    assert body == {"projectId": PID, "status": "running"}
    # the detached worker was kicked and the job is tracked
    assert PID in projects_mod._render_jobs


def test_video_script_args_include_out_into_output_dir(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    cmd = captured["cmd"]
    assert "--out" in cmd
    out_path = cmd[cmd.index("--out") + 1]
    assert out_path.startswith(str(project_dir / "output"))
    assert out_path.endswith(".mp4")
    assert (project_dir / "output").is_dir()


def test_no_async_param_returns_sse_stream(tmp_path, monkeypatch):
    from fastapi.responses import StreamingResponse
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({})

    resp = asyncio.run(render_project(PID, req, project_dir=project_dir))

    assert isinstance(resp, StreamingResponse)
    assert resp.media_type == "text/event-stream"


# ---------------------------------------------------------------------------
# Optional JSON body: { "export": ..., "sdrCurve": ... } threaded to script_args
# ---------------------------------------------------------------------------

def test_no_body_leaves_argv_unchanged_from_today(tmp_path, monkeypatch):
    """No body at all (request.json() raises, mirroring a bodyless POST) → the
    auto path's argv stays byte-identical to before this body-reading was added."""
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body=None)

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    cmd = captured["cmd"]
    assert "--export" not in cmd
    assert "--sdr-curve" not in cmd


def test_empty_body_leaves_argv_unchanged(tmp_path, monkeypatch):
    """An empty JSON object body is likewise treated as "nothing requested"."""
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    cmd = captured["cmd"]
    assert "--export" not in cmd
    assert "--sdr-curve" not in cmd


def test_body_export_and_sdr_curve_thread_to_script_args(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={"export": "both", "sdrCurve": "vivid1-neutral"})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    cmd = captured["cmd"]
    assert cmd[cmd.index("--export") + 1] == "both"
    assert cmd[cmd.index("--sdr-curve") + 1] == "vivid1-neutral"


def test_body_export_only_omits_sdr_curve_flag(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={"export": "sdr"})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    cmd = captured["cmd"]
    assert cmd[cmd.index("--export") + 1] == "sdr"
    assert "--sdr-curve" not in cmd


def test_body_invalid_export_rejected_422(tmp_path, monkeypatch):
    from fastapi import HTTPException
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={"export": "4k"})

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(render_project(PID, req, project_dir=project_dir))

    assert exc_info.value.status_code == 422
    assert exc_info.value.detail["error"] == "invalid_argument"
    # the render never got kicked off
    assert "cmd" not in captured


def test_body_invalid_sdr_curve_rejected_422(tmp_path, monkeypatch):
    from fastapi import HTTPException
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={"sdrCurve": "not-a-real-curve"})

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(render_project(PID, req, project_dir=project_dir))

    assert exc_info.value.status_code == 422
    assert exc_info.value.detail["error"] == "invalid_argument"
    assert "cmd" not in captured


# ---------------------------------------------------------------------------
# SSE 'done' event carries only the first output path
# ---------------------------------------------------------------------------

def test_sse_done_event_carries_only_first_output_path(tmp_path, monkeypatch):
    """--export both makes render.js print two stdout lines; the SSE 'done' event
    must carry only the first (master) path — same outputPath compat contract as
    the status route — not a raw multi-line blob that would corrupt SSE framing."""
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({})

    resp = asyncio.run(render_project(PID, req, project_dir=project_dir))

    job = projects_mod._render_jobs[PID]
    job.status = "done"
    job.result = "/out/master.mp4\n/out/master-sdr.mp4"

    async def _first_done_chunk():
        async for chunk in resp.body_iterator:
            if "event: done" in chunk:
                return chunk
        return None

    chunk = asyncio.run(_first_done_chunk())
    assert chunk == "event: done\ndata: /out/master.mp4\n\n"


# ---------------------------------------------------------------------------
# §737: the bake counter's latest readings reach render_status
# ---------------------------------------------------------------------------

from serve.routes.projects import _note_bake_reading


def test_note_bake_reading_keeps_the_latest_counter_and_time_left():
    job = _RenderJob()
    # The engine's own lines (renderer.js), as serve reads them from render.js's stderr.
    _note_bake_reading(job, "[montaj render] baked 33/660 frames", 1000)
    _note_bake_reading(job, "[montaj render] bake left 134 s", 1001)
    _note_bake_reading(job, "[montaj render] baked 40/660 frames", 2000)
    assert job.baked == {"done": 40, "total": 660, "at": 2000}
    assert job.bake_left == {"sec": 134, "at": 1001}
    # Not readings: a progress bar, a chunk line, an impossible count, an empty total.
    for line in [
        "[montaj render]   overlay-0--shot-s02   10%|██   | 3/30 [00:00<00:05]",
        "[montaj render] 3d chunk overlay-0--shot-s02: 30 frames x1 in 6378 ms (lanes 1)",
        "[montaj render] baked 700/660 frames",
        "[montaj render] baked 0/0 frames",
        "half-baked 3/4 framesets",
    ]:
        _note_bake_reading(job, line, 9999)
    assert job.baked == {"done": 40, "total": 660, "at": 2000}
    assert job.bake_left == {"sec": 134, "at": 1001}


def test_detached_render_records_bake_readings(monkeypatch, tmp_path):
    proc = _FakeProc(
        stderr_lines=[
            b"[montaj render] bundling segment 1/2 (overlay-1)...\n",
            b"[montaj render] baked 33/660 frames\n",
            b"[montaj render] bake left 134 s\n",
            b"[montaj render] baked 60/660 frames\n",
        ],
        returncode=1,
    )
    _patch_spawn(monkeypatch, proc)
    monkeypatch.setattr(projects_mod.time, "time", lambda: 1_763_330_411.5)
    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"

    asyncio.run(_run_render_detached(PID, ["node", "render.js"], {}, pp, pp, job))

    assert job.baked == {"done": 60, "total": 660, "at": 1_763_330_411_500}
    assert job.bake_left == {"sec": 134, "at": 1_763_330_411_500}


def test_render_status_running_carries_the_bake_readings_with_their_age(monkeypatch, tmp_path):
    job = _RenderJob()
    job.phase = "rendering"
    job.baked = {"done": 330, "total": 660, "at": 100_000}
    job.bake_left = {"sec": 60, "at": 98_000}
    projects_mod._render_jobs[PID] = job
    monkeypatch.setattr(projects_mod.time, "time", lambda: 102.5)

    out = asyncio.run(render_status(PID, project_dir=tmp_path))
    assert out == {
        "status": "running", "phase": "rendering",
        "baked": {"done": 330, "total": 660, "at": 100_000, "ageMs": 2_500},
        "bakeLeft": {"sec": 60, "at": 98_000, "ageMs": 4_500},
    }
    # The job's own readings are not changed by a poll.
    assert job.baked == {"done": 330, "total": 660, "at": 100_000}


def test_render_status_done_and_error_carry_no_bake_readings(tmp_path):
    for status, result in (("done", "/p/output/x.mp4"), ("error", "Render failed (exit 1)")):
        job = _RenderJob()
        job.status, job.phase, job.result = status, "done" if status == "done" else "rendering", result
        job.baked = {"done": 660, "total": 660, "at": 1}
        job.bake_left = {"sec": 0, "at": 1}
        projects_mod._render_jobs[PID] = job
        out = asyncio.run(render_status(PID, project_dir=tmp_path))
        assert "baked" not in out and "bakeLeft" not in out, status
