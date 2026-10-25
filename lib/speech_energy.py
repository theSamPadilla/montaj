"""Where the sound is, and where whisper's words sit on it (§558 cut v5): two layers.

Layer 1, WHERE THE SOUND IS: steps/audio/waveform_trim.process_one per source, on the source's own 10 ms RMS
reading (`envelope`, the louder channel of each frame). Three adaptations, in this wrapper only:
1. the threshold is the source's speech level (waveform_trim.speech_level, its 95th-percentile frame) less
   SILENCE_BELOW_SPEECH_DB, never an absolute level, so a gain-down clip is read on its own speech;
2. a breath: every keep widens by `breath` (BREATH_S) into the silence beside it, or by half of min(silence,
   SENTENCE_END_S) after a sentence end, so a silence keeps 2 x breath in all (D1: min(gap, 0.18) at a sentence
   end). A source's own start and end keep one breath, so the video opens and ends on sound;
3. the shortest silence is max-pause: a flat run shorter than that stays (a pause), and so does any frame of sound,
   however short (min_keep 0). A run of flat frames (each SILENCE_BELOW_SPEECH_DB or more under the speech level)
   touching the source's start or end is a silence at any length.
The silences are waveform_trim.envelope_silences of that reading: silencedetect reads sample peaks, which soft
noise breaks up (measured on a replica of pov's opening: bursts 45 dB under the speech, read as sound). The keeps
ARE the voiced runs; whisper's spans never decide silence. A keep shorter than ISLAND_S widens into its own silences
to ISLAND_S, the side away from a source edge first, so no flash of sound stands alone (P3-1).

Layer 2, WHAT TO REMOVE, is whisper's words (cut's take rules). Here each word is placed on layer 1 (`place`):
- a word with VOICED frames (not flat) in its span is placed on them: from its first to its last voiced frame
  within one voiced run, widened over voiced frames beside it that no other word's span holds (up to DRIFT_S).
  Whisper drift: EDGE_BLEED_FRAMES or fewer voiced frames at its span's edge, after a flat frame of its own span,
  that go on into a neighbour's span are that neighbour's (R3-B1); when its span takes in a silence, a run of sound
  of DRIFT_S or less at its start that goes on from the sound the word before is placed on is that word's, and one
  at its end that goes on into the next word's span is the next word's; of what is left, the run with the most
  voiced frames is its own. So removing a word removes exactly its voiced regions;
- ATTACHED (the orchestrator's rule, binding): a word with no voiced frame between the source's first and last heard
  words, with a heard word on each side or within max-pause of one, keeps its own sound under the line: the frames
  of its span at or over the speech level less ATTACHED_BELOW_SPEECH_DB are voiced for layer 1 (layer 1 is read
  again with them), so it is heard. Never the lead or tail, and never sound with no word attached (a breath);
- a word with no voiced frame is OFFERED (stats["quiet"]: cut tags it `inaudible?`) and kept: where its span meets a
  voiced run (a pause inside the keeps), it is placed there;
- a word whose span lies wholly in a silence is INAUDIBLE (stats["inaudible"]), unless whisper misplaced it (the
  landing bar: a lone such word between placed words, or a run a heard neighbour holds, long for its own text,
  LETTER_S a letter plus WORD_BASE_S by MISPLACED_SHARE of the run's letters, or with a burst of sound for each word):
  those are folded FOLD_S against that neighbour's sound, inside its breath, and offered (stats["folded"]). An
  inaudible word is placed INAUDIBLE_S long at the far end of the kept piece of the heard word before it, so the base
  plays it, cut removes it and tags it inaudible, and nothing of any other sound goes with it.
Voiced sound that belongs to no word stays where the keeps hold it, but none before a source's first word or after
its last. The placed spans are what the take, break and F1 rules read too (stats["untrimmed"],
speech_text.take_span): the silence trim never moves them.

The silence trim is a pure function of the kept source intervals and layer 1 (`tidy`): every kept speech run is cut
to layer 1's keeps, so a silence over max-pause inside it keeps only its breaths, and it never touches a voiced
frame. Then no kept piece shorter than ISLAND_S stands alone: (a) it joins its neighbour across a pause cut when no
word lies between and the joined piece holds no flat run over max-pause; (b) else it widens into its own silence
(flat frames, never a removed word or another piece, and never past VIDEO_EDGE_S of flat at the video's edges); (c) a
piece with no voiced frame goes (a sliver); (d) any other stays and is named. The video's first piece opens a breath
before its first voiced frame, and its last ends a breath after its last. A clip kept whole (cut's b-roll,
Refiner.whole) is left as it is.

cut uses this through `Refiner`, which speech_text.derive calls in place of speech_lines.refine (in the plan and in
its apply alike) and whose `tidy` cleans the apply's runs. speech_edit is unchanged.

The envelope reads the whole source into memory (16 kHz, 2 bytes a sample a channel: about 115 MB an hour of
stereo); streaming it is left for long sources, if one needs it.
"""
import math
import os
import subprocess
import tempfile
import wave
from array import array
from dataclasses import dataclass, field, replace

