"""Apply an edited speech text to a project in one write (PL44 T10).

Pipeline: derive the current speech, refuse a stale text, align and build the new speech items,
carry everything else through, validate the candidate, then (unless previewing) take a version and
replace project.json atomically. Every refusal and every failure before the replace leaves
project.json untouched and makes no commit.
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile

from lib import speech_text
from lib.common import fail
from lib.project_tracks import normalize_tracks
from lib.project_versions import commit_version, is_own_repo
from lib.speech_build import items_from_runs, runs_from_rows
from lib.speech_carry import TimeMap, carry, words_by_src

# engine/validate.py imports its sibling validate_step by bare name, so engine/ must be on the path.
_ENGINE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "engine")
if _ENGINE not in sys.path:
    sys.path.append(_ENGINE)
from engine.validate import validate_project  # noqa: E402


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
            "before": before, "after": after, **report.as_dict(), "warnings": warnings, "text": text}


def _noop(report, warnings) -> dict:
    """Nothing to write. The report stays: it says what the build did (a kept gap, a clamp) even when
    that left the project as it was."""
    return {"applied": False, "noop": True, **report.as_dict(), "warnings": warnings}


def apply(project_path: str, text: str, *, preview: bool, max_pause: float | None) -> dict:
    project_path = os.path.abspath(project_path)
    project_dir = os.path.dirname(project_path)
    with open(project_path, encoding="utf-8") as f:
        project = normalize_tracks(json.load(f))

    header, rows = speech_text.parse(text)
    derived = speech_text.derive(project, project_dir, track=header["track"])   # the track the text was read from
    if header["stamp"] != derived.stamp:
        fail("stale", "The project changed since this text was read. Read it again with speech_text.")
    tracks = project["tracks"]
    ti = next(i for i, t in enumerate(tracks) if t["id"] == derived.track_id)
    old_items = tracks[ti]["items"]
    fps = (project.get("settings") or {}).get("fps") or 30

    runs, report = runs_from_rows(rows, derived, derived.silences,
                                  max_pause, old_items, project_dir)
    if not any(r.kind == "speech" for r in runs):
        fail("empty_cut", "The edit leaves no speech in the cut. Delete words or rows, but keep some speech.")
    reserved = {it["id"] for i, t in enumerate(tracks) if i != ti for it in t["items"]}
    items, prov = items_from_runs(runs, old_items, fps, report=report, sources=project.get("sources"),
                                  reserved_ids=reserved, project_dir=project_dir)
    def canon(its):
        return sorted(json.dumps(it, sort_keys=True) for it in its)

    if canon(items) == canon(old_items):
        # Nothing on the speech track changed, so nothing is carried: an unedited text is a no-op.
        return _noop(report, derived.warnings)
    tmap = TimeMap(old_items, items, prov, words=words_by_src(derived), project_dir=project_dir)
    candidate, report = carry(project, ti, items, tmap, fps, report=report)

    def dump(p):
        return json.dumps(p, sort_keys=True)

    if dump(candidate) == dump(project):
        return _noop(report, derived.warnings)

    _validate(candidate)

    before, after = _summary(project, ti), _summary(candidate, ti)
    if preview:
        new_text = speech_text.render(speech_text.derive(candidate, project_dir, track=derived.track_id, sils=derived.silences), _title(candidate))
        return _result(applied=False, preview=True, version=False, before=before, after=after,
                       report=report, warnings=derived.warnings, text=new_text)

    # Everything that can fail runs before the write, so nothing fails after it.
    new_text = speech_text.render(speech_text.derive(candidate, project_dir, track=derived.track_id, sils=derived.silences), _title(candidate))
    version = commit_version(project_dir, "version: before speech edit")
    warnings = list(derived.warnings)
    if not version and not is_own_repo(project_dir):
        warnings.append("no version saved: the project folder is not its own git repository")
    # The temp name must not end in .json: serve's watcher treats any .json (and .tmp-less source
    # extension) write as an overlay source and would push it to the overlay channel. This name is
    # ignored, and the replace lands as an on_moved event onto project.json, which it broadcasts.
    tmp = os.path.join(project_dir, f"project.json.tmp-{os.getpid()}")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(candidate, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, project_path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    with open(os.path.join(project_dir, "speech-text.md"), "w", encoding="utf-8") as f:
        f.write(new_text)
    return _result(applied=True, preview=False, version=version, before=before, after=after,
                   report=report, warnings=warnings, text=new_text)
