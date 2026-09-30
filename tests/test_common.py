"""Unit tests for lib/common.py — no external dependencies required."""
import json
import os
import subprocess
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


def test_find_whisper_bin_managed_looks_for_exe_on_windows(tmp_path, monkeypatch):
    """Windows seam: the managed-path check must look for whisper-cli.exe via
    common._exe (the _EXE_SUFFIX seam), never sys.platform."""
    import models as _models
    monkeypatch.setattr(common, "_EXE_SUFFIX", ".exe")
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path))
    wdir = tmp_path / "whisper"
    wdir.mkdir()
    exe = wdir / "whisper-cli.exe"
    exe.write_text("MZ")
    result = common.find_whisper_bin()
    assert result == str(exe)


# ── resolve_whisper_model() ──────────────────────────────────────────────────

@pytest.fixture
def fake_models(tmp_path, monkeypatch):
    """Point the model registry at a tmp dir; create the given whisper weights.

    Also redirects the legacy whisper.cpp dir to a nonexistent path so resolution
    is deterministic regardless of what's installed on the host."""
    import models
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    monkeypatch.setattr(common, "LEGACY_WHISPER_DIR", str(tmp_path / "no-legacy"))
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


def test_resolve_fails_clearly_when_no_multilingual_installed(fake_models, capsys):
    # Only the English-only weight is present; a non-English request must fail with
    # an actionable message instead of returning a missing model name.
    fake_models("base.en")
    with pytest.raises(SystemExit) as exc:
        common.resolve_whisper_model("base.en", "es")
    assert exc.value.code == 1
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "missing_multilingual_model"
    assert "montaj models download base" in err["message"]


def test_resolve_finds_weight_in_legacy_dir(tmp_path, monkeypatch):
    # A multilingual weight present only in the legacy whisper.cpp dir still counts.
    import models
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path / "managed"))
    (tmp_path / "managed" / "whisper").mkdir(parents=True)
    legacy = tmp_path / "legacy"
    legacy.mkdir()
    (legacy / "ggml-base.bin").write_bytes(b"x")
    monkeypatch.setattr(common, "LEGACY_WHISPER_DIR", str(legacy))
    assert common.resolve_whisper_model("base.en", "es") == "base"


# ── DEFAULT_WHISPER_MODEL (large-v3-turbo-q5_0) fallback ─────────────────────

TURBO = "large-v3-turbo-q5_0"


def test_default_whisper_model_is_turbo():
    from common import DEFAULT_WHISPER_MODEL
    assert DEFAULT_WHISPER_MODEL == TURBO


def test_missing_model_falls_back_to_installed_turbo(fake_models):
    fake_models(TURBO)
    assert common.resolve_whisper_model("base.en", "en") == TURBO
    assert common.resolve_whisper_model("base", "es") == TURBO
    assert common.resolve_whisper_model("base.en", "auto") == TURBO
    assert common.resolve_whisper_model("small.en", "en") == TURBO


def test_installed_model_is_used_as_requested(fake_models):
    fake_models("base.en", TURBO)
    assert common.resolve_whisper_model("base.en", "en") == "base.en"


def test_non_english_prefers_turbo_over_same_size_sibling(fake_models):
    fake_models("base.en", "base", TURBO)
    assert common.resolve_whisper_model("base.en", "es") == TURBO


def test_missing_model_without_turbo_keeps_old_behaviour(fake_models, capsys):
    fake_models("base.en")
    assert common.resolve_whisper_model("base.en", "en") == "base.en"
    with pytest.raises(SystemExit):
        common.resolve_whisper_model("base.en", "es")
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "missing_multilingual_model"


def test_default_turbo_falls_back_to_base_en_for_older_cli_installs(fake_models):
    fake_models("base.en")
    assert common.resolve_whisper_model(TURBO, "en") == "base.en"


def test_default_turbo_falls_back_to_base_for_non_english(fake_models):
    fake_models("base.en", "base")
    assert common.resolve_whisper_model(TURBO, "es") == "base"


