"""steps/media/track_points.py: anchor points followed through an item's footage.

A glass overlay pins its shapes to the footage with `track`: one centre per
overlay frame, in design-canvas pixels (the overlay's own coordinates: 1080 on
the short edge, the aspect of settings.resolution). track_points reads the same
non-overlay composite glass_plate draws, at half the design canvas, and matches
each anchor's frame-0 patch in every frame (NCC, velocity prediction, subpixel
parabola), then smooths.

Both moving clips are drawn analytically (sums of plane waves), so a texture
shifted by a fraction of a pixel is exact rather than resampled and the truth
is known to the subpixel. The clips are 960x540, the working size, so a source
pixel is a working pixel and a design-canvas pixel is half of one.
  - Known path: a textured square moves on a line plus a sinusoidal sway,
    several design px per frame at both ends, over a static, differently
    textured background. Every point must be within 1.5 px of the truth, raw
    and with ma5. The project exports at 1280x720, so design-canvas pixels
    (1920x1080) and export pixels differ: a track in export pixels misses.
  - Fixed background: a large textured foreground slides across most of the
    frame; anchors on the static background must stay within 2 px.

Measured on these fixtures (managed ffmpeg 8.1.2), worst error in design px,
the step against mutations of it run in a scratch mirror, never this tree:
  - the step: known path 0.14 raw, 0.33 ma5; background drift 0.03.
  - one global phase-correlation shift for every anchor (frame k against
    k-1, Hann window, subpixel): known path 15.6; background drift 333.
  - frame-to-frame matching with integer steps (each frame's patch from the
    previous frame): known path 5.35 raw, 3.79 ma5.
  - ma5 padded with the edge values instead of shrinking: 3.89 at frame 0
    (it lags 0.6 x the per-frame velocity there).
  Not caught: frame-to-frame matching refined to subpixel with the anchor's
  offset carried drifts too little in 48 clean frames (0.38).
"""
import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys

import pytest

from tests.conftest import FFMPEG_BIN, HAS_FFMPEG, REPO_ROOT, assert_error, skip_or_fail

np = pytest.importorskip("numpy")

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is required to render the footage")

STEP = REPO_ROOT / "steps" / "media" / "track_points.py"

FPS = 24
SRC_W, SRC_H = 960, 540     # the clips, and the working size: half the 1920x1080 design canvas
N = 48                      # 2 s of frames
K = 2.0                     # design-canvas px per working px

# Known path, in working px: line + sway. Velocity at frame 0 is (3.1, 0.9)
# working px/frame, (6.3, 1.8) design; at frame 47 about 2.6 working in x.
C0 = np.array([300.0, 260.0])
V = np.array([2.2, 0.9])
SWAY = np.array([6.0, 5.0])
PERIOD = 40
PHASE = np.array([0.0, math.pi / 2])
OBJ = 80                    # half side of the moving square, working px

# Fixed background: a full-height foreground band slides right.
FG_X0, FG_V, FG_W = 40.0, 3.3, 560
BG_ANCHORS = [(860, 270), (870, 440)]   # working px, clear of the band's furthest edge (755)

MAX_PATH_ERR = 1.5
MAX_BG_DRIFT = 2.0


def _path(n):
    return C0 + V * n + SWAY * np.sin(2 * math.pi * n / PERIOD + PHASE)


def _waves(seed, count, lam_min, lam_max):
    rng = np.random.default_rng(seed)
    ang = rng.uniform(0, math.pi, count)
    k = 2 * math.pi / rng.uniform(lam_min, lam_max, count)
    return k * np.cos(ang), k * np.sin(ang), rng.uniform(0, 2 * math.pi, count), rng.uniform(0.5, 1.0, count)


def _grey(waves, x, y, mean, contrast):
    """The texture at (x, y), px as floats: plane waves at unit std, as uint8."""
    kx, ky, ph, amp = waves
    v = np.zeros(np.broadcast(x, y).shape, np.float32)
    for a, b, p, m in zip(kx, ky, ph, amp):
        v += np.float32(m) * np.sin(np.float32(a) * x + np.float32(b) * y + np.float32(p))
    v /= np.float32(math.sqrt(float((amp ** 2).sum()) / 2))
    return np.clip(mean + contrast * v, 0, 255).astype(np.uint8)


