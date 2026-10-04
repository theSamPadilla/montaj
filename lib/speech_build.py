"""Speech as text: build the new speech-track items from the edited rows.

Where this sits: `speech_text.parse` gives the rows, `speech_align.align_row` maps each row to the
words of its source line, `runs_from_rows` turns the rows into source runs (this module),
`items_from_runs` turns the runs into speech-track items (this module), and the apply carries the
rest of the project and writes it.

Vocabulary
- **word**: a refined word of a source (`speech_lines.refine`). Its span is speech.
- **gap**: the span between two consecutive refined words of one source, `[w_i.end, w_{i+1}.start]`.
  It is the only silence a cut may use. Before a source's first word the gap starts at 0; after its
  last word it runs to the source's end. A gap next to a word whisper placed inside a pause is
  **uncertain** (`Derived.uncertain`): where the pause really is, is unknown, so no cut is snapped
  into it.
- **join**: two kept words `a`, `b` that play one after the other on the new timeline, with no
  special row (`-- gap`, `-- ... no speech`, `-- image`) between them. A join is contiguous (one
  run plays through it) or a cut (one run ends after `a`, the next starts before `b`).
- **position**: where a pause marker can sit. A join inside a row has one position (before `b`). A
  join across two rows has two: the first row's tail and the second row's lead-in.

Where a cut lands
- **Kept pause.** The pause kept at a join is the sum of the markers written at its positions.
  A marker the text did not change (same value, same neighbouring words as the derived row) counts
  as its exact old value, so an unedited text never moves an edge by the 2-decimal rounding. With
  no marker written: the feel's `min_pause` when the old cut had a marker between `a` and `b` (the
  agent deleted it), otherwise the larger of the gap after `a` and the gap before `b` (the natural
  pause), raised to the feel's `floor`. `max_pause` (the call's, else the feel's) caps the kept
  pause of a join only when no marker at that join was edited,
  and never splits an uncertain gap: where that pause really lies is unknown, so a cut the text did
  not ask for could take a spoken word (on the fixture, the quiet "I" whisper placed at 16.98 s is
  spoken at about 17.4 s, inside the gap that follows).
- **Contiguous.** `a` and `b` adjacent in the source (`b.idx == a.idx + 1`) stay one run when the
  kept pause covers their whole gap (5 ms tolerance, half a marker's rounding step). A larger value
  is clamped to the gap and reported: a pause never grows. A smaller one cuts the middle of the gap.
- **Two sides.** A cut keeps silence on both sides: after `a` it ends at `a.end` plus up to half
  the kept pause, inside the gap after `a`; before `b` it starts at `b.start` minus the rest, inside
  the gap before `b`. A side that cannot take its share gives it to the other side; what neither
  can take is clamped and, when an edited marker asked for it, reported.
- **Unchanged sides.** A row's lead-in (tail) whose first (last) word is the same as in its derived
  row, whose marker is unchanged, and which sat on its old item's `inPoint` (`outPoint`) keeps that
  old edge exactly. That is what makes an unedited text rebuild the same items. The other side of
  the join takes the rest of the kept pause.
- **Never inside a word.** A cut edge never crosses a word: it stays in the gap next to its own
  kept word, so a deleted word is never kept and a kept word never dropped. Inside that gap it may
  move into the gap's measured silence (`sils_by_src`) when it would land on orphan sound (a word
  fragment refine could not attach), if that silence is within `SNAP_WINDOW_S`.
- **Inside words.** A kept word whisper placed inside a pause (`Derived.inside_words`) keeps the whole
  gap on each side: a pause next to it that would cut that gap is kept whole and reported as
  `clamped` with `unsure`, because the real word lies somewhere in the gap.
- **Silence of deleted edge words.** When the text edits a marker at a join and the gaps beside the two
  kept words cannot hold it, silence the old item kept after deleted words at its end (before deleted
  words at its start) is used too: only the deleted words are cut out and their silence is kept as a
  silence-only run (`Run.words` empty).
- **Hard cut.** When the gap on a cut's side is empty (glued words) or uncertain (the inside word is deleted), the edge sits at
  the word edge padded by the feel's `hard_cut_pad` (kept after the last word, before the next) and counts
  as a hard cut. A source's own start and end are not cuts. So: an edge lies inside a refined word
  only when it is a counted hard cut.

Times are source seconds; pause values are source seconds too (as derive shows them), so an item
at `speed` 2 plays a 0.4 s marker as 0.2 s.

Feel (`FEELS`): `tight` is the cut this module made before feels existed, byte for byte (min pause
0.08, no floor, no cap of its own, pads 0.04/0.02). `natural`, the default, keeps more silence:
min pause and floor 0.18, unchanged pauses capped at 0.45 unless the call passes `max_pause`,
pads 0.08/0.05.
"""
import copy
import math
import os
import re
from dataclasses import dataclass, field

from lib.common import fail
from lib.keyframe_curves import rebase
from lib.speech_align import align_row
from lib.speech_lines import norm

SNAP_WINDOW_S = 0.15
HARD_CUT_PAD_S = (0.04, 0.02)   # tight: kept after the last word, kept before the next word
MIN_PAUSE_S = 0.08              # tight: the pause kept where the text deleted a marker


@dataclass(frozen=True)
class Feel:
    """How soft the cut sounds.

    min_pause: the pause kept where the text deleted a marker.
    floor: the least pause kept at a join (or free side) the text wrote no marker for, as far as the gaps
      beside it hold it; 0 keeps their natural pause. A marker the text wrote is never floored.
    max_pause: the cap on every pause the text did not change, when the call passes none.
    hard_cut_pad: kept after the last word and before the next word at a hard cut.
    """
    min_pause: float
    floor: float
    max_pause: float | None
    hard_cut_pad: tuple


# tight is the cut speech_edit made before feels existed, byte for byte; natural is the default.
FEELS = {
    "natural": Feel(min_pause=0.18, floor=0.18, max_pause=0.45, hard_cut_pad=(0.08, 0.05)),
    "tight": Feel(min_pause=MIN_PAUSE_S, floor=0.0, max_pause=None, hard_cut_pad=HARD_CUT_PAD_S),
}
DEFAULT_FEEL = "natural"

