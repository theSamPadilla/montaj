#!/usr/bin/env python3
"""Download a video or playlist from a URL using yt-dlp."""
import json, os, re, sys, argparse
from urllib.parse import urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, run
from youtube import classify_error

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")

_HINTS = {
    "unavailable": "That video is private, removed or restricted; use another video.",
    "blocked": "YouTube refused the request. Try again later or use another video.",
    "offline": "No network reached the site. Check the connection and retry.",
    "too_long": "The video is too long to download; use a shorter one.",
    "too_large": "The video is too large to download; use a smaller one.",
    "no_space": "The disk is full; free space and retry.",
    "failed": "The download failed; see stderr_tail, then retry or use another URL.",
    "instagram_profile": "Instagram profiles can't be fetched; paste individual reel links.",
}

# One JSON object per downloaded video at after_move, so a profile prints one line each.
META_PRINT = ("after_move:%(.{id,title,uploader,description,view_count,like_count,comment_count,"
              "upload_date,duration,webpage_url,filepath})j")
DESCRIPTION_MAX = 2200

# With --max-filesize, every video the run considers prints this marker at
# yt-dlp's after_filter stage, before any size check. --print makes yt-dlp
# quiet, so a video refused for its size (--max-filesize on the file's
# Content-Length, or the size --match-filter on the chosen format) says nothing
# and exits 0 (measured, yt-dlp 2026.03.17): seen but never saved means too
# large.
SEEN = "montaj-seen"


def _is_youtube(url):
    host = (urlparse(url if "://" in url else "https://" + url).hostname or "").lower()
    return host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com")


def _is_instagram(url):
    host = (urlparse(url if "://" in url else "https://" + url).hostname or "").lower()
    return host == "instagram.com" or host.endswith(".instagram.com")


def parse_meta_lines(stdout):
    """{"paths", "videos"} from the JSON lines of a `meta` run, or None when there are none.

    Lines that are not a JSON object with an id (progress, merger notes) are skipped.
    A value yt-dlp did not return is None.
    """
    paths, videos = [], []
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            info = json.loads(line)
        except ValueError:
            continue
        if not isinstance(info, dict) or not info.get("id"):
            continue
        desc = info.get("description")
        path = info.get("filepath")
        paths.append(path)
        videos.append({
            "id": info.get("id"),
            "path": path,
            "url": info.get("webpage_url"),
            "title": info.get("title"),
            "uploader": info.get("uploader"),
            "description": desc[:DESCRIPTION_MAX] if isinstance(desc, str) else None,
            "view_count": info.get("view_count"),
            "like_count": info.get("like_count"),
            "comment_count": info.get("comment_count"),
            "upload_date": info.get("upload_date"),
            "duration": info.get("duration"),
        })
    if not videos:
        return None
    return {"paths": paths, "videos": videos}


def stderr_tail(text, lines=15, limit=2048):
    """Last `lines` lines of stderr, ANSI stripped, at most `limit` characters."""
    clean = _ANSI.sub("", text or "").strip().splitlines()
    return "\n".join(clean[-lines:])[-limit:]


def classify_failure(url, returncode, stdout, stderr):
    """(code, hint) for a failed yt-dlp run."""
    code = (classify_error(returncode, stdout, stderr) if _is_youtube(url) else None) or "failed"
    if code == "failed" and _is_instagram(url) and (
            "[instagram:user]" in (stderr or "") or "Unsupported URL" in (stderr or "")):
        return "instagram_profile", _HINTS["instagram_profile"]
    if "Requested format is not available" in (stderr or ""):
        return code, "That format isn't offered for this video; leave format unset."
    if code == "failed" and "HTTP Error 403" in (stderr or ""):
        return code, "The site refused the media request (HTTP 403). Retry later or use another video."
    return code, _HINTS[code]


def _fail_with(code, hint, stderr):
    """The failure JSON on stderr, then exit 1. stderr_tail goes FIRST: the MCP
    wrapper keeps only the last 2000 chars of stderr, so the code and hint must
    come last."""
    tail = stderr_tail(stderr)
    print(json.dumps({
        "stderr_tail": tail,
        "hint": hint,
        "code": code,
        "error": code,
        "message": f"{code}: {hint}\n{tail}",
    }), file=sys.stderr)
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Download a video from a URL using yt-dlp")
    parser.add_argument("--url",    required=True, help="URL to download (video, profile, or playlist)")
    parser.add_argument("--out",    help="Output directory or file path. Defaults to current directory.")
    parser.add_argument("--format", default="bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
                        help="yt-dlp format selector")
    parser.add_argument("--limit",  type=int, help="Max number of videos to download from a playlist or channel")
    parser.add_argument("--max-filesize", type=int,
                        help="Refuse, before downloading, a video larger than this many bytes when its size is known")
    parser.add_argument("--meta",   action="store_true",
                        help="Also return each video's id, title, uploader, caption text, views, likes, comments, upload date and duration as JSON")
    args = parser.parse_args()

    out = args.out or os.getcwd()
    cmd = [
        # montaj's own interpreter, never a PATH lookup: a packaged app has a
        # minimal PATH and must not depend on a system yt-dlp.
        sys.executable, "-m", "yt_dlp",
        "--format", args.format,
        "--merge-output-format", "mp4",
        "--print", META_PRINT if args.meta else "after_move:filepath",
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

    if args.max_filesize:
        n = args.max_filesize
        # The chosen format's size (a merged format's is the sum of its parts),
        # unknown sizes let through, then the file's own Content-Length.
        cmd += ["--match-filter", f"filesize<=?{n} & filesize_approx<=?{n}",
                "--max-filesize", str(n),
                "--print", f"after_filter:{SEEN} %(id)s"]

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
        # THE TAIL, NOT THE HEAD: yt-dlp writes warnings first and the fatal
        # error last, so a head slice reports the least useful text.
        # stderr_tail goes FIRST in the JSON: the MCP wrapper keeps only the
        # last 2000 chars of stderr, so the code and hint must come last.
        code, hint = classify_failure(args.url, r.returncode, r.stdout, r.stderr)
        _fail_with(code, hint, r.stderr)

    lines = [line.strip() for line in r.stdout.strip().splitlines() if line.strip()]
    seen = [line for line in lines if line.startswith(SEEN + " ")]
    output = [line for line in lines if not line.startswith(SEEN + " ")]

    def nothing_saved():
        if seen:
            _fail_with("too_large", _HINTS["too_large"], r.stderr)
        fail("no_output", "yt-dlp produced no output files")

    if args.meta:
        got = parse_meta_lines("\n".join(output))
        if not got:
            nothing_saved()
        print(json.dumps(got))
        return

    paths = output

    if not paths:
        nothing_saved()

    if len(paths) == 1:
        print(paths[0])
    else:
        print(json.dumps({"paths": paths}))


if __name__ == "__main__":
    main()