from lib.common import fail, ff_path, ffmpeg_bin, run
from lib.speech_lines import _ends_sentence
from steps.audio import waveform_trim

VERSION = "speech-energy v5"
FRAME_S = waveform_trim.FRAME_S
RATE = 16000
SPEECH_PERCENTILE = waveform_trim.SPEECH_PERCENTILE
SILENCE_BELOW_SPEECH_DB = 30.0   # a frame this far under the source's speech level is flat (silence)
ATTACHED_BELOW_SPEECH_DB = 40.0  # ... but an attached word's own frames down to this far under it are its sound
BREATH_S = 0.04                  # what a silence keeps beside the sound, each side
SENTENCE_END_S = 0.18            # what a silence after a sentence end keeps in all, at most (D1)
ISLAND_S = 0.35                  # no kept piece shorter than this stands alone
VIDEO_EDGE_S = 0.1               # the most flat before the video's first sound or after its last (the island rule too)
DRIFT_S = 0.25                   # how far whisper's word times drift from the sound
EDGE_BLEED_FRAMES = 3            # this many voiced frames or fewer at a span's edge, going on into the neighbour's
                                 # span, are the neighbour's sound
FOLD_S = 0.01                    # an offered word with no sound of its own is placed this long, against the sound
INAUDIBLE_S = 0.002              # an inaudible word is placed this long, at the end of the sound before it
LETTER_S = 0.09                  # a heard word longer than LETTER_S a letter plus WORD_BASE_S holds more words
WORD_BASE_S = 0.2
MISPLACED_SHARE = 0.5            # ... the run's letters' share of LETTER_S it must have to spare to hold them
MIN_KEEP_S = 0.0                 # process_one's min_keep: no keep of sound is ever too short to keep
MEASURED_SILENCE_S = 0.06        # flat runs this long are the "measured silences" speech_build snaps a cut into
DECODE_TIMEOUT_S = 600
DEFAULT_MAX_PAUSE_S = 0.45       # speech_build's natural feel, when the refiner was given none
_SILENT_DB = -120.0
_EPS = 1e-6


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


# ── layer 1: where the sound is ─────────────────────────────────────────────────────────────────────────────


@dataclass
class Layer:
    """Layer 1 of one source. flat: one byte a frame, 1 for a flat frame; silences: (start, end) s, each a run of
    flat frames of max-pause or more (or touching the source's start or end); voiced: process_one's keeps between
    them, the voiced runs, before any breath; keeps: the voiced runs with their breaths and island widening (set by
    Refiner.keeps); held: silences kept whole (cut's D2: an overlay starts in it)."""
    env: list
    speech: float
    threshold: float
    flat: bytearray
    silences: list
    voiced: list
    end: float
    measured: list = field(default_factory=list)
    keeps: list | None = None
    held: set = field(default_factory=set)
    attached: set = field(default_factory=set)


def layer1(media, env, max_pause, attached=frozenset()):
    """Layer 1 of `media` (see the module docstring), from its envelope `env`. attached: frames an attached word's
    own sound holds (_attached_frames): voiced, though under the line."""
    end = len(env) * FRAME_S
    if not env:
        return Layer(env, _SILENT_DB, _SILENT_DB, bytearray(), [], [[0.0, end]], end)
    speech = waveform_trim.speech_level(env)
    thr = speech - SILENCE_BELOW_SPEECH_DB
    flat = bytearray(1 if v < thr and k not in attached else 0 for k, v in enumerate(env))
    reading = [v if flat[k] else max(v, thr) for k, v in enumerate(env)]    # an attached frame reads as sound
    sils = waveform_trim.envelope_silences(reading, thr, max_pause)
    runs = waveform_trim.flat_runs(reading, thr)
    for a, b in runs:                      # a flat run at the source's start or end is a silence at any length
        if (a == 0 or b == len(env)) and (round(a * FRAME_S, 6), round(b * FRAME_S, 6)) not in sils:
            sils.append((round(a * FRAME_S, 6), round(b * FRAME_S, 6)))
    sils.sort()
    if all(flat):
        voiced = []
    else:
        voiced = waveform_trim.process_one(media, thr, max_pause, silences=sils, min_keep=MIN_KEEP_S,
                                           duration=end)["keeps"]
    measured = [(round(a * FRAME_S, 6), round(b * FRAME_S, 6)) for a, b in runs
                if (b - a) * FRAME_S >= MEASURED_SILENCE_S - 1e-9]
    return Layer(env, speech, thr, flat, sils, [list(k) for k in voiced], end, measured, attached=set(attached))


