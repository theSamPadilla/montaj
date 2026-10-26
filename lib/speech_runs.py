"""A take transcribed by VOICED RUN (PL89 A1), not as one long file.

whisper.cpp over a whole take loses words and times. Back-to-back retakes ("It's called PhoneBot, it's about 19
inches tall" said four times in a row) come out as one sentence with its words spread over all four sayings, and its
times drift by seconds: a sentence squashed to one instant 8 s before its sound, a take's first words 1.3 s early
because whisper starts its text at 0.0 while the voice starts at 1.3 s. Transcribing each voiced run as its own clip
matched the audio run for run (137 syllables heard in the transcript to 135 in the audio, 312 to 304, 123 to 126), in
6 to 25 s a take. Cutting the silence out and transcribing the joined voice was worse: whisper merged takes and
dropped lines.

1. `voiced_runs` is lib/speech_energy's layer 1 (where the sound is), less the runs under BLIP_S of voice.
2. `transcribe_runs` cuts one 16 kHz mono clip a run, [start - CONTEXT_S, end + PAD_S], and gives ALL the clips to
   whisper-cli in ONE call (the model loads once; BATCH clips at most to a call, for the command line's length on
   Windows). "auto" is detected once, on the longest run, so tiny clips cannot each guess another language.
3. A clip's words are the ones at or after its run's start (less PAD_S): the words before are the context, which the
   run before holds. Their times are mapped to the source's clock and clamped into the run, in order. A run of under
   HALLUCINATION_RUN_S whose words are only a stock phrase whisper writes on a blip ("Thank you.") has none.
4. The file is whisper's own shape (`transcription[]`, one word an entry, offsets in ms) with `run` on each word and
   `montaj.by == "runs"` with `montaj.runs`, the runs themselves, so every reader still works. `runs_of`, `run_of` and
   `is_full_file_montaj` read it back.

A take with no voiced run (silence, music) is not transcribed here: the result says `fell_back`, and the caller does
the full-file run it always did.
"""
import json
import os
import re
import shutil
import tempfile
import wave
from pathlib import Path

from lib.common import fail, ff_path, ffmpeg_bin, find_whisper_bin, run, run_whisper
from lib import speech_energy

VERSION = "speech-runs v1"
BLIP_S = 0.1                     # a run with less voice than this is a blip: no clip (whisper writes "Thank you." on it)
CONTEXT_S = 1.5                  # a clip opens this long before its run, so a lone word keeps its context ...
PAD_S = 0.2                      # ... and ends this long after it
BATCH = 40                       # clips to one whisper-cli call (the command line's length on Windows)
HALLUCINATION_RUN_S = 0.6        # a run shorter than this whose words are only a stock phrase has none
HALLUCINATIONS = ("thank you", "thanks for watching", "you", "bye")
INAUDIBLE_S = speech_energy.INAUDIBLE_S     # a word of no length is given this long
RATE = speech_energy.RATE
DECODE_TIMEOUT_S = speech_energy.DECODE_TIMEOUT_S
_SPECIAL = re.compile(r"^\s*\[_.*_\]\s*$")  # whisper's own markers ([_BEG_], [_TT_42]): not words
_FLAGS = ["--split-on-word", "--max-len", "1", "--output-json", "-mc", "0", "-np"]   # steps/speech/transcribe.py's


def voiced_runs(media, max_pause=speech_energy.DEFAULT_MAX_PAUSE_S):
    """[(start, end)] seconds of the voiced runs of `media` (lib/speech_energy layer 1), without the blips."""
    lay = speech_energy.layer1(media, speech_energy.envelope(media), max_pause)
    return [(float(a), float(b)) for a, b in lay.voiced if b - a >= BLIP_S]


def _srt_ts(ms):
    return f"{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}"


def _write_srt(entries, path):
    """One cue per word (steps/speech/transcribe._write_srt)."""
    cues = [e for e in entries if (e.get("text") or "").strip()]
    # a take with voice and no words is a valid empty file: one newline, since the step refuses a zero-byte output
    Path(path).write_text("".join(
        f"{n}\n{_srt_ts(e['offsets']['from'])} --> {_srt_ts(e['offsets']['to'])}\n{e['text'].strip()}\n\n"
        for n, e in enumerate(cues, 1)) or "\n")


