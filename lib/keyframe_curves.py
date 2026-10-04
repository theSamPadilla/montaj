"""Keyframe sampling (a Python port of the JS sampler) and re-basing for cut items.

A keyframe track is `{prop, points: [{t, value, easing?}]}` with `t` in seconds from
the ITEM's own start (docs/schemas/project.md, "Overlay keyframes" / "Crop keyframes").
`sample_track` ports montaj_assets/timeline-core/src/curves.js exactly; that file is the
one place easing math lives, so this module must not drift from it. The parity test in
tests/test_keyframe_curves.py runs the real JS and compares.
"""
import math

# curves.js:130-132
EASING_NAMES = ("linear", "ease", "ease-in", "ease-out", "ease-in-out", "hold")

# curves.js:135, 138, 146
_EPSILON = 1e-7
_NEWTON_ITERATIONS = 8
_BISECTION_ITERATIONS = 60


def _solve_curve_x(ax, bx, cx, x):
    """Invert x on a cubic bezier. Port of curves.js solveCurveX, lines 160-185
    (Newton-Raphson, then bisection fallback restarted from the initial guess)."""
    s = x
    for _ in range(_NEWTON_ITERATIONS):
        dx = ((ax * s + bx) * s + cx) * s - x
        if abs(dx) < _EPSILON:
            return s
        slope = (3 * ax * s + 2 * bx) * s + cx
        if abs(slope) < 1e-6:
            break
        s -= dx / slope

    lo = 0.0
    hi = 1.0
    s = x
    i = 0
    while i < _BISECTION_ITERATIONS and lo < hi:
        at = ((ax * s + bx) * s + cx) * s
        if abs(at - x) < _EPSILON:
            return s
        if x > at:
            lo = s
        else:
            hi = s
        s = (hi - lo) * 0.5 + lo
        i += 1
    return s


def _cubic_bezier(x1, y1, x2, y2, x):
    """Bezier through (0,0), (x1,y1), (x2,y2), (1,1) at x. Port of curves.js lines 198-207."""
    cx = 3 * x1
    bx = 3 * (x2 - x1) - cx
    ax = 1 - cx - bx
    cy = 3 * y1
    by = 3 * (y2 - y1) - cy
    ay = 1 - cy - by
    s = _solve_curve_x(ax, bx, cx, x)
    return ((ay * s + by) * s + cy) * s


def ease_progress(easing, p):
    """Eased progress along one segment. Port of curves.js easeProgress, lines 228-252.

    `p` is clamped to [0, 1] (NaN reads as 0, line 231 `!(p > 0)`); `hold` is step-end
    (0 for p < 1); an unrecognised or absent easing is linear.
    """
    if not (p > 0):
        return 0.0
    if p >= 1:
        return 1.0
    if easing == "hold":
        return 0.0
    if easing == "ease":
        return _cubic_bezier(0.25, 0.1, 0.25, 1, p)
    if easing == "ease-in":
        return _cubic_bezier(0.42, 0, 1, 1, p)
    if easing == "ease-out":
        return _cubic_bezier(0, 0, 0.58, 1, p)
    if easing == "ease-in-out":
        return _cubic_bezier(0.42, 0, 0.58, 1, p)
    return p


def _finite(x):
    """JS Number.isFinite: a number type only, so None and strings are not finite."""
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _is_usable(kf):
    """Port of curves.js isUsable, lines 263-265."""
    return isinstance(kf, dict) and _finite(kf.get("t")) and _finite(kf.get("value"))


def _first_usable_index(points):
    """Port of curves.js firstUsableIndex, lines 273-278."""
    for i, p in enumerate(points):
        if _is_usable(p):
            return i
    return -1


