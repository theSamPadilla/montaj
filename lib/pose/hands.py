"""Hand landmarks through a video: MediaPipe's palm detector and hand landmark
models, converted to ONNX (weights.py, tflite.py), on onnxruntime with their
tracking loop, in numpy only.

Licence notice. The palm decoding, the hand crop and the landmark projection
are ported from OpenCV Zoo's palm_detection_mediapipe and
handpose_estimation_mediapipe demos (https://github.com/opencv/opencv_zoo,
Apache License 2.0). The anchors, the weighted non-maximum suppression, the
palm-to-region and landmarks-to-region rules and the tracking loop follow
MediaPipe's hand tracking graph and calculators
(https://github.com/google-ai-edge/mediapipe, Copyright The MediaPipe Authors,
Apache License 2.0). Changed for Montaj: rewritten for numpy and onnxruntime
with no OpenCV; the demos' crop and box rules replaced by MediaPipe's own; the
tracking loop and the black border added. A copy of the licence is at
http://www.apache.org/licenses/LICENSE-2.0.

The loop, per frame:
  - Hands tracked from the last frame keep the region their landmarks gave.
  - While fewer than max_hands are tracked, the palm detector runs on the
    frame with a black border of `pad` px on every side, letterboxed to 192.
    A palm whose region overlaps a tracked hand's (IoU over ASSOCIATION_IOU)
    is that hand and is dropped.
  - Each region is cropped (rotated so the fingers point up; a palm's region
    26.6 degrees past that, see PALM_TARGET_ANGLE) to 224 and the landmark
    model gives 21 landmarks, presence, handedness and world
    landmarks. A hand under min_presence is lost; one at or over it is
    tracked into the next frame with the region its landmarks give.

Coordinates are source pixels throughout. The border is not drawn: every crop
reads black outside the frame, which is what a bordered frame holds there, so
the border only shrinks the frame in the palm detector's view (a close hand
that fills the frame is found far more often with it).

Crops sample exactly as the reference's warp does: the region's corners
map to the output's pixel 0 and pixel n, positions are rounded to 1/32 px, the
bilinear weights are fixed point out of 2^15, and the result is rounded to 8
bits before scaling to 0..1. Measured on a close phone clip of a hand gripping
an object, at 10 fps: from the reference's own previous-frame landmarks, the
next frame's landmarks land 0.014 px mean from the reference's (0.23 max, 61
frames); with float sampling, 0.125 (1.2 max).
"""
import math
from collections import namedtuple

import numpy as np

PALM_SIZE = 192
HAND_SIZE = 224

# Palm boxes overlapping more than this are merged, weighted by score.
PALM_NMS_IOU = 0.3
# A palm region becomes a hand region: rotated by the direction from the wrist
# (keypoint 0) to the middle finger's base (keypoint 2), moved half its height
# toward the fingers, squared on its long side and scaled 2.6.
PALM_SHIFT_Y, PALM_SCALE = -0.5, 2.6
# The direction's target angle is 90 RADIANS, not 90 degrees: the reference
# graph sets it so, which turns every palm region 26.6 degrees past upright.
# Matched on purpose. Measured on a close phone clip of a hand gripping an
# object, with the palm detector on every frame (75 frames at 10 fps): with 90
# radians, the same 19 hands as the reference, 0.07 px mean apart; with pi / 2,
# 15 hands, 53 px mean apart.
PALM_TARGET_ANGLE = 90.0
# The landmarks' region for the next frame: moved a tenth of its height toward
# the fingers, squared on its long side and scaled 2.
HAND_SHIFT_Y, HAND_SCALE = -0.1, 2.0
# The landmark model's z is on 0.4 times the scale of its x and y.
Z_SCALE = 0.4
# A detected palm whose region overlaps a tracked hand's by more than this IoU
# (axis-aligned, rotation ignored) is that hand.
ASSOCIATION_IOU = 0.5

