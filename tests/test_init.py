"""Tests for project/init.py project creation — v0.2 unified tracks schema."""
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


def test_normal_project_has_tracks(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--clips", str(clip), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    assert "tracks" in project
    assert "base_track" not in project
    assert "visual_tracks" not in project


def test_normal_project_tracks_has_one_track(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--clips", str(clip), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    assert len(project["tracks"]) == 1


def test_normal_project_clip_in_primary_track(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--clips", str(clip), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    primary = project["tracks"][0]
    assert len(primary) == 1
    item = primary[0]
    assert item["id"] == "clip-0"
    assert item["type"] == "video"
    assert item["src"].endswith("clip.mp4")
    assert "start" in item
    assert "end" in item


def test_normal_project_version_is_0_2(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--clips", str(clip), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    assert project["version"] == "0.2"


def test_canvas_project_has_empty_primary_track(tmp_path):
    result = run_init("--canvas", "--prompt", "test", "--workflow", "canvas",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    assert project["tracks"] == [[]]


def test_canvas_and_clips_are_mutually_exclusive(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--canvas", "--clips", str(clip), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode != 0
    err = json.loads(result.stderr)
    assert err["error"] == "mutually_exclusive"


def test_multiple_clips_all_in_primary_track(tmp_path):
    clip1 = tmp_path / "a.mp4"
    clip2 = tmp_path / "b.mp4"
    clip1.write_bytes(b"fake")
    clip2.write_bytes(b"fake")
    result = run_init("--clips", str(clip1), str(clip2), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    primary = project["tracks"][0]
    assert len(primary) == 2
    assert primary[0]["id"] == "clip-0"
    assert primary[1]["id"] == "clip-1"
