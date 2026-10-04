"""Speech as text: carry everything else on the timeline through a speech edit.

Where this sits: `speech_build` turns the edited text into new speech-track items and their
provenance; `TimeMap` relates the old speech track to the new one; `carry` moves every other
timeline-anchored thing (linked layers, overlays, captions, audio, markers, notes) so it follows the
speech it sat on. Nothing is silently dropped: every removal and every unusual move is added to the
report's `flagged` list, and `carried` counts what was carried.

Use (the apply):
    runs, rep = runs_from_rows(rows, derived, sils, max_pause, old_items, project_dir)
    items, prov = items_from_runs(runs, old_items, fps, report=rep, ...)
    tmap = TimeMap(old_items, items, prov, words=words_by_src(derived), project_dir=project_dir)
    project, rep = carry(project, track_index, items, tmap, fps, report=rep)   # rep.as_dict()

The time map
- Built from the old and new items of the speech track only, in source time. An item plays source
  second `s = inPoint + (t - start) * speed` at timeline time `t`, over `[inPoint, outPoint)`. An
  image item, or a `loop` item, has no meaningful source time: it is keyed by its own id (a new
  item by the old item it was rebuilt from) and `s` is seconds into the item.
- A moment of the old timeline is **kept** when some new item plays its source moment. In a
  crossfade both items play, so a span over a crossfade follows both; a single moment there belongs
  to the incoming item first (an overlay or audio line snapped to an item's start belongs to that
  item), and to the outgoing one when the incoming item's moment was cut.
- **Lineage.** An old item's play of a moment continues as the plays of the new items rebuilt from
  it (provenance `old_id`): the first play and every repeat. A new play whose own old item did not
  play that moment (a run that grew past its anchor) continues the moment's first old play. So an
  old cut that already played a moment twice carries each play to its own copy (an unedited text
  stays byte-identical), and a moment played twice before and once now follows the play it was
  rebuilt from; the other play's overlays and captions count as cut.
- `forward(t)`: the new time of the moment under `t`: the earliest play continuing it, or None when
  it was cut. `new_times(src, s)` lists every new time playing a source moment.
- **Holes** (time on no speech item) are not speech, so no text edit cuts them:
  - before the first item (a leading gap) keeps its absolute time;
  - past the last item follows the new end (`t + new_end - old_end`), e.g. an end card;
  - inside a gap follows the end of the speech before it, and survives only while the new timeline
    still has that much gap there (an unedited gap keeps it; a shortened or deleted `-- gap` row
    cuts what no longer fits).
- `first_kept(t)`: the first old moment at or after `t` that survives. `next_kept(t)` is its
  `forward()`. Past the last kept moment that is the new end (the tail always survives).
- Times that do not change are returned exactly (shifts are added as deltas that are 0.0 for an
  unchanged item), so an unedited text leaves every other layer byte-identical. Changed times are
  rounded to 6 decimals, as `speech_build` rounds item times.

Rules (`carry`)
1. **Linked layers.** A `video` item on another track is linked to every old speech item (its
   partners) with the same source, the same speed `v`, an overlapping source range, and the same
   sync offset: `|(start - inPoint / v) - (sp.start - sp.inPoint / v)| < 1 / fps` (for speed 1 that
   is `start - inPoint`). Each new speech item continuing a partner's play (lineage) is intersected
   with the layer's source range; each non-empty intersection is a piece at
   `new.start + (s - new.inPoint) / speed`, with the layer's fields and its keyframes re-based (a
   repeat replicates the layer). Lineage, rather than every new item of the source, keeps an old
   cut that already repeated a line from doubling its layers. The first piece in timeline order
   keeps the id; later pieces are `<id>-s<n>`. A layer with no piece is removed: `linked_removed`.
   Source the layer covers but no partner played is not carried: `linked_clipped`.
2. **Overlays, images, other video and anything else timed on the other tracks** (not linked):
   - `new_start = forward(start)`; if that moment was cut, `next_kept(start)`, flagged
     `overlay_moved`.
   - The surviving moments of `[start, end)` form new intervals; the interval holding `new_start`
     sets `new_end = min(that interval's end, new_start + (end - start))` (an item never grows).
     When the end of its surviving content plays outside the item (content split apart, e.g. a
     line moved or inserted inside it), it is flagged `overlay_clipped`.
   - No surviving moment: removed, `overlay_removed` with id and src.
   - Keyframes are re-based when the item is shortened or its start moved (offset = the old moment
     the new start shows, minus the old start). A video item's `inPoint` advances by that offset
     times its speed and its `outPoint` follows the new length.
   - Then each track is checked against the engine's bounded-overlap rule (containment on tracks
     other than `tracks[0]`, three items live at once on every track). A violation is fixed by
     moving the later item's start to the end of the earlier one (`overlay_trimmed`, keyframes and
     `inPoint` follow). A track the fix cannot make valid (the later item would vanish) refuses the
     whole apply: `fail("carry_conflict", "<track id>: <ids> overlap after the edit; ...")`.
3. **Captions** (skipped when `captions` is absent or null; top-level styling never changes):
   - Each caption word is anchored to the refined transcript word its source span overlaps most
     (`words` given to the time map; else its midpoint). It is placed in every new play continuing
     its old play (lineage: the first play and copies for repeats), shifted with that item, and
     clipped to the item where the item starts or ends inside the word's span. A word with no such
     play is cut.
   - A segment's placed words, in timeline order, split where two neighbours land apart: the gap
     between them grew by more than `CAPTION_SPLIT_GAP_S` over their gap in the old cut (so cutting
     the words between two kept words never splits them), or the order goes back (a repeat). The first
     part keeps the id; others are `<id>-<n>`. `text` is kept when a part has all the words in
     order, else rebuilt by joining `word`. `lane`, offsets, `scale`, `color`, `hero`, per-word
     `accent` and every other field are kept. A segment with no placed word is removed:
     `caption_removed`. A segment without well-formed words is carried like an overlay (rule 2),
     its `words` left as they were.
   - Speech the old cut never played (an unused take, a restored word) gets segments built from the
     refined sidecar words with `caption_group.group`, in timeline time, ids `cap-<n>` (none when
     the project's caption list is empty).
4. **`audio.tracks`.** A track covering at least `BED_SHARE` of the old cut (first item start to
   last item end) is a bed: its start stays; when its end (its `end`, else the end of its slice)
   was at or after the old end, its `end` and its `outPoint` move by `new_end - old_end`. Every bed
   is flagged `bed_check_timing` when the speech changed. Any other track is anchored like an
   overlay (rule 2): `inPoint`/`outPoint` follow any clipping (`audio_moved`, `audio_clipped`,
   `audio_removed`). A track with neither `end` nor `outPoint` has no known length: its start moves
   like a marker (`audio_moved` when its moment was cut) and it is never removed.
5. **`markers`, `notes`.** `t = forward(t)`; a cut moment moves to `next_kept(t)`, flagged
   `marker_moved` (notes too). A note with `tEnd` carries `[t, tEnd)` by rule 2, and is never
   removed: when nothing in its range survives, `t = next_kept(t)` and `tEnd = t`. Both lists are
   re-sorted by `t` (stable: ties keep their order) when a time changed. Other fields never change.
6. Nothing else in the project changes. The input project is never mutated.
"""
import bisect
import copy
import math
import os
import re
from dataclasses import dataclass, field, fields

