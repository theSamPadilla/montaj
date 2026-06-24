"""Unit tests for lib/common.py — no external dependencies required."""
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))
import common


# ── fail() ───────────────────────────────────────────────────────────────────

def test_fail_exits_nonzero():
    with pytest.raises(SystemExit) as exc:
        common.fail("test_error", "something went wrong")
    assert exc.value.code == 1


def test_fail_writes_json_to_stderr(capsys):
    with pytest.raises(SystemExit):
        common.fail("test_code", "test message")
    captured = capsys.readouterr()
    err = json.loads(captured.err)
    assert err["error"] == "test_code"
    assert err["message"] == "test message"


# ── require_file() ────────────────────────────────────────────────────────────

def test_require_file_passes_for_existing(tmp_path):
    f = tmp_path / "file.txt"
    f.write_text("hello")
    common.require_file(str(f))  # should not raise


def test_require_file_fails_for_missing():
    with pytest.raises(SystemExit):
        common.require_file("/nonexistent/path/file.mp4")


# ── require_cmd() ─────────────────────────────────────────────────────────────

def test_require_cmd_passes_for_python():
    common.require_cmd("python3")  # always available in test env


def test_require_cmd_fails_for_unknown():
    with pytest.raises(SystemExit):
        common.require_cmd("__montaj_nonexistent_cmd__")


# ── check_output() ────────────────────────────────────────────────────────────

def test_check_output_passes_for_nonempty(tmp_path):
    f = tmp_path / "out.mp4"
    f.write_bytes(b"data")
    common.check_output(str(f))


def test_check_output_fails_for_missing():
    with pytest.raises(SystemExit):
        common.check_output("/nonexistent/output.mp4")


def test_check_output_fails_for_empty(tmp_path):
    f = tmp_path / "empty.mp4"
    f.touch()
    with pytest.raises(SystemExit):
        common.check_output(str(f))


# ── run() ─────────────────────────────────────────────────────────────────────

def test_run_captures_stdout():
    r = common.run(["echo", "hello"])
    assert r.stdout.strip() == "hello"
    assert r.returncode == 0


def test_run_raises_on_failure():
    with pytest.raises(SystemExit):
        common.run(["false"])  # exits 1


def test_run_no_raise_when_check_false():
    r = common.run(["false"], check=False)
    assert r.returncode != 0


# ── ffprobe helpers ───────────────────────────────────────────────────────────

@pytest.mark.skipif(not __import__("shutil").which("ffprobe"), reason="ffprobe not available")
def test_get_duration(tmp_path):
    import subprocess
    video = tmp_path / "t.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30",
         "-f", "lavfi", "-i", "anullsrc", "-t", "2",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(video)],
        check=True, capture_output=True,
    )
    dur = common.get_duration(str(video))
    assert 1.9 <= dur <= 2.1


# ── find_whisper_bin() ────────────────────────────────────────────────────────

def test_find_whisper_bin_prefers_montaj_managed(tmp_path, monkeypatch):
    """find_whisper_bin picks up Montaj-managed binary over system PATH."""
    import models as _models
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path))
    bin_path = tmp_path / "whisper" / "whisper-cli"
    bin_path.parent.mkdir(parents=True)
    bin_path.write_text("#!/bin/sh\necho fake")
    bin_path.chmod(0o755)
    result = common.find_whisper_bin()
    assert result == str(bin_path)

def test_find_whisper_bin_falls_back_to_path(tmp_path, monkeypatch):
    """find_whisper_bin falls back to system PATH when no managed binary exists."""
    import models as _models
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path))
    # No managed binary — should fall through to system PATH
    # If whisper-cpp or whisper-cli exists on PATH, it finds it. If not, it calls fail().
    # We mock shutil.which to return a fake path.
    monkeypatch.setattr(common.shutil, "which", lambda name: f"/usr/bin/{name}" if name == "whisper-cli" else None)
    result = common.find_whisper_bin()
    assert result == "/usr/bin/whisper-cli"


# ── resolve_whisper_model() ──────────────────────────────────────────────────

@pytest.fixture
def fake_models(tmp_path, monkeypatch):
    """Point the model registry at a tmp dir; create the given whisper weights."""
    import models
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    wdir = tmp_path / "whisper"
    wdir.mkdir()
    def _install(*names):
        for n in names:
            (wdir / f"ggml-{n}.bin").write_bytes(b"x")
    return _install


def test_resolve_english_passthrough(fake_models):
    fake_models("base.en", "base")
    assert common.resolve_whisper_model("base.en", "en") == "base.en"
    assert common.resolve_whisper_model("base.en", "english") == "base.en"
    assert common.resolve_whisper_model("base.en", "") == "base.en"


def test_resolve_swaps_en_to_multilingual_sibling(fake_models):
    fake_models("base.en", "base")
    assert common.resolve_whisper_model("base.en", "es") == "base"
    # 'auto' is treated as non-English so a multilingual model can detect the language
    assert common.resolve_whisper_model("base.en", "auto") == "base"


def test_resolve_multilingual_passthrough(fake_models):
    fake_models("base", "large")
    assert common.resolve_whisper_model("base", "es") == "base"
    assert common.resolve_whisper_model("large", "es") == "large"


def test_resolve_falls_back_when_sibling_missing(fake_models):
    # medium (multilingual) not installed → fall back to an installed multilingual weight
    fake_models("medium.en", "large")
    assert common.resolve_whisper_model("medium.en", "es") == "large"
