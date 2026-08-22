"""Output-name and cover-frame support for the render endpoint.

Two independent additions to the optional POST /projects/{id}/render JSON body:
  - `name`: overrides the output basename — output/<name>.mp4 instead of the
    default output/<projectname>.mp4. Sanitized to a safe basename that can
    never escape output/ (no path separators, no traversal).
  - `cover`: a project-timeline timestamp in seconds. After a successful
    render, ffmpeg pulls that frame into a sidecar output/<name>.jpg. This is
    best-effort: any extraction failure is swallowed and never flips the
    render job to "error".

Mirrors the `_setup_video_project` harness and `_FakeProc`/`_FakeStream`
mocking style from test_render_async.py / test_render_detach.py.
"""
import asyncio
from pathlib import Path

import pytest

import serve.routes.projects as projects_mod
from serve.routes.projects import (
    _RenderJob,
    _run_render_detached,
    _sanitize_output_name,
    render_project,
)

PID = "55555555-5555-4555-8555-555555555555"


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

    async def communicate(self):
        self.waited = True
        return b"", b""


def _patch_spawn_sequence(monkeypatch, procs):
    """Return successive fake procs for successive create_subprocess_exec
    calls (first call = the render process, second = the ffmpeg cover
    extraction, if any), recording the argv of each call."""
    calls = []
    queue = list(procs)

    async def _fake_exec(*args, **kwargs):
        calls.append(list(args))
        return queue.pop(0)

    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", _fake_exec)
    return calls


def _reserve(job):
    projects_mod._render_jobs[PID] = job
    projects_mod._active_renders.add(PID)


# ---------------------------------------------------------------------------
# _sanitize_output_name
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    ("My Movie", "My Movie"),
    ("My Movie.mp4", "My Movie"),
    ("archive.tar.gz", "archive.tar"),
    ("../../etc/passwd", "passwd"),
    ("a/b", "b"),
    ("weird*name", "weirdname"),
    ("..", "fallback"),
    ("***", "fallback"),
    ("", "fallback"),
    ("   ", "fallback"),
])
def test_sanitize_output_name(raw, expected):
    assert _sanitize_output_name(raw, "fallback") == expected


# ---------------------------------------------------------------------------
# _run_render_detached: cover-frame extraction
# ---------------------------------------------------------------------------

def test_cover_extraction_invokes_ffmpeg_with_seek_and_paths(monkeypatch, tmp_path):
    render_proc = _FakeProc(stdout_blob=b"/out/render.mp4\n", returncode=0)
    cover_proc = _FakeProc(returncode=0)
    calls = _patch_spawn_sequence(monkeypatch, [render_proc, cover_proc])
    monkeypatch.setattr(projects_mod, "ffmpeg_bin", lambda: "/usr/bin/ffmpeg")

    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"
    output_path = tmp_path / "output" / "my-video.mp4"

    asyncio.run(_run_render_detached(
        PID, ["node", "render.js"], {}, pp, pp, job,
        cover=12.5, output_path=output_path,
    ))

    assert job.status == "done"
    assert len(calls) == 2  # render process, then the ffmpeg cover extraction
    cover_cmd = calls[1]
    assert cover_cmd[0] == "/usr/bin/ffmpeg"
    assert cover_cmd[cover_cmd.index("-ss") + 1] == "12.5"
    assert cover_cmd[cover_cmd.index("-i") + 1] == str(output_path)
    assert cover_cmd[-1] == str(output_path.with_suffix(".jpg"))
    # -ss must precede -i for a fast seek
    assert cover_cmd.index("-ss") < cover_cmd.index("-i")


def test_cover_extraction_failure_is_swallowed(monkeypatch, tmp_path):
    render_proc = _FakeProc(stdout_blob=b"/out/render.mp4\n", returncode=0)
    cover_proc = _FakeProc(returncode=1)  # ffmpeg fails
    _patch_spawn_sequence(monkeypatch, [render_proc, cover_proc])
    monkeypatch.setattr(projects_mod, "ffmpeg_bin", lambda: "/usr/bin/ffmpeg")

    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"
    output_path = tmp_path / "output" / "my-video.mp4"

    asyncio.run(_run_render_detached(
        PID, ["node", "render.js"], {}, pp, pp, job,
        cover=3, output_path=output_path,
    ))

    assert job.status == "done"  # cover failure must not flip the render to error
    assert job.result == "/out/render.mp4"


