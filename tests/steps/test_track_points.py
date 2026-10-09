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
    assert set(known_raw) == {"tracks", "minScore", "lostFrames", "fps", "frames", "scale", "workingSize",
                              "canvas"}
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
    assert known_raw["lostFrames"] == {"sq": 0}


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


# Leaving the frame: the square from the known-path test on a straight line out
# through the left edge; its patch (56 working px) is out of frame for the last
# 5-6 of 40 frames. Once the patch is leaving (the best window against the edge
# while the search is clamped, or either with a poor score) the point coasts on
# its last velocity, so on a line it stays on the truth.
# Measured: worst error 0.02 px on both paths, every step the true step. Before
# coasting (6273d1e2) the point stuck at the frame edge and was 60 px (slow)
# and 72 px (fast) off by the last frame, with a 30 px jump on the slow path.
# Coasting with the parabola still bent by an out-of-frame neighbour drifted
# 1 px per frame out (6 px by the last frame). Coasting only on a window
# against the edge scoring below 0.9 took a poor window inside the frame once
# the patch was well out (steps of 40.5 and 49.5 px); adding "or a clamped
# search scoring below 0.9" still took the edge window when the patch was 2 px
# over it (it scores 0.92 there), and the fast path drifted 24 px.
EXIT_N = 40
EXIT_PATHS = {"slow": ((130.0, 270.0), (-3.0, 0.0)), "fast": ((230.0, 300.0), (-6.0, -1.0))}  # working px
MAX_EXIT_ERR = 0.5
SEARCH = 7


def _exit_frames(c0, v):
    bg = _grey(_waves(1, 16, 10, 60), *_grid(0, SRC_W, 0, SRC_H), 100, 25)
    obj = _waves(2, 16, 8, 40)
    for n in range(EXIT_N):
        cx, cy = c0[0] + v[0] * n, c0[1] + v[1] * n
        x0, y0 = int(round(cx)) - OBJ, int(round(cy)) - OBJ
        xs, ys = _grid(x0, x0 + 2 * OBJ, y0, y0 + 2 * OBJ)
        tex = _grey(obj, xs - np.float32(cx), ys - np.float32(cy), 150, 45)
        a, b = max(x0, 0), min(x0 + 2 * OBJ, SRC_W)
        frame = bg.copy()
        if b > a:
            frame[y0:y0 + 2 * OBJ, a:b] = tex[:, a - x0:b - x0]
        yield frame


@pytest.mark.parametrize("name", list(EXIT_PATHS))
def test_a_point_whose_patch_leaves_the_frame_coasts_on_its_velocity(fx, name):
    c0, v = EXIT_PATHS[name]
    project = _make_project(fx["root"], f"exit-{name}", _exit_frames(c0, v), EXIT_N / FPS, [1920, 1080])
    out = _track(fx, project, json.dumps([{"id": "a", "x": c0[0] * K, "y": c0[1] * K}]), "--smooth", "none")
    track = out["tracks"]["a"]
    truth = [(K * (c0[0] + v[0] * n), K * (c0[1] + v[1] * n)) for n in range(EXIT_N)]
    gone = next(n for n in range(EXIT_N) if truth[n][0] < K * 28)     # first frame the patch is out
    assert EXIT_N - gone >= 5

    step_max = K * (math.hypot(*v) + SEARCH)
    steps = [math.dist(track[n], track[n - 1]) for n in range(1, EXIT_N)]
    assert max(steps) <= step_max, f"{name}: a step of {max(steps):.1f} px (true {K * math.hypot(*v):.1f})"
    errors = [math.dist(p, t) for p, t in zip(track, truth)]
    report = " ".join(f"{e:.2f}" for e in errors[gone - 3:])
    assert max(errors) <= MAX_EXIT_ERR, f"{name}: error from frame {gone - 3} (out from {gone}): {report}"
    assert out["minScore"]["a"] == -9.0     # the frames it coasted are reported


