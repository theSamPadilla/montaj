"""lib/pose/body.py on synthetic data: the pose detector's anchors and
decoding, the letterbox back to source pixels, the alignment-points region,
the landmark decoding with its heatmap refinement, the crop's edge pixels and
the tracking loop.
"""
import math

import pytest

np = pytest.importorskip("numpy")

from lib.pose import body as B
from lib.pose import regions as R


# --- anchors ---------------------------------------------------------------

@pytest.mark.parametrize("index, xy", [
    (0, (0.5 / 28, 0.5 / 28)), (1, (0.5 / 28, 0.5 / 28)), (2, (1.5 / 28, 0.5 / 28)), (56, (0.5 / 28, 1.5 / 28)),
    (1567, (27.5 / 28, 27.5 / 28)), (1568, (0.5 / 14, 0.5 / 14)), (1570, (1.5 / 14, 0.5 / 14)),
    (1959, (13.5 / 14, 13.5 / 14)), (1960, (0.5 / 7, 0.5 / 7)), (1965, (0.5 / 7, 0.5 / 7)),
    (1966, (1.5 / 7, 0.5 / 7)), (2253, (6.5 / 7, 6.5 / 7)),
])
def test_anchors_are_three_grids_in_output_order(index, xy):
    a = B.pose_anchors()
    assert a.shape == (2254, 2)
    assert a[index] == pytest.approx(xy, abs=1e-7)


# --- the detector ----------------------------------------------------------

def _raw(found):
    """Detector outputs with one entry per (anchor index, score logit, box
    (dx, dy, w, h) and 4 keypoint offsets in input px); the rest score -50."""
    boxes = np.zeros((2254, 12), np.float32)
    scores = np.full((2254, 1), -50.0, np.float32)
    for k, logit, box, kps in found:
        boxes[k, :4] = box
        boxes[k, 4:] = np.asarray(kps, np.float32).ravel()
        scores[k, 0] = logit
    return boxes, scores


def test_decode_offsets_a_box_and_four_keypoints_from_their_anchor():
    a = B.pose_anchors()
    kps = [(4, -8), (0, -60), (2, -40), (0, -80)]
    boxes, scores = _raw([(1000, 2.0, (11.2, -22.4, 44.8, 89.6), kps)])
    [d] = R.decode_detections(boxes, scores, a, 224, 0.5, 1, B.DETECTOR_NMS_IOU)
    cx, cy = a[1000] + np.array([11.2, -22.4]) / 224
    assert d.box == pytest.approx([cx - 0.1, cy - 0.2, cx + 0.1, cy + 0.2], abs=1e-6)
    assert d.keypoints.shape == (4, 2)
    assert d.keypoints == pytest.approx(a[1000] + np.array(kps) / 224, abs=1e-6)
    assert d.score == pytest.approx(1 / (1 + math.exp(-2.0)))


def test_boxes_merge_only_past_half_overlap():
    a = B.pose_anchors()
    # Two anchors of one cell (the same centre): boxes 40 and 56 wide overlap
    # by IoU 0.51, so they merge; 40 and 64 (IoU 0.39) stay apart, though the
    # hand detector's 0.3 would merge them.
    near = [(1000, 2.0, (0, 0, 40, 40), [(0, 0)] * 4), (1001, 1.0, (0, 0, 56, 56), [(0, 0)] * 4)]
    far = [(1000, 2.0, (0, 0, 40, 40), [(0, 0)] * 4), (1001, 1.0, (0, 0, 64, 64), [(0, 0)] * 4)]
    [merged] = R.decode_detections(*_raw(near), a, 224, 0.5, 5, B.DETECTOR_NMS_IOU)
    s1, s2 = 1 / (1 + math.exp(-2.0)), 1 / (1 + math.exp(-1.0))
    assert merged.box[2] - merged.box[0] == pytest.approx((40 * s1 + 56 * s2) / (s1 + s2) / 224, abs=1e-6)
    assert len(R.decode_detections(*_raw(far), a, 224, 0.5, 5, B.DETECTOR_NMS_IOU)) == 2


def test_a_box_with_no_area_still_stands_for_itself():
    a = B.pose_anchors()
    [d] = R.decode_detections(*_raw([(1000, 2.0, (0, 0, 0, 0), [(1, 2)] * 4)]), a, 224, 0.5, 1, 0.5)
    assert np.isfinite(d.box).all() and np.isfinite(d.keypoints).all()


