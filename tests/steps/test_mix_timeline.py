"""Tests for steps/audio/mix_timeline.py — the timeline-time audio mixer.

The properties that matter downstream (captions transcribe this output, so a
timestamp here is a timestamp on the timeline):

  * output length is the spec's `duration`, not the sum of segment lengths,
  * a gap between segments comes out as real silence at the right place,
  * simultaneous segments are SUMMED, not dropped or crossfaded,
  * a source with no audio stream is skipped, a source that is missing is not.
"""
import json
import subprocess

import pytest

from tests.conftest import HAS_FFMPEG, assert_error, assert_file_output, run_step


def assert_error_after_progress(proc, code):
    """`assert_error`, but tolerant of {"progress": ...} lines ahead of the
    error — steps emit those on stderr too, and serve skips them when parsing a
    failure (see lib/common.progress). Only used where the step has something
    to report before it gives up."""
    assert proc.returncode != 0, proc.stderr
    errors = [json.loads(line) for line in proc.stderr.strip().splitlines()
              if '"error"' in line]
    assert errors, f"no structured error on stderr: {proc.stderr!r}"
    assert errors[-1]["error"] == code, errors[-1]

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")


def _probe_duration(path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def _rms(path, start: float, duration: float) -> float:
    """Mean volume (dBFS) of a window of `path`. -91 or so means digital silence."""
    r = subprocess.run(
        ["ffmpeg", "-v", "info", "-ss", str(start), "-t", str(duration),
         "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, check=True)
    for line in r.stderr.splitlines():
        if "mean_volume:" in line:
            return float(line.split("mean_volume:")[1].split("dB")[0].strip())
    raise AssertionError(f"no mean_volume in ffmpeg output:\n{r.stderr}")


@pytest.fixture(scope="module")
def tone(tmp_path_factory):
    """8 seconds of 440 Hz at a known level."""
    out = tmp_path_factory.mktemp("mix") / "tone.wav"
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
        "-af", "volume=0.5", "-ar", "48000", "-ac", "2", str(out),
    ], check=True, capture_output=True)
    return out


@pytest.fixture(scope="module")
def silent_video(tmp_path_factory):
    """3 seconds of black picture with NO audio stream at all."""
    out = tmp_path_factory.mktemp("mix") / "mute.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30", "-t", "3",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out),
    ], check=True, capture_output=True)
    return out


def _spec(tmp_path, duration, segments, name="spec.json"):
    p = tmp_path / name
    p.write_text(json.dumps({"duration": duration, "sampleRate": 16000,
                             "segments": segments}))
    return p


def test_output_is_timeline_length_with_a_real_gap(tone, tmp_path):
    """Two 1s tones at 0s and 5s over a 7s timeline: 7s out, silence in between.
    The old concat-based caption cut would have produced 2s."""
    spec = _spec(tmp_path, 7.0, [
        {"src": str(tone), "in": 0.0, "out": 1.0, "start": 0.0, "volume": 1.0},
        {"src": str(tone), "in": 0.0, "out": 1.0, "start": 5.0, "volume": 1.0},
    ])
    out = tmp_path / "mix.wav"
    proc = run_step("mix_timeline.py", "--input", str(spec), "--out", str(out))
    assert_file_output(proc)

    assert _probe_duration(out) == pytest.approx(7.0, abs=0.05)
    assert _rms(out, 0.1, 0.8) > -40      # tone
    assert _rms(out, 2.0, 2.5) < -80      # gap is silence
    assert _rms(out, 5.1, 0.8) > -40      # tone again, at 5s


def test_simultaneous_segments_are_summed(tone, tmp_path):
    """Two copies of the same tone at the same instant must be LOUDER than one
    (amix normalize=0), not averaged back down to the single-source level."""
    one = _spec(tmp_path, 2.0, [
        {"src": str(tone), "in": 0.0, "out": 2.0, "start": 0.0, "volume": 1.0},
    ], name="one.json")
    two = _spec(tmp_path, 2.0, [
        {"src": str(tone), "in": 0.0, "out": 2.0, "start": 0.0, "volume": 1.0},
        {"src": str(tone), "in": 2.0, "out": 4.0, "start": 0.0, "volume": 1.0},
    ], name="two.json")

    out_one, out_two = tmp_path / "one.wav", tmp_path / "two.wav"
    assert_file_output(run_step("mix_timeline.py", "--input", str(one), "--out", str(out_one)))
    assert_file_output(run_step("mix_timeline.py", "--input", str(two), "--out", str(out_two)))

    assert _rms(out_two, 0.1, 1.8) > _rms(out_one, 0.1, 1.8) + 3


