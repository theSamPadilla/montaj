#!/usr/bin/env python3
"""Cut a talking-head project in two calls (§558): a plan, then its apply.

Without `plan`: transcribes any clip on the speech track that has no transcript (the only file it may write
beside a clip), runs the mechanical pass (layer 1 of lib/speech_energy, where the sound is, then rm_fillers
keeps, put on the timeline with jump_cut) in memory, chooses one take per section by the select-takes rules
(lib/take_select.py), and writes the result as an editable plan, cut-plan.md in the project folder, in speech_edit's text format: the kept
rows under `## Cut`, every removed row under `## Unused` tagged with why. Nothing in project.json changes.

With `plan` (that file, edited or not, or its text): rebuilds the same in-memory base from the same project
and transcripts (refusing a plan made from a speech track or transcripts that have changed since: the plan
carries speech_text's stamp of the base), and applies the plan through speech_edit's save path
(lib/speech_apply.apply): one guarded write, a version first, every other layer carried from the project as it
was. The write records the cut (`cleanCut`). With no usable speech, the plan removes silences only (waveform_trim
keeps through jump_cut). Each call prints one short JSON answer.
"""
import argparse, contextlib, copy, hashlib, io, json, os, re, shutil, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from common import fail, get_duration, DEFAULT_WHISPER_MODEL, WHISPER_MODEL_CHOICES
from ai_video import save_project_changes
from lib import project_revisions, speech_apply, speech_energy, speech_text, sync_clash, write_places
from lib.project_lock import project_lock_or_fail
from lib.project_tracks import normalize_tracks
from lib.project_versions import commit_version, is_own_repo
from lib.speech_apply import apply
from lib.speech_build import DEFAULT_FEEL, FEELS
from lib.speech_carry import TimeMap, carry
from lib.speech_lines import _ends_sentence, load_words, norm, sidecar_for
from lib.take_select import BREAK_GAP_S, Selection, Unit, phrase_retakes, select
from lib.speech_units import (FALLBACK_ERRORS, HESITATION_S, NON_MEDIA as _NON_MEDIA, UNIT_MAX_TOKENS,  # noqa: F401
                               build_units as _units, filler_test as _filler_test, find_track as _track,
                               install_sidecar as _install_sidecar, line_key as _line_key, media_items as _media,
                               quiet as _quiet, resolve_path as _resolve, resolved_item as _resolved,
                               sidecar_refusal as _sidecar_refusal, speech_track_id as _speech_track_id,
                               stem_clash as _stem_clash)
from lib import speech_units
from lib.speech_units import (DENSE_WINDOW_S, DENSE_WORDS, MADE_UP_MEDIAN_S, MIN_WORDS_PER_S,  # noqa: F401
                               NON_SPACED, ZERO_LENGTH_S, ZERO_SHARE, hardly_speech as _hardly_speech,
                               language_of as _language, made_up as _made_up,
                               mark_made_up_tails as _mark_made_up_tails)
from steps.audio import waveform_trim
from steps.edit import jump_cut
from steps.speech import rm_fillers
from steps.speech.transcribe import transcribe as transcribe_file

VERSION_MESSAGE = "version: before cut"
PLAN_FILE = "cut-plan.md"
PLAN_HELP = ("Edit, then run cut with plan: move a row from ## Unused into ## Cut to keep it, delete a row "
             "from ## Cut to drop it, move rows to reorder. A line cut at a silence is a row of its own. A * row is "
             "the whole of a trimmed row: put it in place of that row. A tag ending in ? is a suggestion, not made: "
             "retake? and false-start? rows are still in ## Cut (delete them there to take it); a repeat?, "
             "restart?, abandoned?, inaudible? or spliced group is the take trimmed (it replaces that take's rows in "
             "## Cut). A * row tagged inaudible? holds the video's first or last word, too soft to play: put it in "
             "place of its row to keep it.")
# Why a row is in a plan's ## Unused.
WHYS = ("retake", "false-start", "repeat", "restart", "abandoned", "filler-only", "pause", "earlier", "inaudible")
REMOVED_CAP_BYTES = 1500
PREV_PLAN_FILE = "cut-plan.prev.md"
LOSES_MOST = 0.1            # warn when a clip keeps under this share of its length
# What the carry report flags about the other layers, by kind, in the answers.
LAYER_FLAGS = ("overlay_", "linked_", "caption_", "audio_", "marker_", "bed_check_timing")
# The marker a cut leaves on the project, written in the same guarded write as the cut. A project carrying it
# is not cut again unless `recut` is passed: a second pass would cut the first pass's output.
MARKER_KEY = "cleanCut"
STEP_VERSION = 1
TEXT_CAP_BYTES = 3000
SILENCE_THRESHOLD_DB = -30.0  # waveform_trim's defaults
SILENCE_MIN_S = 0.3


def _load(project_path):
    with open(project_path, encoding="utf-8") as f:
        return json.load(f)



def _transcribe_missing(project, track_id, project_path, project_dir, model, language):
    """lib/speech_units.transcribe_missing with this module's transcriber (looked up at call time)."""
    return speech_units.transcribe_missing(project, track_id, project_path, project_dir, model, language, transcribe_file)


def _window(item, src):
    if "inPoint" in item and "outPoint" in item:
        return float(item["inPoint"]), float(item["outPoint"])
    return 0.0, float(item.get("sourceDuration") or get_duration(src))


def _seconds(track, project_dir):
    total = 0.0
    for it in _media(track):
        lo, hi = _window(it, _resolve(it["src"], project_dir))
        total += max(0.0, hi - lo) / float(it.get("speed") or 1)
    return total


def _cuttable(item):
    return item.get("speed", 1) == 1 and not item.get("keyframes") and not item.get("loop")


def _window_has(keeps, lo, hi):
    return any(min(e, hi) - max(s, lo) >= 0.05 for s, e in keeps)


def _in_window(keeps, lo, hi):
    """The keeps clipped to the clip's window: jump_cut refuses a keep wholly outside it (a clip already cut)."""
    return [[max(s, lo), min(e, hi)] for s, e in keeps if min(e, hi) - max(s, lo) > 0]


def _cut(work, project_path, ti, cid, src, keeps, lineage):
    """jump_cut one clip in memory; each new piece's lineage is the clip it came from (as on disk)."""
    before = {x["id"] for x in work["tracks"][ti]["items"]}
    jump_cut.cut_clip(work, project_path, cid, spec={"input": src, "keeps": keeps}, track_index=ti)
    origin = lineage.get(cid, cid)
    for x in work["tracks"][ti]["items"]:
        if x["id"] not in before:
            lineage[x["id"]] = origin


def _mechanical(work, project_path, ti, project_dir, fillers, lineage, whole=None, filler_spans=None, refiner=None,
                guard=None, held=None):
    """The mechanical pass per clip, in memory, put on the timeline with jump_cut: layer 1's keeps (lib/speech_energy:
    where the sound is, its silences over max-pause cut to their breaths), then rm_fillers cuts each filler word's
    placed span (its own voiced frames). fillers: rm_fillers' compiled pattern. A clip whose words are made up or
    too few to be speech (b-roll) is left whole and added to `whole`. filler_spans: {source: [(start, end)]} of the
    filler words cut, for removed.by. refiner: cut's speech_energy.Refiner. guard(item id, source start, source
    end) -> True when cutting that span of the item would move a layer's start (an overlay) onto another's (D2):
    that silence is kept whole, and its time on the timeline added to `held`. (filler words removed, warnings)."""
    removed, warnings = 0, []
    ids = [it["id"] for it in _media(work["tracks"][ti])]
    for cid in ids:
        it = next(x for x in work["tracks"][ti]["items"] if x["id"] == cid)
        r = _resolved(it, project_dir)
        sidecar = sidecar_for(r)
        if not sidecar:
            continue
        if not _cuttable(it):
            warnings.append(f"no filler or pause cut on {cid}: it has keyframes, a speed change or a loop")
            continue
        words = [{"text": w.text, "start": w.start, "end": w.end} for w in load_words(sidecar)]
        if not words:
            continue
        lo, hi = _window(it, r["src"])
        inside = [w for w in words if lo <= (w["start"] + w["end"]) / 2 < hi]
        span = max(hi - lo, 1e-6)
        if _made_up(inside) or _hardly_speech(inside, span):
            warnings.append(f"kept {cid} whole: its words do not look like speech (b-roll?)")
            if whole is not None:
                whole.add(cid)
            continue
        raw = load_words(sidecar)
        placed, _, _ = refiner(r["src"], speech_text._media_for(r, sidecar), raw)
        if guard is not None:
            for n, (s0, s1) in enumerate(refiner.silences(r["src"])):
                a, b = max(lo, s0 + refiner.breath), min(hi, s1 - refiner.breath)
                if b - a > 1e-6 and guard(cid, a, b):
                    refiner.hold(r["src"], n)
                    if held is not None:
                        held.append(f"{float(it.get('start', 0)) + s0 - lo:.1f} s")
        keeps = [list(k) for k in refiner.keeps(r["src"])]
        # sound before the clip's first word or after its last belongs to no word (layer 2): not speech; sound in the
        # first word's whisper span before its placement (the last's after it) is that word's, drifted
        mine = [(w, p) for w, p in zip(raw, placed) if lo <= (p.start + p.end) / 2 < hi]
        if mine:
            first, last = min(mine, key=lambda x: x[1].start), max(mine, key=lambda x: x[1].end)
            w0 = min(first[1].start, first[0].start) - refiner.breath
            w1 = max(last[1].end, last[0].end if any(c.isalnum() for c in last[0].text) else 0.0) + refiner.breath
            keeps = [[max(a, w0), min(b, w1)] for a, b in keeps if min(b, w1) - max(a, w0) > 1e-6]
        placed_words = [{"text": w.text, "start": p.start, "end": p.end} for w, p in zip(raw, placed)]
        if mine:                   # rm_fillers snaps the head to the first word: to its drifted sound too
            k0 = next(n for n, (w, p) in enumerate(zip(raw, placed)) if p is first[1])
            placed_words[k0]["start"] = min(placed_words[k0]["start"], first[0].start)
        keeps, cuts, _ = rm_fillers.spec_keeps(keeps, placed_words, fillers)
        if not _window_has(keeps, lo, hi):
            continue
        removed += sum(1 for c in cuts if lo <= (c["start"] + c["end"]) / 2 < hi)
        if filler_spans is not None:
            filler_spans.setdefault(_resolve(it["src"], project_dir), []).extend((c["start"], c["end"]) for c in cuts)
        clipped = _in_window(keeps, lo, hi)
        if sum(e - s0 for s0, e in clipped) < LOSES_MOST * span:
            kept_share = round(100 * sum(e - s0 for s0, e in clipped) / span)
            warnings.append(f"{cid} keeps only {kept_share}% of its length")
        _cut(work, project_path, ti, cid, it["src"], clipped, lineage)
    return removed, warnings


