#!/usr/bin/env python3
"""Prepare caption track from word-level transcript JSON for the render engine."""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output

# Minimum word duration in SECONDS, not frames. This is the single funnel for
# both the SSE route and the CLI step, and neither knows the project's fps
# here -- 50ms guarantees >=1 frame at every fps montaj ships in practice
# (24/25/30/50/60; >=1.5 frames at the default 30fps). fps is auto-detected
# from source footage with no lower clamp, though, so this isn't a hard
# guarantee: below 20fps a 50ms word can still fall between frames. Mirrored
# in the editor at
# montaj_assets/editor/src/video/captionWordFloor.ts, which this module is the
# reference implementation for.
MIN_WORD_DURATION_S = 0.05


def floor_word_durations(words, floor_s=MIN_WORD_DURATION_S):
    """Forward waterfall that enforces a minimum per-word duration.

    Whisper words arrive contiguous (`end_i == start_{i+1}`). For a word
    shorter than `floor_s` with a successor, the shared boundary is pushed
    forward to `start_i + floor_s` -- moving BOTH `end_i` and
    `start_{i+1}` together -- but only via a binary donation gate: the move
    happens in full, or not at all. There is no partial donation, because
    the per-word caption templates select with `.find()` (first match
    wins): a blindly widened `end_i` that stops short of the successor's new
    start would still leave the successor un-selectable at its own start,
    reproducing the invisibility bug one word over. So the donation is only
    accepted when the successor would retain >= `floor_s` after losing that
    slice; otherwise word *i* is left completely unchanged (no better, but
    never worse).

    A non-contiguous pair (a pre-existing gap after word *i*) extends `end_i`
    into that gap, up to the floor, without touching the successor's start
    at all -- there is slack to spend that doesn't cost the successor
    anything.

    The transcript-final word has no successor. This function runs at the
    flatten, before phrase/segment grouping exists, so there is no `seg_end`
    to clamp against either -- the final word borders trailing silence, and
    extending a few tens of milliseconds into silence is harmless. It is
    therefore extended unconditionally, up to the floor. [The TS mirror,
    captionWordFloor.ts, runs per-segment instead and clamps the
    segment-final word at `seg.end` -- the one deliberate divergence between
    the two implementations; see the comment there.]

    One documented side effect: this function runs before the phrase-
    grouping loop later in this module, which starts a new phrase whenever
    the gap to the next word exceeds 0.4s. Because the non-contiguous
    branch above only ever *shrinks* a gap -- by at most `floor_s` (50ms
    with the default) -- a gap that was just over that 0.4s threshold can
    come out just under it, merging two phrases that would otherwise have
    split. This requires a sub-floor word immediately before the gap, so
    it's rare, and the effect is capped at `floor_s`. It is the only one of
    the three branches that can change how words end up grouped into
    phrases: the contiguous branch moves both sides of one shared boundary
    together without touching the gap to the *next* boundary, and the
    transcript-final branch has no successor to affect.

    Never creates overlap. Words already >= `floor_s` are left untouched, so
    a list with nothing short in it comes back with identical values. Pure:
    returns a new list of new dicts and never mutates `words`.
    """
    if not words:
        return words

    out = [dict(w) for w in words]
    n = len(out)
    for i in range(n):
        dur = out[i]["end"] - out[i]["start"]
        if dur >= floor_s:
            continue

        if i + 1 >= n:
            # Transcript-final word: unconditional extension into trailing silence.
            out[i]["end"] = out[i]["end"] + (floor_s - dur)
            continue

        gap = out[i + 1]["start"] - out[i]["end"]
        if gap > 0:
            # Non-contiguous: spend existing slack, never touch the successor.
            out[i]["end"] = min(out[i]["end"] + (floor_s - dur), out[i + 1]["start"])
            continue

        # Contiguous: binary donation gate on the shared boundary.
        candidate_boundary = out[i]["start"] + floor_s
        successor_new_dur = out[i + 1]["end"] - candidate_boundary
        if successor_new_dur >= floor_s:
            out[i]["end"] = candidate_boundary
            out[i + 1]["start"] = candidate_boundary
        # else: donation refused. Word i is left completely unchanged.

    return out


def main():
    parser = argparse.ArgumentParser(
        description="Convert word-level transcript JSON to a caption track for the render engine")
    parser.add_argument("--input", required=True,
                        help="Word-level JSON transcript from the transcribe step")
    parser.add_argument("--style", default="word-by-word",
                        choices=["word-by-word", "karaoke", "subtitle", "pop", "highlight-box", "outline", "clean"],
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

    words = floor_word_durations(words, MIN_WORD_DURATION_S)

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
