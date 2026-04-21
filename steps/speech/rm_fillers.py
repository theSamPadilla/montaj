#!/usr/bin/env python3
"""Remove filler words (um, uh, etc.) — outputs a trim spec, no encode.
Also trims pre-speech noise at the head by snapping the start to the first word onset."""
import json, os, re, sys, argparse, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import require_file, run, get_duration, transcribe_words
from trim_spec import is_trim_spec, load as load_spec, merge as merge_keeps, audio_extract_cmd, remap_timestamp

FILLERS = re.compile(r"^(um|uh|uhh|umm|hmm|hm|ah|ahh|er|erm|mhm|uh-huh)$", re.IGNORECASE)
HEAD_PAD = 0.05   # seconds to keep before first word


def main():
    parser = argparse.ArgumentParser(description="Remove filler words from a clip")
    parser.add_argument("--input", required=True, help="Source video file")
    parser.add_argument("--model", default="base.en",
                        choices=["tiny.en", "base.en", "medium.en", "large"],
                        help="Whisper model for filler detection")
    args = parser.parse_args()

    require_file(args.input)

    # ── Trim spec path ────────────────────────────────────────────────────────
    if is_trim_spec(args.input):
        spec = load_spec(args.input)
        source = spec["input"]
        keeps = spec["keeps"]

        # Extract audio at keep ranges into a temporary WAV, then transcribe
        fd, tmp_wav = tempfile.mkstemp(suffix=".wav", prefix="rmfil_")
        os.close(fd)
        try:
            run(audio_extract_cmd(source, keeps, tmp_wav))
            words = transcribe_words(tmp_wav, args.model)
        finally:
            if os.path.exists(tmp_wav):
                os.unlink(tmp_wav)

        # Remap word timestamps from joined-audio timeline → original timeline
        remapped = []
        for w in words:
            remapped.append({
                "text": w["text"],
                "start": remap_timestamp(w["start"], keeps),
                "end":   remap_timestamp(w["end"],   keeps),
            })

        # Identify filler cuts in original timeline
        filler_cuts = []
        non_filler_words = []
        for w in remapped:
            text = w["text"].strip(".,!?")
            if FILLERS.match(text):
                filler_cuts.append([w["start"], w["end"]])
            else:
                non_filler_words.append(w)

        # Snap head: move keeps[0][0] to just before first non-filler word
        if non_filler_words and keeps:
            first_onset = non_filler_words[0]["start"]
            if keeps[0][0] < first_onset:
                keeps = list(keeps)  # make mutable copy
                keeps[0] = [max(0.0, first_onset - HEAD_PAD), keeps[0][1]]

        refined = merge_keeps(keeps, filler_cuts)
        print(json.dumps({"input": source, "keeps": refined}))
        return

    # ── Raw video path ────────────────────────────────────────────────────────
    duration = get_duration(args.input)
    words = transcribe_words(args.input, args.model)

    filler_cuts = []
    non_filler_words = []
    for w in words:
        text = w["text"].strip(".,!?")
        if FILLERS.match(text):
            filler_cuts.append([w["start"], w["end"]])
        else:
            non_filler_words.append(w)

    head = max(0.0, non_filler_words[0]["start"] - HEAD_PAD) if non_filler_words else 0.0

    # Merge filler ranges closer than 50ms
    filler_cuts.sort()
    merged = []
    for s, e in filler_cuts:
        if merged and s - merged[-1][1] < 0.05:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])

    # Compute keep ranges starting from first-word onset
    keeps = []
    pos = head
    for s, e in merged:
        if s - pos > 0.05:
            keeps.append([pos, s])
        pos = e
    if duration - pos > 0.05:
        keeps.append([pos, duration])

    if not keeps:
        keeps = [[head, duration]]

    print(json.dumps({"input": args.input, "keeps": keeps}))


if __name__ == "__main__":
    main()
