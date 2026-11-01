"""Audio level of a source file's first audio track, for flagging silent clips at import.

Data only: callers record what this returns and never refuse on it.
"""
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))  # add lib/ so `from common` works in all invocation modes
from common import ffmpeg_bin

# A track whose loudest sample is at or below this is treated as silent.
SILENT_MAX_DB = -60.0

_MEAN = re.compile(r"mean_volume:\s*(-?inf|-?[\d.]+)\s*dB")
_MAX = re.compile(r"max_volume:\s*(-?inf|-?[\d.]+)\s*dB")


def _db(text):
    return float("-inf") if "inf" in text else float(text)


def audio_levels(path, timeout=300):
    """(mean_db, max_db) of the first audio track, or None when there is no audio
    stream or the measurement failed. Audio only: the video is never decoded.
    A track with no samples reports (-inf, -inf). Never raises."""
    try:
        r = subprocess.run(
            [ffmpeg_bin(), "-hide_banner", "-nostdin", "-i", str(path), "-vn",
             "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            return None
        mean, mx = _MEAN.search(r.stderr), _MAX.search(r.stderr)
        if not mx:
            return (float("-inf"), float("-inf"))
        return (_db(mean.group(1)) if mean else float("-inf"), _db(mx.group(1)))
    except (Exception, SystemExit):
        return None


def is_silent_audio(path):
    """True only when the file has an audio stream and it is silent."""
    levels = audio_levels(path)
    return levels is not None and levels[1] <= SILENT_MAX_DB
