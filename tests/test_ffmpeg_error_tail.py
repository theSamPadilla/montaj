"""ffmpeg errors carry ffmpeg's last lines, not its banner."""
import json
import os
import subprocess
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))

BANNER = [
    "ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers",
    "  built with Apple clang version 17.0.0",
    "  configuration: --prefix=/opt/homebrew --enable-gpl " + "--enable-x " * 150,
    "  libavutil      60.  8.100 / 60.  8.100",
    "  libavcodec     62. 11.100 / 62. 11.100",
]
REAL = "Error opening input file /x/gone.mp3: No such file or directory"
STDERR = "\n".join(BANNER + [f"progress line {i}" for i in range(30)] + [REAL, ""])


def test_tail_keeps_last_line_drops_banner():
    from common import ffmpeg_error_tail
    tail = ffmpeg_error_tail(STDERR)
    assert tail.endswith(REAL)
    assert "ffmpeg version" not in tail and "configuration:" not in tail
    assert len(tail) < 1000
    assert len(tail.splitlines()) == 10


def test_tail_tolerates_none_and_bytes():
    from common import ffmpeg_error_tail
    assert ffmpeg_error_tail(None) == ""
    assert ffmpeg_error_tail(STDERR.encode()).endswith(REAL)


def test_normalize_encode_failure_carries_real_reason(monkeypatch, tmp_path, capsys):
    from lib import normalize
    r = types.SimpleNamespace(returncode=1, stderr=STDERR, stdout="")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: r)
    with pytest.raises(SystemExit):
        normalize._run_atomic_encode(["ffmpeg"], str(tmp_path / "t.mp4"), str(tmp_path / "o.mp4"), label="SDR normalize")
    msg = json.loads(capsys.readouterr().err.strip().splitlines()[-1])["message"]
    assert msg.endswith(REAL)
    assert "ffmpeg version" not in msg and "configuration:" not in msg
    assert len(msg) < 1000
