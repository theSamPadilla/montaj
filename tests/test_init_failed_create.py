"""§627: a create that fails for any reason removes the folder it made.

On 2026-10-22 a create copied 2.9 GB of footage into the workspace and never
wrote project.json; a retry left a second folder holding only `.git`. Only a
full disk (§541) used to clean up. Run in process, as test_disk_full does.
"""
import json
import sys
from pathlib import Path

import pytest

import project.init as init_mod


@pytest.fixture()
def ws(tmp_path, monkeypatch):
    w = (tmp_path / "ws").resolve()
    w.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(w))
    return w


def _asset(tmp_path, name="logo.png"):
    p = tmp_path / name
    p.write_bytes(b"a" * 2048)
    return p


def _run_init(monkeypatch, capsys, *args):
    monkeypatch.setattr(sys, "argv", ["init.py", "--prompt", "p", "--workflow", "overlays", "--name", "cv", *args])
    with pytest.raises(BaseException) as e:
        init_mod.main()
    return e.value, capsys.readouterr().err


def _fail_after_copy(monkeypatch, then):
    """Fail at the second workflow read, which runs after every file is copied
    in (the first is a check before anything is written)."""
    real, calls = init_mod._read_project_type, []

    def read_type(workflow):
        calls.append(workflow)
        if len(calls) == 1:
            return real(workflow)
        then()
    monkeypatch.setattr(init_mod, "_read_project_type", read_type)


def test_a_failed_create_removes_its_folder(ws, tmp_path, monkeypatch, capsys):
    asset = _asset(tmp_path)
    seen = []
    _fail_after_copy(monkeypatch, lambda: (seen.extend(p.name for p in ws.iterdir()), init_mod.fail("boom", "no")))
    exc, err = _run_init(monkeypatch, capsys, "--assets", str(asset))
    assert isinstance(exc, SystemExit) and exc.code == 1
    assert json.loads([ln for ln in err.splitlines() if '"error"' in ln][-1])["error"] == "boom"
    assert len(seen) == 1                       # the folder was there, half made
    assert list(ws.iterdir()) == []
    assert asset.read_bytes() == b"a" * 2048    # the source is untouched


def test_an_unexpected_error_removes_it_too(ws, tmp_path, monkeypatch, capsys):
    def boom():
        raise RuntimeError("unexpected")
    _fail_after_copy(monkeypatch, boom)
    exc, _ = _run_init(monkeypatch, capsys, "--assets", str(_asset(tmp_path)))
    assert isinstance(exc, RuntimeError)
    assert list(ws.iterdir()) == []


def test_a_termination_signal_removes_it(ws, tmp_path, monkeypatch, capsys):
    _fail_after_copy(monkeypatch, lambda: init_mod._exit_on_signal(15, None))
    exc, _ = _run_init(monkeypatch, capsys, "--assets", str(_asset(tmp_path)))
    assert isinstance(exc, SystemExit) and exc.code == 143
    assert list(ws.iterdir()) == []


def test_the_folder_is_kept_when_a_copied_source_is_gone(ws, tmp_path, monkeypatch, capsys):
    asset = _asset(tmp_path)

    def source_gone_then_fail():
        asset.unlink()                          # the copy is now the only one
        init_mod.fail("boom", "no")
    _fail_after_copy(monkeypatch, source_gone_then_fail)
    exc, err = _run_init(monkeypatch, capsys, "--assets", str(asset))
    assert exc.code == 1
    [kept] = list(ws.iterdir())
    assert any(p.read_bytes() == b"a" * 2048 for p in kept.rglob("*") if p.is_file() and ".git" not in p.parts)
    assert "no longer at its source" in err


def test_a_failure_after_the_project_is_made_keeps_it(ws, tmp_path, monkeypatch, capsys):
    def boom(_staged):
        raise RuntimeError("after the commit")
    monkeypatch.setattr(init_mod, "_cleanup_staged_uploads", boom)
    exc, _ = _run_init(monkeypatch, capsys, "--assets", str(_asset(tmp_path)))
    assert isinstance(exc, RuntimeError)
    [made] = list(ws.iterdir())
    assert (made / "project.json").is_file()


def test_a_refusal_before_anything_is_written_leaves_another_folder_alone(ws, tmp_path, monkeypatch, capsys):
    (ws / "existing").mkdir()
    exc, _ = _run_init(monkeypatch, capsys, "--project-path", "existing", "--assets", str(_asset(tmp_path)))
    assert exc.code == 1
    assert [p.name for p in ws.iterdir()] == ["existing"]
