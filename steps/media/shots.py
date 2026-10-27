#!/usr/bin/env python3
"""shots: label a long source's shots once (lib/shots.py). One call answers the source's shots (where the picture
changes, each with a motion score) and ONE sheet with a tile per shot, numbered; a call with `labels` saves the
agent's few words per shot by number. The list and the labels live in a sidecar beside the file (`<stem>.shots.json`),
never in project.json, so a later session reads them back without scanning again, and edit_timeline can add b-roll by
shot (the item takes the shot's real in and out)."""
import argparse
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "lib"))
from lib import shots as sh  # noqa: E402
from lib.common import fail  # noqa: E402


def resolve(project, clip):
    """(the clip id, its file, the editing proxy to scan when there is one) for a source id or a timeline item id."""
    entries = [s for s in (project.get("sources") or []) if isinstance(s, dict)]
    for t in project.get("tracks") or []:
        items = t.get("items") if isinstance(t, dict) else t
        entries += [it for it in (items or []) if isinstance(it, dict)]
    for e in entries:
        if e.get("id") == clip and isinstance(e.get("src"), str) and e["src"]:
            proxy = e.get("proxySrc") if isinstance(e.get("proxySrc"), str) and os.path.isfile(e["proxySrc"]) else None
            if not proxy:   # a timeline item names the file; its source may carry the proxy
                proxy = next((s.get("proxySrc") for s in entries if s.get("src") == e["src"] and isinstance(s.get("proxySrc"), str)
                              and os.path.isfile(s["proxySrc"])), None)
            return clip, e["src"], proxy
    ids = [s.get("id") for s in (project.get("sources") or []) if isinstance(s, dict) and s.get("type") == "video"]
    fail("clip_not_found", f"No clip or item {clip!r} in this project (its clips: {', '.join(map(str, ids[:20]))}).")


def main():
    parser = argparse.ArgumentParser(description="Label a long source's shots once: a sheet a shot, then labels")
    parser.add_argument("--project", required=True, help="The project id, its folder, or its project.json")
    parser.add_argument("--clip", required=True, help="The source's clip id, or a timeline item id")
    parser.add_argument("--labels", default=None, help='Labels by shot number, a JSON object: {"7": "mannequin pulled out"}')
    parser.add_argument("--redetect", action="store_true", help="Find the shots again (labels of shots still there are kept)")
    args = parser.parse_args()

    project_path = args.project
    if os.path.isdir(project_path):
        project_path = os.path.join(project_path, "project.json")
    try:
        with open(project_path, encoding="utf-8") as f:
            project = json.load(f)
    except (OSError, ValueError):
        fail("not_found", f"Project not readable: {project_path}")
    clip, src, proxy = resolve(project, args.clip)
    if not os.path.isfile(src):
        fail("file_not_found", f"The clip's file is missing: {src}")

    try:
        if args.labels is not None:
            try:
                labels = json.loads(args.labels)
            except ValueError:
                fail("invalid_labels", 'labels is a JSON object of shot number to a few words: {"7": "mannequin pulled out"}.')
            if not isinstance(labels, dict):
                fail("invalid_labels", 'labels is a JSON object of shot number to a few words: {"7": "mannequin pulled out"}.')
            if sh.read_sidecar(src) is None:
                sh.shots_for(src, scan_path=proxy)
            print(json.dumps({"clip": clip, "src": src, "shots": sh.label(src, labels)["shots"]}))
            return
        found = sh.shots_for(src, redetect=args.redetect, scan_path=proxy)
    except sh.ShotsError as e:
        fail("invalid_labels", str(e))
    samples = os.path.join(os.path.dirname(os.path.abspath(project_path)), "render", "samples")
    out = os.path.join(samples, f"shots-{re.sub(r'[^A-Za-z0-9_.-]', '_', clip)}.jpg")
    sh.sheet(src, found["shots"], out, scan_path=proxy)
    print(json.dumps({"clip": clip, "src": src, "shots": found["shots"], "sheet": out}))


if __name__ == "__main__":
    main()
