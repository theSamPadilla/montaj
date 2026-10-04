"""Pause map: silences measured from the audio, with a threshold set per source.

A fixed dB threshold is wrong for any source whose noise floor is not the one it
was tuned on, so the threshold is the source's own noise floor plus a margin.
"""
import re

from lib.common import fail, ffmpeg_bin, ffprobe_bin, require_file, run

MIN_SILENCE_S = 0.06
FLOOR_MARGIN_DB = 15
_THRESHOLD_RANGE_DB = (-60.0, -25.0)
_MERGE_GAP_S = 0.02


def _require_audio(path: str):
    require_file(path)
    r = run([ffprobe_bin(), "-v", "error", "-select_streams", "a", "-show_entries",
             "stream=index", "-of", "csv=p=0", path], check=False)
    if not r.stdout.strip():
        fail("no_audio", f"No audio stream in {path}")


def noise_floor_db(path: str) -> float:
    """ffmpeg astats overall Noise_floor (dB) of the first audio stream; -60.0 if astats reports -inf."""
    _require_audio(path)
    r = run([ffmpeg_bin(), "-i", path, "-map", "0:a:0", "-af", "astats=measure_perchannel=none",
             "-f", "null", "-"], check=False)
    m = re.search(r"Noise floor dB:\s*(-?inf|-?[\d.]+)", r.stderr)
    if not m or m.group(1).endswith("inf"):
        return -60.0
    return max(-60.0, float(m.group(1)))


def threshold_db(path: str) -> float:
    lo, hi = _THRESHOLD_RANGE_DB
    return min(hi, max(lo, noise_floor_db(path) + FLOOR_MARGIN_DB))


def silences(path: str, start: float = 0.0, end: float | None = None) -> list[tuple[float, float]]:
    """Silences of at least MIN_SILENCE_S in source seconds, threshold clamp(noise_floor_db + FLOOR_MARGIN_DB, -60, -25),
    via ffmpeg silencedetect=noise=<t>dB:d=MIN_SILENCE_S. Sorted, merged when closer than 0.02 s."""
    t = threshold_db(path)
    cmd = [ffmpeg_bin()]
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    if end is not None:
        cmd += ["-t", f"{max(0.0, end - start):.3f}"]
    cmd += ["-i", path, "-map", "0:a:0", "-af", f"silencedetect=noise={t:.2f}dB:d={MIN_SILENCE_S}",
            "-f", "null", "-"]
    r = run(cmd, check=False)
    found, cur = [], None
    for line in r.stderr.splitlines():
        s = re.search(r"silence_start: (-?[\d.]+)", line)
        e = re.search(r"silence_end: ([\d.]+)", line)
        if s:
            cur = max(0.0, float(s.group(1)))
        if e and cur is not None:
            found.append((cur + start, float(e.group(1)) + start))
            cur = None
    if cur is not None and end is not None:
        found.append((cur + start, end))
    merged: list[tuple[float, float]] = []
    for a, b in sorted(found):
        if merged and a - merged[-1][1] < _MERGE_GAP_S:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged
