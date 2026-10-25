"""Deterministic take selection over speech units (§558, cut).

The select-takes skill's rules (skills/select-takes/SKILL.md, steps 2 to 5), made mechanical for a PLAN the
agent and the person review. The engine REMOVES only what is certain:
- the same words said again: a whole sentence said again word for word (REPEAT_MIN tokens or more), or a
  clause inside one said again word for word after a break signal (an ellipsis or a dash before the second
  saying, a cut-off word, or a pause of BREAK_GAP_S or more): rule A and the restart below. With no signal it
  may be a chant or an emphasis ("one more song, one more song"; "I love it, I love it so much"): suggested;
- a cut-off take: one that broke off (no closing punctuation, an ellipsis or a dash) whose every word the
  next take says again, in order (its last word may be a cut-off fragment: bare, with no comma or period after
  it, and FRAGMENT_MAX letters at most, "cl" before "clip"; "art" before "artist" or "Dan" before "Daniel" is a
  whole word). "Tokyo..." then "Kyoto" is offered; so is a broken-off take the next one rewords (false-start?).
Every other call is KEPT and offered as a suggestion (`Selection.suggest`, a why ending in "?") for the agent
to judge: a reworded take, a block told again with a change, an abandoned opening, a complete sentence the
next one extends, a short restart, a partial repeat, a line said again with a remark between.

- A unit is one spoken sentence (the caller joins source lines a pause split). Its tokens are its words,
  normalized (lib/speech_lines.norm), with fillers left out. A unit carries its clip, the word positions that
  follow a measured pause, `fixed` (a clip kept whole, b-roll: never a take, a loser or a suggestion) and
  `sparse` (a clip with little speech, whose words may be made up: its takes are never removed, only offered).
- False start: a unit whose tokens open the next unit's (a common prefix of at least PREFIX_MIN tokens
  covering PREFIX_COVER of it). Removed when it broke off; when it ends in a period it is kept and suggested
  (false-start?): "Hold on." / "Hold on to your seat.". Never a question or an exclamation.
- Restart inside a unit: the unit's whole opening said again right after it, word for word (its last word may
  be a fragment). Removed after a break signal ("Start by... start by picking"; "Click the — click the";
  "You can drag the cl you can drag the clip"; a pause), and again for a third saying; with none, suggested:
  restart? for an opening shorter than REPEAT_MIN ("tick tock, tick tock"), repeat? for a longer one. A short
  opening said again after only a pause, starting with a capital, is a name ("New York, | New York"): offered.
  Numbers said twice are a number, never one.
- Repeated phrase inside a unit (skill step 5): (A) a span of REPEAT_MIN tokens or more, not only numbers,
  said again word for word: removed after a break signal, otherwise suggested (repeat?). (B) part of the span said again (REPEAT_PARTIAL_MIN tokens and
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
  or broke off and is said again in full; a block's earlier takes only when every pair of the block, the
  pair it was found by included, would go on its own. A longer take that broke off and a shorter one said
  whole after it are offered (retake?). Any other take stays where it was said and is suggested (retake?), as are: a matching take out
  of reach because a remark sits between, a neighbour reworded in REWORD_SWAPS places or fewer (ratio
  REWORD_RATIO), and the next line of a block that only grew (ratio GROWN_RATIO).
- A unit the caller marks `madeup` (the last line of a clip, words whisper made up over a quiet end) goes as
  a pause.
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
# A bare word of at most FRAGMENT_MAX letters that begins the next word is a cut-off fragment ("cl" / "clip"); a
# longer one is a whole word ("Dan" / "Daniel", "car" / "cart"). 172 real transcripts hold no cut-off fragment
# before a restart at all (every real restart repeats its words exactly).
FRAGMENT_MAX = 2
REWORD_RATIO = 0.7         # a line reworded in one or two places, said again right after: suggested
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
    sparse: bool = False     # never removed as a take, only offered (the caller's call: a clip it doubts)
    madeup: bool = False     # words whisper made up over a quiet end (the caller measures it): removed as a pause


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


def _said_again(span, rest, frag_ok=True):
    """How many tokens of `span` open `rest`. With frag_ok the span's last token may be cut off (a prefix of
    rest's): only a bare word, with no punctuation after it, can be a fragment ("cl" before "clip"); "art,"
    before "artist" is a whole word."""
    k = 0
    for t, tok in enumerate(span):
        if t >= len(rest):
            break
        if tok == rest[t] or (frag_ok and t == len(span) - 1 and tok and rest[t].startswith(tok)):
            k += 1
        else:
            break
    return k


def _numbers_only(span):
    """A span of numbers ("five five five", "twenty twenty"): said twice it is a number, not a restart."""
    return bool(span) and all(t.isdigit() or t in _NUMBER_WORDS for t in span)


def _signal(seq, i, j, cutoff, breaks, bare):
    """What marks the second saying of seq[i:j] (at j) as a retake: "mark" (an ellipsis or a dash before it,
    written on the word or as its own), "fragment" (the span's last word is a bare cut-off of the retake's, short
    against it), "pause" (a timing break of BREAK_GAP_S or more), or None."""
    span = j - i
    if cutoff is not None and cutoff[j - 1]:
        return "mark"
    if j + span - 1 < len(seq) and seq[j - 1] != seq[j + span - 1]:
        if (bare is None or bare[j - 1]) and len(seq[j - 1]) <= FRAGMENT_MAX:
            return "fragment"
    if breaks is not None and breaks[j]:
        return "pause"
    return None


def _signalled(seq, i, j, cutoff, breaks, bare=None):
    return _signal(seq, i, j, cutoff, breaks, bare) is not None


def _frag_ok(seq, n, bare):
    """Token n may be a cut-off fragment: bare (no comma or period after it) and at most FRAGMENT_MAX letters."""
    return (bare is None or bare[n]) and len(seq[n]) <= FRAGMENT_MAX


def restart_at(seq, cutoff=None, breaks=None, bare=None):
    """(j, signal): the last j where the unit says its whole opening seq[:j] again right after it, word for word
    (its last word may be a short bare fragment), and the break signal that marks it (None for none); (0, None)
    when there is no restart. A restart whose last word is a longer word that only begins the next one ("the
    car | the cart") is found with no signal: only a suggestion. Numbers said twice are a number, not a restart."""
    found = (0, None)
    for j in range(RESTART_MIN, min(len(seq) // 2, RESTART_WITHIN) + 1):
        if _numbers_only(seq[:j]):
            continue
        if _said_again(seq[:j], seq[j:], _frag_ok(seq, j - 1, bare)) == j:
            found = (j, _signal(seq, 0, j, cutoff, breaks, bare))
        elif (bare is None or bare[j - 1]) and _said_again(seq[:j], seq[j:], True) == j:
            found = (j, None)
    return found


def restart_cut(seq, cutoff=None, breaks=None, bare=None):
    """Index where the unit restarts its opening, for sure (a break signal marks it), or 0."""
    j, sig = restart_at(seq, cutoff, breaks, bare)
    return j if sig else 0


def restart_hint(seq, cutoff=None, breaks=None, bare=None):
    """Index of a restart with no break signal, or 0: only a suggestion ("New York, New York"; "I love it, I
    love it so much")."""
    j, sig = restart_at(seq, cutoff, breaks, bare)
    return j if j and not sig else 0


def repeat_cuts(seq, ends, cutoff=None, breaks=None, bare=None):
    """[(i, j, sure)]: each clause seq[i:j] said before its retake at j. sure (rule A: the whole span, REPEAT_MIN
    tokens or more and not only numbers, said again word for word, after a break signal) is deleted, applied in
    order: each pair indexes the sequence left by the sure cuts before it. An unsure one (rule A with no break
    signal, a chant or an emphasis; or rule B, part of the span said again) is only a suggestion, indexed in the
    sequence the sure cuts leave, and deletes nothing. ends / cutoff / breaks / bare: per token, it ends at clause
    punctuation / is marked cut off / follows a timing break / has no punctuation after it."""
    seq, ends = list(seq), list(ends)
    cutoff = list(cutoff) if cutoff is not None else [False] * len(seq)
    breaks = list(breaks) if breaks is not None else [False] * len(seq)
    bare = list(bare) if bare is not None else [True] * len(seq)
    cuts, unsure_a = [], []
    while True:
        hit = None
        for i in range(len(seq) - REPEAT_MIN + 1):
            phrase = seq[i:i + REPEAT_MIN]
            best = None
            for j in range(i + REPEAT_MIN, min(len(seq) - REPEAT_MIN, i + REPEAT_WITHIN) + 1):
                if (seq[j:j + REPEAT_MIN] == phrase and _said_again(seq[i:j], seq[j:], _frag_ok(seq, j - 1, bare)) == j - i
                        and not _numbers_only(seq[i:j])):
                    best = j
            if best is None:
                continue
            if _signalled(seq, i, best, cutoff, breaks, bare):
                hit = (i, best)
                break
            if (i, best) not in unsure_a:
                unsure_a.append((i, best))
        if not hit:
            break
        cuts.append((hit[0], hit[1], True))
        a, b = hit
        seq, ends = seq[:a] + seq[b:], ends[:a] + ends[b:]
        cutoff, breaks, bare = cutoff[:a] + cutoff[b:], breaks[:a] + breaks[b:], bare[:a] + bare[b:]
        unsure_a = []
    if unsure_a:
        cuts += [(i, j, False) for i, j in unsure_a[:1]]
        return cuts
    for i in range(len(seq) - REPEAT_MIN + 1):
        phrase = seq[i:i + REPEAT_MIN]
        for j in range(i + 1, min(len(seq) - REPEAT_MIN, i + REPEAT_WITHIN) + 1):
            if seq[j:j + REPEAT_MIN] != phrase:
                continue
            span, k = j - i, _said_again(seq[i:j], seq[j:], _frag_ok(seq, j - 1, bare))
            if (k >= REPEAT_PARTIAL_MIN and k >= REPEAT_PARTIAL_COVER * span and not any(ends[i + k:j])
                    and not _JOINERS.intersection(seq[i + k:j])):
                cuts.append((i, j, False))
                return cuts
    return cuts


def _flags(unit, toks):
    """Per token: (cut off: an ellipsis or a dash ends the word or stands as the next word; follows a timing
    break; bare: no comma or period after the word, so it may be a fragment)."""
    words, brk = unit.words, unit.breaks or ()
    cutoff, breaks, bare = [], [], []
    for n, (k, _, _) in enumerate(toks):
        w = words[k].rstrip(_QUOTES)
        nxt = toks[n + 1][0] if n + 1 < len(toks) else len(words)
        marks = [words[x].strip() for x in range(k + 1, nxt)]
        cutoff.append(w.endswith(_TRAILING_CUT) or any(m and not norm(m) and m.strip(_QUOTES).endswith(_TRAILING_CUT)
                                                       for m in marks))
        breaks.append(k in brk)
        bare.append(not w.endswith(_CLAUSE_END))     # "cl" and "cl-" may be fragments; "art," never
    return cutoff, breaks, bare


def _clean(unit, is_filler):
    """(tokens left, word indices deleted, how it restarted: None, "restart" or "repeat", suggestions
    [(word indices a suggestion would delete, why)])."""
    toks = _tokens(unit.words, is_filler)
    deleted, restarted, suggest = set(), None, []
    while True:
        seq = [t for _, t, _ in toks]
        cutoff, breaks, bare = _flags(unit, toks)
        j, sig = restart_at(seq, cutoff, breaks, bare)
        if j and sig == "pause" and j < REPEAT_MIN:
            word = unit.words[toks[j][0]].lstrip("\"'(“‘¿¡")
            if word[:1].isupper() and toks[j][1] not in _I_FORMS:
                sig = None      # a name said twice after a pause ("New York, | New York"): only offered
        if not j and restarted and len(seq) > 1 and seq[0] == seq[1] and (cutoff[0] or breaks[1]):
            j, sig = 1, "pause"     # what a longer restart leaves: "we, | we did it" after "we, | we, | we,"
        if j and sig:
            deleted.update(range(toks[0][0], toks[j][0]))
            toks = toks[j:]
            restarted = "restart"
            continue            # a third saying: "he ran, | he ran, | he ran as fast"
        if j:
            suggest.append((set(range(toks[0][0], toks[j][0])), "restart?" if j < REPEAT_MIN else "repeat?"))
        break
    cutoff, breaks, bare = _flags(unit, toks)
    for i, j, sure in repeat_cuts([t for _, t, _ in toks], [e for _, _, e in toks], cutoff, breaks, bare):
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
    sparse = [bool(getattr(u, "sparse", False)) for u in units]

    def last_bare(a):
        """a's last word may be a cut-off fragment: no comma or period after it, at most FRAGMENT_MAX letters."""
        w = units[a].words[cleaned[a][0][-1][0]].rstrip(_QUOTES) if cleaned[a][0] else ""
        return not w.endswith(_CLAUSE_END) and len(seqs[a][-1]) <= FRAGMENT_MAX

    def said_in_full(a, b):
        """b says every word of a again, in order, from its start (a's last word may be a bare fragment)."""
        return len(seqs[a]) < len(seqs[b]) and _said_again(seqs[a], seqs[b], last_bare(a)) == len(seqs[a])

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
        if short > long_ and ending[long_] == "open":
            # a longer take that broke off, then a shorter one said whole: a retake, never a sure one
            return max(sm.ratio(), SAME_RATIO)
        if _common_prefix(seqs[short], seqs[long_]) == len(seqs[short]) and len(seqs[short]) < len(seqs[long_]):
            # one opens the other: only the prefix relation can join them
            return max(sm.ratio(), SAME_RATIO) if prefix_rel(short, long_, block) else 0.0
        r = sm.ratio()
        return r if r >= SAME_RATIO else 0.0

    losers = set()
    for i in range(n - 1):
        if fixed[i] or fixed[i + 1] or not seqs[i] or not prefix_rel(i, i + 1):
            continue
        if ending[i] == "open" and said_in_full(i, i + 1) and not (sparse[i] or sparse[i + 1]):
            losers.add(i)              # a take broken off and said again in full: sure
            why[i] = "false-start"
        else:
            unsure_start.add(i)        # a complete sentence the next one extends: maybe a build-up
            suggest.append((i, None, "false-start?"))
    for i in range(n):
        if not seqs[i] and not fixed[i]:
            losers.add(i)
            why[i] = "filler-only"
        elif getattr(units[i], "madeup", False) and not fixed[i]:
            losers.add(i)              # words whisper made up over a quiet end: a pause
            why[i] = "pause"

    sections, section_of, joins, near_misses, block_pairs = [], {}, {}, [], {}

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
            block_pairs[i] = (nt, nb)     # the pair this block rests on: it must go for sure too
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
        that broke off (open ending) whose every word b says again, in order. Never a unit from a clip with little
        speech (its words may be made up)."""
        if sparse[a] or sparse[b]:
            return False
        if seqs[a] == seqs[b]:
            return len(seqs[a]) >= REPEAT_MIN
        return ending[a] == "open" and said_in_full(a, b)

    # A block retake goes only when every pair of the block would go on its own.
    unsure_block = set()
    for i, (t, via) in joins.items():
        if not via:
            continue
        pairs, k = [(t, i)] + ([block_pairs[i]] if i in block_pairs else []), 1
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
        sure = [i for i in section if i != best and i not in unsure_block and sure_pair(i, best)]
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
    # a take that broke off, then reworded: the next one opens close to it
    for t in range(n - 1):
        i = t + 1
        if ending[t] != "open" or t in losers or i in losers or fixed[t] or fixed[i] or not seqs[t] or not seqs[i]:
            continue
        if section_of.get(t) == section_of.get(i):
            continue
        if SequenceMatcher(None, seqs[t], seqs[i][:len(seqs[t])], autojunk=False).ratio() >= REWORD_RATIO:
            offer(t, "false-start?")
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


# ── phrase retakes: the same words said again across whisper's line breaks (§558 field test) ──────────────
#
# Whisper breaks lines at pauses, not at retakes, so on real speech the same phrase is said two or three times in a
# row inside one line or across lines, where select (whole units) finds nothing sure. phrase_retakes runs after
# select, on the words it keeps, in play order across units and clips:
# - an EXACT run of PHRASE_MIN tokens or more (case and punctuation normalised, fillers left out) said again is a
#   sure retake: the earlier saying goes, word for word, and the last is kept (a third saying: only the last stays).
#   Never when a sentence ends between the two sayings ("The best part is the price. The best part is the speed."
#   are two lines built alike: offered). Within one clip the second saying starts at most PHRASE_WITHIN_S of source time after the first ends. Across
#   clips there is no window, but nothing kept may stand between the two (re-recorded takes sit at a clip's end and
#   the next clip's start, or with only removed speech between): a hook repeated as a closing callback is offered.
#   A false start's leftover, at most PHRASE_TAIL_MAX tokens between the earlier saying and the next with no
#   sentence end ("the main thing you need | here | the main thing you need is"), goes with it.
# - a shorter exact repeat (PHRASE_HINT_MIN tokens or more) that restarts within PHRASE_RESTART_GAP tokens, or a
#   near repeat (PHRASE_MIN tokens or more in common, PHRASE_NEAR_SWAPS tokens or fewer differing on each side) is
#   only offered (repeat?, retake? for a whole unit), never removed.
PHRASE_MIN = 5
PHRASE_WITHIN_S = 10.0
PHRASE_HINT_WITHIN_S = 30.0
PHRASE_HINT_MIN = 3
PHRASE_RESTART_GAP = 6
PHRASE_TAIL_MAX = 2
PHRASE_NEAR_SWAPS = 2
PHRASE_NEAR_SPAN = 14
_SENTENCE_END = (".", "!", "?")


def _phrase_seq(units, sel, is_filler, times):
    """[(token, unit, word position, start, end, clip, sentence end)] of the words the selection keeps, in play
    order. A unit kept whole (b-roll) or made up takes no part."""
    out = []
    for ui in sel.kept:
        u = units[ui]
        if getattr(u, "fixed", False) or getattr(u, "madeup", False):
            continue
        gone = sel.drop.get(ui, set())
        for k, w in enumerate(u.words):
            t = norm(w)
            if k in gone or not t or is_filler(t):
                continue
            s, e = times[ui][k] if times is not None else (0.0, 0.0)
            out.append((t, ui, k, s, e, u.clip, w.rstrip(_QUOTES).endswith(_SENTENCE_END)))
    return out


def _run_len(seq, i, j):
    """Tokens seq[i:] and seq[j:] share from their starts, no further than j (the two sayings never overlap)."""
    n = 0
    while j + n < len(seq) and i + n < j and seq[i + n][0] == seq[j + n][0]:
        n += 1
    return n


def _spans_sentences(seq, i, L):
    """The run holds a sentence end before its last word: the end of one line and the opening of the next, said
    alike ("... in one click. You can cut your ..."), not a phrase said again."""
    return any(x[6] for x in seq[i:i + L - 1])


def _one_clip(seq, a, b):
    return len({x[5] for x in seq[a:b]}) == 1


def _place(seq, i, L, j, units, within):
    """"near" (one clip, within `within` s), "next" (across clips with nothing kept between, or the end of one
    clip's last unit and the start of the next clip's first), "far" (anything else)."""
    if not (_one_clip(seq, i, i + L) and _one_clip(seq, j, j + L)):
        return "far"
    if seq[i][5] == seq[j][5]:
        return "near" if seq[j][3] - seq[i + L - 1][4] <= within + 1e-9 else "far"
    if j == i + L:
        return "next"
    first_unit, last_unit, clips = {}, {}, []
    for x in seq:
        first_unit.setdefault(x[5], x[1])
        last_unit[x[5]] = x[1]
        if not clips or clips[-1] != x[5]:
            clips.append(x[5])
    ci, cj = seq[i][5], seq[j][5]
    adjacent = any(clips[k] == ci and clips[k + 1] == cj for k in range(len(clips) - 1))
    if adjacent and all(x[1] == last_unit[ci] for x in seq[i:i + L]) and all(x[1] == first_unit[cj] for x in seq[j:j + L]):
        return "next"
    return "far"


def _offer(units, sel, seq, a, b, out, used):
    """Offer deleting seq[a:b]: per unit, retake? when it is the whole of what the unit keeps, else repeat?."""
    if any(k in used for k in range(a, b)):
        return
    used.update(range(a, b))
    by_unit = {}
    for x in seq[a:b]:
        by_unit.setdefault(x[1], set()).add(x[2])
    for ui, span in by_unit.items():
        left = {k for k, w in enumerate(units[ui].words) if k not in sel.drop.get(ui, set()) and norm(w)}
        out.append((ui, None, "retake?") if left <= span else (ui, frozenset(span), "repeat?"))


def phrase_retakes(units, sel, is_filler, times=None):
    """The phrase rules above, on the words `sel` keeps. times: per unit, (start, end) source seconds per word
    (None: every repeat in one clip counts as near). Returns (drops {unit: {word position: "retake"}}, suggestions
    [(unit, word positions or None, why?)]); the caller adds them to the selection."""
    seq = _phrase_seq(units, sel, is_filler, times)
    sparse = {ui for ui, u in enumerate(units) if getattr(u, "sparse", False)}
    drops = {}
    while True:
        best = None
        for i in range(len(seq)):
            for j in range(i + PHRASE_MIN, len(seq)):
                L = _run_len(seq, i, j)
                if L < PHRASE_MIN or _numbers_only([x[0] for x in seq[i:i + L]]) or _spans_sentences(seq, i, L):
                    continue
                if {x[1] for x in seq[i:i + L] + seq[j:j + L]} & sparse:
                    continue
                if any(x[6] for x in seq[i + L:j]) or _place(seq, i, L, j, units, PHRASE_WITHIN_S) == "far":
                    continue        # a sentence ended between the two: parallel lines, not a retake
                if best is None or L > best[0]:
                    best = (L, i, j)
        if best is None:
            break
        L, i, j = best
        end = i + L
        tail = seq[end:j]
        if 0 < len(tail) <= PHRASE_TAIL_MAX and not any(x[6] for x in seq[i:j]) and _one_clip(seq, i, j):
            end = j                     # what is left of a false start goes with it
        for x in seq[i:end]:
            drops.setdefault(x[1], {})[x[2]] = "retake"
        seq = seq[:i] + seq[end:]

    suggest, used = [], set()
    # exact repeats that are not sure: too far, across clips with kept speech between, or a doubted clip
    for i in range(len(seq)):
        for j in range(i + PHRASE_MIN, len(seq)):
            L = _run_len(seq, i, j)
            if L >= PHRASE_MIN and not _numbers_only([x[0] for x in seq[i:i + L]]) and not _spans_sentences(seq, i, L):
                if seq[i][5] != seq[j][5] or _place(seq, i, L, j, units, PHRASE_HINT_WITHIN_S) != "far":
                    _offer(units, sel, seq, i, i + L, suggest, used)
    # short restarts: "the common trait though | the common trait here is but | the common trait is"
    for i in range(len(seq)):
        for j in range(i + PHRASE_HINT_MIN, min(len(seq), i + PHRASE_HINT_MIN + PHRASE_RESTART_GAP + 1)):
            L = _run_len(seq, i, j)
            if PHRASE_HINT_MIN <= L and not _numbers_only([x[0] for x in seq[i:i + L]]) \
                    and _place(seq, i, L, j, units, PHRASE_WITHIN_S) != "far" and not any(x[6] for x in seq[i:j]):
                _offer(units, sel, seq, i, j, suggest, used)
                break
    # near repeats: a word or two differ
    toks = [x[0] for x in seq]
    for i in range(len(seq) - 1):
        for j in range(i + PHRASE_MIN, len(seq) - 1):
            if toks[i:i + 2] != toks[j:j + 2] or _run_len(seq, i, j) >= PHRASE_MIN:
                continue
            a, b = toks[i:min(j, i + PHRASE_NEAR_SPAN)], toks[j:j + PHRASE_NEAR_SPAN]
            same = da = db = ext = 0
            for op, a1, a2, b1, b2 in SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
                if op == "equal":
                    if a2 - a1 < 2:
                        break           # a lone word in common is chance, not the phrase said again
                    same += a2 - a1
                    ext = a2
                    continue
                da, db = da + (a2 - a1), db + (b2 - b1)
                if da > PHRASE_NEAR_SWAPS or db > PHRASE_NEAR_SWAPS:
                    break
            if same >= PHRASE_MIN and ext and not _spans_sentences(seq, i, ext) and (seq[i][5] != seq[j][5]
                                               or _place(seq, i, ext, j, units, PHRASE_WITHIN_S) != "far"):
                _offer(units, sel, seq, i, i + ext, suggest, used)
    return drops, suggest