def _decode(media, wav_path):
    """The first audio stream of `media` as 16 kHz mono 16-bit PCM."""
    r = run([ffmpeg_bin(), "-v", "error", "-y", "-i", ff_path(media), "-map", "0:a:0", "-vn", "-ar", str(RATE),
             "-ac", "1", "-c:a", "pcm_s16le", wav_path], timeout=DECODE_TIMEOUT_S, check=False)
    if r.returncode != 0:
        fail("transcription_failed", f"Reading the audio of {os.path.basename(media)} failed.")


def _clip_spans(runs, total):
    return [(max(0.0, a - CONTEXT_S), min(total, b + PAD_S)) for a, b in runs]


def _write_clips(wav_path, spans, folder):
    """run-<index>.wav in `folder` for each (start, end) of `spans`; the list of their paths."""
    out = []
    with wave.open(wav_path, "rb") as src:
        rate, width, total = src.getframerate(), src.getsampwidth(), src.getnframes()
        for i, (a, b) in enumerate(spans):
            lo = min(total, int(round(a * rate)))
            hi = min(total, max(lo + 1, int(round(b * rate))))
            src.setpos(lo)
            data = src.readframes(hi - lo)
            path = os.path.join(folder, f"run-{i:03d}.wav")
            with wave.open(path, "wb") as dst:
                dst.setnchannels(1)
                dst.setsampwidth(width)
                dst.setframerate(rate)
                dst.writeframes(data)
            out.append(path)
    return out


