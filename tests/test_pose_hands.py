"""lib/pose/hands.py and lib/pose/one_euro.py on synthetic data: the palm
detector's anchors and decoding, the hand regions, the crop, the landmark
projection, the tracking loop and the One Euro filter.

The reference values for the anchors are OpenCV Zoo's table for the same
detector (palm_detection_mediapipe), indices 0 to 2015.
"""
import math

import pytest

np = pytest.importorskip("numpy")

from lib.pose import hands as H
from lib.pose.one_euro import OneEuro, extent


# --- anchors ---------------------------------------------------------------

@pytest.mark.parametrize("index, xy", [
    (0, (0.02083333, 0.02083333)), (1, (0.02083333, 0.02083333)), (2, (0.0625, 0.02083333)),
    (48, (0.02083333, 0.0625)), (1151, (0.9791667, 0.9791667)), (1152, (0.04166667, 0.04166667)),
    (1158, (0.125, 0.04166667)), (1224, (0.04166667, 0.125)), (2015, (0.9583333, 0.9583333)),
])
def test_anchors_match_the_reference_table(index, xy):
    a = H.palm_anchors()
    assert a.shape == (2016, 2)
    assert a[index] == pytest.approx(xy, abs=1e-7)


# --- palm decoding ---------------------------------------------------------

def _raw(anchors, palms):
    """Detector outputs with one entry per (anchor index, score logit, box
    deltas (dx, dy, w, h) and keypoint deltas in input px); the rest score -50."""
    boxes = np.zeros((2016, 18), np.float32)
    scores = np.full((2016, 1), -50.0, np.float32)
    for k, logit, delta, kps in palms:
        boxes[k, :4] = delta
        boxes[k, 4:] = np.asarray(kps, np.float32).ravel()
        scores[k, 0] = logit
    return boxes, scores


def test_decode_offsets_a_box_and_keypoints_from_their_anchor():
    a = H.palm_anchors()
    kps = [(i, -i) for i in range(7)]
    boxes, scores = _raw(a, [(500, 3.0, (9.6, -19.2, 38.4, 19.2), kps)])
    [palm] = H.decode_palms(boxes, scores, a, 0.5, 2)
    cx, cy = a[500] + np.array([9.6, -19.2]) / 192
    assert palm.box == pytest.approx([cx - 0.1, cy - 0.05, cx + 0.1, cy + 0.05], abs=1e-6)
    assert palm.keypoints == pytest.approx(a[500] + np.array(kps) / 192, abs=1e-6)
    assert palm.score == pytest.approx(1 / (1 + math.exp(-3.0)))


def test_decode_drops_palms_under_the_threshold():
    a = H.palm_anchors()
    boxes, scores = _raw(a, [(500, -0.5, (0, 0, 20, 20), [(0, 0)] * 7)])   # sigmoid 0.38
    assert H.decode_palms(boxes, scores, a, 0.4, 2) == []
    assert len(H.decode_palms(boxes, scores, a, 0.35, 2)) == 1


def test_decode_merges_overlapping_boxes_weighted_by_score_and_keeps_the_top_score():
    a = H.palm_anchors()
    # Two anchors of one cell (identical centres), boxes 40 and 48 wide: IoU 0.69.
    # A third box far away stays separate.
    boxes, scores = _raw(a, [(600, 2.0, (0, 0, 40, 40), [(4, 4)] * 7),
                             (601, 1.0, (0, 0, 48, 48), [(-4, -4)] * 7),
                             (100, 0.0, (0, 0, 40, 40), [(0, 0)] * 7)])
    palms = H.decode_palms(boxes, scores, a, 0.4, 5)
    assert len(palms) == 2
    s1, s2 = 1 / (1 + math.exp(-2.0)), 1 / (1 + math.exp(-1.0))
    w = (40 * s1 + 48 * s2) / (s1 + s2) / 192
    top = palms[0]
    assert top.score == pytest.approx(s1)
    assert top.box[2] - top.box[0] == pytest.approx(w, abs=1e-6)
    kp = (4 * s1 - 4 * s2) / (s1 + s2) / 192
    assert top.keypoints[0] == pytest.approx(a[600] + kp, abs=1e-6)
    assert palms[1].score == pytest.approx(0.5)
    assert len(H.decode_palms(boxes, scores, a, 0.4, 1)) == 1


