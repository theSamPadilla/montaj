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
  - The reference path is the normal one (master footage, no proxy), the
    export's seek rule included: before the resolver's `seek` applied a clip's
    speed, sample_frame showed the speed-2 clip's frame half as far in.
  - The pattern is grey, so only position and timing are compared and
    colour-matrix differences cannot move the means.

Colour is checked apart, on flat saturated swatches (a red clip, then a green
one, under the item "swatch"): the plate's mean RGB against sample_frame's. A
browser decodes a JPEG as BT.601 full range, so a plate holding the parts'
BT.709 limited-range values came out (210, 0, 73) where sample_frame shows
(228, 24, 72).

Two far clips sit outside every item's range, one that normalize would
re-encode and one with two audio streams: a plate must not prepare them.
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
# The swatches: red over 3.0-3.5 s, green over 3.5-4.0 s, screen frames 72-95.
SWATCH = {"start": 3.0, "end": 4.0}
RED, GREEN = "e6194b", "3cb44b"
# Measured on this fixture (managed ffmpeg 8.1.2): the plate's mean RGB against
# sample_frame's, worst channel, is 2 (red) and 1 (green). With the plate's
# JPEGs holding BT.709 limited-range values it was 24 (red) and 21 (green).
MAX_COLOUR_DIFF = 4.0
# Outside every item's range: 5.0-6.0 s and 6.0-7.0 s.
FAR = ["norm.mp4", "two_audio.mp4"]


def _ffmpeg(*args):
    subprocess.run([FFMPEG_BIN, "-v", "error", "-y", *args], check=True, capture_output=True, timeout=120)


def _swatch(path, colour, audio_streams=0):
    """A flat clip of `colour` (hex RGB), BT.709 limited range and tagged, 2 s
    with a keyframe every half second, so normalize leaves it alone."""
    audio = []
    for n in range(audio_streams):
        audio += ["-f", "lavfi", "-i", f"sine=f={440 * (n + 1)}:d=2"]
    maps = ["-map", "0:v"] + [a for n in range(audio_streams) for a in ("-map", f"{n + 1}:a")]
    _ffmpeg("-f", "lavfi", "-i",
            f"color=c=0x{colour}:s=640x360:r=24:d=2,scale=out_color_matrix=bt709:out_range=tv,"
            "format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
            *audio, *maps, "-c:v", "libx264", "-g", "12", *(["-c:a", "aac"] if audio_streams else []),
            str(path))


def _clips(src, red, green):
    return [
        {"id": "a", "type": "video", "src": src, "start": 0.25, "end": 1.5,
         "inPoint": 0.5, "outPoint": 3.0, "speed": 2,
         "scale": 0.8, "offsetX": 10, "offsetY": -5},
        {"id": "b", "type": "video", "src": src, "start": 1.75, "end": 2.5,
         "inPoint": 3.0, "outPoint": 3.75},
        {"id": "red", "type": "video", "src": red, "start": 3.0, "end": 3.5,
         "inPoint": 0.5, "outPoint": 1.0},
        {"id": "green", "type": "video", "src": green, "start": 3.5, "end": 4.0,
         "inPoint": 0.5, "outPoint": 1.0},
    ]


