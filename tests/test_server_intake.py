"""Tests for /api/run aiVideoIntake validation in serve/server.py."""
import json

import pytest
from starlette.testclient import TestClient

import serve.routes.projects as projects_mod
from serve.server import app

client = TestClient(app, raise_server_exceptions=False)


class _CapturedProc:
    """Minimal stand-in for the init subprocess: succeeds, emits a project path."""
    def __init__(self, project_json):
        self.returncode = 0
        self._out = f"{project_json}\n".encode()

    async def communicate(self):
        return self._out, b""

    async def wait(self):
        return 0

    def kill(self):  # only reached on the timeout path; present so it can't AttributeError
        pass


@pytest.fixture
def init_spy(monkeypatch, tmp_path):
    """Capture the argv that /api/run would hand to project/init.py."""
    project_json = tmp_path / "proj" / "project.json"
    project_json.parent.mkdir(parents=True, exist_ok=True)
    project_json.write_text(json.dumps({"version": "0.2", "id": "x", "status": "pending"}))

    captured = {}

    async def _fake_exec(*args, **kwargs):
        captured["cmd"] = list(args)
        return _CapturedProc(project_json)

    monkeypatch.setattr(projects_mod.asyncio, "create_subprocess_exec", _fake_exec)
    return captured


def test_image_ref_missing_both_path_and_text():
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "clean_cut",
        "clips": [],
        "aiVideoIntake": {
            "imageRefs": [{"label": "Max"}],
            "styleRefs": [],
        },
    })
    assert resp.status_code == 400
    assert "exactly one" in resp.json()["detail"]["message"]


def test_image_ref_has_both_path_and_text():
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "clean_cut",
        "clips": [],
        "aiVideoIntake": {
            "imageRefs": [{"label": "Max", "path": "/tmp/x.png", "text": "a dog"}],
            "styleRefs": [],
        },
    })
    assert resp.status_code == 400
    assert "exactly one" in resp.json()["detail"]["message"]


def test_style_ref_missing_path():
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "clean_cut",
        "clips": [],
        "aiVideoIntake": {
            "imageRefs": [],
            "styleRefs": [{"label": "mood"}],
        },
    })
    assert resp.status_code == 400
    assert "requires 'path'" in resp.json()["detail"]["message"]


def test_too_many_style_refs():
    resp = client.post("/api/run", json={
        "prompt": "test",
        "workflow": "clean_cut",
        "clips": [],
        "aiVideoIntake": {
            "imageRefs": [],
            "styleRefs": [
                {"label": "a", "path": "/tmp/a.mp4"},
                {"label": "b", "path": "/tmp/b.mp4"},
                {"label": "c", "path": "/tmp/c.mp4"},
            ],
        },
    })
    assert resp.status_code == 400
    assert "at most 2" in resp.json()["detail"]["message"]


def test_run_forwards_voiceover_asset(tmp_path, init_spy):
    # broll is requires_clips:true — a real clip is required to get past that
    # gate before the voiceoverAsset forwarding logic under test even runs.
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    vo = tmp_path / "vo.wav"
    vo.write_bytes(b"RIFF....WAVEfake")
    resp = client.post("/api/run", json={
        "workflow": "broll",
        "prompt": "make a b-roll cut",
        "clips": [str(clip)],
        "voiceoverAsset": str(vo),
    })
    assert resp.status_code == 201, resp.text
    cmd = init_spy["cmd"]
    assert "--voiceover-asset" in cmd
    assert cmd[cmd.index("--voiceover-asset") + 1] == str(vo)


def test_run_rejects_missing_voiceover_file(tmp_path, init_spy):
    # A real clip is provided so the request would otherwise sail through to
    # the (mocked) init subprocess — without it, this 400 could come from the
    # unrelated clips_required gate and would prove nothing about voiceoverAsset
    # validation. The assertion pins the rejection to voiceoverAsset specifically.
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    resp = client.post("/api/run", json={
        "workflow": "broll",
        "prompt": "make a b-roll cut",
        "clips": [str(clip)],
        "voiceoverAsset": "/nonexistent/vo.wav",
    })
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["error"] != "clips_required"
    assert "voiceoverAsset" in detail["message"]
    assert "cmd" not in init_spy  # rejected before the init subprocess was ever spawned


def test_run_without_voiceover_asset_is_unchanged(tmp_path, init_spy):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    resp = client.post("/api/run", json={
        "workflow": "clean_cut", "prompt": "clean it", "clips": [str(clip)],
    })
    assert resp.status_code == 201, resp.text
    assert "--voiceover-asset" not in init_spy["cmd"]


def test_run_forwards_multiple_voiceover_assets(tmp_path, init_spy):
    """voiceoverAssets forwards every path, in order, to --voiceover-asset."""
    takes = []
    for n in ("a", "b", "c"):
        p = tmp_path / f"{n}.mov"
        p.write_bytes(b"x")
        takes.append(str(p))
    clip = tmp_path / "clip.mov"
    clip.write_bytes(b"x")

    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "broll",
        "clips": [str(clip)], "voiceoverAssets": takes,
    })
    assert resp.status_code == 201, resp.text
    cmd = init_spy["cmd"]
    i = cmd.index("--voiceover-asset")
    assert cmd[i + 1:i + 4] == takes


def test_run_rejects_missing_file_in_voiceover_assets(tmp_path, init_spy):
    good = tmp_path / "a.mov"
    good.write_bytes(b"x")
    clip = tmp_path / "clip.mov"
    clip.write_bytes(b"x")

    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "broll", "clips": [str(clip)],
        "voiceoverAssets": [str(good), str(tmp_path / "nope.mov")],
    })
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "nope.mov" in detail["message"]
    assert "cmd" not in init_spy


def test_run_still_accepts_singular_voiceover_asset(tmp_path, init_spy):
    """Back-compat: the old singular field keeps working unchanged."""
    vo = tmp_path / "vo.mov"
    vo.write_bytes(b"x")
    clip = tmp_path / "clip.mov"
    clip.write_bytes(b"x")

    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "broll",
        "clips": [str(clip)], "voiceoverAsset": str(vo),
    })
    assert resp.status_code == 201, resp.text
    cmd = init_spy["cmd"]
    i = cmd.index("--voiceover-asset")
    assert cmd[i + 1] == str(vo)
