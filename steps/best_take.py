#!/usr/bin/env python3
"""Segment a clip into takes and score each by speech confidence and delivery quality."""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run, get_duration, transcribe_words


def main():
    parser = argparse.ArgumentParser(
        description="Segment and score takes by speech quality"
    )
    parser.add_argument("--input",     required=True, help="Source video file")
    parser.add_argument("--model",     default="base.en",
                        choices=["tiny.en", "base.en", "medium.en", "large"],
                        help="Whisper model for transcription")
    parser.add_argument("--min-pause", type=float, default=2.0,
                        help="Minimum pause between words to define a take boundary (seconds)")
    parser.add_argument("--min-words", type=int, default=5,
                        help="Minimum words in a take to include in results")
    parser.add_argument("--out",       help="Write JSON to file; prints path to stdout")
    args = parser.parse_args()

    require_file(args.input)
    duration = get_duration(args.input)

    raw_words = transcribe_words(args.input, args.model)
    words = [{"confidence": 0.8, **w} for w in raw_words]

    if not words:
        _emit({"duration": round(duration, 3), "take_count": 0, "takes": []}, args.out)
        return

    # Segment into takes by pause threshold
    take_groups = []
    group = [words[0]]
    for w in words[1:]:
        if w["start"] - group[-1]["end"] >= args.min_pause:
            take_groups.append(group)
            group = [w]
        else:
            group.append(w)
    take_groups.append(group)

    # Score each take
    scored = []
    for take in take_groups:
        if len(take) < args.min_words:
            continue

        t_start    = take[0]["start"]
        t_end      = take[-1]["end"]
        t_duration = t_end - t_start
        wpm        = (len(take) / t_duration * 60) if t_duration > 0 else 0
        avg_conf   = sum(w["confidence"] for w in take) / len(take)

        # WPM score: 0 at 40 WPM, 1 at 200 WPM, clamped
        wpm_score = min(1.0, max(0.0, (wpm - 40) / 160))
        score     = round(0.6 * avg_conf + 0.4 * wpm_score, 3)

        scored.append({
            "start":      round(t_start, 3),
            "end":        round(t_end, 3),
            "duration":   round(t_duration, 3),
            "score":      score,
            "confidence": round(avg_conf, 3),
            "wpm":        round(wpm, 1),
            "words":      len(take),
            "text":       " ".join(w["text"] for w in take),
        })

    scored.sort(key=lambda x: x["score"], reverse=True)

    _emit({
        "duration":   round(duration, 3),
        "take_count": len(scored),
        "takes":      scored,
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