def _attached_frames(words, placed, kind, lay, max_pause):
    """The orchestrator's attached-word rule (binding, 2026-10-24): a word with no voiced frame is ATTACHED when it
    lies between the source's first and last heard words and has a heard word on each side, or sits within
    max-pause of a heard word's voiced sound. Its own sound under the line, the frames of its span (between the
    heard words beside it) at or over the speech level less ATTACHED_BELOW_SPEECH_DB, is kept: those frames are
    voiced for layer 1. Never before the first heard word or after the last (the lead and tail), and never sound
    no word is attached to (a breath between words stays silence)."""
    heard = [i for i in range(len(words)) if kind[i] == "heard"]
    if len(heard) < 2:
        return set()
    out = set()
    floor = lay.speech - ATTACHED_BELOW_SPEECH_DB
    for i in range(heard[0] + 1, heard[-1]):
        if kind[i] == "heard":
            continue
        prev = max(h for h in heard if h < i)
        nxt = min(h for h in heard if h > i)
        w = words[i]
        near = min(w.start - placed[prev].end, placed[nxt].start - w.end)
        if not ((prev == i - 1 and nxt == i + 1) or near <= max_pause + _EPS):
            continue
        a, b = _frames(lay.env, max(w.start, placed[prev].end), min(w.end, placed[nxt].start))
        out.update(k for k in range(a, b) if lay.env[k] >= floor)
    return out


def _silence_pads(lay, words, placed, kind, breath):
    """{silence index: (pad after the sound before it, pad before the sound after it)}: a breath a side, or half of
    min(silence, SENTENCE_END_S) after a sentence end (the last placed word before the silence ends one). A
    silence at the source's start or end keeps one breath at its sound's side."""
    out = {}
    order = [i for i in range(len(placed)) if kind[i] != "inaudible"]
    for n, (s0, s1) in enumerate(lay.silences):
        length = s1 - s0
        before = [i for i in order if placed[i].end <= s0 + FRAME_S + _EPS]
        pad = breath
        if before and _ends_sentence(words[before[-1]].text):
            pad = max(breath, min(length, SENTENCE_END_S) / 2)
        pad = min(pad, length / 2) if 0 < s0 and s1 < lay.end - _EPS else min(pad, length)
        out[n] = (pad if s0 > _EPS else 0.0, pad if s1 < lay.end - _EPS else 0.0)
    return out


def _keeps(lay, words, placed, kind, breath):
    """Layer 1's keeps: the voiced runs widened by their breaths (_silence_pads) into the silences beside them, a
    held silence kept whole, then each keep under ISLAND_S widened into its own silences (half each side, the side
    away from a source edge first), always leaving some of each silence cut."""
    pads = _silence_pads(lay, words, placed, kind, breath)
    sil = list(lay.silences)
    keeps = []
    for a, b in lay.voiced:
        lo, hi = a, b
        for n, (s0, s1) in enumerate(sil):
            if abs(s1 - a) <= _EPS:
                lo = a if n in lay.held else a - pads[n][1]
                if n in lay.held:
                    lo = s0
            if abs(s0 - b) <= _EPS:
                hi = s1 if n in lay.held else b + pads[n][0]
        keeps.append([max(0.0, round(lo, 6)), min(lay.end, round(hi, 6))])
    # a held silence with no sound on one side (the source's edge) is kept from the edge
    for n in lay.held:
        s0, s1 = sil[n]
        if s0 <= _EPS and keeps and keeps[0][0] > s0:
            keeps[0][0] = 0.0
        if s1 >= lay.end - _EPS and keeps and keeps[-1][1] < s1:
            keeps[-1][1] = lay.end
    # islands: widened into their own silence, leaving MIN_CUT_S of it cut
    for k, kp in enumerate(keeps):
        need = ISLAND_S - (kp[1] - kp[0])
        if need <= _EPS:
            continue
        left_room = kp[0] - (keeps[k - 1][1] + MIN_CUT_S if k else 0.0)
        right_room = (keeps[k + 1][0] - MIN_CUT_S if k + 1 < len(keeps) else lay.end) - kp[1]
        if k == 0:              # never more than VIDEO_EDGE_S of flat before a source's first sound
            left_room = min(left_room, kp[0] - (lay.voiced[0][0] - VIDEO_EDGE_S))
        if k + 1 == len(keeps):
            right_room = min(right_room, lay.voiced[-1][1] + VIDEO_EDGE_S - kp[1])
        left_room, right_room = max(0.0, left_room), max(0.0, right_room)
        at_start, at_end = k == 0 and kp[0] - left_room <= _EPS, k + 1 == len(keeps) and kp[1] + right_room >= lay.end - _EPS
        if at_start and not at_end:
            right = min(need, right_room)
            left = min(need - right, left_room)
        elif at_end and not at_start:
            left = min(need, left_room)
            right = min(need - left, right_room)
        else:
            left = min(need / 2, left_room)
            right = min(need - left, right_room)
            left = min(need - right, left_room)
        kp[0], kp[1] = round(kp[0] - left, 6), round(kp[1] + right, 6)
    merged = []
    for kp in keeps:
        if merged and kp[0] <= merged[-1][1] + _EPS:
            merged[-1][1] = max(merged[-1][1], kp[1])
        else:
            merged.append(kp)
    return merged


