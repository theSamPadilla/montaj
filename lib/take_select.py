"""Deterministic take selection over speech units (§558, clean_cut).

The rules are the select-takes skill's (skills/select-takes/SKILL.md, steps 2 to 5), made mechanical:

- A unit is one spoken sentence (the caller joins source lines a pause split). Its tokens are its words,
  normalized (lib/speech_lines.norm), with fillers left out.
- False start: a unit whose tokens are the opening of the NEXT unit's (a common prefix of at least
  PREFIX_MIN tokens covering at least PREFIX_COVER of the shorter one), and shorter than it, is an abandoned
  attempt at that unit. It is dropped and never forms a section ("Start by..." then "Start by picking...").
- Restart inside a unit: when the unit's first RESTART_MIN+ tokens come again within RESTART_WITHIN tokens
  ("Start by, start by picking..."), the words before the last restart are deleted and the take counts as
  restarted.
- Repeated phrase inside a unit (skill step 5): a phrase of REPEAT_MIN+ tokens said again within
  REPEAT_WITHIN tokens keeps only its final occurrence: the words from the first occurrence up to the last
  are deleted, and the take counts as restarted. The window keeps a phrase a sentence repeats on purpose,
  far apart, from being cut.
- Abandoned opening: a unit that opens with at least ABANDON_MIN tokens of the unit before it (and at least
  ABANDON_COVER of that unit), then breaks off where a new sentence starts (a capitalized word, not "I"), is a
  truncated retake run into the next sentence ("Then drag it onto Trim the start..."): the opening is deleted.
  An unpunctuated transcript gives no capital to go by, so the rule does not fire there.
- Sections: in cut order, a unit joins the section holding a take it is the same as: a token similarity
  (difflib ratio) of at least SAME_RATIO, or the prefix relation above (a truncated take). The best match
  wins, the most recent section on a tie. A short unit (under SHORT_TOKENS tokens: "Tom!", "No answer.")
  only joins the section of the unit right before it, so short lines said twice far apart stay separate.
  Anything else opens a new section. Unrelated sentences sharing common words stay apart: "The first one is
  the simplest" vs "The second one is the fastest" is 0.67.
- One take per section, by the skill's criteria in order: complete over truncated (truncated: ends in an
  ellipsis or dash, or its tokens are the opening of a take at least TRUNCATED_BY tokens longer), no restart,
  fewer flaws (fillers plus hesitations, which the caller counts), and the last attempt on a tie.
- Narrative order: sections in the order of their first take.

SAME_RATIO is 0.75: a reworded retake of one sentence ("The first one is the easiest" against "...the
simplest", 0.83) still matches, and two different sentences built the same way (0.67 above) do not. The skill
says to cut less when unsure, so the threshold sits above the parallel-sentence case.
"""
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from lib.speech_lines import norm

SAME_RATIO = 0.75
PREFIX_MIN = 2
PREFIX_COVER = 0.8
SHORT_TOKENS = 3
RESTART_MIN = 2
RESTART_WITHIN = 10
REPEAT_MIN = 3
REPEAT_WITHIN = 12
TRUNCATED_BY = 2
ABANDON_MIN = 3
ABANDON_COVER = 0.5
_I_FORMS = {"i", "i'm", "i've", "i'll", "i'd"}

_TRAILING_CUT = ("...", "…", "-", "—", "–")


@dataclass
class Unit:
    """One sentence as spoken. words: the display words, in order. fillers: fillers in the delivery (None:
    count them in `words`); hesitations: long pauses inside it. ref: the caller's handle."""
    words: list
    fillers: int | None = None
    hesitations: int = 0
    ref: object = None


@dataclass
class Selection:
    kept: list                                  # unit indices, one per section, in narrative order
    drop: dict = field(default_factory=dict)    # kept unit index -> word indices to delete in it
    sections: list = field(default_factory=list)  # unit indices per section, cut order
    losers: list = field(default_factory=list)    # unit indices not kept (false starts, other takes, filler-only)
    abandoned: list = field(default_factory=list)  # unit indices whose opening was an abandoned retake (deleted)


def _tokens(words, is_filler):
    """[(word index, token)] without fillers and empty tokens."""
    out = []
    for i, w in enumerate(words):
        t = norm(w)
        if t and not is_filler(t):
            out.append((i, t))
    return out


def _common_prefix(a, b):
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def _prefix_of(short, long):
    """`short` is the opening of `long` (a false start or a truncated take)."""
    if len(short) >= len(long):
        return False
    p = _common_prefix(short, long)
    return p >= PREFIX_MIN and p >= PREFIX_COVER * len(short)


def _ratio(a, b):
    return SequenceMatcher(None, a, b, autojunk=False).ratio() if a and b else 0.0


