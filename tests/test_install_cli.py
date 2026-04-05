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
    """Patch the three _ensure_* helpers and return their mocks."""
    ffmpeg  = MagicMock(return_value=True)
    whisper = MagicMock(return_value=True)
    rvm     = MagicMock(return_value=True)
    monkeypatch.setattr(install_cmd, "_ensure_ffmpeg",  ffmpeg)
    monkeypatch.setattr(install_cmd, "_ensure_whisper", whisper)
    monkeypatch.setattr(install_cmd, "_ensure_rvm",     rvm)
    return ffmpeg, whisper, rvm


def test_handle_rvm_does_not_call_ffmpeg(mock_ensure, capsys):
    ffmpeg, whisper, rvm = mock_ensure
    install_cmd.handle(_make_args(component="rvm"))
    ffmpeg.assert_not_called()
    whisper.assert_not_called()
    rvm.assert_called_once()


def test_handle_whisper_calls_ffmpeg(mock_ensure, capsys):
    ffmpeg, whisper, rvm = mock_ensure
    install_cmd.handle(_make_args(component="whisper"))
    ffmpeg.assert_called_once()
    whisper.assert_called_once()
    rvm.assert_not_called()


def test_handle_all_calls_all(mock_ensure, capsys):
    ffmpeg, whisper, rvm = mock_ensure
    install_cmd.handle(_make_args(component="all"))
    ffmpeg.assert_called_once()
    whisper.assert_called_once()
    rvm.assert_called_once()


def test_handle_default_calls_ffmpeg_and_whisper(mock_ensure, capsys):
    ffmpeg, whisper, rvm = mock_ensure
    install_cmd.handle(_make_args())
    ffmpeg.assert_called_once()
    whisper.assert_called_once()
    rvm.assert_not_called()
