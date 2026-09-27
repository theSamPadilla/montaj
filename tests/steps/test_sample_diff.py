"""Tests for steps/render/sample_diff.py.

Pure Pillow (no ffmpeg, no Puppeteer): builds tiny solid-colour PNG fixtures
by hand so every case is exact and fast. Covers the two independent signals
(pops, jumps), the two-frame loop-seam form, the repeated-flag vs single-flag
argv forms HTTP/MCP vs. a human typist produce, and a size mismatch.
"""
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image

from tests.conftest import REPO_ROOT, assert_error

STEP = REPO_ROOT / "steps" / "render" / "sample_diff.py"


def _run(*args, timeout=30) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(STEP), *args],
        capture_output=True, text=True, timeout=timeout,
    )


def _solid(tmp_path: Path, name: str, luma: int, size=(16, 16)) -> str:
    """Write a solid-grey PNG (all pixels == luma) and return its path."""
    path = tmp_path / name
    Image.new("RGB", size, (luma, luma, luma)).save(path)
    return str(path)


# ── identical / shifted (two-frame loop-seam form) ──────────────────────────

def test_identical_frames_diff_is_zero(tmp_path):
    a = _solid(tmp_path, "a.png", 100)
    b = _solid(tmp_path, "b.png", 100)
    proc = _run("--frames", a, b)
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)
    assert data == {"diff": 0.0, "pops": [], "jumps": []}


def test_solid_shift_reports_exact_luma_diff(tmp_path):
    a = _solid(tmp_path, "a.png", 100)
    b = _solid(tmp_path, "b.png", 110)
    proc = _run("--frames", a, b)
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)
    assert data["diff"] == 10.0
    assert data["pops"] == []
    assert data["jumps"] == []


# ── single-frame pop (and its negative control) ─────────────────────────────

def test_single_bad_middle_frame_is_flagged_as_pop(tmp_path):
    """A A B A A: the middle B is a one-frame pop, not a jump."""
    a0 = _solid(tmp_path, "a0.png", 0)
    a1 = _solid(tmp_path, "a1.png", 0)
    b = _solid(tmp_path, "b.png", 100)
    a3 = _solid(tmp_path, "a3.png", 0)
    a4 = _solid(tmp_path, "a4.png", 0)

    proc = _run("--frames", a0, a1, b, a3, a4)
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)

    assert len(data["pops"]) == 1
    assert data["pops"][0]["frame"] == 2
    assert data["pops"][0]["path"] == b
    assert data["jumps"] == []


def test_negative_control_no_bad_frame_no_pop(tmp_path):
    """Same sequence with the suspect frame replaced by A: no pop, no jump."""
    frames = [_solid(tmp_path, f"a{i}.png", 0) for i in range(5)]
    proc = _run("--frames", *frames)
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)
    assert data["pops"] == []
    assert data["jumps"] == []


# ── clean cut (jump, not a pop) ──────────────────────────────────────────────

def test_clean_cut_is_flagged_as_jump_not_pop(tmp_path):
    """A A B B B: one pair carries the whole change; it's a jump, not a pop."""
    a0 = _solid(tmp_path, "a0.png", 0)
    a1 = _solid(tmp_path, "a1.png", 0)
    b0 = _solid(tmp_path, "b0.png", 100)
    b1 = _solid(tmp_path, "b1.png", 100)
    b2 = _solid(tmp_path, "b2.png", 100)

    proc = _run("--frames", a0, a1, b0, b1, b2)
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)

    assert data["pops"] == []
    assert len(data["jumps"]) == 1
    assert data["jumps"][0]["pair"] == 1


# ── smooth motion: neither signal fires ─────────────────────────────────────

def test_smooth_ramp_flags_nothing(tmp_path):
    frames = [_solid(tmp_path, f"f{i}.png", i * 20) for i in range(5)]
    proc = _run("--frames", *frames)
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)
    assert data["pops"] == []
    assert data["jumps"] == []


# ── repeated-flag vs single-flag argv forms ─────────────────────────────────

def test_repeated_and_single_flag_forms_agree(tmp_path):
    frames = [_solid(tmp_path, f"f{i}.png", i * 20) for i in range(5)]

    single = _run("--frames", *frames)
    repeated_args = []
    for f in frames:
        repeated_args += ["--frames", f]
    repeated = _run(*repeated_args)

    assert single.returncode == 0, single.stderr
    assert repeated.returncode == 0, repeated.stderr
    assert json.loads(single.stdout) == json.loads(repeated.stdout)


def test_mixed_repeated_and_grouped_flags_agree(tmp_path):
    """--frames a --frames b c matches --frames a b c (append + nargs='+')."""
    a = _solid(tmp_path, "a.png", 0)
    b = _solid(tmp_path, "b.png", 50)
    c = _solid(tmp_path, "c.png", 100)

    grouped = _run("--frames", a, b, c)
    mixed = _run("--frames", a, "--frames", b, c)

    assert grouped.returncode == 0, grouped.stderr
    assert mixed.returncode == 0, mixed.stderr
    assert json.loads(grouped.stdout) == json.loads(mixed.stdout)


# ── size mismatch ─────────────────────────────────────────────────────────────

def test_size_mismatch_fails_cleanly(tmp_path):
    a = _solid(tmp_path, "a.png", 0, size=(16, 16))
    b = _solid(tmp_path, "b.png", 0, size=(32, 16))
    proc = _run("--frames", a, b)
    assert_error(proc, "size_mismatch")


# ── --out writes the file and prints a path ─────────────────────────────────

def test_out_writes_json_file_and_prints_path(tmp_path):
    a = _solid(tmp_path, "a.png", 0)
    b = _solid(tmp_path, "b.png", 10)
    out = tmp_path / "diff.json"
    proc = _run("--frames", a, b, "--out", str(out))
    assert proc.returncode == 0, proc.stderr
    printed = json.loads(proc.stdout)
    assert printed == {"path": str(out)}
    assert out.exists()
    on_disk = json.loads(out.read_text())
    assert on_disk["diff"] == 10.0


# ── requires at least 2 frames ──────────────────────────────────────────────

def test_single_frame_is_an_error(tmp_path):
    a = _solid(tmp_path, "a.png", 0)
    proc = _run("--frames", a)
    assert_error(proc, "invalid_args")