class _Detector:
    """Returns one detection, given in the 224 input, normalized."""

    def __init__(self, box, kps, logit=3.0):
        self.box, self.kps, self.logit = box, kps, logit
        self.tensors = []

    def __call__(self, tensor):
        self.tensors.append(tensor)
        k = 1000
        anchor = B.pose_anchors()[k]
        boxes = np.zeros((2254, 12), np.float32)
        scores = np.full((2254, 1), -50.0, np.float32)
        (x0, y0, x1, y1) = self.box
        boxes[k, :4] = (((x0 + x1) / 2 - anchor[0]) * 224, ((y0 + y1) / 2 - anchor[1]) * 224,
                        (x1 - x0) * 224, (y1 - y0) * 224)
        boxes[k, 4:] = ((np.asarray(self.kps) - anchor) * 224).ravel()
        scores[k, 0] = self.logit
        return boxes, scores


def test_a_detection_is_taken_out_of_the_letterbox():
    # 540x960: the detector sees a 960 square (with a 100 px border, 1160)
    # centred on the frame, so its x runs from -210 (-310) in source px.
    kps = [(0.5, 0.5), (0.5, 0.25), (0.5, 0.2), (0.5, 0.1)]
    for pad, side in ((0, 960), (100, 1160)):
        det = B.detect_pose(_Detector((0.25, 0.25, 0.75, 0.75), kps), np.zeros((960, 540, 3), np.uint8),
                            0.5, B.pose_anchors(), pad)
        x0, y0 = 270 - side / 2, 480 - side / 2
        assert det.box == pytest.approx([x0 + side / 4, y0 + side / 4, x0 + 3 * side / 4, y0 + 3 * side / 4], abs=1e-3)
        assert det.keypoints[0] == pytest.approx([270, 480], abs=1e-3)
        assert det.keypoints[1] == pytest.approx([270, 480 - side / 4], abs=1e-3)


def test_the_detector_reads_minus_one_to_one_and_black_outside_the_frame():
    det = _Detector((0.4, 0.4, 0.6, 0.6), [(0.5, 0.5)] * 4)
    B.detect_pose(det, np.full((960, 540, 3), 255, np.uint8), 0.5, B.pose_anchors())
    [t] = det.tensors
    assert t.shape == (1, 224, 224, 3)
    assert t[0, 112, 112] == pytest.approx([1, 1, 1])        # white inside
    assert t[0, 112, 5] == pytest.approx([-1, -1, -1])       # the letterbox, black


def test_no_detection_over_the_threshold_is_none():
    det = _Detector((0.4, 0.4, 0.6, 0.6), [(0.5, 0.5)] * 4, logit=-1.0)    # 0.27
    assert B.detect_pose(det, np.zeros((960, 540, 3), np.uint8), 0.5, B.pose_anchors()) is None


# --- the region ------------------------------------------------------------

def test_the_alignment_region_of_an_upright_body():
    r = B.alignment_rect((300.0, 500.0), (300.0, 380.0))
    assert (r.cx, r.cy) == pytest.approx((300, 500))
    assert r.rotation == pytest.approx(0, abs=1e-12)
    assert (r.w, r.h) == pytest.approx((2 * 120 * 1.25, 2 * 120 * 1.25))


@pytest.mark.parametrize("angle", [0.4, -1.3, 2.9])
def test_the_alignment_region_turns_so_the_scale_point_is_up(angle):
    centre = np.array([250.0, 600.0])
    d = 90.0
    # The scale point, `angle` clockwise on screen from straight above.
    point = centre + d * np.array([math.sin(angle), -math.cos(angle)])
    r = B.alignment_rect(centre, point)
    assert R.normalize_radians(r.rotation - angle) == pytest.approx(0, abs=1e-9)
    # In the 256 crop the centre is the middle and the scale point straight above it.
    m = R.crop_matrix(r, 256)
    above = 128 - 256 * d / r.h
    assert m @ [128, 128, 1] == pytest.approx(centre)
    assert m @ [128, above, 1] == pytest.approx(point)


# --- landmarks -------------------------------------------------------------

def _heatmap(peaks, n=39, logit=8.0):
    """A 64x64xn heatmap of logit -8 with each landmark's peak a 3x3 blob."""
    hm = np.full((64, 64, n), -8.0)
    for k, (row, col) in peaks.items():
        hm[max(0, row - 1):row + 2, max(0, col - 1):col + 2, k] = logit
    return hm


def test_refinement_moves_a_landmark_to_its_peak_as_a_cell_index():
    hm = _heatmap({0: (20, 30)})
    out = B.refine_from_heatmap(np.array([[30.9 / 64, 21.5 / 64]] + [[0.5, 0.5]] * 38), hm)
    # The blob's centre is cell (30, 20), with no half cell added.
    assert out[0] == pytest.approx([30 / 64, 20 / 64], abs=1e-4)


