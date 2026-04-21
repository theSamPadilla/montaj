#!/usr/bin/env python3
"""montaj fetch — download a video from a URL using yt-dlp."""
import os, subprocess, sys
from cli.main import MONTAJ_ROOT, add_global_flags, find_step
from cli.output import emit, emit_error


def register(subparsers):
    p = subparsers.add_parser("fetch", help="Download a video from a URL (YouTube, TikTok, Instagram, etc.)")
    p.add_argument("url", help="URL to download")
    p.add_argument("--format", default="bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
                   help="yt-dlp format selector")
    p.add_argument("--limit", type=int, help="Max number of videos (for playlists / channels)")
    add_global_flags(p)
    p.set_defaults(func=handle)


def handle(args):
    cmd = [
        sys.executable,
        find_step("fetch"),
        "--url", args.url,
        "--format", args.format,
    ]
    if args.limit:
        cmd += ["--limit", str(args.limit)]
    if args.out:
        cmd += ["--out", args.out]

    result = subprocess.run(cmd, capture_output=True, text=True)
    emit(result, as_json=args.json, quiet=args.quiet)
