#!/usr/bin/env python3
"""Download a video or playlist from a URL using yt-dlp."""
import json, os, sys, argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
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
        # YouTube extraction needs a JavaScript runtime to run the player JS,
        # and yt-dlp enables ONLY deno by default. Without one it degrades to
        # "No supported JavaScript runtime could be found", then "No title
        # found in player responses", then fails outright. That is not
        # hypothetical: it is what every YouTube fetch did on Hub's sidecar,
        # which ships Node 20 and no deno.
        #
        # THIS ADDS A RUNTIME, IT DOES NOT REPLACE THE DEFAULT SET. yt-dlp
        # documents the flag as "Additional JavaScript runtime to enable" and
        # picks "the highest priority runtime that is both enabled and
        # available", with deno ranked above node. So a machine with deno keeps
        # using deno and is unaffected, a machine with only node now works, and
        # a machine with neither fails exactly as it did before. That is why
        # this is safe to hardcode in a package other people install.
        "--js-runtimes", "node",
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
        # THE TAIL, NOT THE HEAD, AND THAT IS THE WHOLE POINT. yt-dlp writes
        # warnings first and the fatal error last, so `stderr[:500]` reliably
        # reports the least useful 500 characters it produced. A real failure
        # reached a caller as "ERROR: [youtube" with the cause cut off, and
        # diagnosing it took reading the sidecar's own logs by timestamp.
        # 4000 matches `lib/common.py`'s existing slice; this file was the
        # outlier at 500, not the convention.
        fail("unexpected_error", f"Command failed: {' '.join(cmd)}\n{r.stderr[-4000:]}")

    paths = [line.strip() for line in r.stdout.strip().splitlines() if line.strip()]

    if not paths:
        fail("no_output", "yt-dlp produced no output files")

    if len(paths) == 1:
        print(paths[0])
    else:
        print(json.dumps({"paths": paths}))


if __name__ == "__main__":
    main()
