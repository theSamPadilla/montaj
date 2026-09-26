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


# --- initSettings: the top-level block that carries resolution + the three flags
# plumbed for the clips fan-out. Each behaviour is pinned by its own test so that
# no one of them can mask another — in particular the precedence rule, which is the
# one that would rot silently if it only ever rode along with another assertion.


def _clip(tmp_path):
    c = tmp_path / "clip.mp4"
    c.write_bytes(b"fake")
    return str(c)


def test_init_settings_resolution_alone(tmp_path, init_spy, capsys):
    """initSettings.resolution works on its own, and says nothing while doing it."""
    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "clean_cut", "clips": [_clip(tmp_path)],
        "initSettings": {"resolution": "1080x1920"},
    })
    assert resp.status_code == 201, resp.text
    cmd = init_spy["cmd"]
    assert cmd[cmd.index("--resolution") + 1] == "1080x1920"
    # Correct usage must not emit the deprecation notice.
    assert "DEPRECATED" not in capsys.readouterr().out


def test_ai_video_intake_resolution_still_works_and_warns(tmp_path, init_spy, capsys):
    """The legacy spelling keeps working — montaj's own UI sends it — and logs."""
    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "clean_cut", "clips": [_clip(tmp_path)],
        "aiVideoIntake": {"resolution": "1920x1080"},
    })
    assert resp.status_code == 201, resp.text
    cmd = init_spy["cmd"]
    assert cmd[cmd.index("--resolution") + 1] == "1920x1080"
    out = capsys.readouterr().out
    assert "DEPRECATED" in out
    assert "aiVideoIntake.resolution" in out
    assert "initSettings.resolution" in out  # names the replacement, not just the sin


def test_init_settings_resolution_beats_ai_video_intake(tmp_path, init_spy, capsys):
    """Precedence: both present -> initSettings wins, and only once."""
    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "clean_cut", "clips": [_clip(tmp_path)],
        "initSettings": {"resolution": "1080x1920"},
        "aiVideoIntake": {"resolution": "1920x1080"},
    })
    assert resp.status_code == 201, resp.text
    cmd = init_spy["cmd"]
    assert cmd.count("--resolution") == 1, "the losing spelling must not also append"
    assert cmd[cmd.index("--resolution") + 1] == "1080x1920"
    # The legacy key did NOT supply the value, so there is nothing to deprecate.
    assert "DEPRECATED" not in capsys.readouterr().out


def test_init_settings_forwards_normalize(tmp_path, init_spy):
    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "clean_cut", "clips": [_clip(tmp_path)],
        "initSettings": {"normalize": "lazy"},
    })
    assert resp.status_code == 201, resp.text
    cmd = init_spy["cmd"]
    assert cmd[cmd.index("--normalize") + 1] == "lazy"


def test_init_settings_rejects_unknown_normalize(tmp_path, init_spy):
    """400 naming the field, rather than an opaque nonzero exit from argparse."""
    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "clean_cut", "clips": [_clip(tmp_path)],
        "initSettings": {"normalize": "sometimes"},
    })
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["error"] != "clips_required"
    assert "normalize" in detail["message"]
    assert "cmd" not in init_spy  # rejected before init was ever spawned


def test_init_settings_forwards_symlink_clips(tmp_path, init_spy):
    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "clean_cut", "clips": [_clip(tmp_path)],
        "initSettings": {"symlinkClips": True},
    })
    assert resp.status_code == 201, resp.text
    assert "--symlink-clips" in init_spy["cmd"]


def test_init_settings_symlink_clips_false_appends_nothing(tmp_path, init_spy):
    """store_true downstream: false must omit the flag, not pass a value."""
    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "clean_cut", "clips": [_clip(tmp_path)],
        "initSettings": {"symlinkClips": False},
    })
    assert resp.status_code == 201, resp.text
    assert "--symlink-clips" not in init_spy["cmd"]


def test_init_settings_forwards_derived_from(tmp_path, init_spy):
    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "clean_cut", "clips": [_clip(tmp_path)],
        "initSettings": {"derivedFrom": "e3f1c0de-0000-4000-8000-000000000001"},
    })
    assert resp.status_code == 201, resp.text
    cmd = init_spy["cmd"]
    assert cmd[cmd.index("--derived-from") + 1] == "e3f1c0de-0000-4000-8000-000000000001"


def test_init_settings_rejects_unknown_key(tmp_path, init_spy):
    """A typo must be loud. Silent acceptance is the failure this block exists to stop."""
    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "clean_cut", "clips": [_clip(tmp_path)],
        "initSettings": {"normalise": "lazy"},
    })
    assert resp.status_code == 400
    assert "normalise" in resp.json()["detail"]["message"]
    assert "cmd" not in init_spy


def test_absent_init_settings_changes_nothing(tmp_path, init_spy):
    """The whole block absent appends none of the four caller flags. The one
    thing serve adds of its own is `--normalize lazy`: with no mode chosen by
    the caller or the workflow, init skips the colour conversion and serve runs
    it in the background (see serve/routes/projects.py `_ensure_background_normalize`)."""
    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "clean_cut", "clips": [_clip(tmp_path)],
    })
    assert resp.status_code == 201, resp.text
    cmd = init_spy["cmd"]
    for flag in ("--resolution", "--symlink-clips", "--derived-from"):
        assert flag not in cmd
    assert cmd.count("--normalize") == 1
    assert cmd[cmd.index("--normalize") + 1] == "lazy"


def test_explicit_eager_is_not_turned_into_background(tmp_path, init_spy):
    """A caller that asks for eager gets eager: converted inline, no lazy flag."""
    resp = client.post("/api/run", json={
        "prompt": "p", "workflow": "clean_cut", "clips": [_clip(tmp_path)],
        "initSettings": {"normalize": "eager"},
    })
    assert resp.status_code == 201, resp.text
    cmd = init_spy["cmd"]
    assert cmd.count("--normalize") == 1
    assert cmd[cmd.index("--normalize") + 1] == "eager"
