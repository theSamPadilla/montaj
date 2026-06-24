"""Unit and integration tests for steps/materialize_cut.py"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "steps" / "transform"))
from materialize_cut import build_ffmpeg_args, compute_keeps

from tests.conftest import assert_error, assert_file_output, run_step, HAS_FFMPEG


# ── build_ffmpeg_args unit tests ──────────────────────────────────────────────

def test_single_keep_args_shape():
    spec = {"input": "/v.mp4", "keeps": [[1.0, 3.0]]}
    args, fc = build_ffmpeg_args(spec)
    assert "-i" in args
    assert "/v.mp4" in args
    assert "-ss" in args
    assert "[vout]" in fc
    assert "[aout]" in fc
    assert "aresample" in fc


def test_single_keep_no_concat():
    spec = {"input": "/v.mp4", "keeps": [[0.0, 5.0]]}
    _, fc = build_ffmpeg_args(spec)
    assert "concat" not in fc


def test_multi_keep_uses_concat():
    spec = {"input": "/v.mp4", "keeps": [[0.0, 2.0], [3.0, 5.0]]}
    args, fc = build_ffmpeg_args(spec)
    assert "concat=n=2" in fc
    # Two input segments → two -i flags
    assert args.count("-i") == 2


def test_filter_string_terminates_with_aresample():
    # aresample must be the last filter (handles async audio sync after concat)
    spec = {"input": "/v.mp4", "keeps": [[0.0, 2.0], [3.0, 5.0]]}
    _, fc = build_ffmpeg_args(spec)
    assert fc.endswith("[aout]")
    assert "aresample=async=1000" in fc


def test_multi_source_segments_open_distinct_inputs():
    # Multi-source spec → one -i per segment, each its OWN src, concatenated.
    spec = {"segments": [
        {"src": "/a.mp4", "in": 0.0, "out": 2.0},
        {"src": "/b.mp4", "in": 1.0, "out": 3.0},
    ]}
    args, fc = build_ffmpeg_args(spec)
    assert args.count("-i") == 2
    assert "/a.mp4" in args and "/b.mp4" in args
    assert "concat=n=2" in fc
    assert fc.endswith("[aout]")


def test_single_segment_spec_no_concat():
    spec = {"segments": [{"src": "/a.mp4", "in": 0.0, "out": 2.0}]}
    _, fc = build_ffmpeg_args(spec)
    assert "concat" not in fc
    assert "[vout]" in fc


# ── compute_keeps unit tests ───────────────────────────────────────────────────

def test_compute_keeps_basic():
    # Cut [1,2] from a 5s clip → keeps [0,1] and [2,5]
    result = compute_keeps(5.0, [[1.0, 2.0]])
    assert result == [[0.0, 1.0], [2.0, 5.0]]


def test_compute_keeps_multiple_cuts():
    result = compute_keeps(10.0, [[1.0, 2.0], [5.0, 7.0]])
    assert result == [[0.0, 1.0], [2.0, 5.0], [7.0, 10.0]]


def test_compute_keeps_edge_cut_ignored():
    # Cut starts at 0 — the left edge keep is dropped (within edge threshold)
    result = compute_keeps(5.0, [[0.0, 1.0]])
    assert result == [[1.0, 5.0]]


def test_compute_keeps_covers_all_fails():
    # Cutting the entire clip should fail with SystemExit
    with pytest.raises(SystemExit):
        compute_keeps(5.0, [[0.0, 5.0]])


# ── integration tests (require ffmpeg via test_video fixture) ─────────────────

def test_materialize_from_trim_spec(tmp_path, test_video):
    spec = {"input": str(test_video), "keeps": [[0.0, 1.0], [1.5, 3.0]]}
    p = tmp_path / "spec.json"
    p.write_text(json.dumps(spec))
    out = tmp_path / "out.mp4"

    proc = run_step("materialize_cut.py", "--input", str(p), "--out", str(out))
    assert proc.returncode == 0, proc.stderr
    assert_file_output(proc)


def test_materialize_multi_source_segments(tmp_path, test_video):
    # A multi-source cut (two distinct files) composes into one mp4.
    import shutil
    second = tmp_path / "second.mp4"
    shutil.copy(test_video, second)
    spec = {"segments": [
        {"src": str(test_video), "in": 0.0, "out": 1.0},
        {"src": str(second),     "in": 0.5, "out": 1.5},
    ]}
    p = tmp_path / "cut.json"
    p.write_text(json.dumps(spec))
    out = tmp_path / "out.mp4"

    proc = run_step("materialize_cut.py", "--input", str(p), "--out", str(out))
    assert proc.returncode == 0, proc.stderr
    assert_file_output(proc)


def test_materialize_missing_segment_source_errors(tmp_path, test_video):
    # A segment pointing at a missing file fails cleanly (require_file).
    spec = {"segments": [
        {"src": str(test_video), "in": 0.0, "out": 1.0},
        {"src": "/no/such/file.mp4", "in": 0.0, "out": 1.0},
    ]}
    p = tmp_path / "cut.json"
    p.write_text(json.dumps(spec))
    proc = run_step("materialize_cut.py", "--input", str(p), "--out", str(tmp_path / "o.mp4"))
    assert_error(proc)


def test_materialize_trims_to_duration(tmp_path, test_video):
    spec = {"input": str(test_video), "keeps": [[0.0, 1.0]]}
    p = tmp_path / "spec.json"
    p.write_text(json.dumps(spec))
    out = tmp_path / "out.mp4"

    proc = run_step("materialize_cut.py", "--input", str(p), "--out", str(out))
    assert proc.returncode == 0, proc.stderr

    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(out)],
        capture_output=True, text=True
    )
    duration = float(result.stdout.strip())
    assert 0.7 <= duration <= 1.4


def test_materialize_inpoint_outpoint(tmp_path, test_video):
    out = tmp_path / "out.mp4"
    proc = run_step(
        "materialize_cut.py",
        "--input", str(test_video),
        "--inpoint", "0.5", "--outpoint", "2.0",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    assert_file_output(proc)


def test_materialize_cuts_from_raw_video(tmp_path, test_video):
    out = tmp_path / "out.mp4"
    proc = run_step(
        "materialize_cut.py",
        "--input", str(test_video),
        "--cuts", "[[1.0,1.5]]",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    assert_file_output(proc)


def test_materialize_inpoint_and_cuts_combined(tmp_path, test_video):
    # --inpoint 0.5 clips the window to [0.5, 3.0], then --cuts [[1.5, 2.0]]
    # removes that range → keeps [[0.5, 1.5], [2.0, 3.0]]
    out = tmp_path / "out.mp4"
    proc = run_step(
        "materialize_cut.py",
        "--input", str(test_video),
        "--inpoint", "0.5",
        "--cuts", "[[1.5,2.0]]",
        "--out", str(out),
    )
    assert proc.returncode == 0, proc.stderr
    assert_file_output(proc)


def test_materialize_missing_input():
    proc = run_step("materialize_cut.py", "--input", "/no/such.mp4")
    assert_error(proc)


# ── concat normalisation unit tests ──────────────────────────────────────────

def test_concat_inputs_are_conformed():
    """Multi-segment spec → every input has yuv420p, setsar=1, aformat conforming."""
    spec = {"input": "/v.mp4", "keeps": [[0.0, 1.0], [2.0, 3.0]]}
    _, fc = build_ffmpeg_args(spec)
    assert "format=yuv420p" in fc
    assert "setsar=1" in fc
    assert "aformat=sample_rates=48000" in fc


def test_concat_inputs_are_conformed_multi_source():
    """Multi-source segments spec also conforms every input."""
    spec = {"segments": [
        {"src": "/a.mp4", "in": 0.0, "out": 1.0},
        {"src": "/b.mp4", "in": 0.5, "out": 1.5},
    ]}
    _, fc = build_ffmpeg_args(spec)
    assert "format=yuv420p" in fc
    assert "setsar=1" in fc
    assert "aformat=sample_rates=48000" in fc


def test_scale_spec_scales_and_pads_each_input():
    """scale key → scale+pad appear once per input segment."""
    spec = {"segments": [
        {"src": "/a.mp4", "in": 0.0, "out": 1.0},
        {"src": "/b.mp4", "in": 0.5, "out": 1.5},
    ], "scale": [360, 640]}
    _, fc = build_ffmpeg_args(spec)
    assert fc.count("scale=360:640:force_original_aspect_ratio=decrease") == 2
    assert fc.count("pad=360:640:") == 2


def test_no_scale_key_means_no_scale_filter():
    """Without scale key, scale= and pad= are absent; conforming still happens."""
    spec = {"segments": [
        {"src": "/a.mp4", "in": 0.0, "out": 1.0},
        {"src": "/b.mp4", "in": 0.5, "out": 1.5},
    ]}
    _, fc = build_ffmpeg_args(spec)
    assert "scale=" not in fc
    assert "pad=" not in fc
    # Conforming without resize must still be present
    assert "format=yuv420p" in fc
    assert "setsar=1" in fc


# ── concat normalisation integration test ────────────────────────────────────

def test_materialize_differing_sar_and_pixfmt(tmp_path, test_video):
    """Two clips with different SAR / pixel format must concat cleanly (exit 0).

    This is the regression test for the "Input link parameters do not match"
    ffmpeg error that previously caused materialize_cut to exit 1.
    """
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg not available")

    import subprocess as sp

    # clip_a: yuv422p, SAR 4:3, 44100 Hz mono audio
    # (unusual pixel format, non-square SAR, non-standard sample rate)
    clip_a = tmp_path / "clip_a.mp4"
    sp.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "color=c=blue:s=640x480:r=30",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", "1",
        "-vf", "setsar=4/3",
        "-c:v", "libx264", "-pix_fmt", "yuv422p",
        "-c:a", "aac",
        str(clip_a),
    ], check=True, capture_output=True)

    # clip_b: default yuv420p, SAR 1:1, 48000 Hz stereo audio
    # Same display resolution as clip_a (640x480) — only SAR/pixfmt/audio differ.
    clip_b = tmp_path / "clip_b.mp4"
    sp.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "color=c=red:s=640x480:r=30",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
        "-t", "1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        str(clip_b),
    ], check=True, capture_output=True)

    spec = {"segments": [
        {"src": str(clip_a), "in": 0.0, "out": 1.0},
        {"src": str(clip_b), "in": 0.0, "out": 1.0},
    ]}
    spec_path = tmp_path / "cut.json"
    spec_path.write_text(json.dumps(spec))
    out = tmp_path / "out.mp4"

    proc = run_step("materialize_cut.py", "--input", str(spec_path), "--out", str(out))
    assert proc.returncode == 0, f"materialize_cut failed (exit {proc.returncode}):\n{proc.stderr}"
    assert_file_output(proc)