from lib.caption_group import group
from lib.common import fail
from lib.keyframe_curves import rebase
from lib.project_tracks import normalize_tracks, replace_track_items
from lib.speech_build import Report

BED_SHARE = 0.9
CAPTION_SPLIT_GAP_S = 0.5

_EPS = 1e-9        # same moment
_MERGE_S = 1e-6    # new intervals this close are one
_SPEECH_SKIP = ("overlay", "text", "caption")   # not timeline content on the speech track
_LINE_RE = re.compile(r"^([A-Z]+)\d+$")


@dataclass
class CarryReport(Report):
    """speech_build's Report plus `carried`: counts of what was carried (linked pieces, overlays,
    caption words placed, audio tracks, markers, notes). `as_dict()` adds the `carried` key."""
    carried: dict = field(default_factory=dict)

    @classmethod
    def extending(cls, report):
        """A CarryReport sharing the build report's lists, so flags land in one `flagged` list."""
        if report is None:
            return cls()
        if isinstance(report, CarryReport):
            return report
        return cls(**{f.name: getattr(report, f.name) for f in fields(Report)})

    def as_dict(self) -> dict:
        out = super().as_dict()
        out["carried"] = self.carried
        return out


def words_by_src(derived) -> dict:
    """Refined transcript words per source key (the keys of `derived.letters`), for TimeMap(words=...)."""
    src_of = {letter: src for src, letter in derived.letters.items()}
    out: dict = {}
    for ln in derived.lines.values():
        m = _LINE_RE.match(ln.id)
        if m and m.group(1) in src_of:
            out.setdefault(src_of[m.group(1)], []).extend(ln.words)
    return {k: sorted(v, key=lambda w: w.idx) for k, v in out.items()}


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _speed(it) -> float:
    s = it.get("speed", 1)
    return float(s) if _num(s) and s > 0 else 1.0


def _resolve(path, project_dir):
    if project_dir and isinstance(path, str) and path and not os.path.isabs(path):
        return os.path.join(project_dir, path)
    return path


def _r6(new, old):
    """`old` itself when the value did not change, else `new` rounded to 6 decimals."""
    return old if old is not None and abs(new - old) < _EPS else round(new, 6)


class _Seg:
    """One item of the speech track as the time map sees it."""
    __slots__ = ("id", "key", "start", "end", "s_in", "s_out", "v", "old_id", "words")

    def __init__(self, it, key, lineage, prov=None):
        self.id = it.get("id")
        self.start = float(it.get("start", 0))
        self.end = float(it.get("end", self.start))
        timeless = it.get("type") == "image" or it.get("loop")
        self.v = 1.0 if it.get("type") == "image" else _speed(it)
        self.s_in = 0.0 if it.get("type") == "image" else float(it.get("inPoint", 0) or 0)
        if timeless or not _num(it.get("outPoint")):
            self.s_out = self.s_in + (self.end - self.start) * self.v
        else:
            self.s_out = float(it["outPoint"])
        self.key = ("item", lineage) if timeless else key
        self.old_id = lineage
        self.words = frozenset((prov or {}).get("words") or ())

    def s_at(self, t):
        return self.s_in + (t - self.start) * self.v

    def t_at(self, s):
        if s == self.s_in:
            return self.start
        if s == self.s_out:
            return self.end
        return self.start + (s - self.s_in) / self.v