_TOUCH_S = 0.001        # adjacent runs of one source whose spans touch this closely merge
_MARK_TOL_S = 0.005     # half the 2-decimal step a marker is written with
_EPS = 1e-6

# Fields a rebuilt piece takes from its old item (the plan's list). id, src, timing, keyframes and
# normalizedSrc are set by the build itself.
CARRIED = ("type", "sourceCrop", "scale", "scaleX", "scaleY", "offsetX", "offsetY", "rotation", "opacity",
           "volume", "muted", "speed", "proxySrc", "sourceDuration", "sourceWidth", "sourceHeight",
           "sourceCreatedAt")
_SET_BY_BUILD = ("id", "src", "start", "end", "inPoint", "outPoint", "keyframes", "normalizedSrc",
                 "normalizedInPoint")
_DEAD_FIELDS = ("transition",)   # round-tripped, read by nothing (docs/schemas/project.md)
_SOURCE_FIELDS = ("type", "proxySrc", "sourceDuration", "sourceWidth", "sourceHeight", "sourceCreatedAt")
_NON_SPEECH_TYPES = ("overlay", "image", "text", "caption")
_LINE_RE = re.compile(r"^([A-Z]+)\d+$")


@dataclass
class Run:
    """One span of the new speech track.

    kind "speech": `[s_in, s_out]` of `src` plays; `words` are its kept word indexes, in order.
    kind "nospeech": an old no-speech or no-transcript item (`item_id`), reused untouched.
    kind "image": an old image item (`item_id`), reused for `dur` seconds.
    kind "gap": `dur` seconds of nothing on the new timeline (`src` "", `s_in` == `s_out` == 0).
    `row_index` is the parsed row the run starts in and `line` its line id (None for special rows).
    `old_in` / `old_out`: the id of the old item whose `inPoint` / `outPoint` the edge keeps unchanged.
    `hard_in` / `hard_out`: the edge is a hard cut; `hard_cuts` counts them.
    `item_id` for speech: the old item of the derived row the run starts in (the preferred anchor).
    """
    src: str
    s_in: float
    s_out: float
    row_index: int
    line: str | None
    hard_cuts: int = 0
    kind: str = "speech"
    dur: float | None = None
    item_id: str | None = None
    old_in: str | None = None
    old_out: str | None = None
    hard_in: bool = False
    hard_out: bool = False
    words: list = field(default_factory=list)


@dataclass
class Report:
    """What the build did that the agent should see. `as_dict()` gives the apply result's keys.

    cut: [{"line", "words", "seconds"}] words the old cut played that the new one does not.
    moved: line ids whose rows left the old order (outside a longest common subsequence).
    pauses: [{"line", "from", "to"}] a join of the old cut whose kept pause changed.
    clamped: [{"line", "asked", "kept"[, "unsure": true]}] a marker asked for a different silence than was kept:
    more than exists, or less where the gap is uncertain (kept whole).
    flagged: [{"kind", "id", ...}] kinds keyframes_merged, state_merged, fields_dropped, short_piece.
    """
    hard_cuts: int = 0
    cut: list = field(default_factory=list)
    moved: list = field(default_factory=list)
    pauses: list = field(default_factory=list)
    clamped: list = field(default_factory=list)
    flagged: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"cut": self.cut, "moved": self.moved, "pauses": self.pauses, "clamped": self.clamped,
                "hardCuts": self.hard_cuts, "flagged": self.flagged}


# ------------------------------------------------------------------ sources and gaps


def _resolve(path, project_dir):
    if project_dir and isinstance(path, str) and path and not os.path.isabs(path):
        return os.path.join(project_dir, path)
    return path


def _key(item: dict, project_dir) -> str | None:
    """The source key derive() uses for an item: its src, else its normalizedSrc, resolved."""
    return _resolve(item.get("src") or item.get("normalizedSrc"), project_dir)


class _Source:
    """One source's refined words and the gaps between them."""

    def __init__(self, words, uncertain, sils, end, inside=frozenset(), pad=HARD_CUT_PAD_S):
        self.words = words            # refined Words, words[i].idx == i
        self.uncertain = uncertain    # {(i, i + 1)}
        self.inside = inside          # indexes of words whisper placed inside a pause
        self.sils = sils              # measured silences [(start, end)]
        self.end = end                # the source's end, as far as the project knows it
        self.pad = pad                # the feel's hard_cut_pad

    def gap_after(self, i):
        """(lo, hi, certain) of the gap after word i (to the source's end after the last word)."""
        lo = self.words[i].end
        hi = self.words[i + 1].start if i + 1 < len(self.words) else max(self.end, lo)
        return lo, max(lo, hi), (i, i + 1) not in self.uncertain

    def gap_before(self, i):
        """(lo, hi, certain) of the gap before word i (from 0 before the first word)."""
        hi = self.words[i].start
        lo = self.words[i - 1].end if i > 0 else 0.0
        return min(lo, hi), hi, (i - 1, i) not in self.uncertain

    def snap(self, x, lo, hi):
        """Keep an edge inside the measured silence of its gap. A gap can hold orphan sound; an edge
        that falls on it moves to the nearest silence of the same gap within SNAP_WINDOW_S, else stays."""
        pieces = [(max(a, lo), min(b, hi)) for a, b in self.sils if b > lo and a < hi]
        if not pieces or any(a - _EPS <= x <= b + _EPS for a, b in pieces):
            return x
        d, y = min((abs(x - p), p) for piece in pieces for p in piece)
        return y if d <= SNAP_WINDOW_S else x

    def after(self, i, amount):
        """Edge after word i keeping `amount` of the gap after it -> (edge, hard)."""
        lo, hi, certain = self.gap_after(i)
        if i == len(self.words) - 1 and hi - lo <= _EPS:
            return hi, False                                  # the source ends here: not a cut
        if i in self.inside:
            return hi, False                                  # the real word is somewhere in the gap: keep it whole
        if hi - lo <= _EPS or not certain:
            return round(min(lo + self.pad[0], max(self.end, lo)), 6), True
        return self.snap(lo + max(0.0, min(amount, hi - lo)), lo, hi), False

    def before(self, i, amount):
        """Edge before word i keeping `amount` of the gap before it -> (edge, hard)."""
        lo, hi, certain = self.gap_before(i)
        if i == 0 and hi - lo <= _EPS:
            return lo, False                                  # the source starts here: not a cut
        if i in self.inside:
            return lo, False                                  # the real word is somewhere in the gap: keep it whole
        if hi - lo <= _EPS or not certain:
            return round(max(0.0, hi - self.pad[1]), 6), True
        return self.snap(hi - max(0.0, min(amount, hi - lo)), lo, hi), False

    def capacity(self, lo, hi, certain):
        return hi - lo if certain and hi - lo > _EPS else 0.0


