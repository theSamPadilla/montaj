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


def _solve(drop=(), known=None, k1=0.0, truth=TRUTH, points=POINTS):
    poses, seen = _reconstruction(drop, truth, points)
    return ct.solve(poses, seen, fps=FPS, size=[W, H], focal=FOCAL, k1=k1, known=known)


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


def test_target_is_where_the_axis_meets_the_table_or_one_metre_ahead():
    track = _solve(known={"height": TRUTH_HEIGHT})
    for f in track["frames"]:
        assert f["target"][2] == pytest.approx(0, abs=1e-12)
    loc = np.array([0.0, 0.0, 0.3])
    assert ct.axis_target(loc, np.array([0.0, 1.0, 0.0])) == pytest.approx([0, 1, 0.3])
    assert ct.axis_target(loc, np.array([0.0, 0.6, 0.8])) == pytest.approx(loc + [0, 0.6, 0.8])


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
    cam = track["scene"]["camera"]
    assert cam["lens"] == track["lens"] == round(36 * FOCAL / H, 3)
    assert [k[0] for k in cam["location"]] == [0.0, 0.1, 0.2, 0.3, 0.4]
    assert cam["location"] == [[f["t"], f["location"]] for f in track["frames"]]
    assert cam["target"] == [[f["t"], f["target"]] for f in track["frames"]]
    assert set(cam) == {"lens", "location", "target"}
    for f in track["frames"]:
        assert all(round(c, 4) == c for c in f["location"] + f["target"])
        assert not any(c == 0 and math.copysign(1, c) < 0 for c in f["location"] + f["target"] + [f["roll"]])
    # 0.1 mm positions cost well under a pixel at this 0.4 m tabletop
    assert _max_miss(track) < 0.5
