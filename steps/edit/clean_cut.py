#!/usr/bin/env python3
"""Clean-cut a talking-head project in one call (§558).

Transcribes any clip on the speech track that has no transcript, runs the mechanical pass (rm_nonspeech then
rm_fillers keeps, put on the timeline with jump_cut) in memory, keeps one take per section by the
select-takes rules (lib/take_select.py), and applies the result through speech_edit's save path
(lib/speech_apply.apply): one write, a version saved before it. With no usable speech, removes silences only
(waveform_trim keeps through jump_cut). Prints one short JSON answer.
"""
import argparse, contextlib, copy, io, json, os, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from common import fail, get_duration, DEFAULT_WHISPER_MODEL, WHISPER_MODEL_CHOICES
from ai_video import save_project_changes
from lib import speech_text
from lib.project_tracks import normalize_tracks
from lib.project_versions import commit_version
from lib.speech_apply import apply
from lib.speech_build import DEFAULT_FEEL
from lib.speech_lines import _ends_sentence, load_words, norm, sidecar_for
from lib.take_select import Unit, select
from steps.audio import waveform_trim
from steps.edit import jump_cut
from steps.speech import rm_fillers, rm_nonspeech
from steps.speech.transcribe import transcribe as transcribe_file

VERSION_MESSAGE = "version: before clean cut"
# The marker a cut leaves on the project, written in the same guarded write as the cut. A project carrying it
# is not cut again unless `recut` is passed: a second pass would cut the first pass's output.
MARKER_KEY = "cleanCut"
STEP_VERSION = 1
TEXT_CAP_BYTES = 3000
HESITATION_S = 0.5          # a pause this long inside a take counts against it (select-takes: less dead air)
UNIT_MAX_TOKENS = 40        # a sentence the transcript did not punctuate stops growing here
SILENCE_THRESHOLD_DB = -30.0  # waveform_trim's defaults
SILENCE_MIN_S = 0.3
_NON_MEDIA = ("overlay", "image", "text", "caption")
# A transcription that ran and failed falls back to silence removal; any other error (no model yet, a missing
# file) fails the step with that error.
FALLBACK_ERRORS = ("transcription_failed", "transcription_timeout")


def _resolve(path, project_dir):
    return path if os.path.isabs(path) else os.path.join(project_dir, path)


def _resolved(item, project_dir):
    out = dict(item)
    for k in ("src", "normalizedSrc"):
        if isinstance(out.get(k), str) and out[k]:
            out[k] = _resolve(out[k], project_dir)
    return out


def _media(track):
    return [it for it in track["items"] if it.get("src") and it.get("type") not in _NON_MEDIA]


def _load(project_path):
    with open(project_path, encoding="utf-8") as f:
        return json.load(f)


def _quiet(fn, *a, **k):
    """Run fn with its stderr held back. (ok, result): a fail() inside it is (False, its error)."""
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            return True, fn(*a, **k)
    except SystemExit:
        lines = err.getvalue().strip().splitlines()
        try:
            return False, json.loads(lines[-1])
        except (ValueError, IndexError):
            return False, {"error": "failed", "message": err.getvalue().strip()[-300:]}


def _speech_track_id(project, project_dir):
    """The track with the most seconds of transcribed clips (a fresh clip counts its source length), else
    the first track."""
    tracks = normalize_tracks(project).get("tracks", [])
    if not tracks:
        fail("no_tracks", "The project has no tracks to cut")
    best, best_s = None, -1.0
    for t in tracks:
        clips = [it for it in _media(t) if sidecar_for(_resolved(it, project_dir))]
        if not clips:
            continue
        secs = sum(max(0.0, float(it.get("outPoint", 0)) - float(it.get("inPoint", 0)))
                   if "inPoint" in it and "outPoint" in it else float(it.get("sourceDuration") or 0) for it in clips)
        if secs > best_s:
            best, best_s = t["id"], secs
    return best if best is not None else tracks[0]["id"]


def _track(project, track_id):
    for i, t in enumerate(project["tracks"]):
        if t["id"] == track_id:
            return i, t
    fail("project_changed", f"Track {track_id} is gone from the project: run clean_cut again")


