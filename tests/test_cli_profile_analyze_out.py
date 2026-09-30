"""`montaj profile analyze` default output folder: one path separator per OS."""
import ntpath
import os
import posixpath

import cli.commands.profile as profile_cmd


def test_default_out_is_uniformly_backslashed_on_windows(monkeypatch):
    monkeypatch.setenv("USERPROFILE", r"C:\Users\Zoe\AppData\Local\Montaj\runtime-home")
    monkeypatch.delenv("HOME", raising=False)
    out = profile_cmd.default_analyze_out("old", path=ntpath)
    assert out == r"C:\Users\Zoe\AppData\Local\Montaj\runtime-home\.montaj\profiles\old"
    assert "/" not in out


def test_default_out_on_posix_is_unchanged(monkeypatch):
    monkeypatch.setenv("HOME", "/home/zoe")
    out = profile_cmd.default_analyze_out("old", path=posixpath)
    assert out == "/home/zoe/.montaj/profiles/old"


def test_handle_analyze_uses_default(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    seen = {}

    class R:
        returncode = 0

    monkeypatch.setattr(profile_cmd.subprocess, "run", lambda cmd, **kw: seen.setdefault("cmd", cmd) and R())
    from argparse import Namespace
    profile_cmd.handle_analyze(Namespace(name="old", source="s", out=None, videos=["a.mp4"]))
    cmd = seen["cmd"]
    assert cmd[cmd.index("--out") + 1] == os.path.join(str(tmp_path), ".montaj", "profiles", "old")
