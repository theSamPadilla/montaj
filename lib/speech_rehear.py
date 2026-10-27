"""Hear a slow phrase again (PL89i, 52's kung fu fix 3).

Whisper can write a phrase said twice once, holding a short word over the second saying: on the kung fu clips "but in
all, but in all seriousness" came out "But in all" with "all" held 0.81 s, and "but then there is, but then there is
this part" came out once with "then" 0.57 s and "there" 0.70 s. The cut plan then had no repeat to tag, the false
starts survived, and an agent's "restore" put one back. cut hears such a phrase's own audio again before it writes
the plan, and when that hearing has more words and still holds the phrase's words in order, they replace the
phrase's words in montaj's own transcript (a copy of the old one kept), so repeat? and retake? fire as usual.

Bounded: only a phrase holding a short word held long, or said at under SLOW_RATE of the clip's other phrases' rate
(CV: "Here's how it works" twice, written once at 1.7 words a second against 3.6), at most MAX_PHRASES of them and
MAX_AUDIO_S of audio a cut. One hearing can collapse the repeat the way the transcript did (CV: large-v3-turbo heard it
once on the phrase's window and 0.1 s earlier; base.en heard it twice), so a phrase not heard better is heard again
EARLY_S earlier, then with a second model; a hearing is judged on the words that end clear of the window's end (EDGE_S),
where the next word is cut, and the phrase's own words past that edge are kept.
"""
import json
import os
import re
from dataclasses import dataclass, field

SLOW_WORD_S = 0.5        # a word this long or longer ...
SLOW_LETTERS = 5         # ... with this many letters or fewer, not ending a sentence, may hold a second saying
PHRASE_GAP_S = 0.2       # a gap this long or longer ends a phrase
PHRASE_MAX_WORDS = 12    # a longer phrase is heard around its held word only
AROUND_HELD = 4          # words kept each side of the held word in a long phrase
PAD_S = 0.1              # heard this much beyond the phrase each side
HELD_PAD_S = 0.05        # the second try starts this much before the held word
MAX_PHRASES = 6
MAX_AUDIO_S = 30.0
SLOW_RATE = 0.5          # a phrase said at under this share of the clip's other phrases' rate (median) ...
RATE_MIN_WORDS = 3       # ... with at least this many words, may hold a second saying
EARLY_S = 0.1            # the second try's window starts this much earlier
EDGE_S = 0.15            # words ending this close to the window's end may be cut by it: judged without them
EXTEND_S = 1.0           # the first retry runs on through the words ending this soon after the phrase (1.5.0)


@dataclass
class Budget:
    """How many phrases, and how much audio, one cut may hear again."""
    phrases: int = MAX_PHRASES
    seconds: float = MAX_AUDIO_S
    used: float = field(default=0.0)
    count: int = field(default=0)

    def take(self, seconds):
        if self.count >= self.phrases or self.used + seconds > self.seconds + 1e-9:
            return False
        self.count += 1
        self.used += seconds
        return True


def _norm(text):
    return re.sub(r"[^\w']+", "", text.lower())


def _is_word(text):
    return any(c.isalnum() for c in text)


def _held(word):
    text, start, end = word
    letters = sum(c.isalnum() for c in text)
    # a word held before a comma or a sentence's end is the speaker's pause, not a second saying
    return 0 < letters <= SLOW_LETTERS and end - start >= SLOW_WORD_S and not text.rstrip().endswith((".", "!", "?", ",", ";", ":"))


def _words(entries):
    """[(entry index, (text, start, end))] of the transcript's words."""
    out = []
    for k, e in enumerate(entries):
        text = (e.get("text") or "").strip()
        off = e.get("offsets") or {}
        if text and _is_word(text) and "from" in off and "to" in off:
            out.append((k, (text, off["from"] / 1000.0, off["to"] / 1000.0)))
    return out


def _rate(ws):
    span = ws[-1][2] - ws[0][1]
    return len(ws) / span if span > 1e-6 else float("inf")


