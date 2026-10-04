#!/usr/bin/env python3
"""Apply an edited speech text (the file speech_text wrote) to a project in one write.

Prints the result of lib.speech_apply.apply as one JSON object. Refusals go through fail().
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from common import fail
from lib.speech_apply import apply


def main():
    parser = argparse.ArgumentParser(description="Apply an edited speech text to a project")
    parser.add_argument("--project", required=True, help="Absolute path to project.json")
    parser.add_argument("--text", required=True, help="Absolute path of the edited speech text")
    parser.add_argument("--preview", action="store_true", help="Show the result and change nothing")
    parser.add_argument("--max-pause", type=float, default=None, help="Cap unchanged pauses, in seconds")
    args = parser.parse_args()

    project_path = os.path.abspath(args.project)
    if not os.path.isfile(project_path):
        fail("not_found", f"Project not found: {project_path}")
    text_path = os.path.abspath(args.text)
    if not os.path.isfile(text_path):
        fail("not_found", f"Speech text not found: {text_path}")
    with open(text_path, encoding="utf-8") as f:
        text = f.read()

    result = apply(project_path, text, preview=args.preview, max_pause=args.max_pause)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
