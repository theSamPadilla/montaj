"""POST /projects/{id}/render/estimate (§213): the disk a render would need,
asked before it starts.

The route takes POST /render's body (plus optional `resolution`/`fps` stand-ins
for unsaved settings), runs ``render.js --estimate`` with the render's own
arguments, and returns its JSON. It writes nothing, never touches the render
slot, and answers 200 ``{"estimate": null, "volumes": []}`` (with an `error`)
when it cannot estimate. render.js is stubbed: create_subprocess_exec hands
back a fake process, the `_FakeProc` style of test_render_name_cover.py.
"""
import asyncio
import json

import pytest
from fastapi import HTTPException

import serve.routes.projects as projects_mod
from serve.routes.projects import render_estimate, render_project

PID = "66666666-6666-4666-8666-666666666666"

ESTIMATE = {
    "estimate": {
        "lower": {"tmpBytes": 66_000_000, "projectBytes": 150_000_000},
        "expected": {"tmpBytes": 132_000_000, "projectBytes": 8_470_000_000},
    },
    "volumes": [{"path": "/w/proj/render", "needBytes": 8_602_000_000, "freeBytes": 4_700_000_000}],
}


@pytest.fixture(autouse=True)
def _clean_state():
    for s in (projects_mod._active_renders, projects_mod._render_procs,
              projects_mod._render_jobs, projects_mod._render_task_refs):
        s.clear()
    yield
    for s in (projects_mod._active_renders, projects_mod._render_procs,
              projects_mod._render_jobs, projects_mod._render_task_refs):
        s.clear()


class _FakeRequest:
    def __init__(self, body=None, query=None):
        self.query_params = query or {}
        self._body = body

    async def is_disconnected(self):
        return False

    async def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


class _EstimateProc:
    """render.js --estimate: `communicate()` returns (stdout, stderr) once it exits."""
    def __init__(self, stdout=b"", stderr=b"", returncode=0, delay=0.0):
        self._out = stdout
        self._err = stderr
        self.returncode = returncode
        self._delay = delay
        self.killed = False

    async def communicate(self):
        if self._delay:
            await asyncio.sleep(self._delay)
        return self._out, self._err

    def kill(self):
        self.killed = True

    async def wait(self):
        return self.returncode


def _project(tmp_path, monkeypatch, project=None):
    """A project dir, a stub render.js runtime and node on PATH."""
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    text = json.dumps(project if project is not None else {"projectType": "video", "name": "My Reel"})
    (project_dir / "project.json").write_text(text)

    runtime = tmp_path / "runtime"
    runtime.mkdir()
    (runtime / "render.js").write_text("// stub")
    monkeypatch.setattr(projects_mod, "render_runtime_dir", lambda: str(runtime))
    monkeypatch.setattr(projects_mod.shutil, "which", lambda b: "/usr/bin/node")
    return project_dir


def _spawn(monkeypatch, proc_or_exc):
    """Every create_subprocess_exec gets `proc_or_exc` (or raises it); argv recorded."""
    calls = []

    async def _fake_exec(*args, **kwargs):
        calls.append({"argv": list(args), "kwargs": kwargs})
        if isinstance(proc_or_exc, BaseException):
            raise proc_or_exc
        return proc_or_exc

    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", _fake_exec)
    return calls


def _ok():
    return _EstimateProc(stdout=json.dumps(ESTIMATE).encode() + b"\n")


def _estimate(project_dir, body=None):
    return asyncio.run(render_estimate(PID, _FakeRequest(body), project_dir=project_dir))


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------