def _square_frames(centres):
    """The known-path square at each centre (working px, floats), cut off at
    every frame edge, over the known-path background."""
    bg = _grey(_waves(1, 16, 10, 60), *_grid(0, SRC_W, 0, SRC_H), 100, 25)
    obj = _waves(2, 16, 8, 40)
    for cx, cy in centres:
        x0, y0 = int(round(cx)) - OBJ, int(round(cy)) - OBJ
        xs, ys = _grid(x0, x0 + 2 * OBJ, y0, y0 + 2 * OBJ)
        tex = _grey(obj, xs - np.float32(cx), ys - np.float32(cy), 150, 45)
        a, b = max(x0, 0), min(x0 + 2 * OBJ, SRC_W)
        c, d = max(y0, 0), min(y0 + 2 * OBJ, SRC_H)
        frame = bg.copy()
        if b > a and d > c:
            frame[c:d, a:b] = tex[c - y0:d - y0, a - x0:b - x0]
        yield frame


# Stopping near an edge: the square slides toward the left (or bottom) edge and
# stops at frame 28 with its whole patch inside the frame, 4 (3) working px
# from the edge. On the first stopped frame the prediction, the last position
# plus the last velocity, puts the patch partly out of frame; the clamped
# search finds it. Measured: 0.01 px on both. Coasting whenever the predicted
# patch was out of frame (8e7c0774) ran off: 132 and 134 px by the last frame.
# A patch that stops exactly flush with the edge is read as leaving and coasts.
STOP_N, STOP_AT = 40, 28
STOP_PATHS = {"left": ((200.0, 270.0), (-6.0, 0.0)), "bottom": ((480.0, 341.0), (1.0, 6.0))}  # working px


def _stop_truth(c0, v, n):
    k = min(n, STOP_AT)
    return (c0[0] + v[0] * k, c0[1] + v[1] * k)


@pytest.mark.parametrize("name", list(STOP_PATHS))
def test_a_point_that_stops_near_the_edge_stays_on_it(fx, name):
    c0, v = STOP_PATHS[name]
    truth = [_stop_truth(c0, v, n) for n in range(STOP_N)]
    half = 28                                           # the patch's half side, working px
    stop = truth[-1]
    assert half <= min(stop[0], SRC_W - stop[0], stop[1], SRC_H - stop[1]) <= half + 4
    project = _make_project(fx["root"], f"stop-{name}", _square_frames(truth), STOP_N / FPS, [1920, 1080])
    out = _track(fx, project, json.dumps([{"id": "a", "x": c0[0] * K, "y": c0[1] * K}]), "--smooth", "none")
    errors = [math.dist(p, (K * t[0], K * t[1])) for p, t in zip(out["tracks"]["a"], truth)]
    worst = max(range(STOP_N), key=lambda n: errors[n])
    report = " ".join(f"{e:.2f}" for e in errors[STOP_AT - 2:])
    assert errors[worst] <= MAX_PATH_ERR, f"{name}: worst {errors[worst]:.2f} px at frame {worst}; from {STOP_AT - 2}: {report}"


# Leave and return: out through the left edge at 6 working px a frame, then
# back. The patch is out for frames 18-22 (18 px out at most), flush with the
# edge at 23 and inside from 24. Measured: 0.00 px from frame 24 (24-72 px on
# frames 21-23, coasting out while the square comes back). Without the
# velocity reset the match at 24 set a 30 px/frame step and the point was lost
# (1273 px by the last frame); coasting on the predicted patch alone never
# came back (456 px).
RET_N = 40


def _ret_truth(n):
    return (float(130 - 6 * n if n <= 20 else 10 + 6 * (n - 20)), 270.0)


def test_a_point_whose_patch_leaves_and_comes_back_is_found_again(fx):
    truth = [_ret_truth(n) for n in range(RET_N)]
    project = _make_project(fx["root"], "return", _square_frames(truth), RET_N / FPS, [1920, 1080])
    out = _track(fx, project, json.dumps([{"id": "a", "x": truth[0][0] * K, "y": truth[0][1] * K}]),
                 "--smooth", "none")
    errors = [math.dist(p, (K * t[0], K * t[1])) for p, t in zip(out["tracks"]["a"], truth)]
    inside = [n for n in range(RET_N) if truth[n][0] > 28]        # the patch has a px to spare
    assert [n for n in inside if n > 20][0] == 24
    report = " ".join(f"{n}:{errors[n]:.2f}" for n in range(16, RET_N))
    assert max(errors[n] for n in inside) <= MAX_PATH_ERR, report
    assert out["minScore"]["a"] == -9.0