def test_default_turbo_non_english_with_only_en_weights_says_what_to_install(fake_models, capsys):
    fake_models("base.en")
    with pytest.raises(SystemExit):
        common.resolve_whisper_model(TURBO, "auto")
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "missing_multilingual_model"
    assert TURBO in err["message"]


def test_nothing_installed_returns_requested_model(fake_models):
    # No weights at all: resolution leaves the name alone so transcribe_words'
    # require_file names the missing file.
    assert common.resolve_whisper_model(TURBO, "en") == TURBO


# ── ffmpeg/ffprobe resolver ──────────────────────────────────────────────────

class TestFfmpegResolver:
    def test_env_override_wins(self, monkeypatch, tmp_path):
        fake = tmp_path / "myffmpeg"
        fake.write_text("#!/bin/sh\n")
        fake.chmod(0o755)
        monkeypatch.setenv("MONTAJ_FFMPEG", str(fake))
        # Even with a managed AND a bundled binary present, env must win.
        managed_dir = tmp_path / "managed"
        managed_dir.mkdir()
        managed = managed_dir / "ffmpeg"
        managed.write_text("#!/bin/sh\n")
        managed.chmod(0o755)
        monkeypatch.setattr(common, "_managed_ffmpeg_dir", lambda: str(managed_dir))
        bundled_dir = tmp_path / "bundled"
        bundled_dir.mkdir()
        bundled = bundled_dir / "ffmpeg"
        bundled.write_text("#!/bin/sh\n")
        bundled.chmod(0o755)
        monkeypatch.setattr(common, "_bundled_av_dir", lambda: str(bundled_dir))
        assert common.ffmpeg_bin() == str(fake)

    def test_managed_binary_preferred_over_bundled(self, monkeypatch, tmp_path):
        monkeypatch.delenv("MONTAJ_FFMPEG", raising=False)
        managed_dir = tmp_path / "managed"
        managed_dir.mkdir()
        managed = managed_dir / "ffmpeg"
        managed.write_text("#!/bin/sh\n")
        managed.chmod(0o755)
        monkeypatch.setattr(common, "_managed_ffmpeg_dir", lambda: str(managed_dir))
        bundled_dir = tmp_path / "bundled"
        bundled_dir.mkdir()
        bundled = bundled_dir / "ffmpeg"
        bundled.write_text("#!/bin/sh\n")
        bundled.chmod(0o755)
        monkeypatch.setattr(common, "_bundled_av_dir", lambda: str(bundled_dir))
        assert common.ffmpeg_bin() == str(managed)

    def test_bundled_used_when_managed_absent(self, monkeypatch, tmp_path):
        monkeypatch.delenv("MONTAJ_FFMPEG", raising=False)
        monkeypatch.setattr(common, "_managed_ffmpeg_dir", lambda: str(tmp_path / "absent"))
        bundled_dir = tmp_path / "bundled"
        bundled_dir.mkdir()
        bundled = bundled_dir / "ffmpeg"
        bundled.write_text("#!/bin/sh\n")
        bundled.chmod(0o755)
        monkeypatch.setattr(common, "_bundled_av_dir", lambda: str(bundled_dir))
        assert common.ffmpeg_bin() == str(bundled)

    def test_falls_back_to_path_name(self, monkeypatch, tmp_path):
        monkeypatch.delenv("MONTAJ_FFMPEG", raising=False)
        monkeypatch.setattr(common, "_managed_ffmpeg_dir", lambda: str(tmp_path / "absent"))
        monkeypatch.setattr(common, "_bundled_av_dir", lambda: str(tmp_path / "no-bundle"))
        assert common.ffmpeg_bin() == "ffmpeg"

    def test_ffprobe_mirrors(self, monkeypatch, tmp_path):
        monkeypatch.delenv("MONTAJ_FFPROBE", raising=False)
        monkeypatch.setattr(common, "_managed_ffmpeg_dir", lambda: str(tmp_path / "absent"))
        monkeypatch.setattr(common, "_bundled_av_dir", lambda: str(tmp_path / "no-bundle"))
        assert common.ffprobe_bin() == "ffprobe"

    def test_ffprobe_mirrors_bundled_tier(self, monkeypatch, tmp_path):
        monkeypatch.delenv("MONTAJ_FFPROBE", raising=False)
        monkeypatch.setattr(common, "_managed_ffmpeg_dir", lambda: str(tmp_path / "absent"))
        bundled_dir = tmp_path / "bundled"
        bundled_dir.mkdir()
        bundled = bundled_dir / "ffprobe"
        bundled.write_text("#!/bin/sh\n")
        bundled.chmod(0o755)
        monkeypatch.setattr(common, "_bundled_av_dir", lambda: str(bundled_dir))
        assert common.ffprobe_bin() == str(bundled)

    # Windows: proven through common's _EXE_SUFFIX seam, never sys.platform.
    def test_windows_managed_looks_for_exe(self, monkeypatch, tmp_path):
        monkeypatch.setattr(common, "_EXE_SUFFIX", ".exe")
        monkeypatch.delenv("MONTAJ_FFMPEG", raising=False)
        managed_dir = tmp_path / "managed"
        managed_dir.mkdir()
        # A suffix-less decoy must NOT be picked on Windows.
        (managed_dir / "ffmpeg").write_text("#!/bin/sh\n")
        (managed_dir / "ffmpeg").chmod(0o755)
        exe = managed_dir / "ffmpeg.exe"
        exe.write_text("MZ")
        exe.chmod(0o755)
        monkeypatch.setattr(common, "_managed_ffmpeg_dir", lambda: str(managed_dir))
        monkeypatch.setattr(common, "_bundled_av_dir", lambda: str(tmp_path / "no-bundle"))
        assert common.ffmpeg_bin() == str(exe)

    def test_windows_bundled_looks_for_exe(self, monkeypatch, tmp_path):
        monkeypatch.setattr(common, "_EXE_SUFFIX", ".exe")
        monkeypatch.delenv("MONTAJ_FFPROBE", raising=False)
        monkeypatch.setattr(common, "_managed_ffmpeg_dir", lambda: str(tmp_path / "absent"))
        bundled_dir = tmp_path / "bundled"
        bundled_dir.mkdir()
        exe = bundled_dir / "ffprobe.exe"
        exe.write_text("MZ")
        exe.chmod(0o755)
        monkeypatch.setattr(common, "_bundled_av_dir", lambda: str(bundled_dir))
        assert common.ffprobe_bin() == str(exe)

    def test_windows_ignores_suffixless_managed(self, monkeypatch, tmp_path):
        monkeypatch.setattr(common, "_EXE_SUFFIX", ".exe")
        monkeypatch.delenv("MONTAJ_FFMPEG", raising=False)
        managed_dir = tmp_path / "managed"
        managed_dir.mkdir()
        (managed_dir / "ffmpeg").write_text("#!/bin/sh\n")
        (managed_dir / "ffmpeg").chmod(0o755)
        monkeypatch.setattr(common, "_managed_ffmpeg_dir", lambda: str(managed_dir))
        monkeypatch.setattr(common, "_bundled_av_dir", lambda: str(tmp_path / "no-bundle"))
        assert common.ffmpeg_bin() == "ffmpeg"

    def test_exe_is_identity_off_windows(self, monkeypatch):
        monkeypatch.setattr(common, "_EXE_SUFFIX", "")
        assert common._exe("ffmpeg") == "ffmpeg"
        monkeypatch.setattr(common, "_EXE_SUFFIX", ".exe")
        assert common._exe("whisper-cli") == "whisper-cli.exe"


