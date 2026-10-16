#!/usr/bin/env python3
"""The camera of a clip, for a 3D scene: per-frame lens, location, target and roll.

Frames are sampled at --fps (ffmpeg's fps filter rounding up, so frame k is the
frame on screen at k / fps; rotation applied, the long side at most
WORK_LONG_EDGE) into a temp dir, and pycolmap reconstructs them: SIFT features on
the CPU, one SIMPLE_RADIAL camera for every frame, sequential matching, then the
global mapper. The incremental mapper is not used: on a near-still handheld clip
(§328 P0, 75 frames) it registered 13 to 36 frames with the focal anywhere from
566 to 3,506 px, where the global mapper registered all 75 every time.

lib/camera_track.py does the rest without pycolmap: the frames that did not
register are interpolated, the world is set on the plane the clip looks at, the
scale comes from --known, and each pose becomes Montaj's camera.

pycolmap is the vision extra; it is imported lazily and a missing one fails by
name. There is no Intel Mac build of the pycolmap this needs.
"""
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import tempfile

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib.common import ffmpeg_bin, ffmpeg_error_tail, ffprobe_bin, fail, progress, require_file
from lib.normalize import probe_video

MIN_FPS, MAX_FPS = 1, 30
MIN_LENS, MAX_LENS = 8, 300          # mm, as the engine's fitCamera allows
WORK_LONG_EDGE = 1920                # frames are tracked at most this long
PRIOR_FACTOR = 0.85                  # the focal guess, x the long side, when nothing says better
FOCAL_35MM_TAG = "com.apple.quicktime.camera.focal_length.35mm_equivalent"
MATCH_OVERLAP = 15                   # each frame is matched with the next 15
JPEG_QUALITY = "2"


def _intel_mac():
    return sys.platform == "darwin" and platform.machine() == "x86_64"


def _probe(path):
    """Duration, display size, frame rate and the 35 mm-equivalent focal tag."""
    info = probe_video(path)
    if not info or not info.get("display_width"):
        fail("probe_error", f"Could not read a video stream from {path}")
    cmd = [ffprobe_bin(), "-v", "quiet", "-select_streams", "v:0",
           "-show_entries", "format=duration:format_tags:stream_tags", "-of", "json", path]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    data = json.loads(r.stdout or "{}") if r.returncode == 0 else {}
    fmt = data.get("format") or {}
    try:
        duration = float(fmt.get("duration"))
    except (TypeError, ValueError):
        fail("probe_error", f"Could not read the duration of {path}")
    tags = dict(fmt.get("tags") or {})
    for s in data.get("streams") or []:
        tags.update(s.get("tags") or {})
    f35 = None
    try:
        f35 = float(tags.get(FOCAL_35MM_TAG))
        f35 = f35 if math.isfinite(f35) and f35 > 0 else None
    except (TypeError, ValueError):
        pass
    num, den = (info.get("frame_rate") or "0/1").split("/") if "/" in (info.get("frame_rate") or "") else ("0", "1")
    rate = int(num) / int(den) if int(den) else 0
    return {"duration": duration, "size": (info["display_width"], info["display_height"]),
            "rate": rate, "f35": f35}


def _extract(path, fps, size, out_dir):
    """Frames f00000.jpg ... at fps, k at k / fps, at most WORK_LONG_EDGE long.
    Returns their [w, h]."""
    w, h = size
    k = min(1.0, WORK_LONG_EDGE / max(w, h))
    ww, hh = max(1, round(w * k)), max(1, round(h * k))
    vf = f"fps={fps:g}:round=up"
    if (ww, hh) != (w, h):
        vf += f",scale={ww}:{hh}:flags=area"
    cmd = [ffmpeg_bin(), "-v", "error", "-nostdin", "-i", path, "-vf", vf,
           "-q:v", JPEG_QUALITY, "-start_number", "0", os.path.join(out_dir, "f%05d.jpg")]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        fail("decode_failed", f"Could not read frames from {path}.{ffmpeg_error_tail(r.stderr)}")
    return ww, hh


def _reconstruct(pycolmap, frames_dir, work_dir, focal_factor):
    pycolmap.logging.minloglevel = 2
    db = os.path.join(work_dir, "frames.db")
    sparse = os.path.join(work_dir, "sparse")
    os.makedirs(sparse)
    reader = pycolmap.ImageReaderOptions()
    reader.camera_model = "SIMPLE_RADIAL"
    reader.default_focal_length_factor = focal_factor
    progress("Finding features")
    pycolmap.extract_features(db, frames_dir, camera_mode=pycolmap.CameraMode.SINGLE,
                              reader_options=reader, device=pycolmap.Device.cpu)
    pairing = pycolmap.SequentialPairingOptions()
    pairing.overlap = MATCH_OVERLAP
    progress("Matching frames")
    pycolmap.match_sequential(db, pairing_options=pairing, device=pycolmap.Device.cpu)
    progress("Solving the camera")
    recs = pycolmap.global_mapping(db, frames_dir, sparse)
    return max(recs.values(), key=lambda r: r.num_reg_images()) if recs else None


def _solve_error_code(ct, error, known):
    """The fail code for a ValueError from camera_track.solve."""
    if isinstance(error, ct.NoPlane):
        return "no_plane"
    return "invalid_known" if known else "tracking_failed"