# The landmarks that set the next region: the wrist and the palm's joints
# (thumb 1-3, and each finger's base and first joint), not the fingertips,
# which move the most. Positions 4, 6 and 8 here are the index, middle and
# ring finger bases (landmarks 5, 9, 13).
_ROI_LANDMARKS = [0, 1, 2, 3, 5, 6, 9, 10, 13, 14, 17, 18]

# A region in source px: centre, size, and rotation in radians (clockwise on
# screen, y down) that turns the hand upright.
Rect = namedtuple("Rect", "cx cy w h rotation")
Palm = namedtuple("Palm", "box keypoints score")              # box (x0, y0, x1, y1), keypoints (7, 2)
Hand = namedtuple("Hand", "id score right landmarks world")   # right: the model's right-hand score


def palm_anchors():
    """The palm detector's 2016 anchor centres, in output order: a 24x24 grid
    (stride 8) with 2 anchors a cell, then a 12x12 grid (stride 16, three layers
    merged) with 6. Every anchor is 1x1, so only the centres matter."""
    out = []
    for stride, per_cell in ((8, 2), (16, 6)):
        n = math.ceil(PALM_SIZE / stride)
        ys, xs = np.mgrid[0:n, 0:n]
        centres = np.stack([(xs + 0.5) / n, (ys + 0.5) / n], axis=-1).reshape(-1, 1, 2)
        out.append(np.repeat(centres, per_cell, axis=1).reshape(-1, 2))
    return np.concatenate(out).astype(np.float32)


def normalize_radians(a):
    return a - 2 * math.pi * math.floor((a + math.pi) / (2 * math.pi))


def upright_rotation(x0, y0, x1, y1, target=math.pi / 2):
    """The rotation that turns the direction (x0, y0) -> (x1, y1) to `target`
    (radians, counterclockwise from the x axis): to point up by default."""
    return normalize_radians(target - math.atan2(-(y1 - y0), x1 - x0))


def transform_rect(rect, shift_y, scale):
    """Move the region by shift_y of its height along its own up axis, square
    it on its long side, then scale it."""
    cx = rect.cx - rect.h * shift_y * math.sin(rect.rotation)
    cy = rect.cy + rect.h * shift_y * math.cos(rect.rotation)
    side = max(rect.w, rect.h) * scale
    return Rect(cx, cy, side, side, rect.rotation)


def palm_rect(palm):
    """A detected palm's hand region."""
    x0, y0, x1, y1 = palm.box
    (wx, wy), (mx, my) = palm.keypoints[0], palm.keypoints[2]
    rotation = upright_rotation(wx, wy, mx, my, PALM_TARGET_ANGLE)
    rect = Rect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, rotation)
    return transform_rect(rect, PALM_SHIFT_Y, PALM_SCALE)


def landmarks_rect(landmarks):
    """The next frame's hand region from this frame's landmarks ((21, 2+) in
    source px), as the reference graph's landmarks-to-region step makes it:
    rotation from the wrist toward the mean of the middle finger's base and
    the midpoint of the index and ring bases; the box is the palm landmarks'
    extent in the rotated frame, around its own centre; then HAND_SHIFT_Y and
    HAND_SCALE. Given the reference's landmarks, the region it gives crops
    the next frame as the reference did (the one-step figure above)."""
    p = np.asarray(landmarks, dtype=np.float64)[_ROI_LANDMARKS, :2]
    target = ((p[4] + p[8]) / 2 + p[6]) / 2
    rotation = upright_rotation(p[0][0], p[0][1], target[0], target[1])
    centre = (p.min(axis=0) + p.max(axis=0)) / 2
    back = normalize_radians(-rotation)
    d = p - centre
    q = np.stack([d[:, 0] * math.cos(back) - d[:, 1] * math.sin(back),
                  d[:, 0] * math.sin(back) + d[:, 1] * math.cos(back)], axis=1)
    lo, hi = q.min(axis=0), q.max(axis=0)
    mid = (lo + hi) / 2
    cx = mid[0] * math.cos(rotation) - mid[1] * math.sin(rotation) + centre[0]
    cy = mid[0] * math.sin(rotation) + mid[1] * math.cos(rotation) + centre[1]
    w, h = hi - lo
    return transform_rect(Rect(cx, cy, w, h, rotation), HAND_SHIFT_Y, HAND_SCALE)


