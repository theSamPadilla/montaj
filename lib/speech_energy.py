"""Where whisper's words really are, from the audio's level (§558, cut).

Whisper's words are gapless: a pause sits inside a neighbouring word's span, and on a quiet voiceover a word's
span can run over half a second of near silence. speech_lines.refine moves edges out of the pauses ffmpeg's
silencedetect finds, at the source's noise floor plus 15 dB; a quiet word lies wholly inside such a "silence", so
the gaps beside it are unsure and the cut keeps them whole (on a real 128 s voiceover: 49 such words, and pauses
of 0.6-0.8 s left in a cut capped at 0.45).

This module reads the level itself: the RMS of each FRAME_S of the first audio stream, in dB, taking the louder
channel of each frame (a mono mixdown can cancel a channel out). Two levels are read per source:
- the room's NOISE: the NOISE_PERCENTILE-th percentile frame outside whisper's word spans (of every frame, when that
  is lower or there is too little outside; digital silence left out), deterministic;
- the speech-relative FLOOR: the clip's own speech level (the median of its words' loudest frames) less
  FLOOR_BELOW_SPEECH_DB, kept within FLOOR_RANGE_DB. It decides dead air and trimming, NEVER whether a word goes.
Then for each whisper word:
- LOUD (a frame at or above the floor): its span is trimmed to its audible core, from its first frame at or above
  the floor to the end of its last (a quiet stretch inside the word's sound is kept), and each edge then reaches
  out while frames stay at or above max(noise + AUDIBLE_OVER_NOISE_DB, floor - EDGE_BELOW_FLOOR_DB) (hysteresis:
  a weak "f" decay or "h" onset), within whisper's span and the free time no other word claims, plus a release of
  RELEASE_S after it;
- QUIET (under the floor, but a frame more than AUDIBLE_OVER_NOISE_DB over the noise): heard, never removed. Its
  span is its frames over the noise plus that margin, with the same edges; listed in stats["quiet"], for cut to
  offer as `inaudible?`;
- SILENT (every frame within AUDIBLE_OVER_NOISE_DB of the noise, and under the floor): a run of INAUDIBLE_RUN or
  more in a row is inaudible (spoken under the noise, or not at all), listed in stats["inaudible"] for cut to remove
  and tag, unless a neighbouring heard word is long for its own text (LETTER_S a letter plus WORD_BASE_S) by enough
  to hold the run (MISPLACED_SHARE of the run's own length): whisper misplaced them and their sound is in that
  neighbour, so they stay like a lone one. A lone silent word between heard ones is whisper's timing ("I", "with"
  put in the pause next to the word that holds its sound). Kept silent words are FOLDED into the neighbour that
  holds them: LONE_WORD_S each, right against its edge, so the text and the captions keep them and the pause beside
  them is one gap like any other (listed in stats["folded"]).
No word is whisper-placed inside a pause any more, so no gap is unsure. The measured silences are the runs of
frames under the floor, at least MIN_SILENCE_S long.

cut uses it through `Refiner`, which speech_text.derive calls in place of speech_lines.refine, in the plan and in
its apply alike, and whose `tidy` cleans the apply's runs (see `tidy`). speech_edit is unchanged.

The envelope reads the whole source into memory (16 kHz, 2 bytes a sample a channel: about 115 MB an hour of
stereo); streaming it is left for long sources, if one needs it.
"""
import math
import os
import statistics
import subprocess
import tempfile
import wave
from array import array
from dataclasses import replace

from lib.common import fail, ff_path, ffmpeg_bin, run

VERSION = "speech-energy v2"
FRAME_S = 0.01
RATE = 16000
FLOOR_BELOW_SPEECH_DB = 26.0
FLOOR_RANGE_DB = (-70.0, -36.0)
NOISE_PERCENTILE = 10
NOISE_MIN_FRAMES = 20            # frames outside the words needed to read the room from them alone
AUDIBLE_OVER_NOISE_DB = 10.0     # a word no louder than the room plus this is not heard
EDGE_BELOW_FLOOR_DB = 12.0       # how far under the floor a word's edge reaches (and over the noise, at least)
RELEASE_S = 0.03                 # kept after a word's last audible frame, so a soft ending survives
MIN_SILENCE_S = 0.06
INAUDIBLE_RUN = 2
LONE_WORD_S = 0.04
LETTER_S = 0.09                  # a heard word longer than LETTER_S a letter plus WORD_BASE_S holds more words
WORD_BASE_S = 0.2
MISPLACED_SHARE = 0.5            # ... the run's letters' share of LETTER_S it must have to spare to hold them
DEAD_AIR_MIN_S = 0.16            # a pause this long, every frame under the floor, is dead air
BREATH_S = 0.04                  # what a dead-air pause keeps on each side of the words
SENTENCE_END_S = 0.18            # what dead air at a sentence end keeps, at most
SLIVER_S = 0.30                  # a kept piece shorter than this must be a whole heard word
NEVER_A_WORD_S = 0.10            # a kept piece shorter than this is never a word
DECODE_TIMEOUT_S = 600
_SILENT_DB = -120.0


