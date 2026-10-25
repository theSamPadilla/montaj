"""Apply an edited speech text to a project in one write (PL44 T10).

Pipeline: derive the current speech, refuse a stale text, align and build the new speech items,
carry everything else through, validate the candidate, then (unless previewing) take a version and
replace project.json atomically. Every refusal and every failure before the replace leaves
project.json untouched and makes no commit.
"""
import contextlib
import copy
import io
import json
import os
import shutil
import sys
import tempfile

from lib import project_revisions, speech_text, sync_clash
from lib.common import fail
from lib.project_lock import project_lock_or_fail
from lib.project_tracks import normalize_tracks
from lib.project_versions import commit_version, is_own_repo
from lib.speech_build import DEFAULT_FEEL, items_from_runs, runs_from_rows
from lib.speech_carry import TimeMap, carry, words_by_src

# engine/validate.py imports its sibling validate_step by bare name, so engine/ must be on the path.
_ENGINE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "engine")
if _ENGINE not in sys.path:
    sys.path.append(_ENGINE)
from engine.validate import validate_project  # noqa: E402


# The top-level keys the derive/build/carry pipeline reads (the speech track and everything it
# carries: captions, audio, markers, notes, overlay tracks, source files) plus the frame rate.
_READ_KEYS = ("tracks", "captions", "audio", "markers", "notes", "sources")


def _read_view(project: dict, keys=_READ_KEYS) -> str:
    """The part of a document this edit depends on, comparable across two reads."""
    view = {k: project.get(k) for k in keys}
    view["fps"] = (project.get("settings") or {}).get("fps")
    return json.dumps(view, sort_keys=True)


def _read_revisions(project: dict, keys=_READ_KEYS) -> dict:
    """The same view as revisions (§477): one per read key, plus settings.fps on its own so
    another setting changing does not refuse the edit."""
    revs = project_revisions.revisions_of(project, keys)
    revs["settings.fps"] = project_revisions.revision_of((project.get("settings") or {}).get("fps"))
    return revs


def _title(project: dict) -> str:
    return project.get("name") or project["id"]