def rect_iou(a, b):
    """IoU of two regions as axis-aligned boxes (rotation ignored)."""
    ix = min(a.cx + a.w / 2, b.cx + b.w / 2) - max(a.cx - a.w / 2, b.cx - b.w / 2)
    iy = min(a.cy + a.h / 2, b.cy + b.h / 2) - max(a.cy - a.h / 2, b.cy - b.h / 2)
    if ix <= 0 or iy <= 0:
        return 0.0
    inter = ix * iy
    union = a.w * a.h + b.w * b.h - inter
    return inter / union if union > 0 else 0.0


def crop_matrix(rect, n):
    """2x3 map from output pixel (u, v, 1) of an n x n crop to source px. The
    region's corners land on output pixels 0 and n."""
    c, s = math.cos(rect.rotation), math.sin(rect.rotation)
    kx, ky = rect.w / n, rect.h / n
    return np.array([
        [c * kx, -s * ky, rect.cx - c * rect.w / 2 + s * rect.h / 2],
        [s * kx, c * ky, rect.cy - s * rect.w / 2 - c * rect.h / 2],
    ])


def letterbox_rect(width, height, pad):
    """The palm detector's view: the frame with `pad` px of black on every side,
    centred in a square of its long side."""
    side = max(width, height) + 2 * pad
    return Rect(width / 2, height / 2, side, side, 0.0)


def warp(image, matrix, n):
    """Bilinear sample of `image` (H x W x 3 uint8) into an n x n x 3 float32
    tensor in 0..1; output pixel (u, v) reads `matrix` @ (u, v, 1). Black outside
    the image."""
    h, w = image.shape[:2]
    u = np.arange(n, dtype=np.float64)
    uu, vv = np.meshgrid(u, u)
    # Fixed point, reproducing the reference's warp: positions rounded to 1/32 px,
    # bilinear weights as integers out of 2^15, the sum rounded half up to 8 bits.
    x = np.rint((matrix[0, 0] * uu + matrix[0, 1] * vv + matrix[0, 2]) * 32).astype(np.int64)
    y = np.rint((matrix[1, 0] * uu + matrix[1, 1] * vv + matrix[1, 2]) * 32).astype(np.int64)
    x0, y0 = x >> 5, y >> 5
    tx, ty = (x & 31)[..., None], (y & 31)[..., None]

    def tap(yi, xi):
        inside = ((xi >= 0) & (xi < w) & (yi >= 0) & (yi < h))[..., None]
        return image[np.clip(yi, 0, h - 1), np.clip(xi, 0, w - 1)].astype(np.int64) * inside

    acc = ((32 - tx) * (32 - ty) * tap(y0, x0) + tx * (32 - ty) * tap(y0, x0 + 1)
           + (32 - tx) * ty * tap(y0 + 1, x0) + tx * ty * tap(y0 + 1, x0 + 1)) * 32
    return (((acc + (1 << 14)) >> 15) / 255.0).astype(np.float32)


def _box_iou(box, boxes):
    ix = np.minimum(box[2], boxes[:, 2]) - np.maximum(box[0], boxes[:, 0])
    iy = np.minimum(box[3], boxes[:, 3]) - np.maximum(box[1], boxes[:, 1])
    inter = np.where((ix > 0) & (iy > 0), ix * iy, 0.0)
    area = (box[2] - box[0]) * (box[3] - box[1])
    areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    union = area + areas - inter
    return np.where(union > 0, inter / np.where(union > 0, union, 1), 0.0)


