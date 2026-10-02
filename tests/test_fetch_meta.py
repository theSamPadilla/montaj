"""montaj/fetch `meta`. Subprocess stubbed; fixtures captured from the bundled yt-dlp."""
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
TT = "https://www.tiktok.com/@tiktok"
IG = "https://www.instagram.com/instagram/"
OUT = "/tmp/montaj-fetch-x"
TEMPLATE = ("after_move:%(.{id,title,description,view_count,like_count,comment_count,"
            "upload_date,duration,webpage_url,filepath})j")
KEYS = {"id", "path", "url", "title", "description", "view_count", "like_count",
        "comment_count", "upload_date", "duration"}


def _argv(extra, print_arg="after_move:filepath"):
    return [
        sys.executable, "-m", "yt_dlp",
        "--format", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "--print", print_arg,
        "--js-runtimes", "node",
    ] + extra


def _run_main(monkeypatch, capsys, cli, rc, out, err=""):
    seen = {}

    def fake_run(cmd, **k):
        seen["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, rc, out, err)

    monkeypatch.setattr(sys, "argv", ["fetch"] + cli)
    monkeypatch.setattr(fetch, "run", fake_run)
    monkeypatch.setattr(fetch.os, "makedirs", lambda *a, **k: None)
    fetch.main()
    return seen["cmd"], capsys.readouterr().out


def test_without_meta_argv_and_stdout_unchanged(monkeypatch, capsys):
    cmd, out = _run_main(monkeypatch, capsys, ["--url", YT, "--out", OUT], 0, "/p/one.mp4\n")
    assert cmd == _argv(["--output", OUT + "/%(id)s.%(ext)s", YT])
    assert out == "/p/one.mp4\n"


def test_without_meta_several_paths_unchanged(monkeypatch, capsys):
    _, out = _run_main(monkeypatch, capsys, ["--url", TT, "--out", OUT, "--limit", "2"], 101, "/p/a.mp4\n/p/b.mp4\n")
    assert json.loads(out) == {"paths": ["/p/a.mp4", "/p/b.mp4"]}


def test_meta_argv_changes_only_the_print(monkeypatch, capsys):
    stdout = json.dumps({"id": "a", "filepath": "/p/a.mp4"}) + "\n"
    cmd, _ = _run_main(monkeypatch, capsys, ["--url", YT, "--out", OUT, "--meta"], 0, stdout)
    assert cmd == _argv(["--output", OUT + "/%(id)s.%(ext)s", YT], TEMPLATE)


@pytest.mark.parametrize("name,count", [("youtube", 1), ("tiktok_video", 1), ("tiktok_profile", 2)])
def test_parse_every_capture(name, count):
    _, out, _ = _fixture(f"meta_{name}")
    got = fetch.parse_meta_lines(out)
    assert len(got["paths"]) == len(got["videos"]) == count
    for v, p in zip(got["videos"], got["paths"]):
        assert set(v) == KEYS and v["path"] == p and v["id"] and v["url"].startswith("https://")
        assert isinstance(v["view_count"], int) and isinstance(v["duration"], (int, float))
        assert len(v["upload_date"]) == 8


def test_capture_values_pass_through():
    _, out, _ = _fixture("meta_youtube")
    v = fetch.parse_meta_lines(out)["videos"][0]
    assert v["id"] == "jNQXAC9IVRw" and v["title"] == "Me at the zoo" and v["upload_date"] == "20050424"


def test_missing_values_are_null():
    got = fetch.parse_meta_lines('{"id": "a", "title": "t", "filepath": "/p/a.mp4"}\n')
    v = got["videos"][0]
    assert v["view_count"] is None and v["description"] is None and v["url"] is None and v["upload_date"] is None
    assert v["path"] == "/p/a.mp4"


def test_description_capped_at_2200():
    line = json.dumps({"id": "a", "description": "x" * 5000, "filepath": "/p/a.mp4"})
    assert len(fetch.parse_meta_lines(line)["videos"][0]["description"]) == 2200


def test_non_json_lines_skipped():
    out = "[download] Destination: x\n{not json\n" + json.dumps({"id": "a", "filepath": "/p/a.mp4"}) + "\n[Merger] done\n"
    assert fetch.parse_meta_lines(out)["paths"] == ["/p/a.mp4"]


def test_no_json_line_is_none():
    assert fetch.parse_meta_lines("[download] nothing\n") is None


def test_single_video_prints_the_object(monkeypatch, capsys):
    _, stdout, _ = _fixture("meta_youtube")
    _, out = _run_main(monkeypatch, capsys, ["--url", YT, "--out", OUT, "--meta"], 0, stdout)
    j = json.loads(out)
    assert len(j["paths"]) == 1 and len(j["videos"]) == 1


def test_exit_101_is_success_with_meta(monkeypatch, capsys):
    rc, stdout, _ = _fixture("meta_tiktok_profile")
    assert rc == 101
    _, out = _run_main(monkeypatch, capsys, ["--url", TT, "--out", OUT, "--meta", "--limit", "2"], rc, stdout)
    assert len(json.loads(out)["videos"]) == 2


def test_meta_with_no_json_line_is_no_output(monkeypatch, capsys):
    with pytest.raises(SystemExit) as e:
        _run_main(monkeypatch, capsys, ["--url", YT, "--out", OUT, "--meta"], 0, "[download] nothing\n")
    assert e.value.code == 1
    assert "no_output" in capsys.readouterr().err


def test_instagram_profile_failure_has_code_and_hint(monkeypatch, capsys):
    rc, out, err = _fixture("meta_instagram_profile")
    with pytest.raises(SystemExit):
        _run_main(monkeypatch, capsys, ["--url", IG, "--out", OUT, "--meta", "--limit", "2"], rc, out, err)
    j = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert j["code"] == j["error"] == "instagram_profile"
    assert "reel" in j["hint"] and "—" not in j["hint"] and "\n" not in j["hint"]
    assert j["stderr_tail"] and j["hint"] in j["message"]
