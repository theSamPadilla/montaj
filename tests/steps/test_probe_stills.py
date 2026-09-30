"""`probe` on still images: no container duration, so no crash (PNG and JPEG alike)."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "lib"))
from common import ffmpeg_bin

PROBE = Path(__file__).parent.parent.parent / "steps" / "media" / "probe.py"


def _make(tmp_path, name, *args):
    out = tmp_path / name
    subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-f", "lavfi", "-i",
                    "color=red:s=16x16:d=1:r=10", *args, str(out)], check=True)
    return out


def _probe(path):
    r = subprocess.run([sys.executable, str(PROBE), "--input", str(path)],
                       capture_output=True, text=True, env=dict(os.environ))
    return r


def test_png_and_jpeg_probe_alike(tmp_path):
    png = _make(tmp_path, "x.png", "-frames:v", "1")
    jpg = _make(tmp_path, "x.jpg", "-frames:v", "1")
    rp, rj = _probe(png), _probe(jpg)
    assert rp.returncode == 0, rp.stderr
    assert rj.returncode == 0, rj.stderr
    p, j = json.loads(rp.stdout), json.loads(rj.stdout)
    assert set(p) == set(j)
    assert p["duration"] == j["duration"] == 0.0
    assert set(p["streams"][0]) == set(j["streams"][0])
    assert p["streams"][0]["type"] == "video"
    assert (p["streams"][0]["width"], p["streams"][0]["height"]) == (16, 16)


def test_video_still_reports_duration(tmp_path):
    mp4 = _make(tmp_path, "x.mp4", "-c:v", "libx264", "-pix_fmt", "yuv420p")
    r = _probe(mp4)
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["duration"] == pytest.approx(1.0, abs=0.2)
