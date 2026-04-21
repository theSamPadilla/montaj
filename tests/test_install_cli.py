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
