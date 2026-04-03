#!/usr/bin/env python3
"""Detect jump cut issues: long pauses, stutters, and false starts."""
import json, os, re, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run, get_duration, transcribe_words


def detect_pauses(input_path, min_pause, noise):
    r = run(
        ["ffmpeg", "-i", input_path,
         "-af", f"silencedetect=noise={noise}dB:d={min_pause}",
         "-f", "null", "-"],
        check=False,
    )
    pauses = []
    start = None
    for line in r.stderr.split("\n"):
        s = re.search(r"silence_start: ([\d.]+)", line)
        e = re.search(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", line)
        if s:
            start = float(s.group(1))
        if e and start is not None:
            pauses.append({
                "start":    round(start, 3),
                "end":      round(float(e.group(1)), 3),
                "duration": round(float(e.group(2)), 3),
                "type":     "pause",
            })
            start = None
    return pauses


def detect_transcript_issues(input_path, model):
    issues = []
    raw = transcribe_words(input_path, model)
    words = [{"text": w["text"].lower().strip(".,!?"), "start": w["start"], "end": w["end"]}
             for w in raw if w["text"].strip()]
    if words:

        # Stutters: same word repeated consecutively within 2s — merge runs ("the the the" → one entry)
        i = 0
        while i < len(words) - 1:
            if (
                words[i]["text"] == words[i + 1]["text"]
                and words[i + 1]["start"] - words[i]["start"] < 2.0
            ):
                run_end = i + 1
                while (
                    run_end + 1 < len(words)
                    and words[run_end]["text"] == words[run_end + 1]["text"]
                    and words[run_end + 1]["start"] - words[run_end]["start"] < 2.0
                ):
                    run_end += 1
                issues.append({
                    "start": round(words[i]["start"], 3),
                    "end":   round(words[run_end]["end"], 3),
                    "type":  "stutter",
                    "text":  " ".join(w["text"] for w in words[i : run_end + 1]),
                })
                i = run_end + 1
            else:
                i += 1

        # False starts: phrase of 2–4 words repeated within 15s
        seen = set()
        for phrase_len in range(2, 5):
            for i in range(len(words) - phrase_len + 1):
                phrase1 = tuple(w["text"] for w in words[i : i + phrase_len])
                for j in range(i + 1, len(words) - phrase_len + 1):
                    if words[j]["start"] - words[i]["start"] > 15.0:
                        break
                    phrase2 = tuple(w["text"] for w in words[j : j + phrase_len])
                    if phrase1 == phrase2:
                        key = (round(words[i]["start"], 1), phrase1)
                        if key not in seen:
                            seen.add(key)
                            issues.append({
                                "start": round(words[i]["start"], 3),
                                "end":   round(words[i + phrase_len - 1]["end"], 3),
                                "type":  "false_start",
                                "text":  " ".join(phrase1),
                            })
                        break

    return issues


def main():
    parser = argparse.ArgumentParser(
        description="Detect jump cut issues: pauses, stutters, false starts"
    )
    parser.add_argument("--input",     required=True, help="Source video file")
    parser.add_argument("--min-pause", type=float, default=0.8,
                        help="Minimum silence duration to flag as a pause (seconds)")
    parser.add_argument("--noise",     type=int, default=-30,
                        help="Silence noise floor in dB (e.g. -30 for -30dB)")
    parser.add_argument("--model",     default="none",
                        choices=["none", "tiny.en", "base.en", "medium.en", "large"],
                        help="Whisper model for stutter/false-start detection. 'none' = pause detection only.")
    parser.add_argument("--out",       help="Write JSON to file; prints path to stdout")
    args = parser.parse_args()

    require_file(args.input)
    duration = get_duration(args.input)

    issues = detect_pauses(args.input, args.min_pause, args.noise)

    if args.model != "none":
        issues.extend(detect_transcript_issues(args.input, args.model))

    issues.sort(key=lambda x: x["start"])

    data = json.dumps({
        "duration":    round(duration, 3),
        "issue_count": len(issues),
        "issues":      issues,
    }, indent=2)

    if args.out:
        with open(args.out, "w") as f:
            f.write(data)
        check_output(args.out)
        print(args.out)
    else:
        print(data)


if __name__ == "__main__":
    main()
