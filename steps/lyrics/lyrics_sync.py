#!/usr/bin/env python3
"""Sync lyrics text to audio using Whisper word timestamps on clean vocals.
Outputs a caption track JSON with word-level timestamps grouped by lyric line.

Pipeline:
  1. The vocals are decoded once and cut at quiet points into windows of up to
     30 s, all transcribed by one whisper-cli call → word timestamps (DTW word
     starts when the model has a preset)
  2. One in-order global alignment matches the lyrics to Whisper words → matched words inherit timestamps
  3. Unmatched lyric words are interpolated between neighbouring matched words

--start / --end override auto-detection of the lyrics window.
"""
import json, operator, os, re, sys, tempfile, argparse, wave
from array import array
from math import sqrt
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
import models as _models
from common import (fail, require_file, check_output, run, run_whisper, find_whisper_bin, ffmpeg_bin,
                    resolve_whisper_model, whisper_weight_path, DEFAULT_WHISPER_MODEL,
                    WHISPER_MODEL_CHOICES)


WHISPER_MODEL      = DEFAULT_WHISPER_MODEL
WINDOW_PRE_BUFFER  = 0.0
WINDOW_POST_BUFFER = 0.0


# Lyrics pasted from the web carry typographic apostrophes where whisper writes
# a straight one: "don’t" must still match "don't".
_APOSTROPHES = str.maketrans({"\u2019": "'", "\u2018": "'", "\u02bc": "'"})  # ’ ‘ ʼ


def normalize(word):
    # Unicode-aware: Cyrillic, accented and other letters survive. A token that
    # is all symbols or punctuation (♪, &, a dash) normalizes to '', and
    # _align_tokens never lets '' match anything. Curly apostrophes become
    # straight ones before the strip, which keeps them.
    # Apostrophes at the token's edges are quotation marks (‘love’), not part of
    # the word; goin' and 'cause lose theirs on both sides alike.
    return re.sub(r"[^\w']", "", word.translate(_APOSTROPHES).lower()).strip("'")


_SKIP_LYRIC, _DIAGONAL, _SKIP_WHISPER = 0, 1, 2


def _align_tokens(lyr_norm, whi_norm):
    """Align normalized lyric tokens to normalized Whisper tokens, in order.

    Semi-global Levenshtein with unit costs: every lyric word is consumed
    (matched, substituted or skipped), and Whisper words before the first or
    after the last aligned lyric word cost nothing. Only an exact match of a
    non-empty token becomes an anchor.

    On a tie the backtrack prefers skipping a lyric word over the diagonal
    (then over skipping a Whisper word), so when the lyrics hold more copies of
    a passage than were sung, the earlier copies take the audio and the extra
    copy is the one left to interpolation.

    Pure Python, O(n*m) time; one byte per cell for the backtrack.
    Returns {lyric_idx: whisper_idx}, one entry per anchor.
    """
    n, m = len(lyr_norm), len(whi_norm)
    if n == 0 or m == 0:
        return {}

    prev  = [0] * (m + 1)          # row 0: leading Whisper words are free
    moves = []                      # moves[i-1][j]: the step taken into cell (i, j)
    for i in range(1, n + 1):
        tok  = lyr_norm[i - 1]
        cur  = [i] * (m + 1)        # column 0: i lyric words skipped
        move = bytearray(m + 1)     # 0 == _SKIP_LYRIC
        left = i
        for j in range(1, m + 1):
            best = prev[j] + 1                                   # skip this lyric word
            diag = prev[j - 1] + (0 if tok and tok == whi_norm[j - 1] else 1)
            if diag < best:
                best = diag
                move[j] = _DIAGONAL
            if left + 1 < best:                                  # skip this Whisper word
                best = left + 1
                move[j] = _SKIP_WHISPER
            cur[j] = left = best
        moves.append(move)
        prev = cur

    # Trailing Whisper words are free: end on the cheapest column, the earliest on a tie.
    j = min(range(m + 1), key=prev.__getitem__)
    i = n
    anchors = {}
    while i > 0 and j > 0:
        step = moves[i - 1][j]
        if step == _DIAGONAL:
            tok = lyr_norm[i - 1]
            if tok and tok == whi_norm[j - 1]:
                anchors[i - 1] = j - 1
            i -= 1
            j -= 1
        elif step == _SKIP_LYRIC:
            i -= 1
        else:
            j -= 1
    return anchors


