#!/usr/bin/env python3
"""Which words play at a timeline time or in a timeline range, through the project's current cut.

Read-only. Prints {start, end, words, count}; each word carries its timeline start/end, text, source
and source time.
"""
import argparse, json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from common import fail
from lib.speech_words_at import words_at


def main():
    parser = argparse.ArgumentParser(description="Words that play in a timeline range")
    parser.add_argument("--project", required=True, help="Absolute path to project.json")
    parser.add_argument("--t", type=float, default=None, help="One timeline time, in seconds")
    parser.add_argument("--start", type=float, default=None, help="Range start, in seconds")
    parser.add_argument("--end", type=float, default=None, help="Range end, in seconds")
    parser.add_argument("--track", default=None, help="Only this track id")
    args = parser.parse_args()

    if args.t is not None:
        if args.start is not None or args.end is not None:
            fail("invalid_param", "Pass t, or start and end, not both")
        start = end = args.t
    elif args.start is not None and args.end is not None:
        start, end = args.start, args.end
    else:
        fail("invalid_param", "Pass t, or both start and end")
    if start < 0 or end < start:
        fail("invalid_param", "Times must be >= 0 and end must not be before start")

    project_path = os.path.abspath(args.project)
    if not os.path.isfile(project_path):
        fail("not_found", f"Project not found: {project_path}")
    with open(project_path, encoding="utf-8") as f:
        project = json.load(f)

    words = words_at(project, os.path.dirname(project_path), start, end, args.track)
    print(json.dumps({"start": start, "end": end, "count": len(words), "words": words}, ensure_ascii=False))


if __name__ == "__main__":
    main()
