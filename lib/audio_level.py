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


def silent_audio_pass(project_path, originals):
    """Background pass after init: measure each source in `originals` ({source id: file})
    and set `silentAudio: true` on the matching source in project.json, only when it is
    silent, the source still exists and is still unflagged. Each write is one locked
    read-modify-write of that one field (lib/project_lock.update_project). Never raises."""
    try:
        from lib.project_lock import update_project
        for sid, path in dict(originals).items():
            try:
                if not is_silent_audio(path):
                    continue

                def apply(project, sid=sid):
                    for src in project.get("sources") or []:
                        if isinstance(src, dict) and src.get("id") == sid:
                            if src.get("silentAudio") is True:
                                return None
                            src["silentAudio"] = True
                            return project
                    return None

                update_project(project_path, apply)
            except (Exception, SystemExit):
                continue
    except (Exception, SystemExit):
        pass


def schedule_silent_audio(project_path, originals):
    """Run `silent_audio_pass` in a detached process, so the caller (init) neither waits
    on it nor holds its pipes open. Never raises."""
    try:
        if not originals:
            return
        import json
        from lib.proc import detached_kwargs
        child = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), str(project_path)],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            **detached_kwargs())
        child.stdin.write(json.dumps(originals).encode())
        child.stdin.close()
    except (Exception, SystemExit):
        pass


if __name__ == "__main__":
    import json
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # repo root for `lib.`
    silent_audio_pass(sys.argv[1], json.loads(sys.stdin.read() or "{}"))
