"""Tests for project/init.py project creation — v0.2 unified tracks schema."""
import json, os, subprocess, sys
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


# ---------------------------------------------------------------------------
# projectType propagation tests
# ---------------------------------------------------------------------------

def test_lyrics_video_gets_music_video_type(tmp_path):
    result = run_init("--canvas", "--prompt", "test", "--workflow", "lyrics_video",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    assert project["projectType"] == "music_video"
    assert "storyboard" not in project


def test_clean_cut_defaults_to_editing(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--clips", str(clip), "--prompt", "test", "--workflow", "clean_cut",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    assert project["projectType"] == "editing"
    assert "storyboard" not in project


def test_nonexistent_workflow_defaults_to_editing(tmp_path):
    result = run_init("--canvas", "--prompt", "test", "--workflow", "nonexistent_workflow_xyz",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    assert project["projectType"] == "editing"


def test_ai_video_workflow_gets_storyboard_stub(tmp_path):
    user_wf = Path.home() / ".montaj" / "workflows"
    user_wf.mkdir(parents=True, exist_ok=True)
    user_fixture = user_wf / "_test_ai_stub.json"
    user_fixture.write_text(json.dumps({
        "name": "_test_ai_stub",
        "description": "test fixture",
        "project_type": "ai_video",
        "requires_clips": False,
        "steps": [{"id": "noop", "uses": "montaj/probe"}]
    }))
    ws = tmp_path / "workspace"
    ws.mkdir()
    try:
        result = run_init("--canvas", "--prompt", "test", "--workflow", "_test_ai_stub",
                          env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
        assert result.returncode == 0, result.stderr
        project = json.loads(Path(result.stdout.strip()).read_text())
        assert project["projectType"] == "ai_video"
        assert "storyboard" in project
        assert project["storyboard"]["imageRefs"] == []
        assert project["storyboard"]["styleRefs"] == []
        # scenes[] is always present and starts empty — agent populates during pending
        assert project["storyboard"]["scenes"] == []
        # Intake settings are absent when not provided
        assert "aspectRatio" not in project["storyboard"]
        assert "targetDurationSeconds" not in project["storyboard"]
        # tracks[0] is empty for ai_video at intake — real clips only, no stubs
        assert project["tracks"][0] == []
    finally:
        user_fixture.unlink(missing_ok=True)


def test_ai_video_intake_settings(tmp_path):
    """aspectRatio and targetDurationSeconds flow through as structured storyboard fields,
    not appended to the prompt."""
    user_wf = Path.home() / ".montaj" / "workflows"
    user_wf.mkdir(parents=True, exist_ok=True)
    user_fixture = user_wf / "_test_ai_settings.json"
    user_fixture.write_text(json.dumps({
        "name": "_test_ai_settings",
        "description": "test",
        "project_type": "ai_video",
        "requires_clips": False,
        "steps": [{"id": "noop", "uses": "montaj/probe"}]
    }))
    ws = tmp_path / "workspace"
    ws.mkdir()
    try:
        result = run_init("--canvas", "--prompt", "A dog runs through a field",
                          "--workflow", "_test_ai_settings",
                          "--aspect-ratio", "9:16",
                          "--target-duration", "30",
                          env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
        assert result.returncode == 0, result.stderr
        project = json.loads(Path(result.stdout.strip()).read_text())
        # editingPrompt is EXACTLY what the user typed — no suffix
        assert project["editingPrompt"] == "A dog runs through a field"
        # Structured fields on storyboard
        assert project["storyboard"]["aspectRatio"] == "9:16"
        assert project["storyboard"]["targetDurationSeconds"] == 30
        # Still empty scenes + tracks[0] at intake
        assert project["storyboard"]["scenes"] == []
        assert project["tracks"][0] == []
    finally:
        user_fixture.unlink(missing_ok=True)


def test_ai_video_with_image_ref_path(tmp_path):
    # Create fixture workflow in user-global scope
    user_wf = Path.home() / ".montaj" / "workflows"
    user_wf.mkdir(parents=True, exist_ok=True)
    user_fixture = user_wf / "_test_ai_imgref.json"
    user_fixture.write_text(json.dumps({
        "name": "_test_ai_imgref",
        "description": "test",
        "project_type": "ai_video",
        "requires_clips": False,
        "steps": [{"id": "noop", "uses": "montaj/probe"}]
    }))
    # Create a fake image to reference
    img = tmp_path / "max.png"
    img.write_bytes(b"\x89PNG fake")
    ws = tmp_path / "workspace"
    ws.mkdir()
    try:
        ref_json = json.dumps({"label": "Max", "path": str(img)})
        result = run_init("--canvas", "--prompt", "test", "--workflow", "_test_ai_imgref",
                          "--image-ref", ref_json,
                          env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
        assert result.returncode == 0, result.stderr
        project = json.loads(Path(result.stdout.strip()).read_text())
        assert project["projectType"] == "ai_video"
        refs = project["storyboard"]["imageRefs"]
        assert len(refs) == 1
        assert refs[0]["id"] == "ref1"
        assert refs[0]["label"] == "Max"
        assert refs[0]["source"] == "upload"
        assert "anchor" not in refs[0]
        assert refs[0]["status"] == "pending"
        assert len(refs[0]["refImages"]) == 1
        assert refs[0]["refImages"][0].endswith("max.png")
    finally:
        user_fixture.unlink(missing_ok=True)


def test_ai_video_with_image_ref_text(tmp_path):
    user_wf = Path.home() / ".montaj" / "workflows"
    user_wf.mkdir(parents=True, exist_ok=True)
    user_fixture = user_wf / "_test_ai_textref.json"
    user_fixture.write_text(json.dumps({
        "name": "_test_ai_textref",
        "description": "test",
        "project_type": "ai_video",
        "requires_clips": False,
        "steps": [{"id": "noop", "uses": "montaj/probe"}]
    }))
    ws = tmp_path / "workspace"
    ws.mkdir()
    try:
        ref_json = json.dumps({"label": "Lena", "text": "a woman with red hair"})
        result = run_init("--canvas", "--prompt", "test", "--workflow", "_test_ai_textref",
                          "--image-ref", ref_json,
                          env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
        assert result.returncode == 0, result.stderr
        project = json.loads(Path(result.stdout.strip()).read_text())
        refs = project["storyboard"]["imageRefs"]
        assert len(refs) == 1
        assert refs[0]["label"] == "Lena"
        assert refs[0]["source"] == "text"
        assert refs[0]["anchor"] == "a woman with red hair"
        assert refs[0]["refImages"] == []
    finally:
        user_fixture.unlink(missing_ok=True)


def test_ai_video_with_style_ref(tmp_path):
    user_wf = Path.home() / ".montaj" / "workflows"
    user_wf.mkdir(parents=True, exist_ok=True)
    user_fixture = user_wf / "_test_ai_styleref.json"
    user_fixture.write_text(json.dumps({
        "name": "_test_ai_styleref",
        "description": "test",
        "project_type": "ai_video",
        "requires_clips": False,
        "steps": [{"id": "noop", "uses": "montaj/probe"}]
    }))
    clip = tmp_path / "mood.mp4"
    clip.write_bytes(b"fake video")
    ws = tmp_path / "workspace"
    ws.mkdir()
    try:
        ref_json = json.dumps({"label": "mood", "path": str(clip)})
        result = run_init("--canvas", "--prompt", "test", "--workflow", "_test_ai_styleref",
                          "--style-ref", ref_json,
                          env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
        assert result.returncode == 0, result.stderr
        project = json.loads(Path(result.stdout.strip()).read_text())
        styles = project["storyboard"]["styleRefs"]
        assert len(styles) == 1
        assert styles[0]["kind"] == "video"
        assert styles[0]["label"] == "mood"
    finally:
        user_fixture.unlink(missing_ok=True)


def test_image_ref_ignored_for_non_ai_video(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    ref_json = json.dumps({"label": "Max", "text": "a dog"})
    result = run_init("--clips", str(clip), "--prompt", "test", "--workflow", "clean_cut",
                      "--image-ref", ref_json,
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    assert project["projectType"] == "editing"
    assert "storyboard" not in project


def test_assets_array_untouched_with_project_type(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    asset = tmp_path / "logo.png"
    asset.write_bytes(b"fake png")
    result = run_init("--clips", str(clip), "--assets", str(asset), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(Path(result.stdout.strip()).read_text())
    assert "projectType" in project
    assert len(project["assets"]) == 1
    assert project["assets"][0]["type"] == "image"
    assert project["assets"][0]["name"] == "logo.png"
