#!/usr/bin/env python3
"""transcripts: the one transcript read (lib/transcripts.py). Every talking-head source's lines, with the ids cut's plan
and the brief use (A1, D7...), refined on its silences; or what plays on the timeline now, in timeline seconds. Text by
default, `words` for [text, start, end]. Complete in one call: nothing is trimmed."""
import argparse
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
from lib import transcripts as tr  # noqa: E402
from lib.common import fail  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="Every talking-head take's lines, or the timeline's, in one call")
    parser.add_argument("--project", required=True, help="The project id, its folder, or its project.json")
    parser.add_argument("--scope", default="all", help='"all", "timeline", or source ids or letters, comma-separated')
    parser.add_argument("--words", action="store_true", help="Each word with its start and end, not lines of text")
    args = parser.parse_args()

    project_path = args.project
    if os.path.isdir(project_path):
        project_path = os.path.join(project_path, "project.json")
    try:
        with open(project_path, encoding="utf-8") as f:
            project = json.load(f)
    except (OSError, ValueError):
        fail("not_found", f"Project not readable: {project_path}")
    project_dir = os.path.dirname(os.path.abspath(project_path))
    heads = tr.talking_heads(project, project_dir)
    scope = (args.scope or "all").strip()

    if scope == "timeline":
        entries = tr.on_timeline(project, project_dir, heads)
        if args.words:
            print(json.dumps({"scope": "timeline", "items": entries}))
        else:
            print(json.dumps({"scope": "timeline", "text": tr.timeline_text(entries)}))
        return

    letters = None
    if scope != "all":
        wanted = [x.strip() for x in scope.split(",") if x.strip()]
        known = {letter: letter for _, letter, _ in heads}
        known.update({str(s.get("id")): letter for s, letter, _ in heads})
        missing = [w for w in wanted if w not in known]
        if missing:
            names = ", ".join(f"{letter} = {s.get('id', '')}" for s, letter, _ in heads)
            fail("source_not_found", f"No talking-head source {', '.join(missing)} (they are: {names}; "
                                     "or \"all\", or \"timeline\").")
        letters = {known[w] for w in wanted}
    if args.words:
        lines = {ln.id: [[w.text, round(w.start, 3), round(w.end, 3)] for w in ln.words]
                 for s, letter, lns in heads if letters is None or letter in letters for ln in lns}
        print(json.dumps({"scope": scope, "lines": lines}))
        return
    print(json.dumps({"scope": scope, "text": tr.as_text(project, project_dir, heads, letters)}))


if __name__ == "__main__":
    main()
