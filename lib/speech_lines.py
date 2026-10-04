"""Speech as text: words from a whisper sidecar, refined edges, and source lines with stable ids.

Whisper words are gapless: a pause is absorbed into a neighbouring word's span. `refine`
moves a word's edge out of a measured silence so the word covers speech only.
Times are read from `offsets` (ms) only, never the `timestamps` strings.
"""
import json
import os
import re
from dataclasses import dataclass, replace

LINE_BREAK_PAUSE_S = 0.6
LINE_MAX_WORDS = 25
SHOW_PAUSE_S = 0.15
PAUSE_SPLIT_S = SHOW_PAUSE_S
EDGE_TOUCH_S = 0.05


@dataclass(frozen=True)
class Word:
    idx: int
    text: str
    norm: str
    start: float
    end: float


@dataclass(frozen=True)
class Line:
    id: str
    words: tuple[Word, ...]


def norm(token: str) -> str:
    t = re.sub(r"^[^\w]+|[^\w]+$", "", token.strip().lower())
    return t


def _sidecar_has_transcription(path: str) -> bool:
    if not os.path.isfile(path):
        return False
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return False
    return isinstance(d, dict) and "transcription" in d


def sidecar_for(item: dict) -> str | None:
    src = item.get("src")
    if src:
        p = os.path.splitext(src)[0] + ".json"
        if _sidecar_has_transcription(p):
            return p
    nsrc = item.get("normalizedSrc")
    if nsrc and item.get("normalizedInPoint", 0) == 0:
        p = os.path.splitext(nsrc)[0] + ".json"
        if _sidecar_has_transcription(p):
            return p
    return None


def load_words(sidecar: str) -> list[Word]:
    with open(sidecar, encoding="utf-8") as f:
        d = json.load(f)
    words: list[Word] = []
    for seg in d.get("transcription", []):
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        off = seg["offsets"]
        words.append(Word(len(words), text, norm(text), off["from"] / 1000.0, off["to"] / 1000.0))
    return words


def _sound_segments(a: float, b: float, sils: list[tuple[float, float]]):
    """Word span [a, b] minus its splitting silences, as (start, end) pairs. None when no silence splits it."""
    cuts = []
    for s0, s1 in sils:
        if s1 <= a or s0 >= b:
            continue
        # a short silence mid-word is a consonant closure, not a pause
        if s1 - s0 >= PAUSE_SPLIT_S or s0 - a <= EDGE_TOUCH_S or b - s1 <= EDGE_TOUCH_S:
            cuts.append((max(s0, a), min(s1, b)))
    if not cuts:
        return None
    segs, cur = [], a
    for c0, c1 in sorted(cuts):
        if c0 > cur:
            segs.append((cur, c0))
        cur = max(cur, c1)
    if cur < b:
        segs.append((cur, b))
    return segs


def refine(words: list[Word], sils: list[tuple[float, float]]) -> tuple[list[Word], dict]:
    """Move word edges out of pauses so every visible pause becomes a gap between words.

    Whisper's boundary often sits 30-80 ms before a pause, so a word is cut by every silence that is
    at least PAUSE_SPLIT_S long or touches one of its edges (within EDGE_TOUCH_S). Its refined span is
    the longest remaining sound segment (the later on ties). A leftover segment is given to the
    neighbouring word only when it is contiguous with that word's refined edge; otherwise it is orphan.
    A word entirely inside a pause keeps its raw span and is listed in stats["inside_words"].
    Returns (words, stats) with stats keys inside, inside_words, attached, orphan.
    """
    stats: dict = {"inside": 0, "inside_words": [], "attached": 0, "orphan": 0}
    spans: list[list[float]] = []
    leftovers: list[list[tuple[float, float]]] = []
    mains: list[tuple[float, float]] = []
    for i, w in enumerate(words):
        segs = _sound_segments(w.start, w.end, sils)
        if segs is None:
            main, rest = (w.start, w.end), []
        elif not segs:
            stats["inside_words"].append(i)
            main, rest = (w.start, w.end), []
        else:
            main = max(segs, key=lambda sg: (sg[1] - sg[0], sg[0]))
            rest = [sg for sg in segs if sg is not main]
        mains.append(main)
        spans.append([main[0], main[1]])
        leftovers.append(rest)
    for i, rest in enumerate(leftovers):
        for a, b in rest:
            if b <= mains[i][0] and i > 0 and abs(spans[i - 1][1] - a) < 1e-6:
                spans[i - 1][1] = b
                stats["attached"] += 1
            elif a >= mains[i][1] and i + 1 < len(words) and abs(spans[i + 1][0] - b) < 1e-6:
                spans[i + 1][0] = a
                stats["attached"] += 1
            else:
                stats["orphan"] += 1
    stats["inside"] = len(stats["inside_words"])
    return [replace(w, start=sp[0], end=sp[1]) for w, sp in zip(words, spans)], stats


def uncertain_gaps(stats: dict) -> set[tuple[int, int]]:
    """Consecutive-word index pairs next to a word whisper placed inside a pause: the pause position there is unsure."""
    gaps: set[tuple[int, int]] = set()
    for i in stats["inside_words"]:
        if i > 0:
            gaps.add((i - 1, i))
        gaps.add((i, i + 1))
    return gaps


def _gap(prev: Word, nxt: Word) -> float:
    return nxt.start - prev.end


def _ends_sentence(text: str) -> bool:
    """True when the text, after trailing closing quotes and brackets, ends in . ? or !."""
    return text.rstrip("\"'\u201d\u2019)]").endswith((".", "?", "!"))


def split_lines(letter: str, words: list[Word]) -> list[Line]:
    groups: list[list[Word]] = []
    cur: list[Word] = []
    for w in words:
        if cur:
            prev = cur[-1]
            if _ends_sentence(prev.text) or _gap(prev, w) >= LINE_BREAK_PAUSE_S:
                groups.append(cur)
                cur = []
            elif len(cur) >= LINE_MAX_WORDS:
                k = max(range(1, len(cur)), key=lambda i: (_gap(cur[i - 1], cur[i]), -i))
                groups.append(cur[:k])
                cur = cur[k:]
        cur.append(w)
    if cur:
        groups.append(cur)
    return [Line(f"{letter}{n}", tuple(g)) for n, g in enumerate(groups, 1)]