def _far_clips():
    return [
        {"id": "far-norm", "type": "video", "src": "far/norm.mp4", "start": 5.0, "end": 6.0,
         "inPoint": 0, "outPoint": 1.0},
        {"id": "far-audio", "type": "video", "src": "far/two_audio.mp4", "start": 6.0, "end": 7.0,
         "inPoint": 0, "outPoint": 1.0},
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
    _swatch(proj / "red.mp4", RED)
    # Two audio streams: preparing it writes green_audioclean.mp4, the sign that
    # a clip inside the range is still prepared.
    _swatch(proj / "green.mp4", GREEN, audio_streams=2)
    far = proj / "far"
    far.mkdir()
    # Untagged with a single keyframe: normalize would re-encode it.
    _ffmpeg("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2,format=yuv420p",
            "-c:v", "libx264", "-g", "240", str(far / "norm.mp4"))
    # Conforming, with two audio streams: the audio strip would copy it.
    _swatch(far / "two_audio.mp4", GREEN, audio_streams=2)
    (proj / "glass.jsx").write_text("export default function Glass() { return <div /> }\n")
    (proj / "project.json").write_text(json.dumps(_project("plate-test", [
        {"id": "trk-0", "items": _clips("clip.mp4", "red.mp4", "green.mp4") + _far_clips()},
        {"id": "trk-1", "items": [{"id": "glass", "type": "overlay", "src": "glass.jsx", **GLASS},
                                  {"id": "swatch", "type": "overlay", "src": "glass.jsx", **SWATCH}]},
        {"id": "trk-2", "items": [{"id": "offgrid", "type": "overlay", "src": "glass.jsx", **OFFGRID}]},
    ])))
    # The reference: the same footage, no overlay tracks.
    ref = root / "ref"
    ref.mkdir()
    (ref / "project.json").write_text(json.dumps(_project("plate-ref", [
        {"id": "trk-0", "items": _clips(str(clip), str(proj / "red.mp4"), str(proj / "green.mp4"))},
    ])))
    # sample_frame keeps a cross-process frame cache under $TMPDIR: a private
    # one, so no earlier run can answer for this one.
    tmp = root / "tmp"
    tmp.mkdir()
    env = {**os.environ, "TMPDIR": str(tmp)}
    return {"root": root, "proj": proj, "ref": ref, "env": env}


def _run(fixture, *args, env=None):
    return subprocess.run([sys.executable, str(STEP), *args],
                          capture_output=True, text=True, env=env or fixture["env"], timeout=600)


@pytest.fixture(scope="module")
def glass_plate(fixture):
    proc = _run(fixture, "--project", str(fixture["proj"]), "--item", "glass")
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


@pytest.fixture(scope="module")
def swatch_plate(fixture):
    proc = _run(fixture, "--project", str(fixture["proj"]), "--item", "swatch")
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def _rgb(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)


def _sample_frame(fixture, screen_frame):
    """The reference project's frame at the screen frame's time, full size."""
    full = fixture["root"] / f"ref-{screen_frame:04d}.png"
    if not full.exists():
        proc = subprocess.run(
            [sys.executable, str(SAMPLE_FRAME), "--project", str(fixture["ref"] / "project.json"),
             "--at", repr(screen_frame / FPS), "--out", str(full)],
            capture_output=True, text=True, env=fixture["env"], timeout=120)
        assert proc.returncode == 0, proc.stderr
    return full


def _reference(fixture, screen_frame, size):
    """sample_frame at the screen frame's time, shrunk and blurred like a plate."""
    full = _sample_frame(fixture, screen_frame)
    small = fixture["root"] / f"ref-{screen_frame:04d}-small.png"
    w, h = size
    _ffmpeg("-i", str(full), "-vf", f"scale={w}:{h}:flags=area,format=yuv420p,gblur=sigma={SIGMA}", str(small))
    return _rgb(small)


def test_plate_frame_n_is_the_screen_frame_under_the_items_frame_n(fixture, glass_plate):
    assert set(glass_plate) == {"frames", "fps", "size", "canvas"}
    assert glass_plate["fps"] == FPS
    assert glass_plate["size"] == [480, 270]
    # The overlay's design canvas: 1080 on the short edge, the resolution's aspect.
    assert glass_plate["canvas"] == [1920, 1080]
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


def test_plate_colours_match_the_export_on_saturated_footage(fixture, swatch_plate):
    first = round(SWATCH["start"] * FPS)
    assert len(swatch_plate["frames"]) == round(SWATCH["end"] * FPS) - first == 24
    report, worst = [], 0.0
    # Mid-swatch frames: red is plate frames 0-11, green 12-23.
    for name, n in (("red", 6), ("green", 18)):
        plate = _rgb(swatch_plate["frames"][n]).reshape(-1, 3).mean(axis=0)
        ref = _rgb(_sample_frame(fixture, first + n)).reshape(-1, 3).mean(axis=0)
        diff = float(np.abs(plate - ref).max())
        worst = max(worst, diff)
        report.append(f"{name}: plate {np.round(plate, 1).tolist()} sample_frame {np.round(ref, 1).tolist()}")
    assert worst <= MAX_COLOUR_DIFF, "; ".join(report)


def test_only_the_clips_under_the_item_are_prepared(fixture, glass_plate, swatch_plate):
    # Outside every range: no normalized master, no audio-clean copy.
    assert sorted(os.listdir(fixture["proj"] / "far")) == FAR
    # Inside the swatch range: green has two audio streams, so preparing it
    # wrote its audio-clean copy. A plate that prepared nothing would pass the
    # assertion above too.
    assert (fixture["proj"] / "green_audioclean.mp4").exists()


@pytest.mark.parametrize("which", ["home", "root", "home's parent"])
def test_out_cannot_be_home_a_root_or_a_folder_holding_home(fixture, tmp_path, which):
    home = tmp_path / "home"
    home.mkdir()
    (home / "0001.jpg").write_bytes(b"mine")
    out = {"home": home, "root": Path(home.anchor), "home's parent": tmp_path}[which]
    proc = _run(fixture, "--project", str(fixture["proj"]), "--item", "glass", "--out", str(out),
                env={**fixture["env"], "HOME": str(home)})
    assert_error(proc, "invalid_out")
    assert sorted(os.listdir(home)) == ["0001.jpg"]
    assert (home / "0001.jpg").read_bytes() == b"mine"
    assert sorted(os.listdir(tmp_path)) == ["home"]


def test_an_out_that_cannot_be_made_is_refused(fixture, tmp_path):
    (tmp_path / "file.txt").write_text("not a folder")
    proc = _run(fixture, "--project", str(fixture["proj"]), "--item", "glass",
                "--out", str(tmp_path / "file.txt" / "plates"))
    assert_error(proc, "invalid_out")


def _small_project(root, items):
    root.mkdir()
    (root / "glass.jsx").write_text("export default function Glass() { return <div /> }\n")
    (root / "project.json").write_text(json.dumps(_project("plate-small", [
        {"id": "trk-0", "items": [it for it in items if it["type"] == "video"]},
        {"id": "trk-1", "items": [it for it in items if it["type"] == "overlay"]},
    ])))
    return root


@pytest.mark.parametrize("item_id", ["C:x", "a/b", "a\\b", ".."])
def test_an_item_id_that_cannot_name_a_folder_needs_an_out(fixture, tmp_path, item_id):
    # "C:x" joined on Windows is relative to drive C's current folder, not plates/.
    proj = _small_project(tmp_path / "proj",
                          [{"id": item_id, "type": "overlay", "src": "glass.jsx", "start": 0, "end": 0.25}])
    proc = _run(fixture, "--project", str(proj), "--item", item_id)
    assert_error(proc, "invalid_item")
    assert not (proj / "plates").exists()


def test_a_failed_rerun_keeps_the_previous_plate(fixture, tmp_path):
    proj = _small_project(tmp_path / "proj", [
        {"id": "clip", "type": "video", "src": "red.mp4", "start": 0, "end": 0.5, "inPoint": 0, "outPoint": 0.5},
        {"id": "ov", "type": "overlay", "src": "glass.jsx", "start": 0, "end": 0.5},
    ])
    shutil.copy(fixture["proj"] / "red.mp4", proj / "red.mp4")
    first = _run(fixture, "--project", str(proj), "--item", "ov")
    assert first.returncode == 0, first.stderr
    out = proj / "plates" / "ov"
    names = [f"{n:04d}.jpg" for n in range(12)]
    assert json.loads(first.stdout)["frames"] == [str(out / n) for n in names]
    before = {n: (out / n).read_bytes() for n in names}

    (proj / "red.mp4").rename(proj / "moved.mp4")
    proc = _run(fixture, "--project", str(proj), "--item", "ov")
    assert_error(proc, "missing_files")
    assert sorted(os.listdir(out)) == names       # no frame lost, no temp folder left
    assert {n: (out / n).read_bytes() for n in names} == before
