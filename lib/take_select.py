"""Deterministic take selection over speech units (§558, cut).

The rules are the select-takes skill's (skills/select-takes/SKILL.md, steps 2 to 5), made mechanical, and
built to cut less when unsure: a sentence that only LOOKS like a retake (a list, a parallel clause, a refrain)
must survive whole, because an under-cut is visible and a deleted line is not.

- A unit is one spoken sentence (the caller joins source lines a pause split). Its tokens are its words,
  normalized (lib/speech_lines.norm), with fillers left out. A unit carries its clip and the word positions
  that follow a timing break (a new source line, or a pause of BREAK_GAP_S or more).
- Closed: a unit that ends a question or an exclamation is complete as said, never a false start or a
  truncated take of a longer one. One that ends in a period, with CLOSED_TOKENS or more tokens, is the same
  unless the longer unit comes right after it and says all of it again ("I built an app." then, at once, "I
  built an app that edits videos.": a retake; with a sentence between, or "Then I opened the app." before
  "Then I opened the Montaj editor...", two sentences). An ellipsis or a dash is not an ending.
- Prefix relation: unit a's tokens are the opening of b's (a common prefix of at least PREFIX_MIN tokens
  covering at least PREFIX_COVER of a), a shorter, and a not closed with respect to b.
- False start: a unit in the prefix relation with the NEXT unit is an abandoned attempt at it. It is dropped
  and never forms a section ("Start by..." then "Start by picking...").
- Restart inside a unit: when the unit's whole opening of j tokens (j at least RESTART_MIN, within
  RESTART_WITHIN) is said again right after it ("Start by, start by picking..."), the words before the
  restart are deleted and the take counts as restarted. A clause that only starts the same way ("The more you
  edit, the more you learn") is not a restart.
- Repeated phrase inside a unit (skill step 5): a phrase of REPEAT_MIN tokens said again within REPEAT_WITHIN
  tokens is a restarted clause only when the second saying repeats the span before it: k tokens of the span
  seq[i:j] open seq[j:] (the span's last token may be cut off, a string prefix of the retake's), and either
  (A) k is the whole span, or (B) k is at least REPEAT_PARTIAL_MIN and REPEAT_PARTIAL_COVER of the span, and
  the span does not end at clause punctuation (, ; : . ! ?). Then seq[i:j] is deleted and the take counts as
  restarted. "and always on mode, and always on mode called Kyros" is (A); "we shall fight on the beaches, we
  shall fight on the landing grounds" is not (the span ends at a comma). Accepted residual: a clause said
  whole twice in a row ("never give up, never give up, never give up on your dream") is cut by (A) like a
  stutter.
- Abandoned opening: a unit that opens with at least ABANDON_MIN tokens of the unit before it (and at least
  ABANDON_COVER of that unit), then breaks off where a new sentence starts, is a truncated retake run into the
  next sentence ("Then drag it onto | Trim the start..."): the opening is deleted. "Where a new sentence
  starts" needs both a capitalized word (not "I") and a timing break before it; a capital alone may be a name
  ("We launched it on Product Hunt").
- Same section: two units are takes of one section when they differ only by inserted or dropped words (no
  word replaced: "the price" against "the speed" are two sentences) and either are in the prefix relation, or
  have a token similarity (difflib ratio) of at least SAME_RATIO. Within one clip a unit only joins a section
  whose take is at most NEAR_UNITS units back (a refrain or a callback later in a clip is not a retake); across
  clips at any distance. A short unit (under SHORT_TOKENS tokens: "Tom!", "No answer.") only joins the section
  of the unit right before it. The best match wins, the most recent section on a tie; anything else opens a
  new section.
- One take per section, by the skill's criteria in order: complete over truncated (truncated: ends in an
  ellipsis or dash, or is in the prefix relation with a take at least TRUNCATED_BY tokens longer), then no
  restart, then the last such take; fewer flaws (fillers plus hesitations, which the caller counts) decide only
  between takes that say the same words, so a later spoken correction always wins.
- Narrative order: sections in the order of their first take.
"""
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from lib.speech_lines import norm

