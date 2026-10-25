"""Where whisper's words really are, from the audio's level (§558, cut).

Whisper's words are gapless: a pause sits inside a neighbouring word's span, and on a quiet voiceover a word's
span can run over half a second of near silence. speech_lines.refine moves edges out of the pauses ffmpeg's
silencedetect finds, at the source's noise floor plus 15 dB; a quiet word lies wholly inside such a "silence", so
the gaps beside it are unsure and the cut keeps them whole (on a real 128 s voiceover: 49 such words, and pauses
of 0.6-0.8 s left in a cut capped at 0.45).

This module reads the level itself: the RMS of each FRAME_S of the first audio stream, in dB, taking the louder
channel of each frame (a mono mixdown can cancel a channel out). Two levels are read per source:
- the room's NOISE: the NOISE_PERCENTILE-th percentile frame outside whisper's word spans (of every frame, when that
  is lower), deterministic. It is TRUSTED only when NOISE_MIN_FRAMES or more frames lie outside the words; with
  fewer (dense speech) it is the NOISE_FALLBACK_PERCENTILE-th percentile of every frame, and untrusted;
- the speech-relative FLOOR: the clip's own speech level (the median of its words' loudest frames) less
  FLOOR_BELOW_SPEECH_DB, kept within FLOOR_RANGE_DB. It decides dead air and trimming, NEVER whether a word goes.
First, whisper's gapless spans often take in a neighbour's first or last frames: a run of heard frames at the edge of
a word's span, after a dip, that goes on into the touching neighbour's span is the neighbour's when it is short
(EDGE_BLEED_FRAMES) or loud beside a soft word's own sound (see _edge_runs). Then for each whisper word:
- LOUD (a frame at or above the floor): its span is trimmed to its audible part, from its first heard frame
  (over min(floor, noise + AUDIBLE_OVER_NOISE_DB)) to the end of its last, so a soft burst inside its span plays
  too, and each edge then reaches out while frames stay at or above max(noise + AUDIBLE_OVER_NOISE_DB, floor -
  EDGE_BELOW_FLOOR_DB) (hysteresis: a weak "f" decay or "h" onset), within its span and the free time no other
  word claims, plus a release of RELEASE_S after its loud core;
- QUIET (under the floor, but a frame more than AUDIBLE_OVER_NOISE_DB over the noise): heard, never removed. Its
  span is its heard frames, with the same edges; listed in stats["quiet"], for cut to offer as `inaudible?`;
- SILENT (no heard frame): a lone silent word between heard ones is whisper's timing ("I", "with" put in the pause
  next to the word that holds its sound), and so is a run a neighbouring heard word holds (long for its own text,
  LETTER_S a letter plus WORD_BASE_S, by MISPLACED_SHARE of the run's letters, or a separate burst of sound for
  each of its words), or a run whose words the clip's bursts of sound could hold (as many bursts before the run's
  end as words, or after its start). The rest of a run of INAUDIBLE_RUN or more goes only by the conservative rule:
  on a TRUSTED reading, the longest block of it whose every frame, over its span and AT_NOISE_PAD_S on each side, is
  within AT_NOISE_DB of the noise is inaudible, listed in stats["inaudible"] for cut to remove and tag (with a heard
  word on each side of what stays). Every other silent word stays and is offered (stats["quiet"]). Kept silent words
  are FOLDED into the neighbour that holds them: LONE_WORD_S each, right against its edge, so the text and the
  captions keep them and the pause beside them is one gap like any other (listed in stats["folded"]).
No word is whisper-placed inside a pause any more, so no gap is unsure. The measured silences are the runs of
frames under the floor, at least MIN_SILENCE_S long.
Then the silence trim (fix pass 4, _trim_silence), on the timeline only: each heard word is trimmed to its SOUND,
read on the source's speech level (speech_level, its SPEECH_PERCENTILE-th frame) and never on the noise reading
(sound_frames: within SILENCE_BELOW_SPEECH_DB of it, or a soft sound over the quiet frames' own room), so a span
whisper stretched over silence, or an offered word's, keeps none of it; sound after a long silence at a span's end
goes to the next word. Refiner.quiet (dead air) reads the same silence. The classification above reads the spans as
they were, and so do the take rules (stats["untrimmed"], speech_text.take_span), so the trim changes no removal, no
take and no flag.

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

VERSION = "speech-energy v4"
FRAME_S = 0.01
RATE = 16000
FLOOR_BELOW_SPEECH_DB = 26.0
FLOOR_RANGE_DB = (-70.0, -36.0)
NOISE_PERCENTILE = 10
NOISE_MIN_FRAMES = 20            # frames outside the words needed to read the room from them alone (a trusted reading)
NOISE_FALLBACK_PERCENTILE = 1    # with fewer, the room is this percentile of every frame (dense speech), untrusted
AUDIBLE_OVER_NOISE_DB = 10.0     # a word no louder than the room plus this is not heard
AT_NOISE_DB = 6.0                # a word goes as inaudible only when every frame of its span is within this of the room
AT_NOISE_PAD_S = 0.04            # ... its span and this much on each side
EDGE_BLEED_FRAMES = 3            # a neighbour's frames at the edge of a word's span, after a dip, are the neighbour's
BURST_GAP_FRAMES = 1             # a dip of this many frames under the heard level splits two bursts of sound
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
ISLAND_S = 0.35                  # a kept piece shorter than this never stands alone between two cuts (see tidy)
SPEECH_PERCENTILE = 95           # the source's speech level: this percentile of its frames
SILENCE_BELOW_SPEECH_DB = 30.0   # a frame this far under the speech level is silence (the trim, never a removal)
SOUND_MIN_FRAMES = 3             # a soft sound under that level is sound only over this many frames in a row
ROOM_DIP_DB = 20.0               # a quiet frame this far under the quiet frames' median is a dip, not the room
TOUCH_S = 0.10                   # a group of sound this close to a word's span edge, by a neighbour, may be that neighbour's
EDGE_REACH_S = 0.30              # the most tidy plays on over loud sound a cut went through (longer is not a word)
DECODE_TIMEOUT_S = 600
_SILENT_DB = -120.0
_EPS = 1e-6
_DEFAULT_MAX_PAUSE_S = 0.45      # speech_build's natural feel, when the refiner was given none


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


def noise_reading(words, env):
    """(the room's noise, trusted). Trusted: NOISE_MIN_FRAMES or more frames lie outside the words' spans, and the
    noise is the NOISE_PERCENTILE-th percentile of them (or of every frame, when that is lower). Otherwise the
    reading is unsure (dense speech): the NOISE_FALLBACK_PERCENTILE-th percentile of every frame, so the words'
    own frames are not read as the room. Digital silence is left out."""
    inside = bytearray(len(env))
    for w in words:
        a, b = _frames(env, w.start, w.end)
        inside[a:b] = b"\x01" * (b - a)
    every = [v for v in env if v > _SILENT_DB]
    out = [v for k, v in enumerate(env) if not inside[k] and v > _SILENT_DB]
    if len(out) >= NOISE_MIN_FRAMES:
        return min(_pct(out), _pct(every)), True
    return (_pct(every, NOISE_FALLBACK_PERCENTILE) if every else _SILENT_DB), False


def noise_db(words, env) -> float:
    """The room's noise (noise_reading's)."""
    return noise_reading(words, env)[0]


def heard_db(floor, noise) -> float:
    """Under this a word is not heard: within AUDIBLE_OVER_NOISE_DB of the noise, and under the floor."""
    return min(floor, noise + AUDIBLE_OVER_NOISE_DB)


def _letters(text):
    return sum(1 for c in text if c.isalnum())


def _expected(w):
    return LETTER_S * _letters(w.text) + WORD_BASE_S


def _edge_runs(words, env, heard, floor):
    """Whisper's gapless spans often take in the first or last frames of a neighbour's sound (10-20 ms, or a whole
    onset when whisper is late). A run of heard frames at the edge of a word's span, after a dip, that goes on into
    the touching neighbour's span, at least as much of it there as here, is the neighbour's (R3-B1, P3-2) when the
    word has more sound of its own and the run is EDGE_BLEED_FRAMES or shorter, or loud at the edge of a soft
    word (its own sound under the floor). Returns (start, end) per word: its span with any such run
    given away, and widened over any run it is given."""
    n = len(words)
    fr = [_frames(env, w.start, w.end) for w in words]
    span = [[w.start, w.end] for w in words]

    def gives(vals, run):
        """The rest of the word has sound of its own, longer than the run: soft (under the floor) with a loud run,
        or anything with a run of EDGE_BLEED_FRAMES or fewer (a neighbour's first or last frames)."""
        own = sum(1 for v in vals if v >= heard)
        if not vals or own < len(run):
            return False
        return len(run) <= EDGE_BLEED_FRAMES or (max(vals) < floor and max(run) >= floor)

    def run_len(k, step, stop):
        m = 0
        while 0 <= k < len(env) and (k < stop if step > 0 else k >= stop) and env[k] >= heard:
            m, k = m + 1, k + step
        return m
    for i in range(n - 1):
        (a, b), (a2, b2) = fr[i], fr[i + 1]
        if a2 > b or b - a < 2 or b2 - a2 < 2:
            continue
        # i's last frames into i+1: the run inside i (back from b) and inside i+1 (on from b, within its span)
        mine, theirs = run_len(b - 1, -1, a), run_len(b, 1, b2)
        if mine and theirs >= mine and gives(env[a:b - mine], env[b - mine:b]):
            cut = (b - mine) * FRAME_S
            span[i][1] = max(span[i][0], min(span[i][1], cut))
            span[i + 1][0] = min(span[i + 1][0], cut)
            continue
        # i+1's first frames back into i
        mine, theirs = run_len(a2, 1, b2), run_len(a2 - 1, -1, a)
        if mine and theirs >= mine and gives(env[a2 + mine:b2], env[a2:a2 + mine]):
            cut = (a2 + mine) * FRAME_S
            span[i + 1][0] = min(span[i + 1][1], max(span[i + 1][0], cut))
            span[i][1] = max(span[i][1], cut)
    return [tuple(x) for x in span]


def _burst_spans(env, level, a=0, b=None):
    """The separate bursts of frames at or over `level` in frames [a, b), as (first, end) frames: a dip of
    BURST_GAP_FRAMES or more under it splits two."""
    b = len(env) if b is None else b
    out, low = [], BURST_GAP_FRAMES
    for k in range(a, b):
        if env[k] >= level:
            if low >= BURST_GAP_FRAMES or not out:
                out.append([k, k + 1])
            else:
                out[-1][1] = k + 1
            low = 0
        else:
            low += 1
    return [tuple(x) for x in out]


def _bursts(env, start, end, level):
    """How many separate bursts of frames at or over `level` lie in [start, end]."""
    return len(_burst_spans(env, level, *_frames(env, start, end)))


def at_noise(env, noise, start, end) -> bool:
    """Every frame of [start - AT_NOISE_PAD_S, end + AT_NOISE_PAD_S] is within AT_NOISE_DB of the room."""
    a, b = _frames(env, max(0.0, start - AT_NOISE_PAD_S), end + AT_NOISE_PAD_S)
    return all(v <= noise + AT_NOISE_DB for v in env[a:b])


def speech_level(env) -> float:
    """The source's speech level: its SPEECH_PERCENTILE-th percentile frame (digital silence left out)."""
    vals = [v for v in env if v > _SILENT_DB]
    return _pct(vals, SPEECH_PERCENTILE) if vals else _SILENT_DB


def sound_frames(env, speech):
    """One byte a frame, 1 for sound. A frame is SOUND when it is at most SILENCE_BELOW_SPEECH_DB under the
    `speech` level, or a soft sound: AUDIBLE_OVER_NOISE_DB over the quiet frames' own room (the NOISE_PERCENTILE-th
    percentile of the frames under that level, those ROOM_DIP_DB or more under their median left out, whatever the
    noise reading's trust) for SOUND_MIN_FRAMES frames in a
    row, so a soft word's own sound is never silence and a stray frame of room tone is. Every other frame is
    silence, for the trim (refine), never a removal."""
    lvl = speech - SILENCE_BELOW_SPEECH_DB
    low = [v for v in env if _SILENT_DB < v < lvl]
    if low:
        mid = statistics.median(low)
        low = [v for v in low if v >= mid - ROOM_DIP_DB]       # a dip (a gate, a camera's first frames) is not the room
    soft = (_pct(low) if low else lvl) + AUDIBLE_OVER_NOISE_DB
    n = len(env)

    def runs(test):
        out, k = [], 0
        while k < n:
            if test(env[k]):
                m = k
                while m < n and test(env[m]):
                    m += 1
                out.append((k, m))
                k = m
            else:
                k += 1
        return out
    snd = bytearray(1 if v >= lvl else 0 for v in env)
    for a, b in runs(lambda v: v >= min(lvl, soft)):
        if b - a >= SOUND_MIN_FRAMES:
            snd[a:b] = b"\x01" * (b - a)
    return snd


def _trim_silence(out, words, kind, env, snd, hole, gone=frozenset()):
    """Fix pass 4: no heard word's placed span keeps the silence whisper stretched it over. A word's sound frames
    (sound_frames) are grouped, a run of silence over `hole` seconds (max-pause) splitting two groups. A word with
    more than one group gives some to its heard neighbours, so the silence between becomes a gap between words, which
    dead air and max-pause trim (whisper placed the neighbour late or early, its sound in this word's span):
    - its first group, when it opens the span and the sound runs on from the word before (no silent frame between),
      goes back to that word;
    - its own sound is the first group left, of SOUND_MIN_FRAMES frames or more (a lone frame before it is dropped);
    - every later group goes to the next word when whisper's span for it follows on (within TOUCH_S) and it is
      heard, or silent and kept (not in `gone`, the words removed as inaudible: whisper placed it late, its sound is here; it is
      then placed on that sound, not folded), in turn: that word keeps the first of them as its own and passes the
      rest on. With no word to take them, they stay, and so does the silence between.
    Then each heard word's span is trimmed to its sound, within its span: the pauses beside it are gaps that dead air
    keeps a breath of and max-pause caps (a soft word's own sound is sound, so it always plays). One with no sound
    frame keeps an anchor of BREATH_S: right after the word before when whisper's spans touch, else at its loudest
    frame. Silent (folded) words are placed after this, against these edges. Returns the indexes of the silent words placed on sound."""
    gap = int(round(hole / FRAME_S))
    n = len(out)

    def groups(i):
        a, b = _frames(env, out[i].start, out[i].end)
        gs = []
        for k in range(a, b):
            if snd[k]:
                if gs and k - gs[-1][1] <= gap:
                    gs[-1][1] = k + 1
                else:
                    gs.append([k, k + 1])
        return gs
    heard = [kind[i] != "silent" for i in range(n)]
    taken = set()
    for i in range(n):
        gs = groups(i) if heard[i] else []
        if len(gs) < 2:
            continue
        w = out[i]
        a = _frames(env, w.start, w.end)[0]
        if (i and heard[i - 1] and gs[0][0] == a and a and snd[a - 1]
                and words[i].start - words[i - 1].end <= TOUCH_S + _EPS):
            out[i - 1] = replace(out[i - 1], end=round(max(out[i - 1].end, gs[0][1] * FRAME_S), 6))
            gs = gs[1:]
        own = next((g for g in gs if g[1] - g[0] >= SOUND_MIN_FRAMES), gs[0])
        later = gs[gs.index(own) + 1:]
        st, en = own[0] * FRAME_S, w.end
        if (later and i + 1 < n and (heard[i + 1] or i + 1 not in gone)
                and words[i + 1].start - words[i].end <= TOUCH_S + _EPS):
            out[i + 1] = replace(out[i + 1], start=round(min(out[i + 1].start, later[0][0] * FRAME_S), 6))
            en = own[1] * FRAME_S
            if not heard[i + 1]:
                heard[i + 1] = True
                taken.add(i + 1)
        out[i] = replace(w, start=round(max(w.start, st), 6), end=round(min(w.end, max(st, en)), 6))
    for i, w in enumerate(out):
        if not heard[i]:
            continue
        a, b = _frames(env, w.start, w.end)
        if b <= a:
            continue
        gs = groups(i)
        if not gs:
            # an anchor: against the word before when whisper's spans touch (its sound is there, as a folded
            # word's is), else at its loudest frame
            if i and heard[i - 1] and words[i].start - words[i - 1].end <= TOUCH_S + _EPS and out[i - 1].end <= w.end:
                st = out[i - 1].end
            else:
                st = max(w.start, max(range(a, b), key=lambda k: (env[k], -k)) * FRAME_S)
            out[i] = replace(w, start=round(st, 6), end=round(st + BREATH_S, 6))
            continue
        st = max(w.start, gs[0][0] * FRAME_S)
        en = min(w.end, gs[-1][1] * FRAME_S + RELEASE_S)          # a soft ending survives (B4)
        if st > w.start + _EPS or en < w.end - _EPS:
            out[i] = replace(w, start=round(st, 6), end=round(max(st, en), 6))
    return taken


def refine(words, env, floor, noise=None, trusted=None, speech=None, hole=None):
    """(words placed by the audio, stats {inaudible, quiet, folded, heard: [word index], inside_words: [], inside,
    attached, orphan, untrimmed: [Word]}, silences [(start, end)]). See the module docstring. `trusted`: whether the
    noise reading came from enough frames outside the words (noise_reading); nothing is inaudible when it did not.
    `speech`: the source's speech level (speech_level); `hole`: max-pause, for the silence trim (_trim_silence).
    stats["untrimmed"]: the words placed as before the silence trim (fix pass 4). The take rules read those, through
    speech_text.take_span: lines, units, breaks and phrase times, so the trim changes only the timeline, never a
    take, a break or a flag."""
    before, _, _ = _refine(words, env, floor, noise, trusted, speech, hole, trim=False)
    out, stats, sils = _refine(words, env, floor, noise, trusted, speech, hole, trim=True)
    stats["untrimmed"] = before
    return out, stats, sils


def _refine(words, env, floor, noise, trusted, speech, hole, trim):
    if noise is None:
        noise, trusted = noise_reading(words, env)
    elif trusted is None:
        trusted = noise_reading(words, env)[1]
    heard = heard_db(floor, noise)
    edge = max(noise + AUDIBLE_OVER_NOISE_DB, floor - EDGE_BELOW_FLOOR_DB)
    n, end_s = len(words), len(env) * FRAME_S
    span = _edge_runs(words, env, heard, floor)
    out, kind, core = list(words), [], []
    for i, w in enumerate(words):
        a, b = _frames(env, *span[i])
        pk = max(env[a:b], default=_SILENT_DB)
        thr = floor if pk >= floor else heard if pk >= heard else None
        if thr is None:
            kind.append("silent")
            core.append(None)
            continue
        kind.append("loud" if thr == floor else "quiet")
        loud = [k for k in range(a, b) if env[k] >= thr]
        core.append((loud[0] * FRAME_S, (loud[-1] + 1) * FRAME_S))
        # its audible span: every heard frame of its span, a soft burst (whisper's misplaced neighbour) too (R3-B1)
        audible = [k for k in range(a, b) if env[k] >= heard]
        s, e = audible[0], audible[-1] + 1
        # its span, and the free time beside it that no other word's span claims
        lo_t = span[i][0] if i and span[i - 1][1] >= span[i][0] else (span[i - 1][1] if i else 0.0)
        hi_t = span[i][1] if i + 1 < n and span[i + 1][0] <= span[i][1] else (span[i + 1][0] if i + 1 < n else end_s)
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
    # the misplaced-word rules below read the spans as they were before the silence trim, so the trim never
    # changes which word is removed or offered (fix pass 4, rule a); the silent words fold against the trimmed edges
    pre = list(out)
    folds = []                  # (i, j, host): placed after the silence trim, against the trimmed edges

    def excess(k):
        return (pre[k].end - pre[k].start) - _expected(words[k])

    def holds(k, m, need):
        """Heard word k holds m silent words' sound: it is long for its own text by `need`, or its span holds a
        separate burst of sound for each of them (a run said at a normal pace)."""
        return (excess(k) > 0 and excess(k) >= need) or _bursts(env, pre[k].start, pre[k].end, heard) - 1 >= m

    bursts = _burst_spans(env, heard)

    def sound_for(i, j):
        def count(t0, t1):
            return sum(1 for a, b in bursts if b * FRAME_S > t0 + _EPS and a * FRAME_S < t1 - _EPS)
        return count(0.0, words[j - 1].end) >= j or count(words[i].start, end_s) >= n - i

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
        held = next((k for k in sorted(hosts, key=lambda k: (-excess(k), k)) if holds(k, j - i, need)), None)
        if j - i >= INAUDIBLE_RUN and held is None and sound_for(i, j):
            # whisper put the run's words away from their sound: as many bursts of sound lie before the run's end as
            # there are words to its end (or after its start as words from it), so their sound may be there (R3
            # should-fix 1): kept, folded, offered
            quiet += list(range(i, j))
            folds.append((i, j, best))
            folded += [words[x].idx for x in range(i, j)]
            i = j
            continue
        if j - i >= INAUDIBLE_RUN and held is None:
            # the conservative rule (2b): a word of the run goes only at the room's own level over its whole span
            # and AT_NOISE_PAD_S beside it, on a trusted reading; every other one stays, folded, and is offered
            at = [trusted and at_noise(env, noise, words[k].start, words[k].end) for k in range(i, j)]
            g0, g1, k = i, i, i                 # the longest block of them at the room's level: [g0, g1)
            while k < j:
                m = k
                while m < j and at[m - i]:
                    m += 1
                if m - k > g1 - g0:
                    g0, g1 = k, m
                k = m + 1
            # what is left of the run folds into the heard word beside it; with none there, nothing goes
            if (g0 > i and i == 0) or (g1 < j and j == n):
                g0 = g1 = i
            if g1 > g0:
                inaudible += [words[k].idx for k in range(g0, g1)]
                for lo, hi, host in ((i, g0, i - 1), (g1, j, j)):
                    if hi > lo:
                        folds.append((lo, hi, host))
                        folded += [words[x].idx for x in range(lo, hi)]
                        quiet += list(range(lo, hi))
                i = j
                continue
            quiet += list(range(i, j))
            folds.append((i, j, best))
            folded += [words[x].idx for x in range(i, j)]
            i = j
            continue
        folds.append((i, j, held if held is not None else best))
        folded += [words[k].idx for k in range(i, j)]
        i = j
    taken = set()
    if trim:
        gone = set(inaudible)
        taken = _trim_silence(out, words, kind, env, sound_frames(env, speech_level(env) if speech is None else speech),
                              _DEFAULT_MAX_PAUSE_S if hole is None else hole,
                              {k for k in range(n) if words[k].idx in gone})
    for i, j, host in folds:
        _fold_around(out, words, i, j, host, taken)
    folded = [x for x in folded if x not in {words[k].idx for k in taken}]
    sils, run_start = [], None
    for k, v in enumerate(env + [0.0]):
        if v < floor and k < len(env):
            run_start = k if run_start is None else run_start
        elif run_start is not None:
            if (k - run_start) * FRAME_S >= MIN_SILENCE_S - 1e-9:
                sils.append((round(run_start * FRAME_S, 6), round(k * FRAME_S, 6)))
            run_start = None
    stats = {"inaudible": inaudible, "quiet": [words[k].idx for k in sorted(set(quiet))], "folded": folded,
             "heard": [words[k].idx for k in range(n) if kind[k] != "silent" or k in taken],
             "inside_words": [], "inside": 0, "attached": 0, "orphan": 0}
    return out, stats, sils


def _fold_around(out, words, i, j, host, taken):
    """_fold of silent words i..j-1, but for those the silence trim placed on sound (`taken`): each run of the rest
    folds against the nearest placed word on its host's side (a taken one, or the host), so the order holds."""
    k = i
    while k < j:
        if k in taken:
            k += 1
            continue
        m = k
        while m < j and m not in taken:
            m += 1
        h = host
        if host is not None and host < i and k > i:
            h = k - 1                                    # the taken word right before this run
        elif host is not None and host >= j and m < j:
            h = m                                        # the taken word right after it
        _fold(out, words, k, m, h)
        k = m


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


_STAMPED = ("FRAME_S", "FLOOR_BELOW_SPEECH_DB", "FLOOR_RANGE_DB", "MIN_SILENCE_S", "INAUDIBLE_RUN", "LONE_WORD_S",
            "NOISE_PERCENTILE", "NOISE_MIN_FRAMES", "NOISE_FALLBACK_PERCENTILE", "AUDIBLE_OVER_NOISE_DB", "AT_NOISE_DB",
            "AT_NOISE_PAD_S", "BURST_GAP_FRAMES", "EDGE_BLEED_FRAMES", "EDGE_BELOW_FLOOR_DB", "RELEASE_S", "LETTER_S",
            "WORD_BASE_S", "MISPLACED_SHARE", "ISLAND_S", "EDGE_REACH_S", "SPEECH_PERCENTILE",
            "SILENCE_BELOW_SPEECH_DB", "SOUND_MIN_FRAMES", "ROOM_DIP_DB", "TOUCH_S", "BREATH_S")


class Refiner:
    """What speech_text.derive calls for each source instead of speech_lines.refine: (words, stats, silences).
    Measures each media once per process; `floor`, `noise`, `trusted` and `env` say what it measured, for cut's
    plan, and `quiet_words` / `heard` the word indexes it found quiet (offered) and heard, per source. `max_pause`
    (cut sets it): the most pause tidy restores when it joins an island to its neighbour."""

    def __init__(self, max_pause=None):
        self.env, self.floor, self.noise, self.trusted, self.quiet_words, self.heard = {}, {}, {}, {}, {}, {}
        self.speech, self.sound = {}, {}
        self.whole = set()          # item ids of clips kept whole (cut sets it): tidy never trims their edges
        self.max_pause = max_pause

    stamp = VERSION + " " + " ".join(f"{k}={globals()[k]}" for k in _STAMPED)

    def __call__(self, key, media, raw):
        if key not in self.env:
            self.env[key] = envelope(media)
            self.noise[key], self.trusted[key] = noise_reading(raw, self.env[key])
            self.floor[key] = floor_db(raw, self.env[key], self.noise[key])
            self.speech[key] = speech_level(self.env[key])
            self.sound[key] = sound_frames(self.env[key], self.speech[key])
        words, stats, sils = refine(raw, self.env[key], self.floor[key], self.noise[key], self.trusted[key],
                                    self.speech[key], self.max_pause)
        self.quiet_words[key] = set(stats["quiet"])
        self.heard[key] = set(stats["heard"])
        return words, stats, sils

    def quiet(self, key, start, end) -> bool:
        """Every frame of [start, end] is under the floor or silence (sound_frames: 30 dB under the source's speech
        level, fix pass 4), so dead air is read on the speech level too, whatever the floor's clamp."""
        if key not in self.env:
            return False
        env, floor, snd = self.env[key], self.floor[key], self.sound[key]
        a, b = _frames(env, start, end)
        return all(env[k] < floor or not snd[k] for k in range(a, b))

    def end(self, key) -> float:
        """The measured length of the source, in seconds."""
        return len(self.env.get(key, ())) * FRAME_S

    def tidy(self, runs, derived, report=None):
        """The apply's runs with no partial word and no sliver (see the module function)."""
        return tidy(runs, derived, self, report)


# ── the kept pieces: no partial word, no sliver, no island (§558 dead slivers, P3-1) ─────────────────────────


def tidy(runs, derived, refiner, report=None):
    """The speech runs of an apply, cleaned so that every kept piece is speech:
    - a FRAGMENT, a heard word only part of whose span a piece plays, never stays: a kept word is restored whole
      (its edges reach out over the rest of its span, never over another piece of its source); a removed word's
      part is trimmed off the piece. The same by the audio (P3-3): a piece never ends, or starts, inside loud
      sound that goes on into audio the cut removed. Sound of a removed word is trimmed off (never into a kept
      word); any other sound is played to where it falls quiet;
    - a SLIVER, a piece shorter than ISLAND_S that holds no whole heard word, goes: merged into the neighbouring
      piece of its source it follows on from (that piece keeps as much more silence, up to the next heard word),
      else dropped. At a clip's start or end there is one neighbour;
    - an ISLAND, a piece shorter than ISLAND_S that holds a heard word, never stands alone between two cuts: (a)
      where the cut beside it removed only pause (no word), that cut keeps the pause, up to the refiner's
      max_pause, so the piece joins its neighbour at natural timing (never across a removed word); (b) else it is
      widened into its own dead air (quiet audio, never a removed word) to ISLAND_S; (d) else it is kept, as it
      is. A heard word is never dropped or shortened.
    report.flagged gets {"kind": "sliver", "letter", "idx", "seconds"} for each dropped sliver that held words
    (silent ones: a word folded into a removed word), {"kind": "island_join", "letter", "after", "before"} for each
    cut (a) took back between kept words `after` and `before`, and {"kind": "island", "letter", "idx", "seconds"}
    for each island left short (d). Returns the runs."""
    by_letter = {}
    for ln in derived.lines.values():
        by_letter.setdefault(ln.id.rstrip("0123456789"), []).extend(ln.words)
    words_of = {src: sorted(by_letter.get(letter, []), key=lambda w: w.start) for src, letter in derived.letters.items()}
    heard_of = {src: refiner.heard.get(src, set()) for src in words_of}
    speech = [r for r in runs if r.kind == "speech" and r.src in words_of]
    max_pause = getattr(refiner, "max_pause", None)
    max_pause = _DEFAULT_MAX_PAUSE_S if max_pause is None else max_pause

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

    _loud_edges(speech, words_of, refiner, others)

    def whole_heard(r):
        return any(w.idx in r.words and w.idx in heard_of[r.src] and w.start >= r.s_in - _EPS and w.end <= r.s_out + _EPS
                   for w in words_of[r.src])

    def reach_after(r, t, strict=False):
        """How far a piece ending at t may play on: never into a heard word it does not keep (strict: into any word
        it does not keep), never over another word's middle (derive would read that word as played), never past
        the source."""
        stops = [refiner.end(r.src) or float("inf")]
        for w in words_of[r.src]:
            if w.idx in r.words:
                continue
            at = w.start if (strict or w.idx in heard_of[r.src]) else (w.start + w.end) / 2 - 0.005
            if at >= t - _EPS:
                stops.append(at)
        return min(stops)

    def reach_before(r, t, strict=False):
        stops = [0.0]
        for w in words_of[r.src]:
            if w.idx in r.words:
                continue
            at = w.end if (strict or w.idx in heard_of[r.src]) else (w.start + w.end) / 2 + 0.005
            if at <= t + _EPS:
                stops.append(at)
        return max(stops)

    def heard_between(src, a, b):
        return any(w.idx in heard_of[src] and min(w.end, b) - max(w.start, a) > _EPS for w in words_of[src])

    def word_between(src, a, b, mine):
        return any(w.idx not in mine and min(w.end, b) - max(w.start, a) > _EPS for w in words_of[src])

    def kept_span(r):
        """(start of its first kept word, end of its last), by the placed words; None for a piece of no word."""
        ws = [w for w in words_of[r.src] if w.idx in r.words]
        return (min(w.start for w in ws), max(w.end for w in ws)) if ws else None

    def letter_of(r):
        return derived.letters[r.src]

    out = list(runs)

    def neighbour(k, side):
        j = k + side
        o = out[j] if 0 <= j < len(out) else None
        return o if o is not None and o.kind == "speech" and o.src == out[k].src else None

    def bound_before(r, t):
        """The earliest time a piece starting at t may start: its source's other pieces, any word it does not keep,
        and the quiet audio before it."""
        lo = max([reach_before(r, t, strict=True)] + [o.s_out for o in out if o is not r and o.kind == "speech"
                                                      and o.src == r.src and o.s_out <= t + _EPS])
        return max(lo, _quiet_from(refiner, r.src, t, -1, lo))

    def bound_after(r, t):
        hi = min([reach_after(r, t, strict=True)] + [o.s_in for o in out if o is not r and o.kind == "speech"
                                                     and o.src == r.src and o.s_in >= t - _EPS])
        return min(hi, _quiet_from(refiner, r.src, t, 1, hi))

    k = 0
    while k < len(out):
        r = out[k]
        dur = r.s_out - r.s_in
        if r.kind != "speech" or r.src not in words_of or dur >= ISLAND_S - _EPS:
            k += 1
            continue
        if not whole_heard(r):
            # a sliver: merged into the piece it follows on from (nothing heard between them), else dropped
            p, q = neighbour(k, -1), neighbour(k, 1)
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
                report.flagged.append({"kind": "sliver", "letter": letter_of(r), "idx": list(r.words),
                                       "seconds": round(dur, 3)})
            del out[k]
            continue
        # (a) the cut beside it removed only pause: it keeps that pause, up to max_pause
        joined = None
        for side in (-1, 1):
            o = neighbour(k, side)
            if o is None:
                continue
            lo, hi = (o.s_out, r.s_in) if side < 0 else (r.s_out, o.s_in)
            if hi < lo - _EPS or word_between(r.src, lo, hi, set(r.words) | set(o.words)):
                continue
            first, last = (o, r) if side < 0 else (r, o)
            a_end = (kept_span(first) or (first.s_out, first.s_out))[1]
            b_start = (kept_span(last) or (last.s_in, last.s_in))[0]
            if b_start - a_end <= max_pause + _EPS:
                if report is not None and first.words and last.words:
                    report.flagged.append({"kind": "island_join", "letter": letter_of(r), "after": first.words[-1],
                                           "before": last.words[0]})
                first.s_out, first.old_out, first.hard_out = last.s_out, last.old_out, last.hard_out
                first.words = list(first.words) + list(last.words)
                out.remove(last)
                joined = first
                break
            more = max(0.0, max_pause - ((lo - a_end) + (b_start - hi)))
            if side < 0:
                r.s_in, r.old_in, r.hard_in = max(lo, r.s_in - more), None, False
            else:
                r.s_out, r.old_out, r.hard_out = min(hi, r.s_out + more), None, False
        if joined is not None:
            k = out.index(joined)
            continue
        # (b) widened into its own dead air, half on each side where it can
        need = ISLAND_S - (r.s_out - r.s_in)
        if need > _EPS:
            lo, hi = bound_before(r, r.s_in), bound_after(r, r.s_out)
            left = min(need / 2, max(0.0, r.s_in - lo))
            right = min(need - left, max(0.0, hi - r.s_out))
            left = min(need - right, max(0.0, r.s_in - lo))
            if left > _EPS:
                r.s_in, r.old_in, r.hard_in = round(r.s_in - left, 6), None, False
            if right > _EPS:
                r.s_out, r.old_out, r.hard_out = round(r.s_out + right, 6), None, False
        if r.s_out - r.s_in < ISLAND_S - _EPS and report is not None:
            report.flagged.append({"kind": "island", "letter": letter_of(r), "idx": list(r.words),
                                   "seconds": round(r.s_out - r.s_in, 3)})
        k += 1
    merged = []
    for r in out:
        p = merged[-1] if merged else None
        if (p is not None and p.kind == r.kind == "speech" and p.src == r.src and abs(p.s_out - r.s_in) <= 0.001
                and not (p.old_out and r.old_in)):
            p.s_out, p.old_out, p.hard_out = r.s_out, r.old_out, r.hard_out
            p.words.extend(r.words)
            continue
        merged.append(r)
    _video_edges(merged, words_of, refiner)
    return merged


def _video_edges(runs, words_of, refiner):
    """Fix pass 4 (Sam, pov v3): the video opens and ends on sound. The first speech piece starts BREATH_S before
    its first sound or kept word, the last ends BREATH_S after its last, never inside a kept word and never so short
    that it becomes an island (ISLAND_S): the island rule wins. A piece of a clip kept whole (refiner.whole: cut's
    b-roll) is left as it is."""
    speech = [r for r in runs if r.kind == "speech" and r.src in words_of]
    if not speech:
        return
    whole = getattr(refiner, "whole", None) or ()
    for r, side in ((speech[0], -1), (speech[-1], 1)):
        if r.item_id in whole:
            continue
        env, snd = getattr(refiner, "env", {}).get(r.src), getattr(refiner, "sound", {}).get(r.src)
        if env is None or snd is None:
            continue
        a, b = _frames(env, r.s_in, r.s_out)
        hits = [k for k in range(a, b) if snd[k]]
        own = [w for w in words_of[r.src] if w.idx in r.words]
        if side < 0:
            t = min([k * FRAME_S for k in hits[:1]] + [w.start for w in own], default=None)
            if t is not None:
                to = min(max(r.s_in, t - BREATH_S), r.s_out - ISLAND_S)
                if to > r.s_in + _EPS:
                    r.s_in, r.old_in, r.hard_in = round(to, 6), None, False
        else:
            t = max([(k + 1) * FRAME_S for k in hits[-1:]] + [w.end for w in own], default=None)
            if t is not None:
                to = max(min(r.s_out, t + BREATH_S), r.s_in + ISLAND_S)
                if to < r.s_out - _EPS:
                    r.s_out, r.old_out, r.hard_out = round(to, 6), None, False


def _quiet_from(refiner, src, t, step, limit):
    """From t, in direction step, the farthest time toward `limit` over frames all under the source's floor (the
    whole way when the refiner measured no audio for it)."""
    env, floor = getattr(refiner, "env", {}).get(src), getattr(refiner, "floor", {}).get(src)
    if env is None or floor is None:
        return limit
    k = int(round(t / FRAME_S))
    if step > 0:
        stop = min(len(env), int(math.ceil(limit / FRAME_S - 1e-9)))
        while k < stop and env[k] < floor:
            k += 1
        return min(limit, k * FRAME_S)
    stop = max(0, int(math.floor(limit / FRAME_S + 1e-9)))
    while k - 1 >= stop and env[k - 1] < floor:
        k -= 1
    return max(limit, k * FRAME_S)


def _loud_edges(speech, words_of, refiner, others):
    """P3-3: no piece ends (or starts) inside loud sound that goes on into removed audio. When the sound beyond
    is a removed word's (by its placed span), the piece is trimmed back to where that sound starts, never into
    one of its own kept words; any other sound (a word's onset whisper placed in its neighbour) plays on to where
    it falls under the edge level, never into a word the piece does not keep or another piece."""
    env_of, floor_of, noise_of = (getattr(refiner, k, {}) for k in ("env", "floor", "noise"))
    kept_idx = {}
    for r in speech:
        kept_idx.setdefault(r.src, set()).update(r.words)
    for r in speech:
        env, floor = env_of.get(r.src), floor_of.get(r.src)
        if env is None or floor is None:
            continue
        level = max(noise_of.get(r.src, floor - 40.0) + AUDIBLE_OVER_NOISE_DB, floor - EDGE_BELOW_FLOOR_DB)
        n = len(env)

        def loud(k):
            return 0 <= k < n and env[k] >= floor

        def played(t):
            return any(o.s_in - _EPS <= t <= o.s_out + _EPS for o in others(r))

        def owner(t):
            return next((w for w in words_of[r.src] if w.idx not in kept_idx[r.src] and w.start - _EPS <= t < w.end
                         and w.end - w.start > _EPS), None)
        own = [w for w in words_of[r.src] if w.idx in r.words]
        # the end
        e, was = int(round(r.s_out / FRAME_S)), r.s_out
        if loud(e - 1) and loud(e) and not played((e + 0.5) * FRAME_S):
            if owner((e + 0.5) * FRAME_S) is not None:
                k = e
                while k - 1 >= 0 and env[k - 1] >= level and (k - 1) * FRAME_S > r.s_in:
                    k -= 1
                r.s_out = max(r.s_in, k * FRAME_S, max((w.end for w in own), default=r.s_in))
            else:
                stop = min([refiner.end(r.src) or n * FRAME_S] + [o.s_in for o in others(r) if o.s_in >= r.s_out - _EPS]
                           + [w.start for w in words_of[r.src] if w.idx not in r.words and w.start >= r.s_out - _EPS])
                k = e
                while k < n and env[k] >= level and (k + 1) * FRAME_S <= stop + _EPS:
                    k += 1
                if (k - e) * FRAME_S <= EDGE_REACH_S + _EPS:          # a word's onset or decay, not a music bed
                    r.s_out = max(r.s_out, min(stop, k * FRAME_S + RELEASE_S))
            if abs(r.s_out - was) > _EPS:
                r.old_out, r.hard_out = None, False
        # the start
        a, was = int(round(r.s_in / FRAME_S)), r.s_in
        if loud(a) and loud(a - 1) and not played((a - 0.5) * FRAME_S):
            if owner((a - 0.5) * FRAME_S) is not None:
                k = a
                while k < n and env[k] >= level and (k + 1) * FRAME_S < r.s_out:
                    k += 1
                r.s_in = min(r.s_out, k * FRAME_S, min((w.start for w in own), default=r.s_out))
            else:
                stop = max([0.0] + [o.s_out for o in others(r) if o.s_out <= r.s_in + _EPS]
                           + [w.end for w in words_of[r.src] if w.idx not in r.words and w.end <= r.s_in + _EPS])
                k = a
                while k - 1 >= 0 and env[k - 1] >= level and (k - 1) * FRAME_S >= stop - _EPS:
                    k -= 1
                if (a - k) * FRAME_S <= EDGE_REACH_S + _EPS:
                    r.s_in = min(r.s_in, max(stop, k * FRAME_S - RELEASE_S))
            if abs(r.s_in - was) > _EPS:
                r.old_in, r.hard_in = None, False
