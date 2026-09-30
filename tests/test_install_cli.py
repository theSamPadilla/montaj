# tests/test_install_cli.py
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock
import pytest

# Add lib to path
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from cli.commands import models as models_cmd
from cli.commands import install as install_cmd
import models as _models


def test_model_path_uses_montaj_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path))
    path = models_cmd.model_path("base.en")
    assert "whisper" in path
    assert path.endswith("ggml-base.en.bin")


def test_is_downloaded_false_when_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path))
    assert not models_cmd.is_downloaded("base.en")


def test_is_downloaded_true_when_present(tmp_path, monkeypatch):
    monkeypatch.setattr(_models, "MONTAJ_MODELS_DIR", str(tmp_path))
    dest = Path(_models.model_path("whisper", "ggml-base.en.bin"))
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"fake model")
    assert models_cmd.is_downloaded("base.en")


def test_models_list_output(capsys):
    # Should not raise, just print table
    models_cmd._list()
    out = capsys.readouterr().out
    assert "base.en" in out
    assert "MODEL" in out


def test_models_list_includes_turbo_with_checksum(capsys):
    assert models_cmd.AVAILABLE["large-v3-turbo-q5_0"] == 574
    assert models_cmd.AVAILABLE["large-v3-turbo"] == 1624
    assert models_cmd.CHECKSUMS["large-v3-turbo-q5_0"] == (
        "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2")
    models_cmd._list()
    out = capsys.readouterr().out
    assert "large-v3-turbo-q5_0" in out
    assert "574 MB" in out


def _capture_whisper_downloads(monkeypatch):
    downloaded = []
    monkeypatch.setattr(install_cmd, "_ensure_whisper_binary", lambda: True)
    monkeypatch.setattr(models_cmd, "is_downloaded", lambda name: False)
    monkeypatch.setattr(models_cmd, "_download", lambda name: downloaded.append(name))
    return downloaded


def test_ensure_whisper_default_downloads_turbo_not_base(monkeypatch, capsys):
    downloaded = _capture_whisper_downloads(monkeypatch)
    assert install_cmd._ensure_whisper() is True
    assert downloaded == ["large-v3-turbo-q5_0"]


def test_ensure_whisper_adds_turbo_to_requested_model(monkeypatch, capsys):
    downloaded = _capture_whisper_downloads(monkeypatch)
    install_cmd._ensure_whisper("base.en")
    assert downloaded == ["base.en", "large-v3-turbo-q5_0"]


def test_install_whisper_model_flag_defaults_to_turbo():
    import argparse
    parser = argparse.ArgumentParser()
    install_cmd.register(parser.add_subparsers())
    assert parser.parse_args(["install", "whisper"]).model == "large-v3-turbo-q5_0"


def test_handle_all_installs_turbo(mock_ensure, capsys):
    whisper, *_ = mock_ensure
    install_cmd.handle(_make_args(component="all"))
    whisper.assert_called_once_with(["large-v3-turbo-q5_0"])


# ---------------------------------------------------------------------------
# handle() routing tests
# ---------------------------------------------------------------------------

def _make_args(component=None, install_all=False, model="base.en"):
    args = MagicMock()
    args.component = component
    args.install_all = install_all
    args.model = model
    return args


@pytest.fixture(autouse=False)
def mock_ensure(monkeypatch):
    """Patch the _ensure_* helpers and return their mocks."""
    whisper    = MagicMock(return_value=True)
    rvm        = MagicMock(return_value=True)
    demucs     = MagicMock(return_value=True)
    connectors = MagicMock(return_value=True)
    ui         = MagicMock(return_value=True)
    monkeypatch.setattr(install_cmd, "_ensure_whisper",    whisper)
    monkeypatch.setattr(install_cmd, "_ensure_rvm",        rvm)
    monkeypatch.setattr(install_cmd, "_ensure_demucs",     demucs)
    monkeypatch.setattr(install_cmd, "_ensure_connectors", connectors)
    monkeypatch.setattr(install_cmd, "_ensure_ui",         ui)
    return whisper, rvm, demucs, connectors, ui


def test_handle_rvm_only(mock_ensure, capsys):
    whisper, rvm, demucs, connectors, ui = mock_ensure
    install_cmd.handle(_make_args(component="rvm"))
    whisper.assert_not_called()
    rvm.assert_called_once()
    demucs.assert_not_called()


def test_handle_whisper_only(mock_ensure, capsys):
    whisper, rvm, demucs, connectors, ui = mock_ensure
    install_cmd.handle(_make_args(component="whisper"))
    whisper.assert_called_once()
    rvm.assert_not_called()


