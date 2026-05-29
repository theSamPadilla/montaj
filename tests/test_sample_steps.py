"""Tests for steps/render/sample_overlay.py and steps/render/sample_frame.py.

Tests:
  (a) sample_overlay: exits 0, prints a valid PNG path, file exists.
  (b) sample_overlay --measure: exits 0, prints JSON with pngPath and
      measurements.anyOverflow keys.
  (c) sample_frame: exits 0, prints a valid PNG path, file exists.

Fixtures:
  - JSX: a minimal self-contained overlay written to tmp_path in setup.
  - project.json: uses /Users/Sam/Montaj/2026-05-28-opus-4-8/project.json if
    available, otherwise creates a minimal one (image-only, no external video
    dependency).
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
FIXTURE_PROJECT = Path("/Users/Sam/Montaj/2026-05-28-opus-4-8/project.json")

# ── Skip guard: node must be available ────────────────────────────────────────

import shutil

HAS_NODE = shutil.which("node") is not None

pytestmark = pytest.mark.skipif(
    not HAS_NODE,
    reason="node is required to run sample step tests",
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

MINIMAL_JSX = """\
export default function MinimalOverlay() {
  return (
    <div style={{
      position: 'absolute',
      top: 80,
      left: 0,
      right: 0,
      textAlign: 'center',
      fontFamily: 'sans-serif',
      fontSize: '48px',
      color: 'white',
    }}>
      Hello
    </div>
  );
}
"""


@pytest.fixture
def fixture_jsx(tmp_path):
    """Write a tiny self-contained overlay JSX to tmp_path and return the path."""
    jsx_path = tmp_path / "minimal_overlay.jsx"
    jsx_path.write_text(MINIMAL_JSX, encoding="utf-8")
    return str(jsx_path)


@pytest.fixture
def fixture_project(tmp_path):
    """Return a project.json path suitable for sample_frame tests.

    Prefers the real project at FIXTURE_PROJECT. Falls back to a minimal
    image-only project that has no external video dependency.
    """
    if FIXTURE_PROJECT.exists():
        return str(FIXTURE_PROJECT)

    # Minimal fallback: single image item on a static track.
    # We use ffmpeg to create a 1x1 PNG as the image source so there's no
    # dependency on files outside the test run.
    img_path = tmp_path / "bg.png"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "color=c=black:size=1080x1920:rate=1:duration=1",
            "-frames:v", "1", "-update", "1", str(img_path),
        ],
        check=True, capture_output=True, timeout=30,
    )

    project = {
        "version": "0.2",
        "id": "test-project",
        "status": "draft",
        "projectType": "editing",
        "settings": {
            "fps": 30,
            "resolution": [1080, 1920],
            "colorSpace": "sdr_bt709",
        },
        "tracks": [
            [
                {
                    "id": "img-0",
                    "type": "image",
                    "src": str(img_path),
                    "start": 0,
                    "end": 5,
                }
            ]
        ],
        "audio": {"tracks": []},
    }
    project_path = tmp_path / "project.json"
    project_path.write_text(json.dumps(project, indent=2), encoding="utf-8")
    return str(project_path)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _run_step(module, args, timeout=120):
    """Run a step script as python -m <module> and return the CompletedProcess."""
    return subprocess.run(
        [sys.executable, "-m", module] + args,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=timeout,
    )


# ── (a) sample_overlay: basic PNG output ─────────────────────────────────────

def test_sample_overlay_exits_zero_and_produces_png(fixture_jsx, tmp_path):
    """sample_overlay exits 0, stdout is a valid PNG path, file exists."""
    out = str(tmp_path / "overlay_out.png")
    result = _run_step(
        "steps.render.sample_overlay",
        ["--overlay", fixture_jsx, "--out", out],
    )
    assert result.returncode == 0, (
        f"sample_overlay exited {result.returncode}\nstdout: {result.stdout}\nstderr: {result.stderr}"
    )
    png_path = result.stdout.strip()
    assert png_path, "stdout was empty — expected a PNG path"
    assert os.path.isfile(png_path), f"PNG not found at reported path: {png_path!r}"
    assert png_path.endswith(".png"), f"Expected a .png path, got: {png_path!r}"


# ── (b) sample_overlay --measure: JSON with pngPath + measurements ────────────

def test_sample_overlay_measure_returns_json_with_required_keys(fixture_jsx, tmp_path):
    """sample_overlay --measure exits 0, stdout is JSON with pngPath and measurements.anyOverflow."""
    out = str(tmp_path / "overlay_measure.png")
    result = _run_step(
        "steps.render.sample_overlay",
        ["--overlay", fixture_jsx, "--out", out, "--measure"],
    )
    assert result.returncode == 0, (
        f"sample_overlay --measure exited {result.returncode}\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    stdout = result.stdout.strip()
    assert stdout, "stdout was empty — expected a JSON object"

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as e:
        pytest.fail(f"stdout is not valid JSON: {e}\nraw stdout: {stdout!r}")

    assert "pngPath" in data, f"'pngPath' key missing from JSON: {data}"
    assert "measurements" in data, f"'measurements' key missing from JSON: {data}"
    assert "anyOverflow" in data["measurements"], (
        f"'measurements.anyOverflow' key missing from JSON: {data}"
    )

    assert os.path.isfile(data["pngPath"]), (
        f"pngPath in JSON does not exist on disk: {data['pngPath']!r}"
    )


# ── (c) sample_frame: composited project frame ────────────────────────────────

def test_sample_frame_exits_zero_and_produces_png(fixture_project, tmp_path):
    """sample_frame exits 0, stdout is a valid PNG path, file exists."""
    out = str(tmp_path / "frame_out.png")
    result = _run_step(
        "steps.render.sample_frame",
        ["--project", fixture_project, "--at", "1.5", "--out", out],
    )
    assert result.returncode == 0, (
        f"sample_frame exited {result.returncode}\nstdout: {result.stdout}\nstderr: {result.stderr}"
    )
    png_path = result.stdout.strip()
    assert png_path, "stdout was empty — expected a PNG path"
    assert os.path.isfile(png_path), f"PNG not found at reported path: {png_path!r}"
    assert png_path.endswith(".png"), f"Expected a .png path, got: {png_path!r}"