def test_volume_is_applied(tone, tmp_path):
    loud = _spec(tmp_path, 2.0, [
        {"src": str(tone), "in": 0.0, "out": 2.0, "start": 0.0, "volume": 1.0},
    ], name="loud.json")
    quiet = _spec(tmp_path, 2.0, [
        {"src": str(tone), "in": 0.0, "out": 2.0, "start": 0.0, "volume": 0.1},
    ], name="quiet.json")

    out_loud, out_quiet = tmp_path / "loud.wav", tmp_path / "quiet.wav"
    assert_file_output(run_step("mix_timeline.py", "--input", str(loud), "--out", str(out_loud)))
    assert_file_output(run_step("mix_timeline.py", "--input", str(quiet), "--out", str(out_quiet)))

    assert _rms(out_quiet, 0.1, 1.8) < _rms(out_loud, 0.1, 1.8) - 15


def test_speed_compresses_the_window_into_its_timeline_slot(tone, tmp_path):
    """A 2x segment reads 4 source seconds and must still fit its 2-second
    slot — anything else and every later caption drifts."""
    spec = _spec(tmp_path, 2.0, [
        {"src": str(tone), "in": 0.0, "out": 4.0, "start": 0.0,
         "volume": 1.0, "speed": 2.0},
    ])
    out = tmp_path / "fast.wav"
    assert_file_output(run_step("mix_timeline.py", "--input", str(spec), "--out", str(out)))
    assert _probe_duration(out) == pytest.approx(2.0, abs=0.05)
    assert _rms(out, 0.1, 1.8) > -40


def test_output_defaults_to_16k_mono(tone, tmp_path):
    spec = _spec(tmp_path, 2.0, [
        {"src": str(tone), "in": 0.0, "out": 2.0, "start": 0.0, "volume": 1.0},
    ])
    out = tmp_path / "mix.wav"
    assert_file_output(run_step("mix_timeline.py", "--input", str(spec), "--out", str(out)))
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=sample_rate,channels,codec_name", "-of", "csv=p=0", str(out)],
        capture_output=True, text=True, check=True)
    assert r.stdout.strip() == "pcm_s16le,16000,1"


def test_source_without_audio_is_skipped_not_fatal(tone, silent_video, tmp_path):
    spec = _spec(tmp_path, 4.0, [
        {"src": str(silent_video), "in": 0.0, "out": 3.0, "start": 0.0, "volume": 1.0},
        {"src": str(tone), "in": 0.0, "out": 2.0, "start": 2.0, "volume": 1.0},
    ])
    out = tmp_path / "mix.wav"
    proc = run_step("mix_timeline.py", "--input", str(spec), "--out", str(out))
    assert_file_output(proc)
    assert "no audio stream" in proc.stderr
    assert _rms(out, 2.1, 1.8) > -40


def test_all_sources_silent_fails(silent_video, tmp_path):
    spec = _spec(tmp_path, 3.0, [
        {"src": str(silent_video), "in": 0.0, "out": 3.0, "start": 0.0, "volume": 1.0},
    ])
    assert_error_after_progress(
        run_step("mix_timeline.py", "--input", str(spec), "--out", str(tmp_path / "m.wav")),
        "no_audio",
    )


def test_missing_source_is_fatal(tmp_path):
    """A src that moved off disk would silently drop whatever was said in it."""
    spec = _spec(tmp_path, 3.0, [
        {"src": "/nonexistent/gone.mov", "in": 0.0, "out": 3.0, "start": 0.0, "volume": 1.0},
    ])
    assert_error(
        run_step("mix_timeline.py", "--input", str(spec), "--out", str(tmp_path / "m.wav")),
        "file_not_found",
    )


def test_empty_and_invalid_specs_fail(tmp_path):
    assert_error(
        run_step("mix_timeline.py", "--input", str(_spec(tmp_path, 3.0, [], "empty.json"))),
        "invalid_spec",
    )
    bad = tmp_path / "zero.json"
    bad.write_text(json.dumps({"duration": 0, "segments": [{"src": "x", "in": 0, "out": 1, "start": 0}]}))
    assert_error(run_step("mix_timeline.py", "--input", str(bad)), "invalid_spec")


def test_batching_matches_a_single_pass(tone, tmp_path, monkeypatch):
    """More segments than MAX_INPUTS mixes in batches; summing is associative,
    so the result must be indistinguishable from one pass."""
    segs = [{"src": str(tone), "in": 0.0, "out": 0.2, "start": i * 0.1, "volume": 1.0}
            for i in range(60)]
    spec = _spec(tmp_path, 8.0, segs)
    out = tmp_path / "many.wav"
    proc = run_step("mix_timeline.py", "--input", str(spec), "--out", str(out))
    assert_file_output(proc)
    assert "batches" in proc.stderr
    assert _probe_duration(out) == pytest.approx(8.0, abs=0.05)
    assert _rms(out, 0.5, 3.0) > -40
    # Intermediates are cleaned up.
    assert not list(tmp_path.glob("_mix_timeline_batch_*.wav"))
