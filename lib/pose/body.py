"""Body landmarks through a video: MediaPipe's pose detector and pose landmark
model (BlazePose GHUM, the full model), converted to ONNX (weights.py,
tflite.py), on onnxruntime with their tracking loop, in numpy only.

Licence notice. The detector decoding and the crop are ported from OpenCV
Zoo's mediapipe demos (https://github.com/opencv/opencv_zoo, Apache License
2.0), through regions.py. The anchors, the alignment-points region, the
heatmap refinement, the landmark decoding and the tracking loop follow
MediaPipe's PoseDetectorGraph, PoseLandmarksDetectorGraph and
PoseLandmarkerGraph and their calculators (SsdAnchorsCalculator,
TensorsToDetectionsCalculator, NonMaxSuppressionCalculator,
AlignmentPointsRectsCalculator, RectTransformationCalculator,
TensorsToLandmarksCalculator, RefineLandmarksFromHeatmapCalculator,
LandmarkProjectionCalculator, WorldLandmarkProjectionCalculator), as of tag
v1.1.1 (50505c8312c7eacb1bd411cecdc4cc9fd08d53cb) of
https://github.com/google-ai-edge/mediapipe, Copyright The MediaPipe Authors,
Apache License 2.0. Changed for Montaj: rewritten for numpy and onnxruntime
with no OpenCV; the segmentation mask and the reference's own landmark
smoothing are left out (track_pose smooths with its own One Euro filter). A
copy of the licence is at http://www.apache.org/licenses/LICENSE-2.0.

The loop, per frame (one person, as the model is made for):
  - With no person tracked, the pose detector runs on the frame letterboxed to
    224 (with a black border of `pad` px on every side, 0 by default). Its
    best find gives four keypoints; the first two (the hips' centre and a
    point a body's half-height away) set the region: centred on the first, a
    square twice the distance between them, rotated so the second is straight
    above the first, then grown 1.25 times.
  - The region is cropped to 256 and the landmark model gives 39 landmarks
    (33 body ones, then the same two alignment points and four unused),
    their visibility and presence, a heatmap that sharpens the landmarks
    (refine_from_heatmap), a pose presence score and world landmarks.
  - A pose under min_presence is lost and the detector looks again on the
    next frame. One at or over it is tracked into the next frame with the
    region its own two alignment points give, by the same rule.

Coordinates are source pixels throughout.
"""
import math
from collections import namedtuple

import numpy as np

from lib.pose.regions import (Rect, crop_matrix, crop_to_source, decode_detections, detection_to_source,
                              letterbox_rect, rotate_world, ssd_anchors, transform_rect, upright_rotation, warp)

DETECTOR_SIZE = 224
LANDMARK_SIZE = 256
# The detector's anchors: a 28x28 grid (stride 8) with 2 a cell, a 14x14 grid
# (stride 16) with 2, then a 7x7 grid (stride 32, three layers merged) with 6.
DETECTOR_LAYERS = ((8, 2), (16, 2), (32, 6))
# The detector reads -1..1, the landmark model 0..1 (the models' metadata).
DETECTOR_RANGE = (-1.0, 1.0)
LANDMARK_RANGE = (0.0, 1.0)
# Outside the frame the detector's letterbox reads black, but the landmark
# crop repeats the frame's edge pixels, as the reference's crops do (its pose
# detector sets BORDER_ZERO; the landmark crop keeps ImageToTensorCalculator's
# default, which replicates). Matched on purpose: measured on a 540x960 clip of a golfer filmed whole, with the
# detector on every frame (45 frames), a black landmark crop lands 0.6 px
# (median) from the reference and z 4 to 50 px off wherever the region leaves
# the frame; edge pixels land 0.003 px from it.
LANDMARK_BORDER = "replicate"
# Detector boxes overlapping more than this are merged, weighted by score:
# PoseDetectorGraphOptions' default, which the pose landmarker keeps (the hand
# detector sets 0.3).
DETECTOR_NMS_IOU = 0.5
# The alignment-points region is grown this much on each side.
ROI_SCALE = 1.25
# The landmark model: 33 body landmarks, then the alignment points (the hips'
# centre and the point setting the region's size and rotation), then 4 unused.
BODY_LANDMARKS = 33
CENTRE, SCALE_POINT = 33, 34
# Heatmap refinement: a 7x7 window around each landmark's heatmap cell; a
# landmark moves to the window's confidence-weighted centre when its peak
# confidence is at least 0.5.
HEATMAP_KERNEL = 7
HEATMAP_MIN_CONFIDENCE = 0.5

