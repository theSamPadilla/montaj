#!/usr/bin/env python3
"""Prepare caption track from word-level transcript JSON for the render engine."""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output

def main():
    parser = argparse.ArgumentParser(
        description="Convert word-level transcript JSON to a caption track for the render engine")
    parser.add_argument("--input", required=True,
                        help="Word-level JSON transcript from the transcribe step")
    parser.add_argument("--style", default="word-by-word",
                        choices=["word-by-word", "karaoke", "subtitle", "pop"],
                        help="Caption animation style")
    parser.add_argument("--out", help="Output caption track JSON path")
    args = parser.parse_args()

    require_file(args.input)
    out = args.out or f"{os.path.splitext(args.input)[0]}_captions.json"

    with open(args.input, encoding="utf-8", errors="replace") as f:
        transcript = json.load(f)

    # Canonical format: whisper.cpp transcription[] with offsets in milliseconds
    raw = transcript.get("transcription", [])
    if not raw:
        fail("empty_transcript", "No segments found in transcript JSON")

    # Flatten to word list
    words = []
    for entry in raw:
        text = entry.get("text", "").strip()
        if not text:
            continue
        offsets = entry.get("offsets", {})
        words.append({
            "word":  text,
            "start": offsets.get("from", 0) / 1000.0,
            "end":   offsets.get("to",   0) / 1000.0,
        })

    if not words:
        fail("empty_transcript", "No words found in transcript JSON")

    # Group words into display phrases: new phrase on gap > 0.4s or every 8 words
    items = []
    phrase = [words[0]]
    for w in words[1:]:
        gap = w["start"] - phrase[-1]["end"]
        if gap > 0.4 or len(phrase) >= 8:
            items.append(phrase)
            phrase = [w]
        else:
            phrase.append(w)
    if phrase:
        items.append(phrase)

    items = [
        {
            "text":  " ".join(w["word"] for w in phrase),
            "start": round(phrase[0]["start"], 3),
            "end":   round(phrase[-1]["end"],  3),
            "words": [
                {"word": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)}
                for w in phrase
            ],
        }
        for phrase in items
    ]

    caption_track = {"style": args.style, "segments": items}

    with open(out, "w") as f:
        json.dump(caption_track, f, indent=2)

    check_output(out)
    print(out)

if __name__ == "__main__":
    main()
