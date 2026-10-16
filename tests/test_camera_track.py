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


def _reconstruction(drop=()):
    """The truth seen by a tracker: X_r = s Q X + T, poses in that frame."""
    Q = _rot([0.3, -0.8, 0.5], 73.0)
    s, T = 3.7, np.array([1.5, -2.0, 0.7])
    points = (s * (Q @ POINTS.T)).T + T
    poses = [None if i in drop else (R @ Q.T, s * (Q @ C) + T) for i, (R, C) in enumerate(TRUTH)]
    return poses, points


def _solve(drop=(), known=None, k1=0.0):
    poses, points = _reconstruction(drop)
    return ct.solve(poses, points, fps=FPS, size=[W, H], focal=FOCAL, k1=k1, known=known)


def _camera(frame, lens):
    return {"location": frame["location"], "target": frame["target"], "roll": frame["roll"], "lens": lens}


def _max_miss(track, frames=range(len(TRUTH))):
    worst = 0.0
    for i in frames:
        want = _pixels(TRUTH[i], POINTS)
        got = ct.project_points(_camera(track["frames"][i], track["lens"]), POINTS, (W, H))
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
    assert track["plane"]["inliers"] == 225
    chosen = [c for c in track["plane"]["candidates"] if c["chosen"]]
    assert len(chosen) == 1 and max(c["inliers"] for c in track["plane"]["candidates"]) == 300
    for i, (R, C) in enumerate(TRUTH):
        assert track["frames"][i]["location"] == pytest.approx(C, abs=1e-9)


def test_axes_follow_frame_0_and_the_plane_whatever_the_reconstruction_frame():
    poses, points = _reconstruction()
    planes = ct.find_planes(points, 0.01 * 3.7 * 0.7)
    i = ct.choose_plane(planes, poses[0][1], -poses[0][0][1])
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


@pytest.mark.parametrize("up, inliers", [
    ([-1, 0, 0], 100),            # faces the smaller wall: it wins over the largest
    ([1, 0, 0], 300),             # only the 50-point wall faces it, under a quarter of 300: the largest
    ([0.3, 0.3, 0.9], 300),       # no wall faces it: the largest
])
def test_the_plane_facing_up_the_picture_wins_when_it_holds_enough_points(up, inliers):
    planes = _walls()
    assert sorted(len(p["inliers"]) for p in planes) == [50, 100, 300]
    i = ct.choose_plane(planes, np.array([0, -0.56, 0.42]), np.asarray(up, float) / np.linalg.norm(up))
    assert len(planes[i]["inliers"]) == inliers


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
    for bad in ['{"height": 0}', '{"height": "1"}', "{nope", '{"width": 1}', '{"height": 1, "t": 0}',
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