def decode_palms(raw_boxes, raw_scores, anchors, threshold, max_count):
    """The palm detector's outputs ((2016, 18) and (2016, 1)) as palms in the
    192 px input, normalized 0..1: sigmoid scores at or over `threshold`, boxes
    and 7 keypoints offset from their anchors, merged by weighted non-maximum
    suppression (each kept palm is the score-weighted mean of the boxes it
    overlaps, with the top score), at most `max_count`, best first."""
    scores = 1.0 / (1.0 + np.exp(-np.clip(np.asarray(raw_scores, np.float64).reshape(-1), -100, 100)))
    keep = np.nonzero(scores >= threshold)[0]
    if keep.size == 0:
        return []
    raw = np.asarray(raw_boxes, np.float64).reshape(-1, 18)[keep] / PALM_SIZE
    a = np.asarray(anchors, np.float64)[keep]
    centre = raw[:, 0:2] + a
    half = raw[:, 2:4] / 2
    boxes = np.concatenate([centre - half, centre + half], axis=1)
    keypoints = raw[:, 4:18].reshape(-1, 7, 2) + a[:, None, :]
    scores = scores[keep]

    order = np.argsort(-scores, kind="stable")
    palms = []
    while order.size and len(palms) < max_count:
        overlap = _box_iou(boxes[order[0]], boxes[order]) > PALM_NMS_IOU
        group = order[overlap]
        wts = scores[group][:, None]
        box = (boxes[group] * wts).sum(axis=0) / wts.sum()
        kps = (keypoints[group] * wts[:, :, None]).sum(axis=0) / wts.sum()
        palms.append(Palm(box, kps, float(scores[order[0]])))
        order = order[~overlap]
    return palms


def detect_palms(palm_model, image, pad, threshold, max_count, anchors):
    """Palms in a frame, in source px, best first."""
    h, w = image.shape[:2]
    view = letterbox_rect(w, h, pad)
    tensor = warp(image, crop_matrix(view, PALM_SIZE), PALM_SIZE)
    raw_boxes, raw_scores = palm_model(tensor[None])
    palms = decode_palms(raw_boxes, raw_scores, anchors, threshold, max_count)
    return [palm_to_source(p, view) for p in palms]


def palm_to_source(palm, view):
    """A palm normalized to the detector's input, in source px. `view` is the
    letterboxed, bordered frame the detector saw (letterbox_rect)."""
    x0 = view.cx - view.w / 2
    y0 = view.cy - view.h / 2
    box = np.array([x0 + palm.box[0] * view.w, y0 + palm.box[1] * view.h,
                    x0 + palm.box[2] * view.w, y0 + palm.box[3] * view.h])
    kps = np.stack([x0 + palm.keypoints[:, 0] * view.w, y0 + palm.keypoints[:, 1] * view.h], axis=1)
    return Palm(box, kps, palm.score)


def project_landmarks(raw, rect):
    """The landmark model's 21 landmarks ((63,) in the 224 crop: x, y in px, z
    relative to the wrist) to source px: x, y through the crop's rotation, z on
    the same scale as x."""
    lm = np.asarray(raw, np.float64).reshape(21, 3) / HAND_SIZE
    lx, ly = (lm[:, 0] - 0.5) * rect.w, (lm[:, 1] - 0.5) * rect.h
    c, s = math.cos(rect.rotation), math.sin(rect.rotation)
    return np.stack([rect.cx + c * lx - s * ly, rect.cy + s * lx + c * ly, lm[:, 2] / Z_SCALE * rect.w], axis=1)


def rotate_world(raw, rect):
    """World landmarks ((63,) in metres, the crop's axes) turned back by the
    crop's rotation, so x and y follow the source frame's axes."""
    wl = np.asarray(raw, np.float64).reshape(21, 3)
    c, s = math.cos(rect.rotation), math.sin(rect.rotation)
    return np.stack([c * wl[:, 0] - s * wl[:, 1], s * wl[:, 0] + c * wl[:, 1], wl[:, 2]], axis=1)


