"""Camera-track maths for steps/media/track_camera: a structure-from-motion
reconstruction (camera poses and sparse points, in its own frame and scale) turned
into Montaj's camera in a metric world. Plain numpy; the step runs pycolmap and
hands the poses and points here, so everything below is testable without it.

Poses are COLMAP's: `R` is the cam_from_world rotation, whose rows are the camera's
right, down and forward axes in world coordinates, and `C` is the camera centre.
Intrinsics are COLMAP's SIMPLE_RADIAL: one focal length f in px, the principal point
at the frame's centre, and k1 (a normalized point x is drawn at x * (1 + k1 |x|^2)).
Pixels are (u, v) from the frame's top left corner, u right, v down, as COLMAP and
the engine both count them.

Montaj's world (the app's engine, library/model3d/camera-project.js): Blender axes
(x right, y forward, z up) in metres. A camera is {location, target, lens}: it looks
from location to target, and `lens` is mm on a 36 mm sensor whose field of view is
VERTICAL, 2 atan(18 / lens) over the frame's height, so lens = 36 f / H. With no roll
the camera's right is forward x z and its up is right x forward. `roll` turns the
camera about its forward axis from that, in degrees, positive counter-clockwise as
seen from behind the camera: its right edge rises (the picture's horizon turns
clockwise). With roll r the camera's up is cos(r) up0 - sin(r) right0; `up` carries
that vector too, as camera-project.js takes it. Every target sits on its camera's
axis as far ahead as frame 0's axis runs to the plane, so a camera that looks level
or above the horizon keeps a near, steady target.

The world is fixed by the clip: z = 0 is the plane the clip looks at (a table or a
floor: choose_plane's pick of the planes in the points, or the one under
known.plane's pixels, plane_from_pixels),
+z its normal on the cameras' side; the origin is where frame 0's optical
axis meets it; +x is frame 0's right projected onto it; +y = z x x. The scale is
metric from one known size, else frame 0's camera is assumed DEFAULT_HEIGHT_M up.
"""
import json
import math

import numpy as np

SENSOR_HALF_MM = 18.0           # half the 36 mm sensor, over the frame's height
FULL_FRAME_DIAG_MM = math.hypot(36.0, 24.0)
DEFAULT_HEIGHT_M = 0.3          # frame 0's camera above the plane when no size is known
MIN_TARGET_M = 0.001            # the nearest a target sits ahead of its camera

# Plane search: RANSAC planes are taken off the points one at a time, up to
# MAX_PLANES, each fitting points within PLANE_THRESHOLD x the median depth (along
# frame 0's axis) of the points. A plane is a candidate with at least
# MIN_PLANE_POINTS and MIN_PLANE_SHARE of the largest plane's points.
MAX_PLANES = 5
PLANE_THRESHOLD = 0.01
PLANE_ITERATIONS = 2000
MIN_PLANE_POINTS = 20
MIN_PLANE_SHARE = 0.25
PLANE_SEED = 0
# Candidate planes are scored on at most SCORE_SAMPLE points, a seeded subset, so the
# scoring stays a few MB however many points there are; inliers count on all of them.
SCORE_SAMPLE = 20000
# Of the candidates, the one facing most up the picture (frame 0's image-up) wins
# when it faces it at least UP_ENOUGH; below that no plane faces up, as when the
# camera looks down at the table (image-up then lies in it), and the one facing the
# camera most wins instead.
UP_ENOUGH = 0.3
# known.plane: a found plane takes the pixels when every pixel's ray meets it in
# front of the camera, within FOOTPRINT_MARGIN x the diagonal of its points'
# footprint (their box along the plane's own axes) of that box.
FOOTPRINT_MARGIN = 0.25

# scene.camera's keys: frames are dropped while the camera interpolated between the
# kept keys (location, target and roll linear, the lens constant) draws THIN_POINTS
# of the sparse points, and points on a
# PROBE_GRID x PROBE_GRID grid of the frame's pixel rays, within the tolerance (px)
# of where that frame's own camera draws them. On each ray the points are where it
# meets the plane, as far ahead as the frame's target, and PROBE_FAR times that,
# which stands for infinity: a small move shifts the near table most, a small turn
# the far background, and between the two they can cancel. Along one ray the miss
# is the length of a straight line in 1 / depth, so it is largest at the nearest or
# the farthest point checked, and every depth between is covered. The check runs on
# the values as printed (rounded()), so the tolerance holds on what is written.
# The engine plays a camera key with no ease as a monotone cubic (cameraKeyAt), which
# eases out of and into a key beside a rest, so rounded() marks every key "linear":
# played as a cubic, a still, a dolly and a still kept as four keys miss by over 20 px.
# Roll keys are left out when every frame's roll is under ROLL_KEYS_FROM degrees.
# The default tolerance stays under the track's own error (about 1.4 px of
# reprojection on a phone clip), and a hand-held clip at 10 fps still thins at it:
# on a 7.5 s hand-held phone clip it kept 69 of 75 keys, where 0.5 px kept all 75.
DEFAULT_TOLERANCE_PX = 1.0
THIN_POINTS = 400
THIN_SEED = 0
PROBE_GRID = 5
PROBE_FAR = 1e4
ROLL_KEYS_FROM = 0.05