def test_refinement_needs_a_confident_peak_in_the_window():
    xy = np.array([[30.5 / 64, 20.5 / 64]] + [[0.5, 0.5]] * 38)
    assert np.array_equal(B.refine_from_heatmap(xy, _heatmap({0: (20, 30)}, logit=-0.1)), xy)   # peak 0.48
    assert np.array_equal(B.refine_from_heatmap(xy, _heatmap({0: (20, 38)})), xy)              # outside the 7x7


def test_refinement_keeps_the_references_edge_quirks():
    # Up to a cell left of the crop still refines (the cell truncates to 0).
    left = B.refine_from_heatmap(np.array([[-0.5 / 64, 10.5 / 64]] * 39), _heatmap({0: (10, 1)}))
    assert left[0] == pytest.approx([1 / 64, 10 / 64], abs=1e-4)
    # A cell left of that does not.
    xy = np.array([[-1.5 / 64, 10.5 / 64]] * 39)
    assert np.array_equal(B.refine_from_heatmap(xy, _heatmap({0: (10, 1)})), xy)
    # Below the crop does not either, though the heatmap's last rows are confident.
    xy = np.array([[10.5 / 64, 64.5 / 64]] * 39)
    assert np.array_equal(B.refine_from_heatmap(xy, _heatmap({0: (63, 10)})), xy)


def test_landmark_decoding():
    raw = np.zeros((39, 5))
    raw[:, 0], raw[:, 1], raw[:, 2] = 64.0, 192.0, -25.6
    raw[:, 3], raw[:, 4] = 2.0, -1.0
    xyz, vis, pres = B.decode_landmarks(raw.ravel(), np.full((64, 64, 39), -8.0))
    assert xyz == pytest.approx(np.tile([0.25, 0.75, -0.1], (39, 1)))
    assert vis == pytest.approx(np.full(39, 1 / (1 + math.exp(-2.0))))
    assert pres == pytest.approx(np.full(39, 1 / (1 + math.exp(1.0))))


class _LandmarkModel:
    """Returns fixed raw landmarks (39, 5) in crop px and records its input."""

    def __init__(self, raw, presence=0.9, world=None):
        self.raw, self.presence = np.asarray(raw, np.float32), presence
        self.world = np.zeros(117, np.float32) if world is None else world
        self.tensors = []

    def __call__(self, tensor):
        self.tensors.append(tensor)
        return self.raw.ravel(), np.array([self.presence]), np.full((64, 64, 39), -8.0), self.world


def test_landmarks_land_where_the_crop_read_them():
    rect = R.Rect(260.0, 470.0, 600.0, 600.0, 0.3)
    uv = np.array([[0, 0], [128, 128], [200, 31], [17.5, 250.25]])
    raw = np.zeros((39, 5))
    raw[:4, :2] = uv
    raw[:4, 2] = [0, 25.6, -51.2, 12.8]
    world = np.zeros((39, 3))
    world[0] = (0.0, -0.5, 0.2)                       # half a metre up in the crop
    lm, vis, pres, w = B.pose_landmarks(_LandmarkModel(raw, 0.75, world.ravel()), np.zeros((960, 540, 3), np.uint8),
                                        rect)
    m = R.crop_matrix(rect, 256)
    for k, (u, v) in enumerate(uv):
        assert lm[k, :2] == pytest.approx(m @ [u, v, 1])
    assert lm[:4, 2] == pytest.approx(raw[:4, 2] / 256 * 600)
    assert pres == pytest.approx(0.75)
    assert w[0] == pytest.approx([0.5 * math.sin(0.3), -0.5 * math.cos(0.3), 0.2])


def test_the_landmark_crop_repeats_the_frames_edge():
    img = np.zeros((960, 540, 3), np.uint8)
    img[:, :270] = 100
    img[:, 270:] = 200
    model = _LandmarkModel(np.zeros((39, 5)))
    B.pose_landmarks(model, img, R.Rect(270.0, 480.0, 1080.0, 1080.0, 0.0))   # twice the frame's width
    [t] = model.tensors
    assert t[0, 128, 2] == pytest.approx([100 / 255] * 3)       # left of the frame: its left edge
    assert t[0, 128, 253] == pytest.approx([200 / 255] * 3)     # right of it: its right edge


def test_warp_reads_black_outside_by_default_and_edges_when_asked():
    img = np.full((4, 4, 3), 80, np.uint8)
    m = np.array([[1.0, 0, -2], [0, 1.0, 0]])       # output (u, v) reads source (u - 2, v)
    assert R.warp(img, m, 4)[0, 0] == pytest.approx([0, 0, 0])
    assert R.warp(img, m, 4, border="replicate")[0, 0] == pytest.approx([80 / 255] * 3)
    assert R.warp(img, m, 4, (-1.0, 1.0))[0, 0] == pytest.approx([-1, -1, -1])
    assert R.warp(img, m, 4, (-1.0, 1.0))[0, 3] == pytest.approx([80 / 127.5 - 1] * 3)


