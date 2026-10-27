#!/usr/bin/env python3
"""Read a project's speech as numbered transcript lines with pauses, to edit as text.

Writes <project dir>/speech-text.md and prints {path, text, track, stamp, sources,
lines, duration, warnings}. Pairs with speech_edit.
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from common import fail
from lib import sync_clash
from lib.project_lock import project_lock_or_fail
from lib.project_tracks import normalize_tracks
from lib.speech_text import derive, render

SPEECH_TEXT_FILE = "speech-text.md"


def _write_text(project_path, project_id, out_path, text):
    """Write speech-text.md. §482, review 40: with Studio sync on, the file is checked again against the project's
    open clashes under the project lock, and written in the same hold (serve checked it before the step ran; a
    clash recorded since refuses it, nothing written). Off, or the window's run: written as before."""
    if not sync_clash.state_dir():
        _write(out_path, text)
        return
    with project_lock_or_fail(project_path, fail):
        try:
            sync_clash.check_step_write(project_id, files=[SPEECH_TEXT_FILE])
        except (sync_clash.SyncConflict, sync_clash.SyncBusy) as e:
            sync_clash.exit_refused(e.body)
        _write(out_path, text)


def _write(out_path, text):
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(text)


def main():
    parser = argparse.ArgumentParser(description="Read a project's speech as numbered lines")
    parser.add_argument("--project", required=True, help="Absolute path to project.json")
    parser.add_argument("--track", default=None, help="Track id of the speech track")
    parser.add_argument("--unused", choices=["lines", "none"], default="lines")
    args = parser.parse_args()

    project_path = os.path.abspath(args.project)
    if not os.path.isfile(project_path):
        fail("not_found", f"Project not found: {project_path}")
    project_dir = os.path.dirname(project_path)
    with open(project_path, encoding="utf-8") as f:
        project = json.load(f)

    d = derive(project, project_dir, args.track)
    text = render(d, project.get("name") or project.get("id") or os.path.basename(project_dir), args.unused)

    out_path = os.path.join(project_dir, SPEECH_TEXT_FILE)
    _write_text(project_path, project.get("id"), out_path, text)

    track = next(t for t in normalize_tracks(project)["tracks"] if t["id"] == d.track_id)
    duration = max((float(it.get("end", it.get("start", 0))) for it in track["items"]), default=0.0)
    sources = {letter: (src if os.path.isabs(src) else os.path.abspath(os.path.join(project_dir, src)))
               for src, letter in d.letters.items()}
    print(json.dumps({
        "path": out_path,
        "text": text,
        "track": d.track_id,
        "stamp": d.stamp,
        "sources": sources,
        "lines": sum(1 for r in d.cut if r.kind == "speech"),
        "duration": round(duration, 3),
        "warnings": d.warnings,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
