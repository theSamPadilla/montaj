"""montaj/fetch failure output. Subprocess stubbed; fixtures from tests/fixtures/ytdlp."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "lib"))
sys.path.insert(0, str(ROOT / "steps" / "media"))
import fetch  # noqa: E402

from tests.test_youtube import _fixture  # noqa: E402

YT = "https://www.youtube.com/watch?v=jNQXAC9IVRw"


def _run_main(monkeypatch, capsys, url, rc, out, err):
    monkeypatch.setattr(sys, "argv", ["fetch", "--url", url, "--out", "/tmp/montaj-fetch-x"])
    monkeypatch.setattr(fetch, "run", lambda *a, **k: subprocess.CompletedProcess(a, rc, out, err))
    monkeypatch.setattr(fetch.os, "makedirs", lambda *a, **k: None)
    with pytest.raises(SystemExit) as e:
        fetch.main()
    assert e.value.code == 1
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


@pytest.mark.parametrize("name,code", [
    ("unavailable", "unavailable"), ("bot_check", "blocked"), ("offline", "offline"),
    ("no_space", "no_space"), ("http_403", "failed"),
])
def test_youtube_failure_has_code_hint_tail(monkeypatch, capsys, name, code):
    rc, out, err = _fixture(name)
    j = _run_main(monkeypatch, capsys, YT, rc, out, err)
    assert j["error"] == j["code"] == code
    assert j["hint"] and "—" not in j["hint"] and "\n" not in j["hint"]
    assert j["stderr_tail"] and j["stderr_tail"].splitlines()[-1] in err
    assert code in j["message"] and j["hint"] in j["message"]


def test_blocked_hint():
    rc, out, err = _fixture("bot_check")
    assert fetch.classify_failure(YT, rc, out, err)[1] == "YouTube refused the request. Try again later or use another video."


def test_403_hint_mentions_403():
    rc, out, err = _fixture("http_403")
    assert "403" in fetch.classify_failure(YT, rc, out, err)[1]


def test_format_unavailable_hint():
    err = "ERROR: [youtube] x: Requested format is not available. Use --list-formats"
    assert fetch.classify_failure(YT, 1, "", err)[1] == "That format isn't offered for this video; leave format unset."


def test_other_site_is_failed_even_if_text_looks_blocked(monkeypatch, capsys):
    rc, out, err = _fixture("bot_check")
    j = _run_main(monkeypatch, capsys, "https://vimeo.com/123", rc, out, err)
    assert j["code"] == "failed" and j["stderr_tail"]


def test_tail_is_trimmed_and_ansi_stripped():
    err = "\n".join(f"line{i} " + "x" * 300 for i in range(40)) + "\n\x1b[0;31mERROR:\x1b[0m boom"
    t = fetch.stderr_tail(err)
    assert len(t) <= 2048 and "\x1b" not in t and t.endswith("ERROR: boom")
    assert len(t.splitlines()) <= 15


def test_code_and_hint_survive_mcp_tail_truncation(monkeypatch, capsys):
    rc, out, err = _fixture("bot_check")
    monkeypatch.setattr(sys, "argv", ["fetch", "--url", YT])
    monkeypatch.setattr(fetch, "run", lambda *a, **k: subprocess.CompletedProcess(a, 1, out, "ERROR: x\n" * 400 + err))
    monkeypatch.setattr(fetch.os, "makedirs", lambda *a, **k: None)
    with pytest.raises(SystemExit):
        fetch.main()
    last2000 = capsys.readouterr().err[-2000:]
    assert '"code": "blocked"' in last2000 and "hint" in last2000