def _silence_cut(work, project_path, ti, project_dir, lineage, untranscribed_only=False):
    """waveform_trim keeps per clip through jump_cut, in memory (every clip, or only those with no transcript).
    Returns warnings."""
    warnings = []
    for cid in [it["id"] for it in _media(work["tracks"][ti])]:
        it = next(x for x in work["tracks"][ti]["items"] if x["id"] == cid)
        if untranscribed_only and sidecar_for(_resolved(it, project_dir)):
            continue
        if not _cuttable(it):
            warnings.append(f"no silence cut on {cid}: it has keyframes, a speed change or a loop")
            continue
        src = _resolve(it["src"], project_dir)
        ok, spec = _quiet(waveform_trim.process_one, src, SILENCE_THRESHOLD_DB, SILENCE_MIN_S)
        if not ok:
            warnings.append(f"no silence cut on {cid}: {spec.get('message', spec.get('error', ''))}"[:300])
            continue
        lo, hi = _window(it, src)
        if not _window_has(spec["keeps"], lo, hi):
            continue
        _cut(work, project_path, ti, cid, it["src"], _in_window(spec["keeps"], lo, hi), lineage)
    return warnings


def _origin(disk, track_id, project_dir):
    """The disk project with the speech track's fresh clips (no inPoint/outPoint yet, as project creation
    leaves them) laid end to end over their whole source, the timeline jump_cut cuts them from. The project
    the other layers are carried from; never written."""
    origin = normalize_tracks(copy.deepcopy(disk))
    _, track = _track(origin, track_id)
    shift = 0.0
    for it in sorted(track["items"], key=lambda x: float(x.get("start", 0))):
        if "start" in it:
            it["start"] = round(float(it["start"]) + shift, 6)
        if "end" in it:
            it["end"] = round(float(it["end"]) + shift, 6)
        if it in _media(track) and not ("inPoint" in it and "outPoint" in it):
            dur = float(it.get("sourceDuration") or get_duration(_resolve(it["src"], project_dir)))
            it["inPoint"], it["outPoint"] = 0.0, dur
            it["end"] = round(float(it["start"]) + dur, 6)
            shift += dur
    return origin


def _carried(origin, work, ti, lineage, project_dir):
    """`origin` with the speech track replaced by work's, every other layer carried through speech_carry by
    the one map from origin's speech track to work's (the silence path; speech mode carries inside apply)."""
    items = work["tracks"][ti]["items"]
    prov = {it["id"]: {"old_id": lineage.get(it["id"], it["id"])} for it in items}
    fps = (origin.get("settings") or {}).get("fps") or 30
    tmap = TimeMap(origin["tracks"][ti]["items"], items, prov, project_dir=project_dir)
    candidate, report = carry(origin, ti, items, tmap, fps)
    return candidate, report.as_dict()


# ── units: one spoken sentence each ──────────────────────────────────────────

# ── the edited text ──────────────────────────────────────────────────────────

def _other_row(r):
    if r.kind == "gap":
        return f"-- gap {r.dur:.2f}"
    if r.kind in ("nospeech", "notranscript"):
        what = "no speech" if r.kind == "nospeech" else "no transcript"
        return f"-- {r.label} {r.t0:.2f}-{r.t1:.2f} {what}"
    return f"-- image {r.label} {r.dur:.2f}"


def _trimmed(row, drop):
    """The row without the word positions in `drop` (its own positions), pause markers kept where their
    words are."""
    keep = [k for k in range(len(row.words)) if k not in drop]
    if not keep:
        return None
    new_pos = {k: n for n, k in enumerate(keep)}
    pauses = {}
    for p, v in row.pauses.items():
        if p == len(row.words):
            pauses[len(keep)] = v
        elif p in new_pos:
            pauses[new_pos[p]] = v
    return speech_text.Row("speech", line=row.line, words=[row.words[k] for k in keep], pauses=pauses,
                           item_ids=row.item_ids, folded=row.folded)


# ── the plan ─────────────────────────────────────────────────────────────────

_WHY_ORDER = ("retake", "false-start", "repeat", "restart", "abandoned", "pause", "inaudible", "inaudible?")
SENTENCE_END_S = speech_energy.SENTENCE_END_S


def _first_why(whys):
    """Of the reasons a row or a take lost words, the one its tag names: a take rule first, then a made-up tail,
    then inaudible words."""
    whys = set(whys)
    return next((w for w in _WHY_ORDER if w in whys), next(iter(sorted(whys)), "repeat"))


def _row_line(row, star=False):
    body = speech_text._row_text(row)
    return f"{'*' if star else ''}{row.line}{' ' + body if body else ''}"


def _timer(origin, work, ti, lineage):
    """Seconds on the timeline as it is now (before the cut) of a base row's first word."""
    by_id = {it["id"]: it for it in origin["tracks"][ti]["items"]}
    base = {it["id"]: it for it in work["tracks"][ti]["items"]}

    def at(item_id, s):
        it = by_id.get(lineage.get(item_id, item_id)) or base.get(item_id)
        if it is None:
            return 0.0
        return max(0.0, float(it.get("start", 0)) + (s - float(it.get("inPoint", 0))) / float(it.get("speed") or 1))

    def of_source(src, s):
        for it in by_id.values():
            if it.get("src") == src and float(it.get("inPoint", 0)) <= s < float(it.get("outPoint", 0)):
                return at(it["id"], s)
        return None
    return at, of_source


def _kept_whole(row):
    """The row with every pause marked as set by the text, a hair over what was read, so the apply's cap leaves
    it and the source clamps it back: the clip plays whole."""
    return speech_text.Row("speech", line=row.line, words=row.words,
                           pauses={k: round(v + 0.01, 2) for k, v in row.pauses.items()},
                           item_ids=row.item_ids, folded=row.folded)


