#!/usr/bin/env python3
"""Follow anchor points through the footage under one item (normally an overlay).

A glass overlay pins its shapes to the footage with `track`: one centre per
overlay frame. This step makes those tracks from the footage exactly as placed
on screen: the non-overlay composite glass_plate draws for the item's range
(montaj_assets/render/glass-plate.js, unblurred), at half the design canvas.

Coordinates are design-canvas pixels, the overlay's own: 1080 on the short
edge with the aspect of settings.resolution (render.js), whatever the export
resolution. Frame n is plate frame n, the screen frame round(start * fps) + n.

The tracker is a frame-0 patch matcher. Every frame is matched against the
FRAME-0 patch (frame-to-frame matching drifts), searched within +-search
around the last position plus the last velocity, by normalized cross
correlation, refined to subpixel with a parabola on each axis. A local patch,
never a global shift: a global shift reads whatever moves most (wind, a
foreground) as camera motion. A candidate window that leaves the frame scores
-9. The search centre is clamped so the patch there fits inside the frame, so
a point that stops near an edge is still found. The point coasts on its last
velocity, scoring -9, when its patch is leaving the frame: the best window is
against the edge (a neighbour out of frame) while the search was clamped, or
either of those with a score below COAST_BELOW. A match after a coast starts
the motion again from 0. The minimum score per anchor is reported.

numpy comes from the rvm extra (the app's runtime has it); it is imported
lazily and a missing one fails by name.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from cli.deps import render_runtime_dir
from lib.canvas import DESIGN_SHORT_EDGE, design_canvas
from lib.common import ffmpeg_bin, ffmpeg_error_tail, node_child_env, fail, require_file
from lib.project_tracks import track_items

# The runtime copy of the render engine, as glass_plate.py resolves it.
GLASS_PLATE_JS = os.path.join(render_runtime_dir(), "glass-plate.js")

# Tracking works at half the design canvas, whatever the export resolution.
WORKING_SHORT_EDGE = 540

NO_FIT = -9.0          # the score of a candidate window that leaves the frame
COAST_BELOW = 0.9      # a match at or over the edge scoring below this is a patch leaving
SMOOTH_MODES = ("ma5", "quad", "none")
MIN_PATCH = 16


def _project_json(value):
    """A project folder resolves to the project.json inside it; anything else
    passes through. An id is resolved by serve before the step runs."""
    if os.path.isdir(value):
        return os.path.join(value, "project.json")
    return value


def _find_item(project, item_id):
    for track in track_items(project):
        for item in track or []:
            if isinstance(item, dict) and item.get("id") == item_id:
                return item
    return None


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def _load_anchors(value):
    """--anchors: inline JSON, or the path of a .json file holding it."""
    text = value.strip()
    if not text.startswith(("[", "{")):
        path = os.path.abspath(os.path.expanduser(text))
        if not os.path.isfile(path):
            fail("invalid_anchors", f"--anchors is neither JSON nor a .json file that exists: {value!r}")
        try:
            with open(path) as f:
                text = f.read()
        except OSError as e:
            fail("invalid_anchors", f"Could not read --anchors file {path}: {e}")
    try:
        anchors = json.loads(text)
    except json.JSONDecodeError as e:
        fail("invalid_anchors", f"--anchors is not valid JSON: {e}")
    example = '[{"id": "tile1", "x": 600, "y": 430}]'
    if not isinstance(anchors, list) or not anchors:
        fail("invalid_anchors", f"--anchors needs a non-empty JSON array of anchors, e.g. {example}")
    seen = set()
    for a in anchors:
        if not (isinstance(a, dict) and isinstance(a.get("id"), str) and a["id"].strip()
                and _is_number(a.get("x")) and _is_number(a.get("y"))):
            fail("invalid_anchors",
                 f"Each anchor is {{\"id\": <non-empty string>, \"x\": <number>, \"y\": <number>}} "
                 f"in design-canvas pixels at the item's first frame, e.g. {example}; got {json.dumps(a)}")
        if a["id"] in seen:
            fail("duplicate_anchor_id", f"Two anchors share the id \"{a['id']}\"; each id names one track.")
        seen.add(a["id"])
    return anchors


def _out_of_frame(a, half_w, half_h, w, h, where):
    fail("anchor_out_of_frame",
         f"Anchor \"{a['id']}\" at ({a['x']}, {a['y']}): its patch does not fit inside the {where}. "
         f"Place it at least {half_w:g} px from the left and right edges and {half_h:g} px from the "
         f"top and bottom of the {w}x{h} design canvas, or pass a smaller --patch.")


def smooth(points, mode):
    """`points` [[x, y], ...] smoothed per axis.
    ma5:  a centred moving average whose window shrinks symmetrically at the
          ends: frame 0 and the last frame raw, frames 1 and n-2 over 3, the
          rest over 5. Linear motion keeps no lag, ends included.
    quad: a quadratic fit per axis over the whole range.
    none: unchanged."""
    n = len(points)
    if mode == "none" or n < 3:
        return [list(p) for p in points]
    if mode == "ma5":
        out = []
        for i in range(n):
            h = min(2, i, n - 1 - i)
            win = points[i - h:i + h + 1]
            out.append([sum(p[0] for p in win) / len(win), sum(p[1] for p in win) / len(win)])
        return out
    import numpy as np
    t = np.arange(n, dtype=np.float64)
    cols = []
    for axis in (0, 1):
        v = np.array([p[axis] for p in points], dtype=np.float64)
        cols.append(np.polyval(np.polyfit(t, v, 2), t))
    return [[float(cols[0][i]), float(cols[1][i])] for i in range(n)]


def _ncc_map(np, img, t, ex, ey, P, R):
    """NCC of the normalized patch `t` (2P x 2P) at every centre within +-R of
    (ex, ey). A window that leaves the frame scores NO_FIT."""
    h, w = img.shape
    m = np.full((2 * R + 1, 2 * R + 1), NO_FIT)
    for j, y in enumerate(range(ey - R, ey + R + 1)):
        if y - P < 0 or y + P > h:
            continue
        for i, x in enumerate(range(ex - R, ex + R + 1)):
            if x - P < 0 or x + P > w:
                continue
            win = img[y - P:y + P, x - P:x + P]
            m[j, i] = ((win - win.mean()) / (win.std() + 1e-6) * t).mean()
    return m


def _vertex(c, a, b):
    """Subpixel offset of a parabola's peak through (-1, a), (0, c), (1, b)."""
    d = 2 * (a - 2 * c + b)
    return 0.0 if abs(d) < 1e-9 else (a - b) / d


