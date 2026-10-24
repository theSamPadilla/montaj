"""Deterministic take selection over speech units (§558, cut).

The rules are the select-takes skill's (skills/select-takes/SKILL.md, steps 2 to 5), made mechanical, for a
PLAN the person reviews: only a sure retake is removed. Anything less sure stays kept and is offered as a
suggestion (`Selection.suggest`, a why ending in "?"), so the person can take it. A sentence that only LOOKS
like a retake (a list, a parallel clause, a refrain, a question and its answer) is never removed.

- A unit is one spoken sentence (the caller joins source lines a pause split). Its tokens are its words,
  normalized (lib/speech_lines.norm), with fillers left out. A unit carries its clip and the word positions
  that follow a timing break (a new source line, or a pause of BREAK_GAP_S or more).
- Closed: a unit that ends a question or an exclamation is complete as said, never a false start or a
  truncated take of a longer one. One that ends in a period, with CLOSED_TOKENS or more tokens, is the same
  unless the longer unit comes right after it and says all of it again. An ellipsis or a dash is not an ending.
- Prefix relation: unit a's tokens are the opening of b's (a common prefix of at least PREFIX_MIN tokens
  covering at least PREFIX_COVER of a), a shorter, and a not closed with respect to b.
- False start: a unit in the prefix relation with the NEXT unit is an abandoned attempt at it, dropped
  ("Start by..." then "Start by picking..."). A complete period sentence the next one says again and extends
  ("I built an app." then "I built an app that edits videos.") may be a build-up: kept, suggested
  (false-start?).
- Restart inside a unit: when the unit's whole opening of j tokens (j at least RESTART_MIN, within
  RESTART_WITHIN) is said again right after it, word for word ("Start by, start by picking..."), the words
  before the restart are deleted. "The more you edit, the more you learn" only starts the same way.
- Repeated phrase inside a unit (skill step 5): a phrase of REPEAT_MIN tokens said again within REPEAT_WITHIN
  tokens, where k tokens of the span seq[i:j] before it open seq[j:] (the span's last token may be cut off):
  (A) k is the whole span: a restarted clause, deleted ("and always on mode, and always on mode called
  Kyros"). (B) k is at least REPEAT_PARTIAL_MIN and REPEAT_PARTIAL_COVER of the span, with no clause
  punctuation and no joining word ("and", "then", "y", "et", ...) after the repeated part: only suggested
  (repeat?), never deleted, since parallel clauses have the same shape ("we want to make it easy, and we want
  to make it fast"). Accepted residual of (A): a clause said word for word twice in a row ("come on, come on";
  "never give up, never give up, never give up on your dream") is cut like a stutter, and listed.
- Abandoned opening: a unit that opens with at least ABANDON_MIN tokens of the unit before it (and at least
  ABANDON_COVER of that unit), then breaks off where a new sentence starts, is a truncated retake run into the
  next sentence ("Then drag it onto | Trim the start..."): the opening is deleted. "Where a new sentence
  starts" needs both a capitalized word (not "I") and a timing break before it; a capital alone may be a name.
- Same section: a retake differs from the take it redoes on one side only: words added, or words dropped,
  never both and never one replaced ("the price" against "the speed" are two sentences; "Some say you should
  post every day." against "You should not post every day." too). A question is never a take of a statement,
  nor an exclamation of a period sentence. Then the two are in the prefix relation, or have a token similarity
  (difflib ratio) of at least SAME_RATIO. Across clips at any distance. Within one clip, at most NEAR_UNITS
  units back, and with other kept sentences between them only as a BLOCK retake: the unit before pairs with the
  unit before the earlier take, or the unit after with the unit after (A B A' B' keeps A' B'). Otherwise the
  same sentence in two places of one clip ("Then click export." as step 2 and step 4) is two sentences. A short
  unit (under SHORT_TOKENS tokens) only joins the section of the unit right before it. The best match wins,
  the most recent section on a tie; anything else opens a new section.
- One take per section, by the skill's criteria in order: complete over truncated (truncated: ends in an
  ellipsis or dash, or is in the prefix relation with a take at least TRUNCATED_BY tokens longer), then no
  restart, then the last such take; fewer flaws (fillers plus hesitations, which the caller counts) decide only
  between takes that say the same words, so a later spoken correction wins. The other takes are removed only
  when sure: the same words, a truncated take, or a block retake. A reworded take ("I love this app." /
  "I really love this app.") stays kept where it was said and is suggested (retake?).
- Narrative order: a section with only sure losers sits at its first take; a kept take of a section with a
  suggested one stays where it was said.
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
# Words that join two parallel clauses: a partial repeat across one is a list, not a restart.
_JOINERS = {"and", "or", "but", "then", "so", "nor", "plus", "y", "e", "o", "u", "pero", "luego", "entonces", "et",
            "ou", "mais", "puis", "donc", "und", "oder", "aber", "dann", "mas", "depois", "ma", "poi"}

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
    # [(unit index, word indices it would delete or None for the whole unit, why ending in "?")]: an uncertain
    # cut, not made; the unit stays kept and the plan offers the cut for the person to take
    suggest: list = field(default_factory=list)


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
    """[(i, j, sure)]: for each restarted clause, seq[i:j] said before its retake. sure (rule A: the whole span
    said again) is deleted, applied in order: each pair indexes the sequence left by the sure cuts before it.
    An unsure one (rule B) is only a suggestion, found on the sequence the sure cuts leave, and deletes
    nothing. ends[n]: token n ends at clause punctuation."""
    seq, ends, cuts = list(seq), list(ends), []
    while True:
        hit = None
        for i in range(len(seq) - REPEAT_MIN + 1):
            phrase = seq[i:i + REPEAT_MIN]
            for j in range(i + 1, min(len(seq) - REPEAT_MIN, i + REPEAT_WITHIN) + 1):
                if seq[j:j + REPEAT_MIN] == phrase and _said_again(seq[i:j], seq[j:]) == j - i:
                    hit = (i, j)
            if hit:
                break
        if not hit:
            break
        cuts.append((hit[0], hit[1], True))
        seq = seq[:hit[0]] + seq[hit[1]:]
        ends = ends[:hit[0]] + ends[hit[1]:]
    for i in range(len(seq) - REPEAT_MIN + 1):
        phrase = seq[i:i + REPEAT_MIN]
        for j in range(i + 1, min(len(seq) - REPEAT_MIN, i + REPEAT_WITHIN) + 1):
            if seq[j:j + REPEAT_MIN] != phrase:
                continue
            span, k = j - i, _said_again(seq[i:j], seq[j:])
            if (k >= REPEAT_PARTIAL_MIN and k >= REPEAT_PARTIAL_COVER * span and not any(ends[i + k:j])
                    and not _JOINERS.intersection(seq[i + k:j])):
                cuts.append((i, j, False))
                return cuts
    return cuts


def _clean(unit, is_filler):
    """(tokens left, word indices deleted, how it restarted: None, "restart" or "repeat", suggestions
    [(word indices a suggestion would delete, why)])."""
    toks = _tokens(unit.words, is_filler)
    deleted, restarted, suggest = set(), None, []
    cut = restart_cut([t for _, t, _ in toks])
    if cut:
        deleted.update(range(toks[cut][0]))
        toks = toks[cut:]
        restarted = "restart"
    for i, j, sure in repeat_cuts([t for _, t, _ in toks], [e for _, _, e in toks]):
        span = set(range(toks[i][0], toks[j][0]))
        if not sure:
            suggest.append((span, "repeat?"))
            continue
        deleted |= span
        toks = toks[:i] + toks[j:]
        restarted = restarted or "repeat"
    return toks, deleted, restarted, suggest


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


def _question(unit):
    last = unit.words[-1].rstrip(_QUOTES) if unit.words else ""
    return last.endswith("?") or bool(unit.words and unit.words[0].startswith("¿"))


def select(units, is_filler):
    """Pick one take per section. is_filler(token) -> bool on a normalized token."""
    n = len(units)
    cleaned = [_clean(u, is_filler) for u in units]
    why = {i: c[2] for i, c in enumerate(cleaned) if c[2]}
    suggest = [(i, frozenset(span), w) for i, c in enumerate(cleaned) for span, w in c[3]]

    abandoned = []
    for i in range(1, n):
        toks, deleted, restarted, sugg = cleaned[i]
        seq, prev = [t for _, t, _ in toks], [t for _, t, _ in cleaned[i - 1][0]]
        p = _common_prefix(seq, prev)
        if p >= ABANDON_MIN and p >= ABANDON_COVER * len(prev) and p < len(prev) and p < len(seq):
            pos = toks[p][0]
            word = units[i].words[pos].lstrip("\"'(“‘")
            if word[:1].isupper() and toks[p][1] not in _I_FORMS and pos in (units[i].breaks or ()):
                cleaned[i] = (toks[p:], deleted | set(range(pos)), restarted, sugg)
                abandoned.append(i)
                why[i] = "abandoned"
    seqs = [[t for _, t, _ in c[0]] for c in cleaned]
    ending = [_ending(u) for u in units]
    question = [_question(u) for u in units]

    def prefix_rel(a, b, block=False):
        """a is the opening of b, and may be read as a cut-off take of it (in a block retake, at any
        distance and whatever its ending)."""
        sa, sb = seqs[a], seqs[b]
        if len(sa) >= len(sb):
            return False
        p = _common_prefix(sa, sb)
        if not (p >= PREFIX_MIN and p >= PREFIX_COVER * len(sa)):
            return False
        if block:
            return True
        if ending[a] == "closed":
            return False
        if ending[a] == "period" and len(sa) >= CLOSED_TOKENS and (b != a + 1 or p < len(sa)):
            return False
        return True

    unsure_start = set()      # a complete sentence the next one opens with: kept, suggested as a false start

    def match(a, b, block=False):
        """How much units a and b are takes of one section: 0 when they are not. A retake differs from the
        take it redoes on one side only: words added, or words dropped, never both and never replaced, and a
        question is never a take of a statement."""
        sa, sb = seqs[a], seqs[b]
        if not sa or not sb or a in unsure_start or b in unsure_start:
            return 0.0
        if (ending[a] == "closed") != (ending[b] == "closed") or question[a] != question[b]:
            return 0.0
        sm = SequenceMatcher(None, sa, sb, autojunk=False)
        ops = {op for op, *_ in sm.get_opcodes()}
        if "replace" in ops or {"insert", "delete"} <= ops:
            return 0.0
        short, long_ = (a, b) if len(sa) <= len(sb) else (b, a)
        if _common_prefix(seqs[short], seqs[long_]) == len(seqs[short]) and len(seqs[short]) < len(seqs[long_]):
            # one opens the other: only the prefix relation can join them
            return max(sm.ratio(), SAME_RATIO) if prefix_rel(short, long_, block) else 0.0
        r = sm.ratio()
        return r if r >= SAME_RATIO else 0.0

    losers = set()
    for i in range(n - 1):
        if seqs[i] and prefix_rel(i, i + 1):
            if ending[i] == "period" and len(seqs[i]) >= CLOSED_TOKENS:
                unsure_start.add(i)
                suggest.append((i, None, "false-start?"))
            else:
                losers.add(i)
                why[i] = "false-start"
    for i in range(n):
        if not seqs[i]:
            losers.add(i)
            why[i] = "filler-only"

    sections, section_of, by_block = [], {}, set()

    def reach(i, t):
        """(may i join t's section, through a block retake). Across clips at any distance; in one clip only
        within NEAR_UNITS, and with other kept sentences between them only as a block retake: the unit
        before i is a take of the unit before t, or the unit after i of the unit after t."""
        if units[i].clip != units[t].clip:
            return True, False
        if i - t > NEAR_UNITS:
            return False, False
        if not [x for x in range(t + 1, i) if x not in losers]:
            return True, False
        pb, pt = i - 1, t - 1
        if pt >= 0 and pb in section_of and pt in section_of and section_of[pb] == section_of[pt] and pb != pt:
            return True, True
        nb, nt = i + 1, t + 1
        if nb < n and nt < i and nb not in losers and match(nt, nb, block=True) > 0:
            return True, True
        return False, False

    prev = None
    for i in range(n):
        if i in losers:
            continue
        cands = range(len(sections))
        if len(seqs[i]) < SHORT_TOKENS:
            cands = [section_of[prev]] if prev is not None else []
        best, best_score, best_block = None, 0.0, False
        for s in cands:
            score, blk = 0.0, False
            for t in sections[s]:
                ok, via = reach(i, t)
                if ok:
                    m = match(t, i, block=via)
                    if m > score:
                        score, blk = m, via
            if score > 0 and (score > best_score or (score == best_score and best is not None
                                                      and sections[s][-1] > sections[best][-1])):
                best, best_score, best_block = s, score, blk
        if best is None:
            sections.append([i])
            section_of[i] = len(sections) - 1
        else:
            sections[best].append(i)
            section_of[i] = best
            if best_block:
                by_block.add(best)
        prev = i

    def flaws(i):
        u = units[i]
        fillers = u.fillers if u.fillers is not None else sum(1 for w in u.words if norm(w) and is_filler(norm(w)))
        return fillers + (u.hesitations or 0)

    def truncated(i, section, block):
        if ending[i] == "open" and units[i].words and units[i].words[-1].rstrip(_QUOTES).endswith(_TRAILING_CUT):
            return True
        return any(len(seqs[t]) - len(seqs[i]) >= TRUNCATED_BY and prefix_rel(i, t, block) for t in section if t != i)

    out = []        # (home index, output section, kept unit)
    for s_i, section in enumerate(sections):
        block = s_i in by_block
        top = max((not truncated(i, section, block), not cleaned[i][2]) for i in section)
        cands = [i for i in section if (not truncated(i, section, block), not cleaned[i][2]) == top]
        last = max(cands)
        same = [i for i in cands if seqs[i] == seqs[last]]
        best = min(same, key=lambda i: (flaws(i), -i))
        # Sure losers: the same words, a cut-off take, or a block retake. Any other take stays, suggested.
        sure = [i for i in section if i != best and (seqs[i] == seqs[best] or block or truncated(i, section, block))]
        unsure = [i for i in section if i != best and i not in sure]
        for i in sure:
            losers.add(i)
            why[i] = "retake"
        for i in unsure:
            suggest.append((i, None, "retake?"))
        if unsure:
            out.append((best, [best] + sure, best))
            out += [(i, [i], i) for i in unsure]
        else:
            out.append((section[0], section, best))
    out.sort(key=lambda o: o[0])
    kept = [k for _, _, k in out]
    suggest = sorted((s for s in suggest if s[0] in kept), key=lambda s: s[0])
    return Selection(kept=kept, drop={i: cleaned[i][1] for i in kept if cleaned[i][1]},
                     sections=[sec for _, sec, _ in out], losers=sorted(losers), abandoned=abandoned, why=why,
                     suggest=suggest)