# --- the letterbox and the border ------------------------------------------

def test_a_palm_in_the_bordered_letterbox_maps_back_to_source_pixels():
    # A 540x960 frame with a 320 px border is 1180x1600, letterboxed in 1600.
    view = H.letterbox_rect(540, 960, 320)
    assert (view.cx, view.cy, view.w, view.h) == (270, 480, 1600, 1600)
    corner = ((0 + 530) / 1600, (0 + 320) / 1600)   # the frame's own top-left pixel
    palm = H.Palm(np.array([0.5, 0.5, corner[0], corner[1]]), np.array([corner] * 7), 0.9)
    out = H.palm_to_source(palm, view)
    assert out.box == pytest.approx([270, 480, 0, 0])
    assert out.keypoints == pytest.approx(np.zeros((7, 2)))


def test_the_letterbox_crop_samples_the_frame_inside_a_black_border():
    img = np.full((96, 54, 3), 200, np.uint8)
    t = H.warp(img, H.crop_matrix(H.letterbox_rect(54, 96, 32), 16), 16)
    # 160 px of view in 16: the frame (54 wide) spans the middle 5.4 px of each row.
    assert t[8, 8] == pytest.approx([200 / 255] * 3)
    assert t[8, 0] == pytest.approx([0, 0, 0])
    assert t[0, 8] == pytest.approx([0, 0, 0])


# --- regions ---------------------------------------------------------------

def _upright_hand(cx=300.0, cy=500.0, s=1.0):
    """21 landmarks of an upright hand (fingers up), wrist at the bottom."""
    lm = np.zeros((21, 3))
    lm[0] = (0, 60, 0)                                     # wrist
    lm[1:5] = [(25, 45, 0), (35, 30, 0), (42, 15, 0), (48, 0, 0)]    # thumb
    for f, x in enumerate((15, 0, -15, -30)):              # index, middle, ring, pinky
        base = 5 + 4 * f
        lm[base:base + 4] = [(x, -20 - 22 * j, 0) for j in range(4)]
    lm[:, :2] = lm[:, :2] * s + (cx, cy)
    return lm


def _turn(points, angle, about):
    c, s = math.cos(angle), math.sin(angle)
    p = np.asarray(points, float).copy()
    d = p[:, :2] - about
    p[:, 0] = about[0] + c * d[:, 0] - s * d[:, 1]
    p[:, 1] = about[1] + s * d[:, 0] + c * d[:, 1]
    return p


def test_landmarks_region_of_an_upright_hand():
    lm = _upright_hand()
    r = H.landmarks_rect(lm)
    # Rotation from the wrist to ((index + ring bases) / 2 + middle base) / 2:
    # straight up, so 0. The palm landmarks span x -30..42, y -42..60 (102 px
    # high, the long side), centre (306, 509); moved 10.2 px up, side 204.
    assert r.rotation == pytest.approx(0, abs=1e-12)
    assert (r.cx, r.cy) == pytest.approx((306, 498.8))
    assert (r.w, r.h) == pytest.approx((204, 204))


@pytest.mark.parametrize("angle", [0.3, -1.2, 2.5])
def test_landmarks_region_turns_with_the_hand(angle):
    about = np.array([280.0, 520.0])
    base = H.landmarks_rect(_upright_hand())
    r = H.landmarks_rect(_turn(_upright_hand(), angle, about))
    centre = _turn([[base.cx, base.cy]], angle, about)[0]
    assert H.normalize_radians(r.rotation - angle) == pytest.approx(0, abs=1e-9)
    assert (r.cx, r.cy) == pytest.approx(tuple(centre[:2]))
    assert r.w == pytest.approx(base.w)


