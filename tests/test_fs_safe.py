"""lib.fs_safe.open_write_no_follow: a symlink-refusing write that works on Windows, where os.O_NOFOLLOW is undefined.

The Windows 1.4.1 smoke failed because project/init.py and serve/routes/files.py opened with a bare `os.O_NOFOLLOW`,
which does not exist on Windows (AttributeError -> every new project 500ed). These tests delete `os.O_NOFOLLOW` to
stand in for Windows, so the regression cannot return.
"""
import json
import os
import sys

import pytest

from lib.fs_safe import open_write_no_follow


def _write(path, data=b"hello\n"):
    fd = open_write_no_follow(path)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


def test_writes_and_overwrites(tmp_path):
    p = tmp_path / "a.json"
    _write(str(p), b'{"x":1}')
    assert p.read_bytes() == b'{"x":1}'
    _write(str(p), b'{"x":2}')  # O_TRUNC overwrites a regular file
    assert p.read_bytes() == b'{"x":2}'


def test_works_when_o_nofollow_is_absent(tmp_path, monkeypatch):
    # Windows has no os.O_NOFOLLOW; the open must still succeed, not raise AttributeError.
    monkeypatch.delattr(os, "O_NOFOLLOW", raising=False)
    p = tmp_path / "win.json"
    _write(str(p), b"ok")
    assert p.read_bytes() == b"ok"


def test_bytes_are_identical_no_newline_translation(tmp_path, monkeypatch):
    # O_BINARY (where it exists) keeps the bytes exact; CRLF is never introduced.
    monkeypatch.delattr(os, "O_NOFOLLOW", raising=False)
    p = tmp_path / "nl.txt"
    _write(str(p), b"line1\nline2\n")
    assert p.read_bytes() == b"line1\nline2\n"


@pytest.mark.skipif(sys.platform == "win32", reason="creating a symlink needs privilege on Windows")
def test_refuses_a_symlink_at_the_target(tmp_path):
    outside = tmp_path / "outside.json"
    outside.write_bytes(b"secret")
    link = tmp_path / "link.json"
    os.symlink(outside, link)
    with pytest.raises(OSError):
        _write(str(link), b"pwned")
    assert outside.read_bytes() == b"secret"  # the target was not written through


@pytest.mark.skipif(sys.platform == "win32", reason="creating a symlink needs privilege on Windows")
def test_refuses_a_symlink_even_without_o_nofollow(tmp_path, monkeypatch):
    # The Windows guard is the lstat check, not the flag: a link is refused with O_NOFOLLOW gone too.
    monkeypatch.delattr(os, "O_NOFOLLOW", raising=False)
    outside = tmp_path / "outside.json"
    outside.write_bytes(b"secret")
    link = tmp_path / "link.json"
    os.symlink(outside, link)
    with pytest.raises(OSError):
        _write(str(link), b"pwned")
    assert outside.read_bytes() == b"secret"


def test_write_project_json_works_without_o_nofollow(tmp_path, monkeypatch):
    # The real caller, with O_NOFOLLOW absent (the Windows smoke's failure point).
    monkeypatch.delattr(os, "O_NOFOLLOW", raising=False)
    from project.init import _write_project_json

    p = tmp_path / "project.json"
    _write_project_json(str(p), {"version": 1, "name": "reel"})
    assert json.loads(p.read_bytes()) == {"version": 1, "name": "reel"}