class TimeMap:
    """Old speech-track time to new, through source time. See the module docstring.

    old_items / new_items: the speech track's items before and after the build; provenance: the
    build's `new id -> {old_id, words, ...}`. words: refined words per source key
    (`words_by_src(derived)`), used to anchor caption words and to build captions for new speech.
    project_dir resolves relative `src` the way derive() did. Source keys are resolved paths.
    """

    def __init__(self, old_items, new_items, provenance, *, words=None, project_dir=None):
        provenance = provenance or {}
        self.project_dir = project_dir
        self.old = [_Seg(it, self._key(it), it.get("id")) for it in self._timed(old_items)]
        self.new = []
        for it in self._timed(new_items):
            p = provenance.get(it.get("id")) or {}
            self.new.append(_Seg(it, self._key(it), p.get("old_id") or it.get("id"), p))
        self.old.sort(key=lambda x: (x.start, x.end))
        self.new.sort(key=lambda x: (x.start, x.end))
        self.words = {k: {w.idx: w for w in ws} for k, ws in (words or {}).items()}
        self._by_end = {}
        for k, ws in (words or {}).items():
            srt = sorted(ws, key=lambda w: (w.end, w.start))
            self._by_end[k] = ([w.end for w in srt], srt)
        self.old_start = self.old[0].start if self.old else 0.0
        self.old_end = max((x.end for x in self.old), default=0.0)
        self.new_end = max((x.end for x in self.new), default=0.0)
        def by_id(items):
            return sorted(items or [], key=lambda it: str(it.get("id")))
        self.changed = by_id(old_items) != by_id(new_items)
        self._old_by_id = {x.id: x for x in self.old}
        self._old_by_key: dict = {}
        for x in self.old:
            self._old_by_key.setdefault(x.key, []).append(x)
        # survival: per old item, the old-time stretches its plays continue as, with the new item
        self._survive = {id(x): self._stretches_of(x) for x in self.old}
        self._holes = self._find_holes()
        self._stretches = self._kept_stretches()

    # ---------------------------------------------------------- construction

    @staticmethod
    def _timed(items):
        return [it for it in items or [] if it.get("type") not in _SPEECH_SKIP
                and _num(it.get("start")) and _num(it.get("end")) and it["end"] > it["start"]]

    def _key(self, it):
        return _resolve(it.get("src") or it.get("normalizedSrc"), self.project_dir)

    def _find_holes(self):
        """[(kind, g0, g1, delta, room)]: lead / gap / tail, the shift a surviving hole moment takes
        and how much of the hole survives (from g0)."""
        if not self.old:
            return [("lead", -math.inf, math.inf, 0.0, math.inf)]
        cover = []
        for x in self.old:
            if cover and x.start <= cover[-1][1] + _EPS:
                cover[-1][1] = max(cover[-1][1], x.end)
            else:
                cover.append([x.start, x.end])
        holes = [("lead", -math.inf, cover[0][0], 0.0, math.inf)]
        for (_, g0), (g1, _) in zip(cover, cover[1:]):
            anchor, room = self._gap_anchor(g0)
            holes.append(("gap", g0, g1, anchor - g0, room))
        holes.append(("tail", cover[-1][1], math.inf, self.new_end - self.old_end, math.inf))
        return holes

    def _stretches_of(self, x):
        """[(t0, t1, n, s0, s1)]: old-time stretches of item x, the new item each continues as, and
        their source range."""
        out = []
        cuts = sorted({b for y in self._old_by_key.get(x.key, ()) for b in (y.s_in, y.s_out)})
        for n in self.new:
            if n.key != x.key:
                continue
            lo, hi = max(x.s_in, n.s_in), min(x.s_out, n.s_out)
            if hi - lo <= _EPS:
                continue
            pts = [lo] + [c for c in cuts if lo < c < hi] + [hi]
            runs = []
            for p, q in zip(pts, pts[1:]):
                if q - p > _EPS and self._continues(x, n, (p + q) / 2):
                    if runs and runs[-1][1] == p:
                        runs[-1][1] = q
                    else:
                        runs.append([p, q])
            for p, q in runs:
                t0, t1 = max(x.t_at(p), x.start), min(x.t_at(q), x.end)
                if t1 - t0 > _EPS:
                    out.append((t0, t1, n, p, q))
        return out

    def _continues(self, x, n, s):
        """True when old item x's play of source second s continues as new item n's play of it.

        Lineage: n rebuilt from x continues x. A play of n whose own old item did not play s (a run
        that grew past its anchor, a repeat of another item's moment) has no counterpart; it
        continues the first old play of s (earliest on the old timeline), if any. So an old cut that
        already played a moment twice carries each play to its own copy, and a moment the old cut
        played twice and the new cut plays once follows the play it was rebuilt from."""
        if n.old_id == x.id:
            return True
        c = self._old_by_id.get(n.old_id)
        if c is not None and c.key == n.key and c.s_in - _EPS <= s < c.s_out - _EPS:
            return False
        first = next((y for y in self._old_by_key.get(x.key, ()) if y.s_in - _EPS <= s < y.s_out - _EPS), None)
        return first is None or first is x

    def _gap_anchor(self, g0):
        """(new time where the speech before the gap now ends, new gap length after it)."""
        anchor, after = 0.0, None
        for x in sorted((x for x in self.old if x.end <= g0 + _EPS), key=lambda x: -x.end):
            st = self._survive[id(x)]
            if st:
                t0, t1, n = max(st, key=lambda s: (s[1], s[2].old_id == x.id, -s[2].start))[:3]
                anchor, after = self._to_new(x, n, t1), n
                break
        nxt = [n.start for n in self.new if n is not after and n.start >= anchor - _MERGE_S]
        return anchor, (min(nxt) - anchor if nxt else math.inf)

    # ---------------------------------------------------------- lookups

    def _owners(self, t):
        """Old items playing t, incoming (latest start) first."""
        return sorted((x for x in self.old if x.start - _EPS <= t < x.end - _EPS), key=lambda x: (-x.start, -x.end))

    def _hole(self, t):
        for h in self._holes:
            if h[1] - _EPS <= t < h[2] - _EPS or (h[0] == "lead" and t < h[2] - _EPS):
                return h
        return self._holes[-1]

    def _covering(self, key, s):
        return [n for n in self.new if n.key == key and n.s_in - _EPS <= s < n.s_out - _EPS]

    def _pick(self, x, s):
        """The new item old item x's play of source second s continues as (the earliest, when a
        repeat plays it more than once), or None when that play was cut."""
        cands = [n for n in self._covering(x.key, s) if self._continues(x, n, s)]
        return min(cands, key=lambda n: n.start + (s - n.s_in) / n.v) if cands else None

    @staticmethod
    def _shift(x, n):
        """Constant shift from old item x's timeline to new item n's (same speed), or None."""
        if x.v != n.v:
            return None
        return (n.start - x.start) + (x.s_in - n.s_in) / n.v

    def _to_new(self, x, n, t):
        d = self._shift(x, n)
        if d is None:
            return n.t_at(x.s_at(t))
        return t + d if d else t

    def source_at(self, t_old):
        """(source key, source second) under old timeline time t_old on the speech track, or None."""
        owners = self._owners(t_old)
        if not owners:
            return None
        x = owners[0]
        return x.key, x.s_at(t_old)

    def new_times(self, src, s):
        """Every new timeline time playing (src, s), ascending."""
        return sorted(n.start + (s - n.s_in) / n.v for n in self._covering(src, s))

    def forward(self, t_old):
        """New time of the moment under t_old; None when that moment was cut."""
        owners = self._owners(t_old)
        if not owners:
            kind, g0, _g1, delta, room = self._hole(t_old)
            if kind == "gap" and t_old - g0 >= room - _EPS:
                return None
            return t_old + delta if delta else t_old
        for x in owners:
            n = self._pick(x, x.s_at(t_old))
            if n is not None:
                return self._to_new(x, n, t_old)
        return None

    def _kept_stretches(self):
        """Old-time stretches that survive: (t0, t1, x or None, n or None, delta for holes)."""
        out = []
        for x in self.old:
            out.extend((t0, t1, x, n, None) for t0, t1, n, _, _ in self._survive[id(x)])
        for kind, g0, g1, delta, room in self._holes:
            hi = g1 if room == math.inf else min(g1, g0 + room)
            if hi - g0 > _EPS:
                out.append((g0, hi, None, None, delta))
        return out

    def first_kept(self, t_old):
        """The first old moment at or after t_old that survives (the tail always does)."""
        best = None
        for t0, t1, *_ in self._stretches:
            if t1 - _EPS > t_old:
                u = max(t_old, t0)
                best = u if best is None else min(best, u)
        return best

    def next_kept(self, t_old):
        """forward() of the first old moment at or after t_old that survives."""
        u = self.first_kept(t_old)
        return None if u is None else self.forward(u)

    def span_image(self, a, b):
        """New-timeline intervals [(n0, n1)] playing the surviving moments of old [a, b), merged."""
        ivs = []
        for t0, t1, x, n, delta in self._stretches:
            lo, hi = max(a, t0), min(b, t1)
            if hi - lo <= _EPS:
                continue
            if x is None:
                ivs.append((lo + delta if delta else lo, hi + delta if delta else hi))
            else:
                ivs.append((self._to_new(x, n, lo), self._to_new(x, n, hi)))
        ivs.sort()
        out = []
        for lo, hi in ivs:
            if out and lo <= out[-1][1] + _MERGE_S:
                out[-1] = (out[-1][0], max(out[-1][1], hi))
            else:
                out.append((lo, hi))
        return out

    def end_image(self, a, b):
        """New time where the last surviving content of old [a, b) ends (its own copy first), or None."""
        best = None
        for t0, t1, x, n, delta in self._stretches:
            lo, hi = max(a, t0), min(b, t1)
            if hi - lo <= _EPS:
                continue
            own = x is None or n.old_id == x.id
            t_new = (hi + delta if delta else hi) if x is None else self._to_new(x, n, hi)
            rank = (hi, own, -t_new)
            if best is None or rank > best[0]:
                best = (rank, t_new)
        return None if best is None else best[1]

    # ---------------------------------------------------------- captions

    def word_copies(self, a, b):
        """New placements of an old caption word [a, b): [(start, end, clipped_start, clipped_end)].

        Anchored on the refined word its source span overlaps most (over every old item playing its
        midpoint), else on its midpoint; one placement per new play of that anchor that continues
        the old one (`_continues`): the first play and copies for repeats."""
        m = (a + b) / 2
        owners = self._owners(m)
        if not owners:
            t = self.forward(m)
            if t is None:
                return []
            d = t - m if t != m else 0.0
            return [(a + d if d else a, b + d if d else b, False, False)]
        best = None
        for x in owners:
            for w in self._words_over(x.key, x.s_at(a), x.s_at(b)):
                ov = min(x.s_at(b), w.end) - max(x.s_at(a), w.start)
                if ov > 0 and (best is None or ov > best[0]):
                    best = (ov, x, w.idx)
        if best is not None:
            _, x, k = best
            w = self.words[x.key][k]
            sk = (w.start + w.end) / 2
            copies = [(x, n) for n in self.new if n.key == x.key and k in n.words and self._continues(x, n, sk)]
        else:
            copies = []
            for x in owners:
                sm = x.s_at(m)
                copies = [(x, n) for n in self._covering(x.key, sm) if self._continues(x, n, sm)]
                if copies:
                    break
        out = []
        for x, n in copies:
            d = self._shift(x, n)
            if d is None:
                na, nb = n.t_at(x.s_at(a)), n.t_at(x.s_at(b))
            else:
                na, nb = (a + d, b + d) if d else (a, b)
            ca = n.s_in > x.s_in + _EPS and na < n.start
            cb = n.s_out < x.s_out - _EPS and nb > n.end
            sa, sb = (n.start if ca else na), (n.end if cb else nb)
            if sb - sa <= _EPS:
                sa, sb, ca, cb = na, nb, False, False
            out.append((sa, sb, ca, cb))
        return sorted(out)

    def _words_over(self, key, s0, s1):
        """Refined words of `key` overlapping source span (s0, s1). Refined words are in source
        order and never overlap, so their ends ascend with their starts."""
        ends, srt = self._by_end.get(key, ((), ()))
        out = []
        for w in srt[bisect.bisect_right(ends, s0):]:
            if w.start >= s1:
                break
            out.append(w)
        return out

    def unplayed_words(self):
        """[(new item seg, refined word)] the new cut plays and the old cut never did, in timeline order."""
        played = set()
        for x in self.old:
            for w in (self.words.get(x.key) or {}).values():
                if x.s_in <= (w.start + w.end) / 2 < x.s_out:
                    played.add((x.key, w.idx))
        out = []
        for n in self.new:
            ws = self.words.get(n.key) or {}
            for k in sorted(n.words):
                if k in ws and (n.key, k) not in played:
                    out.append((n, ws[k]))
        return out