# ── node_child_env() ──────────────────────────────────────────────────────────
# Environment for the node-based render children (render.js, sample-frame.js,
# sample-overlay.js, render-carousel.js), which fall back to bare `python3` on
# PATH when MONTAJ_PYTHON is unset. Only cli/commands/mcp.py set it before this
# change; serve's render spawns never did, so every render on a stock Windows
# install failed with `spawn python3 ENOENT` (no python3.exe on PATH there).

class TestNodeChildEnv:
    def test_sets_ffmpeg_ffprobe_and_python(self, monkeypatch):
        monkeypatch.setattr(common, "ffmpeg_bin", lambda: "/resolved/ffmpeg")
        monkeypatch.setattr(common, "ffprobe_bin", lambda: "/resolved/ffprobe")
        env = common.node_child_env()
        assert env["MONTAJ_FFMPEG"] == "/resolved/ffmpeg"
        assert env["MONTAJ_FFPROBE"] == "/resolved/ffprobe"
        assert env["MONTAJ_PYTHON"] == sys.executable

    def test_returns_a_copy_and_never_mutates_os_environ(self, monkeypatch):
        monkeypatch.delenv("MONTAJ_FFMPEG", raising=False)
        monkeypatch.delenv("MONTAJ_FFPROBE", raising=False)
        monkeypatch.delenv("MONTAJ_PYTHON", raising=False)

        env = common.node_child_env()

        assert env is not os.environ
        assert "MONTAJ_FFMPEG" not in os.environ
        assert "MONTAJ_FFPROBE" not in os.environ
        assert "MONTAJ_PYTHON" not in os.environ

    def test_preserves_existing_environ_entries(self, monkeypatch):
        monkeypatch.setenv("SOME_UNRELATED_VAR", "keep-me")
        env = common.node_child_env()
        assert env["SOME_UNRELATED_VAR"] == "keep-me"