# ------------------------------------------------------------------ rows


@dataclass
class _Meta:
    """A derived speech row with what the build needs to know about its old item."""
    j: int                 # index in Derived.cut
    row: object            # speech_text.Row
    src: str
    item: dict | None
    first_in_item: bool    # its lead-in sat on the item's inPoint
    last_in_item: bool     # its tail sat on the item's outPoint

    @property
    def n(self):
        return len(self.row.words)

    def neighbours(self, q):
        w = self.row.words
        return (w[q - 1].idx if q > 0 else None, w[q].idx if q < self.n else None)

    def x(self, q):
        """Where position q sits in source word order: halfway between its neighbouring words."""
        return self.row.words[0].idx + q - 0.5


@dataclass
class _RowInfo:
    ri: int
    line: str
    src: str
    words: list            # kept Words, ascending
    marks: dict            # kept-word position -> seconds written there
    meta: _Meta | None = None


@dataclass
class _Spec:
    """What the text sets at one marker position.

    kind "fixed": an unchanged lead-in or tail on its old item's edge (`edge`, of item `item`).
    kind "value": a marker; `amount` is its exact old value when unedited, else as written.
    kind "none": no marker.
    """
    kind: str
    amount: float = 0.0
    edited: bool = False
    edge: float | None = None
    item: str | None = None


@dataclass
class _Edge:
    t: float
    hard: bool = False
    old: str | None = None     # the old item whose edge this keeps unchanged


def _marks_by_word(row, matched, line, order):
    """Re-key a row's pauses from token positions to kept-word positions (k = before kept word k).

    A token covers one word, or two when alignment used a join (`andit` for `and it`); a token that
    normalises to nothing covers none. A marker before such a token belongs before the next real
    token's first word. Markers that land on one position add up.
    """
    starts, p = [], 0
    for tok in row.tokens:
        t = norm(tok)
        if not t:
            starts.append(None)
            continue
        i = matched[p]
        starts.append(i)
        p += 1 if line.words[i].norm == t else 2
    pos_of = {i: k for k, i in enumerate(order)}
    marks: dict = {}
    for pos, v in row.pauses.items():
        nxt = next((starts[j] for j in range(pos, len(starts)) if starts[j] is not None), None)
        k = pos_of[nxt] if nxt is not None else len(order)
        marks[k] = marks.get(k, 0.0) + v
    return marks


# ------------------------------------------------------------------ the build