MIN_CUT_S = 0.02                 # an island's widening always leaves this much of a silence cut


# ── layer 2: whisper's words, placed on layer 1 ─────────────────────────────────────────────────────────────


def place(words, lay, breath=BREATH_S):
    """(placed words, kind per word: "heard" | "quiet" | "folded" | "inaudible"). See the module docstring."""
    env, flat, n_fr = lay.env, lay.flat, len(lay.env)
    n = len(words)
    if not n_fr:
        return list(words), ["heard"] * n
    vid = [-1] * n_fr                      # the voiced run (layer 1's keeps, before the breath) a frame lies in
    for r, (a, b) in enumerate(lay.voiced):
        for k in range(max(0, int(round(a / FRAME_S))), min(n_fr, int(round(b / FRAME_S)))):
            vid[k] = r
    owner = [-1] * n_fr                    # the word whose whisper span holds a frame's middle
    for i, w in enumerate(words):
        a, b = _frames(env, w.start, w.end)
        for k in range(a, b):
            if owner[k] < 0 and w.start - _EPS <= (k + 0.5) * FRAME_S <= w.end + _EPS:
                owner[k] = i
    drift = int(round(DRIFT_S / FRAME_S))

    def clusters(a, b):
        out = []
        for k in range(a, b):
            if flat[k]:
                continue
            if out and vid[out[-1][0]] == vid[k]:
                out[-1][1] = k + 1
                out[-1][2] += 1
            else:
                out.append([k, k + 1, 1])
        return out

    placed, kind = list(words), [None] * n
    given = {}                              # word index -> (first, end) frames of sound the word before gave it
    for i, w in enumerate(words):
        a, b = _frames(env, w.start, w.end)
        g = given.get(i)
        # a neighbour's edge (R3-B1: gapless spans take in 10-30 ms of the word beside): EDGE_BLEED_FRAMES or fewer
        # voiced frames at its span's end (start), after (before) a flat frame of its own span, that go on into the
        # neighbour's span at least as far as they lie in this one, are the neighbour's
        m = _voiced_run(flat, b - 1, -1, n_fr) if b > a else 0
        if (i + 1 < n and 0 < m <= EDGE_BLEED_FRAMES and b - m - 1 >= a and flat[b - m - 1] and b < n_fr
                and not flat[b] and _voiced_run(flat, b, 1, n_fr) >= m):
            given[i + 1] = (b - m, b, m)
            b -= m
        m = _voiced_run(flat, a, 1, n_fr) if b > a else 0
        if (g is None and i > 0 and kind[i - 1] == "heard" and 0 < m <= EDGE_BLEED_FRAMES and a + m < b
                and flat[a + m] and a > 0 and not flat[a - 1] and _voiced_run(flat, a - 1, -1, n_fr) >= m
                and placed[i - 1].end >= (a - 1) * FRAME_S - _EPS):        # the sound the word before is placed on
            placed[i - 1] = replace(placed[i - 1], end=round(max(placed[i - 1].end, (a + m) * FRAME_S), 6))
            a += m
        cs = clusters(a, b)
        if g is None and len(cs) >= 2 and i > 0 and kind[i - 1] == "heard":
            c = cs[0]
            if (c[0] == a and a > 0 and not flat[a - 1] and c[1] - a <= drift
                    and placed[i - 1].end >= (a - 1) * FRAME_S - _EPS):
                placed[i - 1] = replace(placed[i - 1], end=round(max(placed[i - 1].end, c[1] * FRAME_S), 6))
                cs = cs[1:]
        if len(cs) >= 2 and i + 1 < n:
            c = cs[-1]
            if c[1] == b and b < n_fr and not flat[b] and b - c[0] <= drift:
                given[i + 1] = (c[0], c[1], c[2])
                cs = cs[:-1]
        if g is not None:
            # the run it was given is its onset, one run with the sound its own span opens on
            if cs and vid[cs[0][0]] == vid[g[0]]:
                cs[0] = [g[0], cs[0][1], cs[0][2] + g[2]]
            else:
                cs = [list(g)] + cs
        if cs:
            own = cs if len(cs) == 1 else [max(cs, key=lambda c: (c[2], -c[0]))]
            k0, k1 = own[0][0], own[0][1]
            # voiced frames beside it that no other word's span holds are its own too (drift)
            m = 0
            while k0 - 1 >= 0 and not flat[k0 - 1] and owner[k0 - 1] < 0 and m < drift:
                k0, m = k0 - 1, m + 1
            m = 0
            while k1 < n_fr and not flat[k1] and owner[k1] < 0 and m < drift:
                k1, m = k1 + 1, m + 1
            placed[i] = replace(w, start=round(k0 * FRAME_S, 6), end=round(k1 * FRAME_S, 6))
            kind[i] = "heard"
            continue
        # no voiced frame
        over = [(min(w.end, v1) - max(w.start, v0), v0, v1) for v0, v1 in lay.voiced
                if v0 - _EPS <= w.end and w.start <= v1 + _EPS]
        over = [x for x in over if x[0] > _EPS or (w.end - w.start <= _EPS and x[1] - _EPS <= w.start <= x[2] + _EPS)]
        if over:
            _, v0, v1 = max(over)
            placed[i] = replace(w, start=round(max(w.start, v0), 6), end=round(max(max(w.start, v0), min(w.end, v1)), 6))
            kind[i] = "quiet"
            continue
        mid = round((w.start + w.end) / 2, 6)
        placed[i] = replace(w, start=mid, end=mid)
        kind[i] = "inaudible"
    _misplaced(words, placed, kind, flat)
    # folded words: FOLD_S each against their sound's edge, inside its breath, in order
    i = 0
    while i < n:
        if not isinstance(kind[i], tuple):
            i += 1
            continue
        j = i
        while j < n and kind[j] == kind[i]:
            j += 1
        _, side, t = kind[i]
        each = min(FOLD_S, breath / (j - i + 1))
        for m, k in enumerate(range(i, j)):
            if side == "after":
                s0 = t + m * each
            else:
                s0 = t - (j - i - m) * each
            placed[k] = replace(placed[k], start=round(s0, 6), end=round(s0 + each, 6))
            kind[k] = "folded"
        i = j
    # inaudible words: INAUDIBLE_S each at the far end of the kept piece of sound of the heard word before them (of
    # the heard word after, at the source's start), inside its breath, so the base plays them and the take rules see
    # them: cut removes them and tags them inaudible, a person who keeps them hears that breath, and no piece of
    # sound that no word holds goes with them
    keeps = _keeps(lay, words, placed, kind, breath)
    i = 0
    while i < n:
        if kind[i] != "inaudible":
            i += 1
            continue
        j = i
        while j < n and kind[j] == "inaudible":
            j += 1
        h = max((k for k in range(i) if kind[k] == "heard"), default=None)
        nxt = min((placed[k].start for k in range(j, n) if kind[k] != "inaudible"), default=lay.end)
        t = None
        if h is not None:
            piece = [kp for kp in keeps if kp[1] >= placed[h].end - _EPS and kp[0] <= placed[h].end + _EPS]
            if piece and piece[0][1] <= nxt + _EPS:
                t = piece[0][1] - (j - i) * INAUDIBLE_S
        if t is None:
            after = [kp for kp in keeps if kp[0] >= (placed[h].end if h is not None else 0.0) - _EPS]
            if after:
                t = after[0][0]
        if t is not None:
            for k in range(i, j):
                placed[k] = replace(placed[k], start=round(t, 6), end=round(t + INAUDIBLE_S, 6))
                t += INAUDIBLE_S
        i = j
    # in order: a word never starts before the one before it ends
    for i in range(1, n):
        if placed[i].start < placed[i - 1].end - _EPS:
            st = placed[i - 1].end
            placed[i] = replace(placed[i], start=round(st, 6), end=round(max(st, placed[i].end), 6))
    return placed, kind


