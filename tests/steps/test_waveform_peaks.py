"""Tests for steps/audio/waveform_peaks.py"""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

from tests.conftest import HAS_FFMPEG, run_step, assert_error

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")

STEP_PATH = Path(__file__).parent.parent.parent / "steps" / "audio" / "waveform_peaks.py"


@pytest.fixture(scope="module")
def peaks_mod():
    """Import the step module directly for pure-function unit tests (no subprocess)."""
    spec = importlib.util.spec_from_file_location("waveform_peaks", STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def sine_wav(tmp_path_factory):
    """2s pure 440Hz sine at full scale, 44100Hz mono PCM WAV. Lossless source
    so peak amplitudes are predictable (no lossy-codec ripple).

    ffmpeg's lavfi sine source doesn't expose an amplitude option and its
    baseline level varies by build (observed ~-18dBFS on this machine), so
    volume=20 is applied to drive it into hard s16 clipping — a deterministic
    +/-32767 full-scale peak regardless of the source's baseline gain.
    """
    out = tmp_path_factory.mktemp("waveform_peaks") / "sine.wav"
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
        "-af", "volume=20",
        "-c:a", "pcm_s16le", str(out),
    ], check=True, capture_output=True)
    return out


@pytest.fixture(scope="module")
def silence_then_sine_wav(tmp_path_factory):
    """4s WAV: [0,2) pure digital silence, [2,4) full-scale 440Hz sine.

    Lets a windowed fetch (--start/--duration) be verified against ground
    truth — the two halves have unambiguously different amplitude.
    """
    out = tmp_path_factory.mktemp("waveform_peaks") / "silence_then_sine.wav"
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "aevalsrc=0:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
        # volume=20 clips the sine half to full scale (see sine_wav's docstring);
        # applied to the sine input only, ahead of the concat.
        "-filter_complex", "[1:a]volume=20[boosted];[0:a][boosted]concat=n=2:v=0:a=1[a]",
        "-map", "[a]", "-c:a", "pcm_s16le", str(out),
    ], check=True, capture_output=True)
    return out


@pytest.fixture(scope="module")
def stereo_left_sine_wav(tmp_path_factory):
    """2s stereo WAV: left channel full-scale 440Hz sine, right channel silence.

    Verifies the mono mixdown actually averages channels rather than just
    picking one — mixdown amplitude should land around half of a mono
    full-scale sine's amplitude.
    """
    out = tmp_path_factory.mktemp("waveform_peaks") / "stereo.wav"
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
        "-f", "lavfi", "-i", "aevalsrc=0:d=2",
        # volume=20 clips the sine input to full scale (see sine_wav's
        # docstring). amerge then stacks each (mono) input's channels in
        # input order, giving a deterministic left=input0/right=input1 --
        # unlike `join`, which has to guess channel names with no explicit map.
        "-filter_complex", "[0:a]volume=20[l];[l][1:a]amerge=inputs=2[a]",
        "-map", "[a]", "-ac", "2", "-c:a", "pcm_s16le", str(out),
    ], check=True, capture_output=True)
    return out


@pytest.fixture(scope="module")
def long_sine_wav(tmp_path_factory):
    """650s sine — long enough that samples-per-second=800 (800*650=520,000)
    exceeds the 500k-pair clamp, forcing a step-down to 200 (200*650=130,000)."""
    out = tmp_path_factory.mktemp("waveform_peaks") / "long_sine.wav"
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=650",
        "-c:a", "pcm_s16le", str(out),
    ], check=True, capture_output=True)
    return out


# ── pure-function clamp math (fast, no ffmpeg) ────────────────────────────────

def test_choose_resolution_keeps_requested_when_under_clamp(peaks_mod):
    sps, pairs = peaks_mod.choose_resolution(800, 10.0)
    assert sps == 800
    assert pairs == 8000


def test_choose_resolution_steps_down_one_bucket(peaks_mod):
    # 800 * 650 = 520,000 > 500,000 clamp; 200 * 650 = 130,000 fits.
    sps, pairs = peaks_mod.choose_resolution(800, 650.0)
    assert sps == 200
    assert pairs == 130_000


def test_choose_resolution_steps_down_two_buckets(peaks_mod):
    # 800 and 200 both exceed the clamp at this duration; 50 fits.
    # duration where 200*d > 500_000 but 50*d <= 500_000 -> 2600 < d <= 10_000
    sps, pairs = peaks_mod.choose_resolution(800, 3000.0)
    assert sps == 50
    assert pairs == 150_000


def test_choose_resolution_degrades_below_lowest_bucket(peaks_mod):
    # Even the lowest bucket (50) exceeds the clamp at this pathological duration.
    duration = 20_000.0
    sps, pairs = peaks_mod.choose_resolution(800, duration)
    assert sps < 50
    assert pairs == peaks_mod.MAX_PEAK_PAIRS


