#!/usr/bin/env python3
"""Download a video or playlist from a URL using yt-dlp."""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, run


def main():
    parser = argparse.ArgumentParser(description="Download a video from a URL using yt-dlp")
    parser.add_argument("--url",    required=True, help="URL to download (video, profile, or playlist)")
    parser.add_argument("--out",    help="Output directory or file path. Defaults to current directory.")
    parser.add_argument("--format", default="bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
                        help="yt-dlp format selector")
    parser.add_argument("--limit",  type=int, help="Max number of videos to download from a playlist or channel")
    args = parser.parse_args()

    out = args.out or os.getcwd()
    cmd = [
        "yt-dlp",
        "--format", args.format,
        "--merge-output-format", "mp4",
        "--print", "after_move:filepath",
    ]

    if args.limit:
        cmd += ["--max-downloads", str(args.limit)]

    # If out has no extension treat it as a directory
    if os.path.isdir(out) or not os.path.splitext(out)[1]:
        os.makedirs(out, exist_ok=True)
        cmd += ["--output", os.path.join(out, "%(id)s.%(ext)s")]
    else:
        parent = os.path.dirname(os.path.abspath(out))
        if parent:
            os.makedirs(parent, exist_ok=True)
        cmd += ["--output", out]

    cmd.append(args.url)

    r = run(cmd, check=False)
    # yt-dlp exits 101 when --max-downloads limit is reached — that's expected, not an error
    if r.returncode not in (0, 101):
        fail("unexpected_error", f"Command failed: {' '.join(cmd)}\n{r.stderr[:500]}")

    paths = [line.strip() for line in r.stdout.strip().splitlines() if line.strip()]

    if not paths:
        fail("no_output", "yt-dlp produced no output files")

    if len(paths) == 1:
        print(paths[0])
    else:
        print(json.dumps({"paths": paths}))


if __name__ == "__main__":
    main()