def _poses(np, rec, count):
    """(R, C) per frame index, None where the frame did not register."""
    poses = [None] * count
    for img in rec.images.values():
        if getattr(img, "has_pose", True) is False:
            continue
        name = os.path.splitext(img.name)[0]
        if not (name.startswith("f") and name[1:].isdigit()):
            continue
        cfw = img.cam_from_world() if callable(img.cam_from_world) else img.cam_from_world
        R = np.asarray(cfw.rotation.matrix(), float)
        t = np.asarray(cfw.translation, float)
        i = int(name[1:])
        if 0 <= i < count:
            poses[i] = (R, -R.T @ t)
    return poses


def main():
    import argparse
    parser = argparse.ArgumentParser(description="The camera of a clip, for a 3D scene")
    parser.add_argument("--input", required=True, help="Absolute path of the video")
    parser.add_argument("--fps", type=float, default=10.0, help="Frames tracked per second (1 to 30, default 10)")
    parser.add_argument("--lens", type=float, default=None, help="A lens guess in Montaj mm")
    parser.add_argument("--known", default=None, help="A known size as JSON, for a metric scale")
    parser.add_argument("--max-frames", dest="max_frames", type=int, default=600,
                        help="Refuse a clip that samples to more frames (default 600)")
    parser.add_argument("--out", default=None, help="Write the JSON here and print the path")
    args = parser.parse_args()

    if not (MIN_FPS <= args.fps <= MAX_FPS):
        fail("invalid_param", f"--fps must be from {MIN_FPS} to {MAX_FPS}, got {args.fps:g}")
    if args.lens is not None and not (MIN_LENS <= args.lens <= MAX_LENS):
        fail("invalid_param", f"--lens must be from {MIN_LENS} to {MAX_LENS} mm, got {args.lens:g}")
    if args.max_frames < 1:
        fail("invalid_param", f"--max-frames must be at least 1, got {args.max_frames}")
    input_path = os.path.abspath(args.input)
    require_file(input_path)

    if _intel_mac():
        fail("unsupported_platform", "Camera tracking isn't available on Intel Macs yet.")
    try:
        import numpy as np
        import pycolmap
    except ImportError:
        fail("missing_dependency", "Camera tracking needs Montaj's vision extra (pycolmap).")
    from lib import camera_track as ct

    known = None
    if args.known is not None:
        try:
            known = ct.parse_known(args.known)
        except ValueError as e:
            fail("invalid_known", str(e))

    info = _probe(input_path)
    w, h = info["size"]
    fps = args.fps
    notes = []
    if info["rate"] and fps > info["rate"] + 1e-6:
        fps = round(info["rate"], 3)
        notes.append(f"Sampled at the clip's own {fps:g} fps, not {args.fps:g}.")
    expected = max(1, math.ceil(info["duration"] * fps - 1e-6))
    if expected > args.max_frames:
        fail("too_many_frames",
             f"{info['duration']:.1f} s at {fps:g} fps is {expected} frames, over --max-frames "
             f"{args.max_frames}. Pass a lower --fps, a shorter clip, or a higher --max-frames.")

    if args.lens is not None:
        prior = ct.focal_from_lens(args.lens, h)
        prior_source = f"the lens param ({args.lens:g} mm)"
    elif info["f35"]:
        prior = ct.focal_from_35mm(info["f35"], w, h)
        prior_source = f"the video's 35 mm-equivalent tag ({info['f35']:g} mm)"
    else:
        prior = PRIOR_FACTOR * max(w, h)
        prior_source = f"{PRIOR_FACTOR:g} x the long side"

    work_dir = tempfile.mkdtemp(prefix="montaj-track-camera-")
    try:
        frames_dir = os.path.join(work_dir, "frames")
        os.makedirs(frames_dir)
        progress(f"Reading frames at {fps:g} fps")
        ww, hh = _extract(input_path, fps, (w, h), frames_dir)
        count = len([n for n in os.listdir(frames_dir) if n.endswith(".jpg")])
        if count < 2:
            fail("too_short", f"{input_path} gives {count} frame at {fps:g} fps; tracking needs at least 2.")
        if count > args.max_frames:
            fail("too_many_frames", f"The clip gives {count} frames at {fps:g} fps, over --max-frames {args.max_frames}.")
        rec = _reconstruct(pycolmap, frames_dir, work_dir, prior / max(w, h))
        poses = _poses(np, rec, count) if rec is not None else [None] * count
        got = sum(p is not None for p in poses)
        if got * 2 < count:
            fail("tracking_failed",
                 f"Only {got} of {count} frames could be tracked. The camera needs a still, textured "
                 "scene that stays in view: little blur, not a plain wall or table filling the frame.")
        cam = next(iter(rec.cameras.values()))
        if cam.model_name != "SIMPLE_RADIAL":
            fail("tracking_failed", f"Unexpected camera model {cam.model_name}")
        f_work, cx, cy, k1 = (float(v) for v in cam.params)
        px = h / hh                                  # display px per tracked px
        points = np.array([p.xyz for p in rec.points3D.values()], float)
        try:
            track = ct.solve(poses, points, fps=fps, size=[w, h], focal=f_work * px, k1=k1,
                             principal=[cx * w / ww, cy * px], known=known,
                             reprojection=rec.compute_mean_reprojection_error() * px)
        except ValueError as e:
            fail(_solve_error_code(ct, e, known), str(e))
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    out = ct.rounded(track)
    out["notes"] = notes + [f"The focal guess was {prior_source}."] + out["notes"]
    text = json.dumps(out)
    if args.out:
        try:
            with open(args.out, "w") as f:
                f.write(text)
        except OSError as e:
            fail("write_error", f"Could not write to {args.out}: {e}")
        print(args.out)
    else:
        print(text)


if __name__ == "__main__":
    main()
