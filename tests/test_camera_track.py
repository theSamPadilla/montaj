"""lib/camera_track.py: a reconstruction's poses and points as Montaj's camera.

The scene is synthetic and built in Montaj's own world (Blender axes, metres): a
table at z = 0, a wall behind it with MORE points than the table (a textured
background over a plain table, as on a real tabletop clip), a few points off
both, and five cameras at 10 fps, one rolled. The reconstruction a tracker would
give is that world moved, turned and scaled by an arbitrary similarity, with each
camera's pose in COLMAP's convention (cam_from_world rows: right, down, forward).
The pixels are a pinhole's, so the camera solve() emits must put every point back
on its pixel through the engine's projection (project_points, a port of
camera-project.js) to 0.01 px.

Frame 0 looks from (0, -0.56, 0.42) at the origin with no roll, so the world
solve() sets up (origin where frame 0's axis meets the table, +x frame 0's right)
is the synthetic world itself, at the scale the known size gives.
"""
import json
import math

import pytest

np = pytest.importorskip("numpy")

from lib import camera_track as ct

W, H = 540, 960
FOCAL = 845.0
FPS = 10.0
TRUTH_HEIGHT = 0.42


def _rot(axis, deg):
    a = math.radians(deg)
    x, y, z = np.asarray(axis, float) / np.linalg.norm(axis)
    c, s = math.cos(a), math.sin(a)
    return np.array([
        [c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
        [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
        [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)],
    ])


def _look(location, target, roll=0.0):
    """cam_from_world (rows right, down, forward) of a camera at location looking at
    target, rolled so its right edge rises by `roll` degrees, built from first
    principles: right = forward x z, up = right x forward, then turned about forward."""
    f = np.subtract(target, location) / np.linalg.norm(np.subtract(target, location))
    r = np.cross(f, [0, 0, 1])
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    a = math.radians(roll)
    r, u = math.cos(a) * r + math.sin(a) * u, math.cos(a) * u - math.sin(a) * r
    return np.array([r, -u, f])


# Truth cameras, Montaj world: (cam_from_world, centre).
YAW = 10.0
BASE_LOC = np.array([0.05, -0.50, 0.40])
BASE_R = _look(BASE_LOC, [0.05, 0.0, 0.0])
TRUTH = [
    (_look([0, -0.56, TRUTH_HEIGHT], [0, 0, 0]), np.array([0, -0.56, TRUTH_HEIGHT])),
    # frames 1 and 3 turn the same camera +-10 degrees about z and sit either side of
    # frame 2's centre, so frame 2 is exactly their lerp and slerp
    (BASE_R @ _rot([0, 0, 1], YAW).T, BASE_LOC + [-0.03, 0.01, 0.0]),
    (BASE_R, BASE_LOC),
    (BASE_R @ _rot([0, 0, 1], -YAW).T, BASE_LOC + [0.03, -0.01, 0.0]),
    (_look([-0.08, -0.45, 0.38], [0.02, 0.05, 0.0], roll=12.0), np.array([-0.08, -0.45, 0.38])),
]
TRUTH_ROLL = [0.0, None, 0.0, None, 12.0]


def _scene_points():
    rng = np.random.default_rng(7)
    gx, gy = np.meshgrid(np.linspace(-0.3, 0.3, 15), np.linspace(-0.1, 0.45, 15))
    table = np.c_[gx.ravel() + rng.uniform(-0.01, 0.01, 225), gy.ravel() + rng.uniform(-0.01, 0.01, 225), np.zeros(225)]
    wx, wz = np.meshgrid(np.linspace(-0.4, 0.4, 20), np.linspace(0.03, 0.4, 15))
    wall = np.c_[wx.ravel(), np.full(300, 0.6), wz.ravel()]
    off = np.c_[rng.uniform(-0.2, 0.2, 30), rng.uniform(0.0, 0.4, 30), rng.uniform(0.03, 0.15, 30)]
    return np.vstack([table, wall, off])


POINTS = _scene_points()
TABLE = slice(0, 225)


def _pixels(pose, points, k1=0.0):
    R, C = pose
    xc = (np.asarray(points) - C) @ R.T
    return ct.distort(xc[:, :2] / xc[:, 2:3], FOCAL, np.array([W / 2, H / 2]), k1)


def _reconstruction(drop=(), truth=TRUTH, points=POINTS):
    """The truth seen by a tracker: X_r = s Q X + T, poses in that frame."""
    Q = _rot([0.3, -0.8, 0.5], 73.0)
    s, T = 3.7, np.array([1.5, -2.0, 0.7])
    seen = (s * (Q @ np.asarray(points).T)).T + T
    poses = [None if i in drop else (R @ Q.T, s * (Q @ C) + T) for i, (R, C) in enumerate(truth)]
    return poses, seen


def _solve(drop=(), known=None, k1=0.0, truth=TRUTH, points=POINTS, tol=ct.DEFAULT_TOLERANCE_PX):
    poses, seen = _reconstruction(drop, truth, points)
    return ct.solve(poses, seen, fps=FPS, size=[W, H], focal=FOCAL, k1=k1, known=known, tolerance=tol)


def _camera(frame, lens):
    return {"location": frame["location"], "target": frame["target"], "roll": frame["roll"], "lens": lens}


def _max_miss(track, frames=None, truth=TRUTH, points=POINTS):
    worst = 0.0
    for i in range(len(truth)) if frames is None else frames:
        want = _pixels(truth[i], points)
        got = ct.project_points(_camera(track["frames"][i], track["lens"]), points, (W, H))
        for g, p in zip(got, want):
            worst = max(worst, float(np.hypot(*(np.asarray(g) - p))))
    return worst


# ---- lens ----

def test_lens_from_focal_is_the_vertical_field_of_view_on_a_36_mm_sensor():
    assert ct.lens_from_focal(FOCAL, H) == pytest.approx(36 * FOCAL / H)
    vfov = 2 * math.atan((H / 2) / FOCAL)
    assert ct.lens_from_focal(FOCAL, H) == pytest.approx(18 / math.tan(vfov / 2))
    assert ct.focal_from_lens(ct.lens_from_focal(FOCAL, H), H) == pytest.approx(FOCAL)


def test_35mm_equivalent_matches_the_diagonal():
    assert ct.focal_from_35mm(math.hypot(36, 24), 3000, 4000) == pytest.approx(5000)
    assert ct.focal_from_35mm(26, 1080, 1920) == pytest.approx(26 * math.hypot(1080, 1920) / math.hypot(36, 24))


# ---- the world ----

def test_the_world_is_the_table_under_frame_0_not_the_bigger_wall():
    track = _solve(known={"height": TRUTH_HEIGHT})
    # frame 0's axis meets the table at the origin; +x is its right; +z up
    f0 = track["frames"][0]
    assert f0["location"] == pytest.approx([0, -0.56, TRUTH_HEIGHT], abs=1e-9)
    assert f0["target"] == pytest.approx([0, 0, 0], abs=1e-9)
    assert (track["plane"]["rule"], track["plane"]["inliers"]) == ("up", 225)
    chosen = [c for c in track["plane"]["candidates"] if c["chosen"]]
    assert len(chosen) == 1 and max(c["inliers"] for c in track["plane"]["candidates"]) == 300
    for i, (R, C) in enumerate(TRUTH):
        assert track["frames"][i]["location"] == pytest.approx(C, abs=1e-9)


def test_axes_follow_frame_0_and_the_plane_whatever_the_reconstruction_frame():
    poses, points = _reconstruction()
    planes = ct.find_planes(points, 0.01 * 3.7 * 0.7)
    i, _ = ct.choose_plane(planes, poses[0][1], -poses[0][0][1], poses[0][0][2])
    world = ct.align_world(planes[i], poses[0])
    world["scale"] = 1 / 3.7
    # the reconstruction's own frame mapped back to the truth: every point of the
    # table lands on z = 0 and frame 0's right is +x
    A, o = world["axes"], world["origin"]
    table = ((points[TABLE] - o) @ A.T) / 3.7
    assert np.abs(table[:, 2]).max() < 1e-9
    assert table == pytest.approx(POINTS[TABLE], abs=1e-9)
    assert A @ poses[0][0][0] == pytest.approx([1, 0, 0], abs=1e-12)
    assert np.linalg.det(A) == pytest.approx(1)


def test_planes_are_scored_on_a_subset_and_counted_on_every_point(monkeypatch):
    monkeypatch.setattr(ct, "SCORE_SAMPLE", 120)
    planes = ct.find_planes(POINTS, 0.005)
    assert sorted(len(p["inliers"]) for p in planes[:2]) == [225, 300]
    again = ct.find_planes(POINTS, 0.005)
    assert [p["inliers"].tolist() for p in again] == [p["inliers"].tolist() for p in planes]


def test_x_is_frame_0s_own_right_laid_on_the_plane_when_it_rolls():
    C0 = np.array([0, -0.56, 0.42])
    R0 = _look(C0, [0, 0, 0], roll=15.0)
    world = ct.align_world({"normal": np.array([0, 0, 1.0]), "point": np.array([0.3, 0.2, 0])}, (R0, C0))
    want = R0[0] * [1, 1, 0]
    assert world["axes"][0] == pytest.approx(want / np.linalg.norm(want), abs=1e-12)
    assert world["axes"][2] == pytest.approx([0, 0, 1])
    assert world["origin"] == pytest.approx([0, 0, 0], abs=1e-12)
    assert (world["height"], world["on_axis"]) == (pytest.approx(0.42), True)


def test_frame_0_looking_away_from_the_plane_puts_the_origin_under_it():
    C0 = np.array([0.1, -0.56, 0.42])
    world = ct.align_world({"normal": np.array([0, 0, 1.0]), "point": np.zeros(3)}, (_look(C0, [0.1, 0, 0.6]), C0))
    assert world["origin"] == pytest.approx([0.1, -0.56, 0], abs=1e-12)
    assert world["on_axis"] is False


def _walls():
    """Three walls round the eye at (0, -0.56, 0.42): 300 points at y = 0.6 (facing
    -y), 100 at x = 0.5 (facing -x) and 50 at x = -0.5 (facing +x)."""
    gy, gz = np.meshgrid(np.linspace(0.0, 0.5, 10), np.linspace(0.1, 0.4, 10))
    b = np.c_[np.full(100, 0.5), gy.ravel(), gz.ravel()]
    cy, cz = np.meshgrid(np.linspace(0.0, 0.5, 10), np.linspace(0.1, 0.4, 5))
    c = np.c_[np.full(50, -0.5), cy.ravel(), cz.ravel()]
    return ct.find_planes(np.vstack([POINTS[225:525], b, c]), 0.005)


@pytest.mark.parametrize("up, forward, inliers, rule", [
    # the smaller wall faces up the picture: it wins over the largest
    ([-1, 0, 0], [0, 1, 0], 100, "up"),
    # only the 50-point wall faces up, and it holds under a quarter of 300; nothing
    # else faces up, so the one facing the camera wins
    ([1, 0, 0], [0, 1, 0], 300, "facing"),
    # under 0.3 up for every wall (0.2 for the smaller): the one facing the camera,
    # the smaller, not the largest
    ([0.2, 0, 0.98], [1, 0, 0], 100, "facing"),
])
def test_the_plane_facing_up_the_picture_wins_else_the_one_facing_the_camera(up, forward, inliers, rule):
    planes = _walls()
    assert sorted(len(p["inliers"]) for p in planes) == [50, 100, 300]
    unit = lambda v: np.asarray(v, float) / np.linalg.norm(v)
    i, why = ct.choose_plane(planes, np.array([0, -0.56, 0.42]), unit(up), unit(forward))
    assert (len(planes[i]["inliers"]), why) == (inliers, rule)


def test_scattered_points_with_no_flat_surface_are_refused_by_name():
    scattered = np.random.default_rng(5).uniform([-0.3, 0.0, 0.0], [0.3, 0.5, 0.3], (60, 3))
    for known in (None, {"height": TRUTH_HEIGHT}):
        with pytest.raises(ct.NoPlane, match="^No flat surface with enough tracked points: point at the table "
                                             "or floor with known.plane.$"):
            _solve(known=known, points=scattered)
    with pytest.raises(ct.NoPlane):
        ct.choose_plane([], np.zeros(3), np.array([0, 0, 1.0]), np.array([0, 1.0, 0]))


# A top-down shot: the camera 0.5 m over a table, looking almost straight down, so
# image-up lies nearly in the table (0.1 up). The bigger plane is a vertical board at
# the left, turned 12 degrees, which faces up the picture more (0.2) but under 0.3.
TOP_TRUTH = [
    (_look([0, -0.05, 0.5], [0, 0, 0]), np.array([0, -0.05, 0.5])),
    (_look([0.02, -0.06, 0.48], [0.01, 0, 0]), np.array([0.02, -0.06, 0.48])),
    (_look([-0.02, -0.04, 0.52], [0, 0.01, 0], roll=5.0), np.array([-0.02, -0.04, 0.52])),
]


def _top_points():
    gx, gy = np.meshgrid(np.linspace(-0.1, 0.12, 12), np.linspace(-0.18, 0.18, 12))
    table = np.c_[gx.ravel(), gy.ravel(), np.zeros(144)]
    th = math.radians(12)
    ga, gz = np.meshgrid(np.linspace(-0.2, 0.2, 20), np.linspace(0.03, 0.3, 15))
    board = np.c_[-0.17 - math.sin(th) * ga.ravel(), math.cos(th) * ga.ravel(), gz.ravel()]
    return np.vstack([table, board])


def test_top_down_the_table_facing_the_camera_wins_over_a_bigger_plane():
    points = _top_points()
    track = _solve(known={"height": 0.5}, truth=TOP_TRUTH, points=points)
    cands = sorted(track["plane"]["candidates"], key=lambda c: -c["inliers"])
    assert [c["inliers"] for c in cands[:2]] == [300, 144]
    assert 0 < cands[1]["upInPicture"] < cands[0]["upInPicture"] < ct.UP_ENOUGH
    assert (track["plane"]["rule"], track["plane"]["inliers"]) == ("facing", 144)
    assert any("facing the camera most" in n for n in track["notes"])
    for i, (R, C) in enumerate(TOP_TRUTH):
        assert track["frames"][i]["location"] == pytest.approx(C, abs=1e-9)
    assert _max_miss(track, truth=TOP_TRUTH, points=points) < 0.01


# ---- known.plane: pointing at the ground ----

def _in_frame(pose, points):
    px = _pixels(pose, points)
    return [i for i, (u, v) in enumerate(px) if 10 < u < W - 10 and 10 < v < H - 10]


def test_known_plane_pixels_pick_the_plane_under_them():
    # the wall's pixels at 0.3 s: the wall becomes z = 0 though the rule picks the table
    wall = np.arange(225, 525)
    seen = [i for i in _in_frame(TRUTH[3], POINTS) if i in set(wall)]
    pick = [seen[0], seen[len(seen) // 3], seen[2 * len(seen) // 3], seen[-1]]
    px = _pixels(TRUTH[3], POINTS[pick]).tolist()
    to_wall = 0.6 + 0.56                          # frame 0's camera from the wall
    track = _solve(known={"plane": {"t": 0.3, "pixels": px}, "height": to_wall})
    assert (track["plane"]["rule"], track["plane"]["inliers"]) == ("pixels", 300)
    # every camera's height is now its distance from the wall
    for f, (R, C) in zip(track["frames"], TRUTH):
        assert f["location"][2] == pytest.approx(0.6 - C[1], abs=1e-9)


def _plain_table_points():
    """A plain table: points only along its edges (60, under a quarter of the wall's
    300, so the rule does not even consider it), the wall and the off points."""
    rng = np.random.default_rng(11)
    t = rng.uniform(0, 1, 60)
    side = np.arange(60) % 4
    x = np.where(side == 0, -0.3, np.where(side == 1, 0.3, -0.3 + 0.6 * t)) + rng.uniform(-0.015, 0.015, 60)
    y = np.where(side == 2, -0.1, np.where(side == 3, 0.45, -0.1 + 0.55 * t)) + rng.uniform(-0.015, 0.015, 60)
    return np.vstack([np.c_[x, y, np.zeros(60)], POINTS[225:]])


INSIDE_TABLE = np.array([[0.1, 0.05, 0], [0.15, 0.3, 0], [0.05, 0.3, 0], [0.08, -0.03, 0], [0.2, 0.15, 0]])


def test_known_plane_clicks_inside_a_plain_table_find_it_over_a_bigger_wall():
    points = _plain_table_points()
    auto = _solve(known={"height": TRUTH_HEIGHT}, points=points)
    assert (auto["plane"]["rule"], auto["plane"]["inliers"]) == ("facing", 300)     # the wall, wrongly
    px = _pixels(TRUTH[3], INSIDE_TABLE).tolist()                                   # no tracked point near any
    track = _solve(known={"plane": {"t": 0.3, "pixels": px}, "height": TRUTH_HEIGHT}, points=points)
    assert (track["plane"]["rule"], track["plane"]["inliers"]) == ("pixels", 60)
    for i, (R, C) in enumerate(TRUTH):
        assert track["frames"][i]["location"] == pytest.approx(C, abs=1e-9)
    assert _max_miss(track, points=points) < 0.01


def test_known_plane_clicks_where_two_planes_take_them_go_to_the_nearer_points():
    # near the table's back edge the rays meet the wall just under its points, inside
    # its footprint's margin: both planes take them, and the table's points are nearer
    back = np.array([[-0.1, 0.43, 0], [0.05, 0.42, 0], [0.15, 0.44, 0]])
    px = _pixels(TRUTH[0], back).tolist()
    poses, seen = _reconstruction()
    planes = ct.find_planes(seen, 0.01 * 3.7 * 0.7)
    wall = [i for i, p in enumerate(planes) if len(p["inliers"]) == 300]
    table = [i for i, p in enumerate(planes) if len(p["inliers"]) == 225]
    centre = np.array([W / 2, H / 2])
    ct.plane_from_pixels([planes[i] for i in wall], seen, poses[0], px, FOCAL, centre, 0.0, 3.7 * 0.7)
    i, _ = ct.plane_from_pixels(planes, seen, poses[0], px, FOCAL, centre, 0.0, 3.7 * 0.7)
    assert [i] == table and wall[0] < table[0]


def test_known_plane_pixels_no_plane_takes_are_refused():
    points = _plain_table_points()
    table = [p for p in ct.find_planes(points, 0.005) if len(p["inliers"]) == 60]
    centre = np.array([W / 2, H / 2])
    # the top of the frame meets the table far beyond its points
    with pytest.raises(ValueError, match="no plane in the tracked points lies under those pixels"):
        ct.plane_from_pixels(table, points, TRUTH[0], [[100, 15], [270, 10], [440, 15]], FOCAL, centre, 0.0, 0.7)
    # a camera looking up meets it behind itself
    up = (_look([0, 0, 0.4], [0, 0.3, 0.8]), np.array([0, 0, 0.4]))
    with pytest.raises(ValueError, match="away from its edges"):
        ct.plane_from_pixels(table, points, up, [[200, 400], [300, 500], [250, 600]], FOCAL, centre, 0.0, 0.7)
    # and through solve, as the step reports it
    with pytest.raises(ValueError, match="no plane"):
        _solve(known={"plane": {"t": 0, "pixels": [[100, 15], [270, 10], [440, 15]]}},
               points=_plain_table_points()[:60])


# ---- the camera ----

def test_emitted_cameras_put_every_point_back_on_its_pixel():
    track = _solve(known={"height": TRUTH_HEIGHT})
    assert track["lens"] == pytest.approx(36 * FOCAL / H)
    assert _max_miss(track) < 0.01


def test_roll_is_counter_clockwise_from_behind_the_camera():
    track = _solve(known={"height": TRUTH_HEIGHT})
    for i, roll in enumerate(TRUTH_ROLL):
        if roll is not None:
            assert track["frames"][i]["roll"] == pytest.approx(roll, abs=1e-9)
    # rolled +10 degrees, a level camera sees a point on its own horizon, to the
    # right, below the centre line: the right edge rose, the horizon turned clockwise
    cam = {"location": [0, 0, 1], "target": [0, 1, 1], "roll": 10.0, "lens": 30}
    u, v = ct.project_points(cam, [[1, 5, 1]], (W, H))[0]
    assert u > W / 2 and v > H / 2


def test_every_target_sits_on_its_axis_as_far_as_frame_0s_axis_runs_to_the_plane():
    track = _solve(known={"height": TRUTH_HEIGHT})
    reach = math.hypot(0.56, TRUTH_HEIGHT)                  # frame 0's camera to the origin
    assert track["frames"][0]["target"] == pytest.approx([0, 0, 0], abs=1e-9)
    for f, (R, C) in zip(track["frames"], TRUTH):
        assert np.subtract(f["target"], f["location"]) == pytest.approx(reach * R[2], abs=1e-9)


@pytest.mark.parametrize("pitch", [-1e-9, 0.0, 10.0])
def test_a_level_camera_or_one_above_the_horizon_keeps_a_near_target(pitch):
    """A level axis never meets the plane, and one that tilts up meets it behind the
    camera: either way the target stays the same distance ahead, on the axis."""
    C = np.array([0.0, -0.3, 0.3])
    look = C + [0, math.cos(math.radians(pitch)), math.sin(math.radians(pitch))]
    world = {"axes": np.eye(3), "origin": np.zeros(3), "scale": 1.0, "target": 0.7}
    cam = ct.montaj_camera((_look(C, look), C), world)
    assert np.subtract(cam["target"], cam["location"]) == pytest.approx(0.7 * (look - C), abs=1e-12)


def test_up_is_the_rolled_cameras_up_as_the_engine_takes_it():
    """camera-project.js builds right = forward x up, up' = right x forward from a
    camera's `up`; through that, each emitted camera puts every point on its pixel."""
    track = _solve(known={"height": TRUTH_HEIGHT})
    for i, f in enumerate(track["frames"]):
        fw = np.subtract(f["target"], f["location"])
        fw /= np.linalg.norm(fw)
        r = np.cross(fw, f["up"])
        r /= np.linalg.norm(r)
        u = np.cross(r, fw)
        assert np.linalg.norm(f["up"]) == pytest.approx(1) and float(np.dot(f["up"], fw)) == pytest.approx(0, abs=1e-12)
        tan_v = 18 / track["lens"]
        d = POINTS - f["location"]
        z = d @ fw
        px = np.c_[((d @ r) / (z * tan_v * W / H) * 0.5 + 0.5) * W, (0.5 - (d @ u) / (z * tan_v) * 0.5) * H]
        assert np.abs(px - _pixels(TRUTH[i], POINTS)).max() < 0.01


# ---- scale ----

def test_known_height_sets_frame_0_and_scales_everything_with_it():
    track = _solve(known={"height": 0.25})
    k = 0.25 / TRUTH_HEIGHT
    for i, (R, C) in enumerate(TRUTH):
        assert track["frames"][i]["location"] == pytest.approx(k * C, abs=1e-9)
    assert track["scale"]["source"].startswith("known height")
    assert _max_miss(track) > 1        # a scaled world is not the truth


def test_without_a_known_size_frame_0_is_0_3_m_up_and_the_source_says_so():
    track = _solve()
    assert track["frames"][0]["location"][2] == pytest.approx(0.3, abs=1e-9)
    assert track["scale"]["source"].startswith("assumed")


@pytest.mark.parametrize("k1", [0.0, -0.05])
@pytest.mark.parametrize("frame", [0, 2, 4])
def test_two_pixels_on_the_table_a_known_distance_apart(frame, k1):
    table = POINTS[TABLE]
    a, b = (table[np.argmin(np.linalg.norm(table - q, axis=1))] for q in ([-0.04, 0.12, 0], [0.07, 0.25, 0]))
    px = _pixels(TRUTH[frame], [a, b], k1).tolist()
    d = float(np.linalg.norm(a - b))
    drop = (2,) if frame == 2 else ()      # frame 2 read from its neighbours
    track = _solve(drop=drop, k1=k1, known={"t": frame / FPS, "pixels": px, "metres": d})
    for i, (R, C) in enumerate(TRUTH):
        assert track["frames"][i]["location"] == pytest.approx(C, abs=1e-9)
    assert track["scale"]["source"].startswith("known distance")


def test_a_known_pixel_off_the_frame_or_late_is_refused():
    px = _pixels(TRUTH[0], [POINTS[100], POINTS[120]]).tolist()
    with pytest.raises(ValueError, match="after the last"):
        _solve(known={"t": 0.5, "pixels": px, "metres": 0.1})
    with pytest.raises(ValueError, match="outside"):
        _solve(known={"t": 0, "pixels": [[-5, 10], px[1]], "metres": 0.1})


def test_parse_known():
    assert ct.parse_known('{"height": 0.3}') == {"height": 0.3}
    assert ct.parse_known({"t": 1, "pixels": [[1, 2], [3, 4]], "metres": 0.06}) == \
        {"t": 1.0, "pixels": [[1.0, 2.0], [3.0, 4.0]], "metres": 0.06}
    plane = {"t": 0.5, "pixels": [[1, 2], [30, 4], [5, 60]]}
    assert ct.parse_known({"plane": plane}) == {"plane": {"t": 0.5, "pixels": [[1.0, 2.0], [30.0, 4.0], [5.0, 60.0]]}}
    assert set(ct.parse_known({"height": 0.3, "plane": plane})) == {"height", "plane"}
    for bad in ['{}', '{"plane": {"t": 0, "pixels": [[1, 2], [3, 4]]}}',
                '{"plane": {"t": 0, "pixels": [[1, 1], [2, 2], [3, 3]]}}',
                '{"plane": {"t": 0, "pixels": [[1, 2], [30, 4], [5, 60]], "metres": 1}}',
                '{"plane": [[1, 2], [30, 4], [5, 60]]}',
                '{"height": 0}', '{"height": "1"}', "{nope", '{"width": 1}', '{"height": 1, "t": 0}',
                '{"t": 0, "pixels": [[1, 2]], "metres": 1}', '{"t": 0, "pixels": [[1, 2], [1, 2]], "metres": 1}',
                '{"t": -1, "pixels": [[1, 2], [3, 4]], "metres": 1}', '{"t": 0, "pixels": [[1, 2], [3, 4]], "metres": 0}']:
        with pytest.raises(ValueError):
            ct.parse_known(bad)


# ---- scene.camera: thinned keys ----

TOL = 0.5
CHECKED = POINTS[::2]           # under THIN_POINTS, so thin_keys checks every one of them


def _orbit(n=60, degrees=40.0, jitter=0.0, roll=None, seed=1):
    """A camera orbiting the table's middle at 0.6 m out and 0.4 m up, looking at it."""
    rng = np.random.default_rng(seed)
    out = []
    for i in range(n):
        a = math.radians(-degrees / 2 + degrees * i / (n - 1))
        loc = np.array([0.6 * math.sin(a), 0.175 - 0.6 * math.cos(a), 0.4]) + rng.uniform(-jitter, jitter, 3)
        tgt = np.array([0.0, 0.175, 0.0]) + rng.uniform(-jitter, jitter, 3)
        out.append({"t": i / FPS, "location": loc, "target": tgt, "roll": 0.0 if roll is None else roll(i)})
    return out


def _thinned_miss(frames, keys, lens, points, key_roll=True):
    """The furthest any point inside a frame's picture lands, drawn by the camera
    interpolated between the keys (np.interp per coordinate; level without
    key_roll), from where that frame's own camera draws it: an independent check of
    thin_keys."""
    t = [f["t"] for f in frames]
    kt = [t[k] for k in keys]
    lerp = lambda name, i: np.array([np.interp(t[i], kt, [frames[k][name][c] for k in keys]) for c in range(3)])
    worst = 0.0
    for i, f in enumerate(frames):
        roll = float(np.interp(t[i], kt, [frames[k]["roll"] for k in keys])) if key_roll else 0.0
        mid = {"location": lerp("location", i), "target": lerp("target", i), "roll": roll, "lens": lens}
        full = {**f, "lens": lens}
        for want, got in zip(ct.project_points(full, points, (W, H)), ct.project_points(mid, points, (W, H))):
            if want is not None and 0 <= want[0] <= W and 0 <= want[1] <= H:
                worst = max(worst, float(np.hypot(*np.subtract(got, want))))
    return worst


def test_a_straight_dolly_keeps_only_its_ends():
    frames = [{"t": i / FPS, "location": np.array([0.2 * i / 49, -0.6 + 0.2 * i / 49, 0.4]),
               "target": np.array([0.1 * i / 49, 0.1 * i / 49, 0.0]), "roll": 0.0} for i in range(50)]
    assert ct.thin_keys(frames, 32.0, (W, H), CHECKED, TOL) == [0, 49]


def test_a_smooth_orbit_collapses_to_few_keys_and_holds_the_tolerance():
    frames = _orbit()
    keys = ct.thin_keys(frames, 32.0, (W, H), CHECKED, TOL)
    assert keys[0] == 0 and keys[-1] == len(frames) - 1 and len(keys) <= 12
    assert _thinned_miss(frames, keys, 32.0, CHECKED) <= TOL


@pytest.mark.parametrize("jitter", [0.0, 0.0003])
def test_with_no_tracked_points_the_probes_alone_hold_the_tolerance_near_and_far(jitter):
    """The probes stand in for the table and the far background: the table under the
    frame's bottom, and far behind it, where a small turn and a small move no longer
    cancel. Things standing on the table are checked through the tracked points."""
    frames = _orbit(jitter=jitter)
    keys = ct.thin_keys(frames, 32.0, (W, H), np.zeros((0, 3)), TOL)
    table = CHECKED[CHECKED[:, 2] == 0]
    assert _thinned_miss(frames, keys, 32.0, np.vstack([table, table + [0, 6.0, 0]])) <= TOL


def test_a_jerky_path_keeps_more_keys_and_holds_the_tolerance():
    smooth = len(ct.thin_keys(_orbit(), 32.0, (W, H), CHECKED, TOL))
    frames = _orbit(jitter=0.0003)                      # 0.3 mm of shake on every frame
    keys = ct.thin_keys(frames, 32.0, (W, H), CHECKED, TOL)
    assert len(keys) > 2 * smooth
    assert _thinned_miss(frames, keys, 32.0, CHECKED) <= TOL


def test_a_looser_tolerance_keeps_fewer_keys():
    frames = _orbit(jitter=0.0003)
    counts = [len(ct.thin_keys(frames, 32.0, (W, H), CHECKED, tol)) for tol in (0.5, 2.0, 8.0)]
    assert counts[0] > counts[1] > counts[2]


def test_a_rolling_camera_is_thinned_with_its_roll():
    frames = _orbit(roll=lambda i: 6.0 * math.sin(i / 8))
    keys = ct.thin_keys(frames, 32.0, (W, H), CHECKED, TOL)
    assert _thinned_miss(frames, keys, 32.0, CHECKED) <= TOL
    # the same keys without their roll miss by far more
    assert _thinned_miss(frames, keys, 32.0, CHECKED, key_roll=False) > 20 * TOL
    assert len(keys) > len(ct.thin_keys(_orbit(), 32.0, (W, H), CHECKED, TOL))


@pytest.mark.parametrize("roll, keyed", [(0.04, False), (0.06, True), (-0.06, True)])
def test_roll_keys_only_when_a_frame_rolls_a_twentieth_of_a_degree(roll, keyed):
    truth = TRUTH[:4] + [(_look([-0.08, -0.45, 0.38], [0.02, 0.05, 0.0], roll=roll), TRUTH[4][1])]
    track = _solve(known={"height": TRUTH_HEIGHT}, truth=truth)
    cam = ct.rounded(track)["scene"]["camera"]
    assert ("roll" in cam) is keyed
    note = [n for n in track["notes"] if n.startswith("scene.camera keeps")]
    assert len(note) == 1 and ("no roll keys" in note[0]) is not keyed
    assert not any("take no roll" in n for n in track["notes"])


def _round_trip(roll, n=40, jitter=0.0002):
    """Truth cameras orbiting the origin at 0.7 m out and 0.42 m up, frame 0 looking
    at it level, so the world solve() sets up is this one; `roll(i)` in degrees."""
    rng = np.random.default_rng(4)
    truth = []
    for i in range(n):
        a = math.radians(30.0 * i / (n - 1))
        loc = np.array([0.7 * math.sin(a), -0.7 * math.cos(a), TRUTH_HEIGHT]) + (rng.uniform(-jitter, jitter, 3) if i else 0)
        truth.append((_look(loc, [0, 0, 0], roll=roll(i)), loc))
    return truth


def _printed_miss(track, points):
    """The furthest scene.camera, interpolated between its printed keys at each
    printed frame's t (np.interp), draws a point inside the picture from where that
    printed frame's camera, with its own roll, draws it."""
    cam = track["scene"]["camera"]
    kt = [k[0] for k in cam["location"]]
    lerp = lambda keys, t: [float(np.interp(t, kt, [k[1][c] for k in keys])) for c in range(3)]
    worst = 0.0
    for f in track["frames"]:
        full = {"location": f["location"], "target": f["target"], "roll": f["roll"], "lens": track["lens"]}
        roll = float(np.interp(f["t"], kt, [k[1] for k in cam["roll"]])) if "roll" in cam else 0.0
        mid = {"location": lerp(cam["location"], f["t"]), "target": lerp(cam["target"], f["t"]), "roll": roll,
               "lens": cam["lens"]}
        for want, got in zip(ct.project_points(full, points, (W, H)), ct.project_points(mid, points, (W, H))):
            if want is not None and 0 <= want[0] <= W and 0 <= want[1] <= H:
                worst = max(worst, float(np.hypot(*np.subtract(got, want))))
    return worst


@pytest.mark.parametrize("tol", [0.3, 0.4])
def test_the_tolerance_holds_on_the_printed_frames_and_keys(tol):
    truth = _round_trip(lambda i: 3.0 * math.sin(i / 6))
    track = ct.rounded(_solve(known={"height": TRUTH_HEIGHT}, truth=truth, points=CHECKED, tol=tol))
    assert "roll" in track["scene"]["camera"]
    assert len(track["scene"]["camera"]["location"]) < len(truth)
    assert _printed_miss(track, CHECKED) <= tol + 1e-9


def test_leaving_a_small_roll_out_is_charged_to_the_tolerance():
    """0.045 degrees of roll draws a 5 x 5 probe at the picture's corner 0.35 px off
    when the keys are level: within 1 px it may go, within 0.3 px it may not."""
    truth = _round_trip(lambda i: 0.045)
    loose = _solve(known={"height": TRUTH_HEIGHT}, truth=truth, points=CHECKED, tol=1.0)
    assert "roll" not in ct.rounded(loose)["scene"]["camera"]
    assert _printed_miss(ct.rounded(loose), CHECKED) <= 1.0 + 1e-9
    tight = _solve(known={"height": TRUTH_HEIGHT}, truth=truth, points=CHECKED, tol=0.3)
    assert "roll" in ct.rounded(tight)["scene"]["camera"]
    assert any("keeps roll keys although no frame rolls" in n for n in tight["notes"])
    assert _printed_miss(ct.rounded(tight), CHECKED) <= 0.3 + 1e-9


# The app's engine plays scene camera keys through cameraKeyAt (library/model3d/
# motion.js, with its monotoneTangents), ported here for this test only, its "linear"
# ease and its default: a key with ease "linear" lerps its segment; one with no ease
# is a monotone cubic Hermite per component, Fritsch-Carlson tangents, clamped into
# the segment's two values. (Its other eases, hold, in, out and back, are not used.)
def _monotone_tangents(ts, ys):
    n = len(ys)
    d = [(ys[k + 1] - ys[k]) / (ts[k + 1] - ts[k]) if ts[k + 1] > ts[k] else 0.0 for k in range(n - 1)]
    m = [d[0] if k == 0 else d[n - 2] if k == n - 1
         else (d[k - 1] + d[k]) / 2 if np.sign(d[k - 1]) * np.sign(d[k]) > 0 else 0.0 for k in range(n)]
    s = [1.0] * n
    for k in range(n - 1):
        if not d[k]:
            continue
        r = math.hypot(m[k] / d[k], m[k + 1] / d[k])
        if r > 3:
            s[k], s[k + 1] = min(s[k], 3 / r), min(s[k + 1], 3 / r)
    return [x * f for x, f in zip(m, s)]


def _camera_key_at(keys, t):
    ks = [(k[0], np.atleast_1d(np.asarray(k[1], float)), k[2] if len(k) > 2 else None) for k in keys]
    if t <= ks[0][0]:
        return ks[0][1]
    if t >= ks[-1][0]:
        return ks[-1][1]
    i = max(j for j in range(len(ks) - 1) if ks[j][0] <= t)
    (t1, p1, ease), (t2, p2, _) = ks[i], ks[i + 1]
    h = t2 - t1
    u = (t - t1) / h
    if ease == "linear":
        return p1 + (p2 - p1) * u
    h00, h10, h01, h11 = 2 * u**3 - 3 * u**2 + 1, u**3 - 2 * u**2 + u, -2 * u**3 + 3 * u**2, u**3 - u**2
    out = []
    for q in range(len(p1)):
        m = _monotone_tangents([k[0] for k in ks], [k[1][q] for k in ks])
        v = h00 * p1[q] + h10 * m[i] * h + h01 * p2[q] + h11 * m[i + 1] * h
        out.append(min(max(v, min(p1[q], p2[q])), max(p1[q], p2[q])))
    return np.array(out)


def _engine_miss(track, points, eases=True):
    """_printed_miss with scene.camera played as the engine plays it (_camera_key_at);
    eases=False drops the keys' eases, as keys written without them would be."""
    cam = track["scene"]["camera"]
    keys = lambda name: [k if eases else k[:2] for k in cam[name]]
    worst = 0.0
    for f in track["frames"]:
        full = {"location": f["location"], "target": f["target"], "roll": f["roll"], "lens": track["lens"]}
        mid = {"location": _camera_key_at(keys("location"), f["t"]), "target": _camera_key_at(keys("target"), f["t"]),
               "roll": float(_camera_key_at(keys("roll"), f["t"])[0]) if "roll" in cam else 0.0, "lens": cam["lens"]}
        for want, got in zip(ct.project_points(full, points, (W, H)), ct.project_points(mid, points, (W, H))):
            if want is not None and 0 <= want[0] <= W and 0 <= want[1] <= H:
                worst = max(worst, float(np.hypot(*np.subtract(got, want))))
    return worst


def test_keys_are_written_linear_as_they_were_checked():
    """Still, a 0.2 m dolly with 6 degrees of roll, still: four keys hold it exactly
    when the engine plays them linearly. Played as its default monotone cubic, each
    key beside a rest takes a zero tangent and the move eases in and out, far off."""
    move = lambda i: min(max((i - 24) / 25, 0.0), 1.0)
    truth = [(_look(np.array([0.2 * move(i), -0.56, TRUTH_HEIGHT]), [0.2 * move(i), 0, 0], roll=6.0 * move(i)),
              np.array([0.2 * move(i), -0.56, TRUTH_HEIGHT])) for i in range(75)]
    track = ct.rounded(_solve(known={"height": TRUTH_HEIGHT}, truth=truth, points=CHECKED))
    cam = track["scene"]["camera"]
    assert [k[0] for k in cam["location"]] == [0.0, 2.4, 4.9, 7.4]
    assert all(k[2:] == ["linear"] for name in ("location", "target", "roll") for k in cam[name])
    assert _engine_miss(track, CHECKED) <= ct.DEFAULT_TOLERANCE_PX + 1e-9
    assert _engine_miss(track, CHECKED) == pytest.approx(_printed_miss(track, CHECKED), abs=1e-9)
    assert _engine_miss(track, CHECKED, eases=False) > 10


def test_the_tolerance_sets_the_keys_and_the_count_is_in_the_notes():
    poses, seen = _reconstruction(truth=[(R, C) for R, C in TRUTH])
    solve = lambda tol: ct.solve(poses, seen, fps=FPS, size=[W, H], focal=FOCAL, k1=0.0,
                                 known={"height": TRUTH_HEIGHT}, tolerance=tol)
    assert [solve(tol)["keys"] for tol in (0.5, 500)] == [[0, 1, 2, 3, 4], [0, 4]]
    track = solve(500)
    assert "scene.camera keeps 2 of 5 keys: between them the camera stays within 500 px" in " ".join(track["notes"])


# ---- frames that did not register ----

def test_a_missing_frame_is_interpolated_and_flagged():
    track = _solve(drop=(2,), known={"height": TRUTH_HEIGHT})
    assert [f["registered"] for f in track["frames"]] == [True, True, False, True, True]
    assert track["registered"] == 4 and track["frameCount"] == 5
    assert track["frames"][2]["location"] == pytest.approx(TRUTH[2][1], abs=1e-9)
    assert _max_miss(track, [2]) < 0.01
    assert any("interpolated" in n for n in track["notes"])


def test_fill_poses_holds_the_ends_and_slerps_between():
    a = (_rot([0, 0, 1], 0), np.zeros(3))
    b = (_rot([0, 0, 1], 90), np.array([3.0, 0, 0]))
    filled, reg = ct.fill_poses([None, a, None, None, b, None])
    assert reg == [False, True, False, False, True, False]
    assert filled[0][1] == pytest.approx([0, 0, 0]) and filled[5][1] == pytest.approx([3, 0, 0])
    assert filled[2][1] == pytest.approx([1, 0, 0])
    assert filled[2][0] == pytest.approx(_rot([0, 0, 1], 30), abs=1e-12)
    assert filled[3][0] == pytest.approx(_rot([0, 0, 1], 60), abs=1e-12)


# ---- the output ----

def test_rounded_output_and_scene_camera_keys():
    track = ct.rounded(_solve(known={"height": TRUTH_HEIGHT}, drop=(2,)))
    json.dumps(track)
    assert "keys" not in track and "keyRoll" not in track
    cam = track["scene"]["camera"]
    assert cam["lens"] == track["lens"] == round(36 * FOCAL / H, 3)
    at = {f["t"]: f for f in track["frames"]}
    times = [k[0] for k in cam["location"]]
    assert times[0] == 0.0 and times[-1] == 0.4 and times == sorted(times)
    assert cam["location"] == [[t, at[t]["location"], "linear"] for t in times]
    assert cam["target"] == [[t, at[t]["target"], "linear"] for t in times]
    # frame 4 rolls 12 degrees: roll keys, at the same times, the frames' own sign
    assert cam["roll"] == [[t, at[t]["roll"], "linear"] for t in times]
    assert {k[0]: k[1] for k in cam["roll"]}[0.4] == 12.0
    assert set(cam) == {"lens", "location", "target", "roll"}
    for f in track["frames"]:
        assert list(f) == ["t", "location", "target", "up", "roll", "registered"]
        assert all(round(c, 4) == c for c in f["location"] + f["target"])
        assert all(round(c, 6) == c for c in f["up"])
        assert not any(c == 0 and math.copysign(1, c) < 0
                       for c in f["location"] + f["target"] + f["up"] + [f["roll"]])
    # 0.1 mm positions cost well under a pixel at this 0.4 m tabletop
    assert _max_miss(track) < 0.5