# ------------------------------------------------------------------ rule 2: a timed span


@dataclass
class _Span:
    start: float
    end: float
    offset: float        # old moment the new start shows, minus the old start
    moved: bool          # the start moment was cut
    clipped: bool        # the end of its surviving content plays outside it


def _carry_span(tmap, a, b):
    """Rule 2 for old span [a, b): its new span, or None when no moment of it survives."""
    img = tmap.span_image(a, b)
    if not img:
        return None
    ns, u = tmap.forward(a), a
    if ns is None:
        u = tmap.first_kept(a)
        if u is None or u >= b - _EPS:
            return None
        ns = tmap.forward(u)
        if ns is None:
            return None
    hold = next((iv for iv in img if iv[0] - _MERGE_S <= ns < iv[1] - _EPS), None)
    if hold is None:
        return None
    length = b - a
    ne = hold[1] if hold[1] <= ns + length + _EPS else ns + length
    if ne - ns <= _EPS:
        return None
    end_img = tmap.end_image(a, b)
    clipped = end_img is None or not (ns - _MERGE_S <= end_img <= ne + _MERGE_S)
    return _Span(ns, ne, u - a, u > a + _EPS, clipped)


def _apply_span(it, sp):
    """Write a carried span onto a timed item in place: start/end (unchanged values kept as they
    were), keyframes re-based, and a video's in/out points following the new start and length."""
    a, b = float(it["start"]), float(it["end"])
    it["start"], it["end"] = _r6(sp.start, it["start"]), _r6(sp.end, it["end"])
    dur = it["end"] - it["start"]
    if sp.offset > _EPS or abs(dur - (b - a)) > _EPS:
        _rebase_keyframes(it, sp.offset, dur)
        if it.get("type") == "video":
            v = _speed(it)
            old_in = it.get("inPoint", 0) or 0
            it["inPoint"] = _r6(float(old_in) + sp.offset * v, old_in)
            if _num(it.get("outPoint")):
                it["outPoint"] = _r6(it["inPoint"] + dur * v, it["outPoint"])
    return it


