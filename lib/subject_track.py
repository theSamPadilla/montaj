"""Where the moving subject of a clip is, for a crop that follows it (PL89 frame_broll). numpy only.

The background is the per-pixel median of frames from a window around the range: a subject that moves is not at
any one pixel for most of them, so the median is the room without it. A pixel is foreground where a frame differs
from that background by more than the clip's own spread; a lone pixel is dropped. Each frame's crop is the window
of `crop_w` (a fraction of the width) holding the most foreground, centred on its mass, and the path is filled
where nothing was found and lightly smoothed. A frame where most of the picture differs (a moving camera, a cut)
says nothing about a subject and counts as not found.
"""
import numpy as np

MIN_MASS = 0.002        # the least share of a frame's pixels that is a subject
MAX_COVERAGE = 0.35     # past this share the camera moved: nothing to follow
MIN_DIFF = 18.0         # grey levels (0-255) a pixel must differ by, at least
TEXT_EDGE = 60.0        # a grey-level step this sharp between neighbours is a stroke of burned-in text
TEXT_DENSITY = 0.08     # the share of a cell's pixels on such a step that reads as text (a label, a watermark)
TEXT_GRID = (9, 16)     # rows and columns of the still-text map


def foreground(frames, bg_frames):
    """Boolean masks (n, h, w): where each frame differs from the background, lone pixels dropped."""
    bg = np.median(np.asarray(bg_frames, dtype=np.float32), axis=0)
    diff = np.abs(np.asarray(frames, dtype=np.float32) - bg)
    thr = max(MIN_DIFF, 3.0 * float(np.median(diff)) + 8.0)
    m = diff > thr
    # a pixel stays when at least 4 of the 3x3 around it (itself included) are foreground
    p = np.pad(m, ((0, 0), (1, 1), (1, 1))).astype(np.uint8)
    h, w = m.shape[1:]
    count = sum(p[:, dy:dy + h, dx:dx + w] for dy in range(3) for dx in range(3))
    return m & (count >= 4)


def track(frames, bg_frames, crop_w):
    """{found, cluttered, capture, points: [{x, box}]}: per frame the crop's left edge `x` (a fraction of the width,
    0 to 1 - crop_w) and the subject's box [x, y, w, h] in fractions (None where none was found)."""
    masks = foreground(frames, bg_frames)
    n, h, w = masks.shape
    cw = max(1, min(w, int(round(crop_w * w))))
    centers, boxes, captures, los, his = [], [], [], [], []
    found = cluttered = 0
    for m in masks:
        mass = int(m.sum())
        if mass > MAX_COVERAGE * h * w:
            cluttered += 1
            centers.append(None)
            boxes.append(None)
            continue
        if mass < max(4, MIN_MASS * h * w):
            centers.append(None)
            boxes.append(None)
            continue
        col = m.sum(axis=0).astype(np.float64)
        sums = np.convolve(col, np.ones(cw), mode="valid")
        x0 = int(np.argmax(sums))
        inside = col[x0:x0 + cw]
        cx = (x0 + float((np.arange(cw) * inside).sum() / max(inside.sum(), 1))) / w
        ys, xs = np.nonzero(m[:, x0:x0 + cw])
        bx0, bx1 = np.percentile(xs, [5, 95]) + x0
        by0, by1 = np.percentile(ys, [5, 95])
        boxes.append([bx0 / w, by0 / h, (bx1 - bx0 + 1) / w, (by1 - by0 + 1) / h])
        # how wide the motion is across the WHOLE frame, not just inside the crop (run 5: action wider than a crop)
        _, all_x = np.nonzero(m)
        lo, hi = np.percentile(all_x, [5, 95])
        los.append(lo / w)
        his.append((hi + 1) / w)
        centers.append(cx)
        captures.append(float(sums[x0] / mass))
        found += 1
    xs = _filled(centers)
    if xs is not None and len(xs) >= 3:
        xs = np.convolve(np.pad(xs, 1, mode="edge"), np.ones(3) / 3, mode="valid")
    points = [{"x": float(min(max(c - crop_w / 2, 0.0), 1.0 - crop_w)) if xs is not None else None, "box": b}
              for c, b in zip(xs if xs is not None else [None] * n, boxes)]
    span = [float(np.percentile(los, 10)), float(np.percentile(his, 90))] if los else None
    return {"found": found, "cluttered": cluttered, "capture": float(np.mean(captures)) if captures else 0.0,
            "points": points, "span": span}


def static_text(bg_frames, grid=TEXT_GRID):
    """A map (rows x cols of booleans) of the still background's cells dense with sharp strokes: burned-in text, a
    watermark, a logo. Read from the per-pixel median of `bg_frames` (the room without its moving subject), so a subject
    is never text here."""
    bg = np.median(np.asarray(bg_frames, dtype=np.float32), axis=0)
    h, w = bg.shape
    edge = np.zeros((h, w), dtype=bool)
    edge[:, 1:] |= np.abs(np.diff(bg, axis=1)) > TEXT_EDGE
    edge[1:, :] |= np.abs(np.diff(bg, axis=0)) > TEXT_EDGE
    rows, cols = grid
    out = []
    for r in range(rows):
        y0, y1 = r * h // rows, max(r * h // rows + 1, (r + 1) * h // rows)
        row = []
        for c in range(cols):
            x0, x1 = c * w // cols, max(c * w // cols + 1, (c + 1) * w // cols)
            row.append(bool(edge[y0:y1, x0:x1].mean() > TEXT_DENSITY))
        out.append(row)
    return out


def _filled(values):
    """The values with each gap filled by straight lines between its neighbours (held at the ends), or None."""
    known = [i for i, v in enumerate(values) if v is not None]
    if not known:
        return None
    return np.interp(np.arange(len(values)), known, [values[i] for i in known])