def test_palm_region_uses_the_90_radian_target():
    # Wrist below, middle base straight above: upright would be rotation 0;
    # a 90 radian target turns it by 90 - 14 * 2pi - pi/2 = 0.4646 rad.
    kps = np.array([[100, 200], [0, 0], [100, 100], [0, 0], [0, 0], [0, 0], [0, 0]], float)
    palm = H.Palm(np.array([50.0, 100.0, 150.0, 220.0]), kps, 0.9)
    r = H.palm_rect(palm)
    rot = H.normalize_radians(90.0 - math.pi / 2)
    assert r.rotation == pytest.approx(rot)
    assert rot == pytest.approx(0.4646, abs=1e-4)
    # Moved half its height (120) along its own up axis, squared on the long side, x2.6.
    assert r.cx == pytest.approx(100 + 60 * math.sin(rot))
    assert r.cy == pytest.approx(160 - 60 * math.cos(rot))
    assert r.w == r.h == pytest.approx(120 * 2.6)


def test_rect_iou_ignores_rotation():
    a = H.Rect(0, 0, 10, 10, 0.0)
    assert H.rect_iou(a, a._replace(rotation=1.0)) == pytest.approx(1)
    assert H.rect_iou(a, H.Rect(5, 0, 10, 10, 0)) == pytest.approx(50 / 150)
    assert H.rect_iou(a, H.Rect(20, 0, 10, 10, 0)) == 0


# --- crop and projection ---------------------------------------------------

def test_the_crop_maps_the_region_corners_to_pixels_0_and_n():
    r = H.Rect(50, 40, 20, 20, 0.0)
    m = H.crop_matrix(r, 10)
    assert m @ [0, 0, 1] == pytest.approx([40, 30])
    assert m @ [10, 10, 1] == pytest.approx([60, 50])


def test_a_quarter_turn_crop_is_the_patch_turned():
    rng = np.random.default_rng(3)
    img = rng.integers(0, 256, (40, 40, 3), dtype=np.uint8)
    # A region of 8 px over 8 output px: one source pixel per output pixel.
    straight = H.warp(img, H.crop_matrix(H.Rect(20, 20, 8, 8, 0.0), 8), 8)
    assert straight == pytest.approx(img[16:24, 16:24] / 255)
    turned = H.warp(img, H.crop_matrix(H.Rect(20, 20, 8, 8, math.pi / 2), 8), 8)
    # Rotation pi/2 reads the crop's "up" from the source's right: output (u, v)
    # is source (24 - v, 16 + u), the patch turned a quarter counterclockwise.
    assert turned == pytest.approx(np.rot90(img[16:24, 17:25]) / 255)


def test_the_crop_rounds_like_the_fixed_point_warp():
    # Halfway between 0 and 1 is 0.5: rounded half up to 1, never to the even 0.
    img = np.array([[[0] * 3, [1] * 3]], np.uint8)
    t = H.warp(img, np.array([[1.0, 0, 0.5], [0, 1.0, 0]]), 1)
    assert t[0, 0, 0] * 255 == pytest.approx(1)
    # Positions snap to 1/32 px: 0.51 px reads as 16/32.
    img = np.array([[[0] * 3, [64] * 3]], np.uint8)
    t = H.warp(img, np.array([[1.0, 0, 0.51], [0, 1.0, 0]]), 1)
    assert t[0, 0, 0] * 255 == pytest.approx(32)