def envelope(media: str) -> list:
    """dB (RMS) of each FRAME_S of the first audio stream of `media` at RATE: the louder channel of each frame."""
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    name = os.path.basename(media)
    try:
        try:
            r = run([ffmpeg_bin(), "-v", "error", "-y", "-i", ff_path(media), "-map", "0:a:0", "-ar", str(RATE),
                     "-c:a", "pcm_s16le", wav_path], timeout=DECODE_TIMEOUT_S, check=False)
        except subprocess.TimeoutExpired:
            fail("audio_timeout", f"Reading the audio of {name} took over {DECODE_TIMEOUT_S} s, so cut stopped. "
                                  "Cut a shorter clip, or split this one, then run cut again.")
        if r.returncode != 0:
            if "matches no streams" in (r.stderr or "") or "does not contain any stream" in (r.stderr or ""):
                fail("no_audio", f"{name} has no audio, so cut cannot hear where its words are. Use a clip with "
                                 "sound, or remove its transcript so it is kept whole.")
            run([ffmpeg_bin(), "-v", "error", "-y", "-i", ff_path(media), "-map", "0:a:0", "-ar", str(RATE),
                 "-c:a", "pcm_s16le", wav_path], timeout=DECODE_TIMEOUT_S)        # fails with ffmpeg's own words
        with wave.open(wav_path, "rb") as w:
            ch = max(1, w.getnchannels())
            samples = array("h", w.readframes(w.getnframes()))
    finally:
        if os.path.exists(wav_path):
            os.unlink(wav_path)
    hop = int(RATE * FRAME_S)
    step = hop * ch
    out = []
    for i in range(0, len(samples) - step + 1, step):
        best = 0.0
        for c in range(ch):
            chunk = samples[i + c:i + step:ch]
            ms = sum(v * v for v in chunk) / hop
            best = max(best, ms)
        out.append(20 * math.log10(math.sqrt(best) / 32768) if best > 0 else _SILENT_DB)
    return out


def _frames(env, start, end):
    a = max(0, int(math.floor(start / FRAME_S + 1e-9)))
    b = min(len(env), max(a + 1, int(math.ceil(end / FRAME_S - 1e-9))))
    return a, b


def peak(env, start, end) -> float:
    a, b = _frames(env, start, end)
    return max(env[a:b], default=_SILENT_DB)


def _pct(vals, p=NOISE_PERCENTILE):
    vals = sorted(vals)
    return vals[min(len(vals) - 1, int(p / 100 * (len(vals) - 1)))]


def floor_db(words, env, noise=None) -> float:
    """The clip's speech level (median of its words' peaks, of the words heard over the `noise` when it is given,
    so a clip of mostly made-up words keeps its speech's floor) less FLOOR_BELOW_SPEECH_DB, within FLOOR_RANGE_DB."""
    peaks = [peak(env, w.start, w.end) for w in words]
    if noise is not None:
        peaks = [v for v in peaks if v >= noise + AUDIBLE_OVER_NOISE_DB] or peaks
    level = statistics.median(peaks) if peaks else -16.0
    lo, hi = FLOOR_RANGE_DB
    return min(hi, max(lo, level - FLOOR_BELOW_SPEECH_DB))


def noise_db(words, env) -> float:
    """The room's noise: the NOISE_PERCENTILE-th percentile frame outside the words' spans, or of every frame when
    that is lower or too little lies outside (digital silence left out)."""
    inside = bytearray(len(env))
    for w in words:
        a, b = _frames(env, w.start, w.end)
        inside[a:b] = b"\x01" * (b - a)
    every = [v for v in env if v > _SILENT_DB]
    out = [v for k, v in enumerate(env) if not inside[k] and v > _SILENT_DB]
    cands = ([_pct(out)] if len(out) >= NOISE_MIN_FRAMES else []) + ([_pct(every)] if every else [])
    return min(cands) if cands else _SILENT_DB


