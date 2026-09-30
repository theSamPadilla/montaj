"""fetch must run yt-dlp through montaj's own Python, never a PATH lookup.

A packaged app has a minimal PATH, and must not depend on a system yt-dlp.
The network is never touched: subprocess.run is stubbed to capture argv.
"""
import os
import stat
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "steps" / "media"))

import fetch  # noqa: E402


def test_fetch_uses_own_python_not_path_yt_dlp(tmp_path, monkeypatch, capsys):
    marker = tmp_path / "path_yt_dlp_called"
    fake_dir = tmp_path / "bin"
    fake_dir.mkdir()
    fake = fake_dir / "yt-dlp"
    fake.write_text(f"#!/bin/sh\n/usr/bin/touch {marker}\nexit 42\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", str(fake_dir))

    captured = {}
    real_run = subprocess.run

    def fake_run(cmd, *a, **kw):
        captured["cmd"] = list(cmd)
        # Execute only when it would resolve via PATH, as the real call would.
        if cmd[0] == "yt-dlp":
            return real_run(cmd, capture_output=True, text=True)
        return subprocess.CompletedProcess(cmd, 0, stdout=str(tmp_path / "a.mp4") + "\n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["fetch.py", "--url", "file:///nope", "--out", str(tmp_path / "o")])

    try:
        fetch.main()
    except SystemExit:
        pass

    cmd = captured["cmd"]
    assert cmd[:3] == [sys.executable, "-m", "yt_dlp"]
    assert not marker.exists()
    assert "--js-runtimes" in cmd and cmd[cmd.index("--js-runtimes") + 1] == "node"
