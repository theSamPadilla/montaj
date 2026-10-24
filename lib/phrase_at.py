"""When a phrase is said on the timeline (§558, place): `{phrase, take}` to timeline seconds.

The speech is read as `cut` reads it: the speech track's rows (lib/speech_text.derive), joined into spoken
sentences (lib/speech_units.build_units), judged by the take rules (lib/take_select.select), and placed on the
timeline through the project's current cut (each word through the item that plays it, by words_at's own rule:
lib/speech_words_at). A phrase matches a run of a sentence's words, fillers left out of both, compared as normalized
tokens with their accents folded (lib/speech_lines.norm); in a language written without spaces (NON_SPACED) it matches
the sentence's characters.

Sayings are grouped by the line they are takes of: select's sections (a false start or an abandoned opening goes
with the take after it), and also any two sentences whose words, fillers left out, are near the same (take_select's
SAME_RATIO): select keeps takes it is not sure of apart, and they are still takes of one line here. The earliest line is the one used; the others are answered as `also`, so a phrase said in
two different sentences is never picked silently. Within that line, take:
- "first" / "last": its earliest or latest take.
- "clean": a take with no filler and no restart, never a false start, an abandoned opening or a restarted or
  repeated clause (select's whys), and never the take said right after its own false start or abandoned opening in
  the same clip (a restart the transcript split in two: "Our new editor is... Our new editor is three times
  faster."); among those, the take cut keeps, else the last. With none, the take cut keeps, else the last take, and
  `fallback` says so (never when the line is said once).
"""
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from lib import speech_text, speech_units
from lib.project_tracks import normalize_tracks
from lib.speech_lines import norm
from lib.speech_words_at import _speed
from lib.take_select import SAME_RATIO, select

TAKES = ("clean", "first", "last")
FLAWED = ("restart", "repeat", "abandoned", "false-start", "filler-only")
NOT_FOUND_HINT = "Phrases match within one sentence, as transcribed (\"3 times\" is not \"three times\")."


class PhraseNotFound(Exception):
    pass


@dataclass
class Found:
    start: float
    end: float
    take: str                 # the rule that chose it: clean | first | last | kept | last-said
    said: int                 # how many times the phrase is said, every line
    fallback: str | None = None
    note: str | None = None   # the take cut keeps, when it is another one
    also: list = field(default_factory=list)   # the start of each other line that says it
    text: str = ""
    warnings: list = field(default_factory=list)


def fold(token):
    """A normalized token with its accents taken off: "café" and "cafe" compare equal."""
    return "".join(c for c in unicodedata.normalize("NFKD", token) if not unicodedata.combining(c))


def tokens(text, is_filler=lambda t: False):
    return [fold(t) for t in (norm(w) for w in str(text).split()) if t and not is_filler(t)]


def _unit_words(rows):
    """The Word objects and their row's item ids, in order, of one unit's rows."""
    return [(w, r.item_ids) for _, r in rows for w in r.words]


def _items(project):
    return {it.get("id"): it for t in normalize_tracks(project).get("tracks", []) for it in t.get("items", []) if it.get("id")}


def _on_timeline(items, word, item_ids, end=False):
    """The word's timeline time (its start, or its end) through the first of `item_ids` that plays it, as
    speech_words_at.words_at places a word; None when none does."""
    for iid in item_ids:
        it = items.get(iid)
        if not it:
            continue
        a, b = float(it.get("inPoint", 0)), float(it.get("outPoint", 0))
        if not (a <= (word.start + word.end) / 2 < b):
            continue
        s, e, speed = float(it.get("start", 0)), float(it.get("end", 0)), _speed(it)
        t = s + ((word.end if end else word.start) - a) / speed
        return min(max(t, s), e)
    return None


def _matches(seq, want, spaceless):
    """[(first index, last index)] into `seq` ([(word index, token)]) where `want` (tokens) is said."""
    if not want or not seq:
        return []
    if not spaceless:
        n = len(want)
        return [(a, a + n - 1) for a in range(len(seq) - n + 1) if [t for _, t in seq[a:a + n]] == want]
    text, owner = "", []
    for k, (_, t) in enumerate(seq):
        text += t
        owner += [k] * len(t)
    needle = "".join(want)
    out, i = [], text.find(needle)
    while i != -1:
        out.append((owner[i], owner[i + len(needle) - 1]))
        i = text.find(needle, i + 1)
    return out