def _match(a, b):
    """How much unit tokens a and b are takes of one section: 0 when they are not."""
    r = _ratio(a, b)
    if r >= SAME_RATIO:
        return r
    if _prefix_of(a, b) or _prefix_of(b, a):
        return max(r, SAME_RATIO)
    return 0.0


def restart_cut(seq):
    """Index in seq of the last restart from the unit's opening, or 0 for none."""
    cut = 0
    for j in range(1, min(len(seq), RESTART_WITHIN + 1)):
        k = _common_prefix(seq, seq[j:])
        if k >= RESTART_MIN:
            cut = j
    return cut


def repeat_cuts(seq):
    """[(i, j)]: for each repeated phrase, delete seq[i:j] so only its final occurrence stays. Applied in
    order: each pair indexes the sequence left by the ones before it."""
    seq, cuts = list(seq), []
    while True:
        hit = None
        for i in range(len(seq) - REPEAT_MIN + 1):
            phrase = seq[i:i + REPEAT_MIN]
            for j in range(i + 1, min(len(seq) - REPEAT_MIN, i + REPEAT_WITHIN) + 1):
                if seq[j:j + REPEAT_MIN] == phrase:
                    hit = (i, j)
            if hit:
                break
        if not hit:
            return cuts
        cuts.append(hit)
        seq = seq[:hit[0]] + seq[hit[1]:]


def _clean(unit, is_filler):
    """(tokens left, word indices deleted, restarted)."""
    toks = _tokens(unit.words, is_filler)
    deleted, restarted = set(), False
    cut = restart_cut([t for _, t in toks])
    if cut:
        first_kept = toks[cut][0]
        deleted.update(range(first_kept))
        toks = toks[cut:]
        restarted = True
    for i, j in repeat_cuts([t for _, t in toks]):
        lo, hi = toks[i][0], toks[j][0]
        deleted.update(range(lo, hi))
        toks = toks[:i] + toks[j:]
        restarted = True
    return toks, deleted, restarted


def select(units, is_filler):
    """Pick one take per section. is_filler(token) -> bool on a normalized token."""
    n = len(units)
    cleaned = [_clean(u, is_filler) for u in units]
    abandoned = []
    for i in range(1, n):
        toks, deleted, restarted = cleaned[i]
        seq, prev = [t for _, t in toks], [t for _, t in cleaned[i - 1][0]]
        p = _common_prefix(seq, prev)
        if p >= ABANDON_MIN and p >= ABANDON_COVER * len(prev) and p < len(prev) and p < len(seq):
            word = units[i].words[toks[p][0]].lstrip("\"'(\u201c\u2018")
            if word[:1].isupper() and toks[p][1] not in _I_FORMS:
                cleaned[i] = (toks[p:], deleted | set(range(toks[p][0])), restarted)
                abandoned.append(i)
    seqs = [[t for _, t in c[0]] for c in cleaned]
    losers = set()

    false_start = set()
    for i in range(n - 1):
        if seqs[i] and _prefix_of(seqs[i], seqs[i + 1]):
            false_start.add(i)
    losers |= false_start
    losers |= {i for i in range(n) if not seqs[i]}

    sections, section_of = [], {}
    prev = None
    for i in range(n):
        if i in losers:
            continue
        cands = range(len(sections))
        if len(seqs[i]) < SHORT_TOKENS:
            cands = [section_of[prev]] if prev is not None else []
        best, best_score = None, 0.0
        for s in cands:
            score = max(_match(seqs[i], seqs[t]) for t in sections[s])
            if score > 0 and (score > best_score or (score == best_score and best is not None
                                                      and sections[s][-1] > sections[best][-1])):
                best, best_score = s, score
        if best is None:
            sections.append([i])
            section_of[i] = len(sections) - 1
        else:
            sections[best].append(i)
            section_of[i] = best
        prev = i

    def flaws(i):
        u = units[i]
        fillers = u.fillers if u.fillers is not None else sum(1 for w in u.words if norm(w) and is_filler(norm(w)))
        return fillers + (u.hesitations or 0)

    def truncated(i, section):
        last = units[i].words[-1].strip() if units[i].words else ""
        if last.endswith(_TRAILING_CUT):
            return True
        return any(len(seqs[t]) - len(seqs[i]) >= TRUNCATED_BY and _prefix_of(seqs[i], seqs[t])
                   for t in section if t != i)

    kept = []
    for section in sections:
        best = max(section, key=lambda i: (not truncated(i, section), not cleaned[i][2], -flaws(i), i))
        kept.append(best)
        losers |= {i for i in section if i != best}
    return Selection(kept=kept, drop={i: cleaned[i][1] for i in kept if cleaned[i][1]},
                     sections=sections, losers=sorted(losers), abandoned=abandoned)
