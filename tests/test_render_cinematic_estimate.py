"""POST /projects/{id}/render/cinematic-estimate (3D36): how long the path-traced
3D look would take, from a 2-frame test.

The route takes POST /render's body plus an optional `look3dQuality`, runs
``render.js --cinematic-test`` with the render's own arguments, and returns its
JSON. It never runs beside a render (it uses the GPU), and every failure is a
200 ``{"cinematic": null, "error": ...}`` carrying render.js's code when it gave
one. render.js is stubbed, as in test_render_estimate.py.
"""
import asyncio
import json

import pytest
from fastapi import HTTPException

import serve.routes.projects as projects_mod
from serve.routes.projects import render_cinematic_estimate

from tests.test_render_estimate import PID, _EstimateProc, _FakeRequest, _project, _spawn  # noqa: F401

CINEMATIC = {
    "cinematic": {
        "frames": 360, "shots": 1, "secondsPerFrame": 19.6, "seconds": 7056,
        "lowerSeconds": 6900, "upperSeconds": 7200,
        "testFrames": [{"frame": 0, "ms": 19200}, {"frame": 180, "ms": 20000}], "testSeconds": 71,
    },
}


@pytest.fixture(autouse=True)
def _clean_state():
    projects_mod._active_renders.clear()
    yield
    projects_mod._active_renders.clear()


def _run(project_dir, body=None):
    return asyncio.run(render_cinematic_estimate(PID, _FakeRequest(body), project_dir=project_dir))


def test_returns_the_tests_json_with_the_renders_argv(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    calls = _spawn(monkeypatch, _EstimateProc(stdout=b"cinematic test: ...\n" + json.dumps(CINEMATIC).encode() + b"\n"))

    out = _run(project_dir, {"name": "Forest", "look3dQuality": "high"})

    assert out == CINEMATIC
    argv = calls[0]["argv"]
    assert "--cinematic-test" in argv and "--estimate" not in argv
    assert argv[argv.index("--look3d-quality") + 1] == "high"
    assert argv[argv.index("--out") + 1] == str(project_dir / "output" / "Forest.mp4")
    assert calls[0]["kwargs"]["env"]["MONTAJ_ROOT"] == str(projects_mod.MONTAJ_ROOT)


def test_no_quality_asks_at_the_projects_own(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    calls = _spawn(monkeypatch, _EstimateProc(stdout=json.dumps(CINEMATIC).encode()))
    _run(project_dir, {})
    assert "--look3d-quality" not in calls[0]["argv"]


def test_a_bad_quality_is_422(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    _spawn(monkeypatch, _EstimateProc(stdout=json.dumps(CINEMATIC).encode()))
    with pytest.raises(HTTPException) as e:
        _run(project_dir, {"look3dQuality": "../High"})
    assert e.value.status_code == 422


def test_never_beside_a_render(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    calls = _spawn(monkeypatch, _EstimateProc(stdout=json.dumps(CINEMATIC).encode()))
    projects_mod._active_renders.add("someone-else")
    out = _run(project_dir, {})
    assert out == {"cinematic": None, "error": "a render is running", "code": "render_running"}
    assert calls == []


def test_no_renderer_installed_says_cinematic_unavailable(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    err = json.dumps({"error": "cinematic_unavailable", "message": "The path-traced renderer is not available on this machine."})
    _spawn(monkeypatch, _EstimateProc(stderr=err.encode() + b"\n", returncode=1))
    out = _run(project_dir, {})
    assert out == {"cinematic": None, "error": "The path-traced renderer is not available on this machine.", "code": "cinematic_unavailable"}


def test_unexpected_output_and_carousels_are_no_estimate(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    _spawn(monkeypatch, _EstimateProc(stdout=b'{"cinematic": {"frames": "many"}}\n'))
    assert _run(project_dir, {}) == {"cinematic": None, "error": "render.js --cinematic-test printed no estimate"}

    (tmp_path / "c").mkdir()
    carousel = _project(tmp_path / "c", monkeypatch, {"projectType": "carousel"})
    calls = _spawn(monkeypatch, _EstimateProc(stdout=json.dumps(CINEMATIC).encode()))
    assert _run(carousel, {}) == {"cinematic": None}
    assert calls == []


def test_a_test_past_its_time_is_killed(tmp_path, monkeypatch):
    project_dir = _project(tmp_path, monkeypatch)
    proc = _EstimateProc(stdout=json.dumps(CINEMATIC).encode(), delay=0.2)
    _spawn(monkeypatch, proc)
    monkeypatch.setattr(projects_mod, "_CINEMATIC_TEST_TIMEOUT_S", 0.05)
    out = _run(project_dir, {})
    assert out["cinematic"] is None and "longer than" in out["error"]
    assert proc.killed