def test_handle_all_calls_all(mock_ensure, capsys):
    whisper, rvm, demucs, connectors, ui = mock_ensure
    install_cmd.handle(_make_args(component="all"))
    whisper.assert_called_once()
    rvm.assert_called_once()
    demucs.assert_called_once()
    connectors.assert_called_once()
    ui.assert_called_once()


def test_handle_no_component_does_nothing(mock_ensure, monkeypatch):
    whisper, rvm, demucs, connectors, ui = mock_ensure
    # _parser is None in test context; patch it so print_help doesn't crash
    monkeypatch.setattr(install_cmd, "_parser", MagicMock())
    install_cmd.handle(_make_args())
    # No component → prints help, no installers called
    whisper.assert_not_called()
    rvm.assert_not_called()


def test_ffmpeg_dispatch_calls_managed_download(monkeypatch):
    called = {}
    monkeypatch.setattr(install_cmd, "_ensure_ffmpeg_managed", lambda: called.setdefault("hit", True) or True)
    args = _make_args(component="ffmpeg")
    install_cmd.handle(args)
    assert called.get("hit")


def test_all_includes_ffmpeg(monkeypatch):
    called = []
    for name in ("_ensure_whisper", "_ensure_rvm", "_ensure_demucs",
                 "_ensure_connectors", "_ensure_ui"):
        monkeypatch.setattr(install_cmd, name, lambda *a, name=name: called.append(name) or True)
    monkeypatch.setattr(install_cmd, "_ensure_ffmpeg_managed", lambda: called.append("ffmpeg") or True)
    args = _make_args(component="all")
    install_cmd.handle(args)
    assert "ffmpeg" in called


# ---------------------------------------------------------------------------
# rvm install + remove-bg wrapper (PL2: onnxruntime, no torch)
# ---------------------------------------------------------------------------

def test_ensure_rvm_installs_extra_and_fetches_only_the_onnx_model(monkeypatch, capsys):
    import rvm_model
    run = MagicMock(return_value=MagicMock(returncode=0))
    ensure = MagicMock(return_value="/x/model.onnx")
    monkeypatch.setattr(install_cmd.subprocess, "run", run)
    monkeypatch.setattr(_models, "ensure_model", ensure)
    assert install_cmd._ensure_rvm() is True
    assert run.call_args.args[0][-1] == "montaj[rvm]"
    ensure.assert_called_once_with("rvm", "rvm_mobilenetv3_fp32.onnx", rvm_model.URL, rvm_model.SHA256)
    out = capsys.readouterr()
    assert ".pth" not in out.out + out.err
    assert "torch" not in (out.out + out.err).lower()


def test_ensure_rvm_fails_when_the_model_cannot_be_fetched(monkeypatch, capsys):
    monkeypatch.setattr(install_cmd.subprocess, "run", MagicMock(return_value=MagicMock(returncode=0)))
    monkeypatch.setattr(_models, "ensure_model", MagicMock(side_effect=SystemExit(1)))
    assert install_cmd._ensure_rvm() is False


def test_install_rvm_help_does_not_mention_torch():
    import argparse
    install_cmd.register(argparse.ArgumentParser().add_subparsers())
    sub = next(a for a in install_cmd._parser._subparsers._group_actions[0]._choices_actions if a.dest == "rvm")
    help_text = sub.help
    assert "torch" not in help_text.lower()


def _remove_bg_step_cmd(monkeypatch, argv):
    import argparse, subprocess
    from cli.commands import remove_bg as rb
    parser = argparse.ArgumentParser()
    rb.register(parser.add_subparsers())
    captured = {}
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: captured.update(cmd=cmd) or MagicMock(returncode=0))
    with pytest.raises(SystemExit):
        args = parser.parse_args(["remove-bg", *argv])
        args.func(args)
    return captured["cmd"]


def test_remove_bg_wrapper_builds_a_command_the_step_accepts(monkeypatch, tmp_path):
    import json, subprocess, sys as _sys
    real_run = subprocess.run  # captured before the wrapper's own patch
    missing = str(tmp_path / "nope.mp4")
    cmd = _remove_bg_step_cmd(monkeypatch, ["--input", missing, "--downsample", "0.75", "--max-height", "720"])
    for removed in ("--model", "--cpu", "--workers"):
        assert removed not in cmd
    assert cmd[cmd.index("--max-height") + 1] == "720"
    assert cmd[cmd.index("--downsample") + 1] == "0.75"
    # Run the step for real. argparse runs first and exits 2 on any flag it does
    # not know; a missing input is checked before the model, so exit 1 with
    # file_not_found proves every flag was accepted.
    probe = real_run([_sys.executable, *cmd[1:]], capture_output=True, text=True)
    assert probe.returncode == 1, probe.stderr
    last = [l for l in probe.stderr.splitlines() if l.strip().startswith("{")][-1]
    assert json.loads(last)["error"] == "file_not_found"