# --- the tracking loop -----------------------------------------------------

class _Script:
    """Stands in for detect_pose and pose_landmarks at the level of source px."""

    def __init__(self, detections, presence, places=()):
        self.detections = list(detections)   # per detector run: None or (centre, scale point)
        self.presence = list(presence)       # per landmark run
        self.places = list(places)           # per landmark run: None (the region's own points) or (centre, scale point)
        self.detector_calls = 0
        self.rects = []

    def detect(self, detector, image, threshold, anchors, pad=0):
        self.detector_calls += 1
        found = self.detections.pop(0) if self.detections else None
        if found is None:
            return None
        return R.Detection(np.zeros(4), np.array([found[0], found[1], (0, 0), (0, 0)], float), 0.9)

    def landmarks(self, model, image, rect):
        self.rects.append(rect)
        place = self.places.pop(0) if self.places else None
        lm = np.zeros((39, 3))
        if place is None:
            # The alignment points that give this same region back.
            half = rect.h / 2 / B.ROI_SCALE
            lm[B.CENTRE, :2] = rect.cx, rect.cy
            lm[B.SCALE_POINT, :2] = (rect.cx + half * math.sin(rect.rotation),
                                     rect.cy - half * math.cos(rect.rotation))
        else:
            lm[B.CENTRE, :2], lm[B.SCALE_POINT, :2] = place
        return lm, np.full(39, 0.8), self.presence.pop(0), np.zeros((39, 3))


@pytest.fixture
def script(monkeypatch):
    def make(detections, presence, places=()):
        s = _Script(detections, presence, places)
        monkeypatch.setattr(B, "detect_pose", s.detect)
        monkeypatch.setattr(B, "pose_landmarks", s.landmarks)
        return s
    return make


FRAME = np.zeros((960, 540, 3), np.uint8)


def test_a_tracked_person_skips_the_detector_and_a_lost_one_brings_it_back(script):
    s = script(detections=[((270, 600), (270, 400)), ((260, 600), (260, 420))], presence=[0.9, 0.8, 0.3, 0.9])
    t = B.PoseTracker(None, None, min_presence=0.5)
    ids = [[p.id for p in t(FRAME)] for _ in range(4)]
    # Found, tracked (no detector), lost (presence 0.3), found again with a new id.
    assert ids == [[0], [0], [], [1]]
    assert s.detector_calls == t.detector_runs == 2
    assert tuple(s.rects[0]) == pytest.approx(tuple(B.alignment_rect((270, 600), (270, 400))))
    assert tuple(s.rects[3]) == pytest.approx(tuple(B.alignment_rect((260, 600), (260, 420))))


def test_the_next_region_comes_from_this_frames_alignment_points(script):
    s = script(detections=[((270, 600), (270, 400))], presence=[0.9, 0.9],
               places=[((280, 610), (300, 420)), None])
    t = B.PoseTracker(None, None)
    t(FRAME)
    t(FRAME)
    assert tuple(s.rects[1]) == pytest.approx(tuple(B.alignment_rect((280, 610), (300, 420))))


def test_no_detection_means_the_detector_runs_every_frame(script):
    s = script(detections=[None, None, None], presence=[])
    t = B.PoseTracker(None, None)
    assert [t(FRAME) for _ in range(3)] == [[], [], []]
    assert s.detector_calls == 3


def test_a_nan_presence_is_lost(script):
    s = script(detections=[((270, 600), (270, 400))] * 2, presence=[float("nan"), 0.9])
    t = B.PoseTracker(None, None)
    assert t(FRAME) == []
    assert [p.id for p in t(FRAME)] == [0]
    assert s.detector_calls == 2


def test_non_finite_alignment_points_are_returned_but_not_tracked(script):
    s = script(detections=[((270, 600), (270, 400))] * 2, presence=[0.9, 0.9],
               places=[((float("nan"), 600), (270, 400)), None])
    t = B.PoseTracker(None, None)
    assert [p.id for p in t(FRAME)] == [0]
    assert [p.id for p in t(FRAME)] == [1]
    assert s.detector_calls == 2


def test_a_person_has_33_landmarks_with_visibility_and_world(script):
    script(detections=[((270, 600), (270, 400))], presence=[0.9])
    [p] = B.PoseTracker(None, None)(FRAME)
    assert p.landmarks.shape == (33, 3) and p.visibility.shape == (33,) and p.world.shape == (33, 3)
    assert p.score == pytest.approx(0.9)