def _transcribe_missing(project, track_id, project_dir, model, language):
    """Transcribe every clip of the track with no transcript; the sidecar lands beside the clip's src as the
    project holds it, where speech_text looks. (transcribed clip ids, warnings)."""
    _, track = _track(normalize_tracks(project), track_id)
    done, warnings, seen = [], [], {}
    for it in _media(track):
        r = _resolved(it, project_dir)
        if sidecar_for(r):
            continue
        src = r["src"]
        if src not in seen:
            ok, res = _quiet(transcribe_file, src, None, model, language)
            seen[src] = ok
            if not ok and res.get("error") not in FALLBACK_ERRORS:
                # no model yet, a missing file, a full disk: the step fails as transcribe would
                fail(res.get("error", "transcription_failed"), res.get("message", ""))
            if not ok:
                warnings.append(f"transcription failed for {os.path.basename(src)}: {res.get('message', '')}"[:300])
        if seen[src]:
            done.append(it["id"])
    return done, warnings


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


def _mechanical(work, project_path, ti, project_dir, fillers):
    # fillers: rm_fillers' compiled pattern for the language
    """rm_nonspeech then rm_fillers keeps per clip, from the clip's one transcript, put on the timeline with
    jump_cut, in memory. (filler words removed, warnings)."""
    removed, warnings = 0, []
    ids = [it["id"] for it in _media(work["tracks"][ti])]
    for cid in ids:
        it = next(x for x in work["tracks"][ti]["items"] if x["id"] == cid)
        r = _resolved(it, project_dir)
        sidecar = sidecar_for(r)
        if not sidecar:
            continue
        if not _cuttable(it):
            warnings.append(f"kept {cid} whole: it has keyframes, a speed change or a loop")
            continue
        words = [{"text": w.text, "start": w.start, "end": w.end} for w in load_words(sidecar)]
        if not words:
            continue
        duration = float(it.get("sourceDuration") or get_duration(r["src"]))
        keeps = rm_nonspeech.source_keeps(words, duration)
        keeps, cuts, _ = rm_fillers.spec_keeps(keeps, words, fillers)
        lo, hi = _window(it, r["src"])
        if not _window_has(keeps, lo, hi):
            continue
        removed += sum(1 for c in cuts if lo <= (c["start"] + c["end"]) / 2 < hi)
        jump_cut.cut_clip(work, project_path, cid, spec={"input": it["src"], "keeps": _in_window(keeps, lo, hi)},
                          track_index=ti)
    return removed, warnings


def _silence_cut(work, project_path, ti, project_dir):
    """waveform_trim keeps per clip through jump_cut, in memory. Returns warnings."""
    warnings = []
    for cid in [it["id"] for it in _media(work["tracks"][ti])]:
        it = next(x for x in work["tracks"][ti]["items"] if x["id"] == cid)
        if not _cuttable(it):
            warnings.append(f"kept {cid} whole: it has keyframes, a speed change or a loop")
            continue
        src = _resolve(it["src"], project_dir)
        ok, spec = _quiet(waveform_trim.process_one, src, SILENCE_THRESHOLD_DB, SILENCE_MIN_S)
        if not ok:
            continue
        lo, hi = _window(it, src)
        if not _window_has(spec["keeps"], lo, hi):
            continue
        jump_cut.cut_clip(work, project_path, cid, spec={"input": it["src"], "keeps": _in_window(spec["keeps"], lo, hi)},
                          track_index=ti)
    return warnings


# ── units: one spoken sentence each ──────────────────────────────────────────

def _line_key(line_id):
    letters = line_id.rstrip("0123456789")
    return letters, int(line_id[len(letters):])


def _units(d, is_filler):
    """[(Unit, rows, attached)] in cut order. rows: (cut index, Row) whose words make the unit, in order;
    attached: the non-speech rows right before it. A unit is a run of consecutive rows of one source line,
    joined with the next line of the same source while the sentence has not ended. Plus the trailing rows."""
    occs, pending = [], []
    for i, r in enumerate(d.cut):
        if r.kind != "speech":
            pending.append(r)
            continue
        if occs and occs[-1]["line"] == r.line and not pending:
            occs[-1]["rows"].append((i, r))
            continue
        occs.append({"line": r.line, "rows": [(i, r)], "attached": pending})
        pending = []
    units = []
    for oc in occs:
        if units:
            last = units[-1]
            lw = last["rows"][-1][1].words
            pl, pn = _line_key(last["line"])
            cl, cn = _line_key(oc["line"])
            if (lw and not _ends_sentence(lw[-1].text) and not oc["attached"] and cl == pl and cn == pn + 1
                    and sum(len(r.words) for _, r in last["rows"]) < UNIT_MAX_TOKENS):
                last["rows"] += oc["rows"]
                last["line"] = oc["line"]
                last["lines"].append(oc["line"])
                continue
        units.append({"line": oc["line"], "lines": [oc["line"]], "rows": list(oc["rows"]), "attached": oc["attached"]})
    out = []
    for u in units:
        words = [w for _, r in u["rows"] for w in r.words]
        fillers = 0
        for lid in dict.fromkeys(u["lines"]):
            played = [w.idx for _, r in u["rows"] if r.line == lid for w in r.words]
            ln = d.lines.get(lid)
            if ln and played:
                lo, hi = min(played), max(played)
                fillers += sum(1 for w in ln.words if lo <= w.idx <= hi and w.norm and is_filler(w.norm))
        hes = sum(1 for a, b in zip(words, words[1:]) if b.start - a.end >= HESITATION_S)
        out.append((Unit([w.text for w in words], fillers=fillers, hesitations=hes), u["rows"], u["attached"]))
    return out, pending