def sayings(project, project_dir, phrase, language="en", track_id=None):
    """[(unit index, start, end, text)] of every saying of `phrase`, plus the units, the selection and warnings."""
    is_filler = speech_units.filler_test(language or "en")
    want = tokens(phrase, is_filler)
    if not want:
        raise PhraseNotFound("The phrase has no words.")
    spaceless = (language or "").split("-")[0].lower() in speech_units.NON_SPACED
    if track_id is None:
        track_id = speech_units.speech_track_id(project, project_dir)
    d = speech_text.derive(project, project_dir, track=track_id)
    built, _ = speech_units.build_units(d, is_filler)
    units = [u for u, _, _ in built]
    sel = select(units, is_filler) if units else None
    items = _items(project)
    found = []
    for k, (_, rows, _) in enumerate(built):
        words = _unit_words(rows)
        seq = [(i, fold(t)) for i, (w, _) in enumerate(words) for t in [norm(w.text)] if t and not is_filler(t)]
        for a, b in _matches(seq, want, spaceless):
            first, last = words[seq[a][0]], words[seq[b][0]]
            t0 = _on_timeline(items, *first)
            t1 = _on_timeline(items, *last, end=True)
            if t0 is None or t1 is None:
                continue
            text = ("" if spaceless else " ").join(w.text.strip() for w, _ in words[seq[a][0]:seq[b][0] + 1])
            found.append((k, t0, t1, text))
    found.sort(key=lambda f: f[1])
    return found, units, sel, d.warnings


def _line_of(sel, why, units):
    """unit index -> the line (section) it is a take of; a false start or an abandoned opening goes with the unit
    after it, a unit in no section is a line of its own."""
    of = {}
    for n, sec in enumerate(sel.sections if sel else []):
        for k in sec:
            of[k] = n
    out = {}
    for k in range(len(units)):
        if k in of:
            out[k] = of[k]
        elif why.get(k) in ("false-start", "abandoned") and k + 1 in of:
            out[k] = of[k + 1]
        else:
            out[k] = f"u{k}"
    return out


def find(project, project_dir, phrase, take="clean", language="en", track_id=None):
    """The saying of `phrase` the `take` rule picks in the earliest line that says it: a Found. Raises PhraseNotFound."""
    if take not in TAKES:
        raise PhraseNotFound(f"take must be one of {', '.join(TAKES)}.")
    found, units, sel, warnings = sayings(project, project_dir, phrase, language, track_id)
    if not found:
        raise PhraseNotFound(f'"{phrase}" is not said on the speech track. {NOT_FOUND_HINT}')
    kept = set(sel.kept) if sel else set()
    why = sel.why if sel else {}
    line = _line_of(sel, why, units)
    # sayings join one line when select put their sentences in one section, or the sentences are near the same
    is_filler = speech_units.filler_test(language or "en")
    toks = {k: [t for t in (fold(norm(w)) for w in units[k].words) if t and not is_filler(t)] for k in {f[0] for f in found}}
    root = {k: k for k in toks}

    def top(k):
        while root[k] != k:
            k = root[k]
        return k
    ks = sorted(toks)
    for i, a in enumerate(ks):
        for b in ks[i + 1:]:
            if line[a] == line[b] or SequenceMatcher(None, toks[a], toks[b]).ratio() >= SAME_RATIO:
                root[top(b)] = top(a)
    groups = {}
    for f in found:
        groups.setdefault(top(f[0]), []).append(f)
    ordered = sorted(groups.values(), key=lambda g: g[0][1])
    group, others = ordered[0], ordered[1:]
    also = [round(g[0][1], 2) for g in others]
    said = len(found)

    def done(pick, rule, fallback=None):
        note = None
        in_kept = [f for f in group if f[0] in kept]
        if in_kept and pick[0] not in kept and rule in ("clean", "first", "last"):
            note = f"cut keeps the take at {round(in_kept[-1][1], 2)}s"
        return Found(pick[1], pick[2], rule, said, fallback=fallback, note=note, also=also, text=pick[3], warnings=warnings)

    if take == "first":
        return done(group[0], "first")
    if take == "last":
        return done(group[-1], "last")

    def restarted(k):
        # the sentence right before it in the same clip was its own abandoned attempt
        return k > 0 and why.get(k - 1) in ("false-start", "abandoned") and units[k - 1].clip == units[k].clip
    clean = [f for f in group if not units[f[0]].fillers and why.get(f[0]) not in FLAWED and not restarted(f[0])]
    if clean:
        return done(([f for f in clean if f[0] in kept] or clean)[-1], "clean")
    in_kept = [f for f in group if f[0] in kept]
    pick, rule = (in_kept[-1], "kept") if in_kept else (group[-1], "last-said")
    if len(group) == 1:
        return done(pick, rule)
    which = "the take cut keeps" if rule == "kept" else "the last take"
    return done(pick, rule, f'no clean take of "{phrase}": used {which} at {round(pick[1], 2)}s')
