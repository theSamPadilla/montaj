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
from tests.conftest import HAS_FFMPEG  # the ffmpeg the code runs (PV52)

try:
    from PIL import Image  # noqa: F401
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

pytestmark = pytest.mark.skipif(
    not HAS_NODE,
    reason="node is required to run sample step tests",
)


# Overlay whose opacity is a pure end-of-life fade keyed to the `duration` global:
# opaque for most of its life, then fades to 0 over the final 8 frames. Sampling a
# single frame must NOT catch it mid-fade just because the tool picked a tiny
# duration — that's the regression these tests guard.
FADE_JSX = """\
export default function FadeOverlay() {
  const out = interpolate(frame, [duration - 8, duration], [1, 0]);
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'white', opacity: out }} />
  );
}
"""


def _center_alpha(png_path):
    """Return the alpha of the center pixel of an RGBA PNG (0-255)."""
    from PIL import Image
    im = Image.open(png_path).convert("RGBA")
    w, h = im.size
    return im.getpixel((w // 2, h // 2))[3]


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
def fixture_fade_jsx(tmp_path):
    """Write an end-of-life-fade overlay JSX and return its path."""
    jsx_path = tmp_path / "fade_overlay.jsx"
    jsx_path.write_text(FADE_JSX, encoding="utf-8")
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


# ── (d) duration default: a single-frame preview shows steady state, not the fade ──

@pytest.mark.skipif(not HAS_PIL, reason="Pillow required to inspect pixel alpha")
def test_sample_overlay_default_duration_previews_steady_state(fixture_fade_jsx, tmp_path):
    """Without --duration, sampling an overlay with an end-of-life fade must render
    it at full opacity (steady state), not mid-fade. Regression: the tool used to
    set duration = frame + 1, so every sampled frame caught the fade-out."""
    out = str(tmp_path / "fade_default.png")
    result = _run_step(
        "steps.render.sample_overlay",
        ["--overlay", fixture_fade_jsx, "--frame", "40", "--out", out],
    )
    assert result.returncode == 0, (
        f"exited {result.returncode}\nstdout: {result.stdout}\nstderr: {result.stderr}"
    )
    alpha = _center_alpha(result.stdout.strip())
    assert alpha >= 240, f"expected near-opaque steady state, got center alpha {alpha}/255"


@pytest.mark.skipif(not HAS_PIL, reason="Pillow required to inspect pixel alpha")
def test_sample_overlay_explicit_duration_shows_fade(fixture_fade_jsx, tmp_path):
    """With --duration matching the sampled frame, the same overlay IS caught mid
    fade-out — proving the flag drives the `duration` global through to the render."""
    out = str(tmp_path / "fade_explicit.png")
    result = _run_step(
        "steps.render.sample_overlay",
        ["--overlay", fixture_fade_jsx, "--frame", "40", "--duration", "41", "--out", out],
    )
    assert result.returncode == 0, (
        f"exited {result.returncode}\nstdout: {result.stdout}\nstderr: {result.stderr}"
    )
    alpha = _center_alpha(result.stdout.strip())
    # frame 40 of a 41-frame overlay → ~1/8 through the 8-frame fade → strongly faded
    assert alpha <= 160, f"expected a faded overlay at the dying edge, got center alpha {alpha}/255"


# ── (e) HDR grade: the extract filter must apply the Montaj Vivid LUT ─────────

def test_sample_frame_hdr_filter_applies_vivid_lut():
    """The HDR (HLG/PQ) → SDR extract filter in sample-frame.js must run the
    Montaj Vivid LUT, not a bare tone-map operator.

    Two regressions live here. The original one: the chain converted to linear
    light and back to BT.709 with no tone-map at all, so HDR highlights above SDR
    white clipped and the frame blew out to near-white. The SP6b one: sample_frame
    is the surface agents and the editor preview read, so if it grades differently
    from the render, "the preview matches the export" quietly stops being true.
    Both are caught by requiring the same lut3d call the renderer makes.

    Asserted at the source level rather than end-to-end because this is a Python
    test with no ffmpeg fixture of its own; the JS suite owns the pixel-level
    proof (sample-frame.test.mjs's HLG tests) and the two runtimes' chain strings
    are compared character-for-character in encode-segment.test.mjs.
    """
    from cli.deps import render_runtime_dir

    js = Path(render_runtime_dir()) / "sample-frame.js"
    assert js.exists(), f"sample-frame.js not found at {js}"
    src = js.read_text(encoding="utf-8")

    # The HDR branch still exists and still calls the shared chain builder,
    # rather than hand-rolling a second copy of it.
    assert "hdrProject" in src, "expected an hdrProject branch in sample-frame.js"
    assert "buildVividLutChain" in src, (
        "sample-frame.js must build its HDR→SDR chain with the shared "
        "buildVividLutChain helper so it cannot drift from the renderer's"
    )
    # PNG output: the chain has to end in an RGB format the png encoder accepts
    # (yuv420p makes it fail outright with 'Could not open encoder before EOF').
    assert "format=rgb24" in src, (
        "the HDR extract chain must terminate in format=rgb24 for the PNG encoder"
    )

    # The Hable chain may still appear, but only as the no-lut3d fallback: one
    # named constant, defined once, used once, in the else arm of the
    # zscale+lut3d check, whose if arm is the healthy buildVividLutChain path.
    lines = src.splitlines()
    hable_lines = [l for l in lines if "tonemap=hable" in l]
    assert len(hable_lines) == 1, (
        f"expected exactly one tonemap=hable chain in sample-frame.js, found {len(hable_lines)}"
    )
    assert hable_lines[0].lstrip().startswith("const HABLE_FALLBACK_VF"), (
        f"tonemap=hable outside HABLE_FALLBACK_VF: {hable_lines[0].strip()}"
    )
    uses = [i for i, l in enumerate(lines)
            if "HABLE_FALLBACK_VF" in l and not l.lstrip().startswith(("const HABLE_FALLBACK_VF", "*", "//"))]
    assert len(uses) == 1, f"HABLE_FALLBACK_VF must be used exactly once, found {len(uses)}"
    use = uses[0]
    # Walk back to the enclosing arm: the nearest earlier line that opens a
    # branch must be the else, and the arm before it must be the healthy path.
    arm = next(i for i in range(use, -1, -1) if "else" in lines[i] or lines[i].lstrip().startswith("if ("))
    assert "} else {" in lines[arm], (
        f"the Hable fallback must sit in the else arm, not {lines[arm].strip()!r}"
    )
    healthy = "\n".join(lines[max(0, arm - 6):arm])
    assert "hasLut3d()" in "\n".join(lines[max(0, arm - 8):arm]), "the arm's condition must test hasLut3d()"
    assert "buildVividLutChain" in healthy and "format=rgb24" in healthy, (
        "the if arm before the Hable fallback must be the buildVividLutChain path ending in rgb24"
    )


# ── (f) cli/commands/sample.py argv forwarding: --fps and sample diff ───────
#
# These monkeypatch cli.commands.sample.subprocess.run so no Puppeteer runs;
# they assert exactly what argv the CLI layer hands to the step scripts,
# mirroring the fake-node approach tests/steps/test_sample_frame.py uses one
# layer down.

import argparse

import cli.commands.sample as sample_cmd


class _FakeCompletedProcess:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _sample_parser():
    parser = argparse.ArgumentParser(prog="montaj")
    subparsers = parser.add_subparsers(dest="command")
    sample_cmd.register(subparsers)
    return parser


def test_sample_overlay_forwards_explicit_fps_to_step_argv(monkeypatch, tmp_path):
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return _FakeCompletedProcess(stdout=str(tmp_path / "out.png") + "\n")

    monkeypatch.setattr(sample_cmd.subprocess, "run", fake_run)

    overlay = tmp_path / "overlay.jsx"
    overlay.write_text("export default function O() { return null; }")
    out = tmp_path / "out.png"

    parser = _sample_parser()
    args = parser.parse_args(
        ["sample", "overlay", str(overlay), "--fps", "60", "--out", str(out)]
    )
    args.func(args)

    cmd = captured["cmd"]
    assert "--fps" in cmd
    assert cmd[cmd.index("--fps") + 1] == "60"


def test_sample_overlay_default_fps_is_30(monkeypatch, tmp_path):
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return _FakeCompletedProcess(stdout=str(tmp_path / "out.png") + "\n")

    monkeypatch.setattr(sample_cmd.subprocess, "run", fake_run)

    overlay = tmp_path / "overlay.jsx"
    overlay.write_text("export default function O() { return null; }")
    out = tmp_path / "out.png"

    parser = _sample_parser()
    args = parser.parse_args(["sample", "overlay", str(overlay), "--out", str(out)])
    args.func(args)

    cmd = captured["cmd"]
    assert "--fps" in cmd
    assert cmd[cmd.index("--fps") + 1] == "30"


def test_sample_diff_forwards_all_frames_as_one_flag(monkeypatch, tmp_path):
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return _FakeCompletedProcess(stdout='{"diff": 0.0, "pops": [], "jumps": []}\n')

    monkeypatch.setattr(sample_cmd.subprocess, "run", fake_run)

    a = tmp_path / "a.png"
    b = tmp_path / "b.png"
    c = tmp_path / "c.png"
    for p in (a, b, c):
        p.write_bytes(b"fake-png")

    parser = _sample_parser()
    args = parser.parse_args(["sample", "diff", str(a), str(b), str(c)])
    args.func(args)

    cmd = captured["cmd"]
    assert "--frames" in cmd
    i = cmd.index("--frames")
    assert cmd[i + 1 : i + 4] == [str(a), str(b), str(c)]


def test_sample_diff_forwards_spike_ratio_and_floor(monkeypatch, tmp_path):
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return _FakeCompletedProcess(stdout='{"diff": 0.0, "pops": [], "jumps": []}\n')

    monkeypatch.setattr(sample_cmd.subprocess, "run", fake_run)

    a = tmp_path / "a.png"
    b = tmp_path / "b.png"
    for p in (a, b):
        p.write_bytes(b"fake-png")

    parser = _sample_parser()
    args = parser.parse_args(
        ["sample", "diff", str(a), str(b), "--spike-ratio", "4.5", "--floor", "1.0"]
    )
    args.func(args)

    cmd = captured["cmd"]
    assert cmd[cmd.index("--spike-ratio") + 1] == "4.5"
    assert cmd[cmd.index("--floor") + 1] == "1.0"
