#!/usr/bin/env python3
"""Hand or body landmarks through a video, on onnxruntime: 21 per hand or 33
per body per frame, in source pixels and in metres.

The models are MediaPipe's palm detector and hand landmark model, from its
pinned hand landmarker bundle, fetched on first use and converted to ONNX
(lib/pose/weights.py, lib/pose/tflite.py). The loop
(lib/pose/hands.py) tracks a hand from frame to frame with the region its
landmarks give, and runs the palm detector only while fewer than `hands` are
tracked, on the frame with a black border. Both matter on close footage: a
hand that enters from the frame edge, wrist out of shot, is found in a few
frames by detection alone and in most of them by the loop with the border.

A hand keeps its id while it is tracked. Handedness is the mean of the
model's left/right score over the id's frames, so it does not flip from frame
to frame. The One Euro filter smooths each id's landmarks and world landmarks
on their own.

kind "body" uses MediaPipe's pose detector and pose landmark model (the full
model) from its pinned pose landmarker bundle the same way, with their loop
(lib/pose/body.py): one person, found by the detector and then tracked with
the region its own landmarks give, until it is lost. Each landmark carries the
model's visibility, which is not smoothed.
"""
import argparse
import json
import math
import os
import sys

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib.common import fail, require_file

KINDS = ("hand", "body")
SMOOTH_MODES = ("one-euro", "none")
# The detector's black border, as a fraction of the long side. Hands are often
# close and cut by the frame's edge; the body detector is the reference's
# own, with none.
DEFAULT_PAD = {"hand": 0.3333, "body": 0.0}
# One Euro defaults. Measured 2026-10-16 on a close phone clip of a hand
# gripping an object: they cut the frame-to-frame jitter (mean second
# difference over all landmarks) from 31 to 21 px at 10 fps and from 23 to 10 px
# at 30 fps. On synthetic tracks with 10 px of noise and a 250 px hand, the
# error against the truth falls from 10 to 6 px for a still hand and to 7 px
# for a 300 px lift in 0.5 s, and rises to 17-18 px for a 1 Hz sway of 150 px.
# Beta 2 cuts the jitter further (17 and 7 px) but trails that sway by 25 px;
# beta 10 trails it by 13-15 px and leaves 23 and 12 px of jitter.
DEFAULT_MIN_CUTOFF = 1.0
DEFAULT_BETA = 5.0
# Frames are held in memory and every landmark goes into one JSON: 300 frames
# is 10 s at 30 fps, 30 s at 10.
DEFAULT_MAX_FRAMES = 300

HAND_NOTES = [
    "landmarks: 0 wrist; thumb 1-4 (CMC, MCP, IP, tip); index 5-8, middle 9-12, ring 13-16, "
    "pinky 17-20 (MCP, PIP, DIP, tip).",
    "landmarks are source pixels, x right and y down, and may fall outside the frame for a hand "
    "cut by its edge; z is depth relative to the wrist on the same scale as x, negative toward "
    "the camera.",
    "world is metres around the hand's centre: x right, y down, z away from the camera.",
    "handedness is as the hand appears in the video; a mirrored video swaps it.",
]

BODY_NOTES = [
    "landmarks: 0 nose; eyes 1-3 left (inner, centre, outer), 4-6 right; 7, 8 ears; 9, 10 mouth corners; "
    "11, 12 shoulders; 13, 14 elbows; 15, 16 wrists; 17, 18 pinky knuckles; 19, 20 index knuckles; "
    "21, 22 thumb knuckles; 23, 24 hips; 25, 26 knees; 27, 28 ankles; 29, 30 heels; 31, 32 foot tips. "
    "From 7 on, odd is the person's own left and even their right.",
    "landmarks are [x, y, z, visibility]: source pixels, x right and y down, and may fall outside the "
    "frame; z is depth relative to the hips' centre on the same scale as x, negative toward the camera; "
    "visibility, 0 to 1, is how likely the point is in frame and not hidden.",
    "world is metres around the hips' centre: x right, y down, z away from the camera.",
]


def _parse(argv=None):
    p = argparse.ArgumentParser(description="Hand or body landmarks through a video, on onnxruntime")
    p.add_argument("--input", required=True, help="Absolute path of the video")
    p.add_argument("--kind", required=True, choices=KINDS, help="hand or body")
    p.add_argument("--fps", type=float, default=None,
                   help="Frames per second to sample, at most the video's own (default: the video's, at most 30)")
    p.add_argument("--max-frames", type=int, default=DEFAULT_MAX_FRAMES,
                   help=f"Refuse a clip that samples to more frames (default {DEFAULT_MAX_FRAMES})")
    p.add_argument("--hands", type=int, default=1, help="hand: most hands per frame, 1 or 2 (default 1)")
    p.add_argument("--people", type=int, default=1, help="body: most people per frame, 1 for now (default 1)")
    p.add_argument("--pad", type=float, default=None,
                   help="Black border for the detector, as a fraction of the long side "
                        "(default 0.3333 for hand, 0 for body)")
    p.add_argument("--min-presence", type=float, default=0.5,
                   help="Lowest score at which a detection, hand or body counts as found (default 0.5)")
    p.add_argument("--smooth", default="one-euro", choices=SMOOTH_MODES, help="one-euro (default) or none")
    p.add_argument("--min-cutoff", type=float, default=DEFAULT_MIN_CUTOFF,
                   help="One Euro cutoff in Hz for a still hand or body (default 1.0)")
    p.add_argument("--beta", type=float, default=DEFAULT_BETA,
                   help="One Euro: how fast the cutoff rises with the speed (default 5.0)")
    p.add_argument("--out", default=None, help="Write the JSON here and print the path")
    return p.parse_args(argv)


