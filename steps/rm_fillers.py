#!/usr/bin/env python3
"""Remove filler words (um, uh, etc.) — single-pass filter_complex, no boundary artifacts.
Also trims pre-speech noise at the head by snapping the start to the first word onset."""
import json, os, re, sys, argparse, shutil, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run, get_duration, transcribe_words
from trim_spec import is_trim_spec, load as load_spec, merge as merge_keeps, audio_extract_cmd, remap_timestamp

FILLERS = re.compile(r"^(um|uh|uhh|umm|hmm|hm|ah|ahh|er|erm|mhm|uh-huh)$", re.IGNORECASE)
ENCODE_FLAGS = ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-r", "30"]
HEAD_PAD = 0.05   # seconds to keep before first word


def build_filter(keeps: list[tuple[float, float]]) -> str:
    n = len(keeps)
    parts = []
    # Split input streams so each trim gets its own pad (ffmpeg 8.0 forbids reusing [0:v])
    vs = "".join(f"[vs{i}]" for i in range(n))
    as_ = "".join(f"[as{i}]" for i in range(n))
    parts.append(f"[0:v]split={n}{vs}")
    parts.append(f"[0:a]asplit={n}{as_}")
    for i, (s, e) in enumerate(keeps):
        parts.append(f"[vs{i}]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS,fps=30[v{i}]")
        parts.append(f"[as{i}]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}]")
    concat_in = "".join(f"[v{i}][a{i}]" for i in range(n))
    parts.append(f"{concat_in}concat=n={n}:v=1:a=1[vout][aout_raw]")
    parts.append("[aout_raw]aresample=async=1000[aout]")
    return ";".join(parts)


def main():
    parser = argparse.ArgumentParser(description="Remove filler words from a clip")
    parser.add_argument("--input", required=True, help="Source video file")
    parser.add_argument("--model", default="base.en",
                        choices=["tiny.en", "base.en", "medium.en", "large"],
                        help="Whisper model for filler detection")
    parser.add_argument("--out", help="Output file path")
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

    # ── Legacy video encode path ──────────────────────────────────────────────
    duration = get_duration(args.input)
    out = args.out or f"{os.path.splitext(args.input)[0]}_rm_fillers.mp4"

    words = transcribe_words(args.input, args.model)

    # Identify filler word ranges
    bad_ranges = []
    for w in words:
        text = w["text"].strip(".,!?")
        if FILLERS.match(text):
            bad_ranges.append((w["start"], w["end"]))

    # Snap start to first word onset (removes pre-speech wind/noise at head)
    head = max(0.0, words[0]["start"] - HEAD_PAD) if words else 0.0

    if not bad_ranges:
        # No fillers — just trim the head if needed, simple encode
        if head < 0.01:
            shutil.copy2(args.input, out)
        else:
            run(["ffmpeg", "-y", "-i", args.input, "-ss", f"{head:.3f}", *ENCODE_FLAGS, out])
        check_output(out)
        print(out)
        return

    # Merge filler ranges closer than 50ms
    bad_ranges.sort()
    merged = [list(bad_ranges[0])]
    for s, e in bad_ranges[1:]:
        if s - merged[-1][1] < 0.05:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])

    # Compute keep ranges, starting from first-word onset
    keeps = []
    pos = head
    for s, e in merged:
        if s - pos > 0.05:
            keeps.append((pos, s))
        pos = e
    if duration - pos > 0.05:
        keeps.append((pos, duration))

    if not keeps:
        shutil.copy2(args.input, out)
        check_output(out)
        print(out)
        return

    # Single-pass filter_complex — no segment files, no concat-copy, no PTS gaps
    fd, fc_path = tempfile.mkstemp(suffix=".txt", prefix="rmfil_fc_")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(build_filter(keeps))
        run(
            ["ffmpeg", "-y", "-i", args.input,
             "-/filter_complex", fc_path,
             "-map", "[vout]", "-map", "[aout]",
             *ENCODE_FLAGS, out]
        )
    finally:
        if os.path.exists(fc_path):
            os.unlink(fc_path)

    check_output(out)
    print(out)


if __name__ == "__main__":
    main()