class _Build:
    def __init__(self, rows, derived, sils_by_src, max_pause, old_items, project_dir, feel=DEFAULT_FEEL):
        if feel not in FEELS:
            fail("invalid_param", f"Unknown feel {feel!r}: use one of {', '.join(sorted(FEELS))}.")
        self.feel = FEELS[feel]
        self.rows = rows
        self.d = derived
        self.max_pause = max_pause if max_pause is not None else self.feel.max_pause
        self.report = Report()
        self.project_dir = project_dir
        self.items = list(old_items)
        self.by_id = {it["id"]: it for it in old_items}
        self.src_of = {letter: src for src, letter in derived.letters.items()}
        self.sources = self._sources(sils_by_src or {})
        self.metas = self._metas()
        self.infos = self._infos()

    def _sources(self, sils_by_src):
        by_letter: dict = {}
        for ln in self.d.lines.values():
            by_letter.setdefault(_LINE_RE.match(ln.id).group(1), []).extend(ln.words)
        out = {}
        for letter, words in by_letter.items():
            src = self.src_of[letter]
            words = sorted(words, key=lambda w: w.idx)
            sils = list(sils_by_src.get(src) or [])
            end = max([words[-1].end] + [b for _, b in sils[-1:]]
                      + [float(it[k]) for it in self.items if _key(it, self.project_dir) == src
                         for k in ("outPoint", "sourceDuration") if isinstance(it.get(k), (int, float))])
            unc = {(i, j) for lt, i, j in self.d.uncertain if lt == letter}
            inside = frozenset(i for lt, i in self.d.inside_words if lt == letter)
            out[src] = _Source(words, unc, sils, end, inside, pad=self.feel.hard_cut_pad)
        return out

    def _metas(self):
        cut = self.d.cut
        metas = []
        for j, r in enumerate(cut):
            if r.kind != "speech":
                continue
            ids = r.item_ids
            first = not (j > 0 and cut[j - 1].item_ids == ids)
            last = not (j + 1 < len(cut) and cut[j + 1].item_ids == ids)
            letter = _LINE_RE.match(r.line).group(1)
            metas.append(_Meta(j, r, self.src_of[letter], self.by_id.get(ids[0]) if ids else None, first, last))
        return metas

    def _infos(self):
        """Align every speech row (refusing the edit on a bad row), then match each to a derived row:
        the unmatched derived row of the same line sharing the most kept words, earliest on ties."""
        infos = {}
        for ri, row in enumerate(self.rows):
            if row.kind != "speech":
                continue
            line = self.d.lines.get(row.line)
            matched = align_row(row.line, row.tokens, self.d.lines)
            keep = set(matched)
            # a word that normalises to nothing cannot be written; it stays when both neighbours stay
            for i, w in enumerate(line.words):
                if not w.norm and i - 1 in keep and i + 1 in keep:
                    keep.add(i)
            order = sorted(keep)
            infos[ri] = _RowInfo(ri, row.line, self.src_of[row.letter], [line.words[i] for i in order],
                                 _marks_by_word(row, matched, line, order) if order else {})
        used = set()
        for info in infos.values():
            if not info.words:
                continue
            kept = {w.idx for w in info.words}
            best = None
            for m in self.metas:
                if m.row.line != info.line or m.j in used:
                    continue
                ov = len(kept & {w.idx for w in m.row.words})
                if ov and (best is None or ov > best[0]):
                    best = (ov, m)
            if best:
                used.add(best[1].j)
                info.meta = best[1]
        return infos

    # -------------------------------------------------------------- positions

    def _old_amount(self, m, q):
        """Exact silence position q of derived row m kept in the old cut; None for the tail of a row
        that flowed on into the next row (its gap is that row's lead-in)."""
        w = m.row.words
        if 0 < q < m.n:
            return w[q].start - w[q - 1].end
        if q == 0:
            if m.first_in_item and m.item is not None:
                return max(0.0, w[0].start - float(m.item.get("inPoint", 0)))
            lo, hi, _ = self.sources[m.src].gap_before(w[0].idx)
            return hi - lo
        if m.last_in_item and m.item is not None:
            return max(0.0, float(m.item.get("outPoint", 0)) - w[-1].end)
        return None

    def _spec(self, info, pos):
        """What the text sets at kept-word position `pos` of a row (see _Spec)."""
        K, n = info.words, len(info.words)
        nb = (K[pos - 1].idx if pos else None, K[pos].idx if pos < n else None)
        written = info.marks.get(pos)
        m = info.meta
        if m is not None and pos in (0, n):
            q = 0 if pos == 0 else m.n
            on_edge = m.first_in_item if pos == 0 else m.last_in_item
            if on_edge and m.item is not None and m.neighbours(q) == nb and written == m.row.pauses.get(q):
                edge = float(m.item.get("inPoint", 0) if pos == 0 else m.item.get("outPoint", 0))
                amount = K[0].start - edge if pos == 0 else edge - K[-1].end
                return _Spec("fixed", max(0.0, amount), edge=edge, item=m.item["id"])
        if written is None:
            return _Spec("none")
        consult = [m] if m is not None else [c for c in self.metas if c.row.line == info.line]
        for c in consult:
            for q in range(c.n + 1):
                if c.neighbours(q) == nb and c.row.pauses.get(q) == written:
                    exact = self._old_amount(c, q)
                    if exact is not None:
                        return _Spec("value", exact)
        return _Spec("value", written, edited=True)

    def _old_marker_between(self, metas_and_bounds):
        """True when a derived row had a marker inside the given source-order bounds."""
        return any(lo < m.x(q) < hi for m, lo, hi in metas_and_bounds if m is not None for q in m.row.pauses)

    def _kept_pause(self, specs, natural, deleted):
        """Kept pause of a join or a free side -> (P, edited, capped). See the module docstring."""
        edited = any(s.kind == "value" and s.edited for s in specs)
        fixed = sum(s.amount for s in specs if s.kind == "fixed")
        if any(s.kind == "value" for s in specs):
            p = fixed + sum(s.amount for s in specs if s.kind == "value")
        elif deleted:
            p = fixed + self.feel.min_pause
        else:
            p = max(natural, fixed, self.feel.floor)
        capped = self.max_pause is not None and not edited and p > self.max_pause + _EPS
        if capped:
            p = self.max_pause
            if fixed > p + _EPS:
                for s in specs:
                    if s.kind == "fixed":
                        s.kind = "value"   # the cap moves this side off its old edge
        return p, edited, capped

    def _note(self, line, old, kept, asked, edited, unsure=False):
        """Report a clamp (an edited marker asked for more than the source has) and a pause change
        (a join of the old cut now keeps a different pause). `kept` is the source time between the
        two words, pads of a hard cut included."""
        if unsure or (edited and kept < asked - _MARK_TOL_S):
            entry = {"line": line, "asked": round(asked, 2), "kept": round(kept, 2)}
            if unsure:
                entry["unsure"] = True
            self.report.clamped.append(entry)
        if old is not None and abs(kept - old) >= _MARK_TOL_S:
            self.report.pauses.append({"line": line, "from": round(old, 2), "to": round(kept, 2)})

    def _join_old(self, prev, info, a, b):
        """The pause the old cut kept at this join, or None when the old cut had no such join."""
        if prev is info:
            m = info.meta
            if m is not None and any(m.neighbours(q) == (a.idx, b.idx) for q in range(1, m.n)):
                return b.start - a.end
            return None
        m1, m2 = prev.meta, info.meta
        if m1 is None or m2 is None or m2.j != m1.j + 1:
            return None
        if m1.row.words[-1].idx != a.idx or m2.row.words[0].idx != b.idx:
            return None
        tail = self._old_amount(m1, m1.n) or 0.0
        return tail + self._old_amount(m2, 0)

    # -------------------------------------------------------------- joins and free sides

    def _item_words(self, info):
        """Word indexes the old item of this row played (midpoint inside its in/out, as derive() reads them)."""
        m = info.meta
        if m is None or m.item is None:
            return None
        it = m.item
        a, b = float(it.get("inPoint", 0)), float(it.get("outPoint", 0))
        idx = [w.idx for w in self.sources[info.src].words if a <= (w.start + w.end) / 2 < b]
        return idx, a, b

    def _trailing_silence(self, prev, a, info, b):
        """Silence the old item kept after the words that followed kept word `a` in it, when the new cut
        drops those words: (D, available) with D the end of the item's last word, else None."""
        got = self._item_words(prev)
        if got is None:
            return None
        idx, lo, out = got
        if not idx or a.idx not in idx or max(idx) <= a.idx:
            return None
        last = max(idx)
        if prev.src == info.src and a.idx < b.idx <= last:
            return None                      # b is one of those words: they are not trailing
        src = self.sources[prev.src]
        if not src.gap_after(last)[2]:
            return None
        edge = min(out, src.words[last + 1].start) if last + 1 < len(src.words) else out
        d = src.words[last].end
        return (d, edge - d) if edge - d > _MARK_TOL_S else None

    def _leading_silence(self, prev, a, info, b):
        """The mirror image: silence the old item kept before the words that preceded kept word `b` in it,
        when the new cut drops those words: (S, available) with S the start of the item's first word."""
        got = self._item_words(info)
        if got is None:
            return None
        idx, inp, _ = got
        if not idx or b.idx not in idx or min(idx) >= b.idx:
            return None
        first = min(idx)
        if prev.src == info.src and first <= a.idx < b.idx:
            return None
        src = self.sources[info.src]
        if not src.gap_before(first)[2]:
            return None
        edge = max(inp, src.words[first - 1].end) if first > 0 else inp
        s0 = src.words[first].start
        return (s0, s0 - edge) if s0 - edge > _MARK_TOL_S else None

    def _join(self, prev, pk, info, k):
        """None when the join is contiguous, else (left edge, right edge, silence-only pieces), the pieces
        being (info, from, to) source spans kept between the two edges."""
        a, b = prev.words[pk], info.words[k]
        sa, sb = self.sources[prev.src], self.sources[info.src]
        if prev is info:
            specs = [self._spec(info, k)]
            bounds = [(info.meta, a.idx, b.idx)]
        else:
            specs = [self._spec(prev, len(prev.words)), self._spec(info, 0)]
            # a fixed side still writes its derived marker, so only a free side can have lost one
            bounds = [(prev.meta if specs[0].kind != "fixed" else None, a.idx, math.inf),
                      (info.meta if specs[1].kind != "fixed" else None, -math.inf, b.idx)]
        ga, gb = sa.gap_after(a.idx), sb.gap_before(b.idx)
        deleted = not any(s.kind == "value" for s in specs) and self._old_marker_between(bounds)
        p, edited, capped = self._kept_pause(specs, max(ga[1] - ga[0], gb[1] - gb[0]), deleted)
        fl = specs[0] if prev is not info and specs[0].kind == "fixed" else None
        fr = specs[1] if prev is not info and specs[1].kind == "fixed" else None
        old = self._join_old(prev, info, a, b)
        consecutive = prev.src == info.src and b.idx == a.idx + 1

        if fl and fr:
            self._note(info.line, old, fl.amount + fr.amount, p, edited)
            return _Edge(fl.edge, old=fl.item), _Edge(fr.edge, old=fr.item), []
        if consecutive:
            gap = b.start - a.end
            if not ga[2] and p < gap - _MARK_TOL_S:
                # a word whisper placed inside a pause is next to this gap: where the pause lies is
                # unknown, so a cut could take a spoken word. Keep the gap whole and say so.
                self._note(info.line, old, gap, p, True, unsure=True)
                return None
            if p >= gap - _MARK_TOL_S:
                self._note(info.line, old, gap, p, edited)
                return None
            left_amount = fl.amount if fl else (p - fr.amount if fr else p / 2)
            right_amount = p - left_amount
        else:
            cap_a, cap_b = sa.capacity(*ga), sb.capacity(*gb)
            if fl:
                left_amount, right_amount = fl.amount, min(max(0.0, p - fl.amount), cap_b)
            elif fr:
                left_amount, right_amount = min(max(0.0, p - fr.amount), cap_a), fr.amount
            else:
                left_amount = min(p / 2, cap_a)
                right_amount = min(p - left_amount, cap_b)
                left_amount = min(p - right_amount, cap_a)
        left = _Edge(fl.edge, old=fl.item) if fl else _Edge(*sa.after(a.idx, left_amount))
        right = _Edge(fr.edge, old=fr.item) if fr else _Edge(*sb.before(b.idx, right_amount))
        if prev.src == info.src and a.idx < b.idx and left.t >= right.t - _EPS:
            return None   # pads or snapping met: nothing left to cut between them
        kept = (left.t - a.end) + (b.start - right.t)
        pieces = []
        short = p - kept
        if edited and not consecutive and short > _MARK_TOL_S:
            # The gaps beside the two words cannot hold the pause the text asked for. Silence that followed deleted words
            # at the end of a's old item (or preceded deleted words at the start of b's) is there too:
            # cut out only those words and keep their silence.
            tail = None if fl else self._trailing_silence(prev, a, info, b)
            if tail:
                t = min(short, tail[1])
                pieces.append((prev, tail[0], tail[0] + t))
                short -= t
            lead = None if fr else self._leading_silence(prev, a, info, b)
            if lead and short > _MARK_TOL_S:
                u = min(short, lead[1])
                pieces.append((info, lead[0] - u, lead[0]))
                kept += u
            if tail:
                kept += pieces[0][2] - pieces[0][1]
        self._note(info.line, old, kept, p, edited)
        return left, right, pieces

    def _free_lead(self, info):
        """Edge before a row's first word when nothing plays before it (timeline start, special row)."""
        s = self._spec(info, 0)
        b = info.words[0]
        src = self.sources[info.src]
        lo, hi, _ = src.gap_before(b.idx)
        deleted = s.kind == "none" and self._old_marker_between([(info.meta, -math.inf, b.idx)])
        p, edited, _ = self._kept_pause([s], hi - lo, deleted)
        if s.kind == "fixed":
            return _Edge(s.edge, old=s.item)
        edge = _Edge(*src.before(b.idx, p))
        self._note(info.line, None, b.start - edge.t, p, edited)
        return edge

    def _free_tail(self, info):
        """Edge after a row's last word when nothing plays after it (timeline end, special row)."""
        s = self._spec(info, len(info.words))
        a = info.words[-1]
        src = self.sources[info.src]
        lo, hi, _ = src.gap_after(a.idx)
        deleted = s.kind == "none" and self._old_marker_between([(info.meta, a.idx, math.inf)])
        p, edited, _ = self._kept_pause([s], hi - lo, deleted)
        if s.kind == "fixed":
            return _Edge(s.edge, old=s.item)
        edge = _Edge(*src.after(a.idx, p))
        self._note(info.line, None, edge.t - a.end, p, edited)
        return edge

    # -------------------------------------------------------------- special rows

    def _exact_gaps(self):
        """The old timeline's gaps, in order, the way derive() finds them."""
        out, end_so_far = [], 0.0
        for it in sorted(self.items, key=lambda it: it.get("start", 0)):
            g = float(it.get("start", 0)) - end_so_far
            if g > _EPS:
                out.append(g)
            end_so_far = max(end_so_far, float(it.get("end", it.get("start", 0))))
        return out

    def _special(self, ri, row, gaps, reused):
        """The run for a `-- gap`, `-- image` or `-- <L> a-b no speech/no transcript` row.

        A gap row whose value is an old gap rounded to 2 decimals keeps that exact old gap. An image
        row reuses an old image item of that file name (an unused one first) for the duration it
        states. A no-speech row reuses the old item of that source whose in/out points round to the
        row's numbers, untouched. A row matching no item is refused (`unknown_row`).
        """
        if row.kind == "gap":
            exact = next((g for g in gaps if round(g, 2) == row.dur), None)
            if exact is not None:
                gaps.remove(exact)
            return Run("", 0.0, 0.0, ri, None, kind="gap", dur=exact if exact is not None else row.dur)
        if row.kind == "image":
            cands = [it for it in self.items if it.get("type") == "image"
                     and os.path.basename(it.get("src") or "") == row.label]
            it = self._pick(cands, reused)
            if it is None:
                fail("unknown_row", f"Line {row.lineno}: -- image {row.label} matches no image on the track. "
                                    "These rows can be moved or deleted, not edited.")
            old_dur = float(it["end"]) - float(it["start"])
            dur = old_dur if round(old_dur, 2) == row.dur else row.dur
            return Run(_key(it, self.project_dir) or "", 0.0, 0.0, ri, None, kind="image", dur=dur,
                       item_id=it["id"], old_in=it["id"], old_out=it["id"] if dur == old_dur else None)
        cands = []
        for it in self.items:
            if it.get("type") in _NON_SPEECH_TYPES:
                continue
            key = _key(it, self.project_dir)
            label = self.d.letters.get(key) or os.path.basename(key or "")
            if label == row.label and abs(float(it.get("inPoint", 0)) - row.t0) <= _MARK_TOL_S + 1e-9 \
                    and abs(float(it.get("outPoint", 0)) - row.t1) <= _MARK_TOL_S + 1e-9:
                cands.append(it)
        it = self._pick(cands, reused)
        if it is None:
            what = "no speech" if row.kind == "nospeech" else "no transcript"
            fail("unknown_row", f"Line {row.lineno}: -- {row.label} {row.t0:.2f}-{row.t1:.2f} {what} matches no item "
                                "on the track. These rows can be moved or deleted, not edited.")
        return Run(_key(it, self.project_dir) or "", float(it.get("inPoint", 0)), float(it.get("outPoint", 0)), ri,
                   None, kind="nospeech", item_id=it["id"], old_in=it["id"], old_out=it["id"])

    @staticmethod
    def _pick(cands, reused):
        for it in cands:
            if it["id"] not in reused:
                reused.add(it["id"])
                return it
        return cands[0] if cands else None

    # -------------------------------------------------------------- walk

    def build(self):
        runs, cur, prev = [], None, None
        gaps, reused = self._exact_gaps(), set()

        def close(edge):
            cur.s_out, cur.old_out, cur.hard_out = edge.t, edge.old, edge.hard
            runs.append(cur)

        def open_(info, edge):
            origin = info.meta.item["id"] if info.meta is not None and info.meta.item is not None else None
            return Run(info.src, edge.t, edge.t, info.ri, info.line, item_id=origin, old_in=edge.old,
                       hard_in=edge.hard)

        for ri, row in enumerate(self.rows):
            if row.kind != "speech":
                if cur is not None:
                    close(self._free_tail(prev[0]))
                cur = prev = None
                runs.append(self._special(ri, row, gaps, reused))
                continue
            info = self.infos[ri]
            for k, w in enumerate(info.words):
                if prev is None:
                    cur = open_(info, self._free_lead(info))
                else:
                    edges = self._join(prev[0], prev[1], info, k)
                    if edges is not None:
                        close(edges[0])
                        for minfo, t0, t1 in edges[2]:
                            cur = open_(minfo, _Edge(t0))
                            cur.row_index = info.ri
                            close(_Edge(t1))
                        cur = open_(info, edges[1])
                cur.words.append(w.idx)
                prev = (info, k)
        if cur is not None:
            close(self._free_tail(prev[0]))
        runs = self._merge(runs)
        for r in runs:
            r.hard_cuts = int(r.hard_in) + int(r.hard_out)
        self.report.hard_cuts = sum(r.hard_cuts for r in runs)
        self._report_cut_and_moved()
        return runs, self.report

    @staticmethod
    def _merge(runs):
        """Adjacent speech runs of one source whose spans touch become one run, unless both edges are
        old item edges kept unchanged (an old split stays split)."""
        out = []
        for r in runs:
            p = out[-1] if out else None
            if (p is not None and p.kind == r.kind == "speech" and p.src == r.src
                    and abs(p.s_out - r.s_in) <= _TOUCH_S and not (p.old_out and r.old_in)):
                p.s_out, p.old_out, p.hard_out = r.s_out, r.old_out, r.hard_out
                p.words.extend(r.words)
                continue
            out.append(r)
        return out

    def _report_cut_and_moved(self):
        old_by_line: dict = {}
        for m in self.metas:
            old_by_line.setdefault(m.row.line, {}).update({w.idx: w for w in m.row.words})
        kept: dict = {}
        for info in self.infos.values():
            kept.setdefault(info.line, set()).update(w.idx for w in info.words)
        for line, words in old_by_line.items():
            gone = [words[i] for i in sorted(words) if i not in kept.get(line, set())]
            if gone:
                self.report.cut.append({"line": line, "words": " ".join(w.text for w in gone),
                                        "seconds": round(sum(w.end - w.start for w in gone), 2)})
        old_seq = [m.row.line for m in self.metas]
        new_seq = [info.line for _, info in sorted(self.infos.items()) if info.words]
        in_lcs = _lcs_members(old_seq, new_seq)
        moved = []
        for i, line in enumerate(new_seq):
            if i not in in_lcs and line in old_by_line and line not in moved:
                moved.append(line)
        self.report.moved = moved


