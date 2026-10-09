import sys
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "lib"))
sys.path.insert(0, str(ROOT / "steps" / "media"))
import creator_diagnostic as cd  # noqa: E402


def items(*views):
    return [{"url": f"https://example.com/p/{i}", "path": None, "views": v, "likes": None,
             "posted_at": None, "caption": None} for i, v in enumerate(views)]


def test_parse_items_needs_exactly_one_of_url_or_path():
    assert cd.parse_items('[{"url": "https://example.com/p/1", "views": 5}]')[0]["views"] == 5
    for bad in ('[]', '{}', 'nope', '[{"url": "a", "path": "b"}]', '[{}]', '[' + ','.join(['{"url":"u"}'] * 31) + ']'):
        with pytest.raises(SystemExit):
            cd.parse_items(bad)


def test_select_most_viewed_then_newest_first_on_ties():
    chosen, by = cd.select_items(items(10, None, 50, 50, 3), 3)
    assert by == "views"
    assert [c["url"][-1] for c in chosen] == ["2", "3", "0"]


def test_select_newest_when_no_views_and_single_mode():
    chosen, by = cd.select_items(items(None, None, None), 2)
    assert (by, len(chosen)) == ("latest", 2)
    assert cd.select_items(items(7), 10)[1] == "single"


def test_median_aspect_and_on_beat_share():
    assert cd.median([3, None, 1, 2]) == 2
    assert cd.median([None]) is None
    assert cd.aspect_label(1080, 1920) == "9:16"
    assert cd.aspect_label(1080, 1350) == "4:5"
    assert cd.aspect_label(1920, 1080) == "16:9"
    assert cd.aspect_label(1000, 700) == "1000:700"
    assert cd.on_beat_share([1.0, 2.05, 3.5], [1.02, 2.0, 3.0]) == pytest.approx(2 / 3, abs=1e-3)
    assert cd.on_beat_share([], [1.0]) is None


def test_shot_and_speech_metrics():
    shots = [{"start": 0.0, "duration": 2.0}, {"start": 2.0, "duration": 1.0}, {"start": 3.0, "duration": 3.0}]
    m, cuts = cd.shot_metrics(shots, 6.0)
    assert cuts == [2.0, 3.0]
    assert m["cuts_per_min"] == 20.0 and m["shot_median_s"] == 2.0 and m["first_cut_s"] == 2.0
    words = [{"text": " Stop", "start": 0.4, "end": 0.7}, {"text": " scrolling", "start": 0.7, "end": 1.2},
             {"text": " now", "start": 3.5, "end": 3.9}]
    s = cd.speech_metrics(words, 6.0)
    assert s["first_word_s"] == 0.4 and s["opening_line"] == "Stop scrolling"
    assert s["wpm"] == pytest.approx(3 / (3.5 / 60), abs=0.1)
    assert cd.speech_metrics([], 6.0)["speech_share"] == 0.0


def test_deletable_only_inside_media_or_inbox(tmp_path):
    media, inbox, other = tmp_path / "_media", tmp_path / "inbox", tmp_path / "keep"
    for d in (media, inbox, other):
        d.mkdir()
    assert cd.deletable(media / "a.mp4", media, None)
    assert cd.deletable(inbox / "b.mp4", media, inbox)
    assert not cd.deletable(other / "c.mp4", media, inbox)
    assert not cd.deletable(tmp_path / "inbox-evil" / "d.mp4", media, inbox)
    (inbox / "sub").mkdir()
    assert not cd.deletable(inbox / "sub" / "e.mp4", media, inbox)  # nested: kept
    assert cd.deletable(inbox / "b.mp4", media, inbox)              # direct child: still deleted


def test_summarize_medians_and_music_share():
    v = lambda **k: {"duration_s": 30, "aspect": "9:16", "cuts_per_min": 20, "shot_median_s": 2, "first_cut_s": 1,
                     "wpm": 180, "speech_share": 0.9, "first_word_s": 0.3, "on_beat_share": None,
                     "music": {"bpm": None, "confidence": 0.1, "likely": False}, "palette": ["#000000"], **k}
    s = cd.summarize([v(cuts_per_min=10), v(cuts_per_min=30, music={"bpm": 120.0, "confidence": 0.8, "likely": True})])
    assert s["videos"] == 2 and s["cuts_per_min"] == 20 and s["music_share"] == 0.5 and s["bpm"] == 120.0


import json
import shutil
import subprocess
from tests.conftest import HAS_FFMPEG, run_step_env  # same helpers as test_detect_shots.py