# Losing the patch inside the frame: the square moves slowly on a line and on
# frames 14-21 shows unrelated noise instead of its texture (a new draw each
# frame), then comes back where its path puts it. A match on the noise is not
# the patch: the point coasts on its last confident motion, slowing, and picks
# the square up again on the frame it returns.
# Measured: steps of 1.80, 1.43 .. 0.38 design px while lost (the last
# confident motion, x0.8 a frame), found again 0.14 px off on frame 22,
# minScore 0.016, lostFrames 8. 6a2f2440 took the best window on the noise:
# steps of 15 to 82 px, 500 px off on frame 22, out of the frame at
# (2500, 1708) by the last frame, minScore -9.
LOSE_N, LOSE_FROM, LOSE_TO = 40, 14, 22
LOSE_C0, LOSE_V = (360.0, 250.0), (0.8, 0.4)     # working px, and px per frame


def _load_step():
    spec = importlib.util.spec_from_file_location("track_points_step", STEP)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _lose_truth(n):
    return (LOSE_C0[0] + LOSE_V[0] * n, LOSE_C0[1] + LOSE_V[1] * n)


def _lose_frames():
    bg = _grey(_waves(1, 16, 10, 60), *_grid(0, SRC_W, 0, SRC_H), 100, 25)
    obj = _waves(2, 16, 8, 40)
    for n in range(LOSE_N):
        cx, cy = _lose_truth(n)
        x0, y0 = int(round(cx)) - OBJ, int(round(cy)) - OBJ
        frame = bg.copy()
        if LOSE_FROM <= n < LOSE_TO:
            noise = np.random.default_rng(100 + n).normal(150, 45, (2 * OBJ, 2 * OBJ))
            frame[y0:y0 + 2 * OBJ, x0:x0 + 2 * OBJ] = np.clip(noise, 0, 255).astype(np.uint8)
        else:
            xs, ys = _grid(x0, x0 + 2 * OBJ, y0, y0 + 2 * OBJ)
            frame[y0:y0 + 2 * OBJ, x0:x0 + 2 * OBJ] = _grey(obj, xs - np.float32(cx), ys - np.float32(cy), 150, 45)
        yield frame


def test_a_point_that_loses_its_patch_inside_the_frame_slows_to_a_stop_and_finds_it_again(fx):
    truth = [_lose_truth(n) for n in range(LOSE_N)]
    project = _make_project(fx["root"], "lose", _lose_frames(), LOSE_N / FPS, [1920, 1080])
    out = _track(fx, project, json.dumps([{"id": "a", "x": truth[0][0] * K, "y": truth[0][1] * K}]),
                 "--smooth", "none")
    track = out["tracks"]["a"]
    steps = [math.dist(track[n], track[n - 1]) for n in range(1, LOSE_N)]
    lost = steps[LOSE_FROM - 1:LOSE_TO - 1]          # the steps into frames 14-21
    errors = [math.dist(p, (K * t[0], K * t[1])) for p, t in zip(track, truth)]
    report = (f"steps while lost: {' '.join(f'{s:.1f}' for s in lost)}; error from frame {LOSE_TO}: "
              f"{' '.join(f'{e:.2f}' for e in errors[LOSE_TO:])}; last point {track[-1]}; "
              f"minScore {out['minScore']['a']}")
    # No acceleration while lost: no step longer than the true motion plus 1 px,
    # none longer than the one before it, and slowing, so a long loss settles.
    assert max(lost) <= K * (math.hypot(*LOSE_V) + 1), report
    assert all(b <= a + 0.05 for a, b in zip(lost, lost[1:])), report
    assert lost[-1] <= 0.5 * lost[0], report
    # It stays in the frame and reports a lost patch, never one that left the frame.
    assert all(0 <= x <= 1920 and 0 <= y <= 1080 for x, y in track), report
    assert -9.0 < out["minScore"]["a"] < _load_step().LOST_BELOW, report
    assert out["lostFrames"] == {"a": LOSE_TO - LOSE_FROM}, report
    # Found again on the frame the square comes back.
    assert max(errors[LOSE_TO:]) <= MAX_PATH_ERR, report


