import json


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
        "ffmpeg", "-y",
        "-i", input_path,
        "-filter_complex", filter_complex,
        "-map", "[aout]",
        "-ar", "16000",
        "-ac", "1",
        "-f", "wav",
        out_wav,
    ]