def test_projected_landmarks_land_where_the_crop_read_them():
    r = H.Rect(310.0, 480.0, 250.0, 250.0, 0.7)
    m = H.crop_matrix(r, H.HAND_SIZE)
    uv = np.array([[0, 0], [112, 112], [200, 30], [17.5, 190.25]])
    raw = np.zeros((21, 3))
    raw[:4, :2] = uv
    raw[:4, 2] = [0, 10, -20, 5]
    lm = H.project_landmarks(raw.ravel(), r)
    for k, (u, v) in enumerate(uv):
        assert lm[k, :2] == pytest.approx(m @ [u, v, 1])
    # z on the scale of x: the model's z is 0.4 of its x scale.
    assert lm[:4, 2] == pytest.approx(raw[:4, 2] / 224 / 0.4 * 250)


def test_world_landmarks_turn_back_by_the_crop_rotation():
    raw = np.zeros((21, 3))
    raw[0] = (0.0, -0.05, 0.01)      # 5 cm up in the crop
    w = H.rotate_world(raw.ravel(), H.Rect(0, 0, 1, 1, math.pi / 2))
    assert w[0] == pytest.approx([0.05, 0.0, 0.01])   # up in a pi/2 crop is right in the frame


# --- the tracking loop -----------------------------------------------------

class _Script:
    """Stands in for the two models at the level of source pixels."""

    def __init__(self, palms, presence, places=()):
        self.palms = list(palms)        # per detector run: [(cx, cy)]
        self.presence = list(presence)  # per landmark run
        self.places = list(places)      # per landmark run: None (the region's centre) or (cx, cy)
        self.detector_calls = 0

    def detect(self, palm_model, image, pad, threshold, max_count, anchors):
        self.detector_calls += 1
        found = self.palms.pop(0) if self.palms else []
        return [H.Palm(np.array([x - 40, y - 40, x + 40, y + 40.0]),
                       np.array([[x, y + 30], [0, 0], [x, y - 30], [0, 0], [0, 0], [0, 0], [0, 0]], float), 0.9)
                for x, y in found]

    def landmarks(self, hand_model, image, rect):
        # An upright hand centred in the region, so its next region stays put,
        # or centred where `places` says.
        place = self.places.pop(0) if self.places else None
        if place == "nan":
            return np.full((21, 3), np.nan), self.presence.pop(0), 0.2, np.zeros((21, 3))
        cx, cy = place or (rect.cx, rect.cy)
        lm = _upright_hand(cx, cy, rect.w / 204)
        lm[:, :2] -= np.array(H.landmarks_rect(lm)[:2]) - (cx, cy)
        return lm, self.presence.pop(0), 0.2, np.zeros((21, 3))


@pytest.fixture
def script(monkeypatch):
    def make(palms, presence, places=()):
        s = _Script(palms, presence, places)
        monkeypatch.setattr(H, "detect_palms", s.detect)
        monkeypatch.setattr(H, "hand_landmarks", s.landmarks)
        return s
    return make


FRAME = np.zeros((960, 540, 3), np.uint8)


def test_a_tracked_hand_skips_the_detector_and_a_lost_one_brings_it_back(script):
    s = script(palms=[[(270, 480)], [(270, 480)]], presence=[0.9, 0.8, 0.3, 0.9])
    t = H.HandTracker(None, None, max_hands=1, min_presence=0.5)
    ids = [[h.id for h in t(FRAME)] for _ in range(4)]
    # Found by the detector, tracked once (no detector), lost (presence 0.3),
    # found again by the detector with a new id.
    assert ids == [[0], [0], [], [1]]
    assert s.detector_calls == t.detector_runs == 2


def test_no_palm_means_the_detector_runs_every_frame(script):
    s = script(palms=[[], [], []], presence=[])
    t = H.HandTracker(None, None, max_hands=1)
    assert [t(FRAME) for _ in range(3)] == [[], [], []]
    assert s.detector_calls == 3