def _grid(x0, x1, y0, y1):
    ys, xs = np.mgrid[y0:y1, x0:x1]
    return xs.astype(np.float32), ys.astype(np.float32)


def _encode(path, frames):
    proc = subprocess.Popen(
        [FFMPEG_BIN, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", f"{SRC_W}x{SRC_H}", "-r", str(FPS), "-i", "-",
         "-vf", "format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
         "-c:v", "libx264", "-crf", "12", "-g", str(FPS), str(path)],
        stdin=subprocess.PIPE)
    for frame in frames:
        proc.stdin.write(frame.tobytes())
    proc.stdin.close()
    assert proc.wait(timeout=120) == 0


def _known_path_frames():
    bg = _grey(_waves(1, 16, 10, 60), *_grid(0, SRC_W, 0, SRC_H), 100, 25)
    obj = _waves(2, 16, 8, 40)
    for n in range(N):
        cx, cy = _path(n)
        x0, y0 = int(round(cx)) - OBJ, int(round(cy)) - OBJ
        xs, ys = _grid(x0, x0 + 2 * OBJ, y0, y0 + 2 * OBJ)
        frame = bg.copy()
        frame[y0:y0 + 2 * OBJ, x0:x0 + 2 * OBJ] = _grey(obj, xs - np.float32(cx), ys - np.float32(cy), 150, 45)
        yield frame


def _background_frames():
    bg = _grey(_waves(3, 16, 10, 60), *_grid(0, SRC_W, 0, SRC_H), 110, 20)
    fg = _waves(4, 24, 6, 30)
    for n in range(N):
        left = FG_X0 + FG_V * n
        x0 = int(round(left))
        xs, ys = _grid(x0, x0 + FG_W, 0, SRC_H)
        frame = bg.copy()
        frame[:, x0:x0 + FG_W] = _grey(fg, xs - np.float32(left), ys, 140, 55)
        yield frame


def _project(pid, clip, seconds, resolution):
    return {
        "version": "0.2", "id": pid, "status": "draft", "projectType": "editing",
        "settings": {"fps": FPS, "resolution": resolution, "colorSpace": "sdr_bt709"},
        "tracks": [
            {"id": "trk-0", "items": [{"id": "clip", "type": "video", "src": clip,
                                       "start": 0, "end": seconds, "inPoint": 0, "outPoint": seconds}]},
            {"id": "trk-1", "items": [{"id": "ov", "type": "overlay", "src": "glass.jsx",
                                       "start": 0, "end": seconds}]},
        ],
    }


def _make_project(root, name, frames, seconds, resolution):
    proj = root / name
    proj.mkdir()
    if frames is None:
        subprocess.run([FFMPEG_BIN, "-v", "error", "-y", "-f", "lavfi", "-i",
                        f"color=c=gray:s={SRC_W}x{SRC_H}:r={FPS}:d={seconds}",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(proj / "clip.mp4")],
                       check=True, capture_output=True, timeout=120)
    else:
        _encode(proj / "clip.mp4", frames)
    (proj / "glass.jsx").write_text("export default function Glass() { return <div /> }\n")
    (proj / "project.json").write_text(json.dumps(_project(name, "clip.mp4", seconds, resolution)))
    return proj / "project.json"


@pytest.fixture(scope="module")
def fx(tmp_path_factory):
    if not HAS_FFMPEG:
        skip_or_fail("track_points renders with ffmpeg")
    root = tmp_path_factory.mktemp("track_points")
    # A private TMPDIR: the step's temporary frames (and the renderer's) land
    # here, so the test can see that they are gone afterwards.
    tmp = root / "tmp"
    tmp.mkdir()
    return {
        "root": root,
        "tmp": tmp,
        "env": {**os.environ, "TMPDIR": str(tmp)},
        # Exported at 1280x720: the design canvas is still 1920x1080.
        "known": _make_project(root, "known", _known_path_frames(), N / FPS, [1280, 720]),
        "background": _make_project(root, "background", _background_frames(), N / FPS, [1920, 1080]),
    }


