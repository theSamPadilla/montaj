#!/usr/bin/env python3
"""The camera of a clip, for a 3D scene: per-frame lens, location, target and roll.

Frames are sampled at --fps by lib/frame_sampling (frame k is the source frame on
screen at k / fps; HLG and PQ tone-mapped to SDR; rotation applied, the long side
at most WORK_LONG_EDGE) into a temp dir, and pycolmap reconstructs them: SIFT features on
the CPU (at most SIFT_THREADS threads and SIFT_FEATURES features a frame), one
SIMPLE_RADIAL camera for every frame, sequential matching, then the global mapper,
seeded. The incremental mapper is not used: on a near-still handheld clip (§328 P0,
75 frames) it registered 13 to 36 frames with the focal anywhere from 566 to 3,506
px, where the global mapper registered all 75 every time.

Measured 2026-10-16: the defaults on a 30 s 1080x1920 phone clip (300 frames,
tracked at 1280 px) took 170 s wall and 342 s CPU (about 2 cores on average, SIFT
capped at 4 threads) with 1.2 GB peak memory; all 300 frames registered, lens
32.4 mm, reprojection 1.4 px.

scene.camera is thinned to the keys that hold the camera within --tolerance px of
the track at every sampled frame (lib/camera_track.thin_keys), with roll keys when
the camera rolls.

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
import time

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib import frame_sampling
from lib.common import ffmpeg_bin, ffmpeg_error_tail, ffprobe_bin, fail, progress, require_file
from lib.normalize import probe_video

MIN_FPS, MAX_FPS = 1, 30
MIN_LENS, MAX_LENS = 8, 300          # mm, as the engine's fitCamera allows
MIN_TOLERANCE, MAX_TOLERANCE = 0, 50 # px
WORK_LONG_EDGE = 1280                # frames are tracked at most this long
PRIOR_FACTOR = 0.85                  # the focal guess, x the long side, when nothing says better
FOCAL_35MM_TAG = "com.apple.quicktime.camera.focal_length.35mm_equivalent"
MATCH_OVERLAP = 15                   # each frame is matched with the next 15
JPEG_QUALITY = "2"
SIFT_THREADS = 4                     # at most, and never more than the machine's cores
SIFT_FEATURES = 4096                 # a frame, half pycolmap's default
MAPPER_SEED = 0
MAX_FRAMES = 300
STALE_S = 3600                       # a work folder this old was left by a run that was killed
WORK_PREFIX = "montaj-track-camera-"


def _intel_mac():
    return sys.platform == "darwin" and platform.machine() == "x86_64"


def _probe(path):
    """Duration, display size, frame rate, colour transfer and the 35 mm-equivalent focal tag."""
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
    if not rate > 0:
        fail("probe_error", f"Could not read the frame rate of {path}")
    return {"duration": duration, "size": (info["display_width"], info["display_height"]),
            "rate": rate, "transfer": info.get("color_transfer"), "f35": f35}


def _extract(path, fps, size, out_dir, rate, transfer=None):
    """Frames f00000.jpg ... at fps through lib/frame_sampling (k is the frame on
    screen at k / fps, HDR tone-mapped), at most WORK_LONG_EDGE long. rate is the
    source's frame rate, transfer its ffprobe color_transfer. Returns (w, h,
    tone_mapped)."""
    w, h = size
    k = min(1.0, WORK_LONG_EDGE / max(w, h))
    ww, hh = max(1, round(w * k)), max(1, round(h * k))
    scale = f"scale={ww}:{hh}:flags=area" if (ww, hh) != (w, h) else None
    args, tone_mapped = frame_sampling.input_args(path, fps, rate, transfer, after=scale)
    cmd = [ffmpeg_bin(), "-v", "error", "-nostdin", *args,
           "-q:v", JPEG_QUALITY, "-start_number", "0", os.path.join(out_dir, "f%05d.jpg")]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        fail("decode_failed", f"Could not read frames from {path}.{ffmpeg_error_tail(r.stderr)}")
    return ww, hh, tone_mapped


def _sweep_stale(tmp_dir, now=None):
    """Remove WORK_PREFIX folders in tmp_dir that nothing has touched for STALE_S: a
    run killed by serve's timeout never reaches its own cleanup."""
    now = time.time() if now is None else now
    try:
        names = [n for n in os.listdir(tmp_dir) if n.startswith(WORK_PREFIX)]
    except OSError:
        return
    for name in names:
        path = os.path.join(tmp_dir, name)
        try:
            touched = max([os.path.getmtime(path)]
                          + [os.path.getmtime(os.path.join(path, c)) for c in os.listdir(path)])
        except OSError:
            continue
        if now - touched > STALE_S:
            shutil.rmtree(path, ignore_errors=True)


