"""Deterministic take selection over speech units (§558, cut).

The select-takes skill's rules (skills/select-takes/SKILL.md, steps 2 to 5), made mechanical for a PLAN the
agent and the person review. The engine REMOVES only what is certain:
- the same words said again: a whole sentence said again word for word (REPEAT_MIN tokens or more), or a
  clause inside one said again word for word (rule A below);
- a cut-off take: one that broke off (no closing punctuation, an ellipsis or a dash) and that the next take
  says again in full.
Every other call is KEPT and offered as a suggestion (`Selection.suggest`, a why ending in "?") for the agent
to judge: a reworded take, a block told again with a change, an abandoned opening, a complete sentence the
next one extends, a short restart, a partial repeat, a line said again with a remark between.

- A unit is one spoken sentence (the caller joins source lines a pause split). Its tokens are its words,
  normalized (lib/speech_lines.norm), with fillers left out. A unit carries its clip, the word positions that
  follow a timing break, and `fixed` (a clip kept whole, b-roll: never a take, a loser or a suggestion).
- False start: a unit whose tokens open the next unit's (a common prefix of at least PREFIX_MIN tokens
  covering PREFIX_COVER of it). Removed when it broke off; when it ends in a period it is kept and suggested
  (false-start?): "Hold on." / "Hold on to your seat.". Never a question or an exclamation.
- Restart inside a unit: the unit's whole opening said again right after it, word for word (its last word may
  be cut off). Removed for an opening of REPEAT_MIN tokens or more, or a shorter one that broke off ("Start
  by... start by picking"); a shorter one is suggested (restart?), since "New York, New York" and "tick tock,
  tick tock" have its shape. Numbers said twice ("five five five") are a number, never a restart.
- Repeated phrase inside a unit (skill step 5): (A) a span of REPEAT_MIN tokens or more, not only numbers,
  said again word for word: removed ("and always on mode, and always on mode called Kyros"; accepted residual,
  a clause chanted word for word). (B) part of the span said again (REPEAT_PARTIAL_MIN tokens and
  REPEAT_PARTIAL_COVER of it, no clause punctuation and no joining word after the repeated part): suggested
  (repeat?), since parallel clauses have that shape.
- Abandoned opening: a unit opening with ABANDON_MIN+ tokens of the unit before it that breaks off where a
  capitalized word follows a timing break: suggested (abandoned?): the word may be a name or a German noun.
- Same section: a retake differs from the take it redoes on one side only (words added, or dropped, never
  both, never one replaced, never a negation), a question is never a take of a statement, and then they are
  in the prefix relation or have a token similarity (difflib ratio) of SAME_RATIO or more. Units are counted
  in track order across clip boundaries: at most NEAR_UNITS back, and with other kept sentences between only
  as a BLOCK retake (the unit before pairs with the unit before, or the unit after with the unit after).
- What goes: an earlier take of a section is removed when it says the same words (REPEAT_MIN tokens or more)
  or broke off and is said again in full; a block's earlier takes only when every pair of the block would go
  on its own. Any other take stays where it was said and is suggested (retake?), as are: a matching take out
  of reach because a remark sits between, a neighbour reworded in REWORD_SWAPS places or fewer (ratio
  REWORD_RATIO), and the next line of a block that only grew (ratio GROWN_RATIO).
- Which take is kept: complete over truncated, then no restart, then the last; fewer flaws (fillers plus
  hesitations) decide only between takes that say the same words. Narrative order: a section whose earlier
  takes all go sits at its first take; a section with a suggested take keeps every take where it was said.
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
REWORD_RATIO = 0.75         # a line reworded in one or two places, said again right after: suggested
REWORD_SWAPS = 2
GROWN_RATIO = 0.6           # the next line of a block retake that only grew: suggested
_I_FORMS = {"i", "i'm", "i've", "i'll", "i'd"}
# A negation added or dropped makes another sentence, never a retake ("Not this one." / "This one.").
_NEGATIONS = {"not", "no", "never", "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "won't", "can't",
              "nunca", "nada", "pas", "ne", "jamais", "nicht", "kein", "keine", "nie", "não", "nem", "non", "mai"}
# Number words: a number said twice ("five five five") is a number, not a restart.
_NUMBER_WORDS = {
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty",
    "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand", "million", "oh",
    "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "cien", "mil",
    "un", "deux", "trois", "quatre", "cinq", "sept", "huit", "neuf", "dix", "cent", "mille",
    "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "hundert", "tausend",
    "um", "dois", "três", "quatro", "seis", "sete", "oito", "nove", "dez", "cem"}
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
    fixed: bool = False      # never a take, a loser or a suggestion (a clip kept whole: b-roll); still a sentence between


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


def _numbers_only(span):
    """A span of numbers ("five five five", "twenty twenty"): said twice it is a number, not a restart."""
    return bool(span) and all(t.isdigit() or t in _NUMBER_WORDS for t in span)


def restart_cut(seq, cutoff=None):
    """Index in seq where the unit restarts its whole opening word for word (the last may be cut off), or 0 for
    none. A sure cut: an opening of REPEAT_MIN tokens or more, or a shorter one broken off (cutoff[j - 1]: the
    word before the restart ends in an ellipsis or a dash, "Start by... start by picking")."""
    cut = 0
    for j in range(RESTART_MIN, min(len(seq) // 2, RESTART_WITHIN) + 1):
        if _said_again(seq[:j], seq[j:]) == j and not _numbers_only(seq[:j]) and (
                j >= REPEAT_MIN or (cutoff is not None and cutoff[j - 1])):
            cut = j
    return cut


def restart_hint(seq):
    """Index of a restart of a shorter opening (RESTART_MIN tokens up to REPEAT_MIN), or 0: only a suggestion,
    since "New York, New York" and "tick tock, tick tock" have the same shape."""
    cut = 0
    for j in range(RESTART_MIN, min(REPEAT_MIN, len(seq) // 2 + 1)):
        if _said_again(seq[:j], seq[j:]) == j and not _numbers_only(seq[:j]):
            cut = j
    return cut


def repeat_cuts(seq, ends):
    """[(i, j, sure)]: for each restarted clause, seq[i:j] said before its retake. sure (rule A: the whole span,
    REPEAT_MIN tokens or more and not only numbers, said again word for word) is deleted, applied in order: each
    pair indexes the sequence left by the sure cuts before it. An unsure one (rule B) is only a suggestion, found
    on the sequence the sure cuts leave, and deletes nothing. ends[n]: token n ends at clause punctuation."""
    seq, ends, cuts = list(seq), list(ends), []
    while True:
        hit = None
        for i in range(len(seq) - REPEAT_MIN + 1):
            phrase = seq[i:i + REPEAT_MIN]
            for j in range(i + REPEAT_MIN, min(len(seq) - REPEAT_MIN, i + REPEAT_WITHIN) + 1):
                if (seq[j:j + REPEAT_MIN] == phrase and _said_again(seq[i:j], seq[j:]) == j - i
                        and not _numbers_only(seq[i:j])):
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
    seq = [t for _, t, _ in toks]
    cutoff = [unit.words[k].rstrip(_QUOTES).endswith(_TRAILING_CUT) for k, _, _ in toks]
    cut = restart_cut(seq, cutoff)
    if cut:
        deleted.update(range(toks[cut][0]))
        toks = toks[cut:]
        restarted = "restart"
    else:
        hint = restart_hint(seq)
        if hint:
            suggest.append((set(range(toks[hint][0])), "restart?"))
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
    """"open" | "period" | "closed" (question or exclamation): how the unit ends as said. An ellipsis, a dash, a
    comma or no punctuation at all is open: the take broke off."""
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
    """Pick one take per section. is_filler(token) -> bool on a normalized token. Removes only what is sure
    (see the module docstring); every other call is a suggestion."""
    n = len(units)
    fixed = [bool(getattr(u, "fixed", False)) for u in units]
    cleaned = [_clean(u, is_filler) if not fixed[i] else ([(k, norm(w), False) for k, w in enumerate(u.words)
                                                            if norm(w)], set(), None, [])
               for i, u in enumerate(units)]
    why = {i: c[2] for i, c in enumerate(cleaned) if c[2]}
    suggest = [(i, frozenset(span), w) for i, c in enumerate(cleaned) for span, w in c[3]]

    for i in range(1, n):
        if fixed[i] or fixed[i - 1]:
            continue
        toks = cleaned[i][0]
        seq, prev = [t for _, t, _ in toks], [t for _, t, _ in cleaned[i - 1][0]]
        p = _common_prefix(seq, prev)
        if p >= ABANDON_MIN and p >= ABANDON_COVER * len(prev) and p < len(prev) and p < len(seq):
            pos = toks[p][0]
            word = units[i].words[pos].lstrip("\"'(“‘")
            if word[:1].isupper() and toks[p][1] not in _I_FORMS and pos in (units[i].breaks or ()):
                suggest.append((i, frozenset(range(pos)), "abandoned?"))
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
        take it redoes on one side only: words added, or words dropped, never both, never one replaced and never
        a negation; and a question is never a take of a statement."""
        sa, sb = seqs[a], seqs[b]
        if not sa or not sb or fixed[a] or fixed[b] or a in unsure_start or b in unsure_start:
            return 0.0
        if (ending[a] == "closed") != (ending[b] == "closed") or question[a] != question[b]:
            return 0.0
        sm = SequenceMatcher(None, sa, sb, autojunk=False)
        codes = sm.get_opcodes()
        ops = {op for op, *_ in codes}
        if "replace" in ops or {"insert", "delete"} <= ops:
            return 0.0
        changed = {t for op, i1, i2, j1, j2 in codes if op != "equal" for t in sa[i1:i2] + sb[j1:j2]}
        if changed & _NEGATIONS:
            return 0.0
        short, long_ = (a, b) if len(sa) <= len(sb) else (b, a)
        if _common_prefix(seqs[short], seqs[long_]) == len(seqs[short]) and len(seqs[short]) < len(seqs[long_]):
            # one opens the other: only the prefix relation can join them
            return max(sm.ratio(), SAME_RATIO) if prefix_rel(short, long_, block) else 0.0
        r = sm.ratio()
        return r if r >= SAME_RATIO else 0.0

    losers = set()
    for i in range(n - 1):
        if fixed[i] or fixed[i + 1] or not seqs[i] or not prefix_rel(i, i + 1):
            continue
        if ending[i] == "open":
            losers.add(i)              # a take broken off and said again in full: sure
            why[i] = "false-start"
        else:
            unsure_start.add(i)        # a complete sentence the next one extends: maybe a build-up
            suggest.append((i, None, "false-start?"))
    for i in range(n):
        if not seqs[i] and not fixed[i]:
            losers.add(i)
            why[i] = "filler-only"

    sections, section_of, joins, near_misses = [], {}, {}, []

    def reach(i, t):
        """(may i join t's section, through a block retake). Units are counted in track order across clip
        boundaries: at most NEAR_UNITS back, and with other kept sentences between them only as a block retake
        (the unit before i is a take of the unit before t, or the unit after i of the unit after t)."""
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
        if fixed[i]:
            sections.append([i])
            section_of[i] = len(sections) - 1
            continue
        cands = range(len(sections))
        if len(seqs[i]) < SHORT_TOKENS:
            cands = [section_of[prev]] if prev is not None else []
        best, best_score, best_t, best_block = None, 0.0, None, False
        for s in cands:
            for t in sections[s]:
                ok, via = reach(i, t)
                m = match(t, i, block=via) if ok else 0.0
                if not ok and i - t <= NEAR_UNITS and match(t, i, block=True) > 0:
                    near_misses.append((t, i))      # a take with a remark between: only suggested
                if m > 0 and (m > best_score or (m == best_score and best is not None
                                                 and sections[s][-1] > sections[best][-1])):
                    best, best_score, best_t, best_block = s, m, t, via
        if best is None:
            sections.append([i])
            section_of[i] = len(sections) - 1
        else:
            sections[best].append(i)
            section_of[i] = best
            joins[i] = (best_t, best_block)
        prev = i

    def flaws(i):
        u = units[i]
        fillers = u.fillers if u.fillers is not None else sum(1 for w in u.words if norm(w) and is_filler(norm(w)))
        return fillers + (u.hesitations or 0)

    def truncated(i, section, block=False):
        if ending[i] == "open" and units[i].words and units[i].words[-1].rstrip(_QUOTES).endswith(_TRAILING_CUT):
            return True
        return any(len(seqs[t]) - len(seqs[i]) >= TRUNCATED_BY and prefix_rel(i, t, block) for t in section if t != i)

    def sure_pair(a, b):
        """a, an earlier take of b's line, may go for sure: the same words (REPEAT_MIN tokens or more), or a take
        that broke off (open ending) and b says all of it again."""
        if seqs[a] == seqs[b]:
            return len(seqs[a]) >= REPEAT_MIN
        return ending[a] == "open" and prefix_rel(a, b, block=True)

    # A block retake goes only when every pair of the block would go on its own.
    unsure_block = set()
    for i, (t, via) in joins.items():
        if not via:
            continue
        pairs, k = [(t, i)], 1
        while t - k >= 0 and i - k > t and section_of.get(t - k) is not None and section_of.get(t - k) == section_of.get(i - k):
            pairs.append((t - k, i - k))
            k += 1
        k = 1
        while t + k < i - 0 and i + k < n and section_of.get(t + k) is not None and section_of.get(t + k) == section_of.get(i + k):
            pairs.append((t + k, i + k))
            k += 1
        if not all(sure_pair(a, b) for a, b in pairs):
            unsure_block.update(a for a, _ in pairs)

    out = []        # (home index, output section, kept unit)
    for s_i, section in enumerate(sections):
        if len(section) == 1:
            out.append((section[0], section, section[0]))
            continue
        top = max((not truncated(i, section), not cleaned[i][2]) for i in section)
        cands = [i for i in section if (not truncated(i, section), not cleaned[i][2]) == top]
        last = max(cands)
        same = [i for i in cands if seqs[i] == seqs[last]]
        best = min(same, key=lambda i: (flaws(i), -i))
        sure = [i for i in section if i != best and i not in unsure_block
                and (sure_pair(i, best) or (ending[i] == "open" and truncated(i, section)))]
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
    kept_set = set(kept)

    def offer(i, why_):
        if i in kept_set and not fixed[i] and not any(s[0] == i and s[1] is None for s in suggest):
            suggest.append((i, None, why_))

    for t, i in near_misses:
        if section_of.get(t) != section_of.get(i):
            offer(t, "retake?")
    # a line reworded in one or two places, said again right after: maybe a retake
    for t in range(n - 1):
        i = t + 1
        if t in losers or i in losers or fixed[t] or fixed[i] or section_of.get(t) == section_of.get(i):
            continue
        if not seqs[t] or not seqs[i] or question[t] != question[i] or (ending[t] == "closed") != (ending[i] == "closed"):
            continue
        sm = SequenceMatcher(None, seqs[t], seqs[i], autojunk=False)
        codes = sm.get_opcodes()
        swaps = [c for c in codes if c[0] == "replace"]
        changed = {x for op, a1, a2, b1, b2 in codes if op != "equal" for x in seqs[t][a1:a2] + seqs[i][b1:b2]}
        if (sm.ratio() >= REWORD_RATIO and swaps and len(swaps) <= REWORD_SWAPS
                and all(c[0] in ("equal", "replace") for c in codes) and not changed & _NEGATIONS):
            offer(t, "retake?")
    # a block whose next line grew: after a matched pair, the pair after it at a lower bar
    pairs = [(t, i) for i, (t, _) in joins.items()] + near_misses
    for t, i in pairs:
        nt, nb = t + 1, i + 1
        if nt >= i or nb >= n or nt in losers or nb in losers or section_of.get(nt) == section_of.get(nb):
            continue
        if not seqs[nt] or not seqs[nb]:
            continue
        sm = SequenceMatcher(None, seqs[nt], seqs[nb], autojunk=False)
        if {op for op, *_ in sm.get_opcodes()} <= {"equal", "insert"} and sm.ratio() >= GROWN_RATIO:
            offer(nt, "retake?")

    seen, uniq = set(), []
    for s in sorted((s for s in suggest if s[0] in kept_set and not fixed[s[0]]), key=lambda s: s[0]):
        key = (s[0], s[1], s[2])
        if key not in seen:
            seen.add(key)
            uniq.append(s)
    return Selection(kept=kept, drop={i: cleaned[i][1] for i in kept if cleaned[i][1]},
                     sections=[sec for _, sec, _ in out], losers=sorted(losers), abandoned=[], why=why,
                     suggest=uniq)