def heard_db(floor, noise) -> float:
    """Under this a word is not heard: within AUDIBLE_OVER_NOISE_DB of the noise, and under the floor."""
    return min(floor, noise + AUDIBLE_OVER_NOISE_DB)


def _letters(text):
    return sum(1 for c in text if c.isalnum())


def _expected(w):
    return LETTER_S * _letters(w.text) + WORD_BASE_S


def refine(words, env, floor, noise=None):
    """(words placed by the audio, stats {inaudible, quiet, folded: [word index], inside_words: [], inside,
    attached, orphan}, silences [(start, end)]). See the module docstring."""
    if noise is None:
        noise = noise_db(words, env)
    heard = heard_db(floor, noise)
    edge = max(noise + AUDIBLE_OVER_NOISE_DB, floor - EDGE_BELOW_FLOOR_DB)
    n, end_s = len(words), len(env) * FRAME_S
    out, kind, core = list(words), [], []
    for i, w in enumerate(words):
        a, b = _frames(env, w.start, w.end)
        pk = max(env[a:b], default=_SILENT_DB)
        thr = floor if pk >= floor else heard if pk >= heard else None
        if thr is None:
            kind.append("silent")
            core.append(None)
            continue
        kind.append("loud" if thr == floor else "quiet")
        loud = [k for k in range(a, b) if env[k] >= thr]
        s, e = loud[0], loud[-1] + 1
        core.append((s * FRAME_S, e * FRAME_S))
        # whisper's span, and the free time beside it that no other word's span claims
        lo_t = w.start if i and words[i - 1].end >= w.start else (words[i - 1].end if i else 0.0)
        hi_t = w.end if i + 1 < n and words[i + 1].start <= w.end else (words[i + 1].start if i + 1 < n else end_s)
        lo_f, hi_f = max(0, int(math.floor(lo_t / FRAME_S + 1e-9))), min(len(env), int(math.ceil(hi_t / FRAME_S - 1e-9)))
        while s - 1 >= lo_f and env[s - 1] >= edge:
            s -= 1
        while e < hi_f and env[e] >= edge:
            e += 1
        st = max(lo_t, s * FRAME_S)
        en = min(hi_t, max(e * FRAME_S, core[-1][1] + RELEASE_S))         # at least RELEASE_S past the core
        out[i] = replace(w, start=round(st, 6), end=round(max(st, en), 6))
    # two words that reached into one free gap from both sides meet between their cores
    for i in range(n - 1):
        x, y = out[i], out[i + 1]
        if kind[i] != "silent" and kind[i + 1] != "silent" and x.end > y.start:
            m = min(max((x.end + y.start) / 2, core[i][1]), core[i + 1][0]) if core[i][1] <= core[i + 1][0] else x.end
            out[i] = replace(x, end=round(max(x.start, m), 6))
            out[i + 1] = replace(y, start=round(min(y.end, max(m, out[i].end)), 6))

    def excess(k):
        return (out[k].end - out[k].start) - _expected(words[k])

    inaudible, quiet, folded = [], [k for k in range(n) if kind[k] == "quiet"], []
    i = 0
    while i < n:
        if kind[i] != "silent":
            i += 1
            continue
        j = i
        while j < n and kind[j] == "silent":
            j += 1
        hosts = [k for k in (i - 1, j) if 0 <= k < n]
        need = MISPLACED_SHARE * LETTER_S * sum(_letters(words[k].text) for k in range(i, j))
        best = max(hosts, key=lambda k: (excess(k), -k), default=None)
        if j - i >= INAUDIBLE_RUN and not (best is not None and excess(best) > 0 and excess(best) >= need):
            inaudible += [words[k].idx for k in range(i, j)]
            i = j
            continue
        _fold(out, words, i, j, best)
        folded += [words[k].idx for k in range(i, j)]
        i = j
    sils, run_start = [], None
    for k, v in enumerate(env + [0.0]):
        if v < floor and k < len(env):
            run_start = k if run_start is None else run_start
        elif run_start is not None:
            if (k - run_start) * FRAME_S >= MIN_SILENCE_S - 1e-9:
                sils.append((round(run_start * FRAME_S, 6), round(k * FRAME_S, 6)))
            run_start = None
    stats = {"inaudible": inaudible, "quiet": [words[k].idx for k in quiet], "folded": folded,
             "heard": [words[k].idx for k in range(n) if kind[k] != "silent"],
             "inside_words": [], "inside": 0, "attached": 0, "orphan": 0}
    return out, stats, sils


