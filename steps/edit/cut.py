#!/usr/bin/env python3
"""Cut a talking-head project in two calls (§558): a plan, then its apply.

Without `plan`: transcribes any clip on the speech track that has no transcript (the only file it may write
beside a clip), runs the mechanical pass (rm_nonspeech then rm_fillers keeps, put on the timeline with
jump_cut) in memory, chooses one take per section by the select-takes rules (lib/take_select.py), and writes
the result as an editable plan, cut-plan.md in the project folder, in speech_edit's text format: the kept
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
from lib import project_revisions, speech_apply, speech_text, sync_clash, write_places
from lib.project_lock import project_lock_or_fail
from lib.project_tracks import normalize_tracks
from lib.project_versions import commit_version, is_own_repo
from lib.speech_apply import apply
from lib.speech_build import DEFAULT_FEEL, FEELS
from lib.speech_carry import TimeMap, carry
from lib.speech_lines import _ends_sentence, load_words, norm, sidecar_for
from lib.take_select import BREAK_GAP_S, Selection, Unit, select
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
from steps.speech import rm_fillers, rm_nonspeech
from steps.speech.transcribe import transcribe as transcribe_file

VERSION_MESSAGE = "version: before cut"
PLAN_FILE = "cut-plan.md"
PLAN_HELP = ("Edit, then run cut with plan: move a row from ## Unused into ## Cut to keep it, delete a row "
             "from ## Cut to drop it, move rows to reorder. A * row is the whole of a trimmed row: put it in "
             "place of that row. A tag ending in ? is a suggestion, not made: retake? and false-start? rows are "
             "still in ## Cut (delete them there to take it); a repeat?, restart? or abandoned? group is the take "
             "trimmed (it replaces that take's rows in ## Cut).")
# Why a row is in a plan's ## Unused.
WHYS = ("retake", "false-start", "repeat", "restart", "abandoned", "filler-only", "pause", "earlier")
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


def _mechanical(work, project_path, ti, project_dir, fillers, lineage, whole=None):
    """rm_nonspeech then rm_fillers keeps per clip, from the clip's one transcript, put on the timeline with
    jump_cut, in memory. fillers: rm_fillers' compiled pattern. A clip whose words are made up or too few to be
    speech (b-roll) is left whole and added to `whole`. (filler words removed, warnings)."""
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
        duration = float(it.get("sourceDuration") or get_duration(r["src"]))
        keeps = rm_nonspeech.source_keeps(words, duration)
        keeps, cuts, _ = rm_fillers.spec_keeps(keeps, words, fillers)
        lo, hi = _window(it, r["src"])
        if not _window_has(keeps, lo, hi):
            continue
        removed += sum(1 for c in cuts if lo <= (c["start"] + c["end"]) / 2 < hi)
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
          whole=frozenset()):
    """The plan: speech_edit's text format. `## Cut` holds the kept rows in narrative order (each kept take at
    its section's first appearance, its repeated or restarted words deleted), each tagged [time]; `## Unused`
    every removed take, one group of rows per take (a blank line between), each row tagged [time why]. A row
    of a kept take that keeps some words is listed whole, marked `*`. Times are of the timeline as it is now.
    Line ids are the source's (lib/speech_lines), so the same transcript gives the same ids.
    Uncertain cuts (sel.suggest) are not made: the take stays in `## Cut` and `## Unused` offers the cut, tagged
    with a `?` reason. Returns (text, kept rows [(id, t, words)], removed takes [(id, t, words, why)],
    suggestions [(id, t, words, why?)])."""
    home = {ui: s_i for s_i, section in enumerate(sel.sections) for ui in section}
    for ui in range(len(units) - 1, -1, -1):
        if ui not in home:
            home[ui] = home.get(ui + 1, len(sel.sections) - 1)
    head = speech_text.render(d, title, "none").split("\n")
    cut_at = head.index("## Cut")
    out = [head[0], f"<!-- montaj cut plan v1 · language {language} · max-pause {max_pause:.2f} -->",
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
        for _, row in units[ui][1]:
            mine = {k - pos for k in drop if pos <= k < pos + len(row.words)}
            pos += len(row.words)
            trimmed = _trimmed(row, mine) if mine else row
            if mine:
                lost.append(f"{_row_line(row, star=trimmed is not None)} [{t_of(row):.1f} {sel.why.get(ui, 'repeat')}]")
            if trimmed is not None:
                if row.item_ids and row.item_ids[0] in whole:
                    trimmed = _kept_whole(trimmed)
                out.append(f"{_row_line(trimmed)} [{t_of(row):.1f}]")
                kept.append((row.line, t_of(row), " ".join(w.text for w in trimmed.words)))
        if lost:
            gone = [w for k, w in enumerate(units[ui][0].words) if k in drop]
            groups.append((t_of(units[ui][1][0][1]), sel.why.get(ui, "repeat"), lost,
                           (units[ui][1][0][1].line, " ".join(gone))))
    out += [_other_row(r) for r in trailing]

    for ui in sel.losers:
        rows = [r for _, r in units[ui][1]]
        why = sel.why.get(ui, "retake")
        groups.append((t_of(rows[0]), why, [f"{_row_line(r)} [{t_of(r):.1f} {why}]" for r in rows],
                       (rows[0].line, words(rows))))
    for ln in d.unused:
        if ln.id in d.partly or not ln.words:
            continue        # a line partly in the cut lost only fillers, which the counts carry
        src = next((s for s, letter in d.letters.items() if ln.id[:len(letter)] == letter
                    and ln.id[len(letter):].isdigit()), None)
        src = src if src is None or os.path.isabs(src) else os.path.join(project_dir, src)
        t = of_source(src, ln.words[0].start) if src else None
        text = " ".join(w.text for w in ln.words)
        if t is None:
            # not on the timeline before this cut either (an earlier cut took it): listed to restore, not counted
            groups.append((float("inf"), "earlier", [f"{ln.id} {text} [earlier]"], None))
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
        suggested.append((t_of(rows[0]), why, lines, (rows[0].line, text)))
    if suggested:
        groups2 = sorted(suggested, key=lambda g: (g[0], g[2][0] if g[2] else ""))
        for _, _, rows, _ in groups2:
            out += [""] + rows
    return (_seal("\n".join(out) + "\n"), kept, removed,
            [(ans[0], t, ans[1], why) for t, why, _, ans in sorted(suggested, key=lambda g: g[0])])


_TAG = re.compile(r"\s\[(\d+(?:\.\d+)?)?(?:\s?(" + "|".join(WHYS) + r")(\?)?)?\]\s*$")


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
    """(language, max-pause) from a plan's second comment, or (None, None)."""
    for raw in text.splitlines()[:4]:
        m = re.match(r"^<!--\s*montaj cut plan v1 · language (\S+) · max-pause (\d+(?:\.\d+)?)\s*-->\s*$", raw.strip())
        if m:
            return m.group(1), float(m.group(2))
    return None, None


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