def _clip(path, seconds=6):
    # three solid shots with a sine tone (as test_detect_shots.py:12-31)
    subprocess.run(["ffmpeg", "-y", "-v", "error",
                    "-f", "lavfi", "-i", "color=black:s=360x640:d=2", "-f", "lavfi", "-i", "color=white:s=360x640:d=2",
                    "-f", "lavfi", "-i", "color=gray:s=360x640:d=2", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                    "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)], check=True)


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg missing")
def test_measures_ranks_writes_stills_and_deletes_only_inbox(tmp_path, fake_whisper_env):
    inbox, keep, out = tmp_path / "inbox", tmp_path / "keep", tmp_path / "out"
    inbox.mkdir(); keep.mkdir()
    _clip(inbox / "a.mp4"); _clip(inbox / "b.mp4"); _clip(keep / "c.mp4")
    items = [{"path": str(inbox / "a.mp4"), "views": 10}, {"path": str(inbox / "b.mp4"), "views": 900},
             {"path": str(keep / "c.mp4"), "views": 50}]
    proc = run_step_env("creator_diagnostic.py", fake_whisper_env, "--items", json.dumps(items), "--out", str(out),
                        "--inbox", str(inbox), "--top", "2", "--whisper-model", "base.en", "--language", "en")
    assert proc.returncode == 0, proc.stderr
    doc = json.loads((out / "diagnostic.json").read_text())
    assert doc["schema"] == 1 and doc["mode"] == "creator"
    assert doc["selection"] == {"given": 3, "measured": 2, "by": "views"}
    assert [v["views"] for v in doc["videos"]] == [900, 50]
    v = doc["videos"][0]
    assert v["aspect"] == "9:16" and v["cuts_per_min"] > 0 and v["shot_median_s"] is not None
    assert (out / v["sheet"]).is_file() and (out / v["opening_still"]).is_file()
    assert not (inbox / "b.mp4").exists()          # measured, in inbox: deleted
    assert (inbox / "a.mp4").exists()              # not chosen: untouched
    assert (keep / "c.mp4").exists()               # outside inbox: kept
    assert not (out / "_media").exists()


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg missing")
def test_single_item_and_all_failed(tmp_path, fake_whisper_env):
    _clip(tmp_path / "one.mp4")
    ok = run_step_env("creator_diagnostic.py", fake_whisper_env, "--items", json.dumps([{"path": str(tmp_path / "one.mp4")}]),
                      "--out", str(tmp_path / "o1"), "--whisper-model", "base.en", "--language", "en")
    assert ok.returncode == 0, ok.stderr
    assert json.loads((tmp_path / "o1" / "diagnostic.json").read_text())["mode"] == "single"
    bad = run_step_env("creator_diagnostic.py", fake_whisper_env, "--items", json.dumps([{"path": str(tmp_path / "nope.mp4")}]),
                       "--out", str(tmp_path / "o2"), "--whisper-model", "base.en", "--language", "en")
    assert bad.returncode == 1 and "no_videos_measured" in bad.stderr


class _Proc:
    def __init__(self, rc, out="", err=""):
        self.returncode, self.stdout, self.stderr = rc, out, err


def test_fetch_one_returns_path_and_meta(monkeypatch, tmp_path):
    out = json.dumps({"paths": [str(tmp_path / "x.mp4")], "videos": [{"view_count": 1200, "description": "hi", "upload_date": "20261001"}]})
    monkeypatch.setattr(cd.subprocess, "run", lambda *a, **k: _Proc(0, out))
    path, meta = cd.fetch_one("https://example.com/p/1", tmp_path)
    assert path.endswith("x.mp4") and meta["view_count"] == 1200
    merged = cd.merge_meta({"url": "u", "path": None, "views": None, "likes": None, "posted_at": None, "caption": None}, meta)
    assert merged["views"] == 1200 and merged["posted_at"] == "2026-10-01" and merged["caption"] == "hi"


def test_fetch_one_failure_carries_the_fetch_code(monkeypatch, tmp_path):
    err = json.dumps({"error": "unavailable", "message": "Video unavailable"})
    monkeypatch.setattr(cd.subprocess, "run", lambda *a, **k: _Proc(1, "", "noise\n" + err))
    with pytest.raises(cd.SkipVideo) as e:
        cd.fetch_one("https://example.com/p/1", tmp_path)
    assert e.value.code == "unavailable"


def test_fetch_one_with_no_file_path_skips_the_post(monkeypatch, tmp_path):
    # fetch.py lists a path even when yt-dlp reported none; that post is skipped, not a crash
    out = json.dumps({"paths": [None], "videos": [{"view_count": 5}]})
    monkeypatch.setattr(cd.subprocess, "run", lambda *a, **k: _Proc(0, out))
    with pytest.raises(cd.SkipVideo) as e:
        cd.fetch_one("https://example.com/p/1", tmp_path)
    assert e.value.code == "fetch_failed"


def _one(tmp_path, env, inbox, home):
    items = [{"path": str(tmp_path / "nope.mp4")}]
    return run_step_env("creator_diagnostic.py", {**env, "HOME": str(home)}, "--items", json.dumps(items),
                        "--out", str(tmp_path / "out"), "--inbox", str(inbox),
                        "--whisper-model", "base.en", "--language", "en")


def test_inbox_cannot_be_home_an_ancestor_of_home_or_a_root(tmp_path, fake_whisper_env):
    home = tmp_path / "users" / "me"
    home.mkdir(parents=True)
    for bad in (home, home.parent, tmp_path, Path("/")):
        proc = _one(tmp_path, fake_whisper_env, bad, home)
        assert proc.returncode == 1 and "invalid_argument" in proc.stderr, (bad, proc.stderr)
    ok = tmp_path / "inbox"
    ok.mkdir()
    assert "invalid_argument" not in _one(tmp_path, fake_whisper_env, ok, home).stderr


def test_leaves_a_media_folder_it_did_not_create(tmp_path, fake_whisper_env):
    out = tmp_path / "out"
    (out / "_media").mkdir(parents=True)
    (out / "_media" / "theirs.txt").write_text("keep")
    proc = _one(tmp_path, fake_whisper_env, tmp_path / "inbox", Path.home())
    assert "no_videos_measured" in proc.stderr  # got past the model check, to the final cleanup
    assert (out / "_media" / "theirs.txt").read_text() == "keep"


def test_music_threshold_from_measured_clips(monkeypatch):
    # §163: on 9 speech-only clips bpm_confidence peaked at 0.32; a bed 18 dB under
    # speech reached 0.403. The threshold sits in that gap (0.36).
    import detect_beats
    for conf, likely in ((0.403, True), (0.36, True), (0.33, False), (0.195, False)):
        monkeypatch.setattr(detect_beats, "analyze", lambda p, c=conf: {"bpm": 100.0, "bpm_confidence": c, "beats": []})
        music, _ = cd._music("x.mp4", [])
        assert music["likely"] is likely, (conf, music)
