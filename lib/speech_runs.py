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
3. A clip is its run less PAD_S to its run plus PAD_S, with no context, except a run shorter than SHORT_RUN_S: it gets
   up to CONTEXT_S before it, so a lone word keeps its context. Whisper stamps a clip's opening words from the clip's
   own 0.0, so a time rule cannot tell them from context; a context clip drops its echo by TEXT instead: the longest
   run of its opening words equal, in order, to the last words of the runs before (their transcript), and with no
   such match only the words whose END lies before the run's start less PAD_S. Every other word is kept; its time
   is mapped to the source's clock and clamped into the run, in order. When the echo is the run's every word (a
   back-to-back short retake, "PhoneBot." said again), the words inside the run by time stay. A run of under
   HALLUCINATION_RUN_S with under VOICED_SHARE_MIN of its frames voiced, whose words are only a stock phrase whisper
   writes on little voice ("Thank you."), has none; never the source's first or last run (a real opening or "Bye!").
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
import subprocess
import tempfile
import threading
import wave
from pathlib import Path

from lib.common import (_absolute_whisper_paths, fail, ff_path, ffmpeg_bin, find_whisper_bin, quiet_failures, run,
                        run_whisper, whisper_language)
from lib import speech_energy, voice

VERSION = "speech-runs v1"
BLIP_S = 0.1                     # a run with less voice than this is a blip: no clip (whisper writes "Thank you." on it)
SHORT_RUN_S = 1.0                # a run shorter than this gets context before it ...
CONTEXT_S = 1.5                  # ... up to this long, so a lone word keeps its context
PAD_S = 0.2                      # every clip opens and ends this long beside its run
BATCH = 40                       # clips to one whisper-cli call (the command line's length on Windows)
HALLUCINATION_RUN_S = 0.6        # a run shorter than this whose words are only a stock phrase has none
HALLUCINATIONS = ("thank you", "thanks for watching", "you", "bye")
VOICED_SHARE_MIN = 0.3           # ... and under this share of its frames voiced (lib/voice): a stock phrase on little voice
INAUDIBLE_S = speech_energy.INAUDIBLE_S     # a word of no length is given this long
RATE = speech_energy.RATE
DECODE_TIMEOUT_S = speech_energy.DECODE_TIMEOUT_S
_SPECIAL = re.compile(r"^\s*\[_.*_\]\s*$")  # whisper's own markers ([_BEG_], [_TT_42]): not words
_FLAGS = ["--split-on-word", "--max-len", "1", "--output-json", "-mc", "0", "-np"]   # steps/speech/transcribe.py's


def voiced_runs(media, max_pause=speech_energy.DEFAULT_MAX_PAUSE_S):
    """[(start, end)] seconds of the voiced runs of `media` (lib/speech_energy layer 1, read with cut's own voice check,
    lib/voice), without the blips. By level alone a bump of no voice just before the voice opened the run, and the
    run's first word was clamped onto it, on no voice (real take D: a -47 dB bump 0.15 s early)."""
    return _runs_and_shares(media, max_pause)[0]


def _runs_and_shares(media, max_pause=speech_energy.DEFAULT_MAX_PAUSE_S):
    """(voiced_runs, the share of each run's frames lib/voice reads as voiced, or None with no voice check)."""
    env = speech_energy.envelope(media)
    lay = speech_energy.layer1(media, env, max_pause, spectral=voice.flags(media, len(env)))
    runs = [(float(a), float(b)) for a, b in lay.voiced if b - a >= BLIP_S]
    if lay.voice is None:
        return runs, [None] * len(runs)
    shares = []
    for a, b in runs:
        k0 = int(round(a / speech_energy.FRAME_S))
        k1 = max(int(round(b / speech_energy.FRAME_S)), k0 + 1)
        fr = [lay.voice[k] for k in range(k0, min(k1, len(lay.voice)))]
        shares.append(sum(1 for v in fr if v) / len(fr) if fr else 0.0)
    return runs, shares


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


def _has_context(run):
    return run[1] - run[0] < SHORT_RUN_S


def _clip_spans(runs, total):
    return [(max(0.0, a - (CONTEXT_S if _has_context((a, b)) else PAD_S)), min(total, b + PAD_S)) for a, b in runs]


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
    cmd = list(base) + ["-l", whisper_language(language)] + [x for c in clips for x in ("-f", c)]
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


def _echo(words, before):
    """How many of `words` (the clip's, in order) are the echo of `before` (the texts of the words just before the
    run): the longest opening of `words` equal, by lib.speech_lines.norm and in order, to the end of `before`. Words
    that norm to nothing are skipped in the comparison and dropped with the echo around them."""
    from lib.speech_lines import norm
    prev = [n for n in (norm(t) for t in before) if n]
    pos = [i for i, (t, _, _) in enumerate(words) if norm(t)]
    heard = [norm(words[i][0]) for i in pos]
    for k in range(min(len(prev), len(heard)), 0, -1):
        if heard[:k] == prev[-k:]:
            return pos[k - 1] + 1
    return 0