def _run(fx, *args, env=None):
    return subprocess.run([sys.executable, str(STEP), *args], capture_output=True, text=True,
                          env=env or fx["env"], timeout=600)


def _track(fx, project, anchors, *extra):
    proc = _run(fx, "--project", str(project), "--item", "ov", "--anchors", anchors, *extra)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


ANCHOR = (C0 + SWAY * np.sin(PHASE)) * K     # the square's centre at frame 0, design px


def _truth(n):
    return ANCHOR + K * (_path(n) - _path(0))


@pytest.fixture(scope="module")
def known_raw(fx):
    return _track(fx, fx["known"], json.dumps([{"id": "sq", "x": ANCHOR[0], "y": ANCHOR[1]}]), "--smooth", "none")


@pytest.fixture(scope="module")
def known_ma5(fx):
    return _track(fx, fx["known"], json.dumps([{"id": "sq", "x": ANCHOR[0], "y": ANCHOR[1]}]))


def _errors(track):
    return [math.dist(p, _truth(n)) for n, p in enumerate(track)]


def test_output_is_design_canvas_tracks_one_per_plate_frame(known_raw):
    assert set(known_raw) == {"tracks", "minScore", "fps", "frames", "scale", "workingSize", "canvas"}
    assert known_raw["fps"] == FPS
    assert known_raw["frames"] == N
    assert known_raw["canvas"] == [1920, 1080]
    assert known_raw["workingSize"] == [SRC_W, SRC_H]
    assert known_raw["scale"] == 0.5
    track = known_raw["tracks"]["sq"]
    assert len(track) == N
    assert track[0] == [round(ANCHOR[0], 2), round(ANCHOR[1], 2)]
    assert all(v == round(v, 2) for p in track for v in p)
    assert known_raw["minScore"]["sq"] > 0.9


@pytest.mark.parametrize("mode", ["none", "ma5"])
def test_a_known_path_is_tracked_within_1_5_px(known_raw, known_ma5, mode):
    out = known_raw if mode == "none" else known_ma5
    errors = _errors(out["tracks"]["sq"])
    worst = max(range(N), key=lambda n: errors[n])
    assert errors[worst] <= MAX_PATH_ERR, (
        f"{mode}: worst {errors[worst]:.2f} px at frame {worst}; "
        f"ends {errors[0]:.2f} {errors[1]:.2f} .. {errors[-2]:.2f} {errors[-1]:.2f}")


def test_an_anchor_on_a_fixed_background_stays_put_while_the_foreground_moves(fx):
    anchors = [{"id": f"bg{i}", "x": x * K, "y": y * K} for i, (x, y) in enumerate(BG_ANCHORS)]
    path = fx["root"] / "anchors.json"     # anchors from a file, the other form the param takes
    path.write_text(json.dumps(anchors))
    out = _track(fx, fx["background"], str(path))
    assert out["canvas"] == [1920, 1080] and out["frames"] == N
    for a in anchors:
        drift = [math.dist(p, (a["x"], a["y"])) for p in out["tracks"][a["id"]]]
        assert max(drift) <= MAX_BG_DRIFT, f"{a['id']}: drift up to {max(drift):.2f} px"
        assert out["minScore"][a["id"]] > 0.9


def test_temporary_frames_are_removed(fx, known_raw, known_ma5):
    left = [n for n in os.listdir(fx["tmp"]) if n.startswith(("montaj-track-points", "montaj-glass-plate"))]
    assert left == []


