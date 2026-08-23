#!/usr/bin/env python3
"""Remove filler words (um, uh, etc.) — outputs a trim spec, no encode.
Also trims pre-speech noise at the head by snapping the start to the first word onset."""
import json, os, re, sys, argparse, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, run, get_duration, transcribe_words
from trim_spec import is_trim_spec, load as load_spec, merge as merge_keeps, audio_extract_cmd, remap_timestamp, from_window

# Hesitation-sound fillers per language. Kept conservative: only non-lexical
# hesitations (never real words like Spanish "este"/"pues") so we don't cut
# meaningful speech. Falls back to the English set for unlisted languages.
_FILLERS_BY_LANG = {
    "en": r"^(um|uh|uhh|umm|hmm|hm|ah|ahh|er|erm|mhm|uh-huh)$",
    "es": r"^(eh|ehh|em|emm|mmm|mm|aam|am)$",
    "pt": r"^(eh|ehh|hum|hmm|né|aam|am)$",
    "fr": r"^(euh|heu|hum|hmm|ben|bah)$",
    "de": r"^(äh|ähm|öhm|hm|mhm)$",
}
HEAD_PAD = 0.05   # seconds to keep before first word


def _filler_matcher(language: str):
    lang = (language or "en").strip().lower().split("-")[0]
    return re.compile(_FILLERS_BY_LANG.get(lang, _FILLERS_BY_LANG["en"]), re.IGNORECASE)


def main():
    parser = argparse.ArgumentParser(description="Remove filler words from a clip")
    parser.add_argument("--input", required=True, help="Source video file")
    parser.add_argument("--model", default="base.en",
                        choices=["tiny.en", "base.en", "medium.en", "tiny", "base", "medium", "large", "large-v3"],
                        help="Whisper model for filler detection. English-only (*.en) models are "
                             "auto-upgraded to a multilingual sibling when --language is non-English.")
    parser.add_argument("--language", default="en",
                        help="Language code (e.g. es) for transcription and filler matching, or 'auto'.")
    parser.add_argument("--window-in", type=float,
                        help="Analyse only this window of --input (source seconds). Must be paired "
                             "with --window-out; routes through the trim-spec branch and additionally "
                             "emits `cuts` (the complement of `keeps` within the window, each filler "
                             "entry carrying the matched word as `text`) in the output.")
    parser.add_argument("--window-out", type=float,
                        help="End of the analysis window in source seconds. Must be paired with --window-in.")
    args = parser.parse_args()

    if (args.window_in is None) != (args.window_out is None):
        fail("invalid_args", "--window-in and --window-out must be used together")

    require_file(args.input)

    fillers = _filler_matcher(args.language)

    windowed = args.window_in is not None
    if windowed:
        spec = from_window(args.input, args.window_in, args.window_out)
    elif is_trim_spec(args.input):
        spec = load_spec(args.input)
    else:
        spec = None

    # ── Trim spec path ────────────────────────────────────────────────────────
    if spec is not None:
        source = spec["input"]
        keeps = spec["keeps"]

        # Extract audio at keep ranges into a temporary WAV, then transcribe
        fd, tmp_wav = tempfile.mkstemp(suffix=".wav", prefix="rmfil_")
        os.close(fd)
        try:
            run(audio_extract_cmd(source, keeps, tmp_wav))
            words = transcribe_words(tmp_wav, args.model, language=args.language)
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

        # Identify filler cuts in original timeline. filler_cuts stays a bare
        # [[start, end], ...] list — trim_spec.merge destructures plain pairs —
        # filler_cuts_with_text is a parallel, richer list carrying the matched
        # word, used only to build the windowed `cuts` output below.
        filler_cuts = []
        filler_cuts_with_text = []
        non_filler_words = []
        for w in remapped:
            text = w["text"].strip(".,!?")
            if fillers.match(text):
                filler_cuts.append([w["start"], w["end"]])
                filler_cuts_with_text.append({"start": w["start"], "end": w["end"], "text": w["text"]})
            else:
                non_filler_words.append(w)

        # Snap head: move keeps[0][0] to just before first non-filler word
        head_trim = None
        if non_filler_words and keeps:
            first_onset = non_filler_words[0]["start"]
            if keeps[0][0] < first_onset:
                old_start = keeps[0][0]
                keeps = list(keeps)  # make mutable copy
                new_start = max(0.0, first_onset - HEAD_PAD)
                keeps[0] = [new_start, keeps[0][1]]
                if new_start > old_start:
                    head_trim = [old_start, new_start]

        refined = merge_keeps(keeps, filler_cuts)
        result = {"input": source, "keeps": refined}
        if windowed:
            if head_trim:
                # head_trim already accounts for [head_start, head_end) — any
                # filler cut inside that span would otherwise double-report the
                # same audio as two separate `cuts` entries (and, worse, ticking
                # the filler one back off in the UI would silently do nothing,
                # since the head-trim entry still covers it). Drop entries
                # wholly inside the span; clip ones that straddle the boundary
                # down to their surviving remainder past head_end.
                head_start, head_end = head_trim
                cuts = []
                for c in filler_cuts_with_text:
                    if c["start"] >= head_end:
                        cuts.append(c)  # entirely after the head-trim span
                    elif c["end"] > head_end:
                        # Straddles the boundary — keep only the remainder.
                        cuts.append({"start": head_end, "end": c["end"], "text": c["text"]})
                    # else: wholly inside [head_start, head_end) — already
                    # covered by the head-trim entry below; drop it.
                cuts.append({"start": head_start, "end": head_end})
            else:
                cuts = list(filler_cuts_with_text)
            cuts.sort(key=lambda c: c["start"])
            result["cuts"] = [
                {k: (round(v, 4) if isinstance(v, float) else v) for k, v in c.items()}
                for c in cuts
            ]
        print(json.dumps(result))
        return

    # ── Raw video path ────────────────────────────────────────────────────────
    duration = get_duration(args.input)
    words = transcribe_words(args.input, args.model, language=args.language)

    filler_cuts = []
    non_filler_words = []
    for w in words:
        text = w["text"].strip(".,!?")
        if fillers.match(text):
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