def _words_of_run(doc, clip_start, run, before=None):
    """[(text, start, end)] on the source's clock, clamped into the run. All the clip's words, except the echo of the
    runs before it in a context clip (`before`: their words' texts; None for a clip with no context): the longest
    opening equal to their end, else the words that END before the run's start less PAD_S."""
    lo, hi = run
    got = []
    for e in doc.get("transcription", []):
        text = e.get("text") or ""
        o = e.get("offsets") or {}
        if not text.strip() or _SPECIAL.match(text) or "from" not in o or "to" not in o:
            continue
        got.append((text, clip_start + o["from"] / 1000.0, clip_start + o["to"] / 1000.0))
    if before is not None:
        k = _echo(got, before)
        kept = got[k:] if k else [w for w in got if w[2] >= lo - PAD_S]
        if not kept and k:
            # the echo is every word (a back-to-back short retake, "PhoneBot." said again): the run's own by time
            kept = [w for w in got if lo - PAD_S <= (w[1] + w[2]) / 2 <= hi + PAD_S]
        got = kept
    return _clamp(got, lo, hi)


def _hallucination(words, run, share=None, edge=False):
    """A run of under HALLUCINATION_RUN_S, with under VOICED_SHARE_MIN of its frames voiced (`share`; None: no voice
    check, kept), whose words are only a stock phrase ("Thank you.") or made up (lib/speech_units.made_up). Never the
    source's first or last run (`edge`): a real opening or sign-off ("Bye!") is said there."""
    if edge or share is None or share >= VOICED_SHARE_MIN or run[1] - run[0] >= HALLUCINATION_RUN_S or not words:
        return False
    from lib.speech_units import made_up
    return _norm(" ".join(t for t, _, _ in words)) in HALLUCINATIONS or made_up(
        [{"text": t, "start": s, "end": e} for t, s, e in words])


DETECT_MIN_VOICE_S = 5.0         # a detect decides something only when its clip held this much voice ...
DETECT_MIN_P = 0.95              # ... and was this sure: short clips of a non-native English voice misdetect at p 0.95+
DETECT_S = 30.0                  # a language detect hears at most this long a clip (voice and padding)
DETECT_TIMEOUT_S = 180           # a detect that has not answered by now is given up on: it never holds a step up
DETECT_JOIN_S = DETECT_TIMEOUT_S + 20     # ... and the step waits for a detect thread this long at most
_PROCESSING = re.compile(r": processing '")
_DETECTED = re.compile(r"auto-detected language: (\S+) \(p = ([0-9.]+)\)")


def _detect_timeout(n_clips):
    """Seconds one detect call may take: DETECT_TIMEOUT_S, and a little more for each further clip of a batch."""
    return DETECT_TIMEOUT_S + 10 * max(0, n_clips - 1)


def _run_detect(cmd, timeout):
    """The finished CompletedProcess of a whisper-cli detect, or None when it could not run, did not finish in
    `timeout` seconds or died. Unlike run_whisper it never calls fail: a detect prints no failure line and changes
    nothing about the step that asked for it."""
    exe = os.path.abspath(shutil.which(cmd[0]) or cmd[0])
    cmd = [exe] + _absolute_whisper_paths(cmd[1:])
    try:
        return run(cmd, timeout=timeout, check=False, cwd=os.path.dirname(exe))
    except (subprocess.TimeoutExpired, Exception, SystemExit):
        return None


def _detect_clips(clips, model):
    """[(code, p) or None] for each wav of `clips`, in order, from `whisper-cli -l auto -dl` (-dl exits after
    detecting each file; BATCH clips to a call). The detect prints, per file, `...: processing '<file>' ...` then
    `auto-detected language: <code> (p = <p>)`; they are read in order, so a file that printed no detect is None. A
    detect that fails to run, or times out, is None for every clip of its call: the caller then has nothing to go on
    and trusts what it has. Never fails and never prints."""
    out = []
    for i in range(0, len(clips), BATCH):
        batch = clips[i:i + BATCH]
        try:
            cmd = [find_whisper_bin(), "-m", model, "-l", "auto", "-dl"] + [x for c in batch for x in ("-f", c)]
        except (Exception, SystemExit):
            out += [None] * len(batch)
            continue
        r = _run_detect(cmd, _detect_timeout(len(batch)))
        if r is None:
            out += [None] * len(batch)
            continue
        text = (getattr(r, "stdout", "") or "") + "\n" + (getattr(r, "stderr", "") or "")
        blocks = _PROCESSING.split(text)[1:]
        found = []
        for blk in blocks:
            m = _DETECTED.search(blk)
            found.append((m.group(1).lower(), float(m.group(2))) if m else None)
        out += found if len(found) == len(batch) else [None] * len(batch)
    return out


