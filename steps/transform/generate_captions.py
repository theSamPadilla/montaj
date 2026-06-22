#!/usr/bin/env python3
"""Generate a project's caption track server-side, writing project["captions"].

CLI-subprocess equivalent of the /projects/{id}/captions SSE route. Given a
project id, it derives the single-source cut from the primary track, then runs
the full pipeline as subprocesses:

  1. materialize_cut — render the trimmed timeline to a plain MP4.
  2. transcribe      — multilingual, output-time word timings (plain video in,
                       NOT a trim spec, so timestamps are project-time).
  3. caption         — group words into styled caption segments.

It then merges any prior caption theme (position/color/fontsize/bgColor) into
the new track, writes project.json, cleans up temp files, and prints the track
JSON as the step result.

Async driving (montaj_step async:true + montaj_step_status) is handled
generically by the serve route — this step is a plain CLI subprocess.
"""
import argparse
import json
import os
import sys

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
MONTAJ_ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))

sys.path.insert(0, os.path.join(MONTAJ_ROOT, "lib"))
from common import fail, run  # noqa: E402

sys.path.insert(0, MONTAJ_ROOT)
from serve.common import get_project_dir  # noqa: E402
from serve.caption_job import extract_keeps  # noqa: E402

# Caption-theme keys carried forward from a prior caption track. Mirrors the
# SSE route's merge in serve/routes/projects.py.
THEME_KEYS = ("position", "color", "fontsize", "bgColor")


def resolve_style(args_style, project: dict) -> str:
    """style = explicit arg, else prior captions.style, else 'pop'.

    Mirrors the SSE route's: body.style or prior captions.style or 'pop'.
    """
    prior = project.get("captions") or {}
    return args_style or prior.get("style") or "pop"


def merge_caption_theme(track: dict, prev) -> dict:
    """Carry forward theme keys from a prior caption track into a fresh one.

    Mutates and returns `track`. A theme key is copied only when present in
    `prev` and NOT already present in `track`. Mirrors the SSE route exactly.
    """
    prev = prev or {}
    for k in THEME_KEYS:
        if k in prev and k not in track:
            track[k] = prev[k]
    return track


def main():
    parser = argparse.ArgumentParser(
        description="Generate a project's caption track over its trimmed timeline"
    )
    parser.add_argument("--project-id", required=True, help="Project id")
    parser.add_argument("--model", default="large", help="Whisper model")
    parser.add_argument("--language", default="auto",
                        help="Language code (e.g. en, es), or 'auto' to detect")
    parser.add_argument("--style", default=None, help="Caption animation style")
    args = parser.parse_args()

    # Resolve the project dir. The step is a CLI subprocess, not an HTTP
    # handler, so convert the route's HTTPException(404) into a structured fail.
    try:
        project_dir = get_project_dir(args.project_id)
    except Exception as e:
        if e.__class__.__name__ == "HTTPException":
            fail("project_not_found", f"Project '{args.project_id}' not found")
        raise

    project_path = os.path.join(str(project_dir), "project.json")
    try:
        with open(project_path, encoding="utf-8") as f:
            project = json.load(f)
    except Exception:
        fail("project_not_found", f"project.json for {args.project_id} not found")

    try:
        source, keeps = extract_keeps(project)
    except ValueError as e:
        fail("extract_keeps_failed", str(e))

    style = resolve_style(args.style, project)

    materialize_cut_py = os.path.join(MONTAJ_ROOT, "steps", "transform", "materialize_cut.py")
    transcribe_py = os.path.join(MONTAJ_ROOT, "steps", "speech", "transcribe.py")
    caption_py = os.path.join(MONTAJ_ROOT, "steps", "lyrics", "caption.py")

    d = str(project_dir)
    cut_spec_path = os.path.join(d, "_caption_cut.json")
    cut_mp4_path = os.path.join(d, "_caption_cut.mp4")
    words_prefix = os.path.join(d, "_caption_words")
    words_json_path = os.path.join(d, "_caption_words.json")
    words_srt_path = os.path.join(d, "_caption_words.srt")
    track_path = os.path.join(d, "_caption_track.json")

    try:
        # 1. Write the trim spec.
        with open(cut_spec_path, "w") as f:
            json.dump({"input": source, "keeps": keeps}, f)

        # 2. Materialise the trimmed timeline to a plain MP4.
        run([sys.executable, materialize_cut_py,
             "--input", cut_spec_path, "--out", cut_mp4_path])

        # 3. Transcribe the materialised cut as a plain video so word timings
        #    are output/project-time (NOT a trim spec).
        run([sys.executable, transcribe_py,
             "--input", cut_mp4_path,
             "--model", args.model, "--language", args.language,
             "--out", words_prefix])

        # 4. Group words into a styled caption track.
        run([sys.executable, caption_py,
             "--input", words_json_path, "--style", style, "--out", track_path])

        # 5. Load the track, carry forward the prior theme, persist onto project.
        with open(track_path, encoding="utf-8") as f:
            track = json.load(f)
        merge_caption_theme(track, project.get("captions"))
        project["captions"] = track
        with open(project_path, "w") as f:
            json.dump(project, f, indent=2)

        print(json.dumps(track))
    finally:
        for tmp in (cut_spec_path, cut_mp4_path, words_json_path,
                    words_srt_path, track_path):
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:
                pass


if __name__ == "__main__":
    main()
