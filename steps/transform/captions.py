#!/usr/bin/env python3
"""captions (§558): restyle a project's caption track in one call (the rules are lib/caption_style.py).

The write: `captions` only, through lib/project_lock.update_project_or_fail (under the project lock, which also
checks a Studio sync clash), with a version of the project first (restyling changes captions a person may have
styled). The captions as read are compared under the lock (project_revisions.revision_of): any change since, a
person's edit or a regeneration, refuses `project_changed` and writes nothing. Prints one short JSON.
"""
import argparse, json, os, sys

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib import caption_style, project_revisions  # noqa: E402
from lib.common import fail  # noqa: E402
from lib.project_lock import update_project_or_fail  # noqa: E402
from lib.project_versions import commit_version, is_own_repo  # noqa: E402

VERSION_MESSAGE = "version: before captions"
STEP_LOCK_TIMEOUT = 30.0
STYLE_FIELDS = ("style", "color", "accentColor", "highlightColor", "activeColor", "fontsize")


def _short(report, cap=300):
    out = {"style": report["style"], "segments": report["segments"]}
    for k in ("position", "size"):
        if k in report:
            out[k] = report[k]
    if "accent" in report:
        out["accent"] = report["accent"]
    if report["issues"]:
        out["issues"] = report["issues"]
    # the missed words matter most after the counts: trim the found list first if it runs long
    while len(json.dumps(out)) > cap and out.get("accent", {}).get("found"):
        out["accent"]["found"] = out["accent"]["found"][:-1]
        out["accent"]["more"] = out["accent"].get("more", 0) + 1
    return out


def run(project_path, *, look=None, color=None, highlight=None, accent=None, position=None, size=None, detail=False):
    project_path = os.path.abspath(project_path)
    project_dir = os.path.dirname(project_path)
    try:
        with open(project_path, encoding="utf-8") as f:
            project = json.load(f)
    except (OSError, ValueError):
        fail("not_found", f"Project not readable: {project_path}")
    read_rev = project_revisions.revision_of(project.get("captions"))
    try:
        new, report = caption_style.restyle(project.get("captions"), look=look, color=color, highlight=highlight,
                                            accent=accent, position=position, size=size)
    except caption_style.StyleError as e:
        fail("no_captions" if "no captions" in str(e) else "invalid_params", str(e))
    if new == project.get("captions"):
        out = _short(report)
        out["unchanged"] = True
        return out
    version = commit_version(project_dir, VERSION_MESSAGE)
    if not version and not is_own_repo(project_dir):
        report["issues"].append("no version saved: the project folder is not its own git repository")

    def apply(fresh):
        if project_revisions.revision_of(fresh.get("captions")) != read_rev:
            fail("project_changed", "The captions changed since captions read them (an edit in the editor, or new "
                                    "captions). Run captions again.")
        fresh["captions"] = new
        return fresh

    update_project_or_fail(project_path, apply, fail, timeout=STEP_LOCK_TIMEOUT)
    out = _short(report)
    if version:
        out["version"] = True
    if detail:
        out["track"] = {k: new[k] for k in STYLE_FIELDS if k in new}
    return out


def main():
    parser = argparse.ArgumentParser(description="Restyle a project's captions in one call")
    parser.add_argument("--project", required=True, help="Absolute path to project.json")
    parser.add_argument("--look", default=None)
    parser.add_argument("--color", default=None)
    parser.add_argument("--highlight", default=None)
    parser.add_argument("--accent", default=None)
    parser.add_argument("--position", default=None)
    parser.add_argument("--size", default=None)
    parser.add_argument("--detail", action="store_true")
    args = parser.parse_args()
    project_path = os.path.abspath(args.project)
    if not os.path.isfile(project_path):
        fail("not_found", f"Project not found: {project_path}")
    print(json.dumps(run(project_path, look=args.look, color=args.color, highlight=args.highlight, accent=args.accent,
                         position=args.position, size=args.size, detail=args.detail)))


if __name__ == "__main__":
    main()