def test_returns_render_js_estimate_json(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    calls = _spawn(monkeypatch, _ok())

    out = _estimate(project_dir, {"export": "both", "name": "Highlight Reel"})

    assert out == ESTIMATE
    argv = calls[0]["argv"]
    assert argv[0] == "/usr/bin/node"
    assert argv[1] == str(tmp_path / "runtime" / "render.js")
    assert "--estimate" in argv
    assert argv[argv.index("--out") + 1] == str(project_dir / "output" / "Highlight Reel.mp4")
    assert argv[argv.index("--export") + 1] == "both"
    # The render's own environment and working directory.
    kwargs = calls[0]["kwargs"]
    assert kwargs["cwd"] == str(projects_mod.MONTAJ_ROOT)
    assert kwargs["env"]["MONTAJ_ROOT"] == str(projects_mod.MONTAJ_ROOT)
    assert "MONTAJ_PYTHON" in kwargs["env"] and "MONTAJ_FFPROBE" in kwargs["env"]


def test_argv_is_the_renders_argv_plus_estimate(tmp_path, monkeypatch):
    """The same body plans the same render: one shared builder, not a copy."""
    project_dir = _project(tmp_path, monkeypatch)
    sdr_curve = projects_mod.curve_ids()[0]
    body = {"export": "sdr", "sdrCurve": sdr_curve, "name": "clip", "cover": 2}

    captured = {}

    async def _fake_detached(project_id, cmd, env, render_input, project_path, job, **kwargs):
        captured["cmd"] = cmd

    monkeypatch.setattr(projects_mod, "_run_render_detached", _fake_detached)
    asyncio.run(render_project(PID, _FakeRequest(body, query={"async": "1"}), project_dir=project_dir))
    projects_mod._active_renders.clear()
    projects_mod._render_jobs.clear()

    calls = _spawn(monkeypatch, _ok())
    _estimate(project_dir, body)

    assert calls[0]["argv"] == captured["cmd"] + ["--estimate"]


def test_the_pictures_colour_space_rides_on_the_answer(tmp_path, monkeypatch):
    """§378: render.js says which colour the picture needs; serve passes it on for the export window."""
    project_dir = _project(tmp_path, monkeypatch)
    payload = {**ESTIMATE, "colorSpace": "sdr_bt709", "hdrVisible": False}
    _spawn(monkeypatch, _EstimateProc(stdout=json.dumps(payload).encode() + b"\n"))
    out = _estimate(project_dir)
    assert out == {**ESTIMATE, "colorSpace": "sdr_bt709", "hdrVisible": False}
    # An older render.js says nothing: the answer is as before.
    _spawn(monkeypatch, _ok())
    assert _estimate(project_dir) == ESTIMATE


def test_writes_nothing(tmp_path, monkeypatch):
    """No output/ dir, no git snapshot, no colour-provenance heal, project.json as it was."""
    project_dir = _project(tmp_path, monkeypatch)
    before = (project_dir / "project.json").read_bytes()
    _spawn(monkeypatch, _ok())

    def _boom(*a, **k):
        raise AssertionError("the estimate must not write")

    monkeypatch.setattr(projects_mod, "_git_commit_sync", _boom)
    monkeypatch.setattr(projects_mod, "ensure_project_color_provenance", _boom)

    _estimate(project_dir, {"name": "x", "resolution": [2160, 3840], "fps": 60})

    assert not (project_dir / "output").exists()
    assert sorted(p.name for p in project_dir.iterdir()) == ["project.json"]
    assert (project_dir / "project.json").read_bytes() == before


def test_never_takes_or_supersedes_the_render_slot(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    running = object()
    projects_mod._render_procs[PID] = running
    projects_mod._active_renders.add(PID)
    killed = []
    monkeypatch.setattr(projects_mod, "_kill_render_proc", lambda p: killed.append(p))
    _spawn(monkeypatch, _ok())

    out = _estimate(project_dir, {})

    assert out == ESTIMATE, "an estimate during a render still answers"
    assert killed == []
    assert projects_mod._render_procs == {PID: running}
    assert projects_mod._active_renders == {PID}
    assert PID not in projects_mod._render_jobs


def test_carousel_has_no_estimate(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch, {"projectType": "carousel"})
    calls = _spawn(monkeypatch, _ok())

    assert _estimate(project_dir, {}) == {"estimate": None, "volumes": []}
    assert calls == []


def test_bad_export_or_curve_is_the_renders_422(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    calls = _spawn(monkeypatch, _ok())
    for body in ({"export": "hdr"}, {"sdrCurve": "no-such-curve"}):
        with pytest.raises(HTTPException) as exc:
            _estimate(project_dir, body)
        assert exc.value.status_code == 422
    assert calls == []


def test_no_body_or_a_non_object_body_is_the_default_render(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    for body in (None, [], "both"):
        calls = _spawn(monkeypatch, _ok())
        assert _estimate(project_dir, body) == ESTIMATE
        argv = calls[0]["argv"]
        assert argv[argv.index("--out") + 1] == str(project_dir / "output" / f"{project_dir.name}.mp4")
        assert "--export" not in argv and "--resolution" not in argv


# ---------------------------------------------------------------------------
# resolution / fps stand-ins (never written)
# ---------------------------------------------------------------------------

def test_resolution_is_passed_as_an_override(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    calls = _spawn(monkeypatch, _ok())
    _estimate(project_dir, {"resolution": [2160, 3840]})
    argv = calls[0]["argv"]
    assert argv[argv.index("--resolution") + 1] == "2160x3840"
    assert argv.index("--resolution") > argv.index("--estimate")


@pytest.mark.parametrize("bad", [
    [2160], [2160, 3840, 1], [0, 1920], [-1080, 1920], [1080.5, 1920], ["1080", "1920"],
    [True, 1920], "2160x3840", {"w": 1080, "h": 1920}, None,
])
def test_malformed_resolution_is_ignored(tmp_path, monkeypatch, bad):
    project_dir = _project(tmp_path, monkeypatch)
    calls = _spawn(monkeypatch, _ok())
    assert _estimate(project_dir, {"resolution": bad}) == ESTIMATE
    assert "--resolution" not in calls[0]["argv"]


@pytest.mark.parametrize("fps,arg", [(30, "30"), (60, "60"), (29.97, "29.97"), (24.0, "24.0")])
def test_fps_is_passed_as_an_override(tmp_path, monkeypatch, fps, arg):
    project_dir = _project(tmp_path, monkeypatch)
    calls = _spawn(monkeypatch, _ok())
    _estimate(project_dir, {"fps": fps})
    argv = calls[0]["argv"]
    assert argv[argv.index("--fps") + 1] == arg


@pytest.mark.parametrize("bad", [0, -30, "30", True, None, float("inf"), float("nan"), [30]])
def test_malformed_fps_is_ignored(tmp_path, monkeypatch, bad):
    project_dir = _project(tmp_path, monkeypatch)
    calls = _spawn(monkeypatch, _ok())
    assert _estimate(project_dir, {"fps": bad}) == ESTIMATE
    assert "--fps" not in calls[0]["argv"]


# ---------------------------------------------------------------------------
# No estimate: 200, never a 500
# ---------------------------------------------------------------------------

def test_render_js_failure_is_no_estimate_with_its_message(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    line = json.dumps({"error": "missing_files", "message": "Referenced files not found:\n  /w/a.mov"})
    _spawn(monkeypatch, _EstimateProc(stderr=b"[montaj render] reading\n" + line.encode() + b"\n", returncode=1))

    out = _estimate(project_dir, {})

    assert out == {"estimate": None, "volumes": [], "error": "Referenced files not found:\n  /w/a.mov"}


def test_failure_without_a_json_line_names_the_tail(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    _spawn(monkeypatch, _EstimateProc(stderr=b"node: bad option: --estimate\n", returncode=9))
    out = _estimate(project_dir, {})
    assert out["estimate"] is None and out["volumes"] == []
    assert out["error"] == "node: bad option: --estimate"


@pytest.mark.parametrize("stdout", [b"", b"not json\n", b'{"estimate": 1}\n', b'{"volumes": []}\n',
                                    b'{"estimate": {"lower": {}, "expected": {}}, "volumes": []}\n'])
def test_output_that_is_not_an_estimate_is_no_estimate(tmp_path, monkeypatch, stdout):
    project_dir = _project(tmp_path, monkeypatch)
    _spawn(monkeypatch, _EstimateProc(stdout=stdout))
    out = _estimate(project_dir, {})
    assert out["estimate"] is None and out["volumes"] == [] and out["error"]


def test_spawn_failure_is_no_estimate(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    _spawn(monkeypatch, OSError("too many open files"))
    out = _estimate(project_dir, {})
    assert out["estimate"] is None and "too many open files" in out["error"]


def test_a_slow_estimate_is_killed_and_is_no_estimate(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    proc = _EstimateProc(stdout=json.dumps(ESTIMATE).encode(), delay=5)
    _spawn(monkeypatch, proc)
    monkeypatch.setattr(projects_mod, "_ESTIMATE_TIMEOUT_S", 0.05)
    out = _estimate(project_dir, {})
    assert out["estimate"] is None and "longer than" in out["error"]
    assert proc.killed


def test_missing_runtime_or_node_is_no_estimate(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    calls = _spawn(monkeypatch, _ok())
    (tmp_path / "runtime" / "render.js").unlink()
    out = _estimate(project_dir, {})
    assert out["estimate"] is None and "render.js not found" in out["error"]

    (tmp_path / "runtime" / "render.js").write_text("// stub")
    monkeypatch.setattr(projects_mod.shutil, "which", lambda b: None)
    out = _estimate(project_dir, {})
    assert out["estimate"] is None and "node" in out["error"]
    assert calls == []


def test_unreadable_project_json_is_no_estimate(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    (project_dir / "project.json").write_text("{ not json")
    calls = _spawn(monkeypatch, _ok())
    out = _estimate(project_dir, {})
    assert out["estimate"] is None and out["error"]
    assert calls == []


# ---------------------------------------------------------------------------
# §284: motion blur as a stand-in; each stand-in passed once
# ---------------------------------------------------------------------------

def test_motion_blur_is_passed_as_an_override_and_fps_only_once(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    calls = _spawn(monkeypatch, _ok())
    _estimate(project_dir, {"fps": 30, "motionBlur": 1})
    argv = calls[0]["argv"]
    assert argv.count("--fps") == 1
    assert argv[argv.index("--motion-blur") + 1] == "1"
    assert argv.index("--motion-blur") > argv.index("--estimate")


@pytest.mark.parametrize("bad", [0, 9, 1.5, "1", True])
def test_malformed_motion_blur_is_ignored(tmp_path, monkeypatch, bad):
    project_dir = _project(tmp_path, monkeypatch)
    calls = _spawn(monkeypatch, _ok())
    assert _estimate(project_dir, {"motionBlur": bad}) == ESTIMATE
    assert "--motion-blur" not in calls[0]["argv"]