# Output rounding. Positions to 0.1 mm: at a tabletop's 0.3 m, a 0.5 mm error in
# the location or target moves the picture by up to about 3 px at f = 850 px.
POS_DECIMALS = 4
ROLL_DECIMALS = 2
UP_DECIMALS = 6
LENS_DECIMALS = 3
TIME_DECIMALS = 4


# ---- lens ----

def lens_from_focal(focal_px, height_px):
    """Montaj's lens (mm on a 36 mm sensor, vertical field of view) for a focal length in px."""
    return 2 * SENSOR_HALF_MM * focal_px / height_px


def focal_from_lens(lens, height_px):
    return lens * height_px / (2 * SENSOR_HALF_MM)


def focal_from_35mm(f35, width_px, height_px):
    """A 35 mm-equivalent focal length (matched on the diagonal) as px."""
    return f35 * math.hypot(width_px, height_px) / FULL_FRAME_DIAG_MM


# ---- vectors and rotations ----

def _unit(v):
    n = float(np.linalg.norm(v))
    return None if n < 1e-12 else np.asarray(v, float) / n


def quat_from_matrix(R):
    """Unit quaternion (w, x, y, z) of a rotation matrix."""
    R = np.asarray(R, float)
    tr = R[0, 0] + R[1, 1] + R[2, 2]
    if tr > 0:
        s = 2 * math.sqrt(tr + 1)
        q = [s / 4, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s]
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = 2 * math.sqrt(1 + R[0, 0] - R[1, 1] - R[2, 2])
        q = [(R[2, 1] - R[1, 2]) / s, s / 4, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s]
    elif R[1, 1] > R[2, 2]:
        s = 2 * math.sqrt(1 + R[1, 1] - R[0, 0] - R[2, 2])
        q = [(R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, s / 4, (R[1, 2] + R[2, 1]) / s]
    else:
        s = 2 * math.sqrt(1 + R[2, 2] - R[0, 0] - R[1, 1])
        q = [(R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, s / 4]
    q = np.asarray(q)
    return q / np.linalg.norm(q)


def matrix_from_quat(q):
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


def slerp(q0, q1, a):
    """Spherical interpolation from q0 (a = 0) to q1 (a = 1), the short way round."""
    d = float(np.dot(q0, q1))
    if d < 0:
        q1, d = -q1, -d
    if d > 0.9995:
        q = q0 + a * (q1 - q0)
        return q / np.linalg.norm(q)
    th = math.acos(d)
    return (math.sin((1 - a) * th) * q0 + math.sin(a * th) * q1) / math.sin(th)


def interpolate_pose(p0, p1, a):
    """The pose a of the way from p0 to p1: the centre lerped, the rotation slerped."""
    (R0, C0), (R1, C1) = p0, p1
    q = slerp(quat_from_matrix(R0), quat_from_matrix(R1), a)
    return matrix_from_quat(q), (1 - a) * np.asarray(C0, float) + a * np.asarray(C1, float)


def fill_poses(poses):
    """Every frame's pose, from a list with None for the frames that did not register.
    A gap is interpolated between its registered neighbours; frames before the first
    or after the last registered one hold it. Returns (poses, registered flags)."""
    known = [i for i, p in enumerate(poses) if p is not None]
    if not known:
        raise ValueError("no registered frames")
    out = []
    for i, p in enumerate(poses):
        if p is not None:
            out.append((np.asarray(p[0], float), np.asarray(p[1], float)))
            continue
        before = [k for k in known if k < i]
        after = [k for k in known if k > i]
        if not before or not after:
            k = after[0] if not before else before[-1]
            out.append((np.asarray(poses[k][0], float), np.asarray(poses[k][1], float)))
            continue
        a, b = before[-1], after[0]
        out.append(interpolate_pose(poses[a], poses[b], (i - a) / (b - a)))
    return out, [p is not None for p in poses]


def pose_at(poses, fps, t):
    """The pose at t seconds, between the sampled frames (frame i is at i / fps)."""
    x = t * fps
    i = min(max(int(math.floor(x)), 0), len(poses) - 1)
    if i >= len(poses) - 1 or x <= i:
        return poses[i]
    return interpolate_pose(poses[i], poses[i + 1], x - i)


# ---- intrinsics ----

def undistort(pixels, focal, centre, k1):
    """Pixels of a SIMPLE_RADIAL camera as normalized pinhole coordinates (x, y)."""
    d = (np.asarray(pixels, float) - centre) / focal
    x = d.copy()
    for _ in range(50):
        r2 = (x * x).sum(axis=-1, keepdims=True)
        x = d / (1 + k1 * r2)
    return x


def distort(normalized, focal, centre, k1):
    """Normalized pinhole coordinates as pixels of a SIMPLE_RADIAL camera."""
    x = np.asarray(normalized, float)
    r2 = (x * x).sum(axis=-1, keepdims=True)
    return x * (1 + k1 * r2) * focal + centre


# ---- Montaj's camera ----

def level_basis(forward):
    """The engine's camera basis with no roll: forward, right = forward x z, up = right
    x forward. Looking straight up or down, right is +x (camera-project.js `basis`)."""
    f = _unit(forward)
    r = _unit(np.cross(f, [0.0, 0.0, 1.0]))
    if r is None:
        r = np.array([1.0, 0.0, 0.0])
    return f, r, np.cross(r, f)


def camera_basis(camera):
    """forward, right, up of a {location, target, roll?} camera."""
    f, r0, u0 = level_basis(np.subtract(camera["target"], camera["location"]))
    a = math.radians(camera.get("roll") or 0.0)
    r = math.cos(a) * r0 + math.sin(a) * u0
    u = math.cos(a) * u0 - math.sin(a) * r0
    return f, r, u


def project_points(camera, points, size):
    """World points to pixels through a {location, target, lens, roll?} camera, as the
    engine's projectPoints draws them (roll as its `up`). None for a point at or
    behind the eye."""
    w, h = size
    f, r, u = camera_basis(camera)
    tan_v = SENSOR_HALF_MM / camera["lens"]
    tan_h = tan_v * w / h
    out = []
    for p in np.asarray(points, float):
        d = p - np.asarray(camera["location"], float)
        z = float(d @ f)
        if not z > 1e-9:
            out.append(None)
            continue
        nx, ny = float(d @ r) / (z * tan_h), float(d @ u) / (z * tan_v)
        out.append([(nx * 0.5 + 0.5) * w, (0.5 - ny * 0.5) * h])
    return out


def _draw(location, target, roll, lens, size, points):
    """project_points for many points at once: (pixels N x 2, depth N)."""
    w, h = size
    f, r, u = camera_basis({"location": location, "target": target, "roll": roll})
    tan_v = SENSOR_HALF_MM / lens
    d = np.asarray(points, float) - location
    z = d @ f
    safe = np.where(z > 1e-9, z, 1.0)
    px = np.c_[((d @ r) / (safe * tan_v * w / h) * 0.5 + 0.5) * w, (0.5 - (d @ u) / (safe * tan_v) * 0.5) * h]
    return px, z


def thin_keys(frames, lens, size, points, tolerance, roll=True):
    """Indices of the frames kept as camera keys, first and last always. From each
    kept key the next is the furthest frame such that, at every frame between them,
    the camera interpolated between the two keys at that frame's t (location, target
    and, when `roll`, roll, all linear) draws the checked points within `tolerance`
    px of where that frame's own camera draws them. The checked points are
    THIN_POINTS of `points` (a seeded subset) inside that frame's picture, and points
    on a PROBE_GRID grid of the frame's pixel rays: where each meets z = 0, as far
    ahead as the target, and PROBE_FAR times that. Without `roll` the camera between
    the keys, and at them, is level, and each frame is still drawn with its own roll:
    leaving roll out spends tolerance, and None is returned when a frame's roll alone
    would miss by more than `tolerance`."""
    n = len(frames)
    w, h = size
    t = np.array([f["t"] for f in frames], float)
    loc = np.array([f["location"] for f in frames], float)
    tgt = np.array([f["target"] for f in frames], float)
    own = np.degrees(np.unwrap(np.radians([f["roll"] for f in frames])))   # each frame drawn with this
    rl = own if roll else np.zeros(n)                                       # the keys interpolate this
    pts = np.asarray(points, float).reshape(-1, 3)
    if len(pts) > THIN_POINTS:
        pts = pts[np.random.default_rng(THIN_SEED).choice(len(pts), THIN_POINTS, replace=False)]
    grid = np.array([[(a + 0.5) / PROBE_GRID * w, (b + 0.5) / PROBE_GRID * h]
                     for a in range(PROBE_GRID) for b in range(PROBE_GRID)])
    checks = []
    for i in range(n):
        cam = {"location": loc[i], "target": tgt[i], "roll": own[i], "lens": lens}
        px, z = _draw(loc[i], tgt[i], own[i], lens, size, pts)
        seen = (z > 1e-9) & (px[:, 0] >= 0) & (px[:, 0] <= w) & (px[:, 1] >= 0) & (px[:, 1] <= h)
        reach = float(np.linalg.norm(tgt[i] - loc[i]))
        rays = np.array(pixel_rays(cam, grid, size))
        down = rays[:, 2] < -1e-9
        hit = -loc[i][2] / np.where(down, rays[:, 2], -1.0)
        on_plane = down & (hit > 0)
        probes = [loc[i] + hit[on_plane][:, None] * rays[on_plane],
                  loc[i] + reach * rays, loc[i] + PROBE_FAR * reach * rays]
        drawn = [grid[on_plane], grid, grid]
        checks.append((np.vstack([pts[seen], *probes]), np.vstack([px[seen], *drawn])))

    def miss(i, location, target, r):
        P, want = checks[i]
        px, z = _draw(location, target, r, lens, size, P)
        return np.inf if not (z > 1e-9).all() else float(np.hypot(*(px - want).T).max())

    def holds(a, b):
        for i in range(a + 1, b):
            k = (t[i] - t[a]) / (t[b] - t[a])
            if miss(i, (1 - k) * loc[a] + k * loc[b], (1 - k) * tgt[a] + k * tgt[b],
                    (1 - k) * rl[a] + k * rl[b]) > tolerance:
                return False
        return True

    if not roll and any(miss(i, loc[i], tgt[i], 0.0) > tolerance for i in range(n)):
        return None
    if n <= 2:
        return list(range(n))

    keys, a, b = [0], 0, 1
    while b < n - 1:
        if holds(a, b + 1):
            b += 1
        else:
            keys.append(b)
            a, b = b, b + 1
    keys.append(n - 1)
    return keys


def pixel_rays(camera, pixels, size):
    """Unit world directions through pixels of a {location, target, lens, roll?} camera."""
    w, h = size
    f, r, u = camera_basis(camera)
    tan_v = SENSOR_HALF_MM / camera["lens"]
    tan_h = tan_v * w / h
    out = []
    for px in np.asarray(pixels, float):
        nx, ny = (px[0] / w - 0.5) * 2, (0.5 - px[1] / h) * 2
        out.append(_unit(f + nx * tan_h * r + ny * tan_v * u))
    return out


def roll_degrees(forward, right):
    """The camera's roll from level: positive when its right edge rises."""
    _, r0, u0 = level_basis(forward)
    return math.degrees(math.atan2(float(right @ u0), float(right @ r0)))


def montaj_camera(pose, world):
    """{location, target, up, roll} of a COLMAP pose in Montaj's world (align_world,
    with its scale and the target distance in metres set)."""
    R, C = pose
    A, origin, scale = world["axes"], world["origin"], world["scale"]
    loc = scale * (A @ (np.asarray(C, float) - origin))
    f = A @ R[2]
    r = A @ R[0]
    return {"location": loc, "target": loc + world["target"] * f, "up": A @ -R[1], "roll": roll_degrees(f, r)}


# ---- the plane ----

def find_planes(points, threshold, max_planes=MAX_PLANES, iterations=PLANE_ITERATIONS, seed=PLANE_SEED):
    """RANSAC planes taken off the points one at a time, largest first. Each is
    {normal, point (the inliers' centroid), inliers (indices into points)}, refitted to
    its inliers by least squares. Deterministic for a given seed."""
    pts = np.asarray(points, float)
    rng = np.random.default_rng(seed)
    left = np.arange(len(pts))
    planes = []
    while len(planes) < max_planes and len(left) >= 3:
        P = pts[left]
        S = P if len(P) <= SCORE_SAMPLE else P[rng.choice(len(P), SCORE_SAMPLE, replace=False)]
        idx = rng.integers(0, len(P), size=(iterations, 3))
        a, b, c = P[idx[:, 0]], P[idx[:, 1]], P[idx[:, 2]]
        n = np.cross(b - a, c - a)
        norm = np.linalg.norm(n, axis=1)
        ok = norm > 1e-12
        if not ok.any():
            break
        n, a = n[ok] / norm[ok, None], a[ok]
        best, best_count = None, 0
        for s in range(0, len(n), 128):
            counts = (np.abs(S @ n[s:s + 128].T - (a[s:s + 128] * n[s:s + 128]).sum(axis=1)) < threshold).sum(axis=0)
            j = int(np.argmax(counts))
            if counts[j] > best_count:
                best, best_count = (n[s + j], a[s + j]), int(counts[j])
        if best is None or best_count < 3:
            break
        inl = np.abs((P - best[1]) @ best[0]) < threshold
        for _ in range(2):
            centroid = P[inl].mean(axis=0)
            normal = np.linalg.svd(P[inl] - centroid)[2][-1]
            refit = np.abs((P - centroid) @ normal) < threshold
            if refit.sum() < 3:
                break
            inl = refit
        centroid = P[inl].mean(axis=0)
        normal = np.linalg.svd(P[inl] - centroid)[2][-1]
        planes.append({"normal": normal, "point": centroid, "inliers": left[inl]})
        left = left[~inl]
    return planes


class NoPlane(ValueError):
    """No found plane holds enough tracked points to stand the world on."""

    def __init__(self):
        super().__init__("No flat surface with enough tracked points: point at the table or floor with known.plane.")


def face(planes, eye):
    """Turn each plane's normal to the eye's side."""
    for p in planes:
        if float((eye - p["point"]) @ p["normal"]) < 0:
            p["normal"] = -p["normal"]


def choose_plane(planes, eye, up, forward):
    """The plane the clip stands on, among find_planes' planes, each normal turned to
    the eye's side. A candidate has at least MIN_PLANE_POINTS and MIN_PLANE_SHARE of
    the largest plane's points. Of those, the one whose normal points most along `up`
    (frame 0's image-up) when that is at least UP_ENOUGH, else the one facing the
    camera most (along -forward). A wall of texture behind a plain table holds more
    points than the table, but it faces the camera, not up the picture; looking
    straight down, the table is what faces the camera. Returns (index, "up" | "facing").
    Raises NoPlane when no plane has MIN_PLANE_POINTS."""
    face(planes, eye)
    largest = max((len(p["inliers"]) for p in planes), default=0)
    floor = max(MIN_PLANE_POINTS, MIN_PLANE_SHARE * largest)
    candidates = [i for i, p in enumerate(planes) if len(p["inliers"]) >= floor]
    if not candidates:
        raise NoPlane()
    best = max(candidates, key=lambda i: float(planes[i]["normal"] @ up))
    if float(planes[best]["normal"] @ up) >= UP_ENOUGH:
        return best, "up"
    return max(candidates, key=lambda i: float(planes[i]["normal"] @ -forward)), "facing"


def plane_from_pixels(planes, points, pose, pixels, focal, centre, k1, depth):
    """The found plane under pixels on the ground seen from a COLMAP pose, scored by
    where the pixels' rays meet it: the median distance from each hit to the plane's
    nearest point, over `depth` (the median depth of the points). A plane is out when
    a ray meets it behind the camera or a hit lands far outside its points'
    footprint, so a click on a plain table, whose points are only at its edges and
    under the objects on it, still finds it, and the wall behind the table, which
    those rays meet below its points, does not. Planes under MIN_PLANE_POINTS are not
    considered. Returns (index, score). Raises ValueError when no plane takes them."""
    pts = np.asarray(points, float)
    best = None
    for i, p in enumerate(planes):
        if len(p["inliers"]) < MIN_PLANE_POINTS:
            continue
        hits = plane_points(pose, pixels, p, focal, centre, k1)
        if any(x is None for x in hits):
            continue
        inl = pts[p["inliers"]]
        c = inl.mean(axis=0)
        axes = np.linalg.svd(inl - c)[2][:2]              # the plane's own two axes
        uv = (inl - c) @ axes.T
        lo, hi = uv.min(axis=0), uv.max(axis=0)
        hit_uv = (np.array(hits) - c) @ axes.T
        outside = np.linalg.norm(np.maximum(np.maximum(lo - hit_uv, hit_uv - hi), 0), axis=1)
        if (outside > FOOTPRINT_MARGIN * float(np.linalg.norm(hi - lo))).any():
            continue
        score = float(np.median([np.linalg.norm(inl - x, axis=1).min() for x in hits])) / depth
        if best is None or score < best[1]:
            best = (i, score)
    if best is None:
        raise ValueError("known.plane: no plane in the tracked points lies under those pixels. "
                         "Pick pixels well inside the table or floor, away from its edges")
    return best


def align_world(plane, pose0):
    """The world frame from the plane and frame 0's pose: {axes (rows x, y, z in
    reconstruction coordinates), origin, height (frame 0's camera above the plane, in
    reconstruction units), reach (how far frame 0's camera is from the origin, the
    targets' distance), on_axis (False when frame 0's axis misses the plane and the
    origin is the foot of its camera instead)}. The scale is set later."""
    R0, C0 = pose0
    n, p = plane["normal"], plane["point"]
    f0, r0 = R0[2], R0[0]
    height = float((C0 - p) @ n)
    if height < 0:
        n, height = -n, -height
    origin, on_axis, reach = C0 - height * n, False, height
    if float(f0 @ n) < -1e-9:
        reach = height / -float(f0 @ n)
        origin, on_axis = C0 + reach * f0, True
    x = _unit(r0 - (r0 @ n) * n)
    if x is None:
        # frame 0's right is along the normal (the camera on its side): take its down
        x = _unit(R0[1] - (R0[1] @ n) * n)
    y = np.cross(n, x)
    return {"axes": np.array([x, y, n]), "origin": origin, "height": height, "reach": reach, "on_axis": on_axis}


# ---- known sizes and planes ----

KNOWN_FORMS = ('known is {"height": m} or {"t": s, "pixels": [[u1, v1], [u2, v2]], "metres": d}, '
               'either with or without "plane": {"t": s, "pixels": [[u, v], ...]}')


def parse_known(text):
    """`known` as given (JSON text, or a dict): a scale, {"height": m} or {"t": s,
    "pixels": [[u1, v1], [u2, v2]], "metres": d}, and or a ground plane, "plane": {"t": s,
    "pixels": [[u, v], ...]} (three or more pixels on the table or floor at s). Raises
    ValueError with the reason."""
    if isinstance(text, str):
        try:
            known = json.loads(text)
        except json.JSONDecodeError as e:
            raise ValueError(f"known is not valid JSON: {e}")
    else:
        known = text
    if not isinstance(known, dict) or not known:
        raise ValueError(KNOWN_FORMS)
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
    pixel_list = lambda px: isinstance(px, list) and all(
        isinstance(p, list) and len(p) == 2 and all(num(v) for v in p) for p in px)
    out = {}
    scale = set(known) - {"plane"}
    if scale == {"height"}:
        if not (num(known["height"]) and known["height"] > 0):
            raise ValueError("known.height is frame 0's camera height above the plane in metres, above 0")
        out["height"] = float(known["height"])
    elif scale == {"t", "pixels", "metres"}:
        px = known["pixels"]
        if not (pixel_list(px) and len(px) == 2):
            raise ValueError("known.pixels is two pixels [[u1, v1], [u2, v2]]")
        if px[0] == px[1]:
            raise ValueError("known.pixels are the same pixel")
        if not (num(known["t"]) and known["t"] >= 0):
            raise ValueError("known.t is the time in seconds the pixels are seen at, 0 or more")
        if not (num(known["metres"]) and known["metres"] > 0):
            raise ValueError("known.metres is the distance between the two points in metres, above 0")
        out.update({"t": float(known["t"]), "pixels": [[float(v) for v in p] for p in px],
                    "metres": float(known["metres"])})
    elif scale:
        raise ValueError(KNOWN_FORMS)
    if "plane" in known:
        plane = known["plane"]
        if not (isinstance(plane, dict) and set(plane) == {"t", "pixels"}):
            raise ValueError('known.plane is {"t": s, "pixels": [[u, v], ...]}: three or more pixels on the '
                             "table or floor, seen at s seconds")
        if not (num(plane["t"]) and plane["t"] >= 0):
            raise ValueError("known.plane.t is the time in seconds the pixels are seen at, 0 or more")
        px = plane["pixels"]
        if not (pixel_list(px) and len(px) >= 3):
            raise ValueError("known.plane.pixels is three or more pixels [[u, v], ...] on the table or floor")
        arr = np.asarray(px, float)
        sv = np.linalg.svd(arr - arr.mean(axis=0))[1]
        if not sv[1] > 1e-3 * max(sv[0], 1e-9):
            raise ValueError("known.plane.pixels lie on one line: spread them over the table or floor")
        out["plane"] = {"t": float(plane["t"]), "pixels": arr.tolist()}
    return out


def plane_points(pose, pixels, plane, focal, centre, k1):
    """Where pixels seen from a COLMAP pose meet the plane, in reconstruction
    coordinates; None for a pixel whose ray misses it."""
    R, C = pose
    n, p = plane["normal"], plane["point"]
    out = []
    for x in undistort(pixels, focal, centre, k1):
        ray = R.T @ np.array([x[0], x[1], 1.0])
        den = float(ray @ n)
        s = float((p - C) @ n) / den if abs(den) > 1e-12 else -1.0
        out.append(C + s * ray if s > 0 else None)
    return out


# ---- the whole track ----

def solve(poses, points, *, fps, size, focal, k1, known=None, reprojection=None, principal=None,
          tolerance=DEFAULT_TOLERANCE_PX):
    """The track as track_camera reports it, unrounded.

    poses: one per sampled frame, (R, C) or None for a frame that did not register.
    points: the sparse points (N x 3). size: [w, h] of the frames in px; focal, k1 and
    principal (default the frame's centre) are the SIMPLE_RADIAL camera in those px.
    known: parse_known's dict or None. tolerance: px, how far scene.camera's thinned keys
    may draw the scene from the full track (thin_keys). Raises ValueError for a known
    size that cannot be used."""
    w, h = size
    centre = np.array([w / 2, h / 2]) if principal is None else np.asarray(principal, float)
    filled, registered = fill_poses(poses)
    pts = np.asarray(points, float)
    R0, C0 = filled[0]
    notes = []

    known = known or {}
    end = (len(filled) - 1) / fps

    def seen_at(t, pixels, name):
        if t > end + 1e-9:
            raise ValueError(f"{name}.t {t:g} s is after the last tracked frame ({end:g} s)")
        for u, v in pixels:
            if not (0 <= u <= w and 0 <= v <= h):
                raise ValueError(f"{name}.pixels [{u:g}, {v:g}] is outside the {w}x{h} frame")
        return pose_at(filled, fps, t)

    depth = float(np.median((pts - C0) @ R0[2]))
    threshold = PLANE_THRESHOLD * abs(depth)
    planes = find_planes(pts, threshold)
    face(planes, C0)
    if "plane" in known:
        kp = known["plane"]
        chosen, _ = plane_from_pixels(planes, pts, seen_at(kp["t"], kp["pixels"], "known.plane"), kp["pixels"],
                                      focal, centre, k1, abs(depth))
        plane, rule = planes[chosen], "pixels"
    else:
        chosen, rule = choose_plane(planes, C0, -R0[1], R0[2])
        plane = planes[chosen]
    world = align_world(plane, filled[0])

    if "height" in known:
        scale = known["height"] / world["height"]
        source = f"known height: frame 0's camera {known['height']:g} m above the plane"
    elif "metres" in known:
        pose = seen_at(known["t"], known["pixels"], "known")
        a, b = plane_points(pose, known["pixels"], plane, focal, centre, k1)
        if a is None or b is None:
            raise ValueError("a known pixel's ray never meets the plane; pick two points on the table or floor")
        scale = known["metres"] / float(np.linalg.norm(a - b))
        source = f"known distance: {known['metres']:g} m between two points on the plane at {known['t']:g} s"
    else:
        scale = DEFAULT_HEIGHT_M / world["height"]
        source = (f"assumed: frame 0's camera {DEFAULT_HEIGHT_M:g} m above the plane. "
                  "Replace it: pass known, a measured height or a distance on the plane")
    world["scale"] = scale
    world["target"] = max(world["reach"] * scale, MIN_TARGET_M)

    lens = lens_from_focal(focal, h)
    frames = []
    for i, pose in enumerate(filled):
        cam = montaj_camera(pose, world)
        frames.append({"t": i / fps, **cam, "registered": registered[i]})
    # Thinned on the values as printed, so the tolerance holds on what is written.
    unwrapped = np.degrees(np.unwrap(np.radians([f["roll"] for f in frames])))
    printed = [{"t": round(f["t"], TIME_DECIMALS), "location": _printed_pos(f["location"]),
                "target": _printed_pos(f["target"]), "roll": round(float(r), ROLL_DECIMALS) + 0.0}
               for f, r in zip(frames, unwrapped)]
    printed_lens = round(float(lens), LENS_DECIMALS)
    seen = scale * ((pts - world["origin"]) @ world["axes"].T)
    rolls = any(abs(f["roll"]) >= ROLL_KEYS_FROM for f in frames)
    keys = None if rolls else thin_keys(printed, printed_lens, (w, h), seen, tolerance, roll=False)
    rolled_anyway = not rolls and keys is None
    if keys is None:
        rolls = True
        keys = thin_keys(printed, printed_lens, (w, h), seen, tolerance, roll=True)
    key_roll = [printed[k]["roll"] for k in keys] if rolls else None

    def rms_m(p):
        inl = pts[p["inliers"]]
        return float(np.sqrt(np.mean(((inl - p["point"]) @ p["normal"]) ** 2))) * scale if len(inl) else 0.0

    candidates = [{"inliers": int(len(p["inliers"])), "rmsM": rms_m(p), "upInPicture": float(p["normal"] @ -R0[1]),
                   "towardCamera": float(p["normal"] @ -R0[2]), "chosen": i == chosen}
                  for i, p in enumerate(planes)]

    missing = [i for i, r in enumerate(registered) if not r]
    if missing:
        notes.append(f"{len(missing)} of {len(filled)} frames did not track and were interpolated "
                     f"(registered: false), at t = {', '.join(f'{i / fps:g}' for i in missing[:20])}"
                     f"{' ...' if len(missing) > 20 else ''} s.")
    through = f"{len(plane['inliers'])} of {len(pts)} tracked points"
    up0 = float(plane["normal"] @ -R0[1])
    notes.append({
        "up": f"z = 0 is the plane facing most up the picture ({through}; up {up0:.2f}).",
        "facing": f"z = 0 is the plane facing the camera most ({through}): none faces up the picture "
                  f"by {UP_ENOUGH:g} or more, as when the camera looks down.",
        "pixels": f"z = 0 is the plane under known.plane's pixels ({through}).",
    }[rule] + (" If it is not the table or floor, point at that with known.plane." if rule in ("up", "facing") else ""))
    if not world["on_axis"]:
        notes.append("Frame 0 does not look at the plane: the origin is under frame 0's camera instead.")
    corner = math.hypot(w / 2, h / 2) / focal
    shift = abs(k1) * corner ** 3 * focal
    if shift >= 1:
        notes.append(f"The lens bends the picture (k1 {k1:.3f}) by up to {shift:.0f} px at the corners; "
                     "Montaj's camera has no distortion.")
    if float(np.max(np.abs(centre - [w / 2, h / 2]))) > 0.5:
        notes.append(f"The principal point is off centre by {centre[0] - w / 2:.1f}, {centre[1] - h / 2:.1f} px; "
                     "Montaj's camera keeps it centred.")
    notes.append(f"scene.camera keeps {len(keys)} of {len(frames)} keys: between them the camera stays within "
                 f"{tolerance:g} px of the track at every frame."
                 + ("" if rolls else f" It has no roll keys: no frame rolls {ROLL_KEYS_FROM:g} degrees.")
                 + (f" It keeps roll keys although no frame rolls {ROLL_KEYS_FROM:g} degrees: leaving them out "
                    f"would miss by more than {tolerance:g} px." if rolled_anyway else ""))

    return {
        "fps": fps,
        "frameCount": len(filled),
        "registered": int(sum(registered)),
        "size": [w, h],
        "lens": lens,
        "focalPx": float(focal),
        "distortion": {"k1": float(k1)},
        "frames": frames,
        "plane": {"rule": rule, "inliers": int(len(plane["inliers"])), "rmsM": rms_m(plane),
                  "candidates": candidates},
        "scale": {"metresPerUnit": scale, "source": source},
        "reprojectionPx": reprojection,
        "notes": notes,
        "keys": keys,
        "keyRoll": key_roll,
    }


def _printed_pos(v):
    return [round(float(c), POS_DECIMALS) + 0.0 for c in v]   # + 0.0: no -0.0


def rounded(track):
    """The track as printed: positions to 0.1 mm, up to 1e-6, roll to 0.01 degrees, and
    scene.camera keyed at the frames thin_keys kept, with roll keys when the camera
    rolls, every key [t, value, "linear"] as thin_keys checked it."""
    pos = _printed_pos
    frames = [{"t": round(f["t"], TIME_DECIMALS), "location": pos(f["location"]), "target": pos(f["target"]),
               "up": [round(float(c), UP_DECIMALS) + 0.0 for c in f["up"]],
               "roll": round(float(f["roll"]), ROLL_DECIMALS) + 0.0, "registered": bool(f["registered"])}
              for f in track["frames"]]
    lens = round(float(track["lens"]), LENS_DECIMALS)
    plane = dict(track["plane"])
    plane["rmsM"] = round(plane["rmsM"], 5)
    plane["candidates"] = [{**c, "rmsM": round(c["rmsM"], 5), "upInPicture": round(c["upInPicture"], 2),
                            "towardCamera": round(c["towardCamera"], 2)} for c in plane["candidates"]]
    reproj = track["reprojectionPx"]
    keys, key_roll = track["keys"], track["keyRoll"]
    camera = {
        "lens": lens,
        "location": [[frames[i]["t"], frames[i]["location"], "linear"] for i in keys],
        "target": [[frames[i]["t"], frames[i]["target"], "linear"] for i in keys],
    }
    if key_roll is not None:
        camera["roll"] = [[frames[i]["t"], round(float(r), ROLL_DECIMALS) + 0.0, "linear"]
                          for i, r in zip(keys, key_roll)]
    printed = {k: v for k, v in track.items() if k not in ("keys", "keyRoll")}
    return {
        **printed,
        "lens": lens,
        "focalPx": round(track["focalPx"], 2),
        "distortion": {"k1": round(track["distortion"]["k1"], 5)},
        "frames": frames,
        "plane": plane,
        "scale": {**track["scale"], "metresPerUnit": float(f"{track['scale']['metresPerUnit']:.6g}")},
        "reprojectionPx": None if reproj is None else round(float(reproj), 3),
        "scene": {"camera": camera},
    }
