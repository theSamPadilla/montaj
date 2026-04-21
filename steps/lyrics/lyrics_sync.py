#!/usr/bin/env python3
"""Sync lyrics text to audio using Whisper word timestamps on clean vocals.
Outputs a caption track JSON with word-level timestamps grouped by lyric line.

Pipeline:
  1. Whisper on vocals.wav → word timestamps + rough transcript
  2. SequenceMatcher aligns original lyrics to Whisper words → inherit timestamps
  3. Unmatched lyric words are interpolated between neighbouring matched words

--start / --end override auto-detection of the lyrics window.
"""
import json, mimetypes, os, re, sys, tempfile, argparse
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import models as _models
from common import fail, require_file, check_output, run, find_whisper_bin


WHISPER_MODEL      = "base.en"
WINDOW_PRE_BUFFER  = 0.0
WINDOW_POST_BUFFER = 0.0


def normalize(word):
    return re.sub(r"[^a-z0-9']", "", word.lower())


def parse_lyrics(lyrics_path):
    groups = []
    for line in Path(lyrics_path).read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped:
            words = stripped.split()
            if words:
                groups.append(words)
    return groups


def whisper_words(audio_path, model_path, whisper_bin, tmp_prefix, language="en"):
    """Run Whisper word-level transcription. Returns [{word, start, end}]."""
    run([whisper_bin, "-m", model_path, "-f", audio_path, "-l", language,
         "--split-on-word", "--max-len", "1", "--output-json",
         "--output-file", tmp_prefix], check=False)
    words_path = f"{tmp_prefix}.json"
    if not os.path.exists(words_path):
        fail("whisper_failed", "Whisper did not produce output JSON")
    data = json.loads(Path(words_path).read_text())
    result = []
    for entry in data.get("transcription", []):
        text = entry.get("text", "").strip()
        if not text:
            continue
        offsets = entry.get("offsets", {})
        result.append({
            "word":  text,
            "start": offsets.get("from", 0) / 1000.0,
            "end":   offsets.get("to",   0) / 1000.0,
        })
    return result


def detect_window(w_words, lyrics_groups):
    """Find approximate lyrics window from Whisper word list.
    Returns (start, end) in seconds or (None, None).
    """
    flat_lyrics  = [w for group in lyrics_groups for w in group]
    whisper_norm = [normalize(w["word"]) for w in w_words]
    lyrics_norm  = [normalize(w) for w in flat_lyrics]

    matcher = SequenceMatcher(None, lyrics_norm, whisper_norm, autojunk=False)
    matched = [block.b + off
               for block in matcher.get_matching_blocks()
               for off in range(block.size)]

    if not matched:
        return None, None

    start = max(0.0, w_words[min(matched)]["start"] - WINDOW_PRE_BUFFER)
    end   = w_words[max(matched)]["end"] + WINDOW_POST_BUFFER
    return round(start, 1), round(end, 1)


def align(lyrics_groups, w_words):
    """Align lyric phrases to Whisper word timestamps.

    Matched words inherit Whisper's timestamps directly.
    Unmatched words are interpolated between neighbouring matched anchors.

    Returns [{text, start, end, words: [{word, start, end}]}]
    """
    flat_lyrics  = [(g, w) for g, group in enumerate(lyrics_groups) for w in group]
    whisper_norm = [normalize(w["word"]) for w in w_words]
    lyrics_norm  = [normalize(w) for _, w in flat_lyrics]

    matcher  = SequenceMatcher(None, lyrics_norm, whisper_norm, autojunk=False)
    lyr2whi  = {}
    for block in matcher.get_matching_blocks():
        for off in range(block.size):
            lyr2whi[block.a + off] = block.b + off

    # Build a flat list of (lyric_word, start, end) — interpolating gaps
    total = len(flat_lyrics)
    timed = [None] * total

    # Assign matched timestamps
    for li, wi in lyr2whi.items():
        timed[li] = (flat_lyrics[li][1],
                     round(w_words[wi]["start"], 3),
                     round(w_words[wi]["end"],   3))

    # Interpolate unmatched words between anchors
    i = 0
    while i < total:
        if timed[i] is None:
            # find previous and next anchors
            prev_i = i - 1
            while prev_i >= 0 and timed[prev_i] is None:
                prev_i -= 1
            next_i = i + 1
            while next_i < total and timed[next_i] is None:
                next_i += 1

            # determine time boundaries for the gap
            gap_start = timed[prev_i][1] if prev_i >= 0 else 0.0
            gap_end   = timed[next_i][1] if next_i < total else (
                timed[prev_i][2] if prev_i >= 0 else 0.0)

            gap_words = list(range(i, next_i if next_i < total else total))
            n = len(gap_words)
            step = (gap_end - gap_start) / (n + 1) if n > 0 else 0

            for k, idx in enumerate(gap_words):
                word_start = round(gap_start + step * (k + 1), 3)
                word_end   = round(gap_start + step * (k + 2), 3)
                timed[idx] = (flat_lyrics[idx][1], word_start, word_end)
            i = next_i if next_i < total else total
        else:
            i += 1

    # Re-group by lyric phrase
    segments = []
    li = 0
    for group in lyrics_groups:
        n = len(group)
        phrase = timed[li:li + n]
        li += n
        phrase = [p for p in phrase if p is not None]
        if not phrase:
            continue
        words = [{"word": w, "start": s, "end": e} for w, s, e in phrase]
        segments.append({
            "text":  " ".join(w["word"] for w in words),
            "start": words[0]["start"],
            "end":   words[-1]["end"],
            "words": words,
        })
    return segments