# ── transcribe_words() ───────────────────────────────────────────────────────

def test_transcribe_words_fails_when_whisper_errors(tmp_path, monkeypatch, capsys):
    import subprocess as _sp
    import models
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    monkeypatch.setattr(common, "LEGACY_WHISPER_DIR", str(tmp_path / "no-legacy"))
    wdir = tmp_path / "whisper"
    wdir.mkdir()
    (wdir / "ggml-base.en.bin").write_bytes(b"x")
    monkeypatch.setattr(common, "find_whisper_bin", lambda: "/fake/whisper-cpp")

    def fake_run(cmd, timeout=300, check=True, cwd=None):
        # Simulate whisper crashing: non-zero exit, no JSON written.
        return _sp.CompletedProcess(cmd, returncode=1, stdout="", stderr="ggml: CUDA boom")

    monkeypatch.setattr(common, "run", fake_run)

    wav = tmp_path / "a.wav"
    wav.write_bytes(b"RIFF....WAVE")
    work = tmp_path / "work"
    work.mkdir()

    with pytest.raises(SystemExit):
        common.transcribe_words(str(wav), "base.en", work_dir=str(work))
    err = capsys.readouterr().err
    assert "transcription_failed" in err
    assert "CUDA boom" in err


# ── the lone non-fallback model (PV27 follow-up) ─────────────────────────────

def test_resolve_uses_a_lone_non_fallback_model_for_english(fake_models):
    # Only small.en is installed: neither turbo nor base.en nor base. It used to
    # return the missing default, which failed later as a bare file-not-found.
    fake_models("small.en")
    assert common.resolve_whisper_model(common.DEFAULT_WHISPER_MODEL, "en") == "small.en"


def test_resolve_prefers_the_most_capable_lone_model(fake_models):
    fake_models("tiny.en", "large-v2")
    assert common.resolve_whisper_model(common.DEFAULT_WHISPER_MODEL, "en") == "large-v2"


def test_resolve_takes_a_lone_multilingual_model_for_other_languages(fake_models):
    fake_models("medium")
    assert common.resolve_whisper_model(common.DEFAULT_WHISPER_MODEL, "es") == "medium"


def test_resolve_still_fails_clearly_when_only_english_weights_serve_another_language(fake_models, capsys):
    fake_models("small.en")
    with pytest.raises(SystemExit):
        common.resolve_whisper_model(common.DEFAULT_WHISPER_MODEL, "es")
    assert json.loads(capsys.readouterr().err)["error"] == "missing_multilingual_model"


def test_resolve_with_nothing_installed_returns_the_name_unchanged(fake_models):
    fake_models()
    assert common.resolve_whisper_model(common.DEFAULT_WHISPER_MODEL, "en") == common.DEFAULT_WHISPER_MODEL


# ── the whisper runaway guard (PV27 follow-up) ───────────────────────────────