def _lcs_members(a, b):
    """Indexes of b in one longest common subsequence of a and b."""
    n, m = len(a), len(b)
    t = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            t[i][j] = t[i + 1][j + 1] + 1 if a[i] == b[j] else max(t[i + 1][j], t[i][j + 1])
    out, i, j = set(), 0, 0
    while i < n and j < m:
        if a[i] == b[j]:
            out.add(j)
            i, j = i + 1, j + 1
        elif t[i + 1][j] >= t[i][j + 1]:
            i += 1
        else:
            j += 1
    return out


def runs_from_rows(rows, derived, sils_by_src, max_pause: float | None, old_items,
                   project_dir: str | None = None, *, feel: str = DEFAULT_FEEL) -> tuple[list[Run], Report]:
    """Source runs for the edited rows, in timeline order, and the report of what the build did.

    rows: `speech_text.parse(text)[1]`. derived: `speech_text.derive()` of the CURRENT project (the
    one the text was read from). sils_by_src: measured silences per source, keyed like
    `derived.letters` (`speech_pauses.silences` of the media derive read). max_pause: cap for every
    pause the text did not change, or None for the feel's own. old_items: the speech track's current
    items, as in project.json; project_dir resolves their relative paths the way derive() did.
    feel: a key of FEELS.
    Refuses with `fail()`: alignment refusals from `speech_align.align_row`, `unknown_row` for a
    `-- ... no speech` or `-- image` row that matches no item (those rows are moved or deleted, not edited),
    and `invalid_param` for an unknown feel.
    """
    return _Build(rows, derived, sils_by_src, max_pause, old_items, project_dir, feel).build()