def _tracks_rev(project):
    return project_revisions.revision_of(normalize_tracks(copy.deepcopy(project)).get("tracks"))


def _marker(mode, kept, removed, duration, max_pause, written, plan_stamp, plan_hash=None):
    """The record of a cut. tracksRev: the revision of the tracks it wrote, to tell a later change; planStamp:
    the stamp of the plan it applied, so the same plan is not applied twice."""
    return {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "maxPause": max_pause,
            "stepVersion": STEP_VERSION, "mode": mode, "kept": kept, "removed": removed,
            "duration": duration, "tracksRev": _tracks_rev(written), "planStamp": plan_stamp,
            "planHash": plan_hash}


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

def _build(project_path, project_dir, disk, track_id, language, warnings):
    """The base: the disk project with the mechanical pass on its speech track, in memory, and everything the
    plan and its apply need. Deterministic for the same project and transcripts, so an apply rebuilds the base
    the plan was made from."""
    # The base starts from the origin: fresh clips already laid over their whole source, as jump_cut lays them,
    # so a clip the mechanical pass leaves whole still has a window speech_text can read.
    origin = _origin(disk, track_id, project_dir)
    work = copy.deepcopy(origin)
    ti, track = _track(work, track_id)
    b = {"work": work, "ti": ti, "before_s": _seconds(track, project_dir),
         "origin": origin, "lineage": {}, "d": None, "fillers": 0}
    has_words = any((sc := sidecar_for(_resolved(it, project_dir))) and load_words(sc) for it in _media(track))
    if has_words:
        is_filler = _filler_test(language)
        b["whole"] = set()
        b["fillers"], w = _mechanical(work, project_path, ti, project_dir, rm_fillers.filler_matcher(language),
                                      b["lineage"], b["whole"])
        warnings += w
        warnings += _silence_cut(work, project_path, ti, project_dir, b["lineage"], untranscribed_only=True)
        d = speech_text.derive(work, project_dir, track_id)
        units, trailing = _units(d, is_filler)
        for u, rows, _ in units:
            # a clip kept whole (b-roll): its made-up words are never a take, a loser or a suggestion
            u.fixed = bool(rows) and all(r.item_ids and r.item_ids[0] in b["whole"] for _, r in rows)
        _mark_made_up_tails(units, d.inside_words)
        if units:
            b.update(d=d, units=units, trailing=trailing)
            if language.split("-")[0].lower() in NON_SPACED:
                b["sel"] = Selection(kept=list(range(len(units))), sections=[[i] for i in range(len(units))])
                warnings.append(f"takes are not chosen for {language}: only silences and fillers are cut")
            else:
                b["sel"] = select([u for u, _, _ in units], is_filler)
            return b
    # no usable speech: waveform_trim keeps on a fresh copy
    work = copy.deepcopy(origin)
    b.update(work=work, lineage={}, fillers=0)
    warnings += _silence_cut(work, project_path, b["ti"], project_dir, b["lineage"])
    return b


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
    parser.add_argument("--max-pause", type=float, default=None, help="Cap unchanged pauses, in seconds")
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
    _stem_clash(_track(normalize_tracks(first), track_id)[1], project_dir)
    transcribed, failed, warnings = _transcribe_missing(first, track_id, project_path, project_dir,
                                                        args.model, args.language or "auto")
    disk = _load(project_path)        # read again after the long part
    if isinstance(disk.get(MARKER_KEY), dict) and not args.recut:     # another run cut it meanwhile
        print(json.dumps(_already_cut(disk), ensure_ascii=False))
        return
    language = _language(args.language, _track(normalize_tracks(disk), track_id)[1], project_dir)
    max_pause = args.max_pause if args.max_pause is not None else FEELS[DEFAULT_FEEL].max_pause
    title = disk.get("name") or disk.get("id") or os.path.basename(project_dir)
    b = _build(project_path, project_dir, disk, track_id, language, warnings)
    answer = {"project": disk.get("id"), "mode": "plan"}

    if b["d"] is None:
        candidate, rep = _carried(b["origin"], b["work"], b["ti"], b["lineage"], project_dir)
        kept_s, duration = _sums(candidate, track_id)
        path, prev = _write_plan(project_path, disk.get("id"), _silence_plan(b, track_id, title, marker=not failed))
        answer.update(plan=path, silence=True,
                      kept={"lines": 0, "seconds": kept_s},
                      removed={"seconds": (round(b["before_s"] - kept_s, 2) + 0.0)}, duration=duration,
                      layers=_layers(rep.get("flagged")),
                      note=("Transcription failed: the plan removes silences only." if failed else
                            "No usable speech: the plan removes silences only."))
    else:
        at, of_source = _timer(b["origin"], b["work"], b["ti"], b["lineage"])
        text, kept, removed, suggested = _plan(b["d"], title, b["units"], b["trailing"], b["sel"], at, of_source,
                                               language, max_pause, project_dir, _filler_test(language),
                                               b.get("whole", frozenset()))
        res = apply(project_path, _untagged(text)[0], preview=True, max_pause=max_pause, feel=DEFAULT_FEEL,
                    base=b["work"], base_of=disk, want_project=True, carry_from=b["origin"], lineage=b["lineage"],
                    guard_keys=(MARKER_KEY,))
        kept_s, duration = _sums(res["_project"], track_id)
        path, prev = _write_plan(project_path, disk.get("id"), text)
        by, maybe = {}, {}
        for *_, why in removed:
            by[why] = by.get(why, 0) + 1
        for *_, why in suggested:
            maybe[why] = maybe.get(why, 0) + 1
        answer.update(plan=path, kept={"lines": len(kept), "seconds": kept_s},
                      removed={"lines": by, "fillers": b["fillers"], "seconds": (round(b["before_s"] - kept_s, 2) + 0.0)},
                      duration=duration)
        if maybe:
            answer["suggested"] = maybe
        answer["layers"] = _layers(res.get("flagged"))
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
                          "a repeat?, restart? or abandoned? group replaces that take's rows in ## Cut.")
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
    plan_lang, plan_pause = _plan_meta(text)
    language = args.language or plan_lang or "en"
    max_pause = args.max_pause if args.max_pause is not None else (
        plan_pause if plan_pause is not None else FEELS[DEFAULT_FEEL].max_pause)
    warnings = []
    b = _build(project_path, project_dir, disk, track_id, language, warnings)
    stale = ("The project's speech or its transcripts changed since this plan was made. "
             "Run cut again for a new plan.")
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
        res = apply(project_path, plain, preview=False, max_pause=max_pause, feel=DEFAULT_FEEL,
                    base=b["work"], base_of=disk, version_message=VERSION_MESSAGE, want_project=True, amend=mark,
                    carry_from=b["origin"], lineage=b["lineage"], guard_keys=(MARKER_KEY,))
        version = res.get("version")
        wrote = bool(res.get("applied"))
        final = res["_project"]
        layers = _layers(res.get("flagged"))
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
    try:
        sync_clash.check_step_document(disk, candidate, files=[])
    except sync_clash.SyncConflict as e:
        sync_clash.exit_refused(e.body)
    speech_apply._validate(candidate)
    version = commit_version(project_dir, VERSION_MESSAGE)
    if not version and not is_own_repo(project_dir):
        warnings.append("no version saved: the project folder is not its own git repository")
    keys = ("tracks", "captions", "audio", "markers", "notes", MARKER_KEY)
    save_project_changes(Path(project_path), disk, candidate, keys=keys, guard=keys)
    return version, _layers(rep.get("flagged"))


if __name__ == "__main__":
    main()
