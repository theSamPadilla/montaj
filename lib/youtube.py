"""YouTube link parsing and yt-dlp helpers for a Clips source.

Pure functions: no subprocess, no network. serve/routes/projects.py spawns
the process; this module only builds its argv and reads what it printed.
"""
from __future__ import annotations

import json
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
        # §51: the title (the project's name when it has none) and the whole
        # download's size, before it starts, then one progress line per update.
        # All start with "[", so parse_printed_path skips them.
        "--print", f"before_dl:{MONTAJ_PREFIX} title %(title)j",
        "--print", f"before_dl:{MONTAJ_PREFIX} size %(filesize,filesize_approx)s",
        "--progress-template",
        f"download:{MONTAJ_PREFIX} progress %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
        "--newline",
        "--no-quiet",
        "-o", str(Path(out_dir) / f"youtube-{video_id}.%(ext)s"),
        url,
    ]


MONTAJ_PREFIX = "[montaj]"
TITLE_MAX = 120


def _count(token: str) -> int | None:
    """A byte count yt-dlp printed, or None for NA, a float's junk or anything else."""
    try:
        n = int(float(token))
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def parse_montaj_line(line: str):
    """One of our own lines (ytdlp_argv's prints and progress template), else None:
    ("title", str) | ("size", int | None) | ("progress", downloaded, total | None)."""
    line = (line or "").strip()
    if not line.startswith(MONTAJ_PREFIX + " "):
        return None
    kind, _, rest = line[len(MONTAJ_PREFIX) + 1:].partition(" ")
    if kind == "title":
        try:
            title = json.loads(rest)
        except ValueError:
            return None
        if not isinstance(title, str):
            return None
        title = " ".join(title.split())[:TITLE_MAX].strip()
        return ("title", title) if title else None
    if kind == "size":
        return ("size", _count(rest))
    if kind == "progress":
        parts = rest.split()
        if len(parts) != 3:
            return None
        down = _count(parts[0])
        if down is None:
            return None
        return ("progress", down, _count(parts[1]) or _count(parts[2]))
    return None


class DownloadProgress:
    """The whole download's percent from yt-dlp's per-stream progress. The
    format is a video stream then an audio stream (two downloads, each from
    0), so a stream's own percent restarts; this one never goes back, and it
    stays below 100 until the file is in place (the merge still follows).

    With the whole size known (the `size` line: a merged format's is the sum
    of its parts), it is the bytes of finished streams plus the current one
    over that size. Without it, the current stream's own percent."""

    CAP = 99

    def __init__(self):
        self.total = None
        self._finished = 0
        self._down = 0
        self._stream_total = None
        self.percent = 0

    def size(self, total) -> None:
        self.total = total if isinstance(total, int) and total > 0 else None

    def update(self, downloaded: int, stream_total) -> int:
        if downloaded < self._down:
            # A new stream started: the last one is done.
            self._finished += self._stream_total or self._down
        self._down = downloaded
        if stream_total:
            self._stream_total = stream_total
        if self.total:
            pct = (self._finished + downloaded) * 100 // self.total
        elif self._stream_total:
            pct = downloaded * 100 // self._stream_total
        else:
            pct = 0
        self.percent = max(self.percent, min(self.CAP, int(pct)))
        return self.percent


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