# ------------------------------------------------------------------ items


def _speed(it) -> float:
    s = it.get("speed", 1) if it else 1
    return float(s) if isinstance(s, (int, float)) and s > 0 else 1.0


def _overlap(it, a, b):
    return min(float(it.get("outPoint", 0)), b) - max(float(it.get("inPoint", 0)), a)


def _rebased_keyframes(anchor, s_in, s_out, speed):
    """The anchor's keyframes re-based onto [s_in, s_out]. The re-base window's end is nudged up by
    ulps until offset + duration reaches (s_out - inPoint) / speed, so a piece ending on a keyframe
    time keeps that segment's easing (keyframe_curves.rebase compares it exactly)."""
    in0 = float(anchor.get("inPoint", 0))
    offset = (s_in - in0) / speed
    target = (s_out - in0) / speed
    dur = target - offset
    for _ in range(4):
        if offset + dur >= target:
            break
        dur = math.nextafter(dur, math.inf)
    return rebase(anchor["keyframes"], offset, dur) if dur > 0 else []


def items_from_runs(runs, old_items, fps, *, report: Report | None = None, sources=None, reserved_ids=(),
                    project_dir: str | None = None) -> tuple[list[dict], dict]:
    """New speech-track items for the runs, and their provenance (new id -> dict).

    Timing: one item per run; `start` is the running cursor and `end = start + (s_out - s_in) / speed`.
    `-- gap` runs advance the cursor. Two neighbours whose edges both kept their old items' edges,
    and whose old items were neighbours too, keep their old offset when it was an overlap (a
    crossfade) or a gap under one frame (`1 / fps`, which derive does not show as a row). Every
    other join is a hard join. A piece shorter than one frame is flagged `short_piece`.

    State: the anchor is the old item (same source) whose range holds `s_in`, the run's own row's
    item first; else the one the run overlaps most. A run over exactly its anchor's range is the
    anchor itself (a deep copy). Otherwise the piece carries CARRIED from the anchor, its keyframes
    re-based, and `normalizedSrc` only when `normalizedInPoint == 0` (a full-source conversion; a
    window cache covers the old range only). Other fields are dropped and flagged `fields_dropped`.
    A run that also covers other old items with different keyframes or CARRIED fields keeps the
    anchor's and is flagged `keyframes_merged` / `state_merged`. A run with no old item takes
    CARRIED from the nearest old item of its source (no keyframes), else src and the source fields
    from the project `sources` entry.

    Ids: the first piece of an old item keeps its id; later pieces are `<id>-s<n>` (n counts the
    item's pieces, raised past any id in use); a run with no old item is `sp-<line>-<n>`.
    reserved_ids: ids used elsewhere in the project.

    Provenance: {"kind", "old_id", "piece", "src", "s_in", "s_out", "speed", "line", "row_index",
    "repeat" (an earlier piece played some of this source span), "words"}.
    """
    report = report if report is not None else Report()
    by_id = {it["id"]: it for it in old_items}
    order = sorted(old_items, key=lambda it: it.get("start", 0))
    next_of = {order[i]["id"]: order[i + 1]["id"] for i in range(len(order) - 1)}
    taken = set(reserved_ids) | set(by_id)
    used: set = set()
    pieces: dict = {}
    played: dict = {}
    frame = 1.0 / fps if fps else 0.0
    items, prov = [], {}
    cursor, prev = 0.0, None

    def new_id(base_id, line):
        if base_id is None:
            n = 1
            while f"sp-{line}-{n}" in taken | used:
                n += 1
            return f"sp-{line}-{n}"
        pieces[base_id] = pieces.get(base_id, 0) + 1
        if pieces[base_id] == 1 and base_id not in used:
            return base_id
        n = max(2, pieces[base_id])
        while f"{base_id}-s{n}" in taken | used:
            n += 1
        return f"{base_id}-s{n}"

    for run in runs:
        if run.kind == "gap":
            cursor += run.dur
            prev = None
            continue
        anchor, whole = None, False
        if run.kind in ("nospeech", "image"):
            anchor = by_id[run.item_id]
            item = copy.deepcopy(anchor)
            whole = run.kind == "nospeech" or run.old_out is not None
            dur = float(anchor["end"]) - float(anchor["start"]) if whole else run.dur
            if not whole and anchor.get("keyframes"):
                item["keyframes"] = rebase(anchor["keyframes"], 0.0, dur)
            speed = _speed(anchor)
        else:
            anchor = _anchor(run, old_items, project_dir)
            speed = _speed(anchor)
            whole = anchor is not None and run.s_in == float(anchor.get("inPoint", 0)) \
                and run.s_out == float(anchor.get("outPoint", 0))
            if whole:
                item = copy.deepcopy(anchor)
                dur = float(anchor["end"]) - float(anchor["start"])
            else:
                item = _piece(run, anchor, old_items, sources, project_dir, speed)
                dur = (run.s_out - run.s_in) / speed
        start = cursor
        if prev is not None and prev[0] and run.old_in and next_of.get(prev[0]) == run.old_in:
            off = float(by_id[run.old_in]["start"]) - float(by_id[prev[0]]["end"])
            if off < -_TOUCH_S or 0 < off < frame:
                start = prev[1] + max(off, -(prev[1] - prev[2]))   # an overlap never exceeds the piece it overlaps
        nid = new_id(anchor["id"] if anchor is not None else None, run.line)
        used.add(nid)
        if whole and abs(start - float(anchor["start"])) < _EPS:
            start, end = anchor["start"], anchor["end"]
        else:
            start, end = round(start, 6), round(start + dur, 6)
        item["id"], item["start"], item["end"] = nid, start, end
        if run.kind == "speech":
            if not whole:    # a whole item keeps its own numbers (an integer 0 stays 0)
                item["inPoint"], item["outPoint"] = run.s_in, run.s_out
            if not whole:
                _flag_merged(report, nid, run, anchor, old_items, project_dir)
            if anchor is not None and not whole:
                dropped = sorted(k for k in anchor if k not in CARRIED and k not in _SET_BY_BUILD and k not in _DEAD_FIELDS)
                if dropped:
                    report.flagged.append({"kind": "fields_dropped", "id": nid, "fields": dropped})
        if frame and end - start < frame - 1e-9:
            report.flagged.append({"kind": "short_piece", "id": nid})
        spans = played.setdefault(run.src, [])
        repeat = run.kind == "speech" and any(min(b, run.s_out) - max(a, run.s_in) > _TOUCH_S for a, b in spans)
        if run.kind == "speech":
            spans.append((run.s_in, run.s_out))
        prov[nid] = {"kind": run.kind, "old_id": anchor["id"] if anchor is not None else None,
                     "piece": pieces.get(anchor["id"]) if anchor is not None else None, "src": run.src,
                     "s_in": run.s_in, "s_out": run.s_out, "speed": speed, "line": run.line,
                     "row_index": run.row_index, "repeat": repeat, "words": list(run.words)}
        items.append(item)
        cursor = float(end)
        prev = (run.old_out, float(end), float(start))
    return items, prov


