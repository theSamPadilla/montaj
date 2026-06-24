"""Tests for steps/rm_fillers.py — uses fake whisper binary."""
import json
import os
import pytest
from tests.conftest import run_step_env, assert_file_output, assert_error

_WHISPER_MODEL_NEW = os.path.expanduser("~/.local/share/montaj/models/whisper/ggml-base.en.bin")
_WHISPER_MODEL_OLD = os.path.expanduser("~/.local/share/whisper.cpp/models/ggml-base.en.bin")
requires_whisper = pytest.mark.skipif(
    not os.path.isfile(_WHISPER_MODEL_NEW) and not os.path.isfile(_WHISPER_MODEL_OLD),
    reason="whisper model not installed",
)

pytestmark = requires_whisper


def test_rm_fillers_produces_output(test_video, fake_whisper_env):
    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base.en")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "input" in result
    assert "keeps" in result


def test_rm_fillers_auto_output_path(test_video, fake_whisper_env):
    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(test_video), "--model", "base.en")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"


def test_rm_fillers_missing_input(fake_whisper_env):
    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", "/no/file.mp4")
    assert_error(proc, "file_not_found")


def test_rm_fillers_accepts_trim_spec(tmp_path, test_video, fake_whisper_env):
    spec = {"input": str(test_video), "keeps": [[0.0, 3.0]]}
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))

    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(spec_path), "--model", "base.en")
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    result = json.loads(proc.stdout)
    assert "input" in result
    assert "keeps" in result
    assert result["input"] == str(test_video)


def test_rm_fillers_output_keeps_within_input_keeps(tmp_path, test_video, fake_whisper_env):
    spec = {"input": str(test_video), "keeps": [[0.0, 3.0]]}
    spec_path = tmp_path / "spec.json"
    spec_path.write_text(json.dumps(spec))

    proc = run_step_env("rm_fillers.py", fake_whisper_env,
                        "--input", str(spec_path), "--model", "base.en")
    result = json.loads(proc.stdout)
    # All output keeps must be within the input keep bounds
    for ks, ke in result["keeps"]:
        assert ks >= 0.0
        assert ke <= 3.0


def _load_rm_fillers_module():
    """Import steps/speech/rm_fillers.py directly for pure-function tests."""
    import importlib.util, pathlib, sys
    root = pathlib.Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "lib"))
    spec = importlib.util.spec_from_file_location(
        "rm_fillers_mod", root / "steps" / "speech" / "rm_fillers.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_filler_matcher_is_language_aware():
    mod = _load_rm_fillers_module()
    en = mod._filler_matcher("en")
    es = mod._filler_matcher("es")
    # English hesitations match the English matcher, not the Spanish one
    assert en.match("um") and en.match("uh")
    assert not es.match("um")
    # Spanish hesitations match the Spanish matcher
    assert es.match("eh") and es.match("mmm")
    # Real Spanish words are never treated as fillers (no false cuts)
    assert not es.match("este") and not es.match("pues")
    # Unknown language falls back to the English set
    assert mod._filler_matcher("xx").match("um")