def test_a_confident_wrong_match_cannot_make_the_point_accelerate_faster_than_half_the_search(monkeypatch):
    # Every frame's best match scores 0.6 at the far edge of the search window
    # (7 working px past the prediction), as over unrelated texture that keeps
    # matching ahead of the point. The predicted motion may follow by at most
    # half the search radius a frame. 6a2f2440 took all of it: -7 working px a
    # frame more each frame, -56 after 8.
    mod = _load_step()
    R = SEARCH
    m = np.full((2 * R + 1, 2 * R + 1), 0.1)
    m[0, R] = 0.6
    monkeypatch.setattr(mod, "_ncc_map", lambda *a: m)
    st = mod._Anchor({"id": "a", "x": 960, "y": 900}, 480, 450)
    img = np.zeros((SRC_H, SRC_W), np.float32)
    vy = [st.vy]
    for _ in range(8):
        mod._step(np, img, st, 28, R)
        vy.append(st.vy)
    changes = [abs(b - a) for a, b in zip(vy, vy[1:])]
    assert max(changes) <= R / 2 + 1e-9, f"velocity per frame: {vy}"
    assert vy[-1] == pytest.approx(-R / 2 * 8)


def test_a_lost_point_is_not_found_again_on_the_rim_of_its_search(monkeypatch):
    # While lost, a best window on the rim of the search is a slope running out
    # of the window, not the patch: the point keeps coasting. A peak inside the
    # window finds it again. Without this rule the shirt anchor in LOST_BELOW's
    # measurement was found again at 0.43 on a corner of its search the frame
    # after it was lost, ran 20-37 px a frame and reached the frame edge (-9).
    mod = _load_step()
    R = SEARCH

    def peak(i, score):
        m = np.zeros((2 * R + 1, 2 * R + 1))
        m[R, i] = score
        return m

    maps = [peak(R, 0.1), peak(2 * R, 0.6), peak(R + 3, 0.6)]
    monkeypatch.setattr(mod, "_ncc_map", lambda *a: maps.pop(0))
    st = mod._Anchor({"id": "a", "x": 960, "y": 540}, 480, 270)
    st.vx = 2.0
    img = np.zeros((SRC_H, SRC_W), np.float32)
    mod._step(np, img, st, 28, R)               # 0.1: lost, coasts 2 px
    assert (st.lost_frames, st.x, st.vx) == (1, 482.0, pytest.approx(1.6))
    mod._step(np, img, st, 28, R)               # 0.6 on the rim: still lost
    assert (st.lost_frames, st.x, st.vx) == (2, pytest.approx(483.6), pytest.approx(1.28))
    mod._step(np, img, st, 28, R)               # 0.6 inside the window: found
    assert (st.lost, st.lost_frames, st.x, st.vx) == (False, 2, 488.0, pytest.approx(1.28))


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


# numpy is blocked, and every temporary folder or child process the step makes
# is logged: the step removes its temporary folder on the way out, so an empty
# TMPDIR afterwards alone would not show that the render never started.
BLOCK_NUMPY = """
import os, runpy, subprocess, sys, tempfile
class _NoNumpy:
    def find_spec(self, name, path=None, target=None):
        if name == "numpy" or name.startswith("numpy."):
            raise ImportError("No module named 'numpy'", name="numpy")
sys.meta_path.insert(0, _NoNumpy())
def _logged(real, what):
    def call(*a, **k):
        with open(os.environ["TRACK_POINTS_MADE"], "a") as f:
            f.write(what + "\\n")
        return real(*a, **k)
    return call
tempfile.mkdtemp = _logged(tempfile.mkdtemp, "mkdtemp")
subprocess.Popen = _logged(subprocess.Popen, "Popen")
sys.argv = [sys.argv[1]] + sys.argv[2:]
runpy.run_path(sys.argv[0], run_name="__main__")
"""


def test_missing_numpy_fails_with_the_extra_to_install(fx, tmp_path):
    made = tmp_path / "made.log"
    made.write_text("")
    proc = subprocess.run(
        [sys.executable, "-c", BLOCK_NUMPY, str(STEP), "--project", str(fx["known"]), "--item", "ov",
         "--anchors", '[{"id": "a", "x": 960, "y": 540}]'],
        capture_output=True, text=True, env={**fx["env"], "TRACK_POINTS_MADE": str(made)}, timeout=120)
    assert_error(proc, "missing_dependency")
    msg = json.loads(proc.stderr)["message"]
    assert "numpy" in msg and "montaj[rvm]" in msg
    # It failed before rendering anything: no temporary folder, no renderer.
    assert made.read_text().split() == []
    left = [n for n in os.listdir(fx["tmp"]) if n.startswith(("montaj-track-points", "montaj-glass-plate"))]
    assert left == []
