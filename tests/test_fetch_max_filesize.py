"""montaj/fetch `max-filesize` (§90 in the app: a page's video is size-checked
before it downloads).

The stubbed runs use stdout captured from the bundled yt-dlp (2026.03.17) on
2026-10-10, serving a 32 KB clip from a loopback http.server: refused by
--max-filesize, the run printed only `montaj-seen clip` and exited 0 (101 with
--max-downloads 1); let through, the marker and then the file's path. The last
test repeats that run for real, so a yt-dlp that changes the shape fails here.
"""
import json
import functools
import http.server
import importlib.util
import subprocess
import sys
import threading

import pytest

from tests.test_fetch_meta import OUT, TEMPLATE, YT, _argv, _run_main
import fetch  # noqa: E402  (test_fetch_meta put steps/media on the path)

SIZE_FLAGS = ["--match-filter", "filesize<=?1000 & filesize_approx<=?1000",
              "--max-filesize", "1000", "--print", "after_filter:montaj-seen %(id)s"]


def _failure(monkeypatch, capsys, cli, rc, out):
    with pytest.raises(SystemExit) as e:
        _run_main(monkeypatch, capsys, cli, rc, out)
    assert e.value.code == 1
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


def test_argv_adds_the_size_filter_the_cap_and_the_marker(monkeypatch, capsys):
    cmd, _ = _run_main(monkeypatch, capsys, ["--url", YT, "--out", OUT, "--max-filesize", "1000"], 0,
                       "montaj-seen clip\n/p/clip.mp4\n")
    assert cmd == _argv(SIZE_FLAGS + ["--output", OUT + "/%(id)s.%(ext)s", YT])


def test_seen_and_saved_prints_only_the_path(monkeypatch, capsys):
    _, out = _run_main(monkeypatch, capsys, ["--url", YT, "--out", OUT, "--max-filesize", "1000"], 0,
                       "montaj-seen clip\n/p/clip.mp4\n")
    assert out == "/p/clip.mp4\n"


@pytest.mark.parametrize("rc", [0, 101])
def test_seen_but_not_saved_is_too_large(monkeypatch, capsys, rc):
    j = _failure(monkeypatch, capsys, ["--url", YT, "--out", OUT, "--max-filesize", "1000"], rc, "montaj-seen clip\n")
    assert j["error"] == j["code"] == "too_large"
    assert j["hint"] == fetch._HINTS["too_large"]


def test_meta_skips_the_marker_and_reads_too_large_the_same_way(monkeypatch, capsys):
    line = json.dumps({"id": "clip", "filepath": "/p/clip.mp4"})
    cmd, out = _run_main(monkeypatch, capsys, ["--url", YT, "--out", OUT, "--meta", "--max-filesize", "1000"], 0,
                         f"montaj-seen clip\n{line}\n")
    assert cmd == _argv(SIZE_FLAGS + ["--output", OUT + "/%(id)s.%(ext)s", YT], TEMPLATE)
    assert json.loads(out)["paths"] == ["/p/clip.mp4"]
    j = _failure(monkeypatch, capsys, ["--url", YT, "--out", OUT, "--meta", "--max-filesize", "1000"], 0, "montaj-seen clip\n")
    assert j["code"] == "too_large"


def test_nothing_seen_is_still_no_output(monkeypatch, capsys):
    j = _failure(monkeypatch, capsys, ["--url", YT, "--out", OUT, "--max-filesize", "1000"], 0, "")
    assert j["error"] == "no_output"


@pytest.mark.skipif(importlib.util.find_spec("yt_dlp") is None, reason="yt-dlp is not installed")
@pytest.mark.parametrize("cap,saved", [(1_000, False), (1_000_000, True)])
def test_real_yt_dlp_on_loopback(tmp_path, cap, saved):
    www = tmp_path / "www"
    www.mkdir()
    (www / "clip.mp4").write_bytes(b"\0" * 32 * 1024)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(www))
    handler.log_message = lambda *a, **k: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/clip.mp4"
        out = tmp_path / "out"
        r = subprocess.run(
            [sys.executable, str(fetch.__file__), "--url", url, "--out", str(out), "--limit", "1", "--max-filesize", str(cap)],
            capture_output=True, text=True, timeout=120,
        )
    finally:
        server.shutdown()
    if saved:
        assert r.returncode == 0, r.stderr
        assert r.stdout.strip() == str(out / "clip.mp4")
    else:
        assert r.returncode == 1
        assert json.loads(r.stderr.strip().splitlines()[-1])["code"] == "too_large"
        assert not (out / "clip.mp4").exists()
