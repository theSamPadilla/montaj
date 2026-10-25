"""Where whisper's words really are, from the audio's level (§558, cut).

Whisper's words are gapless: a pause sits inside a neighbouring word's span, and on a quiet voiceover a word's
span can run over half a second of near silence. speech_lines.refine moves edges out of the pauses ffmpeg's
silencedetect finds, at the source's noise floor plus 15 dB; a quiet word lies wholly inside such a "silence", so
the gaps beside it are unsure and the cut keeps them whole (on a real 128 s voiceover: 49 such words, and pauses
of 0.6-0.8 s left in a cut capped at 0.45).

This module reads the level itself: the RMS of each FRAME_S of the first audio stream, in dB. The floor is the
clip's own speech level (the median of its words' loudest frames) less FLOOR_BELOW_SPEECH_DB, kept within
FLOOR_RANGE_DB: -42 dB for speech at -16. Then for each whisper word:
- its span is trimmed to its audible core: from its first frame at or above the floor to the end of its last one
  (a quiet stretch inside the word's sound is kept: the onset and the loudest part are never cut through);
- a run of INAUDIBLE_RUN or more words in a row with no frame at or above the floor is inaudible (spoken under the
  noise, or not at all): each keeps its whisper span and is listed in stats["inaudible"], for cut to remove and tag;
  the cut that removes them takes no frame at or above the floor;
- a lone such word between audible ones is whisper's timing, not silence: a short word ("I", "with") whisper put in
  the pause next to the word that holds its sound. It stays a word, LONE_WORD_S long at the middle of its whisper
  span (where speech_edit and the captions read it), so the text and the captions keep it and the pause it sat in
  is two gaps like any other.
No word is whisper-placed inside a pause any more, so no gap is unsure. The measured silences are the runs of
frames under the floor, at least MIN_SILENCE_S long.

cut uses it through `Refiner`, which speech_text.derive calls in place of speech_lines.refine, in the plan and in
its apply alike. speech_edit is unchanged.
"""
import math
import os
import statistics
import tempfile
import wave
from array import array
from dataclasses import replace

from lib.common import ff_path, ffmpeg_bin, run

VERSION = "speech-energy v1"
FRAME_S = 0.01
RATE = 16000
FLOOR_BELOW_SPEECH_DB = 26.0
FLOOR_RANGE_DB = (-48.0, -36.0)
MIN_SILENCE_S = 0.06
INAUDIBLE_RUN = 2
LONE_WORD_S = 0.04
DEAD_AIR_MIN_S = 0.16       # a pause this long, every frame under the floor, is dead air
BREATH_S = 0.04             # what a dead-air pause keeps on each side of the words
_SILENT_DB = -120.0


def envelope(media: str) -> list:
    """dB (RMS) of each FRAME_S of the first audio stream of `media`, mono at RATE."""
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        run([ffmpeg_bin(), "-v", "error", "-y", "-i", ff_path(media), "-map", "0:a:0", "-ac", "1", "-ar", str(RATE),
             "-c:a", "pcm_s16le", wav_path], timeout=600)
        with wave.open(wav_path, "rb") as w:
            samples = array("h", w.readframes(w.getnframes()))
    finally:
        if os.path.exists(wav_path):
            os.unlink(wav_path)
    hop = int(RATE * FRAME_S)
    out = []
    for i in range(0, len(samples) - hop + 1, hop):
        chunk = samples[i:i + hop]
        ms = sum(v * v for v in chunk) / hop
        out.append(20 * math.log10(math.sqrt(ms) / 32768) if ms > 0 else _SILENT_DB)
    return out


def _frames(env, start, end):
    a = max(0, int(math.floor(start / FRAME_S + 1e-9)))
    b = min(len(env), max(a + 1, int(math.ceil(end / FRAME_S - 1e-9))))
    return a, b


def peak(env, start, end) -> float:
    a, b = _frames(env, start, end)
    return max(env[a:b], default=_SILENT_DB)


def floor_db(words, env) -> float:
    """The clip's speech level (median of its words' peaks) less FLOOR_BELOW_SPEECH_DB, within FLOOR_RANGE_DB."""
    peaks = [peak(env, w.start, w.end) for w in words]
    level = statistics.median(peaks) if peaks else -16.0
    lo, hi = FLOOR_RANGE_DB
    return min(hi, max(lo, level - FLOOR_BELOW_SPEECH_DB))


def refine(words, env, floor):
    """(words trimmed to their audible cores, stats {inaudible: [word index], inside_words: [], inside, attached,
    orphan}, silences [(start, end)]). See the module docstring."""
    out, silent = [], []
    for w in words:
        a, b = _frames(env, w.start, w.end)
        loud = [k for k in range(a, b) if env[k] >= floor]
        silent.append(not loud)
        if not loud:
            out.append(w)
            continue
        s = max(w.start, loud[0] * FRAME_S)
        e = min(w.end, (loud[-1] + 1) * FRAME_S)
        out.append(replace(w, start=round(s, 6), end=round(max(s, e), 6)))
    inaudible = []
    for i, w in enumerate(out):
        if not silent[i]:
            continue
        n = 1
        while i - n >= 0 and silent[i - n]:
            n += 1
        k = 1
        while i + k < len(out) and silent[i + k]:
            n, k = n + 1, k + 1
        if n >= INAUDIBLE_RUN:
            inaudible.append(w.idx)
        else:                                                       # whisper's timing: see above
            mid = (w.start + w.end) / 2
            out[i] = replace(w, start=round(max(w.start, mid - LONE_WORD_S / 2), 6),
                             end=round(min(w.end, mid + LONE_WORD_S / 2), 6))
    sils, run_start = [], None
    for k, v in enumerate(env + [0.0]):
        if v < floor and k < len(env):
            run_start = k if run_start is None else run_start
        elif run_start is not None:
            if (k - run_start) * FRAME_S >= MIN_SILENCE_S - 1e-9:
                sils.append((round(run_start * FRAME_S, 6), round(k * FRAME_S, 6)))
            run_start = None
    stats = {"inaudible": inaudible, "inside_words": [], "inside": 0, "attached": 0, "orphan": 0}
    return out, stats, sils


def quiet(env, floor, start, end) -> bool:
    """Every frame of [start, end] is under the floor."""
    a, b = _frames(env, start, end)
    return all(v < floor for v in env[a:b])


class Refiner:
    """What speech_text.derive calls for each source instead of speech_lines.refine: (words, stats, silences).
    Measures each media once per process; `floor` and `env` say what it measured, for cut's plan."""

    def __init__(self):
        self.env, self.floor = {}, {}

    stamp = f"{VERSION} {FRAME_S} {FLOOR_BELOW_SPEECH_DB} {FLOOR_RANGE_DB} {MIN_SILENCE_S} {INAUDIBLE_RUN} {LONE_WORD_S}"

    def __call__(self, key, media, raw):
        if key not in self.env:
            self.env[key] = envelope(media)
            self.floor[key] = floor_db(raw, self.env[key])
        return refine(raw, self.env[key], self.floor[key])

    def quiet(self, key, start, end) -> bool:
        return key in self.env and quiet(self.env[key], self.floor[key], start, end)

    def end(self, key) -> float:
        """The measured length of the source, in seconds."""
        return len(self.env.get(key, ())) * FRAME_S
