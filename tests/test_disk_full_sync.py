"""§541 x §482: a full disk and the Studio sync clash backstop compose.

The clash check runs first, exactly where it always ran (under the project lock, before any folder, temp file or
byte is written), and a refusal answers exactly as before (the binding 409), full disk or not. A write the guard
lets through that then meets a full disk is the 507, leaves the existing file as it was and removes only its own
temp or half copy. Fixtures and helpers are the guard's own (tests/test_save_guard_sync.py)."""
import errno
import json
import shutil
import types
from pathlib import Path

import pytest

import lib.disk_space as disk_space
import project.init as init_mod
import serve.routes.files as files_mod
from tests.test_save_guard_sync import (  # noqa: F401  (fixtures)
    AI, DRIVE, EDITOR, PID, _client, _disk, _project, _put, _refused, _sidecar, _write_file, brand_logo, recorder, state, ws,
)


def _enospc(*_a, **_k):
    raise OSError(errno.ENOSPC, "No space left on device")


def _fill(monkeypatch):
    """No room from now on: the free-space read says 0, and any write the routes make fails with ENOSPC.
    Called after the test has made its project, sidecar and files."""
    monkeypatch.setattr(disk_space.shutil, "disk_usage", lambda _p: types.SimpleNamespace(total=10 ** 9, used=10 ** 9, free=0))
    monkeypatch.setattr(files_mod, "open_write_no_follow", _enospc)
    monkeypatch.setattr(init_mod.shutil, "copy2", _enospc)

    def write_text(self, *a, **k):
        _enospc()
    monkeypatch.setattr(Path, "write_text", write_text)


def _no_temp(folder):
    return [p.name for p in folder.rglob("*") if p.name.endswith(".tmp") or p.name.startswith(".copying-")]


def _full_disk(resp):
    assert resp.status_code == 507, resp.text
    assert resp.json()["detail"]["error"] == "disk_full"


@pytest.fixture
def overlays(ws, state):
    d = _project(ws)
    (d / "overlays").mkdir()
    (d / "overlays" / "title.jsx").write_text("mine")
    (d / "overlays" / "free.jsx").write_text("mine too")
    return d


def test_a_clashed_file_is_refused_as_before_even_on_a_full_disk(overlays, state, monkeypatch):
    _sidecar(state, files=["overlays/title.jsx"])
    _fill(monkeypatch)
    _refused(_write_file(overlays / "overlays" / "title.jsx"), ["overlays/title.jsx"])
    assert (overlays / "overlays" / "title.jsx").read_text() == "mine"
    assert _no_temp(overlays) == []


def test_a_file_the_guard_lets_through_on_a_full_disk_is_507_and_the_file_is_kept(overlays, state, monkeypatch):
    _sidecar(state, files=["overlays/title.jsx"])
    _fill(monkeypatch)
    _full_disk(_write_file(overlays / "overlays" / "free.jsx"))
    assert (overlays / "overlays" / "free.jsx").read_text() == "mine too"
    assert _no_temp(overlays) == []


def test_a_full_disk_part_way_through_a_let_through_write_removes_only_its_temp(overlays, state, monkeypatch):
    _sidecar(state, files=["overlays/title.jsx"])
    import os
    real = os.fdopen

    class Half:
        def __init__(self, f):
            self.f = f

        def write(self, data):
            self.f.write(data[:1])
            _enospc()

        def __enter__(self):
            return self

        def __exit__(self, *a):
            self.f.close()
    monkeypatch.setattr(files_mod.os, "fdopen", lambda fd, mode="r", *a, **k: Half(real(fd, mode, *a, **k)))
    _full_disk(_write_file(overlays / "overlays" / "free.jsx"))
    assert (overlays / "overlays" / "free.jsx").read_text() == "mine too"
    assert _no_temp(overlays) == []


def test_a_clashed_save_is_refused_as_before_on_a_full_disk(ws, state, monkeypatch):
    d = _project(ws)
    _sidecar(state, fields=["name"])
    before = _disk(d)
    # Full only from here: the read the request needs is done by _put before.
    resp = None

    def write_text(self, *a, **k):
        _enospc()
    with monkeypatch.context() as m:
        m.setattr(Path, "write_text", write_text)
        resp = _put(ws, {"name": "theirs"}, AI)
    _refused(resp, ["name"])
    assert _disk(d) == before


def test_a_save_the_guard_lets_through_on_a_full_disk_is_507_and_project_json_is_kept(ws, state, monkeypatch):
    d = _project(ws)
    _sidecar(state, fields=["status"])
    before = _disk(d)

    def write_text(self, *a, **k):
        _enospc()
    with monkeypatch.context() as m:
        m.setattr(Path, "write_text", write_text)
        resp = _put(ws, {"name": "theirs"}, AI)
    _full_disk(resp)
    assert _disk(d) == before
    assert _no_temp(d) == []


def test_a_clashed_asset_include_is_refused_as_before_on_a_full_disk(ws, state, brand_logo, monkeypatch):
    d = _project(ws, profile="brand", assets=[])
    (state / PID).mkdir(exist_ok=True)
    (state / PID / "clash-set.json").write_text("nope")  # B1: the window is the only writer here, refused when unsure
    _fill(monkeypatch)
    resp = _client().post(f"/api/projects/{PID}/assets", json=brand_logo, headers=DRIVE)
    assert resp.status_code == 409 and resp.json()["detail"]["error"] == "sync_conflict", resp.text
    assert not any(p.name.startswith("logo") for p in d.rglob("*"))


def test_an_asset_include_the_guard_lets_through_on_a_full_disk_is_507_with_no_half_copy(ws, state, brand_logo, monkeypatch):
    d = _project(ws, profile="brand", assets=[])
    _sidecar(state, files=["other.png"])
    _fill(monkeypatch)
    before = _disk(d)
    _full_disk(_client().post(f"/api/projects/{PID}/assets", json=brand_logo, headers=EDITOR))
    assert not any(p.name.startswith("logo") for p in d.rglob("*"))
    assert _disk(d) == before