def _voiced_run(flat, k, step, n):
    """How many voiced frames in a row from frame k, going `step`."""
    m = 0
    while 0 <= k < n and not flat[k]:
        m, k = m + 1, k + step
    return m


def _bursts(flat, start, end):
    """Separate runs of voiced frames in [start, end) seconds (a flat frame splits two)."""
    a, b = int(round(start / FRAME_S)), int(round(end / FRAME_S))
    out, prev = 0, True
    for k in range(max(0, a), min(len(flat), b)):
        if not flat[k] and prev:
            out += 1
        prev = bool(flat[k])
    return out


def _letters(text):
    return sum(1 for c in text if c.isalnum())


def _misplaced(words, placed, kind, flat=None):
    """The landing bar (2026-10-24): a word whisper put in silence while a neighbour holds its audio is never tagged
    inaudible. Of the words found inaudible (wholly in a silence), a lone one between placed words
    is whisper's timing, and so is a run a heard neighbour holds (its voiced span longer than LETTER_S a letter plus
    WORD_BASE_S for its own text, by MISPLACED_SHARE of the run's letters): those are folded against that neighbour
    and offered, never removed. Text only: the silence is cut either way."""
    n = len(words)
    i = 0
    while i < n:
        if kind[i] != "inaudible":
            i += 1
            continue
        j = i
        while j < n and kind[j] == "inaudible":
            j += 1
        hosts = [k for k in (i - 1, j) if 0 <= k < n]
        need = MISPLACED_SHARE * LETTER_S * sum(_letters(words[k].text) for k in range(i, j))

        def excess(k):
            return (placed[k].end - placed[k].start) - (LETTER_S * _letters(words[k].text) + WORD_BASE_S)
        def holds(k):
            """Long for its own text, or a separate burst of sound for each word of the run (said at a normal
            pace)."""
            return excess(k) >= need - _EPS or (flat is not None
                                                and _bursts(flat, placed[k].start, placed[k].end) - 1 >= j - i)
        held = [k for k in hosts if kind[k] == "heard" and holds(k)]
        host = None
        if held:
            host = max(held, key=lambda k: (excess(k), -k))
        elif j - i == 1 and len(hosts) == 2:
            host = min(hosts, key=lambda k: (words[i].start - placed[k].end) if k < i else (placed[k].start - words[i].end))
        if host is not None:
            if host < i:
                t = placed[host].end
                for k in range(i, j):
                    kind[k] = ("folded", "after", t)
            else:
                t = placed[host].start
                for k in range(i, j):
                    kind[k] = ("folded", "before", t)
        i = j


