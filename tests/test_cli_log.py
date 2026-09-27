"""Tests for `montaj log` — the CLI's `_contract` "log <message>" verb.

Two modes, chosen by whether a live `montaj serve` announces itself via its
lockfile (serve/lockfile.py) — NOT by the MONTAJ_SERVE_PORT env var, which is
only ever set in serve's OWN os.environ and never reaches this sibling
process (see cli/commands/log.py's module docstring, and
tests/test_serve_lockfile.py for the same isolation fixture pattern):

  - HTTP mode (lockfile present, pid alive): POST {"message": ...} to
    /api/projects/<project>/log on the port the lockfile names.
  - CLI mode (no live lockfile): print the message to stderr.
"""
from argparse import Namespace
from unittest.mock import Mock

import httpx
import pytest

import cli.commands.log as log_cmd
from serve import lockfile


@pytest.fixture(autouse=True)
def _lockfile_home(tmp_path, monkeypatch):
    """Isolate the lockfile path so this test never touches ~/.montaj/serve.json."""
    monkeypatch.setattr(lockfile, "_lockfile_path", lambda: tmp_path / "serve.json")
    return tmp_path


def _ns(project="proj-1", message="hello"):
    return Namespace(project=project, message=message, json=False, out=None, quiet=False)


def test_cli_mode_prints_to_stderr_when_no_serve_is_running(capsys):
    log_cmd.handle(_ns(message="rendering clip 3 of 6"))
    captured = capsys.readouterr()
    assert captured.err.strip() == "rendering clip 3 of 6"
    assert captured.out == ""


def test_http_mode_posts_to_the_project_log_endpoint(tmp_path, monkeypatch):
    lockfile.write(port=4321, workspace=tmp_path)

    mock_post = Mock(return_value=Mock(raise_for_status=Mock()))
    monkeypatch.setattr(log_cmd.httpx, "post", mock_post)

    log_cmd.handle(_ns(project="proj-42", message="transcribing clip 1 of 3"))

    mock_post.assert_called_once_with(
        "http://127.0.0.1:4321/api/projects/proj-42/log",
        json={"message": "transcribing clip 1 of 3"},
        timeout=log_cmd._TIMEOUT,
    )


def test_http_mode_does_not_fall_back_to_stderr_on_success(tmp_path, monkeypatch, capsys):
    """A successful POST is the whole job — nothing else is printed."""
    lockfile.write(port=4321, workspace=tmp_path)
    monkeypatch.setattr(log_cmd.httpx, "post", Mock(return_value=Mock(raise_for_status=Mock())))

    log_cmd.handle(_ns(message="should not reach stderr"))

    captured = capsys.readouterr()
    assert captured.err == ""
    assert captured.out == ""


def test_http_mode_errors_when_serve_is_unreachable(tmp_path, monkeypatch):
    """The lockfile said serve was alive but the POST itself failed — this is
    a real, surfaceable failure (not silently swallowed into the CLI-mode
    stderr fallback, which is reserved for "no serve at all")."""
    lockfile.write(port=4321, workspace=tmp_path)
    monkeypatch.setattr(
        log_cmd.httpx, "post",
        Mock(side_effect=httpx.ConnectError("connection refused")),
    )

    with pytest.raises(SystemExit) as exc_info:
        log_cmd.handle(_ns())
    assert exc_info.value.code == 1


def test_log_is_exported_as_an_mcp_tool_with_project_and_message_args():
    from cli.mcp_schema import export

    tool = next(t for t in export() if t["name"] == "log")
    assert tool["_cli_tokens"] == ["log"]
    assert tool["_positionals"] == ["message"]
    assert tool["_flags"]["project"] == "--project"
    assert set(tool["inputSchema"]["required"]) == {"project", "message"}
    assert tool["inputSchema"]["properties"]["project"]["type"] == "string"
    assert tool["inputSchema"]["properties"]["message"]["type"] == "string"
