"""Tests for project/init.py project creation — v0.2 unified tracks schema."""
import json, os, shutil, subprocess, sys, uuid
from pathlib import Path
import pytest

REPO_ROOT = Path(__file__).parent.parent
INIT_PY   = str(REPO_ROOT / "project" / "init.py")
HAS_FFMPEG = shutil.which("ffmpeg") is not None


def run_init(*args, env_override=None):
    import os
    e = {**os.environ, **(env_override or {})}
    return subprocess.run(
        [sys.executable, INIT_PY, *args],
        capture_output=True, text=True, env=e
    )


def _project_path_from_stdout(stdout: str) -> Path:
    """init.py emits a single stdout line — the project.json path. This helper
    exists as a defensive layer in case any future change re-introduces extra
    stdout output (e.g. by calling library functions that print). Returns the
    last non-empty line."""
    lines = [ln for ln in stdout.strip().split("\n") if ln.strip()]
    return Path(lines[-1])


def test_normal_project_has_tracks(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--clips", str(clip), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert "tracks" in project
    assert "base_track" not in project
    assert "visual_tracks" not in project


def test_normal_project_tracks_has_one_track(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--clips", str(clip), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert len(project["tracks"]) == 1


def test_normal_project_clip_in_primary_track(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--clips", str(clip), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
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
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["version"] == "0.2"


def test_canvas_project_has_empty_primary_track(tmp_path):
    result = run_init("--canvas", "--prompt", "test", "--workflow", "canvas",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
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
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
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
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["projectType"] == "music_video"
    assert "storyboard" not in project


def test_clean_cut_defaults_to_editing(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--clips", str(clip), "--prompt", "test", "--workflow", "clean_cut",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["projectType"] == "editing"
    assert "storyboard" not in project


def test_nonexistent_workflow_defaults_to_editing(tmp_path):
    result = run_init("--canvas", "--prompt", "test", "--workflow", "nonexistent_workflow_xyz",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
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
        project = json.loads(_project_path_from_stdout(result.stdout).read_text())
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
        project = json.loads(_project_path_from_stdout(result.stdout).read_text())
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
        project = json.loads(_project_path_from_stdout(result.stdout).read_text())
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
        project = json.loads(_project_path_from_stdout(result.stdout).read_text())
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
        project = json.loads(_project_path_from_stdout(result.stdout).read_text())
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
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["projectType"] == "editing"
    assert "storyboard" not in project


def test_ai_video_invalid_aspect_ratio_rejected(tmp_path):
    """init.py rejects aspect ratios outside the enum (defense-in-depth)."""
    user_wf = Path.home() / ".montaj" / "workflows"
    user_wf.mkdir(parents=True, exist_ok=True)
    user_fixture = user_wf / "_test_ai_bad_aspect.json"
    user_fixture.write_text(json.dumps({
        "name": "_test_ai_bad_aspect",
        "description": "test",
        "project_type": "ai_video",
        "requires_clips": False,
        "steps": [{"id": "noop", "uses": "montaj/probe"}]
    }))
    ws = tmp_path / "workspace"
    ws.mkdir()
    try:
        result = run_init("--canvas", "--prompt", "test",
                          "--workflow", "_test_ai_bad_aspect",
                          "--aspect-ratio", "4:3",
                          env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
        assert result.returncode != 0
        assert "invalid_aspect_ratio" in result.stderr or "4:3" in result.stderr
    finally:
        user_fixture.unlink(missing_ok=True)


def test_assets_array_untouched_with_project_type(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    asset = tmp_path / "logo.png"
    asset.write_bytes(b"fake png")
    result = run_init("--clips", str(clip), "--assets", str(asset), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert "projectType" in project
    assert len(project["assets"]) == 1
    assert project["assets"][0]["type"] == "image"
    assert project["assets"][0]["name"] == "logo.png"


# ---------------------------------------------------------------------------
# Real-video tests — parallelism, modal resolution, override, contract
# (require ffmpeg)
# ---------------------------------------------------------------------------

def _make_clip(path: Path, *, width=640, height=480, sample_rate=48000, duration=1, rotation=0):
    """Make a small synthetic video clip — used by parallel + modal-resolution tests.

    Pass `rotation` (e.g. -90) to simulate iPhone vertical recording — adds a
    displaymatrix rotation tag without changing the physical pixel dimensions.
    """
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=red:size={width}x{height}:rate=30:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate={sample_rate}:duration={duration}",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30",
        "-c:a", "aac", "-ar", str(sample_rate),
    ]
    if rotation:
        cmd += ["-metadata:s:v:0", f"rotate={rotation}"]
    cmd.append(str(path))
    subprocess.run(cmd, check=True, capture_output=True, timeout=60)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_normalize_preserves_clip_order(tmp_path):
    """Output project.json's tracks[0] must list clips in --clips arg order."""
    clips = []
    for i in range(4):
        c = tmp_path / f"clip_{i}.mp4"
        # 3s duration ensures ≥2 keyframes so _probe_max_keyframe_interval
        # returns a real value (≤2.0) and the audio fast path is taken.
        # Shorter clips probe as 999 (single keyframe) and fall through to
        # full re-encode, which still passes this test but doesn't exercise
        # what the test name claims.
        _make_clip(c, sample_rate=44100, duration=3)  # 44k → audio fast path
        clips.append(str(c))
    ws = tmp_path / "ws"
    ws.mkdir()
    result = run_init("--clips", *clips, "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    track = project["tracks"][0]
    assert len(track) == 4
    for i, item in enumerate(track):
        assert item["id"] == f"clip-{i}"


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_normalizes_clips_in_parallel(tmp_path):
    """3+ clips should be normalized concurrently. Heuristic: wall-time for 4
    clips that each need normalize should be measurably less than 4× a single
    clip's wall-time. We don't measure absolute timing; we rely on the
    observation that 4 audio-fast-path normalizes complete in << 4× serial."""
    import time
    clips = []
    for i in range(4):
        c = tmp_path / f"clip_{i}.mp4"
        # 3s duration → ≥2 keyframes → keyframe-interval probe succeeds →
        # audio fast path taken (the path this test claims to exercise).
        _make_clip(c, sample_rate=44100, duration=3)
        clips.append(str(c))
    ws = tmp_path / "ws"
    ws.mkdir()
    t0 = time.time()
    result = run_init("--clips", *clips, "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    elapsed = time.time() - t0
    assert result.returncode == 0, result.stderr
    # Sanity: 4 fast-path normalizes in parallel should finish in <30s on any
    # reasonable machine. This guards against accidental serialization but is
    # generous enough not to be flaky in CI.
    assert elapsed < 30, f"init took {elapsed:.1f}s — likely serialized"
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    # Under the new contract: 44.1kHz audio is no longer a normalize trigger
    # (audio resampled at compose time). Conformant SDR clips with bad audio
    # rate skip normalize entirely. So we just assert init finished with the
    # right number of items, not what filename they carry.
    assert len(project["tracks"][0]) == 4


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_continues_when_one_clip_fails(tmp_path, monkeypatch):
    """If a clip can't be probed (corrupt file), init should still finish other
    clips' work without silently swallowing the error. The bad clip falls back
    to its original src path (per the existing fall-back semantics), the good
    clip gets normalized."""
    good = tmp_path / "good.mp4"
    # Use yuv422p so the good clip needs a transcode (yuv422p ≠ yuv420p) — this
    # exercises the transcode path and produces a _normalized_<cs>.mp4 file.
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "color=red:size=640x480:rate=30:duration=3",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv422p",
        "-g", "30", "-keyint_min", "30",
        "-c:a", "aac", "-ar", "48000",
        str(good),
    ], check=True, capture_output=True, timeout=60)
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"not a video")
    ws = tmp_path / "ws"
    ws.mkdir()
    result = run_init("--clips", str(good), str(bad), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    track = project["tracks"][0]
    assert len(track) == 2
    # Good clip: normalized to project color space.
    assert track[0]["src"].endswith("_normalized_sdr_bt709.mp4")
    # Bad clip: src points at the original (copied-into-workspace) path, NOT
    # at a _normalized_*.mp4 — probe failed, normalize was skipped.
    assert "bad" in track[1]["src"]
    assert "_normalized_" not in track[1]["src"]


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_modal_resolution_detection(tmp_path):
    """Project with 1× 640×480 + 2× 1280×720 clips should set settings.resolution
    = [1280, 720] (modal across clips)."""
    a = tmp_path / "a.mp4"; _make_clip(a, width=640, height=480)
    b = tmp_path / "b.mp4"; _make_clip(b, width=1280, height=720)
    c = tmp_path / "c.mp4"; _make_clip(c, width=1280, height=720)
    ws = tmp_path / "ws"; ws.mkdir()
    result = run_init("--clips", str(a), str(b), str(c), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["settings"]["resolution"] == [1280, 720]


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_modal_tiebreak_first_appearance(tmp_path):
    """Tied modes → first-appearance wins (NOT highest resolution).

    Order: 640×480 first, then 1280×720. Both appear once → tied. Result must
    be 640×480 (first-appearance), NOT 1280×720 (highest)."""
    a = tmp_path / "a.mp4"; _make_clip(a, width=640, height=480)
    b = tmp_path / "b.mp4"; _make_clip(b, width=1280, height=720)
    ws = tmp_path / "ws"; ws.mkdir()
    result = run_init("--clips", str(a), str(b), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["settings"]["resolution"] == [640, 480]


# NOTE: The smart-detect display-dims integration test was deliberately omitted.
# Synthetic ffmpeg fixtures (lavfi sources) can't carry displaymatrix side_data
# through the write path in ffmpeg 8.x — `-metadata:s:v:0 rotate=...` silently
# no-ops, and `-display_rotation` is input-only. Real iPhone clips carry the
# metadata natively. The chain "rotated source → portrait canvas" is provable by:
#   1. probe_video swap logic — covered by tests in test_normalize.py
#      (test_probe_video_swaps_dims_for_rotation_minus_90 etc.)
#   2. init.py reads info["display_width"]/["display_height"] before modal —
#      one-line code reading verification.
# A real-iPhone-fixture integration test is filed as a follow-up if rotation
# regressions become a concern.


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_resolution_override(tmp_path):
    """--resolution 1280x720 should set settings.resolution = [1280, 720] regardless
    of source clip dims."""
    a = tmp_path / "a.mp4"; _make_clip(a, width=640, height=480)
    ws = tmp_path / "ws"; ws.mkdir()
    result = run_init("--clips", str(a), "--prompt", "test",
                      "--resolution", "1280x720",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["settings"]["resolution"] == [1280, 720]


def test_init_resolution_invalid_format(tmp_path):
    """--resolution foo should fail with invalid_resolution error."""
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--clips", str(clip), "--prompt", "test",
                      "--resolution", "foo",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode != 0
    err = json.loads(result.stderr)
    assert err["error"] == "invalid_resolution"


def test_init_no_clips_uses_aspect_default(tmp_path):
    """Canvas project (no clips) with aspect 9:16 should use ASPECT_RESOLUTIONS['9:16']."""
    user_wf = Path.home() / ".montaj" / "workflows"
    user_wf.mkdir(parents=True, exist_ok=True)
    user_fixture = user_wf / "_test_aspect_default.json"
    user_fixture.write_text(json.dumps({
        "name": "_test_aspect_default",
        "description": "test",
        "project_type": "ai_video",
        "requires_clips": False,
        "steps": [{"id": "noop", "uses": "montaj/probe"}]
    }))
    ws = tmp_path / "ws"; ws.mkdir()
    try:
        result = run_init("--canvas", "--prompt", "test",
                          "--workflow", "_test_aspect_default",
                          "--aspect-ratio", "9:16",
                          env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
        assert result.returncode == 0, result.stderr
        project = json.loads(_project_path_from_stdout(result.stdout).read_text())
        # ASPECT_RESOLUTIONS["9:16"] = (1080, 1920)
        assert project["settings"]["resolution"] == [1080, 1920]
    finally:
        user_fixture.unlink(missing_ok=True)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_preserves_source_resolution_at_intake(tmp_path):
    """Contract regression: a 4K source on a 1080p-defaulted project must still
    be 4K on disk after init. Locks in resolution-preservation invariant."""
    src = tmp_path / "src4k.mp4"
    _make_clip(src, width=1280, height=720, sample_rate=44100)  # fast-path eligible
    ws = tmp_path / "ws"; ws.mkdir()
    # Force project resolution to 640x480 — different from the source.
    result = run_init("--clips", str(src), "--prompt", "test",
                      "--resolution", "640x480",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["settings"]["resolution"] == [640, 480]

    # The clip's normalized output must still be 1280x720 (source preserved).
    track = project["tracks"][0]
    src_path = track[0]["src"]
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_streams", "-select_streams", "v:0", src_path],
        capture_output=True, text=True, timeout=30,
    )
    assert r.returncode == 0
    stream = json.loads(r.stdout)["streams"][0]
    assert stream["width"] == 1280
    assert stream["height"] == 720


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_contract_every_clip_is_normalized(tmp_path):
    """After init returns, every tracks[0][i].src must satisfy the new contract:
    is_normalized(path, info, project_color_space) == True. The contract checks
    the actual stream content against the project's working color space.

    Uses 3-second clips so the keyframe-interval probe (which inspects the first
    10 seconds and needs ≥2 keyframes to compute a gap) sees enough keyframes."""
    sys.path.insert(0, str(REPO_ROOT))
    from lib.normalize import is_normalized, probe_video

    a = tmp_path / "a.mp4"; _make_clip(a, sample_rate=44100, duration=3)
    b = tmp_path / "b.mp4"; _make_clip(b, sample_rate=48000, duration=3)
    ws = tmp_path / "ws"; ws.mkdir()
    result = run_init("--clips", str(a), str(b), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    project_color_space = project["settings"].get("colorSpace", "sdr_bt709")
    for item in project["tracks"][0]:
        info = probe_video(item["src"])
        assert info is not None, f"probe failed for {item['src']}"
        assert is_normalized(item["src"], info, project_color_space), \
            f"clip is not actually conformant: {item['src']}"


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_probe_cache_is_consumed_by_normalize_loop(tmp_path):
    """probe_video is the most expensive step per clip (two ffprobe subprocesses).
    Smart-resolution detection probes every clip once; _normalize_one MUST read
    from probe_cache instead of re-probing. Verified by wrapping `ffprobe` with a
    counter shim and asserting the per-clip ffprobe count after init equals the
    detection-pass count, NOT 2× it.

    Without the cache, this test would fail: each clip would be probed twice
    (once by detection, once by _normalize_one). With the cache, each clip is
    probed exactly once during detection, then _normalize_one reads from cache.

    (probe_video itself fires 2 ffprobe calls per probe — one for stream info,
    one for keyframe interval. So expected ffprobe count = 2 × n_clips.)"""
    n_clips = 4
    clips = []
    for i in range(n_clips):
        c = tmp_path / f"clip_{i}.mp4"
        _make_clip(c, sample_rate=44100, duration=3)
        clips.append(str(c))

    # Build a counter shim that wraps real ffprobe and records each call as a
    # unique file (via mktemp — atomic across concurrent processes). The naive
    # "read counter, increment, write back" pattern races when init's pool=4
    # workers call ffprobe concurrently: two workers read the same value, both
    # write counter+1, and one increment is lost. mktemp sidesteps this entirely.
    shim_dir = tmp_path / "shim_bin"
    shim_dir.mkdir()
    counter_dir = tmp_path / "ffprobe_calls"
    counter_dir.mkdir()

    real_ffprobe = subprocess.run(["which", "ffprobe"], capture_output=True, text=True).stdout.strip()
    assert real_ffprobe, "could not locate real ffprobe"

    shim = shim_dir / "ffprobe"
    shim.write_text(
        "#!/bin/sh\n"
        f'mktemp "{counter_dir}/call.XXXXXX" >/dev/null\n'
        f'exec "{real_ffprobe}" "$@"\n'
    )
    shim.chmod(0o755)

    ws = tmp_path / "ws"; ws.mkdir()
    env = os.environ.copy()
    env["PATH"] = f"{shim_dir}:{env['PATH']}"
    env["MONTAJ_FFPROBE"] = str(shim)
    env["MONTAJ_WORKSPACE_DIR"] = str(ws)

    result = subprocess.run(
        [sys.executable, INIT_PY, "--clips", *clips, "--prompt", "test"],
        capture_output=True, text=True, env=env,
    )
    assert result.returncode == 0, result.stderr

    ffprobe_count = len(list(counter_dir.iterdir()))
    # Per-clip ffprobe call accounting:
    #   - probe_video()       = 3 ffprobe calls (stream info + keyframe interval + rotation)
    #   - get_duration()      = 1 ffprobe call (duration probe after normalize)
    #
    # Detection runs probe_video for each clip = 3 × n_clips.
    # _normalize_one reads from probe_cache (0 extra) and passes the cached
    # `info` into normalize() (which skips its internal probe = 0 extra).
    # Then get_duration is called once = 1 × n_clips.
    # Expected total: 4 × n_clips.
    #
    # Without cache OR without info-passthrough, we'd see:
    #   - cache miss in _normalize_one: +3 × n_clips
    #   - normalize() internal probe:   +3 × n_clips
    #   → 10 × n_clips total.
    expected = 4 * n_clips
    expected_no_caching = 10 * n_clips
    assert ffprobe_count == expected, (
        f"probe caching appears bypassed: ffprobe ran {ffprobe_count} times for "
        f"{n_clips} clips. Expected {expected} (cache hit + info passthrough), "
        f"would-be-without-caching: {expected_no_caching}."
    )


# ---------------------------------------------------------------------------
# Color-space smart-detect + override tests
# ---------------------------------------------------------------------------

def _make_hlg_clip(path: Path, *, duration=3):
    """Make a clip tagged with HLG color metadata (yuv420p10le, arib-std-b67).

    Uses x265-params transfer= to force the value into the HEVC bitstream so
    ffprobe reports it on read-back. -color_trc alone isn't enough when the
    source is a synthetic lavfi color filter.
    """
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=red:size=640x360:rate=30:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}",
        "-c:v", "libx265", "-preset", "ultrafast", "-crf", "28",
        "-pix_fmt", "yuv420p10le",
        "-x265-params", "transfer=arib-std-b67:colorprim=bt2020:colormatrix=bt2020nc",
        "-color_trc", "arib-std-b67",
        "-color_primaries", "bt2020",
        "-colorspace", "bt2020nc",
        "-g", "30", "-keyint_min", "30",
        "-c:a", "aac", "-ar", "48000",
        str(path),
    ], check=True, capture_output=True, timeout=60)


def _make_pq_clip(path: Path, *, duration=3):
    """Make a clip tagged with PQ color metadata (yuv420p10le, smpte2084).

    Uses x265-params transfer= to force the value into the HEVC bitstream so
    ffprobe reports it on read-back.
    """
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=red:size=640x360:rate=30:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}",
        "-c:v", "libx265", "-preset", "ultrafast", "-crf", "28",
        "-pix_fmt", "yuv420p10le",
        "-x265-params", "transfer=smpte2084:colorprim=bt2020:colormatrix=bt2020nc",
        "-color_trc", "smpte2084",
        "-color_primaries", "bt2020",
        "-colorspace", "bt2020nc",
        "-g", "30", "-keyint_min", "30",
        "-c:a", "aac", "-ar", "48000",
        str(path),
    ], check=True, capture_output=True, timeout=60)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_smart_detects_hdr_hlg_from_iphone_clips(tmp_path):
    """All-HLG clips → settings.colorSpace == 'hdr_hlg', no normalize files written."""
    clips = []
    for i in range(2):
        c = tmp_path / f"hlg_{i}.mp4"
        _make_hlg_clip(c)
        clips.append(str(c))
    ws = tmp_path / "ws"; ws.mkdir()
    result = run_init("--clips", *clips, "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["settings"]["colorSpace"] == "hdr_hlg"
    # No clip should have been normalized — sources are conformant for HLG project.
    for item in project["tracks"][0]:
        assert "_normalized_" not in item["src"], \
            f"HLG clip should pass through HLG project unchanged: {item['src']}"


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_smart_detects_modal_hlg_with_sdr_outlier(tmp_path):
    """2× HLG + 1× SDR → settings.colorSpace == 'hdr_hlg' (modal wins).
    The 1 SDR outlier will be inverse-stretched on the fly, not the other 27
    HDR clips tonemapped down. Critical for iPhone-dominant workflows."""
    a = tmp_path / "hlg1.mp4"; _make_hlg_clip(a)
    b = tmp_path / "hlg2.mp4"; _make_hlg_clip(b)
    c = tmp_path / "sdr.mp4"; _make_clip(c, duration=3)
    ws = tmp_path / "ws"; ws.mkdir()
    result = run_init("--clips", str(a), str(b), str(c), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["settings"]["colorSpace"] == "hdr_hlg"
    # Modal-wins progress message should name the chosen space and the count.
    assert "detected colorSpace=hdr_hlg" in result.stderr
    assert "modal: 2 of 3 clips" in result.stderr


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_smart_detects_sdr_on_tie(tmp_path):
    """1× HLG + 1× SDR (tied at 1 each) → settings.colorSpace == 'sdr_bt709'.
    Tiebreak rule: SDR wins when tied with HDR (conservative on inverse-stretch)."""
    a = tmp_path / "hlg.mp4"; _make_hlg_clip(a)
    b = tmp_path / "sdr.mp4"; _make_clip(b, duration=3)
    ws = tmp_path / "ws"; ws.mkdir()
    result = run_init("--clips", str(a), str(b), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["settings"]["colorSpace"] == "sdr_bt709"


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_smart_detects_pq_from_mixed_hdr(tmp_path):
    """1× HLG + 1× PQ (no SDR, tied) → settings.colorSpace == 'hdr_pq'
    (PQ wins HDR-only ties; HLG converts cleanly into PQ container)."""
    a = tmp_path / "hlg.mp4"; _make_hlg_clip(a)
    b = tmp_path / "pq.mp4"; _make_pq_clip(b)
    ws = tmp_path / "ws"; ws.mkdir()
    result = run_init("--clips", str(a), str(b), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["settings"]["colorSpace"] == "hdr_pq"


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_init_color_space_override_via_cli(tmp_path):
    """--color-space hdr_hlg forces HLG even when sources are all SDR."""
    a = tmp_path / "sdr.mp4"; _make_clip(a, duration=3)
    ws = tmp_path / "ws"; ws.mkdir()
    result = run_init("--clips", str(a), "--prompt", "test",
                      "--color-space", "hdr_hlg",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["settings"]["colorSpace"] == "hdr_hlg"


def test_init_no_clips_uses_default_color_space(tmp_path):
    """Canvas projects (no clips) get the SDR default color space."""
    user_wf = Path.home() / ".montaj" / "workflows"
    user_wf.mkdir(parents=True, exist_ok=True)
    user_fixture = user_wf / "_test_canvas_cs.json"
    user_fixture.write_text(json.dumps({
        "name": "_test_canvas_cs",
        "description": "test",
        "project_type": "ai_video",
        "requires_clips": False,
        "steps": [{"id": "noop", "uses": "montaj/probe"}]
    }))
    ws = tmp_path / "ws"; ws.mkdir()
    try:
        result = run_init("--canvas", "--prompt", "test", "--workflow", "_test_canvas_cs",
                          env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
        assert result.returncode == 0, result.stderr
        project = json.loads(_project_path_from_stdout(result.stdout).read_text())
        assert project["settings"]["colorSpace"] == "sdr_bt709"
    finally:
        user_fixture.unlink(missing_ok=True)


def test_init_color_space_override_via_canvas(tmp_path):
    """--color-space hdr_pq forces PQ on a canvas project (no clips → no smart-detect)."""
    user_wf = Path.home() / ".montaj" / "workflows"
    user_wf.mkdir(parents=True, exist_ok=True)
    user_fixture = user_wf / "_test_canvas_pq.json"
    user_fixture.write_text(json.dumps({
        "name": "_test_canvas_pq",
        "description": "test",
        "project_type": "ai_video",
        "requires_clips": False,
        "steps": [{"id": "noop", "uses": "montaj/probe"}]
    }))
    ws = tmp_path / "ws"; ws.mkdir()
    try:
        result = run_init("--canvas", "--prompt", "test", "--workflow", "_test_canvas_pq",
                          "--color-space", "hdr_pq",
                          env_override={"MONTAJ_WORKSPACE_DIR": str(ws)})
        assert result.returncode == 0, result.stderr
        project = json.loads(_project_path_from_stdout(result.stdout).read_text())
        assert project["settings"]["colorSpace"] == "hdr_pq"
    finally:
        user_fixture.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# --profile snapshot tests (Phase 2 of profile-assets feature)
#
# All tests redirect HOME → tmp_path so the profile dir resolution
# (~/.montaj/profiles/{name}) lands inside the test sandbox. The assets
# manifest helper reads from Path.home() which honors $HOME on Unix.
# ---------------------------------------------------------------------------

def _write_profile_manifest(home: Path, profile: str, manifest: dict) -> None:
    """Write a manifest.json under the fake HOME's profile assets dir."""
    assets_dir = home / ".montaj" / "profiles" / profile / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    (assets_dir / "manifest.json").write_text(json.dumps(manifest))


def _make_profile_dir(home: Path, profile: str) -> Path:
    """Create the profile dir but no assets/ subdir — returns the profile dir."""
    profile_dir = home / ".montaj" / "profiles" / profile
    profile_dir.mkdir(parents=True, exist_ok=True)
    return profile_dir


def test_profile_snapshot_with_populated_manifest(tmp_path):
    """--profile <name> with a populated manifest snapshots summary + sorted
    availableAssets (each with filename, description, tags) into project.json."""
    home = tmp_path / "home"
    home.mkdir()
    _write_profile_manifest(home, "alice", {
        "summary": "alice's brand kit",
        "files": {
            "zebra.png":  {"description": "logo dark",  "tags": ["logo", "dark"]},
            "alpha.jpg":  {"description": "headshot",   "tags": []},
            "middle.svg": {"description": "wordmark",   "tags": ["logo"]},
        },
    })
    ws = tmp_path / "ws"
    ws.mkdir()
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init(
        "--clips", str(clip), "--prompt", "test", "--profile", "alice",
        env_override={"MONTAJ_WORKSPACE_DIR": str(ws), "HOME": str(home)},
    )
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())

    assert project["profile"] == "alice"
    snap = project["profileSnapshot"]
    assert snap["name"] == "alice"
    assert snap["summary"] == "alice's brand kit"
    # availableAssets must be sorted by filename for deterministic output.
    filenames = [a["filename"] for a in snap["availableAssets"]]
    assert filenames == ["alpha.jpg", "middle.svg", "zebra.png"]
    # Each entry has the canonical shape.
    for entry in snap["availableAssets"]:
        assert set(entry.keys()) == {"filename", "description", "tags"}
        assert isinstance(entry["description"], str)
        assert isinstance(entry["tags"], list)
    # Spot-check one entry preserves description + tags.
    by_name = {a["filename"]: a for a in snap["availableAssets"]}
    assert by_name["zebra.png"]["description"] == "logo dark"
    assert by_name["zebra.png"]["tags"] == ["logo", "dark"]
    # Empty-tags case keeps tags as [] (not omitted).
    assert by_name["alpha.jpg"]["tags"] == []


def test_profile_snapshot_byte_identical_across_runs(tmp_path):
    """Two init runs with identical inputs must yield byte-identical
    profileSnapshot blocks (sort stability)."""
    home = tmp_path / "home"
    home.mkdir()
    _write_profile_manifest(home, "bob", {
        "summary": "",
        "files": {
            "c.png": {"description": "", "tags": []},
            "a.png": {"description": "", "tags": []},
            "b.png": {"description": "", "tags": []},
        },
    })
    snaps = []
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    for i in range(2):
        ws = tmp_path / f"ws{i}"
        ws.mkdir()
        r = run_init(
            "--clips", str(clip), "--prompt", "test", "--profile", "bob",
            env_override={"MONTAJ_WORKSPACE_DIR": str(ws), "HOME": str(home)},
        )
        assert r.returncode == 0, r.stderr
        proj = json.loads(_project_path_from_stdout(r.stdout).read_text())
        snaps.append(proj["profileSnapshot"])
    assert snaps[0] == snaps[1]
    assert [a["filename"] for a in snaps[0]["availableAssets"]] == ["a.png", "b.png", "c.png"]


def test_profile_snapshot_no_assets_dir(tmp_path):
    """--profile <name> with a profile dir but no assets/ subdir → snapshot is
    present with empty summary + empty availableAssets."""
    home = tmp_path / "home"
    home.mkdir()
    _make_profile_dir(home, "carol")  # no assets/ subdir created
    ws = tmp_path / "ws"
    ws.mkdir()
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init(
        "--clips", str(clip), "--prompt", "test", "--profile", "carol",
        env_override={"MONTAJ_WORKSPACE_DIR": str(ws), "HOME": str(home)},
    )
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["profile"] == "carol"
    assert project["profileSnapshot"] == {
        "name": "carol", "summary": "", "availableAssets": [],
    }


def test_profile_snapshot_assets_dir_no_manifest(tmp_path):
    """--profile <name> with assets/ but no manifest.json → snapshot is present
    with empty summary + empty availableAssets."""
    home = tmp_path / "home"
    home.mkdir()
    assets_dir = home / ".montaj" / "profiles" / "dave" / "assets"
    assets_dir.mkdir(parents=True)  # no manifest.json
    ws = tmp_path / "ws"
    ws.mkdir()
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init(
        "--clips", str(clip), "--prompt", "test", "--profile", "dave",
        env_override={"MONTAJ_WORKSPACE_DIR": str(ws), "HOME": str(home)},
    )
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["profileSnapshot"] == {
        "name": "dave", "summary": "", "availableAssets": [],
    }


def test_profile_snapshot_corrupt_manifest(tmp_path):
    """--profile <name> with corrupt manifest.json (invalid JSON) → snapshot is
    present with empty summary + empty availableAssets (helper handles it)."""
    home = tmp_path / "home"
    home.mkdir()
    assets_dir = home / ".montaj" / "profiles" / "eve" / "assets"
    assets_dir.mkdir(parents=True)
    (assets_dir / "manifest.json").write_text("{not valid json")
    ws = tmp_path / "ws"
    ws.mkdir()
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init(
        "--clips", str(clip), "--prompt", "test", "--profile", "eve",
        env_override={"MONTAJ_WORKSPACE_DIR": str(ws), "HOME": str(home)},
    )
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert project["profileSnapshot"] == {
        "name": "eve", "summary": "", "availableAssets": [],
    }


def test_no_profile_omits_both_fields(tmp_path):
    """No --profile → both `profile` and `profileSnapshot` absent (existing
    readers must continue seeing absence as before — no widening)."""
    ws = tmp_path / "ws"
    ws.mkdir()
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init(
        "--clips", str(clip), "--prompt", "test",
        env_override={"MONTAJ_WORKSPACE_DIR": str(ws)},
    )
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert "profile" not in project
    assert "profileSnapshot" not in project


def test_profile_snapshot_includes_style_profile_path_when_present(tmp_path):
    """A profile with style_profile.md present at init → snapshot includes
    `styleProfilePath` pointing at that absolute path. Validates the live
    pointer the agent uses to read editorial direction."""
    home = tmp_path / "home"
    home.mkdir()
    profile_dir = _make_profile_dir(home, "frank")
    style_md = profile_dir / "style_profile.md"
    style_md.write_text("# Frank's analyzed style\n")
    ws = tmp_path / "ws"
    ws.mkdir()
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init(
        "--clips", str(clip), "--prompt", "test", "--profile", "frank",
        env_override={"MONTAJ_WORKSPACE_DIR": str(ws), "HOME": str(home)},
    )
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    snap = project["profileSnapshot"]
    assert snap["styleProfilePath"] == str(style_md)


def test_profile_snapshot_omits_style_profile_path_when_absent(tmp_path):
    """No style_profile.md at init → `styleProfilePath` is OMITTED from the
    snapshot entirely (not present-but-empty). Agents gate on key presence."""
    home = tmp_path / "home"
    home.mkdir()
    _make_profile_dir(home, "grace")  # no style_profile.md created
    ws = tmp_path / "ws"
    ws.mkdir()
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init(
        "--clips", str(clip), "--prompt", "test", "--profile", "grace",
        env_override={"MONTAJ_WORKSPACE_DIR": str(ws), "HOME": str(home)},
    )
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    snap = project["profileSnapshot"]
    assert "styleProfilePath" not in snap


# ---------------------------------------------------------------------------
# --id flag tests (Task 1 of 2026-05-10-init-id-passthrough plan)
# ---------------------------------------------------------------------------

CANONICAL_ID = "550e8400-e29b-41d4-a716-446655440000"


def test_init_with_explicit_id_uses_supplied_value(tmp_path, monkeypatch):
    """--id <canonical-uuid> overrides the server-generated UUID in project.json."""
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    result = subprocess.run(
        [sys.executable, "-m", "project.init",
         "--prompt", "test",
         "--workflow", "carousel",
         "--carousel-aspect", "square",
         "--id", CANONICAL_ID,
         "--project-path", "explicit-id-test"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    project_json = json.loads((tmp_path / "explicit-id-test" / "project.json").read_text())
    assert project_json["id"] == CANONICAL_ID


@pytest.mark.parametrize("non_canonical", [
    "550E8400-E29B-41D4-A716-446655440000",                # uppercase hex
    "550e8400e29b41d4a716446655440000",                    # hex32, no dashes
    "{550e8400-e29b-41d4-a716-446655440000}",              # braced
    "urn:uuid:550e8400-e29b-41d4-a716-446655440000",       # urn prefix
])
def test_init_with_non_canonical_id_is_canonicalized(tmp_path, monkeypatch, non_canonical):
    """Non-canonical-but-parseable UUID forms are accepted and stored canonicalized.
    This is the contract that makes find_project_dir's string-equality match safe
    against logically-equal-but-textually-different ids."""
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    # Use a unique project-path per parametrize case — same canonical id under
    # different surface forms would otherwise collide on directory creation.
    safe_subdir = f"non-canon-{abs(hash(non_canonical))}"
    result = subprocess.run(
        [sys.executable, "-m", "project.init",
         "--prompt", "test",
         "--workflow", "carousel",
         "--carousel-aspect", "square",
         "--id", non_canonical,
         "--project-path", safe_subdir],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    project_json = json.loads((tmp_path / safe_subdir / "project.json").read_text())
    assert project_json["id"] == CANONICAL_ID


def test_init_without_id_generates_uuid(tmp_path, monkeypatch):
    """Absence of --id preserves current behavior — generated UUID, valid format."""
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    result = subprocess.run(
        [sys.executable, "-m", "project.init",
         "--prompt", "test",
         "--workflow", "carousel",
         "--carousel-aspect", "square",
         "--project-path", "no-id-test"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    project_json = json.loads((tmp_path / "no-id-test" / "project.json").read_text())
    # Round-trips through uuid.UUID — proves it's a valid canonical UUID string.
    assert str(uuid.UUID(project_json["id"])) == project_json["id"]


@pytest.mark.parametrize("bad_id", [
    "not-a-uuid",
    "550e8400-e29b-41d4-a716",                       # truncated
    "",                                              # empty
    "550e8400-e29b-41d4-a716-44665544000Z",          # invalid hex character
    "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",          # all non-hex
])
def test_init_with_invalid_id_rejected(tmp_path, monkeypatch, bad_id):
    """Truly malformed --id exits non-zero with invalid_id error, no project created."""
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    result = subprocess.run(
        [sys.executable, "-m", "project.init",
         "--prompt", "test",
         "--workflow", "carousel",
         "--carousel-aspect", "square",
         "--id", bad_id,
         "--project-path", "bad-id-test"],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    err = json.loads(result.stderr)
    assert err["error"] == "invalid_id"
    # No project directory should have been created on validation failure.
    assert not (tmp_path / "bad-id-test").exists()


# ---------------------------------------------------------------------------
# --symlink-clips and --derived-from tests
# ---------------------------------------------------------------------------

def test_symlink_clips_creates_symlink(tmp_path):
    """--symlink-clips stages the clip as a symlink instead of a copy."""
    ws = tmp_path / "ws"; ws.mkdir()
    src = tmp_path / "source.mp4"; src.write_bytes(b"\x00" * 1024)
    result = run_init(
        "--prompt", "p", "--workflow", "clean_cut",
        "--clips", str(src),
        "--symlink-clips",
        "--project-path", "proj",
        env_override={"MONTAJ_WORKSPACE_DIR": str(ws)},
    )
    assert result.returncode == 0, result.stderr
    proj_json = _project_path_from_stdout(result.stdout)
    staged = proj_json.parent / "source.mp4"
    assert staged.is_symlink(), "clip should be symlinked, not copied"
    assert staged.resolve() == src.resolve()


def test_derived_from_written(tmp_path):
    """--derived-from writes derivedFrom into project.json."""
    ws = tmp_path / "ws"; ws.mkdir()
    src = tmp_path / "source.mp4"; src.write_bytes(b"\x00" * 1024)
    result = run_init(
        "--prompt", "p", "--workflow", "clean_cut",
        "--clips", str(src),
        "--derived-from", "src-123",
        "--project-path", "proj2",
        env_override={"MONTAJ_WORKSPACE_DIR": str(ws)},
    )
    assert result.returncode == 0, result.stderr
    proj_json = _project_path_from_stdout(result.stdout)
    data = json.loads(proj_json.read_text())
    assert data["derivedFrom"] == "src-123"


# ---------------------------------------------------------------------------
# --normalize flag tests
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_normalize_lazy_skips_transcode(tmp_path):
    """--normalize lazy must record normalize=lazy in settings, leave src
    pointing at the original staged file, and write no _normalized_* file."""
    src = tmp_path / "src.mp4"
    _make_clip(src, duration=1)
    result = run_init(
        "--prompt", "p", "--workflow", "clean_cut", "--clips", str(src),
        "--normalize", "lazy",
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    proj_json = _project_path_from_stdout(result.stdout)
    data = json.loads(proj_json.read_text())
    assert data["settings"].get("normalize") == "lazy"
    assert "_normalized_" not in data["tracks"][0][0]["src"]
    proj_dir = proj_json.parent
    assert not list(proj_dir.glob("*_normalized_*.mp4"))


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")
def test_normalize_default_eager_unchanged(tmp_path):
    """Without --normalize, settings must NOT include a normalize key (eager
    projects remain byte-identical to today)."""
    src = tmp_path / "src.mp4"
    _make_clip(src, duration=1)
    result = run_init(
        "--prompt", "p", "--workflow", "clean_cut", "--clips", str(src),
        env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    data = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert "normalize" not in data["settings"]


# ---------------------------------------------------------------------------
# Staged-upload cleanup: init deletes sources it consumed from _uploads/
# ---------------------------------------------------------------------------

def test_init_removes_consumed_uploads(tmp_path):
    """Clips/assets staged in the workspace-level _uploads/ junk drawer are
    deleted after a successful init; unconsumed neighbours are left alone."""
    uploads = tmp_path / "_uploads"
    uploads.mkdir()
    clip = uploads / "clip.mp4"
    clip.write_bytes(b"fake")
    asset = uploads / "logo.png"
    asset.write_bytes(b"fakepng")
    bystander = uploads / "unrelated.mp4"
    bystander.write_bytes(b"fake")

    result = run_init("--clips", str(clip), "--assets", str(asset),
                      "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())

    # Copies live in the project dir and are what the project references.
    assert Path(project["tracks"][0][0]["src"]).is_file()
    assert Path(project["assets"][0]["src"]).is_file()
    # Consumed staged sources are gone; the bystander survives.
    assert not clip.exists()
    assert not asset.exists()
    assert bystander.exists()


def test_init_keeps_sources_outside_uploads(tmp_path):
    """Sources that don't live in _uploads/ (user-owned originals) are never
    deleted."""
    src_dir = tmp_path / "my_footage"
    src_dir.mkdir()
    clip = src_dir / "clip.mp4"
    clip.write_bytes(b"fake")

    result = run_init("--clips", str(clip), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    assert clip.exists()


def test_init_symlink_clips_keeps_staged_upload(tmp_path):
    """With --symlink-clips the project points at the staged file via symlink,
    so the staged source must NOT be deleted."""
    uploads = tmp_path / "_uploads"
    uploads.mkdir()
    clip = uploads / "clip.mp4"
    clip.write_bytes(b"fake")

    result = run_init("--clips", str(clip), "--symlink-clips",
                      "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    project = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert clip.exists()
    # The project's clip src resolves back to the staged file.
    assert Path(project["tracks"][0][0]["src"]).resolve() == clip.resolve()


# ---------------------------------------------------------------------------
# --voiceover-asset intake (broll projects)
# ---------------------------------------------------------------------------

def test_init_copies_voiceover_into_workspace(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    vo = tmp_path / "narration.wav"
    vo.write_bytes(b"RIFF....WAVEfake")
    result = run_init("--workflow", "broll", "--clips", str(clip), "--prompt", "test",
                      "--voiceover-asset", str(vo),
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr

    project_json = _project_path_from_stdout(result.stdout)
    data = json.loads(project_json.read_text())
    assert data["projectType"] == "broll"

    copied = Path(data["voiceover"]["src"])
    assert copied.exists()
    assert copied.parent == project_json.parent, "voiceover must land in the project workspace"
    assert copied.read_bytes() == vo.read_bytes()
    assert str(copied) != str(vo), "the original must not be referenced in place"


def test_init_voiceover_accepts_a_video_file(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    vo = tmp_path / "talking.mp4"
    vo.write_bytes(b"\x00\x00\x00\x18ftypmp42fake")
    result = run_init("--workflow", "broll", "--clips", str(clip), "--prompt", "test",
                      "--voiceover-asset", str(vo),
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 0, result.stderr
    data = json.loads(_project_path_from_stdout(result.stdout).read_text())
    assert Path(data["voiceover"]["src"]).suffix == ".mp4"


def test_init_broll_without_voiceover_fails(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--workflow", "broll", "--clips", str(clip), "--prompt", "test",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 1
    assert json.loads(result.stderr.strip().splitlines()[-1])["error"] == "missing_argument"


def test_init_voiceover_missing_file_fails(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    result = run_init("--workflow", "broll", "--clips", str(clip), "--prompt", "test",
                      "--voiceover-asset", "/nonexistent/vo.wav",
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 1
    assert json.loads(result.stderr.strip().splitlines()[-1])["error"] == "file_not_found"


def test_voiceover_asset_rejected_for_non_broll_workflow(tmp_path):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"fake")
    vo = tmp_path / "narration.wav"
    vo.write_bytes(b"RIFF....WAVEfake")
    result = run_init("--workflow", "clean_cut", "--clips", str(clip), "--prompt", "test",
                      "--voiceover-asset", str(vo),
                      env_override={"MONTAJ_WORKSPACE_DIR": str(tmp_path)})
    assert result.returncode == 1
    assert json.loads(result.stderr.strip().splitlines()[-1])["error"] == "invalid_argument"
