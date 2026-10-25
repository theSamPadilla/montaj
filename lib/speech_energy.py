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
- SOFT words (_attached_frames): a word with no voiced frame keeps ONE BURST of its own sound under the line (the
  run around its loudest frame, a 0.1 s dip ending it, at least BURST_MIN_S, at most its expected length and max-pause
  less two breaths, never into a heard word's sound): ATTACHED (the orchestrator's rule) between kept words, at
  max(speech - 40 dB, room + 10 dB); PROTECTED anywhere when the guard hears it, peaking at GUARD_DB or over (never
  auto-removed, review B L-B3). The room is the 10th-percentile flat frame. Layer 1 is read again
  with the bursts as sound until nothing changes. Never sound with no word attached (a breath between words);
- a word with no voiced frame is OFFERED (stats["quiet"]: cut tags it `inaudible?`) and kept: where its span meets a
  voiced run (a pause inside the keeps), it is placed there;
- whisper's times drift by SECONDS (§577: a clip's first words stamped at 0.00, spans stretched over long pauses, whole
  phrases shifted), but its word order holds: a run of words whose spans lie in a silence is placed IN ORDER
  (`_ordered`) on the voiced audio no word holds between its neighbours' placed sound, else on a letter share of a
  neighbour's sound that holds theirs too (long for its own text, or two or more bursts; never a filler's) or, at the
  source's start, when they are stamped from 0.00 over the room (fillers left out). A run still silent after the
  misplaced fold, with sound no word holds (or a heard word's spare bursts) within CHAIN_S, is folded where it falls
  in order and that sound plays as its heard neighbour's (`_chain`). A word whose whisper span holds a frame at the
  line is never inaudible (`span_voiced`: at most offered);
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
to layer 1's keeps, the video's edges get a breath, islands join or widen, then on the JOINED timeline no flat stretch
(a soft word's burst counted as sound) runs over max-pause across a cut (_cap: the pause rule and the kept words in
it), and no lone piece with no sound or with no word and under ISLAND_S of sound stays (L-B4: sound a kept word's
whisper span holds, at the guard's level, is that word's and stays). Layer 1 drops the same wordless pieces up front
(Refiner.dropped). A clip kept whole (cut's b-roll, Refiner.whole) is left as it is.

cut uses this through `Refiner`, which speech_text.derive calls in place of speech_lines.refine (in the plan and in
its apply alike) and whose `tidy` cleans the apply's runs. speech_edit is unchanged.

The envelope reads the whole source into memory (16 kHz, 2 bytes a sample a channel: about 115 MB an hour of
stereo); streaming it is left for long sources, if one needs it.
"""
import hashlib
import math
import os
import subprocess
import tempfile
import wave
from array import array
from dataclasses import dataclass, field, replace

from lib import voice as _voice
from lib.common import fail, ff_path, ffmpeg_bin, run
from lib.speech_lines import _ends_sentence
from steps.audio import waveform_trim

VERSION = "speech-energy v5c"
FRAME_S = waveform_trim.FRAME_S
RATE = 16000
SPEECH_PERCENTILE = waveform_trim.SPEECH_PERCENTILE
SILENCE_BELOW_SPEECH_DB = 30.0   # a frame this far under the source's speech level is flat (silence)
ATTACHED_BELOW_SPEECH_DB = 40.0  # ... but an attached word's own frames down to this far under it are its sound,
ATTACHED_OVER_ROOM_DB = 10.0     # ... and this far over the room (v5a fix 1)
GUARD_DB = -46.0                 # a word peaking at or over this is never auto-removed (compare's guard, L-B3) ...
PROTECT_OVER_ROOM_DB = 6.0       # a protected word's burst never reaches down to the room plus this
BURST_UNDER_PEAK_DB = 6.0        # a protected word's burst: its frames down to this far under its peak
BURST_GAP_S = 0.1                # a dip under the line this long ends a word's burst (v5a fix 2)
BURST_MIN_S = 0.03               # a burst shorter than this is no word's sound (L-B2)
ISLAND_TARGET_S = 0.36           # what an island widens to: strictly over ISLAND_S, float edges and all (v5a)
ROOM_NEAR_SPEECH_DB = 33.0       # a room this close under the speech is loud: its pauses can't be trimmed (B sf 2)
ROOM_DENSE_PERCENTILE = 1        # the room of a source with no flat frame: its 1st-percentile frame
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
ORDERED_MIN_S = 0.05             # unclaimed voiced audio this long or longer between two placed words may be a silent
                                 # word's sound (§577: whisper drifts by seconds)
CHAIN_S = 3.0                    # ... and sound no word holds this near a run of silent words is theirs, in order
TAIL_FREE_S = 0.12               # at a source's end, free sound must be this long a word to be a silent run's
ZERO_STAMP_S = 0.05              # a source's first words stamped this near 0.00, over the room, are whisper's start
                                 # drift (their sound is the head of the first heard word's)
MIN_KEEP_S = 0.0                 # process_one's min_keep: no keep of sound is ever too short to keep
MEASURED_SILENCE_S = 0.06        # flat runs this long are the "measured silences" speech_build snaps a cut into
ATTACH_ROUNDS = 6                # layer 1 read again with the attached frames until nothing changes
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
    burst_of: dict = field(default_factory=dict)   # attached frame -> the index of the word whose burst it is
    room: float = _SILENT_DB
    raw_flat: bytearray = field(default_factory=bytearray)    # flat.py's flat frames: the attached ones too
    chained: set = field(default_factory=set)   # word positions _chain folded (§577: whisper's drift, never quiet)
    voice: bytearray | None = None    # lib/voice: voiced frames (None: no voice check)
    noise: set = field(default_factory=set)     # frames over the line cut off from any voice (lib/voice): flat


def layer1(media, env, max_pause, attached=frozenset(), spectral=None):
    """Layer 1 of `media` (see the module docstring), from its envelope `env`. attached: frames an attached word's
    own sound holds (_attached_frames): voiced, though under the line. spectral: lib/voice.flags of the media, or None
    (no voice check): a run of sound over the line cut off from any voiced frame is flat (§577 cut voice)."""
    end = len(env) * FRAME_S
    if not env:
        return Layer(env, _SILENT_DB, _SILENT_DB, bytearray(), [], [[0.0, end]], end)
    speech = waveform_trim.speech_level(env)
    # the room: the 10th-percentile frame of the flat ones (under the line), so a soft aside filling a tenth of a
    # dense clip is never read as the room; with none flat, the 1st percentile of all
    quiet = [v for v in env if v < speech - SILENCE_BELOW_SPEECH_DB]
    room = waveform_trim.room_level(quiet) if quiet else waveform_trim.percentile(env, ROOM_DENSE_PERCENTILE)
    if speech <= waveform_trim.DIGITAL_SILENCE_DB:
        # digital silence: every frame is flat (review B should-fix 4)
        ones = bytearray(b"\x01" * len(env))
        return Layer(env, speech, speech, ones, [(0.0, round(end, 6))], [], end, [(0.0, round(end, 6))],
                     room=room, raw_flat=bytearray(ones))
    thr = speech - SILENCE_BELOW_SPEECH_DB
    raw_flat = bytearray(1 if v < thr else 0 for v in env)
    vo = _voice.voiced(spectral, room + PROTECT_OVER_ROOM_DB)        # pitched over the room's own hum (§577)
    noise = _voice.noise_frames(env, thr, vo, attached)
    flat = bytearray(1 if v < thr and k not in attached or k in noise else 0 for k, v in enumerate(env))
    reading = [min(v, thr - 1.0) if k in noise else v if flat[k] else max(v, thr)    # an attached frame reads as sound
               for k, v in enumerate(env)]
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
    return Layer(env, speech, thr, flat, sils, [list(k) for k in voiced], end, measured, attached=set(attached),
                 burst_of=dict(attached) if isinstance(attached, dict) else {},
                 room=room, raw_flat=raw_flat, voice=vo, noise=noise)


def _noise(lay, w):
    """Whether word w's sound is no voice (lib/voice.noise_word): its whisper span holds sound over the room plus
    PROTECT_OVER_ROOM_DB (the lowest a burst reaches) and every run of it is cut off from any voiced frame."""
    if lay.voice is None:
        return False
    a, b = _frames(lay.env, w.start, max(w.end, w.start + FRAME_S))
    return _voice.noise_word(lay.env, lay.voice, lay.room + PROTECT_OVER_ROOM_DB, a, b)


def _protected(lay, peak):
    """A word with no voiced frame is never auto-removed when the guard hears it: its peak at GUARD_DB or over
    (review B L-B3, as FINISH v5 narrowed it: no room-relative clause, so a quiet room's breaths stay silence)."""
    return peak >= GUARD_DB


def _burst_run(lay, k, a, b, line, owner=None, me=None):
    """The run of frames around frame k, within [a, b), at or over `line`: a dip under it of BURST_GAP_S or more
    ends it, and so does a dip that leads into another word's whisper span (owner: the word index each frame's
    middle lies in); (first, end) frames, trimmed to frames over the line."""
    env, gap = lay.env, int(round(BURST_GAP_S / FRAME_S))
    lo = hi = k
    for step in (-1, 1):
        under, f = 0, k + step
        while a <= f < b:
            if env[f] < line:
                under += 1
                if under >= gap:
                    break
            else:
                if under and owner is not None and owner[f] >= 0 and owner[f] != me:
                    break                          # past a dip, into another word's own sound
                under = 0
                lo, hi = min(lo, f), max(hi, f)
            f += step
    return lo, hi + 1


def _attached_frames(words, placed, kind, lay, max_pause, breath=BREATH_S):
    """The frames layer 1 reads as sound for words with no voiced frame of their own: one BURST each, the run of
    frames over its line around its loudest frame (in its own span when it has one there), a dip under the line of
    BURST_GAP_S or more ending it (v5a fix 2, L-B2):
    - ATTACHED (the orchestrator's rule, binding): a word between the source's first and last heard words with a heard
      word on each side, or within max-pause of a heard word's sound, at the line max(speech - ATTACHED_BELOW_SPEECH_DB,
      room + ATTACHED_OVER_ROOM_DB) (v5a fix 1: never at the room);
    - PROTECTED (L-B3, A-B2): any other word the guard hears (_protected: peak at GUARD_DB or over), at
      max(room + PROTECT_OVER_ROOM_DB, min(that line, its peak - BURST_UNDER_PEAK_DB)).
    A burst looks in the word's span and DRIFT_S beside it, never into a heard word's placed sound; two soft words'
    bursts that meet split at the longest dip between them; each is at most LETTER_S a letter plus WORD_BASE_S and
    at most max-pause less two breaths (so a burst never hides an empty stretch), and at least BURST_MIN_S. Never
    sound no word is attached to: a breath between words stays silence."""
    heard = [i for i in range(len(words)) if kind[i] == "heard"]
    env = lay.env
    line0 = max(lay.speech - ATTACHED_BELOW_SPEECH_DB, lay.room + ATTACHED_OVER_ROOM_DB)
    owner = [-1] * len(env)
    for i, w in enumerate(words):
        fa, fb = _frames(env, w.start, w.end)
        for f in range(fa, fb):
            if owner[f] < 0 and w.start - _EPS <= (f + 0.5) * FRAME_S <= w.end + _EPS:
                owner[f] = i
    raw = []                                  # [anchor, lo, hi, line, cap, word]
    for i, w in enumerate(words):
        if kind[i] == "heard":
            continue
        prev = max((h for h in heard if h < i), default=None)
        nxt = min((h for h in heard if h > i), default=None)
        lo_t = max(w.start - DRIFT_S, placed[prev].end) if prev is not None else max(0.0, w.start - DRIFT_S)
        hi_t = min(w.end + DRIFT_S, placed[nxt].start) if nxt is not None else min(lay.end, w.end + DRIFT_S)
        if hi_t <= lo_t:
            continue
        a, b = _frames(env, lo_t, hi_t)
        own = range(*_frames(env, max(lo_t, w.start), min(hi_t, max(w.end, w.start + FRAME_S))))
        cap = max(1, int(min(LETTER_S * _letters(w.text) + WORD_BASE_S, max_pause - 2 * breath) / FRAME_S + 1e-9))
        attached = prev is not None and nxt is not None and (
            (prev == i - 1 and nxt == i + 1)
            or min(w.start - placed[prev].end, placed[nxt].start - w.end) <= max_pause + _EPS)
        lines = [line0] if attached else []
        pk = max(env[a:b], default=_SILENT_DB)
        if _protected(lay, pk):
            lines.append(max(lay.room + PROTECT_OVER_ROOM_DB, min(line0, pk - BURST_UNDER_PEAK_DB)))
        for line in lines:
            cand = [f for f in own if env[f] >= line] or [f for f in range(a, b) if env[f] >= line]
            if not cand:
                continue
            k = max(cand, key=lambda f: (env[f], -f))
            lo, hi = _burst_run(lay, k, a, b, line, owner, i)
            if not _voice.cut_off(lay.voice, lo, hi):     # a burst cut off from any voice is no word's sound (§577)
                raw.append([k, lo, hi, line, cap, i])
            break
    raw.sort()
    for x, y in zip(raw, raw[1:]):            # two bursts that meet split at the longest dip between their anchors
        if y[1] < x[2]:
            dips, f = [], x[0]
            low = min(x[3], y[3])
            while f < y[0]:
                if env[f] < low:
                    g = f
                    while g < y[0] and env[g] < low:
                        g += 1
                    dips.append((g - f, f, g))
                    f = g
                else:
                    f += 1
            if dips:
                _, d0, d1 = max(dips)
                x[2], y[1] = min(x[2], d0), max(y[1], d1)
            else:
                mid = (x[0] + y[0] + 1) // 2
                x[2], y[1] = min(x[2], mid), max(y[1], mid)
    out = {}
    for k, lo, hi, line, cap, i in raw:
        if hi - lo > cap:
            lo = max(lo, min(k - cap // 2, hi - cap))
            hi = lo + cap
        if (hi - lo) * FRAME_S >= BURST_MIN_S - 1e-9:
            out.update((f, i) for f in range(lo, hi) if env[f] < lay.threshold)    # its frames under the line only
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


def _keeps(lay, words, placed, kind, breath, bounds=None):
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
    lo_b, hi_b = (0.0, lay.end) if bounds is None else (max(0.0, bounds[0]), min(lay.end, bounds[1]))
    keeps = [[round(max(a, lo_b), 6), round(min(b, hi_b), 6)] for a, b in keeps if min(b, hi_b) - max(a, lo_b) > _EPS]

    def sound_edge(kp, side):
        fa, fb = _frames(lay.env, kp[0], kp[1])
        hits = [f for f in range(fa, fb) if not lay.flat[f]]
        if not hits:
            return kp[0] if side < 0 else kp[1]
        return hits[0] * FRAME_S if side < 0 else (hits[-1] + 1) * FRAME_S
    # islands: widened into their own silence, leaving MIN_CUT_S of it cut
    for k, kp in enumerate(keeps):
        need = ISLAND_TARGET_S - (kp[1] - kp[0])
        if need <= _EPS:
            continue
        left_room = kp[0] - (keeps[k - 1][1] + MIN_CUT_S if k else lo_b)
        right_room = (keeps[k + 1][0] - MIN_CUT_S if k + 1 < len(keeps) else hi_b) - kp[1]
        if k == 0:              # never more than VIDEO_EDGE_S of flat before a source's first sound
            left_room = min(left_room, kp[0] - (sound_edge(kp, -1) - VIDEO_EDGE_S))
        if k + 1 == len(keeps):
            right_room = min(right_room, sound_edge(kp, 1) + VIDEO_EDGE_S - kp[1])
        left_room, right_room = max(0.0, left_room), max(0.0, right_room)
        at_start = k == 0 and left_room <= need / 2
        at_end = k + 1 == len(keeps) and right_room <= need / 2
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


def place(words, lay, breath=BREATH_S, is_filler=None):
    """(placed words, kind per word: "heard" | "quiet" | "folded" | "inaudible"). See the module docstring.
    is_filler(norm): the language's filler test (cut's), or None."""
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
    prom = lay.attached                    # frames of a soft word's burst: sound, but never a neighbour's onset

    burst_of = lay.burst_of

    def clusters(a, b, me=None):
        out = []
        for k in range(a, b):
            if flat[k] or burst_of.get(k, me) != me:            # never another word's burst
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
        # Up to DRIFT_S of it when the word keeps sound of its own before (after) that flat frame (review A should-fix
        # 3: a filler's span over the next word's onset never takes it)
        def own_sound(lo, hi):
            return any(not flat[f] for f in range(max(a, lo), min(b, hi)))

        def nat_run(k, step):
            """Voiced frames in a row from k, natural ones only (not a soft word's burst)."""
            m2 = 0
            while 0 <= k < n_fr and not flat[k] and k not in prom:
                m2, k = m2 + 1, k + step
            return m2
        m = nat_run(b - 1, -1) if b > a else 0
        if (i + 1 < n and 0 < m and b - m - 1 >= a and (flat[b - m - 1] or b - m - 1 in prom) and b < n_fr
                and (m <= EDGE_BLEED_FRAMES or m <= drift and own_sound(a, b - m - 1))
                and not flat[b] and _voiced_run(flat, b, 1, n_fr) >= m):
            given[i + 1] = (b - m, b, m)
            b -= m
        m = _voiced_run(flat, a, 1, n_fr) if b > a else 0
        if (g is None and i > 0 and kind[i - 1] == "heard" and 0 < m and a + m < b
                and (m <= EDGE_BLEED_FRAMES or m <= drift and own_sound(a + m + 1, b))
                and flat[a + m] and a > 0 and not flat[a - 1] and _voiced_run(flat, a - 1, -1, n_fr) >= m
                and placed[i - 1].end >= (a - 1) * FRAME_S - _EPS):        # the sound the word before is placed on
            placed[i - 1] = replace(placed[i - 1], end=round(max(placed[i - 1].end, (a + m) * FRAME_S), 6))
            a += m
        cs = clusters(a, b, i)
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
        # no voiced frame (of its span, less what it gave its neighbours)
        ws0, we0 = (w.start, w.end) if w.end - w.start <= _EPS else (max(w.start, a * FRAME_S), min(w.end, b * FRAME_S))
        over = [(min(we0, v1) - max(ws0, v0), v0, v1) for v0, v1 in lay.voiced
                if v0 - _EPS <= we0 and ws0 <= v1 + _EPS]
        over = [x for x in over if x[0] > _EPS or (we0 - ws0 <= _EPS and x[1] - _EPS <= ws0 <= x[2] + _EPS)]
        if over and not _noise(lay, w):              # a word on sound of no voice is inaudible: removed (§577)
            _, v0, v1 = max(over)
            placed[i] = replace(w, start=round(max(ws0, v0), 6), end=round(max(max(ws0, v0), min(we0, v1)), 6))
            kind[i] = "quiet"
            continue
        mid = round((w.start + w.end) / 2, 6)
        placed[i] = replace(w, start=mid, end=mid)
        kind[i] = "inaudible"
    fill = (lambda w: bool(w.norm) and bool(is_filler(w.norm))) if is_filler else None
    _ordered(words, placed, kind, lay, fill)
    _misplaced(words, placed, kind, flat, {i for i in range(n) if kind[i] == "inaudible" and _noise(lay, words[i])})
    _chain(words, placed, kind, lay, fill)
    # a word never auto-removed (L-B3, A-B2: its peak at the guard or over the room) is folded against the nearest
    # placed word and offered, like a misplaced one; its burst, if it has one, makes it heard on the next reading
    for i in range(n):
        if kind[i] != "inaudible":
            continue
        a, b = _frames(env, words[i].start, words[i].end)
        # (§577 b) a word whose whisper span holds sound at the line is never auto-removed either
        if not (_protected(lay, max(env[a:b], default=_SILENT_DB)) or span_voiced(lay, words[i])) or \
                _noise(lay, words[i]):          # §577: its sound is cut off from any voice, so the guard never holds it
            continue
        before = next((k for k in range(i - 1, -1, -1) if kind[k] != "inaudible"), None)
        after = next((k for k in range(i + 1, n) if kind[k] != "inaudible"), None)
        cands = [(words[i].start - placed[k].end, k, "after") for k in [before] if k is not None] + \
                [(placed[k].start - words[i].end, k, "before") for k in [after] if k is not None]
        if not cands:
            continue
        _, host, side = min(cands)
        t = placed[host].end if side == "after" else placed[host].start
        if isinstance(kind[host], tuple):
            t = kind[host][2]
            side = kind[host][1]
        kind[i] = ("folded", side, t)
    # a run of silent words holding a folded one folds whole, against one edge, so their order holds (an inaudible
    # word on either side of a kept one could not be placed in order)
    i = 0
    while i < n:
        if not (kind[i] == "inaudible" or isinstance(kind[i], tuple)):
            i += 1
            continue
        j = i
        while j < n and (kind[j] == "inaudible" or isinstance(kind[j], tuple)):
            j += 1
        folds = [kind[k] for k in range(i, j) if isinstance(kind[k], tuple)]
        if folds and len(set(folds)) > 1 or folds and any(kind[k] == "inaudible" for k in range(i, j)):
            anchor = folds[0]
            for k in range(i, j):
                kind[k] = anchor
        i = j
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
        h = max((k for k in range(i) if kind[k] != "inaudible"), default=None)
        nxt = min((placed[k].start for k in range(j, n) if kind[k] != "inaudible"), default=lay.end)
        need = (j - i) * INAUDIBLE_S
        t = None
        if h is not None:
            piece = [kp for kp in keeps if kp[1] >= placed[h].end - _EPS and kp[0] <= placed[h].end + _EPS]
            if piece and piece[0][1] <= nxt + _EPS and piece[0][1] - need >= placed[h].end - _EPS:
                t = piece[0][1] - need
            elif piece and placed[h].end + need <= min(nxt, piece[0][1]) + _EPS:
                t = placed[h].end
        elif keeps and keeps[0][0] + need <= nxt + _EPS:
            t = keeps[0][0]
        # with no room in order inside the kept sound, it stays where whisper put it: in the silence, never played,
        # and the plan lists it tagged inaudible
        if t is not None:
            for k in range(i, j):
                placed[k] = replace(placed[k], start=round(t, 6), end=round(t + INAUDIBLE_S, 6))
                t += INAUDIBLE_S
        i = j
    # in order: a word never starts before the one before it ends; and no word is of no length (§577, ucla B88: a
    # kept word of no length on the instant a removed word starts put the cut on the kept one, which then played on
    # neither side), so a word of no length takes INAUDIBLE_S
    for i in range(n):
        w = placed[i]
        st = max(w.start, placed[i - 1].end) if i else w.start
        en = max(st, w.end)
        if en - st <= _EPS:
            en = st + INAUDIBLE_S
        if abs(st - w.start) > _EPS or abs(en - w.end) > _EPS:
            placed[i] = replace(w, start=round(st, 6), end=round(en, 6))
    return placed, kind


def span_voiced(lay, w):
    """Whether word w's whisper span holds a frame at the line (the speech level less SILENCE_BELOW_SPEECH_DB): such a
    word is never auto-removed, as inaudible, a tail or the video's edge (§577 b); at most it is offered."""
    if not lay.env or lay.speech <= waveform_trim.DIGITAL_SILENCE_DB:
        return False
    a, b = _frames(lay.env, w.start, max(w.end, w.start + FRAME_S))
    return any(lay.env[f] >= lay.threshold and f not in lay.noise for f in range(a, b))


def _excess(words, placed, k):
    """How much longer word k's placed sound is than its own text (LETTER_S a letter plus WORD_BASE_S)."""
    return (placed[k].end - placed[k].start) - (LETTER_S * _letters(words[k].text) + WORD_BASE_S)


def _holds(words, placed, flat, k, i, j):
    """Whether heard word k holds the sound of silent words i..j-1 too (the landing bar's LETTER_S rule): long for its
    own text by MISPLACED_SHARE of their letters' LETTER_S, or a separate burst of sound for each of them."""
    need = MISPLACED_SHARE * LETTER_S * sum(_letters(words[m].text) for m in range(i, j))
    return _excess(words, placed, k) >= need - _EPS or (
        flat is not None and _bursts(flat, placed[k].start, placed[k].end) - 1 >= j - i)


def _voiced_segs(flat, a, b):
    """[(first, end) frames] of the runs of voiced frames in frames [a, b)."""
    out, k = [], a
    while k < b:
        if flat[k]:
            k += 1
            continue
        m = k
        while m < b and not flat[m]:
            m += 1
        out.append((k, m))
        k = m
    return out


def _on_voiced(words, idx, segs, lay, groups=None):
    """[(word, start, end)]: words idx placed in order over the voiced frames of segs, each a share of them by its
    letters (at least one each). The boundaries between `groups` (lengths in order, splitting idx: a run of silent
    words and the heard word whose sound it shares) are snapped first to the nearest edge between two runs of sound,
    then each word's boundary inside its group, where there is one, so a removal takes whole bursts. Each word keeps to
    the one voiced run of layer 1 holding most of its share, so no word's span takes in a silence (whose cut would
    leave its middle in no kept piece)."""
    wts = [max(1, _letters(words[k].text)) for k in idx]
    total, whole = sum(wts), sum(b - a for a, b in segs)
    if whole <= 0:
        return []
    cum = [0.0]
    for wt in wts:
        cum.append(cum[-1] + wt * whole / total)
    edges, at = [], 0
    for a, b in segs[:-1]:
        at += b - a
        edges.append(float(at))
    bounds = list(cum)
    used = set()

    def snap(k, lo, hi):
        """Boundary k to the nearest free edge strictly inside (lo, hi)."""
        cands = [e for e in edges if lo + _EPS < e < hi - _EPS and e not in used]
        if cands:
            e = min(cands, key=lambda e: (abs(e - cum[k]), e))
            bounds[k] = e
            used.add(e)
    gb = []
    if groups:
        acc = 0
        for g in groups[:-1]:
            acc += g
            gb.append(acc)
    lo = 0.0
    for n, k in enumerate(gb):
        snap(k, lo, cum[gb[n + 1]] if n + 1 < len(gb) else whole)
        lo = bounds[k]
    marks = [0] + gb + [len(idx)]
    for g0, g1 in zip(marks, marks[1:]):
        lo = bounds[g0]
        for k in range(g0 + 1, g1):
            snap(k, lo, bounds[g1])
            lo = bounds[k]
    # in order, and every word a frame at least where there are frames enough (a word of no length on a cut's edge
    # would play on whichever side holds it)
    m = min(1.0, whole / len(idx))
    for k in range(1, len(idx)):
        bounds[k] = max(bounds[k], bounds[k - 1] + m)
    bounds[len(idx)] = whole
    for k in range(len(idx) - 1, 0, -1):
        bounds[k] = min(bounds[k], bounds[k + 1] - m)
    # the voiced run (layer 1) of each frame of segs, by voiced offset
    run_of = []
    for a, b in segs:
        r = next((n for n, (v0, v1) in enumerate(lay.voiced) if v0 - _EPS <= a * FRAME_S < v1 + _EPS), -1 - a)
        run_of.append(r)
    out = []
    for n, k in enumerate(idx):
        v0, v1 = bounds[n], bounds[n + 1]
        if v1 - v0 <= _EPS:
            t = _at(segs, v0, 1)
            out.append((k, t, t))
            continue
        share, at = {}, 0.0
        for (a, b), r in zip(segs, run_of):
            lo2, hi2 = max(v0, at), min(v1, at + (b - a))
            if hi2 - lo2 > _EPS:
                x = share.setdefault(r, [0.0, None, None])
                x[0] += hi2 - lo2
                x[1] = a + (lo2 - at) if x[1] is None else x[1]
                x[2] = a + (hi2 - at)
            at += b - a
        best = max(share.values(), key=lambda x: x[0])
        out.append((k, round(best[1] * FRAME_S, 6), round(best[2] * FRAME_S, 6)))
    return out


def _free_sound(words, placed, kind, lay, min_fr, lo=0, hi=None):
    """[(first, end) frames] of voiced audio no placed word holds (no heard, quiet or folded word's span, no burst; of
    a heard word on two or more separate bursts, all but its longest), min_fr frames or more each, in frames
    [lo, hi) (the whole source by default)."""
    env, flat, n_fr = lay.env, lay.flat, len(lay.env)
    hi = n_fr if hi is None else min(n_fr, hi)
    lo = max(0, lo)
    held = bytearray(n_fr)
    t_lo, t_hi = (lo - 1) * FRAME_S, (hi + 1) * FRAME_S
    for k in range(len(words)):
        w = placed[k]
        if w.end < t_lo or w.start > t_hi or w.end - w.start <= _EPS or kind[k] == "inaudible" \
                or isinstance(kind[k], tuple):
            continue
        a, b = _frames(env, w.start, w.end)
        if b <= lo or a >= hi:
            continue
        held[a:b] = b"\x01" * (b - a)
        if kind[k] == "heard":
            # a heard word on two or more separate bursts holds one: the others are spare (whisper's drift put the
            # words they belong to elsewhere)
            bs = _voiced_segs(flat, a, b)
            if len(bs) >= 2:
                keep = max(bs, key=lambda x: (x[1] - x[0], -x[0]))
                for x0, x1 in bs:
                    if (x0, x1) != keep:
                        held[x0:x1] = b"\x00" * (x1 - x0)
    for f in lay.burst_of:
        if lo <= f < hi:
            held[f] = 1
    out = []
    for a0, b0 in _voiced_segs(flat, lo, hi):
        for a1, b1 in _voiced_segs(held, a0, b0):
            if b1 - a1 >= min_fr:
                out.append((a1, b1))
    return out


def _ordered(words, placed, kind, lay, fill=None):
    """§577: whisper's word times drift by seconds (a clip's first words stamped at 0.00 while its speech starts later,
    spans stretched over long pauses, whole phrases shifted), but its word ORDER holds. So a run of words found
    inaudible (no voiced frame in its span) is placed in order on the sound between its neighbours:
    (a) the unclaimed voiced audio between the placed sound of the word before it and of the word after (the source's
        start or end when there is none), ORDERED_MIN_S or more of it, shared by letters in order over its voiced
        frames: heard. At the source's end, only with TAIL_FREE_S of it a word (a click is no made-up tail's sound);
    (A) with none there, a share by letters of the head of the next heard word's placed sound (or the tail of the one
        before): when that word holds their sound too (_holds, the LETTER_S rule, or two or more separate bursts of
        sound, one of them its own), or at the source's START when the run is stamped from 0.00 (ZERO_STAMP_S,
        whisper's start drift) and its spans hold only the room (under room + ATTACHED_OVER_ROOM_DB), its fillers
        left out (a removed filler never takes the first word's head): heard. Never at the source's end: words over
        the room there are whisper's made-up tail (review A should-fix 5). The boundary between the run and its host
        lies at an edge between two bursts where there is one;
    otherwise they are left inaudible, for the misplaced fold (decision Q4) and the inaudible rule."""
    env, flat, n_fr = lay.env, lay.flat, len(lay.env)
    n = len(words)
    if not n_fr:
        return
    fill = fill or (lambda w: False)
    min_fr = max(1, int(round(ORDERED_MIN_S / FRAME_S)))
    orig = list(placed)                  # whether a host holds a run reads its own placement, before any share
    i = 0
    while i < n:
        if kind[i] != "inaudible":
            i += 1
            continue
        j = i
        while j < n and kind[j] == "inaudible":
            j += 1
        run = list(range(i, j))
        prev = i - 1 if i > 0 else None
        nxt = j if j < n else None
        lo = placed[prev].end if prev is not None else 0.0
        hi = placed[nxt].start if nxt is not None else lay.end
        # (a) unclaimed voiced audio between them: runs of voiced frames, none another word's burst
        f0 = max(0, int(math.ceil(lo / FRAME_S - 1e-9)))
        f1 = min(n_fr, int(math.floor(hi / FRAME_S + 1e-9)))
        segs, k = [], f0
        while k < f1:
            if flat[k] or lay.burst_of.get(k, i) not in run:
                k += 1
                continue
            m = k
            while m < f1 and not flat[m] and lay.burst_of.get(m, i) in run:
                m += 1
            if m - k >= min_fr:
                segs.append((k, m))
            k = m
        if segs and (nxt is not None or sum(b - a for a, b in segs) * FRAME_S >= TAIL_FREE_S * len(run) - _EPS):
            for m, a, b in _on_voiced(words, run, segs, lay, [1] * len(run)):
                placed[m] = replace(words[m], start=a, end=b)
                kind[m] = "heard"
            i = j
            continue
        # (A) a share of a neighbour that holds their sound, or at the source's start
        hosts = [h for h in (nxt, prev) if h is not None and kind[h] == "heard" and not fill(words[h])
                 and placed[h].end - placed[h].start >= FRAME_S * (len(run) + 1) - _EPS]   # never a filler's sound
        # it holds their sound: long for its own text, or on two or more separate bursts (§577: one is its own)
        held = [h for h in hosts if _holds(words, orig, flat, h, i, j)
                or _bursts(flat, orig[h].start, orig[h].end) >= 2]
        host = max(held, key=lambda h: (_excess(words, orig, h), h == nxt)) if held else None
        if host is None and prev is None and hosts and words[i].start <= ZERO_STAMP_S + _EPS:
            fa = min(_frames(env, words[m].start, max(words[m].end, words[m].start + FRAME_S))[0] for m in run)
            fb = max(_frames(env, words[m].start, max(words[m].end, words[m].start + FRAME_S))[1] for m in run)
            if max(env[fa:fb], default=_SILENT_DB) < lay.room + ATTACHED_OVER_ROOM_DB:
                host = nxt
                run = [m for m in run if not fill(words[m])]      # review blocker 2: a filler stays inaudible
        if host is not None and run:
            hs = _voiced_segs(flat, *_frames(env, placed[host].start, placed[host].end))
            if hs:
                order = run + [host] if host == nxt else [host] + run
                groups = [len(run), 1] if host == nxt else [1, len(run)]
                for m, a, b in _on_voiced(words, order, hs, lay, groups):
                    placed[m] = replace(words[m] if m != host else placed[m], start=a, end=b)
                    kind[m] = "heard"
        i = j


def _chain(words, placed, kind, lay, fill=None):
    """§577: a run of silent words still inaudible after _ordered and the misplaced fold, with voiced audio no word
    holds (ORDERED_MIN_S or more; a heard word's spare bursts count) within CHAIN_S of its span: whisper's drift moved
    the words between them. The run is FOLDED (2026-10-25 decision): kept in the text, offered inaudible?, folded as
    the misplaced fold folds (FOLD_S a word inside the breath where it falls in order: after the heard words between
    that sound and the run, or before them), so removing it cuts no voiced audio. The free sound goes to the heard
    word beside it on the same voiced run, so it plays; no heard word leaves its own sound, and none takes sound across
    a silence. Never when a filler is among those words (its sound would play as a kept word's), nor at the source's
    end with under TAIL_FREE_S of free sound a word (a made-up tail over a click)."""
    env, flat, n_fr = lay.env, lay.flat, len(lay.env)
    n = len(words)
    if not n_fr:
        return
    fill = fill or (lambda w: False)
    min_fr = max(1, int(round(ORDERED_MIN_S / FRAME_S)))
    free = None
    i = 0
    while i < n:
        if kind[i] != "inaudible":
            i += 1
            continue
        j = i
        while j < n and kind[j] == "inaudible":
            j += 1
        if free is None:
            free = _free_sound(words, placed, kind, lay, min_fr)
        t0, t1 = words[i].start, words[j - 1].end
        near = [(max(0.0, a * FRAME_S - t1, t0 - b * FRAME_S), a, b) for a, b in free]
        near = [x for x in near if x[0] <= CHAIN_S + _EPS]
        if not near:
            i = j
            continue
        _, ua, ub = min(near)
        live = [k for k in range(n) if kind[k] == "heard"]
        if ub * FRAME_S <= t0 + _EPS or (ua * FRAME_S < t1 and (ua + ub) / 2 * FRAME_S < (t0 + t1) / 2):
            # the sound lies before the run: from the heard word placed before it, through the run, to its neighbour
            before = [k for k in live if k < i and placed[k].end <= ua * FRAME_S + _EPS]
            fa = max(0, int(math.ceil(placed[before[-1]].end / FRAME_S - 1e-9))) if before else 0
            hs = [k for k in live if k < i and placed[k].start >= fa * FRAME_S - _EPS]
            end = placed[j].start if j < n else lay.end
            fb = min(n_fr, int(math.floor(end / FRAME_S + 1e-9)))
            after_run = True
        else:
            after = [k for k in live if k >= j and placed[k].start >= ub * FRAME_S - _EPS]
            fb = min(n_fr, int(math.floor(placed[after[0]].start / FRAME_S + 1e-9))) if after else n_fr
            hs = [k for k in live if k >= j and placed[k].end <= fb * FRAME_S + _EPS]
            start = placed[i - 1].end if i > 0 else 0.0
            fa = max(0, int(math.ceil(start / FRAME_S - 1e-9)))
            after_run = False
        span = range(min(hs + [i]), max(hs + [j - 1]) + 1)
        if (any(fill(words[k]) for k in hs) or any(fill(words[k]) for k in range(i, j))
                or any(isinstance(kind[k], tuple) or kind[k] not in ("heard", "inaudible") for k in span)
                or any(kind[k] == "inaudible" and not i <= k < j for k in span)):
            i = j
            continue
        mine = [(x0, x1) for x0, x1 in free if x1 > fa and x0 < fb]
        if not mine:
            i = j
            continue
        if j == n and sum(min(x1, fb) - max(x0, fa) for x0, x1 in mine) * FRAME_S < TAIL_FREE_S * (j - i) - _EPS:
            i = j          # a made-up tail over a click after the last word: never chained (review blocker 4)
            continue
        # the free sound goes to the heard word beside it on the same voiced run (it plays as that word's), never
        # across a silence; no heard word leaves its own sound
        for x0, x1 in mine:
            x0, x1 = max(x0, fa), min(x1, fb)
            bef = max((k for k in hs if placed[k].end <= x0 * FRAME_S + _EPS), default=None)
            aft = min((k for k in hs if placed[k].start >= x1 * FRAME_S - _EPS), default=None)
            if bef is not None and _vid(lay, placed[bef].end - FRAME_S / 2) == _vid(lay, x0 * FRAME_S):
                placed[bef] = replace(placed[bef], end=round(max(placed[bef].end, x1 * FRAME_S), 6))
            elif aft is not None and _vid(lay, placed[aft].start + FRAME_S / 2) == _vid(lay, (x1 - 1) * FRAME_S):
                placed[aft] = replace(placed[aft], start=round(min(placed[aft].start, x0 * FRAME_S), 6))
        if hs:
            t = placed[hs[-1]].end if after_run else placed[hs[0]].start
        else:                                # the free sound right beside the run: the run sits on its near edge
            t = mine[-1][1] * FRAME_S if after_run else mine[0][0] * FRAME_S
        for m in range(i, j):
            # folded as the misplaced fold folds (FOLD_S each against that sound's edge, inside its breath)
            kind[m] = ("folded", "after" if after_run else "before", round(t, 6))
            lay.chained.add(m)
        # read the free sound again where this chain placed words (a voiced run each side, so a cut segment is whole)
        r0, r1 = fa, fb
        while r0 > 0 and not flat[r0 - 1]:
            r0 -= 1
        while r1 < n_fr and not flat[r1]:
            r1 += 1
        free = [x for x in free if x[1] <= r0 or x[0] >= r1] + _free_sound(words, placed, kind, lay, min_fr, r0, r1)
        free.sort()
        i = j


def _vid(lay, t):
    """The index of layer 1's voiced run holding time t, or None."""
    return next((n for n, (a, b) in enumerate(lay.voiced) if a - _EPS <= t <= b + _EPS), None)


def _at(segs, v, side):
    """The time at voiced offset v (in frames) along segs [(first, end) frames]: side 1 for a start, -1 for an end."""
    for a, b in segs:
        if v < (b - a) - _EPS or (side < 0 and v <= (b - a) + _EPS):
            return round((a + max(0.0, v)) * FRAME_S, 6)
        v -= b - a
    return round(segs[-1][1] * FRAME_S, 6)


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


def _misplaced(words, placed, kind, flat=None, noise=()):
    """The landing bar (2026-10-24): a word whisper put in silence while a neighbour holds its audio is never tagged
    inaudible. Of the words found inaudible (wholly in a silence), a lone one between placed words
    is whisper's timing, and so is a run a heard neighbour holds (its voiced span longer than LETTER_S a letter plus
    WORD_BASE_S for its own text, by MISPLACED_SHARE of the run's letters): those are folded against that neighbour
    and offered, never removed. Text only: the silence is cut either way. A lone word on sound of no voice (`noise`,
    lib/voice: §577) is not whisper's timing: it stays inaudible, and is removed."""
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
        elif j - i == 1 and len(hosts) == 2 and i not in noise:
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

_STAMPED = ("FRAME_S", "RATE", "_SILENT_DB", "SPEECH_PERCENTILE", "SILENCE_BELOW_SPEECH_DB",
            "ATTACHED_BELOW_SPEECH_DB", "ATTACHED_OVER_ROOM_DB", "GUARD_DB", "PROTECT_OVER_ROOM_DB",
            "BURST_UNDER_PEAK_DB", "BURST_GAP_S", "BURST_MIN_S", "ISLAND_TARGET_S", "ROOM_DENSE_PERCENTILE", "BREATH_S",
            "VIDEO_EDGE_S", "SENTENCE_END_S", "ISLAND_S",
            "DRIFT_S", "EDGE_BLEED_FRAMES", "FOLD_S", "INAUDIBLE_S", "LETTER_S", "WORD_BASE_S", "MISPLACED_SHARE", "ORDERED_MIN_S", "CHAIN_S", "TAIL_FREE_S", "ZERO_STAMP_S", "MIN_KEEP_S", "MIN_CUT_S",
            "MEASURED_SILENCE_S")


class _RefinerStamp:
    """Refiner.stamp: on the class, the reading's constants; on a refiner, those, and when it transcribes broken
    stretches again (§577) lib/speech_repair's stamp and a digest of every source's repaired words (text, start, end)
    and failed windows, so a plan and an apply that read different words (a cache gone, a second run that failed once
    and not the other time) never match: stale_plan (review B3)."""

    def __get__(self, obj, cls):
        if obj is None or obj.retranscribe is None:
            return cls.STAMP
        from lib import speech_repair
        h = hashlib.sha256()
        for key in sorted(obj.repaired):
            rep = obj.repaired[key]
            if not rep:
                continue
            h.update(repr(key).encode())
            h.update(repr([(r["window"], r.get("error"), r.get("extension")) for r in rep]).encode())
            h.update(repr([(w.text, w.start, w.end) for w in obj.raw.get(key, ())]).encode())
        return f"{cls.STAMP} {speech_repair.STAMP} repaired={h.hexdigest()[:12]}"


class Refiner:
    """What speech_text.derive calls for each source instead of speech_lines.refine: (words, stats, silences).
    Reads each media once per process (layer 1, `layers`); `quiet_words` / `heard` / `inaudible` are the word
    indexes it offers, hears and finds inaudible, per source. max_pause: the shortest silence layer 1 cuts (cut's
    max-pause); breath: what a silence keeps beside the sound, each side. pause_cap: the cap speech_apply gives
    speech_build, none: a pause is cut by layer 1 alone, on the sound, never on whisper's word spans."""

    pause_cap = float("inf")
    STAMP = VERSION + " " + " ".join(f"{k}={globals()[k]}" for k in _STAMPED) + " " + _voice.STAMP
    stamp = _RefinerStamp()

    def __init__(self, max_pause=None, breath=BREATH_S, is_filler=None, retranscribe=None, retranscribe_tag=""):
        self.layers, self.placed, self.kinds, self.raw = {}, {}, {}, {}
        self.quiet_words, self.heard, self.inaudible, self.soft, self.soundless = {}, {}, {}, {}, {}
        self.folded, self.loud = {}, {}     # per source: folded word indexes; words whose whisper span holds sound
        self.chained = {}                   # per source: word indexes _chain folded
        self.noise = {}                     # per source: inaudible word indexes whose sound is no voice (§577): `noise`
        self.whole = set()          # item ids of clips kept whole (cut sets it): tidy leaves their pieces
        self.dropped = {}           # source -> [(start, end)] pieces of sound with no word layer 1 dropped (L-B4)
        self.max_pause = max_pause
        self.breath = breath
        self.is_filler = is_filler  # the language's filler test (norm -> bool): §577's ordered placement skips fillers
        # §577 (ucla B): retranscribe(media, start, end) -> [(text, start, end)] on the source's clock, or None: whisper
        # again over each voiced run of a broken stretch (lib/speech_repair); None leaves every transcript as it is
        self.retranscribe, self.retranscribe_tag = retranscribe, retranscribe_tag
        self.repaired = {}          # source -> lib/speech_repair's report of the stretches it replaced

    @property
    def env(self):
        return {k: lay.env for k, lay in self.layers.items()}

    def _pause(self):
        return DEFAULT_MAX_PAUSE_S if self.max_pause is None else self.max_pause

    def __call__(self, key, media, raw):
        if key not in self.layers:
            env = envelope(media)
            spectral = _voice.flags(media, len(env))        # §577 cut voice: which frames sound like a voice
            lay = layer1(media, env, self._pause(), spectral=spectral)
            if self.retranscribe is not None:
                from lib import speech_repair
                raw, self.repaired[key] = speech_repair.repair(raw, lay, media, self.retranscribe,
                                                               self.retranscribe_tag)
            placed, kind = place(raw, lay, self.breath, self.is_filler)
            attached = {}
            for _ in range(ATTACH_ROUNDS):       # until nothing changes (A-B2): a word attached makes its neighbour's
                more = {**_attached_frames(raw, placed, kind, lay, self._pause(), self.breath), **attached}
                if more == attached:
                    break
                attached = more
                lay = layer1(media, env, self._pause(), attached, spectral)
                placed, kind = place(raw, lay, self.breath, self.is_filler)
            self.layers[key], self.raw[key] = lay, list(raw)
            self.placed[key], self.kinds[key] = placed, kind
            self.quiet_words[key] = {raw[i].idx for i in range(len(raw)) if kind[i] in ("quiet", "folded")}
            self.heard[key] = {raw[i].idx for i in range(len(raw)) if kind[i] == "heard"}
            self.inaudible[key] = {raw[i].idx for i in range(len(raw)) if kind[i] == "inaudible"}
            self.soundless[key] = {raw[i].idx for i in range(len(raw)) if kind[i] in ("quiet", "folded")}
            self.folded[key] = {raw[i].idx for i in range(len(raw)) if kind[i] == "folded"}
            # folded by _chain: whisper's drift, not a quiet word (a take is never faint for them)
            self.chained[key] = {raw[i].idx for i in lay.chained if i < len(raw) and kind[i] == "folded"}
            self.noise[key] = {raw[i].idx for i in range(len(raw)) if kind[i] == "inaudible" and _noise(lay, raw[i])}
            # §577 (b): never auto-removed (inaudible, tail or the video's edge), at most offered
            self.loud[key] = {w.idx for w in raw if span_voiced(lay, w)}
            # soft: a word whose sound is all under the line (an attached or protected burst, or none): {idx: peak}
            self.soft[key] = {}
            for i, w in enumerate(raw):
                if kind[i] == "inaudible":
                    continue
                span = placed[i]
                fa, fb = _frames(lay.env, span.start, span.end)
                pk = max(lay.env[fa:fb], default=_SILENT_DB)
                if kind[i] != "heard" or pk < lay.threshold:
                    self.soft[key][w.idx] = pk
        lay, placed, kind = self.layers[key], self.placed[key], self.kinds[key]
        stats = {"inaudible": sorted(self.inaudible[key]), "quiet": sorted(self.quiet_words[key]),
                 "folded": [placed[i].idx for i in range(len(placed)) if kind[i] == "folded"],
                 "heard": sorted(self.heard[key]), "inside_words": [], "inside": 0, "attached": 0, "orphan": 0,
                 "untrimmed": list(placed), "line_breaks": self._line_breaks(key)}
        return list(placed), stats, list(lay.measured)

    def _line_breaks(self, key):
        """Word indexes that open a new line: the first word after a cut silence (layer 1's keeps), so each piece of
        a line cut at a silence has an id of its own (review A-B1)."""
        keeps = self.keeps(key)
        out, prev, since = set(), None, 0
        kinds, placed = self.kinds[key], self.placed[key]
        for n, w in enumerate(placed):
            m = (w.start + w.end) / 2
            piece = next((n for n, (a, b) in enumerate(keeps) if a - _EPS <= m <= b + _EPS), -1 - w.idx)
            if prev is not None and piece != prev:
                out.add(w.idx)
                since = n
            # §577 (the kungfu refusal): a run of inaudible words (whisper put them in a silence; they are parked in
            # the breath of the sound before them) that repeats two words in a row said earlier in its line (one, for
            # a run of one) opens a line of its own: the apply aligns a row to the LAST match in its line, so a kept "or get" of one saying would play
            # another saying's parked "or get"
            if n and kinds[n] == "inaudible" and kinds[n - 1] != "inaudible":
                j = n
                while j < len(placed) and kinds[j] == "inaudible":
                    j += 1
                g = min(2, j - n)            # two words in a row (one, for a run of one) said earlier in the line
                before = [x.norm for x in placed[since:n]]
                said = {tuple(before[q:q + g]) for q in range(len(before) - g + 1)}
                run = [x.norm for x in placed[n:j]]
                if any(all(run[q:q + g]) and tuple(run[q:q + g]) in said for q in range(len(run) - g + 1)):
                    out.add(w.idx)
                    since = n
            prev = piece
        return out

    def loud_room(self):
        """[(source, speech, room)] of the sources whose room is within ROOM_NEAR_SPEECH_DB of their speech: their
        pauses can't be trimmed (review B should-fix 2)."""
        return [(k, lay.speech, lay.room) for k, lay in self.layers.items()
                if lay.speech > waveform_trim.DIGITAL_SILENCE_DB and lay.speech - lay.room < ROOM_NEAR_SPEECH_DB]

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
            # sound before the source's first word or after its last belongs to no word: not speech (layer 2)
            ws = list(self.placed[key])          # inaudible words too: they sit inside a piece of sound
            bounds = None
            if ws:
                lo, hi = min(w.start for w in ws) - self.breath, max(w.end for w in ws) + self.breath
                # ... and sound inside the first word's whisper span before its placement (or the last's after) is
                # that word's, drifted
                first = min(range(len(ws)), key=lambda k: ws[k].start)
                last = max(range(len(ws)), key=lambda k: ws[k].end)
                lo = min(lo, self.raw[key][first].start - self.breath)
                hi = max(hi, self.raw[key][last].end + self.breath) if _letters(self.raw[key][last].text) else hi
                bounds = (lo, hi)
            keeps = _keeps(lay, self.raw[key], self.placed[key], self.kinds[key], self.breath, bounds)
            # a piece of sound with no word, standing alone, under ISLAND_S of sound (a lip smack in a pause) goes,
            # and the answer names it (L-B4); one touching a word's sound is part of that word's piece
            self.dropped[key] = []
            kept = []
            spans = [(w.start, w.end) for w, k in zip(self.raw[key], self.kinds[key]) if k != "inaudible"]
            for a, b in keeps:
                if any(a - _EPS <= (w.start + w.end) / 2 <= b + _EPS for w in ws):
                    kept.append([a, b])
                    continue
                fa, fb = _frames(lay.env, a, b)
                snd = [f for f in range(fa, fb) if not lay.flat[f]]
                # loud sound (the guard hears it) inside a word's whisper span may be that word's (drift): it stays
                if len(snd) * FRAME_S >= ISLAND_S - _EPS or any(
                        lay.env[f] >= GUARD_DB and s0 - _EPS <= (f + 0.5) * FRAME_S <= s1 + _EPS
                        for f in snd for s0, s1 in spans):
                    kept.append([a, b])
                    continue
                self.dropped[key].append((a, b))
            lay.keeps = kept
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
    """The speech runs of an apply (see the module docstring): every one cut to layer 1's keeps (the silence trim),
    the video's lead and tail a breath of flat, short pieces joined or widened (islands), then on the JOINED timeline
    no flat run (flat.py's, a soft word's burst counted as its sound: L-B2) over max-pause, across every joint (L-B1),
    and no lone piece with no sound (a sliver) or with no word and under ISLAND_S of sound (L-B4). report.flagged
    gets {"kind": "sliver" | "wordless" | "island", "letter", "idx", "seconds"}. Returns the runs."""
    layers = refiner.layers
    whole = getattr(refiner, "whole", None) or ()
    max_pause = refiner._pause()
    breath = getattr(refiner, "breath", BREATH_S)
    placed_of = {src: {w.idx: w for w in refiner.placed[src]} for src in layers}
    letter_of = derived.letters
    out = []
    for r in runs:
        if r.kind != "speech" or r.src not in layers or r.item_id in whole:
            out.append(r)
            continue
        out += _cut_to(r, refiner.keeps(r.src), placed_of[r.src])

    def mine(r):
        return r.kind == "speech" and r.src in layers and r.item_id not in whole

    def sound(r):
        lay = layers[r.src]
        a, b = _frames(lay.env, r.s_in, r.s_out)
        return sum(1 for k in range(a, b) if not lay.flat[k]) * FRAME_S

    def kept_span(r):
        ws = [placed_of[r.src][i] for i in r.words if i in placed_of[r.src]]
        return (min(w.start for w in ws), max(w.end for w in ws)) if ws else None

    kept_words = {}
    for r in out:
        if mine(r):
            kept_words.setdefault(r.src, set()).update(r.words)
    spans_of = {src: [(w.start, w.end) for w in refiner.raw[src] if w.idx in kept_words.get(src, ())]
                for src in layers}

    def in_kept_span(r):
        """Its sound lies in a kept word's whisper span (that word's, drifted): never a lone smack."""
        lay = layers[r.src]
        a, b = _frames(lay.env, r.s_in, r.s_out)
        return any(s0 - _EPS <= (f + 0.5) * FRAME_S <= s1 + _EPS for f in range(a, b)
                   if not lay.flat[f] and lay.env[f] >= GUARD_DB for s0, s1 in spans_of.get(r.src, ()))

    _video_edges(out, layers, kept_span, mine, breath)
    j = _Joined(out, layers, mine, max_pause)
    _islands(out, j, layers, placed_of, mine, max_pause)
    for _ in range(4):
        changed = _cap(out, j, layers, placed_of, derived, mine, max_pause, breath)
        k = 0
        while k < len(out):
            r = out[k]
            touching = any(0 <= n < len(out) and mine(out[n]) and out[n].src == r.src and out[n].words
                           and min(abs(out[n].s_out - r.s_in), abs(r.s_out - out[n].s_in)) <= 0.001
                           for n in (k - 1, k + 1))
            wordless = mine(r) and not r.words and sound(r) < ISLAND_S - _EPS and not touching \
                and not in_kept_span(r)
            sliver = mine(r) and r.words and sound(r) <= _EPS and r.s_out - r.s_in < ISLAND_S - _EPS
            if wordless or sliver:
                kind = "sliver" if sliver else "wordless"
                if report is not None and (r.words or kind == "wordless"):
                    report.flagged.append({"kind": kind, "letter": letter_of.get(r.src), "idx": list(r.words),
                                           "seconds": round(r.s_out - r.s_in, 3), "at": round(r.s_in, 2)})
                del out[k]
                changed = True
                continue
            k += 1
        if not changed:
            break
    _video_edges(out, layers, kept_span, mine, breath, strict=True)
    if report is not None:
        for r in out:
            if mine(r) and r.s_out - r.s_in < ISLAND_S - _EPS:
                report.flagged.append({"kind": "island", "letter": letter_of.get(r.src), "idx": list(r.words),
                                       "seconds": round(r.s_out - r.s_in, 3)})
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


class _Joined:
    """The joined timeline's flat at the runs' edges (flat.py's, a soft word's burst counted as its sound)."""

    def __init__(self, out, layers, mine, max_pause):
        self.out, self.layers, self.mine, self.max_pause = out, layers, mine, max_pause

    def lead(self, r):
        lay = self.layers[r.src]
        a, b = _frames(lay.env, r.s_in, r.s_out)
        k = a
        while k < b and lay.flat[k]:
            k += 1
        return min(r.s_out - r.s_in, (k - a) * FRAME_S)

    def trail(self, r):
        lay = self.layers[r.src]
        a, b = _frames(lay.env, r.s_in, r.s_out)
        k = b
        while k > a and lay.flat[k - 1]:
            k -= 1
        return min(r.s_out - r.s_in, (b - k) * FRAME_S)

    def all_flat(self, r):
        return self.lead(r) >= r.s_out - r.s_in - _EPS

    def stretch(self, i):
        """(first index, last index, length) of the flat stretch across the joint after run i (runs i and i + 1),
        going on through runs that are all flat; None when either side is not the joined speech."""
        out = self.out
        if not (0 <= i < len(out) - 1 and self.mine(out[i]) and self.mine(out[i + 1])):
            return None
        a, length = i, self.trail(out[i])
        while self.all_flat(out[a]) and a - 1 >= 0 and self.mine(out[a - 1]):
            a -= 1
            length += self.trail(out[a])
        b = i + 1
        length += self.lead(out[b])
        while self.all_flat(out[b]) and b + 1 < len(out) and self.mine(out[b + 1]):
            b += 1
            length += self.lead(out[b])
        return a, b, length

    def room(self, r, side):
        """How much more flat run r's edge (side -1: its start, 1: its end) may take before the joined stretch there
        goes over max-pause."""
        k = self.out.index(r)
        if side > 0:
            st = self.stretch(k)
            length = st[2] if st else self.trail(r)
        else:
            st = self.stretch(k - 1) if k else None
            length = st[2] if st else self.lead(r)
        return max(0.0, self.max_pause - length)


def _islands(out, j, layers, placed_of, mine, max_pause):
    """A piece shorter than ISLAND_S joins its neighbour across a pause cut (no word between, and the joined piece
    holds no flat run over max-pause), else widens into its own silence to ISLAND_TARGET_S: flat frames only, never a
    removed word or another piece, never past max-pause of flat on the joined timeline, never past VIDEO_EDGE_S of
    flat at the video's edges."""
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
        joined = False
        for side in (-1, 1):
            n = k + side
            o = out[n] if 0 <= n < len(out) else None
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
        lo, hi = max(lo, r.s_in - j.room(r, -1)), min(hi, r.s_out + j.room(r, 1))
        speech_runs = [o for o in out if o.kind == "speech"]
        a0, b0 = _frames(lay.env, r.s_in, r.s_out)
        hits = [f for f in range(a0, b0) if not lay.flat[f]]
        if hits and speech_runs and r is speech_runs[0]:
            lo = max(lo, min(r.s_in, hits[0] * FRAME_S - VIDEO_EDGE_S))
        if hits and speech_runs and r is speech_runs[-1]:
            hi = min(hi, max(r.s_out, (hits[-1] + 1) * FRAME_S + VIDEO_EDGE_S))
        need = ISLAND_TARGET_S - (r.s_out - r.s_in)
        left = min(need / 2, max(0.0, r.s_in - lo))
        right = min(need - left, max(0.0, hi - r.s_out))
        left = min(need - right, max(0.0, r.s_in - lo))
        if left > _EPS:
            r.s_in, r.old_in, r.hard_in = round(r.s_in - left, 6), None, False
        if right > _EPS:
            r.s_out, r.old_out, r.hard_out = round(r.s_out + right, 6), None, False
        k += 1


def _cap(out, j, layers, placed_of, derived, mine, max_pause, breath):
    """No flat stretch on the joined timeline over max-pause (v5a fix 3, L-B1): across every joint, the trailing flat
    of one piece, any piece that is all flat, and the leading flat of the next keep only the pause rule (a breath
    each side, half of min(stretch, SENTENCE_END_S) each after a sentence end) and the kept words' own spans in
    them (a soft word's burst), within max-pause in all. A silence kept whole for an overlay (D2) is left as it is.
    Returns whether it changed anything."""
    changed = False
    i = 0
    while i < len(out) - 1:
        st = j.stretch(i)
        if st is None or st[2] <= max_pause + _EPS:
            i += 1
            continue
        a, b, length = st
        segs = []
        for n in range(a, b + 1):
            r = out[n]
            lo = r.s_out - j.trail(r) if n == a else r.s_in
            hi = r.s_in + j.lead(r) if n == b else r.s_out
            segs.append((r, lo, hi))
        if any(_held(layers[r.src], lo, hi) for r, lo, hi in segs):
            i = b
            continue
        prot = []
        for r, lo, hi in segs:
            for x in r.words:
                w = placed_of[r.src].get(x)
                if w is not None and min(w.end, hi) - max(w.start, lo) > _EPS:
                    prot.append((r, max(lo, w.start), min(hi, w.end)))
        last = [w for r, _, _ in segs[:1] for x in r.words for w in [placed_of[r.src].get(x)] if w is not None]
        pad = breath
        if last and _ends_sentence(max(last, key=lambda w: w.end).text):
            pad = max(breath, min(length, SENTENCE_END_S) / 2)
        allow = max(0.0, max_pause - 2 * FRAME_S - sum(e - s0 for _, s0, e in prot))
        pad_h = min(pad, allow / 2, segs[0][2] - segs[0][1])
        pad_t = min(pad, allow - pad_h, segs[-1][2] - segs[-1][1])
        new = []
        for n, (r, lo, hi) in enumerate(segs):
            keep = [(s0, e) for rr, s0, e in prot if rr is r]
            if n == 0:
                keep.append((lo, lo + pad_h))
            if n == len(segs) - 1:
                keep.append((hi - pad_t, hi))
            keep = sorted((max(lo, s0), min(hi, e)) for s0, e in keep if min(hi, e) - max(lo, s0) > _EPS)
            parts = []
            if n == 0 and lo > r.s_in + _EPS:
                parts.append((r.s_in, lo))
            for s0, e in keep:
                if parts and s0 <= parts[-1][1] + _EPS:
                    parts[-1] = (parts[-1][0], max(parts[-1][1], e))
                else:
                    parts.append((s0, e))
            if n == len(segs) - 1 and hi < r.s_out - _EPS:
                if parts and hi <= parts[-1][1] + _EPS:
                    parts[-1] = (parts[-1][0], r.s_out)
                else:
                    parts.append((hi, r.s_out))
            for s0, e in parts:
                p = replace(r, s_in=round(s0, 6), s_out=round(e, 6), words=[
                    x for x in r.words if x in placed_of[r.src]
                    and s0 - _EPS <= (placed_of[r.src][x].start + placed_of[r.src][x].end) / 2 <= e + _EPS])
                if abs(s0 - r.s_in) > _EPS:
                    p.old_in, p.hard_in = None, False
                if abs(e - r.s_out) > _EPS:
                    p.old_out, p.hard_out = None, False
                new.append(p)
        out[a:b + 1] = new
        changed = True
        i = a + max(1, len(new) - 1)
    return changed


def _held(lay, lo, hi):
    """[lo, hi] lies in a silence kept whole for an overlay (D2)."""
    return any(lay.silences[n][0] - _EPS <= lo and hi <= lay.silences[n][1] + _EPS for n in lay.held)


def _video_edges(runs, layers, kept_span, mine, breath=BREATH_S, strict=False):
    """The video opens and ends on sound (a burst of a soft word counts): its first speech piece starts at most a
    breath before its first sound, its last ends at most a breath after its last, never inside a word it keeps and
    never under ISLAND_S. strict (the last pass): at most VIDEO_EDGE_S of flat there, an island or not (the lead and
    tail bars hold; a piece left short is named)."""
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
            to = max(r.s_in, t - (VIDEO_EDGE_S if strict else breath))
            if not strict:
                to = min(to, r.s_out - ISLAND_S)
            if to > r.s_in + _EPS:
                r.s_in, r.old_in, r.hard_in = round(to, 6), None, False
        else:
            t = max([(hits[-1] + 1) * FRAME_S] + ([span[1]] if span else []))
            to = min(r.s_out, t + (VIDEO_EDGE_S if strict else breath))
            if not strict:
                to = max(to, r.s_in + ISLAND_S)
            if to < r.s_out - _EPS:
                r.s_out, r.old_out, r.hard_out = round(to, 6), None, False
