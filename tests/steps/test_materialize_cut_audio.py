"""Tests for materialize_cut's audio-only mode."""
import json
import subprocess

import pytest

from tests.conftest import HAS_FFMPEG, run_step

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")


def _probe(path, entries, stream):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", stream,
         "-show_entries", entries, "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=True)
    return r.stdout.strip()


@pytest.fixture(scope="module")
def tone_wav(tmp_path_factory):
    """6 seconds of tone."""
    out = tmp_path_factory.mktemp("mc_audio") / "tone.wav"
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
        "-ar", "48000", "-ac", "1", str(out),
    ], check=True, capture_output=True)
    return out


@pytest.fixture(scope="module")
def spec(tone_wav, tmp_path_factory):
    """Keep 0-2s and 4-6s: a 4s result."""
    out = tmp_path_factory.mktemp("mc_spec") / "spec.json"
    out.write_text(json.dumps({"input": str(tone_wav), "keeps": [[0.0, 2.0], [4.0, 6.0]]}))
    return out


def test_audio_mode_produces_wav_of_expected_duration(spec, tmp_path):
    out = tmp_path / "clean.wav"
    proc = run_step("materialize_cut.py", "--input", str(spec), "--audio", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert proc.stdout.strip() == str(out)
    assert out.exists() and out.stat().st_size > 0
    assert float(_probe(out, "format=duration", "a:0")) == pytest.approx(4.0, abs=0.15)


def test_audio_mode_output_has_no_video_stream(spec, tmp_path):
    out = tmp_path / "clean.wav"
    proc = run_step("materialize_cut.py", "--input", str(spec), "--audio", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert _probe(out, "stream=codec_type", "v") == ""


def test_audio_mode_defaults_to_wav_extension(spec, tmp_path):
    """With no --out, audio mode writes <base>_cut.wav, not .mp4."""
    src = tmp_path / "in.json"
    src.write_text(spec.read_text())
    proc = run_step("materialize_cut.py", "--input", str(src), "--audio")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert proc.stdout.strip().endswith("_cut.wav")


def test_audio_mode_m4a_format(spec, tmp_path):
    out = tmp_path / "clean.m4a"
    proc = run_step("materialize_cut.py", "--input", str(spec), "--audio", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert out.exists() and out.stat().st_size > 0
    assert "aac" in _probe(out, "stream=codec_name", "a:0")


def test_video_mode_still_produces_video(test_video, tmp_path):
    """Regression: the existing video path is unchanged."""
    spec_path = tmp_path / "vspec.json"
    spec_path.write_text(json.dumps({"input": str(test_video), "keeps": [[0.0, 1.0]]}))
    out = tmp_path / "cut.mp4"
    proc = run_step("materialize_cut.py", "--input", str(spec_path), "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert _probe(out, "stream=codec_type", "v:0") == "video"


def test_audio_mode_single_keep(tone_wav, tmp_path):
    """The n==1 branch of build_ffmpeg_args must also skip the video chain."""
    spec_path = tmp_path / "one.json"
    spec_path.write_text(json.dumps({"input": str(tone_wav), "keeps": [[1.0, 3.0]]}))
    out = tmp_path / "one.wav"
    proc = run_step("materialize_cut.py", "--input", str(spec_path), "--audio", "--out", str(out))
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    assert float(_probe(out, "format=duration", "a:0")) == pytest.approx(2.0, abs=0.15)
    assert _probe(out, "stream=codec_type", "v") == ""