SAME_RATIO = 0.75
PREFIX_MIN = 2
PREFIX_COVER = 0.8
SHORT_TOKENS = 3
CLOSED_TOKENS = 3
RESTART_MIN = 2
RESTART_WITHIN = 10
REPEAT_MIN = 3
REPEAT_WITHIN = 12
REPEAT_PARTIAL_MIN = 5
REPEAT_PARTIAL_COVER = 0.6
TRUNCATED_BY = 2
ABANDON_MIN = 3
ABANDON_COVER = 0.5
NEAR_UNITS = 4
BREAK_GAP_S = 0.3
_I_FORMS = {"i", "i'm", "i've", "i'll", "i'd"}

_TRAILING_CUT = ("...", "…", "-", "—", "–")
_CLAUSE_END = (",", ";", ":", ".", "!", "?")
_QUOTES = "\"'”’)]"


@dataclass
class Unit:
    """One sentence as spoken. words: the display words, in order. fillers: fillers in the delivery (None:
    count them in `words`); hesitations: long pauses inside it. clip: its source (None: one clip for all).
    breaks: word positions that follow a timing break. ref: the caller's handle."""
    words: list
    fillers: int | None = None
    hesitations: int = 0
    ref: object = None
    clip: object = None
    breaks: set = field(default_factory=set)


@dataclass
class Selection:
    kept: list                                  # unit indices, one per section, in narrative order
    drop: dict = field(default_factory=dict)    # kept unit index -> word indices to delete in it
    sections: list = field(default_factory=list)  # unit indices per section, cut order
    losers: list = field(default_factory=list)    # unit indices not kept (false starts, other takes, filler-only)
    abandoned: list = field(default_factory=list)  # unit indices whose opening was an abandoned retake (deleted)
    why: dict = field(default_factory=dict)        # unit index -> why it or part of it was cut


def _tokens(words, is_filler):
    """[(word index, token, ends a clause)] without fillers and empty tokens."""
    out = []
    for i, w in enumerate(words):
        t = norm(w)
        if t and not is_filler(t):
            out.append((i, t, w.rstrip(_QUOTES).endswith(_CLAUSE_END)))
    return out


def _common_prefix(a, b):
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def _said_again(span, rest):
    """How many tokens of `span` open `rest`; the span's last token may be cut off (a prefix of rest's)."""
    k = 0
    for t, tok in enumerate(span):
        if t >= len(rest):
            break
        if tok == rest[t] or (t == len(span) - 1 and tok and rest[t].startswith(tok)):
            k += 1
        else:
            break
    return k