def _rebase_keyframes(it, offset, dur):
    kfs = it.get("keyframes")
    if not kfs or dur <= _EPS:
        return
    new = rebase(kfs, offset, dur)
    if new:
        it["keyframes"] = new
    else:
        it.pop("keyframes", None)


# ------------------------------------------------------------------ the carry


class _Carry:
    def __init__(self, project, track_index, new_items, tmap, fps, report):
        self.p = copy.deepcopy(project)
        self.ti = track_index
        self.new_items = new_items
        self.tm = tmap
        self.fps = fps or 30
        self.rep = report
        self.counts = {"linked": 0, "overlays": 0, "captionWords": 0, "audio": 0, "markers": 0, "notes": 0}
        self.taken = {it.get("id") for t in normalize_tracks(self.p).get("tracks", []) for it in t["items"]}
        self.taken |= {it.get("id") for it in new_items}

    def flag(self, kind, iid, **kw):
        self.rep.flagged.append({"kind": kind, "id": iid, **kw})

    def run(self):
        p = self.p
        p["tracks"] = replace_track_items(p, self.ti, copy.deepcopy(self.new_items))
        for i, t in enumerate(p["tracks"]):
            if i != self.ti:
                t["items"] = self.track(i, t)
        self.captions()
        self.audio()
        self.markers()
        self.notes()
        self.rep.carried = self.counts
        return p, self.rep

    # -------------------------------------------------------- tracks

    def track(self, ti, t):
        out = []
        for it in t["items"]:
            if not (_num(it.get("start")) and _num(it.get("end")) and it["end"] > it["start"]):
                out.append(it)
                continue
            partners = self.partners(it) if it.get("type") == "video" else []
            if partners:
                out.extend(self.pieces(it, partners))
                continue
            a, b = float(it["start"]), float(it["end"])
            sp = _carry_span(self.tm, a, b)
            if sp is None:
                self.flag("overlay_removed", it.get("id"), src=it.get("src"))
                continue
            _apply_span(it, sp)
            if sp.moved:
                self.flag("overlay_moved", it.get("id"), **{"from": round(a, 2), "to": round(it["start"], 2)})
            if sp.clipped:
                self.flag("overlay_clipped", it.get("id"))
            self.counts["overlays"] += 1
            out.append(it)
        return self.fix_overlaps(ti, t.get("id"), out)

    @staticmethod
    def _layer_range(layer):
        v = _speed(layer)
        l_in = float(layer.get("inPoint", 0) or 0)
        l_out = float(layer["outPoint"]) if _num(layer.get("outPoint")) else l_in + (layer["end"] - layer["start"]) * v
        return l_in, l_out, v

    def partners(self, layer):
        """The old speech items a video layer is synced to (rule 1), or []."""
        key = self.tm._key(layer)
        l_in, l_out, v = self._layer_range(layer)
        off = float(layer["start"]) - l_in / v
        return [x for x in self.tm.old if x.key == key and x.v == v and min(l_out, x.s_out) - max(l_in, x.s_in) > _EPS
                and abs(off - (x.start - x.s_in / v)) < 1.0 / self.fps]

    def pieces(self, layer, partners):
        """Rule 1: the layer cut like the speech it is synced to. Each partner's plays continue as
        new items (lineage, `TimeMap._continues`); where one plays the layer's source range, a piece
        sits in sync with it. The part of the layer no partner played is not carried
        (`linked_clipped`): no speech held it in sync."""
        l_in, l_out, v = self._layer_range(layer)
        spans: dict = {}
        for x in partners:
            for _t0, _t1, n, p, q in self.tm._survive[id(x)]:
                lo, hi = max(l_in, p), min(l_out, q)
                if hi - lo > _EPS:
                    spans.setdefault(id(n), (n, []))[1].append([lo, hi])
        covered = sorted([max(l_in, x.s_in), min(l_out, x.s_out)] for x in partners)
        reach, missing = l_in, 0.0
        for lo, hi in covered:
            missing += max(0.0, lo - reach)
            reach = max(reach, hi)
        if missing + max(0.0, l_out - reach) > _EPS:
            self.flag("linked_clipped", layer.get("id"))
        out = []
        for n, ranges in sorted(spans.values(), key=lambda e: e[0].start):
            ranges.sort()
            merged = [ranges[0]]
            for lo, hi in ranges[1:]:
                if lo <= merged[-1][1] + _EPS:
                    merged[-1][1] = max(merged[-1][1], hi)
                else:
                    merged.append([lo, hi])
            for lo, hi in merged:
                out.append(self._piece(layer, n, lo, hi, l_in, l_out, v))
        out.sort(key=lambda it: (it["start"], it["end"]))
        if not out:
            self.flag("linked_removed", layer.get("id"), src=layer.get("src"))
            return []
        for k, piece in enumerate(out):
            piece["id"] = layer.get("id") if k == 0 else self.piece_id(layer.get("id"), k + 1)
        self.counts["linked"] += len(out)
        return out

    @staticmethod
    def _piece(layer, n, lo, hi, l_in, l_out, v):
        """The layer's source [lo, hi) placed in sync with new item n (unchanged when nothing moved)."""
        start, end = n.t_at(lo), n.t_at(hi)
        if lo == l_in and hi == l_out and n.v == v and abs(start - layer["start"]) < _MERGE_S \
                and abs(end - layer["end"]) < _MERGE_S:
            return copy.deepcopy(layer)
        piece = copy.deepcopy(layer)
        piece["start"], piece["end"] = round(start, 6), round(end, 6)
        piece["inPoint"], piece["outPoint"] = lo, hi
        if n.v != v:
            piece["speed"] = n.v                      # stay in sync with the speech it follows
        _rebase_keyframes(piece, (lo - l_in) / v, piece["end"] - piece["start"])
        return piece

    def piece_id(self, base, n):
        while f"{base}-s{n}" in self.taken:
            n += 1
        nid = f"{base}-s{n}"
        self.taken.add(nid)
        return nid

    def fix_overlaps(self, ti, tid, items):
        """The engine's bounded-overlap rule on one track: containment (not on tracks[0]) and three
        live at once are fixed by moving the later item's start to the earlier one's end."""
        timed = [it for it in items if _num(it.get("start")) and _num(it.get("end"))]
        for _ in range(len(timed) ** 2 + 2):
            hit = self._violation(ti, timed)
            if hit is None:
                return items
            b, to, others = hit
            if b["end"] - to <= _EPS:
                ids = ", ".join(str(x.get("id")) for x in sorted(others + [b], key=lambda x: (x["start"], x["end"])))
                fail("carry_conflict", f"{tid}: {ids} overlap after the edit; move or delete one, then apply again")
            a0 = b["start"]
            _apply_span(b, _Span(to, float(b["end"]), to - a0, True, False))
            self.flag("overlay_trimmed", b.get("id"), **{"from": round(a0, 2), "to": round(b["start"], 2)})
        fail("carry_conflict", f"{tid}: items overlap after the edit; move or delete one, then apply again")

    @staticmethod
    def _violation(ti, timed):
        """(later item, where its start must move, the earlier items it collides with) or None."""
        srt = sorted(timed, key=lambda x: (x["start"], x["end"]))
        for j, b in enumerate(srt):
            live = [a for a in srt[:j] if b["start"] < a["end"]]
            if ti != 0:
                inside = [a for a in live if (a["start"] <= b["start"] and a["end"] >= b["end"])
                          or (b["start"] <= a["start"] and b["end"] >= a["end"])]
                if inside:
                    return b, max(a["end"] for a in inside), inside
            if len(live) >= 2:
                return b, min(a["end"] for a in live), live
        return None

    # -------------------------------------------------------- captions

    def captions(self):
        caps = self.p.get("captions")
        if not isinstance(caps, dict) or not isinstance(caps.get("segments"), list):
            return
        segs = caps["segments"]
        taken = {s.get("id") for s in segs if isinstance(s, dict)}
        out, changed = [], False
        for seg in segs:
            if not isinstance(seg, dict):
                out.append(seg)
                continue
            parts = self.segment(seg, taken)
            if parts is None:
                self.flag("caption_removed", seg.get("id"), text=seg.get("text"))
                changed = True
                continue
            changed = changed or parts != [seg]
            out.extend(parts)
        made = self.new_speech_segments(taken) if segs else []
        if made:
            out.extend(made)
            changed = True
        if changed:
            out.sort(key=lambda s: s.get("start", 0) if isinstance(s, dict) else 0)
        caps["segments"] = out

    def segment(self, seg, taken):
        """The carried parts of one segment, or None when nothing of it survives."""
        words = seg.get("words")
        well_formed = isinstance(words, list) and words and all(
            isinstance(w, dict) and _num(w.get("start")) and _num(w.get("end")) for w in words)
        if not well_formed:
            if not (_num(seg.get("start")) and _num(seg.get("end")) and seg["end"] > seg["start"]):
                return [seg]
            sp = _carry_span(self.tm, float(seg["start"]), float(seg["end"]))
            if sp is None:
                return None
            seg["start"], seg["end"] = _r6(sp.start, seg["start"]), _r6(sp.end, seg["end"])
            return [seg]
        inst = []
        for j, w in enumerate(words):
            for sa, sb, ca, cb in self.tm.word_copies(float(w["start"]), float(w["end"])):
                inst.append((sa, sb, j, ca, cb))
        if not inst:
            return None
        inst.sort(key=lambda x: (x[0], x[2]))
        groups = [[inst[0]]]
        for x in inst[1:]:
            prev = groups[-1][-1]
            old_gap = float(words[x[2]]["start"]) - float(words[prev[2]]["end"])
            if x[2] <= prev[2] or (x[0] - prev[1]) - old_gap > CAPTION_SPLIT_GAP_S:
                groups.append([x])
            else:
                groups[-1].append(x)
        parts = []
        for k, g in enumerate(groups):
            part = copy.deepcopy(seg)
            new_words = []
            for sa, sb, j, _, _ in g:
                w = copy.deepcopy(words[j])
                w["start"], w["end"] = _r6(sa, words[j]["start"]), _r6(sb, words[j]["end"])
                new_words.append(w)
            part["words"] = new_words
            js = [x[2] for x in g]
            if js != list(range(len(words))):
                part["text"] = " ".join(str(w.get("word", "")) for w in new_words)
            f, l = g[0], g[-1]
            if _num(seg.get("start")):
                st = seg["start"] + (f[0] - words[0]["start"]) if f[2] == 0 and not f[3] else f[0]
                part["start"] = _r6(st, seg["start"])
            if _num(seg.get("end")):
                en = seg["end"] + (l[1] - words[-1]["end"]) if l[2] == len(words) - 1 and not l[4] else l[1]
                part["end"] = _r6(en, seg["end"])
            if k and seg.get("id") is not None:
                n = k + 1
                while f"{seg['id']}-{n}" in taken:
                    n += 1
                part["id"] = f"{seg['id']}-{n}"
                taken.add(part["id"])
            parts.append(part)
            self.counts["captionWords"] += len(new_words)
        return parts

    def new_speech_segments(self, taken):
        """Segments for speech the old cut never played, from the refined sidecar words."""
        ws = []
        for n, w in self.tm.unplayed_words():
            lo, hi = max(w.start, n.s_in), min(w.end, n.s_out)
            if hi - lo <= _EPS:
                continue
            ws.append({"word": w.text, "start": n.t_at(lo), "end": n.t_at(hi)})
        if not ws:
            return []
        ws.sort(key=lambda w: w["start"])
        made = group(ws)
        nums = [int(m.group(1)) for s in taken if isinstance(s, str) and (m := re.match(r"^cap-(\d+)$", s))]
        nxt = max(nums, default=0) + 1
        for seg in made:
            while f"cap-{nxt}" in taken:
                nxt += 1
            seg["id"] = f"cap-{nxt}"
            taken.add(seg["id"])
            self.counts["captionWords"] += len(seg["words"])
        return [{"id": s["id"], **{k: v for k, v in s.items() if k != "id"}} for s in made]

    # -------------------------------------------------------- audio

    def audio(self):
        au = self.p.get("audio")
        if not isinstance(au, dict) or not isinstance(au.get("tracks"), list):
            return
        tm = self.tm
        cut0, cut1 = tm.old_start, tm.old_end
        out = []
        for t in au["tracks"]:
            if not isinstance(t, dict):
                out.append(t)
                continue
            start = float(t["start"]) if _num(t.get("start")) else 0.0
            if _num(t.get("end")) and t["end"] > start:
                end_eff = float(t["end"])
            elif _num(t.get("outPoint")):
                end_eff = start + float(t["outPoint"]) - float(t.get("inPoint", 0) or 0)
            else:
                end_eff = None
            cover = min(end_eff if end_eff is not None else math.inf, cut1) - max(start, cut0)
            if cut1 - cut0 > _EPS and cover >= BED_SHARE * (cut1 - cut0) - _EPS:
                if self.bed(t, start, end_eff):
                    out.append(t)
                continue
            if end_eff is None:
                nt = tm.forward(start)
                if nt is None:
                    nt = tm.next_kept(start)
                    self.flag("audio_moved", t.get("id"), **{"from": round(start, 2), "to": round(nt, 2)})
                if abs(nt - start) > _EPS:
                    t["start"] = round(nt, 6)
                self.counts["audio"] += 1
                out.append(t)
                continue
            sp = _carry_span(tm, start, end_eff)
            if sp is None:
                self.flag("audio_removed", t.get("id"), src=t.get("src"))
                continue
            dur = sp.end - sp.start
            changed = abs(sp.start - start) > _EPS or abs(dur - (end_eff - start)) > _EPS or sp.offset > _EPS
            if changed:
                t["start"] = _r6(sp.start, t.get("start", 0))
                if _num(t.get("end")):
                    t["end"] = _r6(sp.end, t["end"])
                if sp.offset > _EPS or _num(t.get("inPoint")):
                    old_in = t.get("inPoint", 0) or 0
                    t["inPoint"] = _r6(float(old_in) + sp.offset, old_in)
                if _num(t.get("outPoint")):
                    t["outPoint"] = _r6(t["inPoint"] + dur, t["outPoint"])
            if sp.moved:
                self.flag("audio_moved", t.get("id"), **{"from": round(start, 2), "to": round(t["start"], 2)})
            if sp.clipped:
                self.flag("audio_clipped", t.get("id"))
            self.counts["audio"] += 1
            out.append(t)
        au["tracks"] = out

    def bed(self, t, start, end_eff):
        """A bed keeps its start; an end at or after the old end follows the new end. False: removed."""
        tm = self.tm
        d = tm.new_end - tm.old_end
        if d and (end_eff is None or end_eff >= tm.old_end - _EPS):
            if _num(t.get("end")) and t["end"] > start:
                t["end"] = round(t["end"] + d, 6)
                if t["end"] <= start + _EPS:
                    self.flag("audio_removed", t.get("id"), src=t.get("src"))
                    return False
            if _num(t.get("outPoint")):
                t["outPoint"] = round(max(float(t.get("inPoint", 0) or 0), t["outPoint"] + d), 6)
        if tm.changed:
            self.flag("bed_check_timing", t.get("id"))
        self.counts["audio"] += 1
        return True

    # -------------------------------------------------------- markers and notes

    def _point(self, t):
        """(new t, moved) for a point that is never removed."""
        nt = self.tm.forward(t)
        if nt is not None:
            return nt, False
        nt = self.tm.next_kept(t)
        return (nt if nt is not None else self.tm.new_end), True

    def markers(self):
        ms = self.p.get("markers")
        if not isinstance(ms, list):
            return
        changed = False
        for m in ms:
            if not isinstance(m, dict) or not _num(m.get("t")):
                continue
            nt, moved = self._point(float(m["t"]))
            new = _r6(nt, m["t"])
            if moved:
                self.flag("marker_moved", m.get("id"), **{"from": round(m["t"], 2), "to": round(new, 2)})
            changed = changed or new != m["t"]
            m["t"] = new
            self.counts["markers"] += 1
        if changed:
            ms.sort(key=lambda m: m.get("t", 0) if isinstance(m, dict) else 0)

    def notes(self):
        ns = self.p.get("notes")
        if not isinstance(ns, list):
            return
        changed = False
        for n in ns:
            if not isinstance(n, dict) or not _num(n.get("t")):
                continue
            a = float(n["t"])
            if _num(n.get("tEnd")) and n["tEnd"] > a:
                b = float(n["tEnd"])
                sp = _carry_span(self.tm, a, b)
                if sp is None:
                    nt, _ = self._point(a)
                    nt = _r6(nt, n["t"])
                    n["t"], n["tEnd"], moved = nt, nt, True
                else:
                    n["t"], n["tEnd"], moved = _r6(sp.start, n["t"]), _r6(sp.end, n["tEnd"]), sp.moved
            else:
                nt, moved = self._point(a)
                n["t"] = _r6(nt, n["t"])
            if moved:
                self.flag("marker_moved", n.get("id"), **{"from": round(a, 2), "to": round(n["t"], 2)})
            changed = changed or n["t"] != a
            self.counts["notes"] += 1
        if changed:
            ns.sort(key=lambda n: n.get("t", 0) if isinstance(n, dict) else 0)


def carry(project, old_track_index, new_items, tmap, fps, *, report=None):
    """The project with the speech track (`old_track_index`) holding `new_items` and everything
    else carried through the edit (rules in the module docstring), and the report.

    report: the build's `Report`; carry's flags join its `flagged` list and the returned
    `CarryReport` adds `carried` counts. Refuses with `fail("carry_conflict", ...)` when an overlay
    track cannot be made valid. The input project is not mutated.
    """
    return _Carry(project, old_track_index, new_items, tmap, fps, CarryReport.extending(report)).run()
