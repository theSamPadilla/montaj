"""Tests for steps/rm_nonspeech.py — uses fake whisper binary."""
import json
import os
import pytest
from tests.conftest import run_step_env, assert_error

_WHISPER_MODEL_NEW = os.path.expanduser("~/.local/share/montaj/models/whisper/ggml-base.en.bin")
_WHISPER_MODEL_OLD = os.path.expanduser("~/.local/share/whisper.cpp/models/ggml-base.en.bin")
_WHISPER_BASE_NEW = os.path.expanduser("~/.local/share/montaj/models/whisper/ggml-base.bin")
_WHISPER_BASE_OLD = os.path.expanduser("~/.local/share/whisper.cpp/models/ggml-base.bin")
requires_whisper = pytest.mark.skipif(
    (not os.path.isfile(_WHISPER_MODEL_NEW) and not os.path.isfile(_WHISPER_MODEL_OLD))
    or (not os.path.isfile(_WHISPER_BASE_NEW) and not os.path.isfile(_WHISPER_BASE_OLD)),
    reason="whisper model not installed",
)

pytestmark = requires_whisper


def test_rm_nonspeech_produces_output(test_video, tmp_path, fake_whisper_env):
    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"


def test_rm_nonspeech_missing_input(fake_whisper_env):
    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", "/no/file.mp4")
    assert_error(proc, "file_not_found")


def test_rm_nonspeech_accepts_trim_spec(tmp_path, test_video, fake_whisper_env):
    spec = {"input": str(test_video), "keeps": [[0.0, 3.0]]}
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))

    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", str(spec_path), "--model", "base.en")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "input" in result
    assert "keeps" in result
    assert result["input"] == str(test_video)


def test_rm_nonspeech_clamps_outpoint_to_duration(test_video, fake_whisper_env):
    """Raw-video branch must never emit an outpoint past the source duration.

    The fake whisper's last word ends at 2.8s over a 3.0s test video. With a
    0.5s sentence-edge the unclamped outpoint would be 3.3s (> duration); the
    clamp must keep every keep end within the source.
    """
    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base",
                        "--sentence-edge", "0.5")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    last_out = max(e for _, e in result["keeps"])
    assert last_out <= 3.05, f"outpoint {last_out} exceeds ~3.0s source duration"


def test_rm_nonspeech_accepts_language_flag(test_video, fake_whisper_env):
    """--language is a recognized arg and the step still runs (large = multilingual)."""
    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base",
                        "--language", "es")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"


def test_rm_nonspeech_window_flags_require_both(test_video, fake_whisper_env):
    """--window-in without --window-out (and vice versa) is a clear error, not silent."""
    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base",
                        "--window-in", "0.5")
    assert_error(proc, "invalid_args")

    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base",
                        "--window-out", "2.5")
    assert_error(proc, "invalid_args")


def test_rm_nonspeech_windowed_returns_keeps_and_cuts_within_window(test_video, fake_whisper_env):
    """A windowed call routes through the trim-spec branch (source time) and
    additionally emits `cuts` — the exact complement of `keeps` within the
    analysed window, with no gaps or overlaps."""
    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base",
                        "--window-in", "0.0", "--window-out", "3.0")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert result["input"] == str(test_video)
    assert "cuts" in result

    segments = sorted(result["keeps"] + [[c["start"], c["end"]] for c in result["cuts"]])
    pos = 0.0
    for s, e in segments:
        assert s == pytest.approx(pos, abs=1e-4)
        pos = e
    assert pos == pytest.approx(3.0, abs=1e-4)


def test_rm_nonspeech_windowed_stays_within_the_window_bounds(test_video, fake_whisper_env):
    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base",
                        "--window-in", "0.5", "--window-out", "2.5")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    for s, e in result["keeps"]:
        assert s >= 0.5 - 1e-6 and e <= 2.5 + 1e-6
    for c in result["cuts"]:
        assert c["start"] >= 0.5 - 1e-6 and c["end"] <= 2.5 + 1e-6


def test_rm_nonspeech_unwindowed_output_has_no_cuts_key(test_video, fake_whisper_env):
    """Unwindowed behaviour is byte-identical to today — no new `cuts` key."""
    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "cuts" not in result


def test_rm_nonspeech_plain_trim_spec_has_no_cuts_key(tmp_path, test_video, fake_whisper_env):
    """A caller-supplied trim spec without --window-in/--window-out is also
    unaffected — `cuts` is only added when this step itself windowed the call."""
    spec = {"input": str(test_video), "keeps": [[0.0, 3.0]]}
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))

    proc = run_step_env("rm_nonspeech.py", fake_whisper_env,
                        "--input", str(spec_path), "--model", "base.en")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "cuts" not in result
