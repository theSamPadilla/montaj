"""Unit and integration tests for steps/materialize_cut.py"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "steps" / "transform"))
from materialize_cut import build_ffmpeg_args, compute_keeps

from tests.conftest import assert_error, assert_file_output, run_step


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
