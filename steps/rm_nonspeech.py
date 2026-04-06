#!/usr/bin/env python3
"""Remove non-speech regions using whisper word-level timestamps — outputs a trim spec, no encode."""
import json, os, sys, argparse, shutil, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import require_file, get_duration, transcribe_words, run
from trim_spec import is_trim_spec, load as load_spec, merge as merge_keeps, audio_extract_cmd, remap_timestamp

def main():
    parser = argparse.ArgumentParser(description="Remove non-speech regions from a video")
    parser.add_argument("--input", required=True, help="Source video file or trim spec JSON")
    parser.add_argument("--model", default="base",
                        help="Whisper model for speech detection")
    parser.add_argument("--max-word-gap", type=float, default=0.18,
                        help="Max gap between words to bridge in seconds (default: 0.18)")
    parser.add_argument("--sentence-edge", type=float, default=0.10,
                        help="Padding around sentence edges in seconds (default: 0.10)")
    args = parser.parse_args()

    require_file(args.input)

    # ── trim spec path ────────────────────────────────────────────────────────
    if is_trim_spec(args.input):
        spec = load_spec(args.input)
        source = spec["input"]
        keeps = spec["keeps"]

        work = tempfile.mkdtemp(prefix="nonspeech_")
        try:
            tmp_wav = os.path.join(work, "extracted.wav")
            run(audio_extract_cmd(source, keeps, tmp_wav))

            words = transcribe_words(tmp_wav, args.model, work_dir=work)

            # Build speech regions in the extracted-audio timeline, then remap
            seg_regions = []
            for w in words:
                start, end = w["start"], w["end"]
                if not seg_regions:
                    seg_regions.append({"start": start, "end": end})
                else:
                    gap = start - seg_regions[-1]["end"]
                    if gap <= args.max_word_gap:
                        seg_regions[-1]["end"] = end
                    else:
                        seg_regions[-1]["end"] += args.max_word_gap / 2
                        seg_regions.append({"start": start - args.max_word_gap / 2, "end": end})
            if seg_regions:
                seg_regions[0]["start"] = max(0, seg_regions[0]["start"] - args.sentence_edge)
                seg_regions[-1]["end"] += args.sentence_edge

            if not seg_regions:
                # No speech detected — keep everything as-is
                print(json.dumps({"input": source, "keeps": keeps}))
                return

            # Speech regions are "keeps in extracted timeline"; invert to get cuts
            # in extracted timeline, then remap each cut boundary to source timeline
            speech_keeps_extracted = [[r["start"], r["end"]] for r in seg_regions]

            # Remap speech keep boundaries back to source timeline
            nonspeech_cuts = []
            prev_end_src = keeps[0][0]  # start of first keep segment in source
            for sk_s, sk_e in speech_keeps_extracted:
                cut_start_src = remap_timestamp(sk_s, keeps)
                # The gap before this speech region in extracted timeline maps to a cut
                # We need the end of the previous speech region in source timeline
                nonspeech_cuts.append([prev_end_src, cut_start_src])
                prev_end_src = remap_timestamp(sk_e, keeps)
            # Any trailing gap after last speech region
            nonspeech_cuts.append([prev_end_src, keeps[-1][1]])

            # Filter out zero/negative-length cuts
            nonspeech_cuts = [[s, e] for s, e in nonspeech_cuts if e > s]

            refined = merge_keeps(keeps, nonspeech_cuts)
        finally:
            shutil.rmtree(work, ignore_errors=True)

        print(json.dumps({"input": source, "keeps": refined}))
        return

    # ── Raw video path ────────────────────────────────────────────────────────
    work = tempfile.mkdtemp(prefix="nonspeech_")
    try:
        words = transcribe_words(args.input, args.model, work_dir=work)

        seg_regions = []
        for w in words:
            start, end = w["start"], w["end"]
            if not seg_regions:
                seg_regions.append({"start": start, "end": end})
            else:
                gap = start - seg_regions[-1]["end"]
                if gap <= args.max_word_gap:
                    seg_regions[-1]["end"] = end
                else:
                    seg_regions[-1]["end"] += args.max_word_gap / 2
                    seg_regions.append({"start": start - args.max_word_gap / 2, "end": end})
        if seg_regions:
            seg_regions[0]["start"] = max(0, seg_regions[0]["start"] - args.sentence_edge)
            seg_regions[-1]["end"] += args.sentence_edge
    finally:
        shutil.rmtree(work, ignore_errors=True)

    if not seg_regions:
        duration = get_duration(args.input)
        print(json.dumps({"input": args.input, "keeps": [[0.0, duration]]}))
        return

    keeps = [[r["start"], r["end"]] for r in seg_regions]
    print(json.dumps({"input": args.input, "keeps": keeps}))

if __name__ == "__main__":
    main()