def _plan(d, title, units, trailing, sel, at, of_source, language, max_pause, project_dir, is_filler,
          whole=frozenset(), why_at=None, notes=None, breath=None):
    """The plan: speech_edit's text format. `## Cut` holds the kept rows in narrative order (each kept take at
    its section's first appearance, its repeated or restarted words deleted), each tagged [time]; `## Unused`
    every removed take, one group of rows per take (a blank line between), each row tagged [time why]. A row
    of a kept take that keeps some words is listed whole, marked `*`. Times are of the timeline as it is now.
    Line ids are the source's (lib/speech_lines), so the same transcript gives the same ids.
    Uncertain cuts (sel.suggest) are not made: the take stays in `## Cut` and `## Unused` offers the cut, tagged
    with a `?` reason. why_at: {unit: {word position: why}} for words a kept take lost to a rule of its own (a phrase
    retake): each trimmed row is tagged with the why of its first lost word. A silence the mechanical pass cut
    (layer 1, lib/speech_energy) is where one row ends and the next begins: the rows are the base's. A line whisper
    placed wholly in a silence (d.inaudible) is listed tagged inaudible. notes: {(unit, span): word} added to that
    suggestion's tag ("spliced"). breath: written in the header, so the apply rebuilds the same base. Returns (text,
    kept rows [(id, t, words)], removed takes [(id, t, words, why)], suggestions [(id, t, words, why?)])."""
    home = {ui: s_i for s_i, section in enumerate(sel.sections) for ui in section}
    for ui in range(len(units) - 1, -1, -1):
        if ui not in home:
            home[ui] = home.get(ui + 1, len(sel.sections) - 1)
    head = speech_text.render(d, title, "none").split("\n")
    cut_at = head.index("## Cut")
    meta = f"language {language} · max-pause {max_pause:.2f}" + (f" · breath {breath:.3f}" if breath is not None else "")
    out = [head[0], f"<!-- montaj cut plan v1 · {meta} -->",
           PLAN_HASH_LINE, f"<!-- {PLAN_HELP} -->"] + head[1:cut_at + 1] + [""]
    kept, groups = [], []          # groups: (t, why, [plan rows], answer words or None)

    def t_of(row):
        return round(at(row.item_ids[0], row.words[0].start), 1) if row.item_ids and row.words else 0.0

    def words(rows):
        return " ".join(w.text for r in rows for w in r.words)

    for s_i in range(len(sel.sections)):
        for ui in range(len(units)):
            if home[ui] == s_i:
                out += [_other_row(r) for r in units[ui][2]]
        ui = sel.kept[s_i]
        drop, pos, lost = sel.drop.get(ui, set()), 0, []
        mine_why = (why_at or {}).get(ui, {})
        unit_why = _first_why(mine_why.get(k, sel.why.get(ui, "repeat")) for k in drop)
        for _, row in units[ui][1]:
            mine = {k - pos for k in drop if pos <= k < pos + len(row.words)}
            row_why = _first_why(mine_why.get(k + pos, sel.why.get(ui, "repeat")) for k in mine) if mine else None
            pos += len(row.words)
            trimmed = _trimmed(row, mine) if mine else row
            if mine:
                lost.append(f"{_row_line(row, star=trimmed is not None)} [{t_of(row):.1f} {row_why}]")
            if trimmed is not None:
                if row.item_ids and row.item_ids[0] in whole:
                    trimmed = _kept_whole(trimmed)
                out.append(("row", trimmed, f" [{t_of(row):.1f}]"))
                kept.append((row.line, t_of(row), " ".join(w.text for w in trimmed.words)))
        if lost:
            gone = [w for k, w in enumerate(units[ui][0].words) if k in drop]
            groups.append((t_of(units[ui][1][0][1]), unit_why, lost,
                           (units[ui][1][0][1].line, " ".join(gone))))
    out += [_other_row(r) for r in trailing]
    out = [f"{_row_line(x[1])}{x[2]}" if isinstance(x, tuple) else x for x in out]

    for ui in sel.losers:
        rows = [r for _, r in units[ui][1]]
        why = sel.why.get(ui, "retake")
        groups.append((t_of(rows[0]), why, [f"{_row_line(r)} [{t_of(r):.1f} {why}]" for r in rows],
                       (rows[0].line, words(rows))))
    inaudible = getattr(d, "inaudible", None) or set()
    for ln in d.unused:
        if not ln.words:
            continue
        letter = _line_key(ln.id)[0]
        silent = [w for w in ln.words if (letter, w.idx) in inaudible]
        if ln.id in d.partly and not silent:
            continue        # a line partly in the cut lost only fillers, which the counts carry
        src = next((s for s, lt in d.letters.items() if lt == letter), None)
        src = src if src is None or os.path.isabs(src) else os.path.join(project_dir, src)
        t = of_source(src, ln.words[0].start) if src else None
        text = " ".join(w.text for w in ln.words)
        if t is None and not silent:
            # not on the timeline before this cut either (an earlier cut took it): listed to restore, not counted
            groups.append((float("inf"), "earlier", [f"{ln.id} {text} [earlier]"], None))
            continue
        t = 0.0 if t is None else t
        if silent:
            # whisper put these words wholly in a silence the mechanical pass cut: the line (the whole of it, `*`,
            # when some of it plays) tagged inaudible, to put back in its row's place
            star = "*" if ln.id in d.partly else ""
            groups.append((round(t, 1), "inaudible", [f"{star}{ln.id} {text} [{t:.1f} inaudible]"],
                           (ln.id, " ".join(w.text for w in silent))))
            continue
        why = "filler-only" if all(is_filler(w.norm) for w in ln.words if w.norm) else "pause"
        groups.append((round(t, 1), why, [f"{ln.id} {text} [{t:.1f} {why}]"], (ln.id, text)))
    groups.sort(key=lambda g: (g[0], g[2][0]))
    out += ["", "## Unused"]
    for _, _, rows, _ in groups:
        out += [""] + rows
    removed = [(ans[0], t, ans[1], why) for t, why, _, ans in groups if ans is not None]
    suggested = []
    for ui, span, why in sel.suggest:
        note = (notes or {}).get((ui, span))
        why = f"{why} {note}" if note else why
        rows = [r for _, r in units[ui][1]]
        drop, pos, lines = set(sel.drop.get(ui, set())) | set(span or ()), 0, []
        for row in rows:
            mine = {k - pos for k in drop if pos <= k < pos + len(row.words)}
            pos += len(row.words)
            trimmed = _trimmed(row, mine) if mine else row
            if trimmed is not None:
                lines.append(f"{_row_line(trimmed)} [{t_of(row):.1f} {why}]")
        if span:
            text = " ".join(w for k, w in enumerate(units[ui][0].words) if k in span)
        else:
            text = " ".join(w for k, w in enumerate(units[ui][0].words) if k not in drop)
        other = getattr(sel, "partner", {}).get(ui)
        if other is not None and units[other][1] and not why.startswith("inaudible"):
            # where the other take is, so the offer is decided in one edit (§558): its line id and time
            first = units[other][1][0][1]
            where = f" {first.line} {t_of(first):.1f}"
            why = why + where
            lines = [ln[:-1] + where + "]" for ln in lines]
        suggested.append((t_of(rows[0]), why, lines, (rows[0].line, text)))
    if suggested:
        groups2 = sorted(suggested, key=lambda g: (g[0], g[2][0] if g[2] else ""))
        for _, _, rows, _ in groups2:
            out += [""] + rows
    return (_seal("\n".join(out) + "\n"), kept, removed,
            [(ans[0], t, ans[1], why) for t, why, _, ans in sorted(suggested, key=lambda g: g[0])])


_TAG = re.compile(r"\s\[(\d+(?:\.\d+)?)?(?:\s?(" + "|".join(WHYS) + r")(\?)?(?:\sspliced)?(?:\s\S+\s\d+(?:\.\d+)?)?)?\]\s*$")


PLAN_HASH_LINE = "<!-- plan hash - -->"
_HASH_RE = re.compile(r"<!-- plan hash ([0-9a-f]{12}) -->")


def _seal(text):
    """The plan with its own hash in it, so a later run can tell an unedited plan from an edited one."""
    h = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    return text.replace(PLAN_HASH_LINE, f"<!-- plan hash {h} -->", 1)


def _unedited(text):
    """The plan is as cut wrote it: its sealed hash still matches."""
    m = _HASH_RE.search(text)
    if not m:
        return False
    return hashlib.sha256(text.replace(m.group(0), PLAN_HASH_LINE, 1).encode("utf-8")).hexdigest()[:12] == m.group(1)


def _plan_hash(text):
    """The hash of the plan as the apply reads it (tags gone): two plans that apply the same edit match."""
    return hashlib.sha256(_untagged(text)[0].encode("utf-8")).hexdigest()[:12]


def _plan_meta(text):
    """(language, max-pause, breath) from a plan's second comment, or Nones (breath: None in a plan without it)."""
    for raw in text.splitlines()[:4]:
        m = re.match(r"^<!--\s*montaj cut plan v1 · language (\S+) · max-pause (\d+(?:\.\d+)?)"
                     r"(?: · breath (\d+(?:\.\d+)?))?\s*-->\s*$", raw.strip())
        if m:
            return m.group(1), float(m.group(2)), (float(m.group(3)) if m.group(3) else None)
    return None, None, None


def _untagged(text):
    """The plan as speech_edit reads it: the [time why] tags gone. Returns (text, {why: takes left in Unused}),
    a take being a group of rows between blank lines."""
    out, section, why_left, group = [], None, {}, set()

    def close():
        for why in group:
            if why != "earlier":
                why_left[why] = why_left.get(why, 0) + 1
        group.clear()
    for raw in text.splitlines():
        s = raw.strip()
        if s.startswith("## "):
            close()
            section = s[3:].strip().lower()
        elif not s:
            close()
        m = _TAG.search(raw) if (s and not s.startswith(("<!--", "#", "--"))) else None
        if m:
            if section == "unused" and m.group(2) and not m.group(3):
                group.add(m.group(2))
            raw = raw[:m.start()]
        out.append(raw)
    close()
    return "\n".join(out) + "\n", why_left


def _read_plan(value, project_dir):
    """The plan text: the path of a plan file inside the project folder, or the plan itself."""
    if value.lstrip().startswith("<!--"):
        return value
    path = os.path.abspath(_resolve(value, project_dir))
    if not write_places.within(write_places.real(path), write_places.real(project_dir)) or not os.path.isfile(path):
        fail("invalid_params", "plan must be the plan's text, or the path of a plan file in the project folder")
    with open(path, encoding="utf-8") as f:
        return f.read()