def _fold(out, words, i, j, host):
    """Place silent words i..j-1 LONE_WORD_S each right against the edge of `host` (the heard word beside them that
    holds their sound), in the silence between that edge and the next word, so they play in the host's piece; with
    no host, at the middle of their span (a lone word)."""
    lo, hi = words[i].start, words[j - 1].end
    if host is None:
        mid = (lo + hi) / 2
        for k in range(i, j):
            out[k] = replace(words[k], start=round(max(lo, mid - LONE_WORD_S / 2), 6),
                             end=round(min(hi, mid + LONE_WORD_S / 2), 6))
        return
    m = j - i
    if host < i:
        t = out[host].end
        stop = out[j].start if j < len(out) else max(hi, t)
        each = min(LONE_WORD_S, max(0.0, stop - t) / m)
        for k in range(i, j):
            out[k] = replace(words[k], start=round(t, 6), end=round(t + each, 6))
            t += each
    else:
        t = out[host].start
        stop = out[i - 1].end if i else min(lo, t)
        each = min(LONE_WORD_S, max(0.0, t - stop) / m)
        for k in range(j - 1, i - 1, -1):
            out[k] = replace(words[k], start=round(t - each, 6), end=round(t, 6))
            t -= each


def quiet(env, floor, start, end) -> bool:
    """Every frame of [start, end] is under the floor."""
    a, b = _frames(env, start, end)
    return all(v < floor for v in env[a:b])


class Refiner:
    """What speech_text.derive calls for each source instead of speech_lines.refine: (words, stats, silences).
    Measures each media once per process; `floor`, `noise` and `env` say what it measured, for cut's plan, and
    `quiet_words` / `heard` the word indexes it found quiet and heard, per source."""

    def __init__(self):
        self.env, self.floor, self.noise, self.quiet_words, self.heard = {}, {}, {}, {}, {}

    stamp = (f"{VERSION} {FRAME_S} {FLOOR_BELOW_SPEECH_DB} {FLOOR_RANGE_DB} {MIN_SILENCE_S} {INAUDIBLE_RUN} "
             f"{LONE_WORD_S} {NOISE_PERCENTILE} {AUDIBLE_OVER_NOISE_DB} {EDGE_BELOW_FLOOR_DB} {RELEASE_S} "
             f"{LETTER_S} {WORD_BASE_S} {MISPLACED_SHARE}")

    def __call__(self, key, media, raw):
        if key not in self.env:
            self.env[key] = envelope(media)
            self.noise[key] = noise_db(raw, self.env[key])
            self.floor[key] = floor_db(raw, self.env[key], self.noise[key])
        words, stats, sils = refine(raw, self.env[key], self.floor[key], self.noise[key])
        self.quiet_words[key] = set(stats["quiet"])
        self.heard[key] = set(stats["heard"])
        return words, stats, sils

    def quiet(self, key, start, end) -> bool:
        return key in self.env and quiet(self.env[key], self.floor[key], start, end)

    def end(self, key) -> float:
        """The measured length of the source, in seconds."""
        return len(self.env.get(key, ())) * FRAME_S

    def tidy(self, runs, derived, report=None):
        """The apply's runs with no partial word and no sliver (see the module function)."""
        return tidy(runs, derived, self, report)


# ── the kept pieces: no partial word, no sliver (§558 dead slivers) ─────────────────────────────────────────

_EPS = 1e-6