def _filler_test(language):
    rx = rm_fillers.filler_matcher(language)
    return lambda tok: bool(rx.match(tok))


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


def _edited_text(d, title, units, trailing, sel):
    """The speech text with every losing take's rows deleted, each kept take at its section's first
    appearance, and the kept take's repeated or restarted words deleted. The non-speech rows before a unit
    go with that unit's section (a false start's with the section of the take it opened)."""
    home = {ui: s_i for s_i, section in enumerate(sel.sections) for ui in section}
    for ui in range(len(units) - 1, -1, -1):
        if ui not in home:
            home[ui] = home.get(ui + 1, len(sel.sections) - 1)
    head = speech_text.render(d, title, "none").split("\n")
    out = head[:head.index("## Cut") + 1] + [""]
    for s_i in range(len(sel.sections)):
        for ui in range(len(units)):
            if home[ui] == s_i:
                out += [_other_row(r) for r in units[ui][2]]
        ui = sel.kept[s_i]
        drop, pos = sel.drop.get(ui, set()), 0
        for _, row in units[ui][1]:
            mine = {k - pos for k in drop if pos <= k < pos + len(row.words)}
            pos += len(row.words)
            row = _trimmed(row, mine) if mine else row
            if row is not None:
                out.append(f"{row.line} {speech_text._row_text(row)}")
    out += [_other_row(r) for r in trailing]
    return "\n".join(out) + "\n"


# ── the answer ───────────────────────────────────────────────────────────────

def _phrases(project, project_dir, track_id, is_filler, sils=None):
    """[(timeline seconds, text)] of the speech on the track, one per sentence."""
    try:
        d = speech_text.derive(project, project_dir, track_id, sils=sils)
    except SystemExit:
        return []
    items = {it["id"]: it for it in normalize_tracks(project)["tracks"][_track(normalize_tracks(project), track_id)[0]]["items"]}
    units, _ = _units(d, is_filler)
    out = []
    for unit, rows, _ in units:
        row = rows[0][1]
        it = items.get(row.item_ids[0]) if row.item_ids else None
        t = 0.0
        if it is not None and row.words:
            t = float(it["start"]) + (row.words[0].start - float(it.get("inPoint", 0))) / float(it.get("speed") or 1)
        out.append((round(max(t, 0.0), 1), " ".join(unit.words)))
    return out


def _text(phrases):
    lines, size = [], 0
    for n, (t, txt) in enumerate(phrases):
        line = f"{t:.1f} {txt}"
        if size + len(line.encode()) + 1 > TEXT_CAP_BYTES:
            lines.append(f"... {len(phrases) - n} more lines")
            break
        lines.append(line)
        size += len(line.encode()) + 1
    return "\n".join(lines)


def _answer(project_id, mode, final, track_id, project_dir, before_s, phrases, takes, fillers, transcribed,
            warnings, note=None):
    _, track = _track(normalize_tracks(final), track_id)
    kept_s = sum(max(0.0, float(it.get("end", 0)) - float(it.get("start", 0))) for it in _media(track))
    duration = max((float(it.get("end", 0)) for it in track["items"]), default=0.0)
    out = {"project": project_id, "mode": mode,
           "kept": {"lines": len(phrases), "seconds": round(kept_s, 2)},
           "removed": {"takes": takes, "fillers": fillers, "seconds": round(max(0.0, before_s - kept_s), 2)},
           "duration": round(duration, 2), "text": _text(phrases), "transcribed": transcribed}
    if note:
        out["note"] = note
    if warnings:
        out["warnings"] = warnings[:5]
    return out


def _marker(answer, max_pause):
    return {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "maxPause": max_pause,
            "stepVersion": STEP_VERSION, "mode": answer["mode"], "kept": answer["kept"],
            "removed": answer["removed"], "duration": answer["duration"]}