def _detect_spans(runs, total=None):
    """([(start, end)] of the clip a language detect hears, the seconds of voice in it) for the voiced `runs` of a
    source (`total`: its length, None when not known). The runs of at least SHORT_RUN_S, longest first, until the clip
    holds DETECT_S including PAD_S around each, in time order (a run too long for what is left is cut short); with
    none that long, the longest run. Spans that touch are one. The voice is the runs' own seconds, never padding."""
    if not runs:
        return [], 0.0
    cands = [r for r in runs if r[1] - r[0] >= SHORT_RUN_S] or [max(runs, key=lambda r: r[1] - r[0])]
    chosen, used, voice = [], 0.0, 0.0
    for a, b in sorted(cands, key=lambda r: r[0] - r[1]):
        room = DETECT_S - used - 2 * PAD_S
        if room <= 0:
            break
        take = min(b - a, room)
        if chosen and take < SHORT_RUN_S:
            continue
        chosen.append((a, a + take))
        used += take + 2 * PAD_S
        voice += take
    spans = []
    for a, b in sorted(chosen):
        a, b = max(0.0, a - PAD_S), b + PAD_S
        if total is not None:
            b = min(total, b)
        if spans and a <= spans[-1][1]:
            spans[-1] = (spans[-1][0], max(spans[-1][1], b))
        else:
            spans.append((a, b))
    return spans, voice


def _write_joined(wav_path, spans, path):
    """The `spans` of the 16 kHz mono wav at `wav_path`, one after another, as the wav `path`."""
    with wave.open(wav_path, "rb") as src:
        rate, width, total = src.getframerate(), src.getsampwidth(), src.getnframes()
        data = b""
        for a, b in spans:
            lo = min(total, int(round(a * rate)))
            hi = min(total, max(lo + 1, int(round(b * rate))))
            src.setpos(lo)
            data += src.readframes(hi - lo)
    _write_wav(path, data, rate, width)


