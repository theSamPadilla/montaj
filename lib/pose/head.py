"""The head box from the body pose model's face landmarks, and a clip's head through chosen times (snapshot `faces`).

The rule is the one the Studio Talk recipe gives an agent to measure by hand, so the two agree. BlazePose 33: 0 nose,
1-6 eyes, 7-8 ears, 9-10 mouth. The box spans the ears and the eyes across; its top is the hair, one ear-to-ear width
above the eyes; its bottom is the chin, half an ear-to-ear width below the mouth (the body landmarks have no chin).
With the ears not both visible (a profile) the width is the larger of twice the eye span and the horizontal span of the
seen landmarks (a visible ear included), and that width sets the vertical size too; one eye and no ear cannot be sized. A tenth of the width is added each side (the
ear landmarks sit mid-ear). Only landmarks at FACE_VISIBLE or above
count (the threshold steps/edit/push_in.py uses)."""
import subprocess
from statistics import median

FACE_VISIBLE = 0.5
EYES, EARS, MOUTH = (1, 2, 3, 4, 5, 6), (7, 8), (9, 10)
DECODE_WIDTH = 360     # as push_in.find_head: the model reads a small frame, boxes are scaled back to source pixels


def head_box(landmarks, visibility, frame_w, frame_h, visible=FACE_VISIBLE):
    """(x, y, w, h) floats of the head in the landmarks' own pixels, clamped to the frame; None when too few landmarks
    are seen to size it (no eye, or a profile with one eye)."""
    def seen(idx):
        return [(float(landmarks[i][0]), float(landmarks[i][1])) for i in idx if visibility[i] >= visible]
    eyes, ears, mouth = seen(EYES), seen(EARS), seen(MOUTH)
    if not eyes:
        return None
    if len(eyes) == 1 and not ears:                      # one landmark and no ear: nothing to measure a width by
        return None
    eye_x = [p[0] for p in eyes]
    xs = eye_x + [p[0] for p in ears]
    x0, x1 = min(xs), max(xs)
    both = len(ears) == 2
    width = abs(ears[0][0] - ears[1][0]) if both else max(2 * (max(eye_x) - min(eye_x)), x1 - x0)
    if not width > 0:
        return None
    if x1 - x0 < width:                                  # a profile: widen about the seen landmarks to that width
        mid = (x0 + x1) / 2
        x0, x1 = mid - width / 2, mid + width / 2
    pad = 0.1 * width                                    # the ear landmarks sit mid-ear: measured on a rendered head, the ears and hair
    x0, x1 = x0 - pad, x1 + pad                          # stood out of an unpadded box (2026-10-31)
    eye_y = sum(p[1] for p in eyes) / len(eyes)
    mouth_y = sum(p[1] for p in mouth) / len(mouth) if mouth else eye_y + 0.5 * width
    top, bottom = eye_y - width, mouth_y + 0.5 * width
    x0, x1 = max(0.0, x0), min(float(frame_w), x1)
    top, bottom = max(0.0, top), min(float(frame_h), bottom)
    if x1 <= x0 or bottom <= top:
        return None
    return (x0, top, x1 - x0, bottom - top)


def scale_box(box, k):
    """A decode-size box as source pixels: ints, top-left x, y, w, h."""
    return tuple(int(round(v * k)) for v in box)


def summarize(samples, size):
    """samples [(t, (x, y, w, h) or None)] -> the per-clip answer: at, box (median of the seen), range (their union, same x, y, w, h),
    seen 'k/n'. A clip where no face is seen has box None and a note."""
    at = [[t, *b] if b else [t, None] for t, b in samples]
    boxes = [b for _, b in samples if b]
    out = {"size": list(size), "at": at, "seen": f"{len(boxes)}/{len(samples)}"}
    if not boxes:
        return {**out, "box": None, "range": None, "note": "no face seen"}
    out["box"] = [int(round(median(b[i] for b in boxes))) for i in range(4)]
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)    # [x, y, w, h] like box: the union of the seen boxes
    out["range"] = [x0, y0, max(b[0] + b[2] for b in boxes) - x0, max(b[1] + b[3] for b in boxes) - y0]
    return out


def clip_faces(src, times):
    """One clip's head through `times` (seconds): summarize()'s answer. Never raises: a machine with no pose model, or a
    clip that does not decode, answers box None and a note."""
    try:
        import numpy as np
        from lib.common import ffmpeg_bin
        from lib.frame_sampling import input_args
        from lib.pose import body as body_lib, weights
        from lib.pose.video import video_info
        info = video_info(src)
        models = body_lib.onnx_models(*weights.body_models())
    except (Exception, SystemExit) as e:    # fail() exits; no pose model or no readable video stream
        return {"size": None, "at": [], "seen": f"0/{len(times)}", "box": None, "range": None,
                "note": f"face model or clip unavailable: {str(e)[:80] or type(e).__name__}"}
    w = DECODE_WIDTH
    h = max(2, int(round(w * info.height / info.width / 2)) * 2)
    k = info.width / w
    samples = []
    for t in times:
        box = None
        try:
            args, _ = input_args(src, info.rate, info.rate, info.color_transfer, after=f"scale={w}:{h}")
            r = subprocess.run([ffmpeg_bin(), "-v", "error", "-nostdin", "-ss", f"{max(0.0, t):.3f}", *args,
                                "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                               capture_output=True, timeout=60)
            if len(r.stdout) >= w * h * 3:
                frame = np.frombuffer(r.stdout[:w * h * 3], np.uint8).reshape(h, w, 3)
                people = body_lib.PoseTracker(*models)(frame)   # a fresh tracker: the times are not a sequence
                if people:
                    b = head_box(people[0].landmarks, people[0].visibility, w, h)
                    box = scale_box(b, k) if b else None
        except (Exception, SystemExit):
            box = None
        samples.append((t, box))
    return summarize(samples, (info.width, info.height))
