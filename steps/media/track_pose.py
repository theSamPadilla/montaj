#!/usr/bin/env python3
"""Hand landmarks through a video, on onnxruntime: 21 per hand per frame, in
source pixels and in metres.

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

kind "body" is a later task and is refused for now.
"""
import argparse
import json
import os
import sys

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib.common import fail, require_file

KINDS = ("hand", "body")
SMOOTH_MODES = ("one-euro", "none")
DEFAULT_PAD = 0.3333
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

NOTES = [
    "landmarks: 0 wrist; thumb 1-4 (CMC, MCP, IP, tip); index 5-8, middle 9-12, ring 13-16, "
    "pinky 17-20 (MCP, PIP, DIP, tip).",
    "landmarks are source pixels, x right and y down, and may fall outside the frame for a hand "
    "cut by its edge; z is depth relative to the wrist on the same scale as x, negative toward "
    "the camera.",
    "world is metres around the hand's centre, x and y along the frame's axes, z depth.",
    "handedness is as the hand appears in the video; a mirrored video swaps it.",
]


def _parse(argv=None):
    p = argparse.ArgumentParser(description="Hand landmarks through a video, on onnxruntime")
    p.add_argument("--input", required=True, help="Absolute path of the video")
    p.add_argument("--kind", required=True, choices=KINDS, help="hand (body is not available yet)")
    p.add_argument("--fps", type=float, default=None,
                   help="Frames per second to sample (default: the video's, at most 30)")
    p.add_argument("--hands", type=int, default=1, help="Most hands per frame, 1 or 2 (default 1)")
    p.add_argument("--pad", type=float, default=DEFAULT_PAD,
                   help="Black border for the palm detector, as a fraction of the long side (default 0.3333)")
    p.add_argument("--min-presence", type=float, default=0.5,
                   help="Lowest score at which a hand or palm counts as found (default 0.5)")
    p.add_argument("--smooth", default="one-euro", choices=SMOOTH_MODES, help="one-euro (default) or none")
    p.add_argument("--min-cutoff", type=float, default=DEFAULT_MIN_CUTOFF,
                   help="One Euro cutoff in Hz for a still hand (default 1.0)")
    p.add_argument("--beta", type=float, default=DEFAULT_BETA,
                   help="One Euro: how fast the cutoff rises with the hand's speed (default 5.0)")
    p.add_argument("--out", default=None, help="Write the JSON here and print the path")
    return p.parse_args(argv)


def _check(args):
    if args.kind == "body":
        fail("unsupported_kind", "track_pose kind 'body' is not available yet; use kind 'hand'.")
    if args.hands not in (1, 2):
        fail("invalid_args", f"--hands is 1 or 2, got {args.hands}")
    if args.fps is not None and not args.fps > 0:
        fail("invalid_args", f"--fps must be above 0, got {args.fps}")
    if not 0 <= args.pad <= 1:
        fail("invalid_args", f"--pad is a fraction of the long side from 0 to 1, got {args.pad}")
    if not 0 < args.min_presence < 1:
        fail("invalid_args", f"--min-presence must be between 0 and 1, got {args.min_presence}")
    if not args.min_cutoff > 0 or args.beta < 0:
        fail("invalid_args", "--min-cutoff must be above 0 and --beta 0 or more")


def track_hands(frames, fps, tracker):
    """[(t, [Hand])] for every frame, landmarks raw."""
    return [(i / fps, tracker(img)) for i, img in enumerate(frames)]


def label_hands(per_frame):
    """{id: "left" | "right"} from the mean right-hand score of each id's frames."""
    sums = {}
    for _, hands in per_frame:
        for h in hands:
            s, n = sums.get(h.id, (0.0, 0))
            sums[h.id] = (s + h.right, n + 1)
    return {i: ("right" if s / n > 0.5 else "left") for i, (s, n) in sums.items()}


def smooth_hands(per_frame, min_cutoff, beta):
    """The same frames with each id's landmarks and world landmarks through a
    One Euro filter of their own."""
    from lib.pose.one_euro import OneEuro, extent
    filters = {}
    out = []
    for t, hands in per_frame:
        kept = []
        for h in hands:
            if h.id not in filters:
                filters[h.id] = (OneEuro(min_cutoff, beta), OneEuro(min_cutoff, beta))
            f_lm, f_world = filters[h.id]
            kept.append(h._replace(landmarks=f_lm(t, h.landmarks, extent(h.landmarks)),
                                   world=f_world(t, h.world, extent(h.world))))
        out.append((t, kept))
    return out


def _round(rows, places):
    return [[round(float(v), places) for v in row] for row in rows]


def result(per_frame, labels, fps, size, model):
    frames = [{
        "t": round(t, 4),
        "hands": [{
            "id": h.id,
            "handedness": labels[h.id],
            "score": round(h.score, 3),
            "landmarks": _round(h.landmarks, 2),
            "world": _round(h.world, 4),
        } for h in hands],
    } for t, hands in per_frame]
    return {
        "kind": "hand",
        "fps": round(fps, 4),
        "frameCount": len(frames),
        "size": list(size),
        "found": sum(1 for f in frames if f["hands"]),
        "frames": frames,
        "model": model,
        "notes": NOTES,
    }


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

    from lib.pose import hands as hands_lib, weights
    from lib.pose.video import MAX_DEFAULT_FPS, frames, video_info

    width, height, rate = video_info(args.input)
    fps = args.fps if args.fps is not None else min(rate, MAX_DEFAULT_FPS)
    try:
        palm_path, hand_path = weights.hand_models()
    except ValueError as e:
        fail("model_conversion_failed", f"The hand models could not be prepared: {e}")
    # OMP_NUM_THREADS, when set, caps onnxruntime's threads as it does numpy's.
    threads = os.environ.get("OMP_NUM_THREADS", "")
    palm_model, hand_model = hands_lib.onnx_models(palm_path, hand_path,
                                                   threads=int(threads) if threads.isdigit() else 0)
    tracker = hands_lib.HandTracker(palm_model, hand_model, max_hands=args.hands,
                                    min_presence=args.min_presence,
                                    pad=round(args.pad * max(width, height)))

    per_frame = track_hands(frames(args.input, fps, width, height), fps, tracker)
    labels = label_hands(per_frame)
    if args.smooth == "one-euro":
        per_frame = smooth_hands(per_frame, args.min_cutoff, args.beta)
    model = {
        "palm": weights.PALM.filename,
        "landmarks": weights.HAND_LANDMARKS.filename,
        "source": f"MediaPipe {weights.HAND_BUNDLE.name} (Apache-2.0), converted to ONNX",
        "runtime": f"onnxruntime {onnxruntime.__version__}",
    }
    out = result(per_frame, labels, fps, (width, height), model)
    text = json.dumps(out, separators=(",", ":"))
    if args.out:
        path = os.path.abspath(os.path.expanduser(args.out))
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            f.write(text)
        print(path)
    else:
        print(text)


if __name__ == "__main__":
    main()
