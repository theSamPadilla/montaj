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
        "--print", "before_dl:[montaj] title %(title)j",
        "--print", "before_dl:[montaj] size %(filesize,filesize_approx)s",
        "--progress-template",
        "download:[montaj] progress %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
        "--newline",
        "--no-quiet",
        "-o", str(Path("/p/proj") / "youtube-dQw4w9WgXcQ.%(ext)s"),
        CANON,
    ]


# §51: our own lines. The title line's shape was measured (yt-dlp 2026.03.17,
# jNQXAC9IVRw, 2026-10-11): `[montaj] title "Me at the zoo"`, before the download.
def test_parse_montaj_line():
    p = youtube.parse_montaj_line
    assert p('[montaj] title "Me at the zoo"') == ("title", "Me at the zoo")
    assert p('[montaj] title "  two\\nlines\\tand   spaces "') == ("title", "two lines and spaces")
    assert p('[montaj] title "' + "x" * 300 + '"') == ("title", "x" * youtube.TITLE_MAX)
    assert p('[montaj] title ""') is None
    assert p("[montaj] title NA") is None
    assert p("[montaj] title 3") is None
    assert p("[montaj] size 635110") == ("size", 635110)
    assert p("[montaj] size NA") == ("size", None)
    assert p("[montaj] progress 150 600 NA") == ("progress", 150, 600)
    assert p("[montaj] progress 150 NA 612.5") == ("progress", 150, 612)
    assert p("[montaj] progress 150 NA NA") == ("progress", 150, None)
    assert p("[montaj] progress NA 600 NA") is None
    assert p("[montaj] progress 1 2") is None
    assert p("[download]  14.9% of  422.93KiB") is None
    assert p("/p/proj/youtube-x.mp4") is None
    # parse_printed_path never takes one of ours for the file.
    assert youtube.parse_printed_path('[montaj] title "/etc/passwd"\n[montaj] size 1\n') is None


def test_download_progress_with_the_whole_size_spans_both_streams_and_never_goes_back():
    d = youtube.DownloadProgress()
    d.size(1000)
    assert [d.update(n, 600) for n in (0, 300, 600)] == [0, 30, 60]
    # The audio stream starts from 0: the video's 600 bytes are kept.
    assert [d.update(n, 400) for n in (0, 100, 400)] == [60, 70, 99]
    assert d.percent == 99, "never 100: the merge still follows"


def test_download_progress_without_a_size_is_the_stream_percent_and_never_goes_back():
    d = youtube.DownloadProgress()
    d.size(None)
    assert [d.update(n, 200) for n in (0, 50, 100)] == [0, 25, 50]
    assert [d.update(n, 100) for n in (0, 20, 90)] == [50, 50, 90]
    e = youtube.DownloadProgress()
    assert e.update(10, None) == 0, "no size at all: 0, never a guess"


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