def _write_plan(project_path, project_id, text):
    """Write cut-plan.md in the project folder; with Studio sync on, checked against the open clashes under
    the project lock and written in the same hold (as speech_text writes speech-text.md)."""
    project_dir = os.path.dirname(project_path)
    out_path = os.path.join(project_dir, PLAN_FILE)

    def write():
        """A plan already there that cut wrote and nobody edited is replaced. An edited one (or a link) is kept:
        as cut-plan.prev.md, or, when that holds another edit, as cut-plan.prev-<UTC time>.md, so no edit is
        lost. The new plan lands by a rename of a new temp file, so a link at either name is replaced, never
        followed. Returns the path an edited plan was kept at, or None."""
        kept_at = None
        if os.path.lexists(out_path):
            old = None
            if not os.path.islink(out_path) and os.path.isfile(out_path):
                with open(out_path, encoding="utf-8", errors="replace") as f:
                    old = f.read()
            if old == text:
                return None
            if old is None or not _unedited(old):
                kept_at = os.path.join(project_dir, PREV_PLAN_FILE)
                if os.path.lexists(kept_at):
                    prev = None
                    if not os.path.islink(kept_at) and os.path.isfile(kept_at):
                        with open(kept_at, encoding="utf-8", errors="replace") as f:
                            prev = f.read()
                    if prev != old:
                        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
                        kept_at = os.path.join(project_dir, f"cut-plan.prev-{stamp}.md")
                os.replace(out_path, kept_at)
        tmp = os.path.join(project_dir, f"{PLAN_FILE}.tmp-{os.getpid()}")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(text)
            os.replace(tmp, out_path)
        finally:
            if os.path.lexists(tmp):
                os.remove(tmp)
        return kept_at
    if not sync_clash.state_dir():
        return out_path, write()
    with project_lock_or_fail(project_path, fail):
        try:
            sync_clash.check_step_write(project_id, files=[PLAN_FILE, PREV_PLAN_FILE, "cut-plan.prev-"])
        except sync_clash.SyncConflict as e:
            sync_clash.exit_refused(e.body)
        return out_path, write()


# ── the answer ───────────────────────────────────────────────────────────────

def _capped(lines, cap):
    out, size = [], 0
    for n, line in enumerate(lines):
        if size + len(line.encode()) + 1 > cap:
            out.append(f"... {len(lines) - n} more")
            break
        out.append(line)
        size += len(line.encode()) + 1
    return "\n".join(out)


def _sums(final, track_id):
    _, track = _track(normalize_tracks(final), track_id)
    kept_s = sum(max(0.0, float(it.get("end", 0)) - float(it.get("start", 0))) for it in _media(track))
    duration = max((float(it.get("end", 0)) for it in track["items"]), default=0.0)
    return round(kept_s, 2), round(duration, 2)


def _layers(flagged):
    """{kind: n} of what the cut does to the other layers (overlay_removed, caption_removed, ...)."""
    out = {}
    for f in flagged or []:
        kind = f.get("kind", "")
        if kind.startswith(LAYER_FLAGS):
            out[kind] = out.get(kind, 0) + 1
    return out


def _audio_warnings(flagged):
    """One line for each audio track (music, an sfx, a bed) the cut moved or clipped. A cut never removes one:
    only the person or the AI deletes audio, so the answer names each, to check."""
    out = []
    for f in flagged or []:
        kind, iid = f.get("kind"), f.get("id")
        if kind == "audio_moved":
            out.append(f"Audio track {iid} moved from {f.get('from', 0):.2f} s to {f.get('to', 0):.2f} s: the cut "
                       "took its moment. Check it still fits, or delete it.")
        elif kind == "audio_clipped" and f.get("minimum"):
            out.append(f"Audio track {iid} would have ended before it starts: kept at {f.get('seconds', 0):.2f} s. "
                       "Check its length.")
        elif kind == "audio_clipped":
            out.append(f"Audio track {iid} was clipped by the cut. Check it still fits.")
    return out


def _tracks_rev(project):
    return project_revisions.revision_of(normalize_tracks(copy.deepcopy(project)).get("tracks"))


def _marker(mode, kept, removed, duration, max_pause, written, plan_stamp, plan_hash=None):
    """The record of a cut. tracksRev: the revision of the tracks it wrote, to tell a later change; planStamp:
    the stamp of the plan it applied, so the same plan is not applied twice."""
    return {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "maxPause": max_pause,
            "stepVersion": STEP_VERSION, "mode": mode, "kept": kept, "removed": removed,
            "duration": duration, "tracksRev": _tracks_rev(written), "planStamp": plan_stamp,
            "planHash": plan_hash}


def _has_clips(project, track_id):
    """Whether the speech track has footage to cut. A pending project's 0/0 placeholders (project creation's
    clips, before anyone opened it) count, since an AI plans on a project the person has not opened. After the
    status leaves pending, a clip counts only if it has length: "Edit it yourself" drops the placeholders."""
    track = next((t for t in normalize_tracks(copy.deepcopy(project)).get("tracks", []) if t.get("id") == track_id), None)
    if track is None:
        return False
    items = _media(track)
    if project.get("status") == "pending":
        return bool(items)
    return any(float(it.get("end", 0)) > float(it.get("start", 0)) for it in items)


def _already_cut(project):
    m = project[MARKER_KEY]
    out = {"project": project.get("id"), "mode": "already-cut", "cutAt": m.get("at"),
           "kept": m.get("kept"), "removed": m.get("removed"), "duration": m.get("duration"),
           "note": "Already cut. Pass recut to cut it again."}
    if m.get("tracksRev") and m["tracksRev"] != _tracks_rev(project):
        out["changedSince"] = True
        out["note"] = "Already cut, and the timeline changed since. Pass recut to cut it again."
    return out




# ── the run ──────────────────────────────────────────────────────────────────

def _build(project_path, project_dir, disk, track_id, language, warnings, max_pause=None, breath=speech_energy.BREATH_S):
    """The base: the disk project with the mechanical pass on its speech track, in memory, and everything the
    plan and its apply need. Deterministic for the same project, transcripts, max-pause and breath, so an apply
    rebuilds the base the plan was made from. b["held"]: the silences kept whole for the overlays (D2)."""
    # The base starts from the origin: fresh clips already laid over their whole source, as jump_cut lays them,
    # so a clip the mechanical pass leaves whole still has a window speech_text can read.
    origin = _origin(disk, track_id, project_dir)
    work = copy.deepcopy(origin)
    ti, track = _track(work, track_id)
    b = {"work": work, "ti": ti, "before_s": _seconds(track, project_dir),
         "origin": origin, "lineage": {}, "d": None, "fillers": 0,
         "refiner": speech_energy.Refiner(max_pause, breath), "filler_spans": {}, "held": []}
    has_words = any((sc := sidecar_for(_resolved(it, project_dir))) and load_words(sc) for it in _media(track))
    if has_words:
        is_filler = _filler_test(language)
        b["whole"] = set()
        at, _ = _timer(origin, work, ti, b["lineage"])
        b["fillers"], w = _mechanical(work, project_path, ti, project_dir, rm_fillers.filler_matcher(language),
                                      b["lineage"], b["whole"], b["filler_spans"], b["refiner"],
                                      _layer_guard(b, at), b["held"])
        b["refiner"].whole = b["whole"]          # clips kept whole: tidy leaves their pieces as they are
        warnings += w
        warnings += _silence_cut(work, project_path, ti, project_dir, b["lineage"], untranscribed_only=True)
        d = speech_text.derive(work, project_dir, track_id, refiner=b["refiner"])   # words where the audio is
        units, trailing = _units(d, is_filler)
        for u, rows, _ in units:
            # a clip kept whole (b-roll): its made-up words are never a take, a loser or a suggestion
            u.fixed = bool(rows) and all(r.item_ids and r.item_ids[0] in b["whole"] for _, r in rows)
        _faint(b["refiner"], d, units)
        # a tail goes on the audio's evidence only (every word inaudible), never on a word's length (B2)
        _mark_made_up_tails(units, d.inaudible, durations=False)
        if units:
            b.update(d=d, units=units, trailing=trailing)
            if language.split("-")[0].lower() in NON_SPACED:
                b["sel"] = Selection(kept=list(range(len(units))), sections=[[i] for i in range(len(units))])
                warnings.append(f"takes are not chosen for {language}: only silences and fillers are cut")
            else:
                b["sel"] = select([u for u, _, _ in units], is_filler)
                for ui in b["sel"].losers:
                    # made-up words on a quiet end go on the audio's evidence (every word inaudible): tagged so
                    # (review A should-fix 5), not as a pause
                    if units[ui][0].madeup and b["sel"].why.get(ui) == "pause":
                        b["sel"].why[ui] = "inaudible"
                _made_up_tails(b, speech_units.made_up_tail_words(units, d.inaudible, durations=False))
                _inaudible(b, units, d.inaudible)
                _phrases(b, units, is_filler)          # on the words still heard
                _edge_soft(b, units, d)
                _quiet_offers(b, units, d)
                _spliced(b, units)
            return b
    # no usable speech: waveform_trim keeps on a fresh copy
    work = copy.deepcopy(origin)
    b.update(work=work, lineage={}, fillers=0)
    warnings += _silence_cut(work, project_path, b["ti"], project_dir, b["lineage"])
    return b


FAINT_SHARE = 1 / 3         # a take this share of whose words are offered or inaudible never wins over an audible one


def _faint(ref, d, units):
    """P3-2: a unit whose words the energy pass offers (under the speech floor) or finds inaudible, FAINT_SHARE of
    them or more, is faint: lib/take_select never keeps it over a take of the same words that is heard."""
    low = {(d.letters[src], i) for src, idx in ref.quiet_words.items() if src in d.letters for i in idx} | d.inaudible
    for u, rows, _ in units:
        keys = [(_line_key(r.line)[0], w.idx) for _, r in rows for w in r.words if norm(w.text)]
        u.faint = bool(keys) and sum(1 for k in keys if k in low) >= FAINT_SHARE * len(keys)