def test_ma5_averages_a_shrinking_symmetric_window_at_the_edges():
    spec = importlib.util.spec_from_file_location("track_points_step", STEP)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    pts = [[float(n * n), float(-3 * n)] for n in range(7)]
    out = mod.smooth(pts, "ma5")
    assert out[0] == pts[0] and out[-1] == pts[-1]                     # raw at the ends
    assert out[1] == [(0 + 1 + 4) / 3, -3.0]                           # 3 frames
    assert out[3] == [(1 + 4 + 9 + 16 + 25) / 5, -9.0]                 # 5 in the interior
    assert out[5] == [(16 + 25 + 36) / 3, -15.0]
    # Linear motion has no lag anywhere, ends included.
    line = [[2.5 * n, 7.0 - n] for n in range(9)]
    assert mod.smooth(line, "ma5") == line
    assert mod.smooth(pts, "none") == pts
    quad = mod.smooth(pts, "quad")
    assert all(abs(a - b) < 1e-6 for p, q in zip(quad, pts) for a, b in zip(p, q))
    assert mod.smooth(pts[:2], "ma5") == pts[:2]


# -- refusals -----------------------------------------------------------------

def _refuse(fx, anchors, code, *extra, item="ov"):
    proc = _run(fx, "--project", str(fx["known"]), "--item", item, "--anchors", anchors, *extra)
    assert_error(proc, code)
    return json.loads(proc.stderr)["message"]


def test_unknown_item_is_refused_by_name(fx):
    msg = _refuse(fx, '[{"id": "a", "x": 960, "y": 540}]', "unknown_item", item="no-such-item")
    assert "no-such-item" in msg


def test_an_anchor_whose_patch_leaves_the_frame_is_refused_by_id(fx):
    anchors = json.dumps([{"id": "ok", "x": 960, "y": 540}, {"id": "edge-pin", "x": 40, "y": 540}])
    assert "edge-pin" in _refuse(fx, anchors, "anchor_out_of_frame")
    # The patch is what has to fit: the default 112 px fits 120 px in, 300 px does not.
    anchors = json.dumps([{"id": "wide", "x": 1800, "y": 540}])
    assert "wide" in _refuse(fx, anchors, "anchor_out_of_frame", "--patch", "300")


def test_duplicate_ids_are_refused(fx):
    anchors = json.dumps([{"id": "a", "x": 600, "y": 500}, {"id": "a", "x": 900, "y": 500}])
    assert '"a"' in _refuse(fx, anchors, "duplicate_anchor_id")


@pytest.mark.parametrize("anchors", ["[]", "{}", "not json", '[{"id": "a", "x": "1", "y": 2}]',
                                     '[{"x": 1, "y": 2}]'])
def test_empty_or_malformed_anchors_are_refused(fx, anchors):
    _refuse(fx, anchors, "invalid_anchors")


def test_a_flat_frame0_patch_is_refused_by_id(fx):
    project = _make_project(fx["root"], "flat", None, 0.25, [1920, 1080])
    proc = _run(fx, "--project", str(project), "--item", "ov",
                "--anchors", '[{"id": "sky", "x": 960, "y": 540}]')
    assert_error(proc, "flat_anchor")
    assert "sky" in json.loads(proc.stderr)["message"]


BLOCK_NUMPY = """
import runpy, sys
class _NoNumpy:
    def find_spec(self, name, path=None, target=None):
        if name == "numpy" or name.startswith("numpy."):
            raise ImportError("No module named 'numpy'", name="numpy")
sys.meta_path.insert(0, _NoNumpy())
sys.argv = [sys.argv[1]] + sys.argv[2:]
runpy.run_path(sys.argv[0], run_name="__main__")
"""


def test_missing_numpy_fails_with_the_extra_to_install(fx):
    proc = subprocess.run(
        [sys.executable, "-c", BLOCK_NUMPY, str(STEP), "--project", str(fx["known"]), "--item", "ov",
         "--anchors", '[{"id": "a", "x": 960, "y": 540}]'],
        capture_output=True, text=True, env=fx["env"], timeout=120)
    assert_error(proc, "missing_dependency")
    msg = json.loads(proc.stderr)["message"]
    assert "numpy" in msg and "montaj[rvm]" in msg