def main():
    parser = argparse.ArgumentParser(
        description="Sync lyrics to audio using Whisper timestamps on clean vocals.")
    parser.add_argument("--input",   required=True,
                        help="Vocals WAV (output of stem_separation --stems vocals) or any audio/video")
    parser.add_argument("--lyrics",  required=True, help="Lyrics text file (one phrase per line)")
    parser.add_argument("--model",   default=WHISPER_MODEL,
                        choices=["tiny.en", "base.en", "medium.en", "large"],
                        help="Whisper model (default: base.en). medium.en improves window detection on noisy audio.")
    parser.add_argument("--language", default="en", help="Language code passed to Whisper (default: en)")
    parser.add_argument("--start",   type=float, default=None,
                        help="Override: start time in seconds (skips auto-detection)")
    parser.add_argument("--end",     type=float, default=None,
                        help="Override: end time in seconds (skips auto-detection)")
    parser.add_argument("--out",     help="Output caption track JSON path")
    args = parser.parse_args()

    require_file(args.input)
    require_file(args.lyrics)

    whisper_bin = find_whisper_bin()
    model_path  = _models.model_path("whisper", f"ggml-{args.model}.bin")
    require_file(model_path)

    out = args.out or f"{os.path.splitext(args.input)[0]}_lyrics.json"

    lyrics_groups = parse_lyrics(args.lyrics)
    if not lyrics_groups:
        fail("empty_lyrics", "Lyrics file is empty or has no content")

    # Convert video → wav if needed
    mime      = mimetypes.guess_type(args.input)[0] or ""
    tmp_audio = None
    audio_in  = args.input
    if mime.startswith("video/"):
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        tmp_audio = tmp.name
        run(["ffmpeg", "-y", "-i", args.input, "-vn", "-acodec", "pcm_s16le",
             "-ar", "16000", "-ac", "1", tmp_audio])
        audio_in = tmp_audio

    with tempfile.TemporaryDirectory(prefix="montaj_lyrics_") as tmp_dir:
        # Step 1: Whisper on full audio for window detection + timestamps
        print("→ running Whisper on vocals…", file=sys.stderr)
        w_words = whisper_words(audio_in, model_path, whisper_bin,
                                os.path.join(tmp_dir, "whisper_full"), args.language)

        if not w_words:
            fail("no_words", "Whisper returned no words")

        # Step 2: detect window unless overridden
        start = args.start
        end   = args.end
        if start is None or end is None:
            detected_start, detected_end = detect_window(w_words, lyrics_groups)
            if detected_start is None:
                print("  warning: window detection failed, using full audio", file=sys.stderr)
            else:
                print(f"  detected window: {detected_start}s – {detected_end}s", file=sys.stderr)
                if start is None:
                    start = detected_start
                if end is None:
                    end = detected_end

        # Step 3: filter Whisper words to the detected window
        if start is not None or end is not None:
            w_start = start or 0.0
            w_end   = end   or float("inf")
            w_words_window = [w for w in w_words
                              if w["end"] >= w_start and w["start"] <= w_end]
            # Re-zero timestamps relative to window start
            for w in w_words_window:
                w["start"] = round(w["start"] - w_start, 3)
                w["end"]   = round(w["end"]   - w_start, 3)
        else:
            w_words_window = w_words
            w_start = 0.0

        # Step 4: align lyrics to Whisper word timestamps
        segments = align(lyrics_groups, w_words_window)

    if not segments:
        fail("alignment_failed", "Could not align any lyrics phrases to the audio")

    if tmp_audio and os.path.exists(tmp_audio):
        os.unlink(tmp_audio)

    # audioInPoint: where in the source file the project t=0 maps to
    audio_in_point = round(w_start, 3)

    caption_track = {"segments": segments, "audioInPoint": audio_in_point}

    with open(out, "w") as f:
        json.dump(caption_track, f, indent=2)

    check_output(out)
    print(out)


if __name__ == "__main__":
    main()
