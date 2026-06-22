"""Detached-render semantics.

A manual render runs as a background task that is NOT tied to the SSE request that
started it. A dropped connection (the Cloudflare tunnel cuts long-lived streams at
~100s; a multi-minute render outlives it) must therefore NOT abort the render — it
runs to completion, records its output, and releases its slot regardless of whether
any client is still watching. The only way to stop a render is POST /render/cancel.

Covers `_run_render_detached` (the detached worker) and `cancel_render` (explicit
abort). The SSE viewer itself is a thin reader over `_RenderJob` state.
"""
import asyncio
from unittest.mock import Mock

import pytest

import serve.routes.projects as projects_mod
from serve.routes.projects import _RenderJob, _run_render_detached, cancel_render

PID = "33333333-3333-4333-8333-333333333333"


@pytest.fixture(autouse=True)
def _clean_state():
    projects_mod._active_renders.clear()
    projects_mod._render_procs.clear()
    projects_mod._render_jobs.clear()
    yield
    projects_mod._active_renders.clear()
    projects_mod._render_procs.clear()
    projects_mod._render_jobs.clear()


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


def test_detached_render_completes_with_no_viewer_attached(monkeypatch, tmp_path):
    # The crux: nobody is consuming the SSE (a dropped connection is just "no
    # consumer"), yet the render runs to the end and records its output path.
    proc = _FakeProc(
        stderr_lines=[b"[render] bundling 1/2\n", b"[render] bundling 2/2\n"],
        stdout_blob=b"  /scratch/output/render.mp4\n",
        returncode=0,
    )
    _patch_spawn(monkeypatch, proc)
    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"  # render_input == project_path → nothing to unlink

    asyncio.run(_run_render_detached(PID, ["node", "render.js"], {}, pp, pp, job))

    assert job.status == "done"
    assert job.result == "/scratch/output/render.mp4"
    assert job.lines == ["[render] bundling 1/2", "[render] bundling 2/2"]
    assert proc.waited
    # slot + registries released on completion
    assert PID not in projects_mod._active_renders
    assert PID not in projects_mod._render_procs
    assert PID not in projects_mod._render_jobs


def test_detached_render_records_nonzero_exit_as_error(monkeypatch, tmp_path):
    proc = _FakeProc(stderr_lines=[b"boom\n"], returncode=2)
    _patch_spawn(monkeypatch, proc)
    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"

    asyncio.run(_run_render_detached(PID, ["node", "render.js"], {}, pp, pp, job))

    assert job.status == "error"
    assert "exit 2" in job.result
    assert PID not in projects_mod._active_renders  # slot still released on failure


def test_detached_render_surfaces_spawn_failure_as_error(monkeypatch, tmp_path):
    async def _boom(*a, **k):
        raise OSError("node not found")
    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", _boom)
    job = _RenderJob()
    _reserve(job)
    pp = tmp_path / "project.json"

    asyncio.run(_run_render_detached(PID, ["node", "render.js"], {}, pp, pp, job))

    assert job.status == "error"
    assert "node not found" in job.result
    assert PID not in projects_mod._active_renders


def test_detached_render_unlinks_temp_render_input(monkeypatch, tmp_path):
    proc = _FakeProc(stdout_blob=b"/out.mp4\n", returncode=0)
    _patch_spawn(monkeypatch, proc)
    job = _RenderJob()
    _reserve(job)
    project_path = tmp_path / "project.json"
    render_input = tmp_path / "project.render.json"
    render_input.write_text("{}")

    asyncio.run(_run_render_detached(PID, ["node", "r.js"], {}, render_input, project_path, job))

    assert not render_input.exists()  # the temp render-input was cleaned up


def test_detached_render_does_not_clobber_a_superseding_render(monkeypatch, tmp_path):
    # While we run, a newer render takes the slot. Our `finally` must leave the
    # newer render's registry entries and slot intact (the supersede guard).
    newer_proc = Mock(name="newer_proc")
    newer_job = _RenderJob()

    class _SupersedeOnRead(_FakeStream):
        async def read(self):
            projects_mod._render_procs[PID] = newer_proc
            projects_mod._render_jobs[PID] = newer_job
            projects_mod._active_renders.add(PID)
            return b"/out.mp4\n"

    proc = _FakeProc(stdout_blob=b"/out.mp4\n", returncode=0)
    proc.stdout = _SupersedeOnRead()
    _patch_spawn(monkeypatch, proc)
    old_job = _RenderJob()
    _reserve(old_job)
    pp = tmp_path / "project.json"

    asyncio.run(_run_render_detached(PID, ["node", "r.js"], {}, pp, pp, old_job))

    assert projects_mod._render_procs.get(PID) is newer_proc
    assert projects_mod._render_jobs.get(PID) is newer_job
    assert PID in projects_mod._active_renders


def test_cancel_render_kills_the_tracked_proc(monkeypatch):
    killed = []
    monkeypatch.setattr(projects_mod, "_kill_render_proc", killed.append)
    proc = Mock(name="render_proc")
    projects_mod._render_procs[PID] = proc

    assert asyncio.run(cancel_render(PID)) == {"cancelled": True}
    assert killed == [proc]


def test_cancel_render_is_a_noop_when_nothing_is_rendering(monkeypatch):
    monkeypatch.setattr(projects_mod, "_kill_render_proc",
                        lambda p: pytest.fail("must not kill when idle"))

    assert asyncio.run(cancel_render(PID)) == {"cancelled": False}
