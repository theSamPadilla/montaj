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
from lib.project_versions import commit_version
from lib.speech_build import items_from_runs, runs_from_rows
from lib.speech_carry import TimeMap, carry, words_by_src
from lib.speech_lines import sidecar_for
from lib.speech_pauses import silences

# engine/validate.py imports its sibling validate_step by bare name, so engine/ must be on the path.
_ENGINE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "engine")
if _ENGINE not in sys.path:
    sys.path.append(_ENGINE)
from engine.validate import validate_project  # noqa: E402


def _title(project: dict) -> str:
    return project.get("name") or project["id"]


def _sils_by_src(project: dict, track: dict, derived, project_dir: str) -> dict:
    """Measured silences per source key of `derived.letters`, from the same media derive() read."""
    out = {}
    cands = [speech_text._resolve(it, project_dir) for it in track["items"]]
    cands += [speech_text._resolve(s, project_dir) for s in project.get("sources") or [] if s.get("src")]
    for it in cands:
        key = it.get("src") or it.get("normalizedSrc")
        if key not in derived.letters or key in out or it.get("type") in speech_text._NON_SPEECH_TYPES:
            continue
        sc = sidecar_for(it)
        if sc:
            out[key] = silences(speech_text._media_for(it, sc))
    for key in derived.letters:
        out.setdefault(key, [])
    return out


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


def apply(project_path: str, text: str, *, preview: bool, max_pause: float | None) -> dict:
    project_path = os.path.abspath(project_path)
    project_dir = os.path.dirname(project_path)
    with open(project_path, encoding="utf-8") as f:
        project = normalize_tracks(json.load(f))

    derived = speech_text.derive(project, project_dir)
    header, rows = speech_text.parse(text)
    if header["stamp"] != derived.stamp or header["track"] != derived.track_id:
        fail("stale", "The project changed since this text was read. Read it again with speech_text.")
    tracks = project["tracks"]
    ti = next(i for i, t in enumerate(tracks) if t["id"] == derived.track_id)
    old_items = tracks[ti]["items"]
    fps = (project.get("settings") or {}).get("fps") or 30

    runs, report = runs_from_rows(rows, derived, _sils_by_src(project, tracks[ti], derived, project_dir),
                                  max_pause, old_items, project_dir)
    reserved = {it["id"] for i, t in enumerate(tracks) if i != ti for it in t["items"]}
    items, prov = items_from_runs(runs, old_items, fps, report=report, sources=project.get("sources"),
                                  reserved_ids=reserved, project_dir=project_dir)
    tmap = TimeMap(old_items, items, prov, words=words_by_src(derived), project_dir=project_dir)
    candidate, report = carry(project, ti, items, tmap, fps, report=report)

    def dump(p):
        return json.dumps(p, sort_keys=True)

    if dump(candidate) == dump(project):
        return {"applied": False, "noop": True}

    _validate(candidate)

    before, after = _summary(project, ti), _summary(candidate, ti)
    if preview:
        new_text = speech_text.render(speech_text.derive(candidate, project_dir), _title(candidate))
        return _result(applied=False, preview=True, version=False, before=before, after=after,
                       report=report, warnings=derived.warnings, text=new_text)

    version = commit_version(project_dir, "version: before speech edit")
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
    new_text = speech_text.render(speech_text.derive(candidate, project_dir), _title(candidate))
    with open(os.path.join(project_dir, "speech-text.md"), "w", encoding="utf-8") as f:
        f.write(new_text)
    return _result(applied=True, preview=False, version=version, before=before, after=after,
                   report=report, warnings=derived.warnings, text=new_text)