@pytest.mark.parametrize("duration", [None, "x", 0, -5, float("nan"), float("inf"), 10, 225])
def test_runaway_timeout_never_drops_below_the_old_900s(duration):
    assert common.whisper_runaway_timeout(duration) == common.WHISPER_RUNAWAY_FLOOR_S == 900


def test_runaway_timeout_scales_with_long_audio():
    # 10 minutes of audio: 4x = 2400 s, well past the flat 300 s / 900 s that
    # used to kill a CPU transcription part-way.
    assert common.whisper_runaway_timeout(600) == 600 * common.WHISPER_RUNAWAY_FACTOR == 2400


def test_runaway_timeout_for_an_unprobeable_file_is_the_floor(tmp_path):
    assert common.whisper_runaway_timeout_for(str(tmp_path / "missing.wav")) == 900


def test_run_whisper_turns_a_timeout_into_a_structured_failure(monkeypatch, capsys):
    # A stuck whisper used to escape as a raw TimeoutExpired traceback.
    monkeypatch.setattr(common, "whisper_runaway_timeout_for", lambda _path: 1)
    with pytest.raises(SystemExit) as exc:
        common.run_whisper([sys.executable, "-c", "import time; time.sleep(10)"], "audio.wav")
    assert exc.value.code == 1
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "transcription_timeout"
    assert "1s" in err["message"] and "runaway guard" in err["message"]


def test_run_whisper_passes_through_a_normal_run(monkeypatch):
    monkeypatch.setattr(common, "whisper_runaway_timeout_for", lambda _path: 30)
    r = common.run_whisper([sys.executable, "-c", "print('ok')"], "audio.wav")
    assert r.returncode == 0 and r.stdout.strip() == "ok"


def _capture_whisper_spawn(monkeypatch):
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"], seen["kw"] = cmd, kw
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(common.subprocess, "run", fake_run)
    monkeypatch.setattr(common, "whisper_runaway_timeout_for", lambda _path: 30)
    return seen


def test_run_whisper_spawns_with_the_binarys_own_directory_as_cwd(tmp_path, monkeypatch):
    # whisper.cpp loads ggml-cpu-*.dll from its cwd as well as its exe dir; an
    # inherited cwd (serve's) would let a DLL planted there load.
    seen = _capture_whisper_spawn(monkeypatch)
    exe = tmp_path / "bin" / "whisper-cli"
    common.run_whisper([str(exe), "-m", "m.bin"], "a.wav")
    assert seen["kw"]["cwd"] == str(tmp_path / "bin")


def test_run_whisper_resolves_a_relative_binary_before_taking_its_directory(tmp_path, monkeypatch):
    seen = _capture_whisper_spawn(monkeypatch)
    monkeypatch.chdir(tmp_path)
    common.run_whisper([os.path.join("rel", "whisper-cli")], "a.wav")
    assert seen["kw"]["cwd"] == str(tmp_path / "rel")
    assert seen["cmd"][0] == str(tmp_path / "rel" / "whisper-cli")


def test_run_whisper_makes_path_arguments_absolute_so_the_cwd_change_cannot_move_them(tmp_path, monkeypatch):
    # -f, -m and --output-file were relative to the caller's cwd; whisper now
    # runs elsewhere, so a relative one would read or write the wrong place.
    seen = _capture_whisper_spawn(monkeypatch)
    monkeypatch.chdir(tmp_path)
    exe = str(tmp_path / "bin" / "whisper-cli")
    common.run_whisper([exe, "-m", "models/m.bin", "-f", "clip.wav", "-l", "en",
                        "--output-file", "out/prefix", "--output-json"], "clip.wav")
    cmd = seen["cmd"]
    assert cmd[cmd.index("-m") + 1] == str(tmp_path / "models" / "m.bin")
    assert cmd[cmd.index("-f") + 1] == str(tmp_path / "clip.wav")
    assert cmd[cmd.index("--output-file") + 1] == str(tmp_path / "out" / "prefix")
    assert cmd[cmd.index("-l") + 1] == "en"      # non-path values untouched


def test_run_leaves_cwd_unset_for_other_callers(monkeypatch):
    seen = _capture_whisper_spawn(monkeypatch)
    common.run(["echo", "x"])
    assert seen["kw"].get("cwd") is None