def slow_phrases(entries):
    """[(first, last)] word indexes (into the transcript's words) of phrases that hold a short word held long, or are
    said at under SLOW_RATE of the median rate of the clip's other phrases."""
    words = [w for _, w in _words(entries)]
    spans, i = [], 0
    while i < len(words):
        j = i
        while j + 1 < len(words) and words[j + 1][1] - words[j][2] < PHRASE_GAP_S:
            j += 1
        spans.append((i, j))
        i = j + 1
    rates = {(i, j): _rate(words[i:j + 1]) for i, j in spans if j - i + 1 >= RATE_MIN_WORDS}
    out = []
    for i, j in spans:
        held = [k for k in range(i, j + 1) if _held(words[k])]
        others = sorted(r for k, r in rates.items() if k != (i, j))
        slow = ((i, j) in rates and others and j - i + 1 <= PHRASE_MAX_WORDS
                and rates[(i, j)] < SLOW_RATE * others[len(others) // 2])
        if slow and not held:
            out.append((i, j))
        elif held:
            if j - i + 1 > PHRASE_MAX_WORDS:
                h = max(held, key=lambda k: words[k][2] - words[k][1])
                out.append((max(i, h - AROUND_HELD), min(j, h + AROUND_HELD)))
            else:
                out.append((i, j))
    return out


def _clean(heard):
    return [(t.strip(), a, b) for t, a, b in heard if t and _is_word(t.strip())]


def _better(orig, new):
    """The new words are more, hold the old ones in order, and every word added is one of the phrase's own: a second
    saying repeats the phrase (a word whisper made up, such as a lone "X", is never put in)."""
    if len(new) <= len(orig):
        return False
    want, got = [_norm(t) for t, _, _ in orig], [_norm(t) for t, _, _ in new]
    k, extra = 0, []
    for g in got:
        if k < len(want) and g == want[k]:
            k += 1
        else:
            extra.append(g)
    return k == len(want) and all(e in want for e in extra)


def _accept(words, heard, end):
    """The phrase's words as `heard` gives them, or None: when heard is better (_better), or, judged only on the words
    of both that end clear of the window's end (EDGE_S, where the next word is cut), better there; then the phrase's
    own words past that edge follow, none starting before the last word heard."""
    if _better(words, heard):
        return heard
    cut = end - EDGE_S
    ow = [w for w in words if w[2] <= cut]
    hw = [w for w in heard if w[2] <= cut]
    tail = words[len(ow):]
    if not ow or not tail or len(ow) < len(words) - len(tail) or not _better(ow, hw):
        return None
    last = hw[-1][2]
    return hw + [(t, max(a, last), max(b, last)) for t, a, b in tail]


def until_after(words, j):
    """The end of the words that run on from word j without a pause and end within EXTEND_S of it, or None."""
    k = j
    while (k + 1 < len(words) and words[k + 1][1] - words[k][2] < PHRASE_GAP_S
           and words[k + 1][2] <= words[j][2] + EXTEND_S):
        k += 1
    return words[k][2] if k > j else None


def rehear_phrase(window, words, alt=None, until=None):
    """The phrase's words as heard again, or None. window(start, end) -> [(text, start, end)] in source seconds; alt:
    the same with a second model, or None; until: where the words after the phrase reach a natural end (until_after).
    First the whole phrase; when that hears it once again, from its longest held word on, the words before kept; then
    run on to `until` (1.5.0, CV pl89r: a window cut mid-word collapsed the repeat, one ending on whole words did not),
    judged up to the phrase's own end; then the whole phrase EARLY_S earlier; then with `alt`."""
    start, end = words[0][1] - PAD_S, words[-1][2] + PAD_S
    got = _accept(words, _clean(window(round(start, 3), round(end, 3))), end)
    if got:
        return got
    held = [k for k, w in enumerate(words) if _held(w)]
    if held:
        h = max(held, key=lambda k: words[k][2] - words[k][1])
        at = words[h][1] - HELD_PAD_S
        tail = [w for w in _clean(window(round(at, 3), round(end, 3))) if w[1] >= at - 1e-6]
        combined = list(words[:h]) + tail
        if _better(words, combined):
            return combined
    tries = [(window, start, until + PAD_S)] if until is not None and until + PAD_S > end else []
    for hear, s0, e0 in tries + [(window, start - EARLY_S, end), (alt, start, end)]:
        if hear is None:
            continue
        got = _accept(words, _clean(hear(round(max(0.0, s0), 3), round(e0, 3))), end)
        if got:
            return got
    return None


def _montaj_runs(sidecar):
    """(bytes, doc) of montaj's own transcript made by runs, or None."""
    try:
        with open(sidecar, "rb") as f:
            old = f.read()
        doc = json.loads(old)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or not isinstance(doc.get("montaj"), dict) or doc["montaj"].get("by") != "runs":
        return None
    return (old, doc) if isinstance(doc.get("transcription"), list) else None


def candidates(sidecar):
    """[(held seconds, first, last, phrase seconds)] of the transcript's slow phrases: a cut hears the longest-held
    first across all its clips (the kung fu clip A's ordinary slow phrases would otherwise have taken the budget)."""
    got = _montaj_runs(sidecar)
    if got is None:
        return []
    entries = got[1]["transcription"]
    words = [w for _, w in _words(entries)]
    out = []
    for i, j in slow_phrases(entries):
        held = max((w[2] - w[1] for w in words[i:j + 1] if _held(w)), default=max(w[2] - w[1] for w in words[i:j + 1]))
        out.append((round(held, 3), i, j, round(words[j][2] - words[i][1] + 2 * PAD_S, 3)))
    return out


def rehear_file(sidecar, src, window, budget, only=None, alt=None):
    """Hear the transcript's slow phrases again and put what was heard in it. Only montaj's own transcript made by runs
    is rewritten, and only when it is as read; a copy of it is kept first (<stem>.full.json). [{clip, at, was,
    heard}] for each phrase changed. only: the (first, last) phrases to hear (all when None)."""
    got = _montaj_runs(sidecar)
    if got is None:
        return []
    old, doc = got
    entries = doc["transcription"]
    indexed = _words(entries)
    changes = []
    for i, j in slow_phrases(entries):
        if only is not None and (i, j) not in only:
            continue
        phrase = [w for _, w in indexed[i:j + 1]]
        if not budget.take(phrase[-1][2] - phrase[0][1] + 2 * PAD_S):
            break
        new = rehear_phrase(window, phrase, alt, until_after([w for _, w in indexed], j))
        if new:
            changes.append((indexed[i][0], indexed[j][0], phrase, new))
    if not changes:
        return []
    out = list(entries)
    for e0, e1, _, new in reversed(changes):
        run = entries[e0].get("run")
        made = [{"text": f" {t}", "offsets": {"from": round(a * 1000), "to": round(b * 1000)},
                 **({"run": run} if run is not None else {})} for t, a, b in new]
        out[e0:e1 + 1] = made
    doc["transcription"] = out
    from lib.speech_units import keep_copy       # late: speech_units pulls in the transcribers
    try:
        if os.path.islink(sidecar) or open(sidecar, "rb").read() != old:
            return []
        if keep_copy(sidecar, old, ".json") is None:
            return []
        stage = f"{sidecar}.{os.getpid()}.tmp"
        with open(stage, "w", encoding="utf-8") as f:
            f.write(json.dumps(doc))
        os.replace(stage, sidecar)
    except OSError:
        return []
    return [{"clip": os.path.basename(src), "at": round(phrase[0][1], 2), "was": " ".join(t for t, _, _ in phrase),
             "heard": " ".join(t for t, _, _ in new)} for _, _, phrase, new in changes]
