"""Regions of interest for the pose models, in numpy only: the rotated region a
landmark model reads, its crop, the SSD detectors' anchors and decoding, and
the map from a crop back to source pixels. Shared by hands.py and body.py.

Licence notice. The detector decoding and the crop are ported from OpenCV
Zoo's palm_detection_mediapipe and handpose_estimation_mediapipe demos
(https://github.com/opencv/opencv_zoo, Apache License 2.0). The anchors, the
weighted non-maximum suppression, the region rules and the crop's sampling
follow MediaPipe's calculators (https://github.com/google-ai-edge/mediapipe,
Copyright The MediaPipe Authors, Apache License 2.0). Changed for Montaj:
rewritten for numpy with no OpenCV. A copy of the licence is at
http://www.apache.org/licenses/LICENSE-2.0.

Crops sample exactly as the reference's warp does: the region's corners map
to the output's pixel 0 and pixel n, positions are rounded to 1/32 px, the
bilinear weights are fixed point out of 2^15, and the result is rounded to 8
bits before scaling to the model's value range.
"""
import math
from collections import namedtuple

import numpy as np

# A region in source px: centre, size, and rotation in radians (clockwise on
# screen, y down) that turns its subject upright.
Rect = namedtuple("Rect", "cx cy w h rotation")
# A detector's find: box (x0, y0, x1, y1), keypoints (k, 2), score.
Detection = namedtuple("Detection", "box keypoints score")


def ssd_anchors(size, layers):
    """An SSD detector's anchor centres, in output order: for each (stride,
    anchors per cell) of `layers`, a grid of ceil(size / stride) cells a side,
    row by row, each cell's anchors together. Layers of one stride are merged
    into one entry. Every anchor is 1x1, so only the centres matter."""
    out = []
    for stride, per_cell in layers:
        n = math.ceil(size / stride)
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


def letterbox_rect(width, height, pad=0):
    """A detector's view: the frame with `pad` px of black on every side,
    centred in a square of its long side."""
    side = max(width, height) + 2 * pad
    return Rect(width / 2, height / 2, side, side, 0.0)


def warp(image, matrix, n, value_range=(0.0, 1.0), border="zero"):
    """Bilinear sample of `image` (H x W x 3 uint8) into an n x n x 3 float32
    tensor, 0..255 mapped onto `value_range`; output pixel (u, v) reads
    `matrix` @ (u, v, 1). Outside the image, border "zero" reads black (the
    range's low end) and "replicate" the nearest edge pixel."""
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
        px = image[np.clip(yi, 0, h - 1), np.clip(xi, 0, w - 1)].astype(np.int64)
        if border == "replicate":
            return px
        return px * ((xi >= 0) & (xi < w) & (yi >= 0) & (yi < h))[..., None]

    acc = ((32 - tx) * (32 - ty) * tap(y0, x0) + tx * (32 - ty) * tap(y0, x0 + 1)
           + (32 - tx) * ty * tap(y0 + 1, x0) + tx * ty * tap(y0 + 1, x0 + 1)) * 32
    lo, hi = value_range
    return (((acc + (1 << 14)) >> 15) / 255.0 * (hi - lo) + lo).astype(np.float32)


def _box_iou(box, boxes):
    ix = np.minimum(box[2], boxes[:, 2]) - np.maximum(box[0], boxes[:, 0])
    iy = np.minimum(box[3], boxes[:, 3]) - np.maximum(box[1], boxes[:, 1])
    inter = np.where((ix > 0) & (iy > 0), ix * iy, 0.0)
    area = (box[2] - box[0]) * (box[3] - box[1])
    areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    union = area + areas - inter
    return np.where(union > 0, inter / np.where(union > 0, union, 1), 0.0)


def decode_detections(raw_boxes, raw_scores, anchors, size, threshold, max_count, nms_iou):
    """An SSD detector's outputs ((anchors, 4 + 2k) and (anchors, 1)) as
    detections in its `size` px input, normalized 0..1: sigmoid scores at or
    over `threshold`, boxes (x, y, w, h) and k keypoints offset from their
    anchors, merged by weighted non-maximum suppression (each kept detection is
    the score-weighted mean of the boxes overlapping it by more than
    `nms_iou`, with the top score), at most `max_count`, best first."""
    scores = 1.0 / (1.0 + np.exp(-np.clip(np.asarray(raw_scores, np.float64).reshape(-1), -100, 100)))
    keep = np.nonzero(scores >= threshold)[0]
    if keep.size == 0:
        return []
    a = np.asarray(anchors, np.float64)
    raw = np.asarray(raw_boxes, np.float64).reshape(len(a), -1)[keep] / size
    a = a[keep]
    centre = raw[:, 0:2] + a
    half = raw[:, 2:4] / 2
    boxes = np.concatenate([centre - half, centre + half], axis=1)
    keypoints = raw[:, 4:].reshape(len(keep), -1, 2) + a[:, None, :]
    scores = scores[keep]

    order = np.argsort(-scores, kind="stable")
    found = []
    while order.size and len(found) < max_count:
        overlap = _box_iou(boxes[order[0]], boxes[order]) > nms_iou
        overlap[0] = True                   # a box with no area still stands for itself
        group = order[overlap]
        wts = scores[group][:, None]
        box = (boxes[group] * wts).sum(axis=0) / wts.sum()
        kps = (keypoints[group] * wts[:, :, None]).sum(axis=0) / wts.sum()
        found.append(Detection(box, kps, float(scores[order[0]])))
        order = order[~overlap]
    return found


def detection_to_source(det, view):
    """A detection normalized to its detector's input, in source px. `view` is
    the letterboxed (and maybe bordered) frame the detector saw."""
    x0 = view.cx - view.w / 2
    y0 = view.cy - view.h / 2
    box = np.array([x0 + det.box[0] * view.w, y0 + det.box[1] * view.h,
                    x0 + det.box[2] * view.w, y0 + det.box[3] * view.h])
    kps = np.stack([x0 + det.keypoints[:, 0] * view.w, y0 + det.keypoints[:, 1] * view.h], axis=1)
    return type(det)(box, kps, det.score)


def crop_to_source(points, rect):
    """Points normalized to a crop of `rect` ((n, 3): x, y 0..1 across the
    crop, z on the scale of x) to source px: x, y through the crop's rotation,
    z on the same scale as x."""
    p = np.asarray(points, np.float64)
    lx, ly = (p[:, 0] - 0.5) * rect.w, (p[:, 1] - 0.5) * rect.h
    c, s = math.cos(rect.rotation), math.sin(rect.rotation)
    return np.stack([rect.cx + c * lx - s * ly, rect.cy + s * lx + c * ly, p[:, 2] * rect.w], axis=1)


def rotate_world(raw, rect):
    """World landmarks ((n * 3,) in metres, the crop's axes) turned back by the
    crop's rotation, so x and y follow the source frame's axes."""
    wl = np.asarray(raw, np.float64).reshape(-1, 3)
    c, s = math.cos(rect.rotation), math.sin(rect.rotation)
    return np.stack([c * wl[:, 0] - s * wl[:, 1], s * wl[:, 0] + c * wl[:, 1], wl[:, 2]], axis=1)
