"""A video's frames as RGB arrays for the pose models, through ffmpeg.

Frames come upright (ffmpeg applies the rotation tag) at the display size, by
lib/frame_sampling's rule: frame k is the source frame on screen at k / fps s
from the first frame, tone-mapped to SDR when the source is HLG or PQ.
"""
import subprocess
import tempfile
from collections import namedtuple

import numpy as np

from lib.common import fail, ffmpeg_bin, ffmpeg_error_tail, ffprobe_bin, ff_path
from lib.frame_sampling import input_args
from lib.normalize import probe_video

MAX_DEFAULT_FPS = 30.0

# Display size, the real frame rate, the duration in s (None when the file
# does not say) and ffprobe's color_transfer.
VideoInfo = namedtuple("VideoInfo", "width height rate duration color_transfer")


def video_info(path):
    """The clip's VideoInfo, or fail with probe_error."""
    info = probe_video(path)
    if not info or not info.get("display_width"):
        fail("probe_error", f"Could not read a video stream from {path}")
    num, _, den = str(info.get("frame_rate") or "").partition("/")
    try:
        rate = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        rate = float(info.get("fps") or 0)
    if not rate > 0:
        fail("probe_error", f"Could not read the frame rate of {path}")
    return VideoInfo(int(info["display_width"]), int(info["display_height"]), rate,
                     _duration(path), info.get("color_transfer"))


def _duration(path):
    r = subprocess.run([ffprobe_bin(), "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", ff_path(path)],
                       capture_output=True, text=True, timeout=30)
    try:
        d = float(r.stdout.strip())
    except ValueError:
        return None
    return d if d > 0 else None


def frames(path, fps, info, limit=None):
    """RGB uint8 frames (height x width x 3) at `fps`, in order. More than
    `limit` frames fails with too_many_frames."""
    width, height = info.width, info.height
    size = width * height * 3
    args, _ = input_args(path, fps, info.rate, info.color_transfer)
    # stderr goes to a file, never a pipe: a pipe nobody reads while frames
    # stream would stall ffmpeg once it fills.
    with tempfile.TemporaryFile() as err:
        proc = subprocess.Popen([ffmpeg_bin(), "-v", "error", "-nostdin", *args,
                                 "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                                stdout=subprocess.PIPE, stderr=err)
        n = 0
        try:
            while True:
                buf = proc.stdout.read(size)
                if len(buf) != size:
                    break
                n += 1
                if limit is not None and n > limit:
                    fail("too_many_frames", f"{path} gives more than {limit} frames at {fps:g} fps.")
                yield np.frombuffer(buf, np.uint8).reshape(height, width, 3)
            if proc.wait() != 0 or n == 0:
                err.seek(0)
                fail("decode_failed", f"Decoding {path} failed after {n} frames.{ffmpeg_error_tail(err.read())}")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