def _check(args):
    if args.hands not in (1, 2):
        fail("invalid_param", f"--hands is 1 or 2, got {args.hands}")
    if args.people != 1:
        fail("invalid_param", f"--people is 1 for now (the body model follows one person), got {args.people}")
    if args.fps is not None and not args.fps > 0:
        fail("invalid_param", f"--fps must be above 0, got {args.fps}")
    if args.max_frames < 1:
        fail("invalid_param", f"--max-frames must be at least 1, got {args.max_frames}")
    if args.pad is None:
        args.pad = DEFAULT_PAD[args.kind]
    if not 0 <= args.pad <= 1:
        fail("invalid_param", f"--pad is a fraction of the long side from 0 to 1, got {args.pad}")
    if not 0 < args.min_presence < 1:
        fail("invalid_param", f"--min-presence must be between 0 and 1, got {args.min_presence}")
    if not args.min_cutoff > 0 or args.beta < 0:
        fail("invalid_param", "--min-cutoff must be above 0 and --beta 0 or more")


def sampling(args, info):
    """(fps, notes) for a clip's VideoInfo: the fps asked for, or the clip's
    own at most 30, never above the clip's own; refused before any decoding
    when the clip samples to more than --max-frames."""
    from lib.frame_sampling import tone_maps
    from lib.pose.video import MAX_DEFAULT_FPS
    notes = []
    fps = args.fps if args.fps is not None else min(info.rate, MAX_DEFAULT_FPS)
    if fps > info.rate + 1e-6:
        fps = info.rate
        notes.append(f"Sampled at the clip's own {fps:g} fps, not {args.fps:g}.")
    if info.duration is not None:
        expected = max(1, math.ceil(info.duration * fps - 1e-6))
        if expected > args.max_frames:
            fail("too_many_frames",
                 f"{info.duration:.1f} s at {fps:g} fps is {expected} frames, over --max-frames "
                 f"{args.max_frames}. Pass a lower --fps, a shorter clip, or a higher --max-frames.")
    if tone_maps(info.color_transfer):
        notes.append("The clip is HDR; its frames were tone-mapped to SDR for the models.")
    return fps, notes


def emit(text, out=None):
    """Print the JSON, or write it to out and print the path."""
    if not out:
        print(text)
        return
    path = os.path.abspath(os.path.expanduser(out))
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
    except OSError as e:
        fail("write_error", f"Could not write to {out}: {e}")
    print(path)


def track(frames, fps, tracker):
    """[(t, [Hand] or [Person])] for every frame, landmarks raw."""
    return [(i / fps, tracker(img)) for i, img in enumerate(frames)]


def drop_nonfinite(per_frame):
    """The frames without any hand or person holding a NaN or infinite value,
    and [{t, id}] for each one dropped. Runs before smoothing, so a bad value
    never reaches a filter, and the JSON stays strict."""
    import numpy as np
    out, dropped = [], []
    for t, found in per_frame:
        kept = []
        for h in found:
            values = [v for k, v in h._asdict().items() if k != "id"]
            if all(np.isfinite(np.asarray(v, dtype=np.float64)).all() for v in values):
                kept.append(h)
            else:
                dropped.append({"t": round(t, 4), "id": h.id})
        out.append((t, kept))
    return out, dropped


def label_hands(per_frame):
    """{id: "left" | "right"} from the mean right-hand score of each id's frames."""
    sums = {}
    for _, hands in per_frame:
        for h in hands:
            s, n = sums.get(h.id, (0.0, 0))
            sums[h.id] = (s + h.right, n + 1)
    return {i: ("right" if s / n > 0.5 else "left") for i, (s, n) in sums.items()}


def smooth(per_frame, min_cutoff, beta):
    """The same frames with each id's landmarks and world landmarks through a
    One Euro filter of their own."""
    from lib.pose.one_euro import OneEuro, extent
    filters = {}
    out = []
    for t, found in per_frame:
        kept = []
        for h in found:
            if h.id not in filters:
                filters[h.id] = (OneEuro(min_cutoff, beta), OneEuro(min_cutoff, beta))
            f_lm, f_world = filters[h.id]
            kept.append(h._replace(landmarks=f_lm(t, h.landmarks, extent(h.landmarks)),
                                   world=f_world(t, h.world, extent(h.world))))
        out.append((t, kept))
    return out


