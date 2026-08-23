import json

from common import ffmpeg_bin


def load(src) -> dict:
    """Load a trim spec from a dict or a JSON file path."""
    if isinstance(src, dict):
        return src
    with open(src, "r") as f:
        return json.load(f)


def is_trim_spec(path: str) -> bool:
    """Return True if path is a .json file that parses as a trim spec."""
    if not isinstance(path, str) or not path.endswith(".json"):
        return False
    try:
        with open(path, "r") as f:
            data = json.load(f)
        return "input" in data and "keeps" in data
    except Exception:
        return False


def is_cut_spec(path: str) -> bool:
    """Return True if path is a JSON cut spec — either the single-source
    ``{"input", "keeps"}`` trim-spec shape or the multi-source
    ``{"segments": [{"src", "in", "out"}, ...]}`` shape.

    Broader than ``is_trim_spec``; use where multi-source concatenation is
    supported (e.g. the caption cut). ``is_trim_spec`` is deliberately left
    narrow so single-source-only callers (transcribe, rm_fillers, rm_nonspeech)
    keep rejecting the multi-source shape."""
    if not isinstance(path, str) or not path.endswith(".json"):
        return False
    try:
        with open(path, "r") as f:
            data = json.load(f)
        return ("input" in data and "keeps" in data) or "segments" in data
    except Exception:
        return False


def from_window(input_path: str, win_in: float, win_out: float) -> dict:
    """Build a single-range trim spec covering [win_in, win_out) of input_path.

    One copy of the "analyse only a window of a source file" rule — steps that
    need it call this rather than constructing the {input, keeps} shape
    themselves, and fall into the same tested trim-spec branch as a
    caller-supplied spec.
    """
    return {"input": input_path, "keeps": [[win_in, win_out]]}


def merge(keeps: list, cuts: list) -> list:
    """Remove cut ranges from keeps. All timestamps are in original source timeline."""
    MIN_SEGMENT = 0.02
    result = []

    for ks, ke in keeps:
        # Start with the full keep segment, then subtract cuts
        segments = [[ks, ke]]
        for cs, ce in cuts:
            next_segments = []
            for s, e in segments:
                # No overlap
                if ce <= s or cs >= e:
                    next_segments.append([s, e])
                else:
                    # Left part before cut
                    if cs > s:
                        next_segments.append([s, cs])
                    # Right part after cut
                    if ce < e:
                        next_segments.append([ce, e])
            segments = next_segments
        result.extend(segments)

    # Round to 4 decimal places and drop segments shorter than MIN_SEGMENT
    cleaned = []
    for s, e in result:
        s = round(s, 4)
        e = round(e, 4)
        if e - s >= MIN_SEGMENT:
            cleaned.append([s, e])

    return cleaned


def remap_timestamp(t: float, keeps: list) -> float:
    """Map timestamp t from joined-audio timeline back to original source timeline."""
    offset = 0.0
    for s, e in keeps:
        segment_duration = e - s
        if t < offset + segment_duration:
            return s + (t - offset)
        offset += segment_duration
    # Clamp to last segment end
    if keeps:
        return keeps[-1][1]
    return t


def audio_extract_cmd(input_path: str, keeps: list, out_wav: str) -> list:
    """Build an ffmpeg command to extract and concatenate audio at keep ranges."""
    n = len(keeps)
    filter_parts = []
    for i, (s, e) in enumerate(keeps):
        filter_parts.append(
            f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}]"
        )
    inputs = "".join(f"[a{i}]" for i in range(n))
    if n == 1:
        filter_parts.append(f"[a0]anull[aout]")
    else:
        filter_parts.append(f"{inputs}concat=n={n}:v=0:a=1[aout]")
    filter_complex = ";".join(filter_parts)

    return [
        ffmpeg_bin(), "-y",
        "-i", input_path,
        "-filter_complex", filter_complex,
        "-map", "[aout]",
        "-ar", "16000",
        "-ac", "1",
        "-f", "wav",
        out_wav,
    ]
