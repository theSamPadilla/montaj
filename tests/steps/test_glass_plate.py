"""steps/render/glass_plate.py: the footage under an item as blurred low-res frames.

A frosted-glass overlay draws plate frame n behind its glass shapes while it
draws its own frame n, at screen coordinates. That only works when the plate
is exactly the footage as placed on screen: the project's video and image
tracks, every transform and speed applied, frame n being screen frame
round(start * fps) + n.

The fixture makes that falsifiable. A scrolling test pattern (it moves 12 px
per source frame, so one frame of drift is plain) sits on a video track
scaled, offset and at speed 2, then a gap with no footage, then the same clip
at speed 1. The overlay item's range covers the tail of the first clip, the
gap and the head of the second, starting mid-clip.

The reference for each plate frame is montaj's own sample_frame at that screen
frame's time, on a copy of the project without the overlay tracks, shrunk to
the plate size (area) and blurred with the same sigma. Two choices keep it an
honest reference:
  - It samples through `--prefer-proxy`, the clip itself standing in as its
    own proxy. sample_frame's master path seeks with the resolver's `seek`
    (timeline-core activation.js resolveItem), which leaves out the clip's
    speed: on the speed-2 clip it shows the frame half as far in, measured at a
    mean abs of 71-78 against this plate. The proxy path seeks with
    inPoint + speed * elapsed, the export's and the editor's rule (seekTime).
  - The pattern is grey. The proxy path decodes saturated colour with a
    different matrix than the export (measured: about 8 mean abs on testsrc2's
    colour bars at speed 1, where the master path matches the plate to 1.5).
    Grey has no chroma, so only position and timing are compared.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from tests.conftest import FFMPEG_BIN, HAS_FFMPEG, REPO_ROOT, assert_error, skip_or_fail

np = pytest.importorskip("numpy")
from PIL import Image  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is required to render plates")

STEP = REPO_ROOT / "steps" / "render" / "glass_plate.py"
SAMPLE_FRAME = REPO_ROOT / "steps" / "render" / "sample_frame.py"

FPS = 24
SIGMA = 2.2

# Measured on this fixture (managed ffmpeg 8.1.2): plate against its own
# screen frame, mean abs per frame 1.6-2.2 on the scaled speed-2 clip, 0.2 on
# the full-canvas clip, 0.0 in the gap. The same plate one frame late against
# the same references: 10.6-13.4 on every frame with footage (up to 133 where
# the shift crosses the gap's edges). 5.0 sits at 2.3x the worst aligned frame
# and below half the smallest one-frame miss.
MAX_MEAN_ABS = 5.0

# The overlay "glass": 1.0-2.0 s, screen frames 24-47. Clip "a" covers frames
# 24-35 of it, the gap 36-41, clip "b" 42-47.
GLASS = {"start": 1.0, "end": 2.0}
# Off the frame grid at both ends: round(24.48) = 24, round(36.84) = 37, so the
# overlay rule gives 13 frames where round((end - start) * fps) gives 12.
OFFGRID = {"start": 1.02, "end": 1.535}


def _ffmpeg(*args):
    subprocess.run([FFMPEG_BIN, "-v", "error", "-y", *args], check=True, capture_output=True, timeout=120)


def _clips(src, proxy=False):
    extra = {"proxySrc": src} if proxy else {}
    return [
        {"id": "a", "type": "video", "src": src, "start": 0.25, "end": 1.5,
         "inPoint": 0.5, "outPoint": 3.0, "speed": 2,
         "scale": 0.8, "offsetX": 10, "offsetY": -5, **extra},
        {"id": "b", "type": "video", "src": src, "start": 1.75, "end": 2.5,
         "inPoint": 3.0, "outPoint": 3.75, **extra},
    ]


def _project(pid, tracks):
    return {
        "version": "0.2", "id": pid, "status": "draft", "projectType": "editing",
        "settings": {"fps": FPS, "resolution": [1920, 1080], "colorSpace": "sdr_bt709"},
        "tracks": tracks,
    }


@pytest.fixture(scope="module")
def fixture(tmp_path_factory):
    if not HAS_FFMPEG:
        skip_or_fail("glass_plate renders with ffmpeg")
    root = tmp_path_factory.mktemp("glass_plate")
    proj = root / "proj"
    proj.mkdir()
    clip = proj / "clip.mp4"
    # A 1280-wide pattern cropped through a sliding 640 window: 12 px of motion
    # per source frame, grey, tagged BT.709 so no reader has to guess.
    _ffmpeg("-f", "lavfi", "-i",
            "testsrc2=size=1280x360:rate=24:duration=6,crop=640:360:'mod(n*12,640)':0,"
            "hue=s=0,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
            "-c:v", "libx264", "-g", "24", str(clip))
    (proj / "glass.jsx").write_text("export default function Glass() { return <div /> }\n")
    (proj / "project.json").write_text(json.dumps(_project("plate-test", [
        {"id": "trk-0", "items": _clips("clip.mp4")},
        {"id": "trk-1", "items": [{"id": "glass", "type": "overlay", "src": "glass.jsx", **GLASS}]},
        {"id": "trk-2", "items": [{"id": "offgrid", "type": "overlay", "src": "glass.jsx", **OFFGRID}]},
    ])))
    # The reference: the same footage, no overlay tracks.
    ref = root / "ref"
    ref.mkdir()
    (ref / "project.json").write_text(json.dumps(_project("plate-ref", [
        {"id": "trk-0", "items": _clips(str(clip), proxy=True)},
    ])))
    # sample_frame keeps a cross-process frame cache under $TMPDIR: a private
    # one, so no earlier run can answer for this one.
    tmp = root / "tmp"
    tmp.mkdir()
    env = {**os.environ, "TMPDIR": str(tmp)}
    return {"root": root, "proj": proj, "ref": ref, "env": env}


def _run(fixture, *args):
    return subprocess.run([sys.executable, str(STEP), *args],
                          capture_output=True, text=True, env=fixture["env"], timeout=600)


@pytest.fixture(scope="module")
def glass_plate(fixture):
    proc = _run(fixture, "--project", str(fixture["proj"]), "--item", "glass")
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def _rgb(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)


def _reference(fixture, screen_frame, size):
    """sample_frame at the screen frame's time, shrunk and blurred like a plate."""
    full = fixture["root"] / f"ref-{screen_frame:04d}.png"
    small = fixture["root"] / f"ref-{screen_frame:04d}-small.png"
    proc = subprocess.run(
        [sys.executable, str(SAMPLE_FRAME), "--project", str(fixture["ref"] / "project.json"),
         "--at", repr(screen_frame / FPS), "--prefer-proxy", "--out", str(full)],
        capture_output=True, text=True, env=fixture["env"], timeout=120)
    assert proc.returncode == 0, proc.stderr
    w, h = size
    _ffmpeg("-i", str(full), "-vf", f"scale={w}:{h}:flags=area,format=yuv420p,gblur=sigma={SIGMA}", str(small))
    return _rgb(small)


def test_plate_frame_n_is_the_screen_frame_under_the_items_frame_n(fixture, glass_plate):
    assert set(glass_plate) == {"frames", "fps", "size"}
    assert glass_plate["fps"] == FPS
    assert glass_plate["size"] == [480, 270]
    first = round(GLASS["start"] * FPS)
    count = round(GLASS["end"] * FPS) - first
    assert len(glass_plate["frames"]) == count == 24

    means = []
    for n, path in enumerate(glass_plate["frames"]):
        plate = _rgb(path)
        assert plate.shape == (270, 480, 3)
        means.append(float(np.abs(plate - _reference(fixture, first + n, glass_plate["size"])).mean()))
    report = " ".join(f"{m:.1f}" for m in means)
    assert max(means) < MAX_MEAN_ABS, f"plate vs screen frame, mean abs per frame: {report}"
    # The gap (screen frames 36-41) is black, not the clip's last frame held.
    assert max(means[12:18]) < MAX_MEAN_ABS
    assert all(_rgb(p).max() < 8 for p in glass_plate["frames"][12:18])


def test_frames_default_to_the_items_plates_folder(fixture, glass_plate):
    out = fixture["proj"] / "plates" / "glass"
    expected = [str(out / f"{n:04d}.jpg") for n in range(24)]
    assert glass_plate["frames"] == expected
    assert sorted(os.listdir(out)) == [f"{n:04d}.jpg" for n in range(24)]


def test_frame_count_is_the_overlays_rounding_and_only_stale_frames_are_cleared(fixture):
    out = fixture["root"] / "offgrid"
    out.mkdir()
    # A longer earlier plate's tail, and files that are not frames.
    for name in ("0012.jpg", "0013.jpg", "0099.jpg", "12345.jpg"):
        (out / name).write_bytes(b"stale")
    keep = ["notes.txt", "cover.jpg", "001.jpg", "0001.png"]
    for name in keep:
        (out / name).write_bytes(b"keep")

    proc = _run(fixture, "--project", str(fixture["proj"] / "project.json"), "--item", "offgrid",
                "--out", str(out))
    assert proc.returncode == 0, proc.stderr
    frames = json.loads(proc.stdout)["frames"]

    expected = round(OFFGRID["end"] * FPS) - round(OFFGRID["start"] * FPS)
    assert expected == 13
    assert round((OFFGRID["end"] - OFFGRID["start"]) * FPS) == 12  # the rule this is not
    assert len(frames) == expected
    on_disk = sorted(n for n in os.listdir(out) if n not in keep)
    assert on_disk == [f"{n:04d}.jpg" for n in range(expected)]
    for name in keep:
        assert (out / name).read_bytes() == b"keep"


def test_unknown_item_is_refused_by_name(fixture):
    proc = _run(fixture, "--project", str(fixture["proj"] / "project.json"), "--item", "no-such-item")
    assert_error(proc, "unknown_item")
    assert "no-such-item" in proc.stderr
    assert not (fixture["proj"] / "plates" / "no-such-item").exists()
