"""Tests for steps/normalize.py"""
import json
import subprocess
import sys

import pytest
from tests.conftest import REPO_ROOT, run_step, assert_file_output, assert_error

sys.path.insert(0, str(REPO_ROOT / "lib"))
from trim_spec import audio_extract_cmd  # noqa: E402  (mono/16k extraction helper, for the fidelity test)


def test_normalize_youtube(test_video, tmp_path):
    out = tmp_path / "norm.mp4"
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "youtube", "--out", str(out))
    assert_file_output(proc)


def test_normalize_podcast(test_video, tmp_path):
    out = tmp_path / "norm.mp4"
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "podcast", "--out", str(out))
    assert_file_output(proc)


def test_normalize_custom_lufs(test_video, tmp_path):
    out = tmp_path / "norm.mp4"
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "custom", "--lufs", "-16", "--out", str(out))
    assert_file_output(proc)


def test_normalize_auto_output_path(test_video):
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "youtube")
    out = assert_file_output(proc)
    assert "_normalized" in out.name


def test_normalize_missing_input():
    proc = run_step("normalize.py", "--input", "/no/file.mp4", "--target", "youtube")
    assert_error(proc, "file_not_found")


# ── measure-only ──────────────────────────────────────────────────────────────

def test_normalize_measure_only_prints_stats_and_writes_no_file(test_video, tmp_path):
    # Copy into an isolated dir: test_video is session-scoped and other tests
    # in this file legitimately write a "<name>_normalized<ext>" sibling next
    # to it, which would make an existence check here order-dependent.
    isolated = tmp_path / test_video.name
    isolated.write_bytes(test_video.read_bytes())

    proc = run_step("normalize.py", "--input", str(isolated), "--target", "youtube", "--measure-only")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    stats = json.loads(proc.stdout)
    for key in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset", "target_i"):
        assert key in stats, f"missing {key} in {stats}"
    float(stats["input_i"])  # parseable
    assert stats["target_i"] == -14

    normalized = isolated.parent / f"{isolated.stem}_normalized{isolated.suffix}"
    assert not normalized.exists(), "measure-only must not write a pass-2 output file"


def test_normalize_measure_only_values_are_numbers_not_strings(test_video):
    """ffmpeg's loudnorm filter (print_format=json) emits its pass-1
    measurements as JSON *strings*. normalize.py must coerce them to real
    numbers before printing -- every downstream consumer (HTTP API, MCP, CLI,
    the editor adapter) inherits whatever type lands here, and a string
    silently "works" in JS via operator coercion right up until something
    calls .toFixed() on it and crashes (see montajAdapter.ts's `loudness`
    case, and AudioPolishModal.tsx which calls .toFixed() on these fields)."""
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "youtube", "--measure-only")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    stats = json.loads(proc.stdout)
    for key in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset", "target_i"):
        assert isinstance(stats[key], (int, float)), f"{key} is {type(stats[key]).__name__}, not a number: {stats}"


def test_normalize_measure_only_resolves_custom_target_i(test_video):
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "custom", "--lufs", "-19",
                    "--measure-only")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    stats = json.loads(proc.stdout)
    assert stats["target_i"] == -19


def test_normalize_measure_only_does_not_require_out(test_video):
    """--out is meaningless in measure-only mode and must not be required."""
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "youtube", "--measure-only")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"


# ── windowed measurement ──────────────────────────────────────────────────────

def test_normalize_window_flags_require_both(test_video):
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "youtube",
                    "--measure-only", "--window-in", "0.5")
    assert_error(proc, "invalid_args")

    proc = run_step("normalize.py", "--input", str(test_video), "--target", "youtube",
                    "--measure-only", "--window-out", "2.5")
    assert_error(proc, "invalid_args")


def test_normalize_window_without_measure_only_is_rejected(test_video):
    """Windowed *encoding* is out of scope — a window without --measure-only is a clear error."""
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "youtube",
                    "--window-in", "0.0", "--window-out", "1.0")
    assert_error(proc, "invalid_args")


def test_normalize_windowed_measure_only_prints_stats(test_video):
    proc = run_step("normalize.py", "--input", str(test_video), "--target", "youtube",
                    "--measure-only", "--window-in", "0.5", "--window-out", "2.5")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    stats = json.loads(proc.stdout)
    assert "input_i" in stats
    float(stats["input_i"])


