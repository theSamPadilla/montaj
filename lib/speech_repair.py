"""Whisper's broken stretches, transcribed again (§577, ucla clip B).

Over a long take with many retakes whisper keeps its TEXT in order but can lose its TIMES over a stretch: words
collapsed to no length, a phrase stretched over seconds of silence, the next sentence's words standing on the sound of
the one before (8 s off on the real file). No placement can mend that: a retake rule then removes the words that stand
on another sentence's sound, and that sentence goes with them. So, per source, before any placement:

1. `stretches` finds the broken stretches on layer 1 (lib/speech_energy.layer1):
   - a seed is ZERO_RUN or more words in a row each under ZERO_S long, or SILENT_RUN or more words in a row with no
     voiced frame in their spans, together over SILENT_SPAN_S of the source;
   - a seed grows over the bad words beside it (under ZERO_S, no voiced frame, or STRETCH_S longer than their text:
     LETTER_S a letter plus WORD_BASE_S), so the stretch runs from the last good word before it to the first good
     word after it (the source's start or end when there is none);
   - its window is the time between those good words, and it is broken only when that window holds MIN_VOICED_S of
     voiced audio (layer 1's voiced runs; a made-up tail over the room has none, and is left to the tail rule).
2. `repair` transcribes each voiced run of a broken window again, one at a time, with the same whisper call cut uses for
   a clip with no transcript (a trim spec of that run, so its times come back on the source's clock), and puts the new
   words in the stretch's place, in order. Every other word is left as whisper wrote it. Nothing is written beside the
   clip: the new words live in the cut's memory, and in a cache under the temp folder so the apply reads the very words
   the plan read. A run whisper cannot transcribe again (no model, a failure, no words) leaves the stretch as it was.

The cost is one whisper run per voiced run of a broken window (a few seconds of audio each), only where a stretch is
broken; a source with none costs nothing.
"""
import hashlib
import json
import os
import tempfile
from dataclasses import replace

from lib.speech_lines import Word, norm

ZERO_S = 0.03            # a word this short is collapsed (whisper's zero-length words)
ZERO_RUN = 3             # ... and this many of them in a row seed a broken stretch
SILENT_RUN = 3           # this many words in a row with no voiced frame in their spans ...
SILENT_SPAN_S = 2.0      # ... spanning this much of the source, seed one too
STRETCH_S = 1.0          # a word this much longer than its text is stretched (a bad word beside a seed)
LETTER_S = 0.09          # (lib/speech_energy's: a word's expected length is LETTER_S a letter plus WORD_BASE_S)
WORD_BASE_S = 0.2
MIN_VOICED_S = 0.3       # a broken window holds this much voiced audio, or it is left alone
RUN_PAD_S = 0.1          # each voiced run is transcribed with this much of the room either side (whisper's context)
VERSION = "speech-repair v1"
_STAMPED = ("ZERO_S", "ZERO_RUN", "SILENT_RUN", "SILENT_SPAN_S", "STRETCH_S", "MIN_VOICED_S", "RUN_PAD_S")
STAMP = VERSION + " " + " ".join(f"{k}={globals()[k]}" for k in _STAMPED)
_EPS = 1e-6


def _letters(text):
    return sum(1 for c in text if c.isalnum())