def test_cover_extraction_spawn_error_is_swallowed(monkeypatch, tmp_path):
    render_proc = _FakeProc(stdout_blob=b"/out/render.mp4\n", returncode=0)
    calls = []

    async def _fake_exec(*args, **kwargs):
        calls.append(list(args))
        if len(calls) == 1:
            return render_proc
        raise OSError("ffmpeg not found")

    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", _fake_exec)
    monkeypatch.setattr(projects_mod, "ffmpeg_bin", lambda: "/usr/bin/ffmpeg")

    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"
    output_path = tmp_path / "output" / "my-video.mp4"

    asyncio.run(_run_render_detached(
        PID, ["node", "render.js"], {}, pp, pp, job,
        cover=3, output_path=output_path,
    ))

    assert job.status == "done"


def test_no_cover_means_no_ffmpeg_call(monkeypatch, tmp_path):
    render_proc = _FakeProc(stdout_blob=b"/out/render.mp4\n", returncode=0)
    calls = _patch_spawn_sequence(monkeypatch, [render_proc])

    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"

    asyncio.run(_run_render_detached(PID, ["node", "render.js"], {}, pp, pp, job))

    assert job.status == "done"
    assert len(calls) == 1  # only the render process was spawned


def test_failed_render_skips_cover_extraction(monkeypatch, tmp_path):
    render_proc = _FakeProc(stderr_lines=[b"boom\n"], returncode=2)
    calls = _patch_spawn_sequence(monkeypatch, [render_proc])

    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"
    output_path = tmp_path / "output" / "my-video.mp4"

    asyncio.run(_run_render_detached(
        PID, ["node", "render.js"], {}, pp, pp, job,
        cover=5, output_path=output_path,
    ))

    assert job.status == "error"
    assert len(calls) == 1  # cover extraction never attempted on a failed render


# ---------------------------------------------------------------------------
# render_project route: name/cover parsing and threading
# ---------------------------------------------------------------------------

class _FakeRequest:
    def __init__(self, query, body=None):
        self.query_params = query
        self._body = body

    async def is_disconnected(self):
        return False

    async def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


def _setup_video_project(tmp_path, monkeypatch):
    """Make render_project's non-carousel path runnable without a real subprocess."""
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    (project_dir / "project.json").write_text('{"projectType": "video", "name": "My Reel"}')

    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "render.js").write_text("// stub")
    monkeypatch.setattr(projects_mod, "render_runtime_dir", lambda: str(runtime))
    monkeypatch.setattr(projects_mod.shutil, "which", lambda b: "/usr/bin/node")

    captured = {}

    async def _fake_detached(project_id, cmd, env, render_input, project_path, job, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs

    monkeypatch.setattr(projects_mod, "_run_render_detached", _fake_detached)
    return project_dir, captured


def test_name_in_body_sets_output_filename(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={"name": "Highlight Reel"})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    cmd = captured["cmd"]
    out_path = cmd[cmd.index("--out") + 1]
    assert out_path == str(project_dir / "output" / "Highlight Reel.mp4")


def test_absent_name_keeps_default_output_filename(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    cmd = captured["cmd"]
    out_path = cmd[cmd.index("--out") + 1]
    assert out_path == str(project_dir / "output" / f"{project_dir.name}.mp4")


def test_name_sanitized_never_escapes_output_dir(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={"name": "../../etc/passwd"})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    cmd = captured["cmd"]
    out_path = Path(cmd[cmd.index("--out") + 1])
    assert out_path.parent == project_dir / "output"
    assert out_path.name == "passwd.mp4"


def test_odd_name_sanitized_never_escapes_output_dir(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={"name": "a/b"})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    cmd = captured["cmd"]
    out_path = Path(cmd[cmd.index("--out") + 1])
    assert out_path.parent == project_dir / "output"
    assert out_path.name == "b.mp4"


def test_cover_in_body_is_threaded_to_detached_worker(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={"name": "clip", "cover": 4.2})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    kwargs = captured["kwargs"]
    assert kwargs["cover"] == 4.2
    assert kwargs["output_path"] == project_dir / "output" / "clip.mp4"


def test_absent_cover_passes_none_to_detached_worker(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={"name": "clip"})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    assert captured["kwargs"]["cover"] is None


def test_negative_cover_ignored(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={"cover": -1})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    assert captured["kwargs"]["cover"] is None


def test_non_numeric_cover_ignored(tmp_path, monkeypatch):
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={"cover": "soon"})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    assert captured["kwargs"]["cover"] is None


def test_integer_cover_zero_is_accepted(tmp_path, monkeypatch):
    # cover=0 is a legitimate poster frame (first frame) — must not be treated
    # as falsy/absent.
    project_dir, captured = _setup_video_project(tmp_path, monkeypatch)
    req = _FakeRequest({"async": "1"}, body={"cover": 0})

    asyncio.run(render_project(PID, req, project_dir=project_dir))

    assert captured["kwargs"]["cover"] == 0