class _Anchor:
    def __init__(self, a, cx, cy):
        self.a = a
        self.cx0, self.cy0 = cx, cy            # integer working centre of the frame-0 patch
        self.x, self.y = float(cx), float(cy)  # last position, working px
        self.vx = self.vy = 0.0
        self.low = 1.0
        self.coasting = False
        self.t = None
        self.pts = [(float(cx), float(cy))]


def _start(np, img, st, P):
    t = img[st.cy0 - P:st.cy0 + P, st.cx0 - P:st.cx0 + P]
    sd = float(t.std())
    if not sd > 1e-6:
        fail("flat_anchor",
             f"Anchor \"{st.a['id']}\" at ({st.a['x']}, {st.a['y']}) sits on a flat patch with nothing "
             f"to match. Place it on visible detail (texture, an edge, a corner).")
    st.t = (t - t.mean()) / sd


def _step(np, img, st, P, R):
    px, py = st.x, st.y
    h, w = img.shape
    # Search around the prediction, clamped so the patch at the centre fits
    # inside the frame: a point that stops near an edge is still found there.
    rx, ry = int(round(px + st.vx)), int(round(py + st.vy))
    ex, ey = min(max(rx, P), w - P), min(max(ry, P), h - P)
    clamped = (ex, ey) != (rx, ry)
    m = _ncc_map(np, img, st.t, ex, ey, P, R)
    j, i = np.unravel_index(np.argmax(m), m.shape)
    pinned = NO_FIT in [m[b, a] for b, a in ((j, i - 1), (j, i + 1), (j - 1, i), (j + 1, i))
                        if 0 <= a <= 2 * R and 0 <= b <= 2 * R]
    # Leaving: the best window is against the edge while the motion carries the
    # patch past it, or either one with a poor match. A patch 2 px over the
    # edge still scores about 0.92 there, so the score alone cannot tell.
    if (pinned and clamped) or ((pinned or clamped) and m[j, i] < COAST_BELOW):
        st.x, st.y = px + st.vx, py + st.vy
        st.low = NO_FIT
        st.coasting = True
        st.pts.append((st.x, st.y))
        return
    # A neighbour out of frame scores NO_FIT and would bend the parabola
    # toward the edge: that axis keeps the whole-pixel position.
    dx = (_vertex(m[j, i], m[j, i - 1], m[j, i + 1])
          if 0 < i < 2 * R and NO_FIT not in (m[j, i - 1], m[j, i + 1]) else 0.0)
    dy = (_vertex(m[j, i], m[j - 1, i], m[j + 1, i])
          if 0 < j < 2 * R and NO_FIT not in (m[j - 1, i], m[j + 1, i]) else 0.0)
    nx, ny = ex + i - R + dx, ey + j - R + dy
    # After a coast the last position was a guess: the motion restarts from 0.
    st.vx, st.vy = (0.0, 0.0) if st.coasting else (nx - px, ny - py)
    st.coasting = False
    st.x, st.y = nx, ny
    st.low = min(st.low, float(m[j, i]))
    st.pts.append((nx, ny))