def _already_cut(project):
    m = project[MARKER_KEY]
    return {"project": project.get("id"), "mode": "already-cut", "cutAt": m.get("at"),
            "kept": m.get("kept"), "removed": m.get("removed"), "duration": m.get("duration"),
            "note": "Already cut. Pass recut to cut it again."}


def main():
    parser = argparse.ArgumentParser(description="Clean-cut a talking-head project")
    parser.add_argument("--project", required=True, help="Absolute path to project.json")
    parser.add_argument("--max-pause", type=float, default=None, help="Cap unchanged pauses, in seconds")
    parser.add_argument("--preview", action="store_true", help="Compute and answer, change nothing")
    parser.add_argument("--model", default=DEFAULT_WHISPER_MODEL, choices=list(WHISPER_MODEL_CHOICES),
                        help="Whisper model for clips with no transcript")
    parser.add_argument("--language", default="en", help="Language code (e.g. es), or 'auto'")
    parser.add_argument("--recut", action="store_true", help="Cut again a project clean_cut already cut")
    args = parser.parse_args()

    project_path = os.path.abspath(args.project)
    if not os.path.isfile(project_path):
        fail("not_found", f"Project not found: {project_path}")
    project_dir = os.path.dirname(project_path)
    is_filler = _filler_test(args.language)

    first = _load(project_path)
    if isinstance(first.get(MARKER_KEY), dict) and not args.recut:
        print(json.dumps(_already_cut(first), ensure_ascii=False))
        return

    track_id = _speech_track_id(first, project_dir)
    transcribed, warnings = _transcribe_missing(_load(project_path), track_id, project_dir, args.model, args.language)

    # Read again after the long part: every write below is guarded against this read.
    disk = _load(project_path)
    project_id = disk.get("id")
    work = normalize_tracks(copy.deepcopy(disk))
    ti, track = _track(work, track_id)
    before_s = _seconds(track, project_dir)
    has_words = any((sc := sidecar_for(_resolved(it, project_dir))) and load_words(sc) for it in _media(track))

    d = None
    if has_words:
        fillers, mech_warn = _mechanical(work, project_path, ti, project_dir, rm_fillers.filler_matcher(args.language))
        warnings += mech_warn
        d = speech_text.derive(work, project_dir, track_id)
        units, trailing = _units(d, is_filler)
        if not units:
            d = None
            work = normalize_tracks(copy.deepcopy(disk))
            ti, _ = _track(work, track_id)

    if d is None:
        warnings += _silence_cut(work, project_path, ti, project_dir)
        changed = json.dumps(work, sort_keys=True) != json.dumps(normalize_tracks(copy.deepcopy(disk)), sort_keys=True)
        note = "No usable speech: removed silences only."
        answer = _answer(project_id, "silence", work, track_id, project_dir, before_s, [], 0, 0,
                         transcribed, warnings, note)
        if not args.preview:
            work[MARKER_KEY] = _marker(answer, args.max_pause)
            commit_version(project_dir, VERSION_MESSAGE)
            save_project_changes(Path(project_path), disk, work, keys=("tracks", MARKER_KEY))
        print(json.dumps(answer, ensure_ascii=False))
        return

    sel = select([u for u, _, _ in units], is_filler)
    title = work.get("name") or work.get("id") or os.path.basename(project_dir)
    text = _edited_text(d, title, units, trailing, sel)
    answer = {}

    def record(candidate):
        """Answer from the project as it will be written, and put the marker in that same write."""
        phrases = _phrases(candidate, project_dir, track_id, is_filler, sils=d.silences)
        answer.update(_answer(project_id, "speech", candidate, track_id, project_dir, before_s, phrases,
                              len(sel.losers) + len(sel.abandoned), fillers, transcribed, warnings))
        candidate[MARKER_KEY] = _marker(answer, args.max_pause)

    result = apply(project_path, text, preview=args.preview, max_pause=args.max_pause, feel=DEFAULT_FEEL,
                   base=work, base_of=disk, version_message=VERSION_MESSAGE, want_project=True, amend=record)
    if not answer:      # nothing to write at all (cannot happen with a marker to add; kept for safety)
        record(copy.deepcopy(result["_project"]))
    for w in result.get("warnings", []):
        if w not in answer.setdefault("warnings", []):
            answer["warnings"].append(w)
    if not answer.get("warnings"):
        answer.pop("warnings", None)
    print(json.dumps(answer, ensure_ascii=False))


if __name__ == "__main__":
    main()