def sample_track(track, local_t):
    """Value of one keyframed property at item-relative time `local_t`, or None when
    there is nothing to sample. Port of curves.js sampleTrack, lines 313-349.

    `track` is a `{prop, points}` dict or a bare list of points. Edge behaviours kept
    from the JS: unusable points (non-finite or missing t/value) are skipped; a
    non-finite `local_t` clamps to the first point; before the first point returns its
    value; duplicate or out-of-order `t` (non-positive span) returns the later point's
    value; past the last returns the last value. Points are assumed ascending (no sort).
    """
    points = None
    if isinstance(track, list):
        points = track
    elif isinstance(track, dict) and isinstance(track.get("points"), list):
        points = track["points"]
    if not points:
        return None

    first = _first_usable_index(points)
    if first < 0:
        return None

    prev = points[first]
    t = local_t if _finite(local_t) else prev["t"]
    # NOTE: `hold` jumps exactly AT a point's `t`, so this comparison is exact-float
    # sensitive: a `t` that rebase shifted by -offset can land 1 ulp off the sample
    # time and put the jump on the other side of it. Not an error in the port.
    if t < prev["t"]:
        return prev["value"]

    for i in range(first + 1, len(points)):
        cur = points[i]
        if not _is_usable(cur):
            continue
        if t < cur["t"]:
            span = cur["t"] - prev["t"]
            if not (span > 0):
                return cur["value"]
            return prev["value"] + (cur["value"] - prev["value"]) * ease_progress(
                prev.get("easing"), (t - prev["t"]) / span)
        prev = cur
    return prev["value"]


def _normalized_points(track):
    """Usable points, ascending by t (stable), last wins on duplicate t. Same rule as
    curves.js normalizeTrack, lines 377-394, on copies of the points."""
    raw = track.get("points") if isinstance(track, dict) else None
    pts = sorted((dict(p) for p in (raw or []) if _is_usable(p)), key=lambda p: p["t"])
    out = []
    for i, p in enumerate(pts):
        if i + 1 < len(pts) and pts[i + 1]["t"] == p["t"]:
            continue
        out.append(p)
    return out


def rebase(tracks, offset, duration):
    """Re-base tracks onto a piece cut from an item: the piece starts `offset` seconds
    into the original item and lasts `duration` seconds.

    Every `t` shifts by `-offset`. Points strictly inside (0, duration) are kept with
    their own easing. Boundary points are inserted at 0 and at `duration`, valued
    `sample_track(original, offset)` and `sample_track(original, offset + duration)`,
    so both ends are exact. An eased segment cannot be split exactly (a sub-span of a
    cubic-bezier preset is not a named easing), any segment that is shortened, at
    its start or at its end, becomes `linear` between its exact endpoints when its
    easing was a bezier. Segments kept whole keep their easing, and `hold` and
    `linear` split exactly so they keep theirs. The inserted start point takes the
    easing of the segment it begins (subject to that rule). A track with no usable points is dropped. Inputs are not mutated.
    """
    if not (duration > 0):
        raise ValueError("duration must be positive")
    end = offset + duration
    out = []
    for track in tracks:
        pts = _normalized_points(track)
        if not pts:
            continue
        start_value = sample_track(pts, offset)
        end_value = sample_track(pts, end)

        at_start = next((p for p in pts if p["t"] == offset), None)
        if at_start is not None:
            start_easing = at_start.get("easing")
        else:
            before = [p for p in pts if p["t"] < offset]
            start_easing = before[-1].get("easing") if before else None
            if start_easing != "hold":
                start_easing = None  # linear: absent, unknown or a cut bezier

        first = {"t": 0.0, "value": start_value}
        if start_easing is not None and start_easing != "linear":
            first["easing"] = start_easing
        new_points = [first]
        last_src_t = offset  # original t of the last kept point (start point: offset)
        for p in pts:
            nt = p["t"] - offset
            if 0 < nt < duration:
                q = dict(p)
                q["t"] = nt
                new_points.append(q)
                last_src_t = p["t"]
        # The segment leaving the last kept point is cut short at the end when the
        # original next point lies beyond `end`; a bezier easing there becomes linear.
        nxt = next((p for p in pts if p["t"] > last_src_t), None)
        if nxt is not None and nxt["t"] > end and new_points[-1].get("easing") not in (None, "linear", "hold"):
            del new_points[-1]["easing"]
        new_points.append({"t": float(duration), "value": end_value})

        new_track = {k: v for k, v in track.items() if k != "points"}
        new_track["points"] = new_points
        out.append(new_track)
    return out
