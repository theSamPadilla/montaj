#!/usr/bin/env python3
"""montaj profile — creator profile management."""
import glob, os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("profile", help="Creator profile management (analyze, list)")
    sub = p.add_subparsers(dest="profile_command", required=True)

    # montaj profile analyze
    a = sub.add_parser("analyze", help="Analyze videos and write analysis_current.json")
    a.add_argument("--name",    required=True, help="Profile name (e.g. techbyjaz)")
    a.add_argument("--source",  choices=["current", "inspired"], default="current")
    a.add_argument("--videos",  nargs="+", metavar="VIDEO",
                   help="Video files to analyze. Omit to auto-discover from ~/.montaj/profiles/<name>/videos/<source>/")
    add_global_flags(a)
    a.set_defaults(func=handle_analyze)

    # montaj profile list
    ls = sub.add_parser("list", help="List all profiles")
    ls.set_defaults(func=handle_list)

    p.set_defaults(func=lambda args: p.print_help())


def handle_analyze(args):
    out = args.out or os.path.expanduser(f"~/.montaj/profiles/{args.name}/")

    videos = args.videos
    if not videos:
        videos_dir = os.path.join(out, "videos", args.source)
        videos = sorted(glob.glob(os.path.join(videos_dir, "*.mp4")))
        if not videos:
            emit_error("no_videos", f"No videos found in {videos_dir}. Pass --videos or run montaj fetch first.")
            sys.exit(1)

    cmd = [
        sys.executable,
        os.path.join(MONTAJ_ROOT, "profiles", "analyze.py"),
        "--name",   args.name,
        "--source", args.source,
        "--out",    out,
        "--videos", *videos,
    ]

    result = subprocess.run(cmd, capture_output=False, text=True)
    if result.returncode != 0:
        sys.exit(result.returncode)


R  = "\033[0m"
Y  = "\033[33;1m"
C  = "\033[36m"
D  = "\033[2m"
G  = "\033[32m"


def handle_list(args):
    profiles_dir = os.path.expanduser("~/.montaj/profiles/")
    if not os.path.isdir(profiles_dir):
        print(f"{D}no profiles found{R}")
        return
    found = False
    for entry in sorted(os.listdir(profiles_dir)):
        path = os.path.join(profiles_dir, entry)
        if not os.path.isdir(path):
            continue
        if not os.path.isfile(os.path.join(path, "analysis_current.json")):
            continue
        found = True
        style_path = os.path.join(path, "style_profile.md")
        username = entry
        summary = ""
        videos  = ""
        if os.path.isfile(style_path):
            with open(style_path) as f:
                text = f.read()
            if text.startswith("---"):
                try:
                    end = text.index("---", 3)
                    for line in text[3:end].strip().splitlines():
                        if line.startswith("username:"):
                            username = line.partition(":")[2].strip()
                        elif line.startswith("style_summary:"):
                            summary = line.partition(":")[2].strip()
                        elif line.startswith("videos_current:"):
                            videos = line.partition(":")[2].strip()
                except ValueError:
                    pass
        videos_str = f" {D}({videos} videos){R}" if videos else ""
        summary_str = f"\n    {D}{summary}{R}" if summary else ""
        print(f"  {C}{username}{R}{videos_str}{summary_str}")
    if not found:
        print(f"{D}no profiles found{R}")