def _validate(candidate: dict):
    """Run the engine's validator on the candidate, in a temp dir outside the project folder.

    Not in the project folder: serve's watcher reacts to any .json written there. Project paths are
    absolute, so the location does not change the result.
    """
    tmp = tempfile.mkdtemp()
    try:
        path = os.path.join(tmp, "project.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(candidate, f)
        buf = io.StringIO()
        try:
            with contextlib.redirect_stderr(buf), contextlib.redirect_stdout(io.StringIO()):
                validate_project(path)
        except SystemExit:
            code, msg = "invalid", buf.getvalue().strip()
            try:
                e = json.loads(msg.splitlines()[-1])
                code, msg = e.get("error", code), e.get("message", msg)
            except (ValueError, IndexError):
                pass
            fail("invalid_result", f"The edit would make an invalid project ({code}): {msg}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _summary(project: dict, track_index: int) -> dict:
    items = normalize_tracks(project)["tracks"][track_index]["items"]
    return {"duration": round(max((float(it.get("end", 0)) for it in items), default=0.0), 2), "items": len(items)}


def _result(*, applied, preview, version, before, after, report, warnings, text) -> dict:
    return {"applied": applied, "preview": preview, "noop": False, "version": version,
            "before": before, "after": after, **report.as_dict(), "hardCutAt": report.hard_cuts_at(),
            "warnings": warnings, "text": text}


def _noop(report, warnings) -> dict:
    """Nothing to write. The report stays: it says what the build did (a kept gap, a clamp) even when
    that left the project as it was."""
    return {"applied": False, "noop": True, **report.as_dict(), "hardCutAt": report.hard_cuts_at(), "warnings": warnings}


SPEECH_TEXT_FILE = "speech-text.md"


def _check_sync(before: dict, after: dict) -> None:
    """§482: the fields `after` changes and the text file, against the project's open Studio sync clashes (a
    no-op with MONTAJ_SYNC_STATE_DIR unset, or for the window's run). A refusal ends the step with it."""
    try:
        sync_clash.check_step_document(before, after, files=[SPEECH_TEXT_FILE])
    except sync_clash.SyncConflict as e:
        sync_clash.exit_refused(e.body)


def apply(project_path: str, text: str, *, preview: bool, max_pause: float | None,
          feel: str = DEFAULT_FEEL, base: dict | None = None, base_of: dict | None = None,
          version_message: str = "version: before speech edit", want_project: bool = False,
          amend=None, carry_from: dict | None = None, lineage: dict | None = None,
          guard_keys: tuple = (), refiner=None, lower=None) -> dict:
    """Apply `text` to the project at `project_path`.

    base (cut): the project as an in-memory step already changed it, and the one the text was read
    from. base_of: the disk project as the caller read it, before it made `base`. The text is derived,
    built and carried on `base`; everything that guards the write (the sync check, the version, the lock,
    the stale check and the merge) compares against `base_of`, so the write is refused, never merged over,
    when the disk changed at any time since the caller's read. A base that differs from the disk is written
    even when the text changes nothing.
    want_project: also return the resulting project (as written, or as it would be) under `_project`.
    amend: called with the candidate project before it is validated and written, to change it in place
    (cut records its marker there, so the marker lands in this same guarded write).
    carry_from, lineage (with base): every other layer (linked layers, overlays, captions, audio, markers,
    notes) is still timed to the project before the base's change, so it is carried from `carry_from` (that
    project; default base_of) through ONE map, from its speech track to the result. lineage maps a base item
    id to the carry_from item it was cut from (`<clip>-seg-*` -> clip), so the result's provenance names the
    items the layers were timed to.
    guard_keys: more top-level keys the stale check compares under the lock (cut: its marker).
    refiner: places the words the text is read and built on (speech_text.derive's; cut's speech_energy.Refiner).
    lower (with base): the speech track is a source cut lifted into a track of its own (an audio lane or the
    voiceover, lib/speech_source.py); `lower(candidate)` puts it back where it came from. The text, the summaries and
    `amend` see the lifted project; the noop check, the validation, the sync check and the write see the lowered
    one, compared with `base_of` (the disk as it is). speech-text.md is not written: it would name the lifted track.
    """
    project_path = os.path.abspath(project_path)
    project_dir = os.path.dirname(project_path)
    if base is not None and base_of is None:
        raise ValueError("apply: base needs base_of, the disk project it was made from")
    if base_of is not None:
        on_disk = copy.deepcopy(base_of)
    else:
        with open(project_path, encoding="utf-8") as f:
            on_disk = json.load(f)
    project = normalize_tracks(on_disk)
    as_read = copy.deepcopy(project)   # as read, before anything mutates it
    # §482: the sync check compares with the file as it is on disk (a legacy `tracks` the write converts is a write
    # of tracks); everything else works on the reader's shape. The same document unless the file is legacy.
    on_disk_as_read = as_read if project is on_disk else copy.deepcopy(on_disk)
    read_keys = _READ_KEYS + tuple(k for k in guard_keys if k not in _READ_KEYS)
    read = _read_revisions(project, read_keys) if project_revisions.engine_guard_enabled() else None
    disk = project
    if base is not None:
        project = normalize_tracks(copy.deepcopy(base))

    header, rows = speech_text.parse(text)
    derived = speech_text.derive(project, project_dir, track=header["track"],   # the track the text was read from
                                 refiner=refiner)
    if header["stamp"] != derived.stamp:
        fail("stale", "The project changed since this text was read. Read it again with speech_text.")
    tracks = project["tracks"]
    ti = next(i for i, t in enumerate(tracks) if t["id"] == derived.track_id)
    old_items = tracks[ti]["items"]
    fps = (project.get("settings") or {}).get("fps") or 30

    # speech-text.md is speech_edit's text: derived as speech_edit derives it, never on a refiner's words
    plain_sils = derived.silences if refiner is None else None
    # cut's refiner cuts silences on the sound (its layer 1), so it gives speech_build no cap of its own: pause_cap
    runs, report = runs_from_rows(rows, derived, derived.silences,
                                  getattr(refiner, "pause_cap", max_pause), old_items, project_dir, feel=feel)
    if hasattr(refiner, "tidy"):
        runs = refiner.tidy(runs, derived, report)     # cut: the silence trim, no island, no sliver (speech_energy.tidy)
    if not any(r.kind == "speech" for r in runs):
        fail("empty_cut", "The edit leaves no speech in the cut. Delete words or rows, but keep some speech.")
    reserved = {it["id"] for i, t in enumerate(tracks) if i != ti for it in t["items"]}
    items, prov = items_from_runs(runs, old_items, fps, report=report, sources=project.get("sources"),
                                  reserved_ids=reserved, project_dir=project_dir)
    def canon(its):
        return sorted(json.dumps(it, sort_keys=True) for it in its)

    def dump(p):
        return json.dumps(p, sort_keys=True)

    def noop():
        out = _noop(report, derived.warnings)
        if want_project:
            out["_project"] = disk
            out["_lifted"] = project if lower is not None else disk
        return out

    if base is not None:
        # The layers are timed to carry_from, not to the base: one map from its speech track to the result.
        origin = normalize_tracks(copy.deepcopy(carry_from if carry_from is not None else disk))
        lineage = lineage or {}
        prov2 = {}
        for it in items:
            p = dict(prov.get(it["id"]) or {})
            old = p.get("old_id") or it["id"]
            p["old_id"] = lineage.get(old, old)
            prov2[it["id"]] = p
        tmap = TimeMap(origin["tracks"][ti]["items"], items, prov2, words=words_by_src(derived),
                       project_dir=project_dir)
        candidate, report = carry(origin, ti, items, tmap, fps, report=report)
    elif canon(items) == canon(old_items):
        # Nothing on the speech track changed, so nothing is carried: an unedited text is a no-op.
        if amend is None:
            return noop()
        candidate = project
    else:
        tmap = TimeMap(old_items, items, prov, words=words_by_src(derived), project_dir=project_dir)
        candidate, report = carry(project, ti, items, tmap, fps, report=report)

    if amend is not None:
        if candidate is project:
            candidate = copy.deepcopy(project)
        amend(candidate)
    lifted = candidate
    if lower is not None:
        candidate = lower(lifted)

    if dump(candidate) == dump(disk):
        return noop()

    _validate(candidate)

    before, after = _summary(project if lower is not None else disk, ti), _summary(lifted, ti)
    if preview:
        # cut's preview (a refiner) never shows the text: deriving it as speech_edit does is two more full decodes
        new_text = None if refiner is not None else speech_text.render(
            speech_text.derive(lifted, project_dir, track=derived.track_id, sils=plain_sils), _title(candidate))
        out = _result(applied=False, preview=True, version=False, before=before, after=after,
                      report=report, warnings=derived.warnings, text=new_text)
        if want_project:
            out["_project"] = candidate
            out["_lifted"] = lifted
        return out

    # §482: a field this edit changes, or its text file, in an open Studio sync clash refuses it before the
    # version commit; the check runs again under the lock, on the fresh document.
    _check_sync(on_disk_as_read, candidate)
    # Everything that can fail runs before the write, so nothing fails after it.
    new_text = speech_text.render(speech_text.derive(lifted, project_dir, track=derived.track_id, sils=plain_sils), _title(candidate))
    version = commit_version(project_dir, version_message)
    warnings = list(derived.warnings)
    if not version and not is_own_repo(project_dir):
        warnings.append("no version saved: the project folder is not its own git repository")
    # The temp name must not end in .json: serve's watcher treats any .json (and .tmp-less source
    # extension) write as an overlay source and would push it to the overlay channel. This name is
    # ignored, and the replace lands as an on_moved event onto project.json, which it broadcasts.
    tmp = os.path.join(project_dir, f"project.json.tmp-{os.getpid()}")
    # The candidate was built from the copy read at the top, a git commit ago. Under the
    # project lock, a project whose KEYS THE EDIT READS are not what was read (an edit or a step
    # wrote them meanwhile) is refused rather than overwritten (§467). That includes a background
    # proxy, normalize or dims write, which lands inside tracks or sources: the edit is refused and
    # read again. Anything outside the read keys (the name, the status, the other settings, a
    # colour record) is kept, and only the keys the edit changed are written onto the fresh document.
    with project_lock_or_fail(project_path, fail):
        with open(project_path, encoding="utf-8") as f:
            fresh_on_disk = json.load(f)
        fresh = normalize_tracks(fresh_on_disk)   # pure: fresh_on_disk stays the file as read
        if read is not None:
            stale = project_revisions.stale_fields(None, list(read), read, revisions=_read_revisions(fresh, read_keys))["stale"]
            if stale:
                fail("project_changed", project_revisions.step_stale_message(stale))
        elif _read_view(fresh, read_keys) != _read_view(as_read, read_keys):
            fail("project_changed", "The project changed while the edit was applied: read the text again and redo it.")
        merged = dict(fresh)
        for key in set(candidate) | set(as_read):
            if key in candidate:
                if candidate[key] != as_read.get(key) or key not in as_read:
                    merged[key] = candidate[key]
            elif key in as_read:
                merged.pop(key, None)
        _check_sync(fresh_on_disk, merged)
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(merged, f, indent=2, ensure_ascii=False)
                f.write("\n")
            os.replace(tmp, project_path)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    if lower is None:
        with open(os.path.join(project_dir, SPEECH_TEXT_FILE), "w", encoding="utf-8") as f:
            f.write(new_text)
    out = _result(applied=True, preview=False, version=version, before=before, after=after,
                  report=report, warnings=warnings, text=new_text)
    if want_project:
        out["_project"] = merged
        out["_lifted"] = lifted
    return out