def _reconstruct(pycolmap, frames_dir, work_dir, focal_factor):
    pycolmap.logging.minloglevel = 2
    db = os.path.join(work_dir, "frames.db")
    sparse = os.path.join(work_dir, "sparse")
    os.makedirs(sparse)
    reader = pycolmap.ImageReaderOptions()
    reader.camera_model = "SIMPLE_RADIAL"
    reader.default_focal_length_factor = focal_factor
    extraction = pycolmap.FeatureExtractionOptions()
    extraction.num_threads = min(SIFT_THREADS, os.cpu_count() or 1)
    extraction.sift.max_num_features = SIFT_FEATURES
    progress("Finding features")
    pycolmap.extract_features(db, frames_dir, camera_mode=pycolmap.CameraMode.SINGLE,
                              reader_options=reader, extraction_options=extraction, device=pycolmap.Device.cpu)
    pairing = pycolmap.SequentialPairingOptions()
    pairing.overlap = MATCH_OVERLAP
    progress("Matching frames")
    pycolmap.match_sequential(db, pairing_options=pairing, device=pycolmap.Device.cpu)
    progress("Solving the camera")
    mapping = pycolmap.GlobalPipelineOptions()
    mapping.random_seed = MAPPER_SEED
    mapping.mapper.random_seed = MAPPER_SEED
    recs = pycolmap.global_mapping(db, frames_dir, sparse, mapping)
    return max(recs.values(), key=lambda r: r.num_reg_images()) if recs else None


def _too_few(got, count):
    return (f"Only {got} of {count} frames could be tracked. The camera needs a still, textured "
            "scene that stays in view: little blur, not a plain wall or table filling the frame. "
            "The camera must move; for a locked-off shot use fit_camera.")


def _emit(out, path):
    """Print the track, or write it to path and print the path. A track with a
    non-finite number (a degenerate pose) fails as tracking_failed."""
    try:
        text = json.dumps(out, allow_nan=False)
    except ValueError:
        fail("tracking_failed", "The track came out degenerate (a number that is not finite). "
                                "Try again, or a different stretch of the clip.")
    if path:
        try:
            with open(path, "w") as f:
                f.write(text)
        except OSError as e:
            fail("write_error", f"Could not write to {path}: {e}")
        print(path)
    else:
        print(text)


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
    parser.add_argument("--max-frames", dest="max_frames", type=int, default=MAX_FRAMES,
                        help=f"Refuse a clip that samples to more frames (default {MAX_FRAMES})")
    parser.add_argument("--tolerance", type=float, default=0.5,
                        help="scene.camera keys hold the camera within this many px of the track (default 0.5)")
    parser.add_argument("--out", default=None, help="Write the JSON here and print the path")
    args = parser.parse_args()

    if not (MIN_FPS <= args.fps <= MAX_FPS):
        fail("invalid_param", f"--fps must be from {MIN_FPS} to {MAX_FPS}, got {args.fps:g}")
    if args.lens is not None and not (MIN_LENS <= args.lens <= MAX_LENS):
        fail("invalid_param", f"--lens must be from {MIN_LENS} to {MAX_LENS} mm, got {args.lens:g}")
    if not (MIN_TOLERANCE <= args.tolerance <= MAX_TOLERANCE):
        fail("invalid_param", f"--tolerance must be from {MIN_TOLERANCE} to {MAX_TOLERANCE} px, got {args.tolerance:g}")
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
    if fps > info["rate"] + 1e-6:
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

    _sweep_stale(tempfile.gettempdir())
    work_dir = tempfile.mkdtemp(prefix=WORK_PREFIX)
    try:
        frames_dir = os.path.join(work_dir, "frames")
        os.makedirs(frames_dir)
        progress(f"Reading frames at {fps:g} fps")
        ww, hh, tone_mapped = _extract(input_path, fps, (w, h), frames_dir, info["rate"], info["transfer"])
        if tone_mapped:
            notes.append("The clip is HDR: it was tracked through an SDR tone map.")
        count = len([n for n in os.listdir(frames_dir) if n.endswith(".jpg")])
        if count < 2:
            fail("too_short", f"{input_path} gives {count} frame at {fps:g} fps; tracking needs at least 2.")
        if count > args.max_frames:
            fail("too_many_frames", f"The clip gives {count} frames at {fps:g} fps, over --max-frames {args.max_frames}.")
        rec = _reconstruct(pycolmap, frames_dir, work_dir, prior / max(w, h))
        poses = _poses(np, rec, count) if rec is not None else [None] * count
        got = sum(p is not None for p in poses)
        if got * 2 < count:
            fail("tracking_failed", _too_few(got, count))
        cam = next(iter(rec.cameras.values()))
        if cam.model_name != "SIMPLE_RADIAL":
            fail("tracking_failed", f"Unexpected camera model {cam.model_name}")
        f_work, cx, cy, k1 = (float(v) for v in cam.params)
        px = h / hh                                  # display px per tracked px
        points = np.array([p.xyz for p in rec.points3D.values()], float)
        reprojection = rec.compute_mean_reprojection_error() * px
        del rec, cam                                 # the arrays above are all solve needs
        try:
            track = ct.solve(poses, points, fps=fps, size=[w, h], focal=f_work * px, k1=k1,
                             principal=[cx * w / ww, cy * px], known=known, reprojection=reprojection,
                             tolerance=args.tolerance)
        except ValueError as e:
            fail(_solve_error_code(ct, e, known), str(e))
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    out = ct.rounded(track)
    out["notes"] = notes + [f"The focal guess was {prior_source}."] + out["notes"]
    _emit(out, args.out)


if __name__ == "__main__":
    main()