Person = namedtuple("Person", "id score landmarks visibility world")   # landmarks (33, 3) px, world (33, 3) m


def pose_anchors():
    """The pose detector's 2254 anchor centres, in output order."""
    return ssd_anchors(DETECTOR_SIZE, DETECTOR_LAYERS)


def alignment_rect(centre, scale_point):
    """The region two alignment points give: centred on `centre`, a square
    twice the distance to `scale_point`, rotated so `scale_point` is straight
    above `centre`, then grown ROI_SCALE times."""
    (x0, y0), (x1, y1) = centre[:2], scale_point[:2]
    side = 2 * math.hypot(x1 - x0, y1 - y0)
    rect = Rect(float(x0), float(y0), side, side, upright_rotation(x0, y0, x1, y1))
    return transform_rect(rect, 0.0, ROI_SCALE)


def detect_pose(detector, image, threshold, anchors, pad=0):
    """The best person the detector finds in a frame (a Detection in source
    px, keypoints (4, 2)), or None."""
    h, w = image.shape[:2]
    view = letterbox_rect(w, h, pad)
    tensor = warp(image, crop_matrix(view, DETECTOR_SIZE), DETECTOR_SIZE, DETECTOR_RANGE)
    raw_boxes, raw_scores = detector(tensor[None])
    found = decode_detections(raw_boxes, raw_scores, anchors, DETECTOR_SIZE, threshold, 1, DETECTOR_NMS_IOU)
    return detection_to_source(found[0], view) if found else None


def refine_from_heatmap(xy, heatmap):
    """Landmarks ((n, 2), normalized to the crop) moved to the confidence-
    weighted centre of a HEATMAP_KERNEL window of their heatmap channel
    ((rows, cols, n) logits), where the window's peak confidence is at least
    HEATMAP_MIN_CONFIDENCE, as RefineLandmarksFromHeatmapCalculator does. Two
    quirks of the reference are kept on purpose: the cell is the landmark's
    position truncated toward zero, so a landmark up to one cell left of or
    above the crop still refines, and the weighted centre is a cell index with
    no half-cell added."""
    hm = np.asarray(heatmap, np.float64)
    rows, cols, n = hm.shape
    out = np.array(xy, np.float64)
    half = (HEATMAP_KERNEL - 1) // 2
    for k in range(n):
        col, row = int(out[k, 0] * cols), int(out[k, 1] * rows)
        if col < 0 or col >= cols or row < 0 or row >= rows:
            continue
        r0, r1 = max(0, row - half), min(rows, row + half + 1)
        c0, c1 = max(0, col - half), min(cols, col + half + 1)
        conf = 1.0 / (1.0 + np.exp(-hm[r0:r1, c0:c1, k]))
        total = conf.sum()
        if conf.max() >= HEATMAP_MIN_CONFIDENCE and total > 0:
            rr, cc = np.mgrid[r0:r1, c0:c1]
            out[k] = (cc * conf).sum() / cols / total, (rr * conf).sum() / rows / total
    return out


def decode_landmarks(raw, heatmap):
    """The landmark model's landmarks ((39 * 5,): x, y, z in crop px, then
    visibility and presence logits) as (xyz (39, 3) normalized to the crop, z
    on the scale of x; visibility (39,); presence (39,)), x and y refined by
    the heatmap ((64, 64, 39))."""
    lm = np.asarray(raw, np.float64).reshape(-1, 5)
    xyz = lm[:, :3] / LANDMARK_SIZE
    xyz[:, :2] = refine_from_heatmap(xyz[:, :2], heatmap)
    return xyz, 1.0 / (1.0 + np.exp(-lm[:, 3])), 1.0 / (1.0 + np.exp(-lm[:, 4]))


