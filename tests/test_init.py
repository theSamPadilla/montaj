"""Tests for project/init.py canvas project creation."""
import json, subprocess, sys
from pathlib import Path
import pytest

REPO_ROOT = Path(__file__).parent.parent
INIT_PY   = str(REPO_ROOT / "project" / "init.py")


def run_init(*args, env_override=None):
    import os
    e = {**os.environ, **(env_override or {})}
    return subprocess.run(
        [sys.executable, INIT_PY, *args],
        capture_output=True, text=True, env=e
    )


def test_canvas_creates_project_without_video_track(tmp_path):
    result = run_init("--canvas", "--prompt", "test", "--workflow", "canvas",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    assert not any(t["type"] == "video" for t in project["tracks"])
    assert "overlay_tracks" in project
    assert project["overlay_tracks"] == []


def test_canvas_and_clips_are_mutually_exclusive(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--canvas", "--clips", str(clip), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode != 0
    err = json.loads(result.stderr)
    assert err["error"] == "mutually_exclusive"


def test_normal_project_includes_overlay_tracks(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--clips", str(clip), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    assert "overlay_tracks" in project
    assert project["overlay_tracks"] == []
    assert any(t["type"] == "video" for t in project["tracks"])
