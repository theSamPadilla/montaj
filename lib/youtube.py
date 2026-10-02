"""YouTube link parsing and yt-dlp helpers for a Clips source.

Pure functions: no subprocess, no network. serve/routes/projects.py spawns
the process; this module only builds its argv and reads what it printed.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

YOUTUBE_FORMAT = "bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4]/b"
MAX_DURATION_S = 10800
MAX_FILESIZE = "4G"

_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_WATCH_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com"}


def parse_youtube_url(raw) -> dict:
    """Return {ok, url, id} (canonical watch URL) or {ok: False, reason}.

    reason is "shorts" or "invalid". Only watch and youtu.be links pass;
    every other query parameter is dropped.
    """
    s = (raw or "").strip() if isinstance(raw, str) else ""
    if not s:
        return {"ok": False, "reason": "invalid"}
    if "://" not in s:
        s = "https://" + s
    u = urlparse(s)
    if u.scheme not in ("http", "https") or not u.hostname:
        return {"ok": False, "reason": "invalid"}
    host = u.hostname.lower()
    if host in _WATCH_HOSTS:
        if u.path.startswith("/shorts/"):
            return {"ok": False, "reason": "shorts"}
        if u.path != "/watch":
            return {"ok": False, "reason": "invalid"}
        vid = (parse_qs(u.query).get("v") or [""])[0]
    elif host == "youtu.be":
        vid = u.path.lstrip("/")
    else:
        return {"ok": False, "reason": "invalid"}
    if not _ID.match(vid):
        return {"ok": False, "reason": "invalid"}
    return {"ok": True, "url": f"https://www.youtube.com/watch?v={vid}", "id": vid}


def ytdlp_argv(url: str, out_dir, video_id: str) -> list[str]:
    """The yt-dlp command line. --no-quiet is needed: with --print alone,
    yt-dlp runs quiet and a duration or size skip prints nothing (measured
    2026-10-01), so too_long and too_large could not be told apart."""
    return [
        sys.executable, "-m", "yt_dlp",
        "--no-update", "--no-playlist", "--js-runtimes", "node",
        "-f", YOUTUBE_FORMAT,
        "--merge-output-format", "mp4",
        "--match-filters", f"duration<={MAX_DURATION_S}",
        "--max-filesize", MAX_FILESIZE,
        "--socket-timeout", "30",
        "--continue",
        "--print", "after_move:filepath",
        "--no-quiet",
        "-o", str(Path(out_dir) / f"youtube-{video_id}.%(ext)s"),
        url,
    ]


def parse_printed_path(stdout: str) -> str | None:
    """The `after_move:filepath` line: the last stdout line that is an
    absolute path (POSIX or a Windows drive path). Log lines start with `[`."""
    for line in reversed((stdout or "").splitlines()):
        line = line.strip()
        if not line or line.startswith("["):
            continue
        if line.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", line):
            return line
    return None


_OFFLINE = (
    "Unable to connect to proxy", "Failed to establish a new connection",
    "getaddrinfo failed", "nodename nor servname", "Name or service not known",
    "Temporary failure in name resolution", "Network is unreachable",
    "Connection refused", "timed out",
)
_BLOCKED = ("not a bot", "HTTP Error 429", "Too Many Requests")
_UNAVAILABLE = (
    "This video is unavailable", "Video unavailable", "Private video",
    "Sign in to confirm your age", "members-only", "Join this channel",
    "not available in your country", "has been removed", "age-restricted",
)


def classify_error(returncode: int, stdout: str, stderr: str) -> str | None:
    """None when the download finished, else one code: unavailable, blocked,
    offline, too_long, too_large, no_space or failed. Patterns come from
    tests/fixtures/ytdlp (real captures, plus two marked NOT captured)."""
    out, err = stdout or "", stderr or ""
    if returncode == 0:
        if parse_printed_path(out):
            return None
        if "larger than max-filesize" in out:
            return "too_large"
        return "too_long"
    both = out + "\n" + err
    if "No space left on device" in both or "Errno 28" in both:
        return "no_space"
    if "larger than max-filesize" in out:
        return "too_large"
    errs = "\n".join(l for l in err.splitlines() if l.startswith("ERROR"))
    if any(p in errs for p in _BLOCKED):
        return "blocked"
    if any(p in errs for p in _UNAVAILABLE):
        return "unavailable"
    if any(p in errs for p in _OFFLINE):
        return "offline"
    return "failed"
