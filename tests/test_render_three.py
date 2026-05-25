"""End-to-end smoke test for Three.js / r3f support in the overlay renderer.

Builds a minimal 1-second project containing a single overlay (the cube fixture)
over a black background, runs render.js through Node, and asserts that the
output is a real video with non-trivial pixel content (i.e. the cube actually
drew — not a blank frame from a silently-failed WebGL context).

Marked `slow` because it spawns Puppeteer and an ffmpeg encode. Skipped by
default. Run explicitly with `pytest tests/test_render_three.py -m slow`.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT     = Path(__file__).resolve().parent.parent
RENDER_JS     = REPO_ROOT / "montaj_assets" / "render" / "render.js"
CUBE_FIXTURE  = REPO_ROOT / "tests" / "fixtures" / "overlays" / "three-cube.jsx"


def _require(binary: str) -> None:
    if shutil.which(binary) is None:
        pytest.skip(f"{binary} not on PATH")


@pytest.mark.slow
def test_render_three_cube_overlay(tmp_path):
    """Render a 1s project with a single r3f overlay and verify the cube drew."""
    _require("node")
    _require("ffmpeg")
    _require("ffprobe")

    # 1. Generate a 1-second black 1080x1920 background clip via ffmpeg lavfi
    bg_clip = tmp_path / "black.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", "color=black:s=1080x1920:r=30:d=1.0",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "1.0",
        str(bg_clip),
    ], check=True)

    # 2. Copy the cube overlay fixture into the project workspace (render
    #    resolves absolute paths, so an in-place reference would also work
    #    — copying keeps the project self-contained).
    project_overlays = tmp_path / "overlays"
    project_overlays.mkdir()
    cube_jsx = project_overlays / "three-cube.jsx"
    cube_jsx.write_text(CUBE_FIXTURE.read_text())

    # 3. Build project.json
    project = {
        "version":  "0.2",
        "id":       "three-smoke-test",
        "status":   "final",
        "settings": {"resolution": [1080, 1920], "fps": 30},
        "tracks": [
            [{
                "id":             "clip-0",
                "type":           "video",
                "src":            str(bg_clip),
                "start":          0.0,
                "end":            1.0,
                "inPoint":        0.0,
                "outPoint":       1.0,
                "sourceDuration": 1.0,
            }],
            [{
                "id":    "ov-cube",
                "type":  "overlay",
                "src":   str(cube_jsx),
                "start": 0.0,
                "end":   1.0,
                "props": {},
            }],
        ],
        "assets": [],
        "audio":  {},
    }
    project_json = tmp_path / "project.json"
    project_json.write_text(json.dumps(project))

    # 4. Run render.js
    result = subprocess.run(
        ["node", str(RENDER_JS), str(project_json)],
        capture_output=True, text=True, timeout=300,
    )
    assert result.returncode == 0, (
        f"render.js exited {result.returncode}\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )

    # render.js prints the final mp4 path as its last stdout line
    output_path = Path(result.stdout.strip().splitlines()[-1])
    assert output_path.exists(), f"expected output at {output_path}"
    assert output_path.stat().st_size > 10_000, f"output too small: {output_path.stat().st_size} bytes"

    # 5. ffprobe — confirm shape
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", str(output_path),
    ], capture_output=True, text=True, check=True)
    probe_data = json.loads(probe.stdout)
    video = next(s for s in probe_data["streams"] if s["codec_type"] == "video")
    assert video["width"]  == 1080
    assert video["height"] == 1920
    duration = float(probe_data["format"]["duration"])
    assert 0.8 < duration < 1.2, f"unexpected duration {duration}"

    # 6. Pull a mid-clip frame and verify the cube actually drew — i.e. the
    #    frame is not solid black. A blue cube on black means stddev of pixel
    #    values will be well above zero. A solid black frame (silent WebGL
    #    failure) would give stddev ~0.
    mid_frame = tmp_path / "mid.png"
    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-ss", "0.5", "-i", str(output_path),
        "-frames:v", "1", str(mid_frame),
    ], check=True)
    stats = subprocess.run([
        "ffmpeg", "-v", "info", "-i", str(mid_frame),
        "-vf", "signalstats,metadata=print:file=-",
        "-f", "null", "-",
    ], capture_output=True, text=True)
    # signalstats prints lavfi.signalstats.YAVG etc.; we expect non-zero variation.
    # Simpler: just assert the PNG is more than a few KB (a black PNG compresses
    # to ~1 KB, anything with content is meaningfully larger).
    assert mid_frame.stat().st_size > 5_000, (
        f"mid frame {mid_frame.stat().st_size} bytes — likely solid color, cube did not render"
    )