def _voiced(lay, w):
    """Whether word w's whisper span holds a voiced frame of layer 1."""
    if not lay.env:
        return False
    frame = 0.01
    a = max(0, int(w.start / frame + 1e-9))
    b = min(len(lay.flat), max(a + 1, int(-(-w.end // frame))))
    return any(not lay.flat[k] for k in range(a, b))


def _bad(lay, w):
    dur = w.end - w.start
    return (dur < ZERO_S - _EPS or not _voiced(lay, w)
            or dur > LETTER_S * _letters(w.text) + WORD_BASE_S + STRETCH_S + _EPS)


def stretches(words, lay):
    """[(first word, end word, window start, window end)] of the broken stretches of a source (see the module
    docstring), in order."""
    n = len(words)
    if not n or not lay.env:
        return []
    zero = [w.end - w.start < ZERO_S - _EPS for w in words]
    silent = [not _voiced(lay, w) for w in words]
    seeds = []
    for flags, need in ((zero, ZERO_RUN), (silent, SILENT_RUN)):
        i = 0
        while i < n:
            if not flags[i]:
                i += 1
                continue
            j = i
            while j < n and flags[j]:
                j += 1
            if j - i >= need and (flags is zero or words[j - 1].end - words[i].start >= SILENT_SPAN_S - _EPS):
                seeds.append((i, j))
            i = j
    out = []
    for i, j in sorted(seeds):
        while i > 0 and _bad(lay, words[i - 1]):
            i -= 1
        while j < n and _bad(lay, words[j]):
            j += 1
        if out and i <= out[-1][1]:
            i = out.pop()[0]
        out.append((i, j))
    res = []
    for i, j in out:
        t0 = words[i - 1].end if i > 0 else 0.0
        t1 = words[j].start if j < n else lay.end
        runs = _runs(lay, t0, t1)
        if sum(b - a for a, b in runs) >= MIN_VOICED_S - _EPS:
            res.append((i, j, t0, t1))
    return res


def _runs(lay, t0, t1):
    """Layer 1's voiced runs clipped to [t0, t1]."""
    return [(max(a, t0), min(b, t1)) for a, b in lay.voiced if min(b, t1) - max(a, t0) > _EPS]


def _cache_key(media, a, b, tag):
    try:
        st = os.stat(media)
        ident = f"{os.path.abspath(media)}|{st.st_size}|{st.st_mtime_ns}"
    except OSError:
        ident = os.path.abspath(media)
    return hashlib.sha256(f"{ident}|{a:.3f}|{b:.3f}|{tag}|{STAMP}".encode()).hexdigest()[:32]


def _cached(media, a, b, tag, run):
    """run(media, a, b) -> [(text, start, end)] or None, cached under the temp folder."""
    folder = os.path.join(tempfile.gettempdir(), "montaj-cut-retranscribe")
    path = os.path.join(folder, _cache_key(media, a, b, tag) + ".json")
    try:
        with open(path, encoding="utf-8") as f:
            return [tuple(x) for x in json.load(f)]
    except (OSError, ValueError):
        pass
    got = run(media, a, b)
    if got:
        try:
            os.makedirs(folder, exist_ok=True)
            tmp = path + f".{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump([list(x) for x in got], f)
            os.replace(tmp, path)
        except OSError:
            pass
    return got


def repair(words, lay, media, retranscribe, tag=""):
    """(words, report): each broken stretch's words merged with whisper's words for its window's voiced runs,
    transcribed one run at a time (retranscribe(media, start, end) -> [(text, start, end)] on the source's clock, or
    None), every word numbered again in order. The merge never loses a word: the two texts are aligned word for word
    (lib's norm), a matched word takes the new word's time, a word only the second run heard is added, and a word
    only the first run wrote is kept, after the new words of its block (whisper's times run early over a broken
    stretch: its sound lies later), its time moved no earlier than the word before. report: [{"words": (first, end)
    old indexes, "window": (t0, t1), "runs": n, "new": n, "matched": n, "added": n, "kept": n}], with "error" for a
    stretch whose second run came back with no words (its words are left as they were)."""
    from difflib import SequenceMatcher
    found = stretches(words, lay)
    if not found or retranscribe is None:
        return list(words), []
    out, report, k = [], [], 0
    for i, j, t0, t1 in found:
        new = []
        runs = _runs(lay, t0, t1)
        for a, b in runs:
            lo, hi = max(t0, a - RUN_PAD_S), min(t1, b + RUN_PAD_S)
            got = _cached(media, lo, hi, tag, retranscribe) or []
            new += [(t, max(lo, s), min(hi, max(s, e))) for t, s, e in got
                    if norm(t) and lo - _EPS <= (s + e) / 2 <= hi + _EPS]
        entry = {"words": (i, j), "window": (round(t0, 2), round(t1, 2)), "runs": len(runs), "new": len(new)}
        if not new:
            entry["error"] = getattr(retranscribe, "last_error", None) or "no words"
            report.append(entry)
            continue
        old = words[i:j]
        fresh = [Word(-1, t.strip(), norm(t), round(s, 3), round(e, 3)) for t, s, e in new]
        merged, n_match, n_add, n_keep = [], 0, 0, 0
        sm = SequenceMatcher(None, [w.norm for w in old], [w.norm for w in fresh], autojunk=False)
        for op, a0, a1, b0, b1 in sm.get_opcodes():
            if op == "equal":
                merged += [replace(fresh[b], text=old[a].text) for a, b in zip(range(a0, a1), range(b0, b1))]
                n_match += a1 - a0
            else:
                merged += fresh[b0:b1] + [replace(w, idx=-2) for w in old[a0:a1]]
                n_add += b1 - b0
                n_keep += a1 - a0
        entry.update(matched=n_match, added=n_add, kept=n_keep)
        report.append(entry)
        out += words[k:i] + merged
        k = j
    out += words[k:]
    if not any("error" not in r for r in report):
        return list(words), report
    # in order, and numbered again (a word the merge placed takes no time before the word before it)
    fixed, prev = [], 0.0
    for n, w in enumerate(out):
        s = max(w.start, prev) if w.idx < 0 else w.start
        fixed.append(replace(w, idx=n, start=round(s, 3), end=round(max(s, w.end), 3)))
        prev = max(prev, fixed[-1].end)
    return fixed, report