def parse_lyrics(lyrics_path):
    groups = []
    for line in Path(lyrics_path).read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped:
            words = stripped.split()
            if words:
                groups.append(words)
    return groups


# ── Windowed transcription ────────────────────────────────────────────────────
# Whisper run over a whole song loops (578 words for a 251-word lyric sheet)
# and loses the intro, so the song goes to whisper in windows of up to 30 s,
# cut where the vocal stem is quietest. The constants are the measured rule
# (PL7): do not tighten the cut search, it was measured at [c+25, c+30] s.
SAMPLE_RATE    = 16000
FRAME          = 800          # 50 ms RMS frames at 16 kHz
SMOOTH_FRAMES  = 6            # the RMS is smoothed over 300 ms
CUT_SEARCH_S   = (25, 30)     # the next cut is the quietest point in [c+25, c+30) s
WINDOW_PAD_S   = 0.25         # a window reaches this far past each of its cuts
SILENCE_DBFS   = -45          # a window whose loudest 300 ms is below this is skipped
SEAM_DEDUPE_S  = 0.5          # at a seam, the same word again this soon is dropped

# whisper-cli's -dtw presets. "large" is ambiguous (v1, v2 or v3), so it has
# none and its words keep whisper's segment offsets.
_DTW_PRESETS = {
    "large-v3-turbo-q5_0": "large.v3.turbo", "large-v3-turbo": "large.v3.turbo",
    "large-v3": "large.v3", "large-v2": "large.v2", "large-v1": "large.v1",
    **{m: m for m in ("tiny", "base", "small", "medium",
                      "tiny.en", "base.en", "small.en", "medium.en")},
}


def _frame_rms(pcm):
    """RMS of each 50 ms frame of s16 samples, full scale = 1.0 (last frame may be short)."""
    mul, out = operator.mul, []
    for i in range(0, len(pcm), FRAME):
        fr = pcm[i:i + FRAME]
        out.append(sqrt(sum(map(mul, fr, fr)) / len(fr)) / 32768.0)
    return out


def _smooth(rms):
    """Value i is the mean frame RMS over the 300 ms centred on frame boundary i
    (frames i-3 .. i+2), fewer frames at the edges of the audio."""
    half, n = SMOOTH_FRAMES // 2, len(rms)
    out = []
    for i in range(n):
        a, b = max(0, i - half), min(n, i + half)
        out.append(sum(rms[a:b]) / (b - a))
    return out


def quiet_cuts(rms, n_samples):
    """Cut points in samples: 0, then from each cut c the centre of the
    quietest 300 ms in [c+25, c+30) s, until the audio ends within 30 s of the
    last cut; then ``n_samples``. ``rms`` is the 50 ms frame RMS."""
    sm = _smooth(rms)
    lo_f = CUT_SEARCH_S[0] * SAMPLE_RATE // FRAME
    hi_f = CUT_SEARCH_S[1] * SAMPLE_RATE // FRAME
    cuts = [0]
    while cuts[-1] + CUT_SEARCH_S[1] * SAMPLE_RATE < n_samples:
        c = cuts[-1] // FRAME
        search = range(c + lo_f, min(c + hi_f, len(sm)))
        if not search:
            break
        cuts.append(min(search, key=sm.__getitem__) * FRAME)
    cuts.append(n_samples)
    return cuts


def _decode(audio_in, wav_path):
    """Decode any audio or video input once to 16 kHz mono s16 WAV. Returns
    (raw little-endian bytes, samples)."""
    run([ffmpeg_bin(), "-y", "-i", audio_in, "-vn", "-acodec", "pcm_s16le",
         "-ar", str(SAMPLE_RATE), "-ac", "1", wav_path])
    with wave.open(wav_path, "rb") as w:
        raw = w.readframes(w.getnframes())
    pcm = array("h")
    pcm.frombytes(raw)
    return raw, pcm


def _write_window(path, raw, a, b):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(raw[2 * a:2 * b])