def test_with_room_for_two_a_palm_on_a_tracked_hand_is_that_hand(script):
    s = script(palms=[[(150, 300)], [(150, 300), (420, 800)], [(150, 300), (420, 800)]],
               presence=[0.9] * 5)
    t = H.HandTracker(None, None, max_hands=2)
    ids = [[h.id for h in t(FRAME)] for _ in range(3)]
    # Frame 2: the palm at (150, 300) overlaps hand 0's region and is dropped; the
    # other becomes hand 1. Frame 3: both tracked, so the detector does not run.
    assert ids == [[0], [0, 1], [0, 1]]
    assert s.detector_calls == 2


def test_two_palms_on_one_hand_are_one_hand(script):
    script(palms=[[(270, 480), (280, 490)]], presence=[0.9, 0.9])
    t = H.HandTracker(None, None, max_hands=2)
    # The second palm's region overlaps the first's (IoU over 0.5): dropped
    # when it is detected.
    assert [h.id for h in t(FRAME)] == [0]


def test_two_tracked_hands_that_slide_onto_one_keep_the_first(script):
    # Frame 1 finds two hands far apart. In frame 2 the second one's landmarks
    # land on the first hand: its next region would overlap, so it is dropped.
    script(palms=[[(150, 300), (420, 800)]], presence=[0.9] * 4,
           places=[None, None, None, (160, 290)])
    t = H.HandTracker(None, None, max_hands=2)
    assert [h.id for h in t(FRAME)] == [0, 1]
    assert [h.id for h in t(FRAME)] == [0]


def test_a_hand_with_nan_landmarks_is_returned_but_not_tracked(script):
    s = script(palms=[[(270, 480)]] * 3, presence=[0.9, float("nan"), 0.9], places=["nan", None, None])
    t = H.HandTracker(None, None, max_hands=1)
    first = t(FRAME)
    # Returned for the step to report, but its region would be NaN: not tracked.
    assert [h.id for h in first] == [0] and np.isnan(first[0].landmarks).all()
    assert t.tracked == []
    # A NaN presence is lost too.
    assert t(FRAME) == [] and s.detector_calls == 2
    assert [h.id for h in t(FRAME)] == [1] and s.detector_calls == 3


# --- One Euro --------------------------------------------------------------

def test_one_euro_keeps_a_constant():
    f = OneEuro(1.0, 5.0)
    for t in range(10):
        out = f(t / 10, np.array([3.0, -2.0]))
    assert out == pytest.approx([3.0, -2.0])


def test_one_euro_without_beta_is_an_exponential_smoother():
    f = OneEuro(1.0, 0.0)
    f(0.0, np.array([0.0]))
    a = 1 / (1 + (1 / (2 * math.pi)) / 0.1)        # cutoff 1 Hz at 10 Hz
    assert f(0.1, np.array([10.0])) == pytest.approx([10 * a])
    assert f(0.2, np.array([10.0])) == pytest.approx([10 * a + a * (10 - 10 * a)])


def test_one_euro_follows_faster_with_beta():
    def after(beta):
        f = OneEuro(1.0, beta)
        for k in range(5):
            out = f(k / 10, np.array([float(20 * k)]), 50.0)
        return out[0]
    assert after(0.0) < after(5.0) < 80
    assert after(5.0) > 60


def test_one_euro_speed_is_in_object_sizes():
    a, b = OneEuro(1.0, 5.0), OneEuro(1.0, 5.0)
    for k in range(6):
        x = np.array([float(7 * k * k)])
        ra, rb = a(k / 10, x, 40.0), b(k / 10, x * 3, 120.0)
    assert rb == pytest.approx(ra * 3)


def test_one_euro_ignores_a_repeated_time():
    f = OneEuro(1.0, 5.0)
    f(0.0, np.array([0.0]))
    first = f(0.1, np.array([10.0])).copy()
    assert f(0.1, np.array([50.0])) == pytest.approx(first)


def test_extent_is_the_mean_of_the_two_spans():
    assert extent([[0, 0, 5], [40, 10, -5]]) == pytest.approx(25)
