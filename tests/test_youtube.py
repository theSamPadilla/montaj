"""lib/youtube.py: link parsing, the yt-dlp argv and the failure classifier.

Pure functions only. Classifier cases read tests/fixtures/ytdlp/*.txt, each
headed by a `# captured <date>, yt-dlp <version>` line (or `# NOT captured`
with the source of its pattern). No subprocess and no network here.
"""
import sys
from pathlib import Path

import pytest

from lib import youtube

FIX = Path(__file__).parent / "fixtures" / "ytdlp"
CANON = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


@pytest.mark.parametrize("raw", [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&index=2",
    "youtube.com/watch?v=dQw4w9WgXcQ",
    "m.youtube.com/watch?v=dQw4w9WgXcQ&t=30",
    "https://youtu.be/dQw4w9WgXcQ?si=x",
    "  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ",
])
def test_parse_accepts_watch_and_short_links(raw):
    assert youtube.parse_youtube_url(raw) == {"ok": True, "url": CANON, "id": "dQw4w9WgXcQ"}


@pytest.mark.parametrize("raw,reason", [
    ("https://www.youtube.com/shorts/dQw4w9WgXcQ", "shorts"),
    ("https://music.youtube.com/watch?v=dQw4w9WgXcQ", "invalid"),
    ("https://www.youtube.com/embed/dQw4w9WgXcQ", "invalid"),
    ("https://www.youtube.com/live/dQw4w9WgXcQ", "invalid"),
    ("https://www.youtube.com/playlist?list=PL1", "invalid"),
    ("https://www.youtube.com/watch?list=PL1", "invalid"),
    ("https://www.youtube.com/watch?v=dQw4w9WgXc", "invalid"),
    ("http://example.com/watch?v=dQw4w9WgXcQ", "invalid"),
    ("", "invalid"),
    (None, "invalid"),
])
def test_parse_refuses(raw, reason):
    assert youtube.parse_youtube_url(raw) == {"ok": False, "reason": reason}


def test_argv_is_the_plan_list_exactly():
    argv = youtube.ytdlp_argv(CANON, "/p/proj", "dQw4w9WgXcQ")
    assert argv[:3] == [sys.executable, "-m", "yt_dlp"]
    assert argv == [
        sys.executable, "-m", "yt_dlp",
        "--no-update", "--no-playlist", "--js-runtimes", "node",
        "-f", "bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4]/b",
        "--merge-output-format", "mp4",
        "--match-filters", "duration<=10800",
        "--max-filesize", "4G",
        "--socket-timeout", "30",
        "--continue",
        "--print", "after_move:filepath",
        "--no-quiet",
        "-o", str(Path("/p/proj") / "youtube-dQw4w9WgXcQ.%(ext)s"),
        CANON,
    ]


def _fixture(name):
    text = (FIX / f"{name}.txt").read_text()
    head, rest = text.split("\n", 1)
    assert head.startswith("# captured 2026-10-0") or head.startswith("# NOT captured")
    code_line, rest = rest.split("\n", 1)
    out, err = rest.split("--- stdout\n", 1)[1].split("--- stderr\n", 1)
    return int(code_line.removeprefix("exit: ")), out, err


@pytest.mark.parametrize("name,code", [
    ("unavailable", "unavailable"),
    ("age_gated", "unavailable"),
    ("bot_check", "blocked"),
    ("offline", "offline"),
    ("too_long", "too_long"),
    ("too_large", "too_large"),
    ("no_space", "no_space"),
    ("http_403", "failed"),
])
def test_classify_fixture(name, code):
    rc, out, err = _fixture(name)
    assert youtube.classify_error(rc, out, err) == code


def test_success_fixture_has_no_error_and_a_path():
    rc, out, err = _fixture("ok")
    assert youtube.classify_error(rc, out, err) is None
    assert youtube.parse_printed_path(out) == "/work/bundled-ok/youtube-jNQXAC9IVRw.mp4"


def test_exit_zero_without_a_path_is_too_long():
    assert youtube.classify_error(0, "", "") == "too_long"


def test_unknown_stderr_is_failed():
    assert youtube.classify_error(1, "", "ERROR: something new") == "failed"
    assert youtube.parse_printed_path("[download] x\n") is None