def _phrases(b, units, is_filler):
    """The phrase rules (lib/take_select.phrase_retakes) on what the selection keeps: a sure retake's words join the
    unit's drop, tagged per word in b["why_at"]; the rest are offered."""
    sel = b["sel"]
    # the words' times as the take rules read them (before the silence trim, speech_text.take_span)
    times = [[speech_text.take_span(b["d"], _line_key(r.line)[0], w) for _, r in rows for w in r.words]
             for _, rows, _ in units]
    drops, offers = phrase_retakes([u for u, _, _ in units], sel, is_filler, times, pairs=b.setdefault("pairs", []))
    why_at = b.setdefault("why_at", {})
    for ui, pos in drops.items():
        sel.drop.setdefault(ui, set()).update(pos)
        why_at.setdefault(ui, {}).update(pos)
    # an offer select made inside words a phrase retake now removes is gone with them; a unit select already offers
    # a cut in keeps that one
    sel.suggest[:] = [o for o in sel.suggest if not (o[1] and set(o[1]) & set(drops.get(o[0], ())))]
    offered = {o[0] for o in sel.suggest}
    sel.suggest += [o for o in offers if o[0] not in offered]


def _made_up_tails(b, tails):
    """A made-up tail glued onto a kept line (lib/speech_units.made_up_tail_words, every word of it inaudible) goes,
    word for word, tagged inaudible (review A should-fix 5)."""
    sel, why_at = b["sel"], b.setdefault("why_at", {})
    for ui, pos in tails.items():
        if ui in sel.kept:
            sel.drop.setdefault(ui, set()).update(pos)
            why_at.setdefault(ui, {}).update({k: "inaudible" for k in pos})


def _edge_soft(b, units, d):
    """2b's (b), with the orchestrator's guard: the video's very first word and its very last, when soft (all its sound
    under the line) and peaking under speech_energy.GUARD_DB, is not played: it goes to ## Unused tagged inaudible?,
    and one move puts it back. A word the guard hears plays (its own burst)."""
    sel, ref, why_at = b["sel"], b["refiner"], b.setdefault("why_at", {})
    src_of = {letter: src for src, letter in d.letters.items()}
    order = [sel.kept[s] for s in range(len(sel.sections)) if not units[sel.kept[s]][0].fixed]
    if not order:
        return

    def keys(ui):
        return [(_line_key(r.line)[0], w.idx) for _, r in units[ui][1] for w in r.words]

    def soft(key):
        pk = ref.soft.get(src_of.get(key[0]), {}).get(key[1])
        return pk is not None and pk < speech_energy.GUARD_DB

    for ui, step in ((order[0], 1), (order[-1], -1)):
        ks, gone = keys(ui), sel.drop.get(ui, set())
        pos = [k for k in (range(len(ks)) if step > 0 else range(len(ks) - 1, -1, -1))
               if k not in gone and norm(units[ui][0].words[k])]
        hit = pos[:1] if pos and soft(ks[pos[0]]) else []
        for k in pos[len(hit):] if hit else pos:
            # a word with no sound of its own beside it (offered, folded) goes with it: it would open (or end)
            # the video on silence
            if ks[k][1] in ref.soundless.get(src_of.get(ks[k][0]), ()) and soft(ks[k]):
                hit.append(k)
            else:
                break
        if hit and len(hit) < len(pos):
            sel.drop.setdefault(ui, set()).update(hit)
            why_at.setdefault(ui, {}).update({k: "inaudible?" for k in hit})


def _inaudible(b, units, inaudible):
    """A kept word with no audible frame (lib/speech_energy) goes, word for word, tagged inaudible."""
    sel, why_at = b["sel"], b.setdefault("why_at", {})
    for ui in sel.kept:
        u, rows, _ = units[ui]
        if u.fixed:
            continue
        ws = [(_line_key(r.line)[0], w.idx) for _, r in rows for w in r.words]
        gone = sel.drop.get(ui, set())
        pos = {k for k, key in enumerate(ws) if key in inaudible and k not in gone}
        if pos:
            sel.drop.setdefault(ui, set()).update(pos)
            why_at.setdefault(ui, {}).update({k: "inaudible" for k in pos})


def _quiet_offers(b, units, d):
    """A kept word under the clip's floor but heard over the room (lib/speech_energy: quiet) is never removed, only
    offered: inaudible? (R2-Q2). One offer per unit, of all its quiet words (the whole unit: its row)."""
    sel, ref = b["sel"], b["refiner"]
    quiet = {(d.letters[src], i) for src, idx in ref.quiet_words.items() if src in d.letters for i in idx}
    for ui in sel.kept:
        u, rows, _ = units[ui]
        if u.fixed:
            continue
        ws = [(_line_key(r.line)[0], w.idx) for _, r in rows for w in r.words]
        gone = sel.drop.get(ui, set())
        pos = {k for k, key in enumerate(ws) if key in quiet and k not in gone}
        if pos:
            left = {k for k in range(len(ws)) if k not in gone and norm(u.words[k])}
            sel.suggest.append((ui, None if left <= pos else frozenset(pos), "inaudible?"))


def _spliced(b, units):
    """F2: a sure phrase retake keeps the last saying, but inaudible words took that saying's opening, so the words
    before the removed saying (the earlier take's opening) now lead into the later take: the line is spliced from
    two takes. That kept fragment is offered (retake?, noted spliced); nothing is changed."""
    sel, why_at, notes = b["sel"], b.get("why_at", {}), b.setdefault("notes", {})
    inaudible = getattr(b["d"], "inaudible", None) or set()
    for gone, said in b.get("pairs", []):
        if not gone or not said:
            continue
        ku, k0 = said[0]
        m, k = 0, k0 - 1
        while k >= 0 and why_at.get(ku, {}).get(k) == "inaudible":
            m, k = m + 1, k - 1
        # words whisper put wholly in a silence (layer 1 cut them with it) right before the saying took it too
        keys = [(_line_key(r.line)[0], w.idx) for _, r in units[ku][1] for w in r.words]
        if m == 0 and k0 < len(keys):
            lt, idx = keys[k0]
            while (lt, idx - 1 - m) in inaudible:
                m += 1
        eu, e0 = gone[0]
        if not m or eu not in sel.kept:
            continue
        left = [p for p in range(e0) if p not in sel.drop.get(eu, set()) and norm(units[eu][0].words[p])]
        frag = frozenset(left[-m:])
        if frag:
            sel.suggest.append((eu, frag, "retake?"))
            notes[(eu, frag)] = "spliced"
            if ku != eu:
                sel.partner.setdefault(eu, ku)


_CATEGORY = {"retake": "retake", "false-start": "retake", "repeat": "retake", "restart": "retake",
             "abandoned": "retake", "earlier": "retake", "inaudible": "inaudible", "inaudible?": "inaudible",
             "pause": "tail", "filler-only": "fillers"}


def _spans(project, ti, project_dir):
    """{source: [(inPoint, outPoint)]} of the media items of track ti."""
    out = {}
    for it in _media(normalize_tracks(copy.deepcopy(project))["tracks"][ti]):
        if "inPoint" in it and "outPoint" in it:
            out.setdefault(_resolve(it["src"], project_dir), []).append((float(it["inPoint"]), float(it["outPoint"])))
    return out


def _minus(a, b):
    """The parts of intervals a not in intervals b."""
    out = []
    for s0, e0 in a:
        cur = [(s0, e0)]
        for s1, e1 in b:
            cur = [p for x0, x1 in cur for p in ((x0, min(x1, s1)), (max(x0, e1), x1)) if p[1] - p[0] > 1e-6]
        out += cur
    return out