def _same_src(old_items, src, project_dir):
    return [it for it in sorted(old_items, key=lambda it: it.get("start", 0))
            if it.get("type") not in _NON_SPEECH_TYPES and _key(it, project_dir) == src]


def _anchor(run, old_items, project_dir):
    same = _same_src(old_items, run.src, project_dir)
    hold = [it for it in same if float(it.get("inPoint", 0)) <= run.s_in < float(it.get("outPoint", 0))]
    pick = next((it for it in hold if it["id"] == run.item_id), None) or (hold[0] if hold else None)
    if pick is None:
        over = [it for it in same if _overlap(it, run.s_in, run.s_out) > 0]
        pick = next((it for it in over if it["id"] == run.item_id), None) \
            or max(over, key=lambda it: _overlap(it, run.s_in, run.s_out), default=None)
    return pick


def _piece(run, anchor, old_items, sources, project_dir, speed):
    """A rebuilt piece: CARRIED fields from its anchor (or a stand-in), in the anchor's key order."""
    base, with_kf = anchor, True
    if base is None:
        same = _same_src(old_items, run.src, project_dir)
        base = min(same, key=lambda it: max(float(it.get("inPoint", 0)) - run.s_out,
                                            run.s_in - float(it.get("outPoint", 0)), 0.0), default=None)
        with_kf = False
    if base is None:
        entry = next((s for s in sources or [] if _resolve(s.get("src"), project_dir) == run.src), None) or {}
        item = {"id": None, "type": entry.get("type", "video"), "src": entry.get("src", run.src)}
        item.update({k: copy.deepcopy(entry[k]) for k in _SOURCE_FIELDS if k in entry and k != "type"})
        item.update({"start": 0.0, "end": 0.0, "inPoint": run.s_in, "outPoint": run.s_out})
        return item
    item = {}
    for k, v in base.items():
        if k in ("id", "start", "end", "inPoint", "outPoint", "src"):
            item[k] = copy.deepcopy(v)
        elif k in CARRIED:
            item[k] = copy.deepcopy(v)
        elif k == "keyframes" and with_kf and v:
            kfs = _rebased_keyframes(base, run.s_in, run.s_out, speed)
            if kfs:
                item[k] = kfs
        elif k in ("normalizedSrc", "normalizedInPoint") and base.get("normalizedSrc") \
                and base.get("normalizedInPoint") == 0:
            item[k] = copy.deepcopy(v)
    item.setdefault("type", "video")
    for k in ("start", "end", "inPoint", "outPoint"):
        item.setdefault(k, 0.0)
    return item


def _flag_merged(report, nid, run, anchor, old_items, project_dir):
    if anchor is None:
        return
    others = [it for it in _same_src(old_items, run.src, project_dir)
              if it is not anchor and _overlap(it, run.s_in, run.s_out) > _TOUCH_S]
    if not others:
        return
    ids = [anchor["id"]] + [it["id"] for it in others]
    if any(it.get("keyframes") != anchor.get("keyframes") for it in others):
        report.flagged.append({"kind": "keyframes_merged", "id": nid, "items": ids})
    fields = sorted({k for it in others for k in CARRIED if it.get(k) != anchor.get(k)})
    if fields:
        report.flagged.append({"kind": "state_merged", "id": nid, "items": ids, "fields": fields})