def _run_whisper_windows(windows, model_path, whisper_bin, audio_path, language, dtw):
    """One whisper-cli call over every window (one model load). Returns
    (CompletedProcess, True when every window's JSON was written)."""
    cmd = [whisper_bin, "-m", model_path, "-l", language,
           "--split-on-word", "--max-len", "1", "--output-json"]
    if dtw:
        # DTW needs flash attention off: with it on, every t_dtw is -1.
        cmd += ["-ojf", "-dtw", dtw, "-nfa"]
    for win in windows:
        cmd += ["-f", win["wav"], "-of", win["prefix"]]
        if os.path.exists(win["prefix"] + ".json"):
            os.unlink(win["prefix"] + ".json")
    r = run_whisper(cmd, audio_path)
    ok = r.returncode == 0 and all(os.path.exists(w["prefix"] + ".json") for w in windows)
    return r, ok


def _window_words(win, dtw):
    """The words of one window's JSON that start inside its own cuts, with
    times in samples of the full audio. A word starts at its first real
    token's DTW time, or at its segment offset when there is none."""
    # -ojf token text can split a multibyte character, so do not let that fail the read.
    try:
        data = json.loads(Path(win["prefix"] + ".json").read_text(encoding="utf-8", errors="replace"),
                          strict=False)
    except ValueError:
        fail("whisper_failed", "whisper wrote JSON that could not be read")
    base, out = win["start"], []
    for entry in data.get("transcription", []):
        text = entry.get("text", "").strip()
        if not text:
            continue
        offsets = entry.get("offsets", {})
        start = base + offsets.get("from", 0) * SAMPLE_RATE // 1000
        end   = base + offsets.get("to",   0) * SAMPLE_RATE // 1000
        if dtw:
            tok = next((t for t in entry.get("tokens", [])
                        if not str(t.get("text", "")).startswith("[_")), None)
            t_dtw = tok.get("t_dtw", -1) if tok else -1
            if isinstance(t_dtw, (int, float)) and t_dtw >= 0:
                start = base + int(t_dtw * SAMPLE_RATE // 100)      # t_dtw is in 10 ms units
        if win["lo"] <= start < win["hi"]:
            out.append({"word": text, "start": start, "end": max(end, start)})
    return out


def transcribe_windows(audio_in, model, model_path, whisper_bin, tmp_dir, language="en"):
    """Whisper word timestamps for the whole input: [{word, start, end}] in
    absolute seconds.

    The input is decoded once, cut at quiet points into windows of up to
    30.5 s (see quiet_cuts), and every window that is not silent goes to one
    whisper-cli call. Each word is kept only by the window whose cuts hold its
    start. A model with a DTW preset gets DTW word starts; if that run fails
    or leaves a window without JSON, it runs once more without DTW.
    """
    full = os.path.join(tmp_dir, "audio.wav")
    raw, pcm = _decode(audio_in, full)
    n = len(pcm)
    rms = _frame_rms(pcm)
    del pcm
    cuts = quiet_cuts(rms, n)
    sm = _smooth(rms)

    floor = 10 ** (SILENCE_DBFS / 20)
    pad = int(WINDOW_PAD_S * SAMPLE_RATE)
    windows, silent = [], 0
    for k, (lo, hi) in enumerate(zip(cuts, cuts[1:])):
        loudness = sm[lo // FRAME:-(-hi // FRAME)]
        if not loudness or max(loudness) < floor:
            silent += 1
            continue
        a, b = max(0, lo - pad), min(n, hi + pad)
        wav = os.path.join(tmp_dir, f"window_{k:03d}.wav")
        _write_window(wav, raw, a, b)
        windows.append({"start": a, "lo": lo, "hi": hi, "wav": wav, "prefix": wav[:-4]})
    del raw

    words = []
    if windows:
        dtw = _DTW_PRESETS.get(model)
        r, ok = _run_whisper_windows(windows, model_path, whisper_bin, full, language, dtw)
        if not ok and dtw:
            print("  whisper-cli could not run with DTW word timing; running it again without DTW",
                  file=sys.stderr)
            dtw = None
            r, ok = _run_whisper_windows(windows, model_path, whisper_bin, full, language, dtw)
        if not ok:
            fail("whisper_failed",
                 f"Whisper did not produce output JSON (exit {r.returncode}): {r.stderr[-2000:]}")

        for win in windows:
            seam = bool(words)
            for w in _window_words(win, dtw):
                if seam:
                    # Safety net at a seam only: the same word again within 0.5 s
                    # is the neighbouring window's copy. Repeats inside a window stay.
                    seam = False
                    prev, norm = words[-1], normalize(w["word"])
                    if (norm and norm == normalize(prev["word"])
                            and w["start"] - prev["start"] < SEAM_DEDUPE_S * SAMPLE_RATE):
                        continue
                words.append(w)

    print(f"  whisper words: {len(words)}, windows: {len(windows)} ({silent} silent, skipped)",
          file=sys.stderr)
    return [{"word":  w["word"],
             "start": round(w["start"] / SAMPLE_RATE, 3),
             "end":   round(w["end"] / SAMPLE_RATE, 3)} for w in words]


def detect_window(w_words, lyrics_groups):
    """Find approximate lyrics window from Whisper word list.
    Returns (start, end) in seconds or (None, None).
    """
    flat_lyrics  = [w for group in lyrics_groups for w in group]
    whisper_norm = [normalize(w["word"]) for w in w_words]
    lyrics_norm  = [normalize(w) for w in flat_lyrics]

    matched = list(_align_tokens(lyrics_norm, whisper_norm).values())

    if not matched:
        return None, None

    start = max(0.0, w_words[min(matched)]["start"] - WINDOW_PRE_BUFFER)
    end   = w_words[max(matched)]["end"] + WINDOW_POST_BUFFER
    return round(start, 1), round(end, 1)


def align(lyrics_groups, w_words):
    """Align lyric phrases to Whisper word timestamps.

    Matched words inherit Whisper's timestamps directly.
    Unmatched words are interpolated between neighbouring matched anchors.

    Returns [{text, start, end, words: [{word, start, end}]}], or [] when no
    lyric word matches any Whisper word (main then fails alignment_failed).
    """
    flat_lyrics  = [(g, w) for g, group in enumerate(lyrics_groups) for w in group]
    whisper_norm = [normalize(w["word"]) for w in w_words]
    lyrics_norm  = [normalize(w) for _, w in flat_lyrics]

    lyr2whi = _align_tokens(lyrics_norm, whisper_norm)
    if not lyr2whi:
        return []

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
                        choices=list(WHISPER_MODEL_CHOICES),
                        help=f"Whisper model (default: {WHISPER_MODEL}). A model that is not "
                             "installed falls back to one that is.")
    parser.add_argument("--language", default="en", help="Language code passed to Whisper (default: en)")
    parser.add_argument("--start",   type=float, default=None,
                        help="Override: start time in seconds (skips auto-detection)")
    parser.add_argument("--end",     type=float, default=None,
                        help="Override: end time in seconds (skips auto-detection)")
    parser.add_argument("--out",     help="Output caption track JSON path")
    args = parser.parse_args()

    require_file(args.input)
    require_file(args.lyrics)

    model       = resolve_whisper_model(args.model, args.language)
    # Managed dir first, then the legacy whisper.cpp dir, as transcribe does.
    model_path  = whisper_weight_path(model) or _models.model_path("whisper", f"ggml-{model}.bin")
    require_file(model_path)
    whisper_bin = find_whisper_bin()

    out = args.out or f"{os.path.splitext(args.input)[0]}_lyrics.json"

    lyrics_groups = parse_lyrics(args.lyrics)
    if not lyrics_groups:
        fail("empty_lyrics", "Lyrics file is empty or has no content")

    with tempfile.TemporaryDirectory(prefix="montaj_lyrics_") as tmp_dir:
        # Step 1: Whisper over the whole input, in windows, for window detection + timestamps.
        # transcribe_windows decodes any audio or video input itself, once.
        print("→ running Whisper on vocals…", file=sys.stderr)
        w_words = transcribe_windows(args.input, model, model_path, whisper_bin,
                                     tmp_dir, args.language)

        if not w_words:
            fail("no_words", "No singing was found in the audio. Pass the vocals stem "
                             "from stem_separation (--stems vocals).")

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

    # audioInPoint: where in the source file the project t=0 maps to
    audio_in_point = round(w_start, 3)

    caption_track = {"segments": segments, "audioInPoint": audio_in_point}

    with open(out, "w") as f:
        json.dump(caption_track, f, indent=2)

    check_output(out)
    print(out)


if __name__ == "__main__":
    main()