def _removed_by(b, final, project_dir, max_pause, units):
    """Seconds the cut removes, by cause: fillers (the filler words the mechanical pass cut, and filler-only lines),
    silence (the rest of the mechanical pass: layer 1's silences over max-pause cut to their breaths, the sound
    before a clip's first word and after its last, and every silence of a clip with no transcript), retake (every
    take rule), inaudible, tail (made-up words at a clip's end), and the silence the apply cuts between kept words:
    pause (what max-pause alone would take) and deadAir (the rest). Since v5 cuts silences in the mechanical pass,
    pause and deadAir hold only what a join across removed words trims. Plus the count of inaudible words removed. `final` may be the result as lifted (speech of an audio lane put in a track): only its
    track ti is read."""
    d, sel, ti = b["d"], b["sel"], b["ti"]
    origin, base, after = (_spans(p, ti, project_dir) for p in (b["origin"], b["work"], final))
    out = {"pause": 0.0, "deadAir": 0.0, "retake": 0.0, "inaudible": 0.0, "tail": 0.0, "fillers": 0.0, "silence": 0.0}
    for src, iv in origin.items():
        mech = _minus(iv, base.get(src, []))
        filler = sum(max(0.0, min(e, e1) - max(s0, s1)) for s0, e in mech for s1, e1 in b.get("filler_spans", {}).get(src, []))
        total = sum(e - s0 for s0, e in mech)
        out["fillers"] += min(filler, total)
        out["silence"] += total - min(filler, total)
    why = {}                                    # (letter, word index) -> why it went
    for ui in sel.losers:
        for _, r in units[ui][1]:
            for w in r.words:
                why[(_line_key(r.line)[0], w.idx)] = sel.why.get(ui, "retake")
    for ui, drop in sel.drop.items():
        at = (b.get("why_at") or {}).get(ui, {})
        ws = [(_line_key(r.line)[0], w.idx) for _, r in units[ui][1] for w in r.words]
        for k in drop:
            if k < len(ws):
                why[ws[k]] = at.get(k, sel.why.get(ui, "repeat"))
    words_of = {}
    for ln in d.lines.values():
        words_of.setdefault(_line_key(ln.id)[0], []).extend(ln.words)
    inaudible = 0
    for src, letter in d.letters.items():
        ws = sorted(words_of.get(letter, []), key=lambda w: w.idx)
        played = {w.idx for w in ws if why.get((letter, w.idx)) == "inaudible"}
        # words whisper put wholly in a silence: the mechanical pass cut their silence (layer 1)
        inaudible += len(played | {i for lt, i in getattr(d, "inaudible", ()) if lt == letter})
        gone = _minus(base.get(src, []), after.get(src, []))
        if not gone:
            continue
        cat = {w.idx: _CATEGORY.get(why.get((letter, w.idx)), "") for w in ws}
        edges = [0.0] + [t for w in ws for t in (w.start, w.end)] + [float("inf")]
        for n in range(len(edges) - 1):
            lo, hi = edges[n], edges[n + 1]
            cut = sum(max(0.0, min(e, hi) - max(s0, lo)) for s0, e in gone)
            if cut <= 1e-6:
                continue
            if n % 2 == 1:                       # inside word n // 2
                out[cat[ws[n // 2].idx] or "pause"] += cut
                continue
            left = cat.get(ws[n // 2 - 1].idx) if n // 2 >= 1 else None
            right = cat.get(ws[n // 2].idx) if n // 2 < len(ws) else None
            if left or right:                    # the silence beside a removed word goes with it
                out[left or right] += cut
                continue
            span = (min(hi, b["refiner"].end(src) or hi) - lo)
            capped = min(cut, max(0.0, span - max_pause))
            out["pause"] += capped
            out["deadAir"] += cut - capped
    return {k: round(v, 2) for k, v in out.items()}, inaudible


BREATH_MIN_S = 0.02
_TAKE_WHYS = ("retake", "repeat", "restart", "false-start", "abandoned")
SETTLE_ROUNDS = 4           # plan, preview, settle: slivers and a repeat the apply would play the other copy of
INAUDIBLE_WARN_SHARE = 0.2  # warn when a clip loses this share of its words (and INAUDIBLE_WARN_WORDS) as inaudible
INAUDIBLE_WARN_WORDS = 3


def _layer_guard(b, at):
    """guard(item id, source start, source end) for the mechanical pass (D2): a layer (an item of any other track)
    starts inside that span of the speech item, on the timeline as it is now. None when there are no layers."""
    import bisect
    origin, ti = b["origin"], b["ti"]
    starts = sorted(float(it["start"]) for i, t in enumerate(origin.get("tracks", [])) if i != ti
                    for it in t.get("items", []) if isinstance(it.get("start"), (int, float)))
    if not starts:
        return None

    def guard(item_id, s0, s1):
        t0, t1 = at(item_id, s0), at(item_id, s1)
        k = bisect.bisect_right(starts, t0 + 1e-6)
        return k < len(starts) and starts[k] < t1 - 1e-6
    return guard


def _settle(b, res, project_dir):
    """Fold what the preview shows back into the selection, so the plan says what the apply does. True when the
    plan must be made again:
    - words of a sliver the apply drops (lib/speech_energy.tidy: a piece with no voiced frame) are dropped in the
      plan too, tagged inaudible, so no orphan row is left between removed rows (never a heard word: R3-B2);
    - a unit whose phrase retake the apply would play (its row's words matched to the other copy of the repeat, #2
      should-fix 4) gets that cut back as an offer (repeat?), so the plan never says one copy and plays the other."""
    d, sel, units = b["d"], b["sel"], b["units"]
    why_at = b.setdefault("why_at", {})
    where = {}
    for ui in sel.kept:
        for k, (lt, idx) in enumerate((_line_key(r.line)[0], w.idx) for _, r in units[ui][1] for w in r.words):
            where[(lt, idx)] = (ui, k)
    again = False
    src_of = {letter: src for src, letter in d.letters.items()}
    for f in res.get("flagged") or []:
        if f.get("kind") != "sliver":
            continue
        heard = b["refiner"].heard.get(src_of.get(f["letter"]), set())
        for idx in f.get("idx", ()):
            if idx in heard:
                continue
            hit = where.get((f["letter"], idx))
            if hit and hit[1] not in sel.drop.get(hit[0], set()):
                sel.drop.setdefault(hit[0], set()).add(hit[1])
                why_at.setdefault(hit[0], {})[hit[1]] = "inaudible"
                again = True
    def take_drops(ui):
        """The positions a take rule (a repeat said again in the unit's own rows) drops in kept unit ui."""
        mine = why_at.get(ui, {})
        return sorted(k for k in sel.drop.get(ui, set()) if mine.get(k, sel.why.get(ui, "repeat")) in _TAKE_WHYS)
    units_hit = [ui for ui in sel.kept if take_drops(ui)]
    if not units_hit:
        return again
    d2 = speech_text.derive(res["_project"], project_dir, track=d.track_id, refiner=b["refiner"])
    letter_of = {d2.letters[src]: d.letters.get(src) for src in d2.letters}
    played = {(letter_of.get(_line_key(r.line)[0]), w.idx) for r in d2.cut if r.kind == "speech" for w in r.words}
    for ui in units_hit:
        keys = [(_line_key(r.line)[0], w.idx) for _, r in units[ui][1] for w in r.words]
        gone = [k for k in take_drops(ui) if k < len(keys)]
        if any(keys[k] in played for k in gone):
            for k in gone:
                sel.drop[ui].discard(k)
                why_at.get(ui, {}).pop(k, None)
            if not sel.drop[ui]:
                sel.drop.pop(ui)
            sel.suggest.append((ui, frozenset(gone), "repeat?"))
            again = True
    return again


def _plan_warnings(b, final, project_dir, held):
    """What the plan's answer warns, measured on the preview (after every pass): a clip that keeps under LOSES_MOST of
    its length, a clip that loses many words as inaudible, pauses kept for the overlays (D2), spliced lines (F2)."""
    out, ti = [], b["ti"]
    after = _spans(final, ti, project_dir)
    for it in _media(b["origin"]["tracks"][ti]):
        if "inPoint" not in it or it["id"] in b.get("whole", ()):
            continue
        src, lo, hi = _resolve(it["src"], project_dir), float(it["inPoint"]), float(it["outPoint"])
        if hi - lo <= 0:
            continue
        kept = sum(max(0.0, min(e, hi) - max(s0, lo)) for s0, e in after.get(src, []))
        if kept < LOSES_MOST * (hi - lo):
            out.append(f"{it['id']} keeps only {round(100 * kept / (hi - lo))}% of its length")
    d, units, why_at = b["d"], b["units"], b.get("why_at", {})
    lost, total, seen = {}, {}, set()
    for ui, (u, rows, _) in enumerate(units):
        if u.fixed:
            continue
        n = 0
        for _, r in rows:
            lt = _line_key(r.line)[0]
            total[lt] = total.get(lt, 0) + len(r.words)
            for w in r.words:
                seen.add((lt, w.idx))
                if why_at.get(ui, {}).get(n) == "inaudible":
                    lost[lt] = lost.get(lt, 0) + 1
                n += 1
    for lt, i in getattr(d, "inaudible", ()):            # cut with their silence, never played: in no take
        if (lt, i) not in seen:
            lost[lt] = lost.get(lt, 0) + 1
            total[lt] = total.get(lt, 0) + 1
    names = {letter: os.path.basename(src) for src, letter in d.letters.items()}
    for lt, n in sorted(lost.items()):
        if n >= INAUDIBLE_WARN_WORDS and n >= INAUDIBLE_WARN_SHARE * total.get(lt, 1):
            out.append(f"{names.get(lt, lt)} loses {n} of {total[lt]} words as inaudible: check the inaudible rows")
    if held:
        out.append(f"kept {len(held)} pause(s) where an overlay starts, so no two overlays meet: {', '.join(held[:8])}")
    spliced = sorted({units[ui][1][0][1].line for ui, _ in b.get("notes", {})})
    if spliced:
        out.append(f"spliced from two takes (offered, retake? spliced): {', '.join(spliced[:8])}")
    return out


def _piece_warnings(d, flagged, slivers=True):
    """What tidy (lib/speech_energy) did to the kept pieces, for an answer: islands it kept short (a heard word it
    could not join or widen, P3-1) and, with `slivers`, short pieces of no heard word it dropped (R3-B2)."""
    line_of = {(_line_key(ln.id)[0], w.idx): ln.id for ln in d.lines.values() for w in ln.words}
    out = []
    for kind, say in (("island", "kept {n} short piece(s) with a heard word, under {s:.2f} s: {w}"),
                      ("sliver", "dropped {n} short piece(s) with no heard word: {w}"),
                      ("wordless", "dropped {n} short piece(s) of sound with no word: {w}")):
        if kind == "sliver" and not slivers:
            continue
        hits = [f for f in flagged or [] if f.get("kind") == kind]
        if hits:
            where = [f"{f['letter']} at {f['at']:.2f} s" if kind == "wordless" else
                     f"{line_of.get((f['letter'], (f.get('idx') or [None])[0]), f['letter'])} {f['seconds']:.2f} s"
                     for f in hits]
            out.append(say.format(n=len(hits), s=speech_energy.ISLAND_S, w=", ".join(where[:8])))
    return out


def _layer1_warnings(b):
    """What layer 1 says for an answer: pieces of sound with no word it dropped (L-B4), and a room so loud its pauses
    can't be trimmed (review B should-fix 2)."""
    ref, out = b["refiner"], []
    letters = b["d"].letters if b.get("d") is not None else {}
    hits = [f"{letters.get(src, os.path.basename(src))} at {a:.2f} s" for src, iv in ref.dropped.items() for a, _ in iv]
    if hits:
        out.append(f"dropped {len(hits)} short piece(s) of sound with no word: {', '.join(hits[:8])}")
    for src, speech, room in ref.loud_room():
        out.append(f"the room is loud in {os.path.basename(src)} ({speech - room:.0f} dB under the speech): its pauses "
                   "can't be trimmed")
    return out


def _played_mismatch(b, res, project_dir, text):
    """The backstop (review A-B1): the plan's rows against what its preview plays, word for word, in source words:
    the kept rows' words (as the apply reads them) that do not play, and the words that play but no kept row holds.
    Returns a short description of the first mismatch, or None."""
    d = b["d"]
    header, rows = speech_text.parse(_untagged(text)[0])
    want = set()
    by_line = {ln.id: ln for ln in d.lines.values()}
    for r in rows:
        if r.kind != "speech" or not r.tokens or r.line not in by_line:
            continue
        ln = by_line[r.line]
        toks = [norm(t) for t in r.tokens]
        ws = [w for w in ln.words if norm(w.text)]
        k = 0
        for w in ws:                       # the row's words in its line, in order
            if k < len(toks) and norm(w.text) == toks[k]:
                want.add((r.letter, w.idx))
                k += 1
    d2 = speech_text.derive(res.get("_lifted", res["_project"]), project_dir, track=d.track_id, refiner=b["refiner"])
    letter_of = {d2.letters[src]: d.letters.get(src) for src in d2.letters}
    played = {(letter_of.get(_line_key(r.line)[0]), w.idx) for r in d2.cut if r.kind == "speech"
              for w in r.words if norm(w.text)}
    extra, missing = sorted(played - want), sorted(want - played)
    if extra or missing:
        return f"plays {extra[:3]} it does not keep, and keeps {missing[:3]} it does not play"
    return None


def _silence_stamp(b, track_id):
    items = b["work"]["tracks"][b["ti"]]["items"]
    rows = [[os.path.basename(it.get("src") or ""), it.get("inPoint"), it.get("outPoint"), it.get("start"), it.get("end")]
            for it in sorted(items, key=lambda x: float(x.get("start", 0)))]
    blob = json.dumps([track_id, rows], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:12]


def _silence_plan(b, track_id, title, marker):
    _, track = _track(b["work"], track_id)
    rows = [f"-- {os.path.basename(it['src'])} {float(it.get('inPoint', 0)):.2f}-{float(it.get('outPoint', 0)):.2f} keep"
            for it in _media(track)]
    return _seal("\n".join([f"<!-- montaj cut plan v1 · silence · track {track_id} · stamp {_silence_stamp(b, track_id)} · "
                            f"marker {'yes' if marker else 'no'} -->", PLAN_HASH_LINE, f"# {title}", "",
                            "No usable speech: this plan removes silences only. Apply it as it is.", "", "## Cut", "",
                            *rows]) + "\n")


_SILENCE_HEADER = re.compile(r"^<!--\s*montaj cut plan v1 · silence · track (\S+) · stamp (\S+) · marker (yes|no)\s*-->\s*$")


def main():
    parser = argparse.ArgumentParser(description="Plan, then apply, a clean cut of a talking-head project")
    parser.add_argument("--project", required=True, help="Absolute path to project.json")
    parser.add_argument("--plan", default=None, help="Apply this plan: its text, or the path of the plan file")
    parser.add_argument("--max-pause", type=float, default=None,
                        help="The longest pause kept as it is, in seconds; a longer silence is cut to its breaths")
    parser.add_argument("--breath", type=float, default=speech_energy.BREATH_S,
                        help="Seconds of a silence over max-pause kept on each side of the sound")
    parser.add_argument("--model", default=DEFAULT_WHISPER_MODEL, choices=list(WHISPER_MODEL_CHOICES),
                        help="Whisper model for clips with no transcript")
    parser.add_argument("--language", default=None, help="The speaker's language (e.g. es), or 'auto' (the default)")
    parser.add_argument("--recut", action="store_true", help="Plan again a project cut already cut")
    parser.add_argument("--detail", action="store_true", help="Also answer with the kept lines")
    args = parser.parse_args()

    project_path = os.path.abspath(args.project)
    if not os.path.isfile(project_path):
        fail("not_found", f"Project not found: {project_path}")
    project_dir = os.path.dirname(project_path)
    if not speech_units.valid_language(args.language):
        fail("invalid_params", "language is a code such as en, es, pt-BR, or auto.")
    if args.plan is not None:
        _apply_plan(args, project_path, project_dir)
    else:
        _make_plan(args, project_path, project_dir)


def _make_plan(args, project_path, project_dir):
    first = _load(project_path)
    if isinstance(first.get(MARKER_KEY), dict) and not args.recut:
        print(json.dumps(_already_cut(first), ensure_ascii=False))
        return
    track_id = _speech_track_id(first, project_dir)
    if not _has_clips(first, track_id):
        fail("no_clips", "No clips on the timeline. Place clips first (the footage is in the project's media), "
                         "then run cut.")
    _stem_clash(_track(normalize_tracks(first), track_id)[1], project_dir)
    transcribed, failed, warnings = _transcribe_missing(first, track_id, project_path, project_dir,
                                                        args.model, args.language or "auto")
    disk = _load(project_path)        # read again after the long part
    if isinstance(disk.get(MARKER_KEY), dict) and not args.recut:     # another run cut it meanwhile
        print(json.dumps(_already_cut(disk), ensure_ascii=False))
        return
    language = _language(args.language, _track(normalize_tracks(disk), track_id)[1], project_dir)
    max_pause = args.max_pause if args.max_pause is not None else FEELS[DEFAULT_FEEL].max_pause
    breath = min(max(args.breath, BREATH_MIN_S), max_pause / 2)       # R2-Q3
    title = disk.get("name") or disk.get("id") or os.path.basename(project_dir)
    b = _build(project_path, project_dir, disk, track_id, language, warnings, max_pause, breath)
    answer = {"project": disk.get("id"), "mode": "plan"}

    if b["d"] is None:
        candidate, rep = _carried(b["origin"], b["work"], b["ti"], b["lineage"], project_dir)
        kept_s, duration = _sums(candidate, track_id)
        path, prev = _write_plan(project_path, disk.get("id"), _silence_plan(b, track_id, title, marker=not failed))
        warnings[:0] = _audio_warnings(rep.get("flagged"))
        answer.update(plan=path, silence=True,
                      kept={"lines": 0, "seconds": kept_s},
                      removed={"seconds": (round(b["before_s"] - kept_s, 2) + 0.0)}, duration=duration,
                      layers=_layers(rep.get("flagged")),
                      note=("Transcription failed: the plan removes silences only." if failed else
                            "No usable speech: the plan removes silences only."))
    else:
        at, of_source = _timer(b["origin"], b["work"], b["ti"], b["lineage"])
        held = b["held"]
        for _ in range(SETTLE_ROUNDS + 1):        # the last round only checks the plan made after the others
            text, kept, removed, suggested = _plan(b["d"], title, b["units"], b["trailing"], b["sel"], at, of_source,
                                                   language, max_pause, project_dir, _filler_test(language),
                                                   b.get("whole", frozenset()), b.get("why_at"), b.get("notes"),
                                                   breath)
            res = apply(project_path, _untagged(text)[0], preview=True, max_pause=max_pause, feel=DEFAULT_FEEL,
                        base=b["work"], base_of=disk, want_project=True, carry_from=b["origin"], lineage=b["lineage"],
                        guard_keys=(MARKER_KEY,), refiner=b["refiner"])
            if not _settle(b, res, project_dir):
                break
        else:
            # the plan would not say what its apply does (R3 should-fix 2): never write one that may not
            fail("plan_unsettled", "cut could not settle its plan: each preview changed it again, so nothing was "
                                   "written. Run cut again, and report it if this repeats.")
        wrong = _played_mismatch(b, res, project_dir, text)
        if wrong:
            # every row plays exactly its own words (review A-B1's backstop): never write a plan that would not
            fail("plan_unsettled", f"cut's plan would not play what it says ({wrong}), so nothing was written. "
                                   "Report it, with the project.")
        warnings[:] = [w for w in warnings if " keeps only " not in w] + _plan_warnings(b, res["_project"], project_dir,
                                                                                         held) \
            + _piece_warnings(b["d"], res.get("flagged"), slivers=False) + _layer1_warnings(b)
        kept_s, duration = _sums(res["_project"], track_id)
        by_cause, inaudible = _removed_by(b, res["_project"], project_dir, max_pause, b["units"])
        path, prev = _write_plan(project_path, disk.get("id"), text)
        by, maybe = {}, {}
        for *_, why in removed:
            by[why] = by.get(why, 0) + 1
        for *_, why in suggested:
            maybe[why.split()[0]] = maybe.get(why.split()[0], 0) + 1      # its tag, without the place it names
        answer.update(plan=path, kept={"lines": len(kept), "seconds": kept_s},
                      removed={"lines": by, "fillers": b["fillers"], "seconds": (round(b["before_s"] - kept_s, 2) + 0.0),
                               "by": by_cause, "inaudible": inaudible},
                      duration=duration)
        if maybe:
            answer["suggested"] = maybe
        answer["layers"] = _layers(res.get("flagged"))
        warnings[:0] = _audio_warnings(res.get("flagged"))
        answer["cut"] = _capped([f"{i} {t:.1f} {txt} [{why}]" for i, t, txt, why in removed + suggested],
                                REMOVED_CAP_BYTES)
        if args.detail:
            answer["keep"] = _capped([f"{i} {t:.1f} {txt}" for i, t, txt in kept], TEXT_CAP_BYTES)
        warnings += [w for w in res.get("warnings", []) if w not in warnings]
    if b["d"] is None:
        answer["next"] = f'Apply: cut with plan "{path}".'
    else:
        answer["next"] = (f'Apply: cut with plan "{path}". To keep a removed line, move its row from ## Unused '
                          "into ## Cut. To take a ? suggestion: delete a retake? or false-start? row from ## Cut; "
                          "a repeat?, restart?, abandoned?, inaudible? or spliced group replaces that take's rows in "
                          "## Cut.")
    if prev:
        answer["previous"] = prev
    answer["transcribed"] = transcribed
    if warnings:
        answer["warnings"] = warnings[:5]
    print(json.dumps(answer, ensure_ascii=False))


def _apply_plan(args, project_path, project_dir):
    text = _read_plan(args.plan, project_dir)
    disk = _load(project_path)
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    sil = _SILENCE_HEADER.match(first)
    if sil:
        track_id, plan_stamp = sil.group(1), sil.group(2)
    else:
        header, _ = speech_text.parse(text)
        track_id, plan_stamp = header["track"], header["stamp"]
    marker = disk.get(MARKER_KEY)
    plan_hash = _plan_hash(text)
    if isinstance(marker, dict) and marker.get("planStamp") == plan_stamp and marker.get("planHash") == plan_hash:
        fail("already_applied", "This plan is already applied: there is nothing new in it to apply. "
                                "Edit it to change the cut.")
    _track(normalize_tracks(copy.deepcopy(disk)), track_id)
    plan_lang, plan_pause, plan_breath = _plan_meta(text)
    language = args.language or plan_lang or "en"
    asked_pause = plan_pause if args.max_pause is None else args.max_pause
    pause_off = plan_pause is not None and abs(asked_pause - plan_pause) > 1e-6
    breath_off = (plan_breath is not None and args.breath != speech_energy.BREATH_S
                  and abs(min(max(args.breath, BREATH_MIN_S), asked_pause / 2) - plan_breath) > 1e-6)
    if pause_off or breath_off:
        # the plan was made with another max-pause or breath: its base is another (review A should-fix 4)
        fail("stale_plan", "This plan was made with another max-pause or breath. Run cut again with them, or apply "
                           "it without them (your edited plan is kept).")
    max_pause = plan_pause if plan_pause is not None else (
        args.max_pause if args.max_pause is not None else FEELS[DEFAULT_FEEL].max_pause)
    breath = plan_breath if plan_breath is not None else min(max(args.breath, BREATH_MIN_S), max_pause / 2)
    warnings = []
    b = _build(project_path, project_dir, disk, track_id, language, warnings, max_pause, breath)
    stale = ("This plan was made before cut was updated, or the timeline changed. Run cut again (your edited plan "
             "is kept).")
    if not _has_clips(disk, track_id):
        stale += " There are no clips on the timeline now; place clips first."
    answer = {"project": disk.get("id"), "mode": "applied"}

    if sil:
        if b["d"] is not None or _silence_stamp(b, track_id) != plan_stamp:
            fail("stale_plan", stale)
        version, layers = _write_silence(project_path, project_dir, disk, b, track_id, max_pause,
                                         marker=sil.group(3) == "yes", warnings=warnings, plan_stamp=plan_stamp,
                                         plan_hash=plan_hash)
        wrote = "Nothing to cut." not in warnings
        final = _load(project_path)
    else:
        if b["d"] is None or b["d"].stamp != plan_stamp:
            fail("stale_plan", stale)
        plain, why_left = _untagged(text)

        def mark(candidate):
            kept_s, duration = _sums(candidate, track_id)
            candidate[MARKER_KEY] = _marker(
                "speech", {"seconds": kept_s},
                {"lines": why_left, "fillers": b["fillers"], "seconds": (round(b["before_s"] - kept_s, 2) + 0.0)},
                duration, max_pause, candidate, plan_stamp, plan_hash)
            _start(candidate)
        res = apply(project_path, plain, preview=False, max_pause=max_pause, feel=DEFAULT_FEEL,
                    base=b["work"], base_of=disk, version_message=VERSION_MESSAGE, want_project=True, amend=mark,
                    carry_from=b["origin"], lineage=b["lineage"], refiner=b["refiner"],
                    # status is guarded when this write starts a pending project, so a status the person set
                    # meanwhile refuses the apply rather than being overwritten with draft.
                    guard_keys=(MARKER_KEY,) + (("status",) if disk.get("status") == "pending" else ()))
        version = res.get("version")
        wrote = bool(res.get("applied"))
        final = res["_project"]
        layers = _layers(res.get("flagged"))
        warnings[:0] = _audio_warnings(res.get("flagged"))
        warnings += _piece_warnings(b["d"], res.get("flagged")) + _layer1_warnings(b)
        warnings += [w for w in res.get("warnings", []) if w not in warnings]
    _, duration = _sums(final, track_id)
    if version:
        answer.update(version=VERSION_MESSAGE, duration=duration, undo=f'Restore the version "{VERSION_MESSAGE}".')
    elif is_own_repo(project_dir) and wrote:
        # nothing unsaved before the cut: the latest version already holds the project as it was
        answer.update(version="latest", duration=duration,
                      undo="Restore the latest version from before this cut: it holds the project as it was.")
    else:
        answer.update(version=None, duration=duration,
                      undo="No version was saved: undo in the editor." if wrote else "Nothing was written.")
    answer["layers"] = layers
    if warnings:
        answer["warnings"] = warnings[:5]
    print(json.dumps(answer, ensure_ascii=False))


def _start(project):
    """A pending project is started by the cut that applies: the same write sets it to draft."""
    if project.get("status") == "pending":
        project["status"] = "draft"


def _write_silence(project_path, project_dir, disk, b, track_id, max_pause, marker, warnings, plan_stamp,
                   plan_hash=None):
    """The silence cut's write, with the speech path's guards: the other layers carried by the one map, the
    sync check, validation, a version, and the locked stale check over every key it writes.
    Returns (version saved, layer flags)."""
    candidate, rep = _carried(b["origin"], b["work"], b["ti"], b["lineage"], project_dir)

    def windows(project):
        return sorted((it["src"], round(float(it.get("inPoint", 0)), 3), round(float(it.get("outPoint", 0)), 3))
                      for it in _media(project["tracks"][b["ti"]]))
    if windows(candidate) == windows(b["origin"]):
        warnings.append("Nothing to cut.")
        return False, {}
    kept_s, duration = _sums(candidate, track_id)
    if marker:
        # A cut after a failed transcription leaves no marker, so the real cut can still run once it works.
        candidate[MARKER_KEY] = _marker("silence", {"seconds": kept_s},
                                        {"seconds": (round(b["before_s"] - kept_s, 2) + 0.0)},
                                        duration, max_pause, candidate, plan_stamp, plan_hash)
    _start(candidate)
    try:
        sync_clash.check_step_document(disk, candidate, files=[])
    except sync_clash.SyncConflict as e:
        sync_clash.exit_refused(e.body)
    speech_apply._validate(candidate)
    version = commit_version(project_dir, VERSION_MESSAGE)
    if not version and not is_own_repo(project_dir):
        warnings.append("no version saved: the project folder is not its own git repository")
    keys = ("tracks", "captions", "audio", "markers", "notes", MARKER_KEY)
    guard = keys
    if candidate.get("status") != disk.get("status"):
        # Written in this same guarded write, and guarded too: a status the person changed since this read
        # refuses the apply (run cut again) rather than being overwritten with draft.
        keys = keys + ("status",)
        guard = guard + ("status",)
    save_project_changes(Path(project_path), disk, candidate, keys=keys, guard=guard)
    warnings[:0] = _audio_warnings(rep.get("flagged"))
    return version, _layers(rep.get("flagged"))


if __name__ == "__main__":
    main()