def _write_wav(path, data, rate=RATE, width=2):
    with wave.open(path, "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(width)
        dst.setframerate(rate)
        dst.writeframes(data)


def _cut_media(media, spans, path, tmp):
    """The `spans` (seconds) of `media`'s first audio stream, joined as the 16 kHz mono wav `path`: ffmpeg decodes
    only those seconds (`-ss`/`-t`), never the whole file. False when ffmpeg could not."""
    data, rate, width = b"", RATE, 2
    for i, (a, b) in enumerate(spans):
        part = os.path.join(tmp, f"part-{i}.wav")
        r = run([ffmpeg_bin(), "-v", "error", "-y", "-ss", f"{a:.3f}", "-t", f"{max(b - a, 0.05):.3f}", "-i",
                 ff_path(media), "-map", "0:a:0", "-vn", "-ar", str(RATE), "-ac", "1", "-c:a", "pcm_s16le", part],
                timeout=DECODE_TIMEOUT_S, check=False)
        if r.returncode != 0 or not os.path.isfile(part):
            return False
        with wave.open(part, "rb") as w:
            rate, width = w.getframerate(), w.getsampwidth()
            data += w.readframes(w.getnframes())
    _write_wav(path, data, rate, width)
    return True


def sure(detected, min_voice_s=DETECT_MIN_VOICE_S, min_p=DETECT_MIN_P):
    """True when `detected` ((code, p, voice_s) of detect_languages_p) is firm enough to act on."""
    return bool(detected) and detected[1] >= min_p and detected[2] >= min_voice_s


def _wav_seconds(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def _detect_clip(media, known_runs, tmp, tag):
    """(the detect clip's wav, the seconds of voice in it) for `media`, or None when it has no voice or could not be
    read. `known_runs` (its voiced runs, from its transcript): only those seconds are decoded; None: the file is
    decoded and its voiced runs found."""
    path = os.path.join(tmp, f"detect-{tag}.wav")
    if known_runs is not None:
        spans, voice_s = _detect_spans(known_runs)
        return (path, voice_s) if spans and _cut_media(media, spans, path, tmp) else None
    runs = voiced_runs(media)
    if not runs:
        return None
    wav = os.path.join(tmp, f"source-{tag}.wav")
    _decode(media, wav)
    spans, voice_s = _detect_spans(runs, _wav_seconds(wav))
    _write_joined(wav, spans, path)
    return path, voice_s


def detect_languages_p(medias, model_path, runs_for=None, pool=False):
    """{media: (code, p, voice_s) or None}: the language whisper hears in each of `medias`, from a clip of its voiced
    runs (`_detect_spans`: at most DETECT_S), all in ONE whisper-cli call. voice_s: the seconds of voice the clip
    held. A media with no voiced run has no words to be wrong about: None, and so has one whose detect did not run.
    `runs_for` {media: [(start, end)]}: the voiced runs already known (a transcript's), so only those seconds are
    read. `pool`: the medias whose own voice is under DETECT_MIN_VOICE_S (and there are two or more) are joined into
    ONE clip, one detect, and each of those that went into it gets its answer: voice_s is the pool's. Never fails,
    never prints, never changes what its caller does next."""
    result, items = {}, []
    tmp = tempfile.mkdtemp(prefix="montaj-detect-")
    try:
        with quiet_failures():
            for n, media in enumerate(medias):
                result[media] = None
                try:
                    got = _detect_clip(media, (runs_for or {}).get(media), tmp, n)
                except (Exception, SystemExit):
                    got = None
                if got:
                    items.append((media, got[0], got[1]))
            short = [it for it in items if it[2] < DETECT_MIN_VOICE_S] if pool else []
            if len(short) < 2:
                short = []
            owners = [it for it in items if it not in short]
            clips = [it[1] for it in owners]
            pooled = []
            if short:
                data, voice, used = b"", 0.0, 0.0
                for media, clip, v in sorted(short, key=lambda it: -it[2]):
                    seconds = _wav_seconds(clip)
                    if pooled and used + seconds > DETECT_S:
                        continue
                    with wave.open(clip, "rb") as w:
                        data += w.readframes(w.getnframes())
                    pooled.append(media)
                    voice += v
                    used += seconds
                pool_path = os.path.join(tmp, "pool.wav")
                _write_wav(pool_path, data)
                clips.append(pool_path)
            answers = _detect_clips(clips, model_path) if clips else []
            for (media, _, voice_s), got in zip(owners, answers):
                result[media] = (got[0], got[1], voice_s) if got else None
            if pooled:
                got = answers[len(owners)]
                for media in pooled:
                    result[media] = (got[0], got[1], voice) if got else None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return result


def detect_languages(medias, model_path):
    """{media: language code, or None} (see detect_languages_p)."""
    return {m: (got[0] if got else None) for m, got in detect_languages_p(medias, model_path).items()}


def transcribe_runs(media, out_prefix, model, language, detect=False):
    """Transcribe `media` run by run (see the module docstring) and write `<out_prefix>.json` and `.srt`. `model` is
    the weight's path. {"words", "srt", "runs", "detected"}; with no voiced run nothing is written and {"fell_back":
    True, "runs": 0} says so. `detect`: also hear the language of the longest run (one detect, from the clip already
    cut: at most DETECT_S of it), answered as "detected": (code, p, voice_s) or None; the transcript is made in `language`."""
    runs, shares = _runs_and_shares(media)
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
        # The detect runs beside the transcription (its model load is most of its cost), never in front of it, and
        # it never changes what the step does: no failure line, no wait past DETECT_TIMEOUT_S.
        box = {}
        th = None
        dclip = None
        if detect:
            try:
                dspans, voice_s = _detect_spans(runs, total)
                dclip = os.path.join(tmp, "detect.wav")
                _write_joined(wav, dspans, dclip)
            except (Exception, SystemExit):
                dclip = None

        if dclip:
            def _hear():
                with quiet_failures():
                    try:
                        box["got"] = _detect_clips([dclip], model)[0]
                    except (Exception, SystemExit):
                        pass
            th = threading.Thread(target=_hear, daemon=True)
            th.start()
        docs = {}
        try:
            for i in range(0, len(clips), BATCH):
                docs.update(_whisper(base, clips[i:i + BATCH], spans_of, language))
        finally:
            if th:
                th.join(DETECT_JOIN_S)
        detected = (box["got"][0], box["got"][1], voice_s) if th and not th.is_alive() and box.get("got") else None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    entries, said = [], []          # said: (run end, the texts of the run's words) so far, hallucinations too
    for i, (run_, clip) in enumerate(zip(runs, clips)):
        before = None
        if _has_context(run_):
            before = [t for end, texts in said if end > spans[i][0] for t in texts]
        words = _words_of_run(docs[clip], spans[i][0], run_, before)
        said.append((run_[1], [t for t, _, _ in words]))
        if _hallucination(words, run_, shares[i], edge=i in (0, len(runs) - 1)):
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
    return {"words": words_path, "srt": srt_path, "runs": len(runs), "fell_back": False, "detected": detected}


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
