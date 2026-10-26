"""PL89c: a sheet's frames render at the design canvas (short edge 1080), not the project's own size.

PL89c's contact sheets of 17 and 19 times composited every frame at the 2160x3840 canvas, then shrank each to a 320 px
tile. Several times in one call are always a sheet, so sample_frames caps them at SHEET_SHORT_EDGE, the canvas the
overlays and the type floors are measured on; one time (a single sample) stays the project's full size.
"""
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

import steps.render.sample_frame as sf  # noqa: E402


def capture(monkeypatch, tmp_path):
    seen = []

    def fake(cmd, timeout=None, env=None):
        seen.append(cmd)
        n = cmd.count("--at")
        out = []
        for k in range(n):
            p = tmp_path / f"f_{k:04d}.png"
            p.write_bytes(b"png")
            out.append(str(p))
        return subprocess.CompletedProcess(cmd, 0, ("\n".join(out) + "\n").encode(), b"")
    monkeypatch.setattr(sf, "run_stopping", fake)
    return seen


def test_several_times_are_capped_at_the_design_canvas_and_one_time_is_not(monkeypatch, tmp_path):
    seen = capture(monkeypatch, tmp_path)
    assert sf.SHEET_SHORT_EDGE == 1080
    sf.sample_frames("/p/project.json", [1, 2, 3], str(tmp_path))
    assert seen[-1][seen[-1].index("--max-short-edge") + 1] == "1080"
    sf.sample_frames("/p/project.json", [1], str(tmp_path))
    assert "--max-short-edge" not in seen[-1], "a single sample stays full size"
    sf.sample_frames("/p/project.json", [1, 2], str(tmp_path), raw=True)
    assert "--max-short-edge" not in seen[-1], "a raw source frame is the source as stored"