def _whisper(base, clips, spans_of, language):
    """One whisper-cli call over `clips` (the guard told their summed length). Each clip's `<clip>.json`, parsed."""
    cmd = list(base) + ["-l", language] + [x for c in clips for x in ("-f", c)]
    total = sum(spans_of[c][1] - spans_of[c][0] for c in clips)
    run_whisper(cmd, clips[0], check=True, duration_s=total)
    out = {}
    for c in clips:
        try:
            out[c] = json.loads(Path(c + ".json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            fail("transcription_failed", "whisper.cpp wrote no transcript for one of the voiced runs.")
    return out


def _norm(text):
    return " ".join(re.sub(r"[^\w\s]", "", text.lower()).split())


def _clamp(words, lo, hi):
    """[(text, start, end)] in order, each inside [lo, hi], none starting before the one before ends, each at least
    INAUDIBLE_S long (the run is always longer than the words it holds)."""
    out, prev = [], lo
    for t, s, e in words:
        s = max(s, lo, prev)
        e = max(e, s + INAUDIBLE_S)
        out.append([t, s, e])
        prev = e
    limit = hi
    for w in reversed(out):                       # nothing past the run's end: pull the last words back, in order
        w[2] = min(w[2], limit)
        w[1] = min(w[1], w[2] - INAUDIBLE_S)
        limit = w[1]
    return [tuple(w) for w in out]


def _words_of_run(doc, clip_start, run):
    """[(text, start, end)] on the source's clock: the clip's words from the run's start (less PAD_S) on, clamped."""
    lo, hi = run
    got = []
    for e in doc.get("transcription", []):
        text = e.get("text") or ""
        o = e.get("offsets") or {}
        if not text.strip() or _SPECIAL.match(text) or "from" not in o or "to" not in o:
            continue
        s, t = clip_start + o["from"] / 1000.0, clip_start + o["to"] / 1000.0
        if (s + t) / 2 >= lo - PAD_S:
            got.append((text, s, t))
    return _clamp(got, lo, hi)


def _hallucination(words, run):
    """A run of under HALLUCINATION_RUN_S whose words are only a stock phrase ("Thank you.") or made up (lib/
    speech_units.made_up, as speech_repair reads it)."""
    if run[1] - run[0] >= HALLUCINATION_RUN_S or not words:
        return False
    from lib.speech_units import made_up
    return _norm(" ".join(t for t, _, _ in words)) in HALLUCINATIONS or made_up(
        [{"text": t, "start": s, "end": e} for t, s, e in words])


def transcribe_runs(media, out_prefix, model, language):
    """Transcribe `media` run by run (see the module docstring) and write `<out_prefix>.json` and `.srt`. `model` is
    the weight's path. {"words", "srt", "runs"}; with no voiced run nothing is written and {"fell_back": True,
    "runs": 0} says so."""
    runs = voiced_runs(media)
    if not runs:
        return {"fell_back": True, "runs": 0}
    whisper_bin = find_whisper_bin()
    base = [whisper_bin, "-m", model] + _FLAGS
    tmp = tempfile.mkdtemp(prefix="montaj-runs-")
    try:
        wav = os.path.join(tmp, "source.wav")
        _decode(media, wav)
        with wave.open(wav, "rb") as w:
            total = w.getnframes() / float(w.getframerate())
        spans = _clip_spans(runs, total)
        clips = _write_clips(wav, spans, tmp)
        spans_of = dict(zip(clips, spans))
        if language == "auto":
            longest = max(range(len(runs)), key=lambda i: runs[i][1] - runs[i][0])
            probe = [whisper_bin, "-m", model, "--output-json", "-mc", "0", "-np"]
            doc = _whisper(probe, [clips[longest]], spans_of, "auto")[clips[longest]]
            language = ((doc.get("result") or {}).get("language") or "").strip() or "auto"
        docs = {}
        for i in range(0, len(clips), BATCH):
            docs.update(_whisper(base, clips[i:i + BATCH], spans_of, language))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    entries = []
    for i, (run_, clip) in enumerate(zip(runs, clips)):
        words = _words_of_run(docs[clip], spans[i][0], run_)
        if _hallucination(words, run_):
            continue
        for t, s, e in words:
            a, b = int(round(s * 1000)), int(round(e * 1000))
            entries.append({"text": t, "offsets": {"from": a, "to": b},
                            "timestamps": {"from": _srt_ts(a), "to": _srt_ts(b)}, "run": i})
    first = docs[clips[0]]
    data = {k: first[k] for k in ("systeminfo", "model", "params", "result") if k in first}
    data["transcription"] = entries
    data["montaj"] = {"input": "file", "offsets": "source", "timestamps": "source", "srt": "source", "by": "runs",
                      "runs": [[round(a, 3), round(b, 3)] for a, b in runs], "version": VERSION}
    words_path, srt_path = f"{out_prefix}.json", f"{out_prefix}.srt"
    Path(words_path).write_text(json.dumps(data), encoding="utf-8")
    _write_srt(entries, srt_path)
    return {"words": words_path, "srt": srt_path, "runs": len(runs), "fell_back": False}


# ── reading it back (lane A2 reads runs_of and run_of: names and shapes are fixed) ──────────────────────────────

def _montaj_block(sidecar_path):
    try:
        with open(sidecar_path, encoding="utf-8") as f:
            block = json.load(f).get("montaj")
    except (OSError, ValueError, AttributeError):
        return None
    return block if isinstance(block, dict) else None


def runs_of(sidecar_path):
    """[(start, end)] the sidecar was transcribed by, or None when it is not a by-runs transcript."""
    block = _montaj_block(sidecar_path)
    if not block or block.get("by") != "runs":
        return None
    try:
        return [(float(a), float(b)) for a, b in block.get("runs") or []]
    except (TypeError, ValueError):
        return None


def run_of(words, runs):
    """The index of the run each loaded Word stands in (by its midpoint), None for a word outside every run; None
    when `runs` is None."""
    if runs is None:
        return None
    out = []
    for w in words:
        mid = (w.start + w.end) / 2
        out.append(next((i for i, (a, b) in enumerate(runs) if a - 1e-3 <= mid <= b + 1e-3), None))
    return out


def is_full_file_montaj(sidecar_path):
    """True for montaj's own older full-file transcript: a `montaj` block whose input is "file" or "spec" and that is
    not by runs. A person's own file (no block) is False."""
    block = _montaj_block(sidecar_path)
    return bool(block) and block.get("input") in ("file", "spec") and block.get("by") != "runs"