# ── what speech_text.derive and cut call ────────────────────────────────────────────────────────────────────

_STAMPED = ("FRAME_S", "SPEECH_PERCENTILE", "SILENCE_BELOW_SPEECH_DB", "ATTACHED_BELOW_SPEECH_DB", "BREATH_S",
            "VIDEO_EDGE_S", "SENTENCE_END_S", "ISLAND_S",
            "DRIFT_S", "EDGE_BLEED_FRAMES", "FOLD_S", "INAUDIBLE_S", "LETTER_S", "WORD_BASE_S", "MISPLACED_SHARE", "MIN_KEEP_S", "MIN_CUT_S",
            "MEASURED_SILENCE_S")


class Refiner:
    """What speech_text.derive calls for each source instead of speech_lines.refine: (words, stats, silences).
    Reads each media once per process (layer 1, `layers`); `quiet_words` / `heard` / `inaudible` are the word
    indexes it offers, hears and finds inaudible, per source. max_pause: the shortest silence layer 1 cuts (cut's
    max-pause); breath: what a silence keeps beside the sound, each side. pause_cap: the cap speech_apply gives
    speech_build, none: a pause is cut by layer 1 alone, on the sound, never on whisper's word spans."""

    pause_cap = float("inf")
    stamp = VERSION + " " + " ".join(f"{k}={globals()[k]}" for k in _STAMPED)

    def __init__(self, max_pause=None, breath=BREATH_S):
        self.layers, self.placed, self.kinds, self.raw = {}, {}, {}, {}
        self.quiet_words, self.heard, self.inaudible = {}, {}, {}
        self.whole = set()          # item ids of clips kept whole (cut sets it): tidy leaves their pieces
        self.max_pause = max_pause
        self.breath = breath

    @property
    def env(self):
        return {k: lay.env for k, lay in self.layers.items()}

    def _pause(self):
        return DEFAULT_MAX_PAUSE_S if self.max_pause is None else self.max_pause

    def __call__(self, key, media, raw):
        if key not in self.layers:
            env = envelope(media)
            lay = layer1(media, env, self._pause())
            placed, kind = place(raw, lay, self.breath)
            attached = _attached_frames(raw, placed, kind, lay, self._pause())
            if attached:
                lay = layer1(media, env, self._pause(), attached)
                placed, kind = place(raw, lay, self.breath)
            self.layers[key], self.raw[key] = lay, list(raw)
            self.placed[key], self.kinds[key] = placed, kind
            self.quiet_words[key] = {raw[i].idx for i in range(len(raw)) if kind[i] in ("quiet", "folded")}
            self.heard[key] = {raw[i].idx for i in range(len(raw)) if kind[i] == "heard"}
            self.inaudible[key] = {raw[i].idx for i in range(len(raw)) if kind[i] == "inaudible"}
        lay, placed, kind = self.layers[key], self.placed[key], self.kinds[key]
        stats = {"inaudible": sorted(self.inaudible[key]), "quiet": sorted(self.quiet_words[key]),
                 "folded": [placed[i].idx for i in range(len(placed)) if kind[i] == "folded"],
                 "heard": sorted(self.heard[key]), "inside_words": [], "inside": 0, "attached": 0, "orphan": 0,
                 "untrimmed": list(placed)}
        return list(placed), stats, list(lay.measured)

    def silences(self, key):
        """Layer 1's silences of a source read already: [(start, end)]."""
        return list(self.layers[key].silences) if key in self.layers else []

    def hold(self, key, n):
        """Keep silence n of a source whole (D2: cutting it would move an overlay's start onto another's)."""
        lay = self.layers[key]
        lay.held.add(n)
        lay.keeps = None

    def keeps(self, key):
        """Layer 1's keeps of a source (its voiced runs, their breaths, held silences, islands widened)."""
        lay = self.layers[key]
        if lay.keeps is None:
            keeps = _keeps(lay, self.raw[key], self.placed[key], self.kinds[key], self.breath)
            # sound before the source's first word or after its last belongs to no word: not speech (layer 2)
            ws = list(self.placed[key])          # inaudible words too: they sit inside a piece of sound
            if ws:
                lo, hi = min(w.start for w in ws) - self.breath, max(w.end for w in ws) + self.breath
                keeps = [[round(max(a, lo), 6), round(min(b, hi), 6)] for a, b in keeps if min(b, hi) - max(a, lo) > _EPS]
            lay.keeps = keeps
        return lay.keeps

    def end(self, key) -> float:
        """The measured length of the source, in seconds."""
        lay = self.layers.get(key)
        return lay.end if lay is not None else 0.0

    def tidy(self, runs, derived, report=None):
        """The apply's runs cut to layer 1, with no island and no sliver (see the module function)."""
        return tidy(runs, derived, self, report)