def hand_landmarks(hand_model, image, rect):
    """(landmarks (21, 3) source px, presence, right-hand score, world (21, 3) m)."""
    tensor = warp(image, crop_matrix(rect, HAND_SIZE), HAND_SIZE)
    raw_lm, presence, right, raw_world = hand_model(tensor[None])
    return (project_landmarks(raw_lm, rect), float(np.ravel(presence)[0]),
            float(np.ravel(right)[0]), rotate_world(raw_world, rect))


class HandTracker:
    """The tracking loop over frames in order. `palm_model(tensor)` returns the
    detector's (boxes, scores); `hand_model(tensor)` returns (landmarks,
    presence, handedness, world). Each call takes one RGB uint8 frame and
    returns its hands (Hand), tracked ones first. A hand keeps its id while it
    is tracked; a hand found again by the detector gets a new one."""

    def __init__(self, palm_model, hand_model, max_hands=1, min_presence=0.5, pad=0):
        self.palm_model = palm_model
        self.hand_model = hand_model
        self.max_hands = max_hands
        self.min_presence = min_presence
        self.pad = pad
        self.anchors = palm_anchors()
        self.tracked = []      # [(Rect, id)] for the next frame
        self.next_id = 0
        self.detector_runs = 0

    def __call__(self, image):
        regions = list(self.tracked)
        if len(regions) < self.max_hands:
            self.detector_runs += 1
            palms = detect_palms(self.palm_model, image, self.pad, self.min_presence, self.max_hands, self.anchors)
            for palm in palms:
                rect = palm_rect(palm)
                if all(rect_iou(rect, r) <= ASSOCIATION_IOU for r, _ in regions):
                    regions.append((rect, None))
        hands, tracked = [], []
        for rect, hand_id in regions[:self.max_hands]:
            landmarks, presence, right, world = hand_landmarks(self.hand_model, image, rect)
            if not presence >= self.min_presence:        # a NaN presence is lost too
                continue
            # Non-finite landmarks are returned for the caller to report, but never
            # tracked: their region would be NaN, so the detector looks again.
            finite = bool(np.isfinite(landmarks).all())
            next_rect = landmarks_rect(landmarks) if finite else None
            # Two regions that have slid onto one hand: keep the first.
            if finite and any(rect_iou(next_rect, r) > ASSOCIATION_IOU for r, _ in tracked):
                continue
            if hand_id is None:
                hand_id = self.next_id
                self.next_id += 1
            hands.append(Hand(hand_id, presence, right, landmarks, world))
            if finite:
                tracked.append((next_rect, hand_id))
        self.tracked = tracked
        return hands


def onnx_models(palm_path, hand_path, threads=0):
    """The two models on onnxruntime's CPU provider, as the callables
    HandTracker takes. threads 0 is onnxruntime's default (every core)."""
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    opts.intra_op_num_threads = opts.inter_op_num_threads = threads
    palm = ort.InferenceSession(palm_path, opts, providers=["CPUExecutionProvider"])
    hand = ort.InferenceSession(hand_path, opts, providers=["CPUExecutionProvider"])
    palm_in = palm.get_inputs()[0].name
    hand_in = hand.get_inputs()[0].name
    # Outputs by name: Identity is the boxes (palm) or landmarks (hand),
    # Identity_1 the scores or presence, Identity_2 the right-hand score,
    # Identity_3 world.
    palm_out = ["Identity", "Identity_1"]
    hand_out = ["Identity", "Identity_1", "Identity_2", "Identity_3"]

    def palm_model(tensor):
        boxes, scores = palm.run(palm_out, {palm_in: tensor})
        return boxes[0], scores[0]

    def hand_model(tensor):
        return tuple(o[0] for o in hand.run(hand_out, {hand_in: tensor}))

    return palm_model, hand_model