def test_choose_resolution_never_steps_up(peaks_mod):
    # Requesting 50 never returns 200 or 800, even if there'd be room.
    sps, pairs = peaks_mod.choose_resolution(50, 1.0)
    assert sps == 50


# ── end-to-end CLI ─────────────────────────────────────────────────────────────

def test_waveform_peaks_output_shape(sine_wav):
    proc = run_step("waveform_peaks.py", "--input", str(sine_wav), "--samples-per-second", "50")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert data["samplesPerSecond"] == 50
    assert data["start"] == 0.0
    assert data["duration"] == pytest.approx(2.0, abs=0.05)
    assert isinstance(data["peaks"], list)
    # 2s * 50/s = 100 pairs -> 200 interleaved values.
    assert len(data["peaks"]) == 200


def test_waveform_peaks_default_resolution(sine_wav):
    proc = run_step("waveform_peaks.py", "--input", str(sine_wav))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert data["samplesPerSecond"] == 200


def test_waveform_peaks_sine_envelope_is_near_full_scale(sine_wav):
    """Every bucket spans >1 full period of the 440Hz tone at 50 buckets/sec
    (882 samples/bucket vs ~100 samples/period), so every min/max pair should
    be close to the full int16 range for a full-amplitude sine."""
    proc = run_step("waveform_peaks.py", "--input", str(sine_wav), "--samples-per-second", "50")
    data = json.loads(proc.stdout)
    peaks = data["peaks"]
    mins = peaks[0::2]
    maxs = peaks[1::2]
    assert all(m < -28000 for m in mins)
    assert all(m > 28000 for m in maxs)


def test_waveform_peaks_windowed_fetch_selects_correct_region(silence_then_sine_wav):
    # Silence half: [0, 2).
    silent = run_step("waveform_peaks.py", "--input", str(silence_then_sine_wav),
                      "--start", "0", "--duration", "2", "--samples-per-second", "50")
    assert silent.returncode == 0, f"stderr: {silent.stderr}"
    silent_data = json.loads(silent.stdout)
    assert silent_data["start"] == 0.0
    assert silent_data["duration"] == pytest.approx(2.0, abs=0.05)
    assert all(p == 0 for p in silent_data["peaks"])

    # Sine half: [2, 4).
    loud = run_step("waveform_peaks.py", "--input", str(silence_then_sine_wav),
                    "--start", "2", "--duration", "2", "--samples-per-second", "50")
    assert loud.returncode == 0, f"stderr: {loud.stderr}"
    loud_data = json.loads(loud.stdout)
    assert loud_data["start"] == pytest.approx(2.0, abs=0.01)
    assert loud_data["duration"] == pytest.approx(2.0, abs=0.05)
    assert max(loud_data["peaks"]) > 20000


def test_waveform_peaks_start_without_duration_uses_rest_of_file(silence_then_sine_wav):
    proc = run_step("waveform_peaks.py", "--input", str(silence_then_sine_wav),
                    "--start", "2", "--samples-per-second", "50")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert data["start"] == pytest.approx(2.0, abs=0.01)
    assert data["duration"] == pytest.approx(2.0, abs=0.05)


def test_waveform_peaks_mono_mixdown_averages_channels(stereo_left_sine_wav):
    """Left = full-scale sine, right = silence -> mono mixdown ~ half amplitude
    of a full mono sine (not the full ~32767 the left channel alone would give)."""
    proc = run_step("waveform_peaks.py", "--input", str(stereo_left_sine_wav), "--samples-per-second", "50")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    peaks = json.loads(proc.stdout)["peaks"]
    max_amp = max(peaks)
    assert 12000 < max_amp < 20000


def test_waveform_peaks_batch_outputs_array(sine_wav):
    proc = run_step("waveform_peaks.py", "--inputs", str(sine_wav), str(sine_wav),
                    "--samples-per-second", "50")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert isinstance(result, list)
    assert len(result) == 2
    for entry in result:
        assert "samplesPerSecond" in entry and "peaks" in entry


def test_waveform_peaks_missing_input():
    proc = run_step("waveform_peaks.py", "--input", "/no/file.mp4")
    assert_error(proc, "file_not_found")


def test_waveform_peaks_invalid_samples_per_second_rejected(sine_wav):
    proc = run_step("waveform_peaks.py", "--input", str(sine_wav), "--samples-per-second", "100")
    assert proc.returncode != 0


@pytest.mark.slow
def test_waveform_peaks_clamp_steps_down_end_to_end(long_sine_wav):
    proc = run_step("waveform_peaks.py", "--input", str(long_sine_wav), "--samples-per-second", "800")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    data = json.loads(proc.stdout)
    assert data["samplesPerSecond"] == 200
    assert len(data["peaks"]) == 2 * 130_000