def restart_cut(seq):
    """Index in seq where the unit restarts its whole opening, or 0 for none."""
    cut = 0
    for j in range(RESTART_MIN, min(len(seq) // 2, RESTART_WITHIN) + 1):
        if _said_again(seq[:j], seq[j:]) == j:
            cut = j
    return cut


def repeat_cuts(seq, ends):
    """[(i, j)]: for each restarted clause, delete seq[i:j] so the retake stays. Applied in order: each pair
    indexes the sequence left by the ones before it. ends[n]: token n ends at clause punctuation."""
    seq, ends, cuts = list(seq), list(ends), []
    while True:
        hit = None
        for i in range(len(seq) - REPEAT_MIN + 1):
            phrase = seq[i:i + REPEAT_MIN]
            for j in range(i + 1, min(len(seq) - REPEAT_MIN, i + REPEAT_WITHIN) + 1):
                if seq[j:j + REPEAT_MIN] != phrase:
                    continue
                span = j - i
                k = _said_again(seq[i:j], seq[j:])
                if k == span or (k >= REPEAT_PARTIAL_MIN and k >= REPEAT_PARTIAL_COVER * span and not ends[j - 1]):
                    hit = (i, j)
            if hit:
                break
        if not hit:
            return cuts
        cuts.append(hit)
        seq = seq[:hit[0]] + seq[hit[1]:]
        ends = ends[:hit[0]] + ends[hit[1]:]


def _clean(unit, is_filler):
    """(tokens left, word indices deleted, how it restarted: None, "restart" or "repeat")."""
    toks = _tokens(unit.words, is_filler)
    deleted, restarted = set(), None
    cut = restart_cut([t for _, t, _ in toks])
    if cut:
        deleted.update(range(toks[cut][0]))
        toks = toks[cut:]
        restarted = "restart"
    for i, j in repeat_cuts([t for _, t, _ in toks], [e for _, _, e in toks]):
        deleted.update(range(toks[i][0], toks[j][0]))
        toks = toks[:i] + toks[j:]
        restarted = restarted or "repeat"
    return toks, deleted, restarted


def _ending(unit):
    """"open" | "period" | "closed" (question or exclamation): how the unit ends as said."""
    last = unit.words[-1].rstrip(_QUOTES) if unit.words else ""
    if not last or last.endswith(_TRAILING_CUT):
        return "open"
    if last.endswith(("?", "!")):
        return "closed"
    if last.endswith("."):
        return "period"
    return "open"


def select(units, is_filler):
    """Pick one take per section. is_filler(token) -> bool on a normalized token."""
    n = len(units)
    cleaned = [_clean(u, is_filler) for u in units]
    why = {i: c[2] for i, c in enumerate(cleaned) if c[2]}

    abandoned = []
    for i in range(1, n):
        toks, deleted, restarted = cleaned[i]
        seq, prev = [t for _, t, _ in toks], [t for _, t, _ in cleaned[i - 1][0]]
        p = _common_prefix(seq, prev)
        if p >= ABANDON_MIN and p >= ABANDON_COVER * len(prev) and p < len(prev) and p < len(seq):
            pos = toks[p][0]
            word = units[i].words[pos].lstrip("\"'(“‘")
            if word[:1].isupper() and toks[p][1] not in _I_FORMS and pos in (units[i].breaks or ()):
                cleaned[i] = (toks[p:], deleted | set(range(pos)), restarted)
                abandoned.append(i)
                why[i] = "abandoned"
    seqs = [[t for _, t, _ in c[0]] for c in cleaned]
    ending = [_ending(u) for u in units]

    def prefix_rel(a, b):
        """a is the opening of b, and may be read as a cut-off take of it."""
        sa, sb = seqs[a], seqs[b]
        if len(sa) >= len(sb):
            return False
        p = _common_prefix(sa, sb)
        if not (p >= PREFIX_MIN and p >= PREFIX_COVER * len(sa)):
            return False
        if ending[a] == "closed":
            return False
        if ending[a] == "period" and len(sa) >= CLOSED_TOKENS and (b != a + 1 or p < len(sa)):
            return False
        return True

    def match(a, b):
        """How much units a and b are takes of one section: 0 when they are not."""
        sa, sb = seqs[a], seqs[b]
        if not sa or not sb:
            return 0.0
        sm = SequenceMatcher(None, sa, sb, autojunk=False)
        if any(op == "replace" for op, *_ in sm.get_opcodes()):
            return 0.0
        short, long_ = (a, b) if len(sa) <= len(sb) else (b, a)
        if _common_prefix(seqs[short], seqs[long_]) == len(seqs[short]) and len(seqs[short]) < len(seqs[long_]):
            # one opens the other: only the prefix relation can join them
            return max(sm.ratio(), SAME_RATIO) if prefix_rel(short, long_) else 0.0
        r = sm.ratio()
        return r if r >= SAME_RATIO else 0.0

    def near(i, t):
        same_clip = units[i].clip == units[t].clip
        return not same_clip or i - t <= NEAR_UNITS

    losers = set()
    false_start = {i for i in range(n - 1) if seqs[i] and prefix_rel(i, i + 1)}
    losers |= false_start
    for i in false_start:
        why[i] = "false-start"
    for i in range(n):
        if not seqs[i]:
            losers.add(i)
            why[i] = "filler-only"

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
            takes = [t for t in sections[s] if near(i, t)]
            score = max((match(t, i) for t in takes), default=0.0)
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
        if ending[i] == "open" and units[i].words and units[i].words[-1].rstrip(_QUOTES).endswith(_TRAILING_CUT):
            return True
        return any(len(seqs[t]) - len(seqs[i]) >= TRUNCATED_BY and prefix_rel(i, t) for t in section if t != i)

    kept = []
    for section in sections:
        top = max((not truncated(i, section), not cleaned[i][2]) for i in section)
        cands = [i for i in section if (not truncated(i, section), not cleaned[i][2]) == top]
        last = max(cands)
        same = [i for i in cands if seqs[i] == seqs[last]]
        best = min(same, key=lambda i: (flaws(i), -i))
        kept.append(best)
        for i in section:
            if i != best:
                losers.add(i)
                why[i] = "retake"
    return Selection(kept=kept, drop={i: cleaned[i][1] for i in kept if cleaned[i][1]},
                     sections=sections, losers=sorted(losers), abandoned=abandoned, why=why)