def _round(rows, places):
    return [[round(float(v), places) for v in row] for row in rows]


def _hand(h, labels):
    return {
        "id": h.id,
        "handedness": labels[h.id],
        "score": round(h.score, 3),
        "landmarks": _round(h.landmarks, 2),
        "world": _round(h.world, 4),
    }


def _person(p):
    landmarks = [[round(float(v), 2) for v in xyz] + [round(float(vis), 3)]
                 for xyz, vis in zip(p.landmarks, p.visibility)]
    return {"id": p.id, "score": round(p.score, 3), "landmarks": landmarks, "world": _round(p.world, 4)}


def result(per_frame, labels, fps, size, model, dropped=(), kind="hand", notes_before=()):
    """The step's JSON. labels is {id: handedness} for hands, unused for bodies.
    notes_before go ahead of the kind's own notes."""
    key, notes, what = ("hands", HAND_NOTES, "hands") if kind == "hand" else ("people", BODY_NOTES, "people")
    notes = list(notes_before) + notes
    frames = [{
        "t": round(t, 4),
        key: [_hand(h, labels) if kind == "hand" else _person(h) for h in found],
    } for t, found in per_frame]
    out = {
        "kind": kind,
        "fps": round(fps, 4),
        "frameCount": len(frames),
        "size": list(size),
        "found": sum(1 for f in frames if f[key]),
        "frames": frames,
        "model": model,
        "notes": notes,
    }
    if dropped:
        out["dropped"] = list(dropped)
        out["notes"] = notes + [f"{len(dropped)} {what} had non-finite values and were left out of their "
                                f"frames; dropped lists them by t and id."]
    return out


def main(argv=None):
    args = _parse(argv)
    _check(args)
    require_file(args.input)
    try:
        import numpy  # noqa: F401
        import onnxruntime
    except ImportError as e:
        fail("missing_dependency",
             f"track_pose needs onnxruntime and numpy ({e.name} is missing), which the rvm extra provides. "
             f"Install it with: pip install 'montaj[rvm]' (or: montaj install rvm)")

    from lib.pose import body as body_lib, hands as hands_lib, weights
    from lib.pose.video import frames, video_info

    info = video_info(args.input)
    width, height = info.width, info.height
    fps, notes = sampling(args, info)
    hand = args.kind == "hand"
    try:
        detector_path, landmark_path = weights.hand_models() if hand else weights.body_models()
    except weights.MirrorError as e:
        fail("invalid_model_mirror", str(e))
    except weights.ConversionMismatch as e:
        fail("model_conversion_mismatch",
             f"The {args.kind} models converted on this machine are not the pinned ones ({e}). Please report "
             f"this, with your OS and processor; deleting the models will not help.")
    except ValueError as e:
        from lib import models
        fail("model_conversion_failed",
             f"The {args.kind} models could not be prepared: {e}. Delete {models.models_dir(weights.FAMILY)} "
             f"and run track_pose again to download them afresh.")
    # OMP_NUM_THREADS, when set, caps onnxruntime's threads as it does numpy's.
    threads = os.environ.get("OMP_NUM_THREADS", "")
    threads = int(threads) if threads.isdigit() else 0
    pad = round(args.pad * max(width, height))
    if hand:
        palm_model, hand_model = hands_lib.onnx_models(detector_path, landmark_path, threads=threads)
        tracker = hands_lib.HandTracker(palm_model, hand_model, max_hands=args.hands,
                                        min_presence=args.min_presence, pad=pad)
    else:
        detector, landmark_model = body_lib.onnx_models(detector_path, landmark_path, threads=threads)
        tracker = body_lib.PoseTracker(detector, landmark_model, min_presence=args.min_presence, pad=pad)

    per_frame, dropped = drop_nonfinite(track(frames(args.input, fps, info, limit=args.max_frames), fps, tracker))
    labels = label_hands(per_frame) if hand else {}
    if args.smooth == "one-euro":
        per_frame = smooth(per_frame, args.min_cutoff, args.beta)
    if hand:
        bundle = weights.HAND_BUNDLE
        model = {"palm": weights.PALM.filename, "landmarks": weights.HAND_LANDMARKS.filename}
    else:
        bundle = weights.POSE_BUNDLE
        model = {"detector": weights.POSE_DETECTOR.filename, "landmarks": weights.POSE_LANDMARKS.filename}
    model["source"] = f"MediaPipe {bundle.name} (Apache-2.0), converted to ONNX"
    model["runtime"] = f"onnxruntime {onnxruntime.__version__}"
    out = result(per_frame, labels, fps, (width, height), model, dropped, args.kind, notes)
    emit(json.dumps(out, separators=(",", ":"), allow_nan=False), args.out)


if __name__ == "__main__":
    main()