def pose_landmarks(landmark_model, image, rect):
    """(landmarks (39, 3) source px, visibility (39,), pose presence, world (39, 3) m)."""
    tensor = warp(image, crop_matrix(rect, LANDMARK_SIZE), LANDMARK_SIZE, LANDMARK_RANGE, LANDMARK_BORDER)
    # The pose presence is already a probability: the model's own last op on
    # that output is a sigmoid, and the reference thresholds it as it comes.
    raw, presence, heatmap, raw_world = landmark_model(tensor[None])
    xyz, visibility, _ = decode_landmarks(raw, heatmap)
    return crop_to_source(xyz, rect), visibility, float(np.ravel(presence)[0]), rotate_world(raw_world, rect)


class PoseTracker:
    """The tracking loop over frames in order. `detector(tensor)` returns the
    pose detector's (boxes, scores); `landmark_model(tensor)` returns
    (landmarks, presence, heatmap, world). Each call takes one RGB uint8 frame
    and returns its person, [Person] or []. A person keeps its id while it is
    tracked; one found again by the detector gets a new one."""

    def __init__(self, detector, landmark_model, min_presence=0.5, pad=0):
        self.detector = detector
        self.landmark_model = landmark_model
        self.min_presence = min_presence
        self.pad = pad
        self.anchors = pose_anchors()
        self.tracked = None      # (Rect, id) for the next frame
        self.next_id = 0
        self.detector_runs = 0

    def __call__(self, image):
        if self.tracked is not None:
            rect, person_id = self.tracked
        else:
            self.detector_runs += 1
            found = detect_pose(self.detector, image, self.min_presence, self.anchors, self.pad)
            if found is None:
                return []
            rect, person_id = alignment_rect(found.keypoints[0], found.keypoints[1]), None
        self.tracked = None
        landmarks, visibility, presence, world = pose_landmarks(self.landmark_model, image, rect)
        if not presence >= self.min_presence:        # a NaN presence is lost too
            return []
        if person_id is None:
            person_id = self.next_id
            self.next_id += 1
        # Non-finite landmarks are returned for the caller to report, but never
        # tracked: their region would be NaN, so the detector looks again.
        if np.isfinite(landmarks[[CENTRE, SCALE_POINT], :2]).all():
            self.tracked = (alignment_rect(landmarks[CENTRE], landmarks[SCALE_POINT]), person_id)
        n = BODY_LANDMARKS
        return [Person(person_id, presence, landmarks[:n], visibility[:n], world[:n])]


def onnx_models(detector_path, landmark_path, threads=0):
    """The two models on onnxruntime's CPU provider, as the callables
    PoseTracker takes. threads 0 is onnxruntime's default (every core)."""
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    opts.intra_op_num_threads = opts.inter_op_num_threads = threads
    det = ort.InferenceSession(detector_path, opts, providers=["CPUExecutionProvider"])
    lmk = ort.InferenceSession(landmark_path, opts, providers=["CPUExecutionProvider"])
    det_in, lmk_in = det.get_inputs()[0].name, lmk.get_inputs()[0].name
    # Outputs by name: the detector's Identity is the boxes, Identity_1 the
    # scores; the landmark model's Identity the landmarks, Identity_1 the pose
    # presence, Identity_3 the heatmap, Identity_4 world (Identity_2, the
    # segmentation mask, is not converted).
    det_out = ["Identity", "Identity_1"]
    lmk_out = ["Identity", "Identity_1", "Identity_3", "Identity_4"]

    def detector(tensor):
        boxes, scores = det.run(det_out, {det_in: tensor})
        return boxes[0], scores[0]

    def landmark_model(tensor):
        return tuple(o[0] for o in lmk.run(lmk_out, {lmk_in: tensor}))

    return detector, landmark_model
