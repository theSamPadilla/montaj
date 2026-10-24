"""When a phrase is said on the timeline (§558, place): `{phrase, take}` to timeline seconds.

The speech is read as `cut` reads it: the speech track's rows (lib/speech_text.derive), joined into spoken
sentences (lib/speech_units.build_units), judged by the take rules (lib/take_select.select), and placed on the
timeline through the project's current cut (each word through the item that plays it, by words_at's own rule:
lib/speech_words_at). A phrase matches a run of a sentence's
words, fillers left out, compared as normalized tokens (lib/speech_lines.norm).

take:
- "first" / "last": the earliest or latest saying on the timeline.
- "clean": a saying in a sentence with no filler and no restart, never a false start, an abandoned opening or a
  restarted or repeated clause (select's whys), and never the take said right after its own false start or
  abandoned opening in the same clip (a restart the transcript split in two: "Our new editor is... Our new editor
  is three times faster."); among those, the take select keeps, else the last. With none, the
  take select keeps (else the last saying), and `fallback` says so: the caller reports it, never guesses silently.
"""
from dataclasses import dataclass, field

from lib import speech_text, speech_units
from lib.speech_lines import norm
from lib.project_tracks import normalize_tracks
from lib.speech_words_at import _speed
from lib.take_select import select

TAKES = ("clean", "first", "last")
FLAWED = ("restart", "repeat", "abandoned", "false-start", "filler-only")


class PhraseNotFound(Exception):
    pass


@dataclass
class Found:
    start: float
    end: float
    take: str                 # the rule that chose it: clean | first | last | kept | last-said
    said: int                 # how many times the phrase is said
    fallback: str | None = None
    text: str = ""
    warnings: list = field(default_factory=list)


def tokens(text):
    return [t for t in (norm(w) for w in str(text).split()) if t]


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


def sayings(project, project_dir, phrase, language="en", track_id=None):
    """[(unit index, start, end, text)] of every saying of `phrase`, plus the selection and the units' flaws."""
    want = tokens(phrase)
    if not want:
        raise PhraseNotFound("The phrase has no words.")
    if track_id is None:
        track_id = speech_units.speech_track_id(project, project_dir)
    d = speech_text.derive(project, project_dir, track=track_id)
    is_filler = speech_units.filler_test(language)
    built, _ = speech_units.build_units(d, is_filler)
    units = [u for u, _, _ in built]
    sel = select(units, is_filler) if units else None
    items = _items(project)
    found = []
    for k, (_, rows, _) in enumerate(built):
        words = _unit_words(rows)
        # the unit's words without fillers, with their place in `words`
        seq = [(i, t) for i, (w, _) in enumerate(words) for t in [norm(w.text)] if t and not is_filler(t)]
        for a in range(len(seq) - len(want) + 1):
            if [t for _, t in seq[a:a + len(want)]] != want:
                continue
            first, last = words[seq[a][0]], words[seq[a + len(want) - 1][0]]
            t0 = _on_timeline(items, *first)
            t1 = _on_timeline(items, *last, end=True)
            if t0 is None or t1 is None:
                continue
            text = " ".join(w.text.strip() for w, _ in words[seq[a][0]:seq[a + len(want) - 1][0] + 1])
            found.append((k, t0, t1, text))
    found.sort(key=lambda f: f[1])
    return found, units, sel, d.warnings


def find(project, project_dir, phrase, take="clean", language="en", track_id=None):
    """The saying of `phrase` the `take` rule picks: a Found. Raises PhraseNotFound."""
    if take not in TAKES:
        raise PhraseNotFound(f"take must be one of {', '.join(TAKES)}.")
    found, units, sel, warnings = sayings(project, project_dir, phrase, language, track_id)
    if not found:
        raise PhraseNotFound(f'"{phrase}" is not said on the speech track.')
    said = len(found)
    if take == "first":
        k, s, e, text = found[0]
        return Found(s, e, "first", said, text=text, warnings=warnings)
    if take == "last":
        k, s, e, text = found[-1]
        return Found(s, e, "last", said, text=text, warnings=warnings)
    kept = set(sel.kept) if sel else set()
    why = sel.why if sel else {}
    def restarted(k):
        # the sentence right before it in the same clip was its own abandoned attempt
        return k > 0 and why.get(k - 1) in ("false-start", "abandoned") and units[k - 1].clip == units[k].clip
    clean = [f for f in found if not units[f[0]].fillers and why.get(f[0]) not in FLAWED and not restarted(f[0])]
    if clean:
        pick = ([f for f in clean if f[0] in kept] or clean)[-1]
        return Found(pick[1], pick[2], "clean", said, text=pick[3], warnings=warnings)
    in_kept = [f for f in found if f[0] in kept]
    if in_kept:
        pick, rule = in_kept[-1], "kept"
    else:
        pick, rule = found[-1], "last-said"
    note = f'no clean take of "{phrase}": used the {"kept take" if rule == "kept" else "last saying"} at {round(pick[1], 2)}s'
    return Found(pick[1], pick[2], rule, said, fallback=note, text=pick[3], warnings=warnings)