# ── the silence trim and the island rule, on the apply's runs ───────────────────────────────────────────────


def _cut_to(r, keeps, placed_of):
    """Run r cut to the keeps: one run per piece, each with the kept words whose placed middle it holds."""
    out = []
    for k0, k1 in keeps:
        lo, hi = max(r.s_in, k0), min(r.s_out, k1)
        if hi - lo <= _EPS:
            continue
        mine = [i for i in r.words if i in placed_of and lo - _EPS <= (placed_of[i].start + placed_of[i].end) / 2
                <= hi + _EPS]
        p = replace(r, s_in=round(lo, 6), s_out=round(hi, 6), words=mine)
        if abs(lo - r.s_in) > _EPS:
            p.old_in, p.hard_in = None, False
        if abs(hi - r.s_out) > _EPS:
            p.old_out, p.hard_out = None, False
        out.append(p)
    return out


def tidy(runs, derived, refiner, report=None):
    """The speech runs of an apply: every one cut to layer 1's keeps (the silence trim), the video's lead and tail a
    breath of flat, then no island or sliver (see the module docstring). report.flagged gets {"kind": "sliver",
    "letter", "idx", "seconds"} for each dropped piece with no voiced frame that held words, and {"kind": "island",
    "letter", "idx", "seconds"} for each piece left under ISLAND_S. Returns the runs."""
    layers = refiner.layers
    whole = getattr(refiner, "whole", None) or ()
    max_pause = refiner._pause()
    placed_of = {src: {w.idx: w for w in refiner.placed[src]} for src in layers}
    out = []
    for r in runs:
        if r.kind != "speech" or r.src not in layers or r.item_id in whole:
            out.append(r)
            continue
        out += _cut_to(r, refiner.keeps(r.src), placed_of[r.src])

    def mine(r):
        return r.kind == "speech" and r.src in layers and r.item_id not in whole

    def voiced(r):
        lay = layers[r.src]
        a, b = _frames(lay.env, r.s_in, r.s_out)
        return any(not lay.flat[k] for k in range(a, b))

    def kept_span(r):
        ws = [placed_of[r.src][i] for i in r.words if i in placed_of[r.src]]
        return (min(w.start for w in ws), max(w.end for w in ws)) if ws else None

    _video_edges(out, layers, kept_span, mine)
    letter_of = derived.letters

    def word_between(src, a, b, keep):
        return any(i not in keep and min(w.end, b) - max(w.start, a) > _EPS for i, w in placed_of[src].items())

    def longest_flat(src, a, b):
        lay = layers[src]
        f0, f1 = _frames(lay.env, a, b)
        best = cur = 0
        for k in range(f0, f1):
            cur = cur + 1 if lay.flat[k] else 0
            best = max(best, cur)
        return best * FRAME_S

    k = 0
    while k < len(out):
        r = out[k]
        if not mine(r) or r.s_out - r.s_in >= ISLAND_S - _EPS:
            k += 1
            continue
        if not voiced(r):
            # a sliver: no sound, so it goes (its words had none either)
            if report is not None and r.words:
                report.flagged.append({"kind": "sliver", "letter": letter_of.get(r.src), "idx": list(r.words),
                                       "seconds": round(r.s_out - r.s_in, 3)})
            del out[k]
            continue
        joined = False
        for side in (-1, 1):
            j = k + side
            o = out[j] if 0 <= j < len(out) else None
            if o is None or not mine(o) or o.src != r.src:
                continue
            first, last = (o, r) if side < 0 else (r, o)
            if last.s_in < first.s_out - _EPS or word_between(r.src, first.s_out, last.s_in,
                                                             set(first.words) | set(last.words)):
                continue
            if longest_flat(r.src, first.s_in, last.s_out) > max_pause + _EPS:
                continue
            first.s_out, first.old_out, first.hard_out = last.s_out, last.old_out, last.hard_out
            first.words = list(first.words) + list(last.words)
            out.remove(last)
            k = out.index(first)
            joined = True
            break
        if joined:
            continue
        # widened into its own silence: flat frames, never another piece or a word it does not keep
        lay = layers[r.src]
        others = [o for o in out if o is not r and o.kind == "speech" and o.src == r.src]
        lo_lim = max([0.0] + [o.s_out for o in others if o.s_out <= r.s_in + _EPS]
                     + [w.end for i, w in placed_of[r.src].items() if i not in r.words and w.end <= r.s_in + _EPS
                        and w.end - w.start > _EPS])
        hi_lim = min([lay.end] + [o.s_in for o in others if o.s_in >= r.s_out - _EPS]
                     + [w.start for i, w in placed_of[r.src].items() if i not in r.words
                        and w.start >= r.s_out - _EPS and w.end - w.start > _EPS])

        def reach(t, step, limit):
            f = int(round(t / FRAME_S))
            if step < 0:
                while (f - 1) * FRAME_S >= limit - _EPS and f - 1 >= 0 and lay.flat[f - 1]:
                    f -= 1
                return max(limit, f * FRAME_S)
            while (f + 1) * FRAME_S <= limit + _EPS and f < len(lay.flat) and lay.flat[f]:
                f += 1
            return min(limit, f * FRAME_S)
        lo, hi = reach(r.s_in, -1, lo_lim), reach(r.s_out, 1, hi_lim)
        # the video's first piece never widens to more than VIDEO_EDGE_S of flat before its sound, its last after it
        speech_runs = [o for o in out if o.kind == "speech"]
        a0, b0 = _frames(lay.env, r.s_in, r.s_out)
        hits = [f for f in range(a0, b0) if not lay.flat[f]]
        if hits and speech_runs and r is speech_runs[0]:
            lo = max(lo, min(r.s_in, hits[0] * FRAME_S - VIDEO_EDGE_S))
        if hits and speech_runs and r is speech_runs[-1]:
            hi = min(hi, max(r.s_out, (hits[-1] + 1) * FRAME_S + VIDEO_EDGE_S))
        need = ISLAND_S - (r.s_out - r.s_in)
        left = min(need / 2, max(0.0, r.s_in - lo))
        right = min(need - left, max(0.0, hi - r.s_out))
        left = min(need - right, max(0.0, r.s_in - lo))
        if left > _EPS:
            r.s_in, r.old_in, r.hard_in = round(r.s_in - left, 6), None, False
        if right > _EPS:
            r.s_out, r.old_out, r.hard_out = round(r.s_out + right, 6), None, False
        if r.s_out - r.s_in < ISLAND_S - _EPS and report is not None:
            report.flagged.append({"kind": "island", "letter": letter_of.get(r.src), "idx": list(r.words),
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
    return merged


def _video_edges(runs, layers, kept_span, mine):
    """The video opens and ends on sound: its first speech piece starts at most a breath before its first voiced
    frame, its last ends at most a breath after its last, never inside a word it keeps and never under ISLAND_S."""
    speech = [r for r in runs if r.kind == "speech"]
    if not speech:
        return
    for r, side in ((speech[0], -1), (speech[-1], 1)):
        if not mine(r):
            continue
        lay = layers[r.src]
        a, b = _frames(lay.env, r.s_in, r.s_out)
        hits = [k for k in range(a, b) if not lay.flat[k]]
        if not hits:
            continue
        span = kept_span(r)
        if side < 0:
            t = min([hits[0] * FRAME_S] + ([span[0]] if span else []))
            to = min(max(r.s_in, t - BREATH_S), r.s_out - ISLAND_S)
            if to > r.s_in + _EPS:
                r.s_in, r.old_in, r.hard_in = round(to, 6), None, False
        else:
            t = max([(hits[-1] + 1) * FRAME_S] + ([span[1]] if span else []))
            to = max(min(r.s_out, t + BREATH_S), r.s_in + ISLAND_S)
            if to < r.s_out - _EPS:
                r.s_out, r.old_out, r.hard_out = round(to, 6), None, False