# ── silent input: ffmpeg's -inf/+inf edge case ────────────────────────────────

@pytest.fixture(scope="session")
def silent_test_audio(tmp_path_factory):
    """3s of pure digital silence. ffmpeg's loudnorm filter measures this as
    input_i = "-inf" and input_tp = "-inf" (confirmed empirically), and
    target_offset = "inf" -- the exact case normalize.py must floor/ceil to
    a finite number, since json.dumps() would otherwise write the bare,
    JSON-invalid tokens -Infinity/Infinity that no JS JSON.parse can read."""
    d = tmp_path_factory.mktemp("silent_audio")
    out = d / "silent.wav"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
            "-t", "3",
            "-c:a", "pcm_s16le",
            str(out),
        ],
        check=True, capture_output=True,
    )
    return out


def test_normalize_measure_only_silent_input_emits_strict_finite_json(silent_test_audio):
    proc = run_step("normalize.py", "--input", str(silent_test_audio), "--target", "youtube",
                    "--measure-only")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    # The real regression check: Python's own json.loads is lenient and would
    # happily accept a bare -Infinity/Infinity/NaN token (non-standard
    # extension), masking this bug if we only checked json.loads() succeeds.
    # A JS JSON.parse would reject those tokens outright, so assert they
    # never appear in the raw output.
    assert "Infinity" not in proc.stdout and "NaN" not in proc.stdout, (
        f"measure-only JSON must be strict, finite JSON for a JS JSON.parse "
        f"to consume: {proc.stdout}"
    )
    stats = json.loads(proc.stdout)
    for key in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset", "target_i"):
        assert isinstance(stats[key], (int, float)), f"{key} is {type(stats[key]).__name__}, not a number: {stats}"
    # input_i and input_tp measured -inf on silent input -> floored to -70.0
    # (mirroring ffmpeg's own -70 LUFS absolute silence-gate threshold).
    assert stats["input_i"] == -70.0
    assert stats["input_tp"] == -70.0
    # target_offset measured +inf on silent input -> ceilinged to +70.0.
    assert stats["target_offset"] == 70.0


# ── fidelity trap regression ──────────────────────────────────────────────────

@pytest.fixture(scope="session")
def stereo_test_audio(tmp_path_factory):
    """5s stereo 48kHz wav: full-level 1kHz tone on the left channel, silence
    on the right. The channel imbalance means a mono downmix measures
    materially different loudness than a true stereo BS.1770 measurement —
    exactly the fidelity trap `normalize --window-in/--window-out` must avoid
    by measuring the source directly instead of via `audio_extract_cmd`."""
    d = tmp_path_factory.mktemp("stereo_audio")
    out = d / "stereo.wav"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
            "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
            "-filter_complex", "[0:a][1:a]amerge=inputs=2[a]",
            "-map", "[a]",
            "-t", "5",
            "-c:a", "pcm_s16le",
            str(out),
        ],
        check=True, capture_output=True,
    )
    return out


def test_normalize_windowed_measure_stereo_differs_materially_from_mono_downmix(stereo_test_audio, tmp_path):
    # Windowed measurement directly on the stereo/48kHz source.
    proc = run_step("normalize.py", "--input", str(stereo_test_audio), "--target", "youtube",
                    "--measure-only", "--window-in", "0.0", "--window-out", "5.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    stereo_i = float(json.loads(proc.stdout)["input_i"])

    # The same window, measured through a mono/16kHz whisper-style extraction.
    extracted = tmp_path / "extracted.wav"
    r = subprocess.run(
        audio_extract_cmd(str(stereo_test_audio), [[0.0, 5.0]], str(extracted)),
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr

    proc2 = run_step("normalize.py", "--input", str(extracted), "--target", "youtube", "--measure-only")
    assert proc2.returncode == 0, f"stderr: {proc2.stderr}"
    mono_i = float(json.loads(proc2.stdout)["input_i"])

    diff = abs(stereo_i - mono_i)
    assert diff > 3.0, (
        f"expected a materially different input_i between stereo/48k ({stereo_i}) and "
        f"mono/16k-downmix ({mono_i}) measurement of the same window — got only {diff} LU apart"
    )