def _render_plate(project_path, item_id, work_dir):
    """The unblurred composite for the item's range at WORKING_SHORT_EDGE, one
    PNG per frame in work_dir. Returns glass-plate.js's {frames, fps, size}."""
    cmd = [
        "node", GLASS_PLATE_JS,
        "--project", project_path,
        "--item", item_id,
        "--short-edge", str(WORKING_SHORT_EDGE),
        "--sigma", "0",
        "--ext", "png",
        "--out-dir", work_dir,
    ]
    result = subprocess.run(cmd, check=False, capture_output=True, env=node_child_env())
    stderr = result.stderr.decode("utf-8", errors="replace")
    if result.returncode != 0:
        for line in reversed(stderr.splitlines()):
            try:
                err = json.loads(line)
            except ValueError:
                continue
            if isinstance(err, dict) and "error" in err:
                fail(err["error"], err.get("message", ""))
        fail("glass_plate_failed", f"Rendering the footage failed (exit {result.returncode}): {stderr[-2000:]}")
    try:
        return json.loads(result.stdout.decode("utf-8", errors="replace"))
    except ValueError:
        fail("glass_plate_failed", f"The footage renderer returned no result: {stderr[-2000:]}")


def _frames(np, work_dir, fps, count, w, h):
    """The rendered PNGs as grey uint8 frames, one at a time, through ffmpeg."""
    pattern = os.path.join(work_dir.replace("%", "%%"), "%04d.png")
    proc = subprocess.Popen(
        [ffmpeg_bin(), "-v", "error", "-nostdin", "-start_number", "0", "-framerate", str(fps),
         "-i", pattern, "-frames:v", str(count), "-vf", "format=gray",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    size = w * h
    try:
        for n in range(count):
            buf = proc.stdout.read(size)
            if len(buf) != size:
                proc.kill()
                proc.wait()
                fail("track_frames_missing",
                     f"Decoded {n} of {count} frames.{ffmpeg_error_tail(proc.stderr.read())}")
            yield np.frombuffer(buf, np.uint8).reshape(h, w)
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()


def main():
    import argparse
    parser = argparse.ArgumentParser(
        description="Follow anchor points through the footage under an item (design-canvas pixels)"
    )
    parser.add_argument("--project", required=True,
                        help="Absolute path to project.json, or the project folder")
    parser.add_argument("--item", required=True,
                        help="Id of the item whose range is tracked (normally the overlay item)")
    parser.add_argument("--anchors", required=True,
                        help='JSON array [{"id", "x", "y"}] in design-canvas pixels at the item\'s first '
                             'frame, inline or the path of a .json file')
    parser.add_argument("--patch", type=int, default=112,
                        help="Side of the matched patch in design-canvas px (default 112)")
    parser.add_argument("--search", type=int, default=7,
                        help="Search radius in working px around the predicted position (default 7)")
    parser.add_argument("--smooth", default="ma5",
                        help="ma5 (default), quad or none")
    args = parser.parse_args()

    try:
        import numpy as np
    except ImportError:
        fail("missing_dependency",
             "track_points needs numpy, which the rvm extra provides. "
             "Install it with: pip install 'montaj[rvm]' (or: montaj install rvm)")

    if args.smooth not in SMOOTH_MODES:
        fail("invalid_smooth", f"--smooth must be one of {list(SMOOTH_MODES)}, got {args.smooth!r}")
    if args.patch < MIN_PATCH:
        fail("invalid_patch", f"--patch must be at least {MIN_PATCH}, got {args.patch}")
    if args.search < 1:
        fail("invalid_search", f"--search must be at least 1, got {args.search}")

    project_path = os.path.abspath(_project_json(args.project))
    require_file(project_path)
    try:
        with open(project_path) as f:
            project = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        fail("invalid_project", f"Could not read project.json at {project_path}: {e}")

    item = _find_item(project, args.item)
    if item is None:
        fail("unknown_item",
             f"No item with the id \"{args.item}\" in {project_path}. "
             f"\"item\" takes the id of an item on one of the project's tracks, normally the overlay item.")
    if not (_is_number(item.get("start")) and _is_number(item.get("end"))) or item["end"] <= item["start"]:
        fail("invalid_item", f"Item \"{args.item}\" needs a numeric start and an end after it "
                             f"(start {item.get('start')!r}, end {item.get('end')!r}).")

    anchors = _load_anchors(args.anchors)
    canvas_w, canvas_h = design_canvas(project.get("settings") or {})
    scale = WORKING_SHORT_EDGE / DESIGN_SHORT_EDGE
    P = max(2, int(round(args.patch * scale / 2)))   # half side of the patch, working px
    R = args.search
    # Before rendering: the patch must fit inside the design canvas.
    half = P / scale
    for a in anchors:
        if a["x"] - half < 0 or a["x"] + half > canvas_w or a["y"] - half < 0 or a["y"] + half > canvas_h:
            _out_of_frame(a, half, half, canvas_w, canvas_h, "frame")

    work_dir = tempfile.mkdtemp(prefix="montaj-track-points-")
    try:
        plate = _render_plate(project_path, args.item, work_dir)
        fps = plate["fps"]
        count = len(plate["frames"])
        w, h = plate["size"]
        sx, sy = w / canvas_w, h / canvas_h

        states = []
        for a in anchors:
            cx, cy = int(round(a["x"] * sx)), int(round(a["y"] * sy))
            if cx - P < 0 or cx + P > w or cy - P < 0 or cy + P > h:
                _out_of_frame(a, P / sx, P / sy, canvas_w, canvas_h, "rendered frame")
            states.append(_Anchor(a, cx, cy))

        for n, raw in enumerate(_frames(np, work_dir, fps, count, w, h)):
            img = raw.astype(np.float32)
            for st in states:
                if n == 0:
                    _start(np, img, st, P)
                else:
                    _step(np, img, st, P, R)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    tracks, min_score = {}, {}
    for st in states:
        # The anchor rides with its patch: frame 0 is the anchor itself.
        pts = [[st.a["x"] + (x - st.cx0) / sx, st.a["y"] + (y - st.cy0) / sy] for x, y in st.pts]
        tracks[st.a["id"]] = [[round(x, 2), round(y, 2)] for x, y in smooth(pts, args.smooth)]
        min_score[st.a["id"]] = round(st.low, 3)

    print(json.dumps({
        "tracks": tracks,
        "minScore": min_score,
        "fps": fps,
        "frames": count,
        "scale": scale,
        "workingSize": [w, h],
        "canvas": [canvas_w, canvas_h],
    }))


if __name__ == "__main__":
    main()
