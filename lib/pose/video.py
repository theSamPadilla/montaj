"""A video's frames as RGB arrays for the pose models, through ffmpeg.

Frames come upright (ffmpeg applies the rotation tag) at the display size,
resampled to a constant `fps` from the first frame, so frame i is at i / fps s.
"""
import subprocess

import numpy as np

from lib.common import fail, ffmpeg_bin, ffmpeg_error_tail
from lib.normalize import probe_video

MAX_DEFAULT_FPS = 30.0


def video_info(path):
    """(width, height, fps) upright, or fail. fps is the clip's real rate."""
    info = probe_video(path)
    if not info or not info.get("width"):
        fail("invalid_video", f"No video stream in {path}")
    num, _, den = str(info.get("frame_rate") or "").partition("/")
    try:
        rate = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        rate = float(info.get("fps") or 0)
    if not rate > 0:
        fail("invalid_video", f"Could not read the frame rate of {path}")
    return int(info["display_width"]), int(info["display_height"]), rate


def frames(path, fps, width, height):
    """RGB uint8 frames (height x width x 3) at `fps`, in order."""
    size = width * height * 3
    proc = subprocess.Popen(
        [ffmpeg_bin(), "-v", "error", "-nostdin", "-i", path, "-map", "0:v:0",
         "-vf", f"fps={fps!r}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    n = 0
    try:
        while True:
            buf = proc.stdout.read(size)
            if not buf:
                break
            if len(buf) != size:
                break
            n += 1
            yield np.frombuffer(buf, np.uint8).reshape(height, width, 3)
        err = proc.stderr.read()
        if proc.wait() != 0 or n == 0:
            fail("decode_failed", f"Decoding {path} failed after {n} frames.{ffmpeg_error_tail(err)}")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
