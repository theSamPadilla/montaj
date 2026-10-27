"""§585: which caption lines are a person's, and keeping them when the AI captions again.

Every line a caption run writes carries `auto`, a stamp of its text (`stamp`). A person's edit in the editor changes the
text and leaves the stamp, a line they add has none, and a line they split keeps the whole's stamp on both halves: so a
line is the person's (`is_persons`) when it has no stamp, or its text no longer matches it. Translated rows are never
anyone's here (generate_captions keeps them its own way). A track with no stamp at all was made before stamps and
cannot be judged: it gets no guard.

`keep_persons(prev, new)`: what an AI re-run writes. The person's lines stay as they are (their stamp too, so they stay
theirs); a new line over one of them (on any row) keeps only its words whose middle is outside every kept line,
clamped clear of them and split where a kept line sits between its words, and is stamped again; the kept lines'
translations stay with them. New lines never take a kept line's id.
"""
import copy
import hashlib
import re

from lib.caption_translation import is_translation, mint_ids


_SPACE = re.compile(r"[\s\ufeff\x1c-\x1f\x85]+")


def stamp(text) -> str:
    """The stamp of a line's text: 12 hex characters of sha256 over the text with its spacing evened (runs of white
    space, BOM and the C0 separators are one space, the ends dropped). The app's JS computes the same; the shared
    vectors are tests/fixtures/caption_stamp_vectors.json."""
    pieces = [p for p in _SPACE.split(text if isinstance(text, str) else "") if p]
    return hashlib.sha256(" ".join(pieces).encode("utf-8")).hexdigest()[:12]


def stamp_all(segments):
    """Stamp every line but translations, in place. Returns `segments`."""
    for s in segments:
        if isinstance(s, dict) and not is_translation(s):
            s["auto"] = stamp(s.get("text"))
    return segments


def is_persons(seg) -> bool:
    if not isinstance(seg, dict) or is_translation(seg):
        return False
    return not isinstance(seg.get("auto"), str) or seg["auto"] != stamp(seg.get("text"))


def carry_stamp(part, sources):
    """A line re-cut from `sources` is the AI's only if every source was; otherwise its stale stamp keeps it the person's."""
    if sources and all(isinstance(s.get("auto"), str) and not is_persons(s) for s in sources):
        part["auto"] = stamp(part.get("text"))


def stamped(segments) -> bool:
    """Whether a track carries stamps at all (one made since §585)."""
    return any(isinstance(s, dict) and not is_translation(s) and isinstance(s.get("auto"), str) for s in segments or [])


def _num(v, default=0.0):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def _around(seg, spans):
    """`seg` (a new line) with the kept spans taken out: [] when nothing of it is left, else one or more
    lines. A line with no words is dropped when a kept line overlaps it."""
    s0, s1 = _num(seg.get("start")), _num(seg.get("end"))
    hits = [(a, b) for a, b in spans if a < s1 and b > s0]
    if not hits:
        return [seg]
    words = seg.get("words")
    if not isinstance(words, list) or not words:
        return []
    eps = 1e-6
    inside = lambda t: any(a + eps <= t < b - eps for a, b in hits)  # noqa: E731
    runs, run, last_mid = [], [], None
    for w in words:
        mid = (_num(w.get("start")) + _num(w.get("end"))) / 2
        if inside(mid):
            if run:
                runs.append(run)
                run = []
            continue
        if run and any(a >= last_mid - eps and b <= mid + eps for a, b in hits):   # a kept line sits between the two words
            runs.append(run)
            run = []
        run.append(copy.deepcopy(w))
        last_mid = mid
    if run:
        runs.append(run)
    out = []
    n = -1
    for r in runs:
        for w in r:   # clamped clear of the kept lines, on the side its middle is on
            ws, we = _num(w.get("start")), _num(w.get("end"))
            mid = (ws + we) / 2
            for a, b in hits:
                if ws < b and we > a:
                    if mid >= b - eps:
                        ws = max(ws, b)
                    else:
                        we = min(we, a)
            w["start"], w["end"] = ws, we
        r = [w for w in r if w["end"] > w["start"]]
        if not r:
            continue
        n += 1
        part = copy.deepcopy(seg)
        part["words"] = r
        part["start"], part["end"] = r[0]["start"], r[-1]["end"]
        part["text"] = " ".join(str(w.get("word", w.get("text", ""))) for w in r)
        part["auto"] = stamp(part["text"])
        if n:
            part.pop("id", None)
        out.append(part)
    return out


def keep_persons(prev, new):
    """(segments, kept): the lines an AI re-run writes, `new` with the person's lines in `prev` kept (see the module
    doc), in time order; and those kept lines. With no stamp on `prev`, or no line of the person's in it: (new, [])."""
    prev = [s for s in (prev or []) if isinstance(s, dict)]
    new = [s for s in (new or []) if isinstance(s, dict)]
    if not stamped(prev):
        return new, []
    kept = [s for s in prev if is_persons(s)]
    if not kept:
        return new, []
    spans = []   # every kept line, on whatever row: the same words twice on two rows is a duplicate
    for s in kept:
        a, b = _num(s.get("start")), _num(s.get("end"), _num(s.get("start")))
        if b > a:
            spans.append((a, b))
    kept_ids = {s["id"] for s in kept if isinstance(s.get("id"), str)}
    out, changed = [], set()
    for s in new:
        if is_translation(s):
            if not (set(s.get("translationOf") or []) & kept_ids):
                out.append(s)
            continue
        parts = _around(s, spans)
        if parts != [s] and isinstance(s.get("id"), str):
            changed.add(s["id"])   # trimmed or dropped: its translations no longer fit it
        for part in parts:
            if part.get("id") in kept_ids:
                part.pop("id", None)
            out.append(part)
    out = [s for s in out if not (is_translation(s) and set(s.get("translationOf") or []) & changed)]
    # the kept lines' own translations stay with them
    theirs = [t for t in prev if is_translation(t) and set(t.get("translationOf") or []) & kept_ids]
    order = sorted(out + kept + theirs, key=lambda s: (_num(s.get("start")), 1 if is_translation(s) else 0))
    return mint_ids(order, kept_ids), kept