def tidy(runs, derived, refiner, report=None):
    """The speech runs of an apply, cleaned so that every kept piece is speech:
    - a FRAGMENT, a heard word only part of whose span a piece plays, never stays: a kept word is restored whole
      (its edges reach out over the rest of its span, never over another piece of its source); a removed word's
      part is trimmed off the piece;
    - a SLIVER, a piece shorter than SLIVER_S that holds no whole heard word, or any piece shorter than
      NEVER_A_WORD_S, goes: merged into the neighbouring piece of its source it follows on from (that piece keeps as
      much more silence, up to the next heard word), else dropped. At a clip's start or end there is one neighbour.
    The words a dropped sliver held (silent ones: a word folded into a removed word) are listed in report.flagged as
    {"kind": "sliver", "letter", "idx", "seconds"}. Returns the runs."""
    by_letter = {}
    for ln in derived.lines.values():
        by_letter.setdefault(ln.id.rstrip("0123456789"), []).extend(ln.words)
    words_of = {src: sorted(by_letter.get(letter, []), key=lambda w: w.start) for src, letter in derived.letters.items()}
    heard_of = {src: refiner.heard.get(src, set()) for src in words_of}
    speech = [r for r in runs if r.kind == "speech" and r.src in words_of]

    def others(r):
        return [o for o in speech if o is not r and o.src == r.src]

    for r in speech:
        kept = set(r.words)
        for w in words_of[r.src]:
            if w.idx not in heard_of[r.src] or w.end - w.start <= _EPS:
                continue
            if min(w.end, r.s_out) - max(w.start, r.s_in) <= _EPS:
                continue
            if w.start >= r.s_in - _EPS and w.end <= r.s_out + _EPS:
                continue
            if w.idx in kept:
                lo = max([o.s_out for o in others(r) if o.s_out <= r.s_in + _EPS] + [w.start])
                hi = min([o.s_in for o in others(r) if o.s_in >= r.s_out - _EPS] + [w.end])
                r.s_in, r.s_out = min(r.s_in, max(lo, w.start)), max(r.s_out, min(hi, w.end))
            else:
                own = [x for x in words_of[r.src] if x.idx in kept]
                if w.start <= r.s_in + _EPS:
                    r.s_in = min(r.s_out, w.end, min((x.start for x in own), default=w.end))
                elif w.end >= r.s_out - _EPS:
                    r.s_out = max(r.s_in, w.start, max((x.end for x in own), default=w.start))

    def whole_heard(r):
        return any(w.idx in r.words and w.idx in heard_of[r.src] and w.start >= r.s_in - _EPS and w.end <= r.s_out + _EPS
                   for w in words_of[r.src])

    def reach_after(r, t):
        """How far a piece ending at t may play on: never into a heard word it does not keep, never over another
        word's middle (derive would read that word as played), never past the source."""
        stops = [refiner.end(r.src) or float("inf")]
        for w in words_of[r.src]:
            if w.idx in r.words:
                continue
            at = w.start if w.idx in heard_of[r.src] else (w.start + w.end) / 2 - 0.005
            if at >= t - _EPS:
                stops.append(at)
        return min(stops)

    def reach_before(r, t):
        stops = [0.0]
        for w in words_of[r.src]:
            if w.idx in r.words:
                continue
            at = w.end if w.idx in heard_of[r.src] else (w.start + w.end) / 2 + 0.005
            if at <= t + _EPS:
                stops.append(at)
        return max(stops)

    def heard_between(src, a, b):
        return any(w.idx in heard_of[src] and min(w.end, b) - max(w.start, a) > _EPS for w in words_of[src])

    out = list(runs)
    k = 0
    while k < len(out):
        r = out[k]
        dur = r.s_out - r.s_in
        if r.kind != "speech" or r.src not in words_of or dur >= SLIVER_S - _EPS \
                or (dur >= NEVER_A_WORD_S - _EPS and whole_heard(r)):
            k += 1
            continue
        p = out[k - 1] if k and out[k - 1].kind == "speech" and out[k - 1].src == r.src else None
        q = out[k + 1] if k + 1 < len(out) and out[k + 1].kind == "speech" and out[k + 1].src == r.src else None
        # a neighbour it follows on from in the source: nothing heard between them (a removed take is between)
        p = p if p is not None and p.s_out <= r.s_in + _EPS and not heard_between(r.src, p.s_out, r.s_in) else None
        q = q if q is not None and q.s_in >= r.s_out - _EPS and not heard_between(r.src, r.s_out, q.s_in) else None
        if p is not None:
            limit = min([reach_after(p, p.s_out)] + [o.s_in for o in out if o is not p and o is not r
                                                               and o.kind == "speech" and o.src == r.src
                                                               and o.s_in >= p.s_out - _EPS])
            p.s_out = max(p.s_out, min(p.s_out + dur, limit))
        elif q is not None:
            limit = max([reach_before(q, q.s_in)] + [o.s_out for o in out if o is not q and o is not r
                                                           and o.kind == "speech" and o.src == r.src
                                                           and o.s_out <= q.s_in + _EPS])
            q.s_in = min(q.s_in, max(q.s_in - dur, limit))
        if report is not None and r.words:
            report.flagged.append({"kind": "sliver", "letter": derived.letters[r.src], "idx": list(r.words),
                                   "seconds": round(dur, 3)})
        del out[k]
    merged = []
    for r in out:
        p = merged[-1] if merged else None
        if (p is not None and p.kind == r.kind == "speech" and p.src == r.src and abs(p.s_out - r.s_in) <= 0.001
                and not (p.old_out and r.old_in)):
            p.s_out, p.old_out, p.hard_out = r.s_out, r.old_out, r.hard_out
            p.words.extend(r.words)
            continue
        merged.append(r)
    return merged
