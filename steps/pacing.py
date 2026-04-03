#!/usr/bin/env python3
"""Analyze speech pacing: WPM per window, slow sections, editing suggestions."""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run, get_duration, transcribe_words


def main():
    parser = argparse.ArgumentParser(
        description="Analyze speech pacing and identify slow sections"
    )
    parser.add_argument("--input",          required=True, help="Source video file")
    parser.add_argument("--model",          default="base.en",
                        choices=["tiny.en", "base.en", "medium.en", "large"],
                        help="Whisper model for transcription")
    parser.add_argument("--window",         type=float, default=5.0,
                        help="Window size in seconds for WPM calculation")
    parser.add_argument("--slow-threshold", type=float, default=0.7,
                        help="Fraction of avg WPM below which a window is flagged as slow")
    parser.add_argument("--out",            help="Write JSON to file; prints path to stdout")
    args = parser.parse_args()

    require_file(args.input)
    duration = get_duration(args.input)

    words = transcribe_words(args.input, args.model)

    if not words:
        _emit({
            "duration": round(duration, 3), "total_words": 0, "wpm_avg": 0,
            "wpm_min": 0, "wpm_max": 0, "slow_section_count": 0,
            "segments": [], "slow_sections": [],
        }, args.out)
        return

    # Build per-window segments
    window   = args.window
    segments = []
    t = 0.0
    while t < duration:
        w_end        = min(t + window, duration)
        actual_dur   = w_end - t
        w_words      = [w for w in words if t <= w["start"] < w_end]
        speech_secs  = sum(w["end"] - w["start"] for w in w_words)
        wpm          = len(w_words) / (actual_dur / 60) if actual_dur > 0 else 0
        segments.append({
            "start":        round(t, 3),
            "end":          round(w_end, 3),
            "words":        len(w_words),
            "wpm":          round(wpm, 1),
            "speech_ratio": round(speech_secs / actual_dur, 3) if actual_dur > 0 else 0,
        })
        t += window

    total_words = len(words)
    spoken_segs = [s for s in segments if s["words"] > 0]
    wpm_avg     = sum(s["wpm"] for s in spoken_segs) / len(spoken_segs) if spoken_segs else 0
    wpm_min     = min(s["wpm"] for s in spoken_segs) if spoken_segs else 0
    wpm_max     = max(s["wpm"] for s in spoken_segs) if spoken_segs else 0

    # Flag slow sections (contiguous windows below threshold)
    threshold_wpm = wpm_avg * args.slow_threshold
    slow_sections = []
    slow_start    = None
    slow_end      = None
    for seg in segments:
        is_slow = seg["words"] > 0 and seg["wpm"] < threshold_wpm
        if is_slow:
            if slow_start is None:
                slow_start = seg["start"]
            slow_end = seg["end"]
        else:
            if slow_start is not None:
                slow_sections.append({"start": slow_start, "end": slow_end})
                slow_start = None
                slow_end   = None
    if slow_start is not None:
        slow_sections.append({"start": slow_start, "end": slow_end})

    _emit({
        "duration":           round(duration, 3),
        "total_words":        total_words,
        "wpm_avg":            round(wpm_avg, 1),
        "wpm_min":            round(wpm_min, 1),
        "wpm_max":            round(wpm_max, 1),
        "slow_section_count": len(slow_sections),
        "segments":           segments,
        "slow_sections":      slow_sections,
    }, args.out)


def _emit(data, out_path):
    text = json.dumps(data, indent=2)
    if out_path:
        with open(out_path, "w") as f:
            f.write(text)
        check_output(out_path)
        print(out_path)
    else:
        print(text)


if __name__ == "__main__":
    main()
