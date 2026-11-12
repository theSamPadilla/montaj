"""§706 item 3: Portuguese narration captioned as English. transcribe's default language stays en (whisper given -l en on
Portuguese translates it), so a run on that default hears the language once (a detect) and says so, every transcript records
what was asked / given / heard, and captions reuse a source's transcript only when its language fits. Whisper is stubbed:
tones and silence written here, a fake whisper-cli for the transcription and for `-l auto -dl`."""
import json
import re
import shutil
import sys
import threading
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

from lib import caption_words  # noqa: E402
from lib import speech_runs as sr  # noqa: E402
from tests.conftest import HAS_FFMPEG  # noqa: E402
from tests.test_speech_runs import make_wav  # noqa: E402

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")


class Whisper:
    """Stands in for run_whisper. `-dl` calls answer `detects` (a list of (code, p), one per -f, in order) on stderr in
    whisper.cpp's words; other calls write `<clip>.json` (or --output-file) with `heard` as result.language: the
    language asked for."""

    def __init__(self, detects=None):
        self.detects = list(detects or [])
        self.calls = []

    def __call__(self, cmd, audio_path, check=False, duration_s=None):
        self.calls.append(list(cmd))
        files = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-f"]
        lang = cmd[cmd.index("-l") + 1]
        if "-dl" in cmd:
            text = ""
            for f in files:
                code, p = self.detects.pop(0)
                text += f"main: processing '{f}' (100 samples)\nwhisper_full_with_state: auto-detected language: {code} (p = {p})\n"
            return type("R", (), {"stdout": "", "stderr": text, "returncode": 0})()
        doc = {"result": {"language": lang}, "transcription": [{"text": " Hello", "offsets": {"from": 500, "to": 900}}]}
        if "--output-file" in cmd:
            prefix = cmd[cmd.index("--output-file") + 1]
            Path(prefix + ".json").write_text(json.dumps(doc))
            Path(prefix + ".srt").write_text("1\n00:00:00,500 --> 00:00:00,900\nHello\n\n")
        else:
            for f in files:
                Path(f + ".json").write_text(json.dumps(doc))

    def detect_calls(self):
        return [c for c in self.calls if "-dl" in c]

    def langs(self):
        return [c[c.index("-l") + 1] for c in self.calls if "-dl" not in c]


@pytest.fixture
def step(monkeypatch, tmp_path):
    import steps.speech.transcribe as T
    monkeypatch.setattr(T, "require_whisper_model", lambda model, language: (model, str(tmp_path / "m.bin")))
    monkeypatch.setattr(T, "find_whisper_bin", lambda: "whisper-cli")
    monkeypatch.setattr(sr, "find_whisper_bin", lambda: "whisper-cli")

    def install(detects=None):
        w = Whisper(detects)
        monkeypatch.setattr(sr, "run_whisper", w)
        monkeypatch.setattr(sr, "_run_detect", lambda cmd, timeout: w(cmd, None))
        monkeypatch.setattr(T, "run_whisper", w)
        return w
    T.install = install
    return T


def marker(prefix):
    return json.loads(Path(str(prefix) + ".json").read_text())["montaj"]["language"]


def talk(tmp_path, seconds=7.0, name="a.wav"):
    return make_wav(tmp_path / name, [(0.5, 0.5 + seconds)], seconds + 1.5)


# ── transcribe ───────────────────────────────────────────────────────────────

def test_default_is_still_en_and_an_explicit_language_runs_no_detect(step, tmp_path):
    w = step.install([("en", 0.99)])
    step.transcribe(talk(tmp_path), str(tmp_path / "d"), "m")
    assert w.langs() == ["en"] and len(w.detect_calls()) == 1
    w = step.install()
    step.transcribe(talk(tmp_path), str(tmp_path / "e"), "m", "pt-BR")
    assert w.langs() == ["pt"] and w.detect_calls() == []
    assert marker(tmp_path / "e") == {"asked": "pt-BR", "given": True, "heard": "pt"}


def test_a_defaulted_run_that_hears_portuguese_says_so_and_still_transcribes_in_en(step, tmp_path):
    w = step.install([("pt", 0.99)])
    res = step.transcribe(talk(tmp_path), str(tmp_path / "o"), "m")
    assert w.langs() == ["en"]
    assert res["languageHeard"]["code"] == "pt" and res["languageHeard"]["p"] == 0.99
    assert "--language pt" in res["languageHeard"]["message"]
    m = marker(tmp_path / "o")
    assert m["asked"] == "en" and m["given"] is False and m["heard"] == "en" and m["detected"] == "pt" and m["p"] == 0.99


@pytest.mark.parametrize("seconds,detect", [(7.0, ("en", 0.99)), (7.0, ("pt", 0.5)), (3.0, ("pt", 0.99)),
                                            (6.0, ("pt", 0.85))])
def test_a_detect_that_is_en_weak_or_on_little_voice_says_nothing(step, tmp_path, seconds, detect):
    step.install([detect])
    res = step.transcribe(talk(tmp_path, seconds), str(tmp_path / "o"), "m")
    assert "languageHeard" not in res
    assert marker(tmp_path / "o")["detected"] == detect[0]


def test_six_seconds_at_p_95_says_so(step, tmp_path):
    step.install([("pt", 0.95)])
    assert step.transcribe(talk(tmp_path, 6.0), str(tmp_path / "o"), "m")["languageHeard"]["code"] == "pt"


def test_the_marker_on_the_full_file_and_trim_spec_paths(step, tmp_path):
    media = talk(tmp_path)
    step.install([("pt", 0.99)])
    res = step.transcribe(media, str(tmp_path / "w"), "m", whole_file=True)
    assert marker(tmp_path / "w")["detected"] == "pt" and res["languageHeard"]["code"] == "pt"
    spec = tmp_path / "spec.json"
    spec.write_text(json.dumps({"input": media, "keeps": [[0.0, 7.0]]}))
    step.install([("en", 0.99)])
    step.transcribe(str(spec), str(tmp_path / "t"), "m")
    m = marker(tmp_path / "t")
    assert m["asked"] == "en" and m["given"] is False and m["detected"] == "en"
    step.install()
    step.transcribe(media, str(tmp_path / "w2"), "m", "fr", whole_file=True)
    assert marker(tmp_path / "w2") == {"asked": "fr", "given": True, "heard": "fr"}


# ── caption reuse ────────────────────────────────────────────────────────────

def source(tmp_path, name, heard="en", marker_=None, seconds=7.0):
    media = talk(tmp_path, seconds, name + ".wav")
    doc = {"result": {"language": heard}, "transcription": [{"text": " Hello", "offsets": {"from": 500, "to": 900}}]}
    doc["montaj"] = {"by": "runs", "runs": [[0.5, 0.5 + seconds]]}      # the speech the guard's detect hears
    if marker_ is not None:
        doc["montaj"]["language"] = marker_
    (tmp_path / (name + ".json")).write_text(json.dumps(doc))
    return {"id": name, "type": "voiceover", "src": media, "start": 0, "end": seconds + 1.5, "inPoint": 0,
            "outPoint": seconds + 1.5}


def words(tmp_path, items, language, monkeypatch, detects=None):
    w = Whisper(detects)
    monkeypatch.setattr(sr, "run_whisper", w)
    monkeypatch.setattr(sr, "_run_detect", lambda cmd, timeout: w(cmd, None))
    monkeypatch.setattr(sr, "find_whisper_bin", lambda: "whisper-cli")
    monkeypatch.setattr(caption_words, "_model_path", lambda model: "m.bin")
    project = {"tracks": [], "audio": {"tracks": items}}
    return caption_words.timeline_words(project, str(tmp_path), language=language), w


def test_explicit_language_does_not_reuse_a_sidecar_heard_in_another(tmp_path, monkeypatch):
    got, w = words(tmp_path, [source(tmp_path, "a", "en")], "pt", monkeypatch)
    assert got is None and w.calls == []
    got, _ = words(tmp_path, [source(tmp_path, "a", "en")], "pt-BR", monkeypatch)
    assert got is None
    got, _ = words(tmp_path, [source(tmp_path, "a", "pt")], "pt-BR", monkeypatch)
    assert got and got[0]["text"] == "Hello"


def test_auto_reuses_a_sidecar_made_with_auto_and_runs_no_detect(tmp_path, monkeypatch):
    item = source(tmp_path, "a", "en", {"asked": "auto", "given": True, "heard": "en"})
    got, w = words(tmp_path, [item], "auto", monkeypatch)
    assert got and w.calls == []


def test_auto_judges_a_sidecar_with_a_recorded_detect_on_it_and_runs_no_detect(tmp_path, monkeypatch):
    bad = source(tmp_path, "a", "en", {"asked": "en", "given": False, "heard": "en", "detected": "pt", "p": 0.99, "voice_s": 7.0})
    got, w = words(tmp_path, [bad], "auto", monkeypatch)
    assert got is None and w.calls == []
    ok = source(tmp_path, "b", "en", {"asked": "en", "given": False, "heard": "en", "detected": "en", "p": 0.99, "voice_s": 7.0})
    got, w = words(tmp_path, [ok], "auto", monkeypatch)
    assert got and w.calls == []


def test_auto_detects_an_unmarked_sidecar_once_and_follows_a_sure_detect(tmp_path, monkeypatch):
    item = source(tmp_path, "a", "en")
    got, w = words(tmp_path, [item], "auto", monkeypatch, [("pt", 0.999)])
    assert got is None and len(w.detect_calls()) == 1
    shutil.rmtree(tmp_path / ".cache")                  # (a second run would be answered from the cache)
    got, w = words(tmp_path, [item], "auto", monkeypatch, [("en", 0.999)])
    assert got
    shutil.rmtree(tmp_path / ".cache")
    got, w = words(tmp_path, [item], "auto", monkeypatch, [("pt", 0.7)])      # weak: reuse
    assert got
    short = source(tmp_path, "s", "en", seconds=3.0)
    got, w = words(tmp_path, [short], "auto", monkeypatch, [("pt", 0.99)])     # little voice: reuse
    assert got


def test_a_forced_sidecar_without_a_detect_is_detected_too(tmp_path, monkeypatch):
    item = source(tmp_path, "a", "en", {"asked": "en", "given": False, "heard": "en"})
    got, w = words(tmp_path, [item], "auto", monkeypatch, [("pt", 0.99)])
    assert got is None and len(w.detect_calls()) == 1


def test_several_sources_needing_a_detect_make_one_whisper_call(tmp_path, monkeypatch):
    items = [source(tmp_path, "a", "en"), source(tmp_path, "b", "en")]
    items[1].update(start=items[0]["end"], end=items[0]["end"] + 8.5)
    got, w = words(tmp_path, items, "auto", monkeypatch, [("en", 0.99), ("en", 0.99)])
    assert got and len(w.calls) == 1 and w.calls[0].count("-f") == 2


def test_a_source_with_no_voiced_run_is_trusted(tmp_path, monkeypatch):
    media = make_wav(tmp_path / "q.wav", [], 3.0)
    (tmp_path / "q.json").write_text(json.dumps({"result": {"language": "en"}, "transcription": [
        {"text": " Hi", "offsets": {"from": 0, "to": 100}}]}))
    item = {"id": "q", "type": "voiceover", "src": media, "start": 0, "end": 3, "inPoint": 0, "outPoint": 3}
    got, w = words(tmp_path, [item], "auto", monkeypatch)
    assert got and w.calls == []


def test_on_the_command_line_only_a_typed_language_is_given(step, tmp_path, monkeypatch):
    media = talk(tmp_path)
    for extra, given, detects in (([], False, 1), (["--language", "en"], True, 0)):
        w = step.install([("en", 0.99)])
        out = tmp_path / f"cli{given}"
        monkeypatch.setattr(sys, "argv", ["transcribe.py", "--input", media, "--out", str(out), *extra])
        step.main()
        assert marker(out)["given"] is given and len(w.detect_calls()) == detects


# ── review fixes ─────────────────────────────────────────────────────────────

def test_a_second_caption_run_is_answered_from_the_cache(tmp_path, monkeypatch):
    item = source(tmp_path, "a", "en")
    got, w = words(tmp_path, [item], "auto", monkeypatch, [("pt", 0.999)])
    assert got is None and len(w.detect_calls()) == 1
    cached = json.loads((tmp_path / ".cache" / "language-detect.json").read_text())
    assert len(cached["items"]) == 1
    got, w = words(tmp_path, [item], "auto", monkeypatch)            # no detect queued: it must not run one
    assert got is None and w.calls == []                             # the same verdict, at no cost


def test_a_changed_transcript_asks_again(tmp_path, monkeypatch):
    item = source(tmp_path, "a", "en")
    words(tmp_path, [item], "auto", monkeypatch, [("pt", 0.999)])
    sidecar = tmp_path / "a.json"
    sidecar.write_text(sidecar.read_text() + " ")                    # size and mtime change
    got, w = words(tmp_path, [item], "auto", monkeypatch, [("en", 0.999)])
    assert got and len(w.detect_calls()) == 1


def test_the_guard_decodes_only_the_transcripts_speech_not_the_whole_file(tmp_path, monkeypatch):
    item = source(tmp_path, "a", "en")
    cuts = []
    real = sr.run
    monkeypatch.setattr(sr, "voiced_runs", lambda *a, **k: pytest.fail("the guard found voiced runs itself"))
    monkeypatch.setattr(sr, "_decode", lambda *a, **k: pytest.fail("the guard decoded the whole file"))
    monkeypatch.setattr(sr, "run", lambda cmd, **k: (cuts.append(cmd), real(cmd, **k))[1])
    got, w = words(tmp_path, [item], "auto", monkeypatch, [("pt", 0.999)])
    assert got is None
    assert len(cuts) == 1 and "-ss" in cuts[0] and "-t" in cuts[0]


def test_an_old_transcript_without_runs_gives_its_speech_by_its_words(tmp_path):
    side = tmp_path / "old.json"
    w = lambda t, a, b: {"text": t, "offsets": {"from": int(a * 1000), "to": int(b * 1000)}}   # noqa: E731
    side.write_text(json.dumps({"transcription": [w(" a", 0.5, 1.0), w(" b", 1.1, 1.6), w(" c", 4.0, 4.5)]}))
    assert caption_words.transcript_runs(str(side)) == [(0.5, 1.6), (4.0, 4.5)]
    side.write_text(json.dumps({"transcription": [], "montaj": {"by": "runs", "runs": [[1, 2]]}}))
    assert caption_words.transcript_runs(str(side)) == [(1.0, 2.0)]
    side.write_text(json.dumps({"transcription": []}))
    assert caption_words.transcript_runs(str(side)) == []


def shorts(tmp_path, n=3, heard="en", seconds=2.0):
    items = []
    for i in range(n):
        it = source(tmp_path, f"s{i}", heard, seconds=seconds)
        it.update(start=i * 10, end=i * 10 + seconds + 1.5)
        items.append(it)
    return items


def test_sources_each_under_five_seconds_are_pooled_into_one_detect(tmp_path, monkeypatch):
    got, w = words(tmp_path, shorts(tmp_path), "auto", monkeypatch, [("pt", 0.999)])
    assert got is None                                   # 6 s of voice together, sure: they are Portuguese
    assert len(w.detect_calls()) == 1 and w.detect_calls()[0].count("-f") == 1


def test_a_pool_too_short_or_not_sure_leaves_the_sources_trusted(tmp_path, monkeypatch):
    got, w = words(tmp_path, shorts(tmp_path, 2), "auto", monkeypatch, [("pt", 0.999)])      # 4 s together
    assert got
    shutil.rmtree(tmp_path / ".cache", ignore_errors=True)
    got, w = words(tmp_path, shorts(tmp_path), "auto", monkeypatch, [("pt", 0.8)])
    assert got


def test_sources_in_different_languages_are_never_pooled(tmp_path, monkeypatch):
    def line(name, heard, i):
        it = source(tmp_path, name, heard, seconds=2.0)
        it.update(id=name, start=i * 10, end=i * 10 + 3.5)
        return it
    two = [line("e0", "en", 0), line("e1", "en", 1), line("p0", "pt", 2), line("p1", "pt", 3)]
    got, w = words(tmp_path, two, "auto", monkeypatch)
    assert w.detect_calls() == [] and got            # 4 s of each language: too short even pooled, so no detect
    three = two + [line("e2", "en", 4), line("p2", "pt", 5)]
    got, w = words(tmp_path, three, "auto", monkeypatch, [("en", 0.999), ("pt", 0.999)])
    assert len(w.detect_calls()) == 2 and all(c.count("-f") == 1 for c in w.detect_calls())
    assert got                                       # each pool heard its own language: both fit


def test_two_voices_of_the_same_clip_pooled_follow_the_pool_once_cached(tmp_path, monkeypatch):
    items = shorts(tmp_path)
    words(tmp_path, items, "auto", monkeypatch, [("pt", 0.999)])
    got, w = words(tmp_path, items, "auto", monkeypatch)
    assert got is None and w.calls == []


# detect clip: the voiced runs together, not the longest alone

def test_detect_spans_gather_short_sentences_longest_first_in_time_order():
    runs = [(0.0, 1.5), (3.0, 5.5), (7.0, 7.4), (9.0, 11.0), (13.0, 14.2)]
    spans, voice = sr._detect_spans(runs, 20.0)
    assert voice == pytest.approx(1.5 + 2.5 + 2.0 + 1.2)                  # the 0.4 s blip is under SHORT_RUN_S
    assert spans == sorted(spans) and len(spans) == 4
    assert spans[0][0] == 0.0 and spans[1] == pytest.approx((2.8, 5.7))


def test_detect_spans_cap_the_clip_at_thirty_seconds_with_padding():
    runs = [(i * 6.0, i * 6.0 + 5.0) for i in range(10)]
    spans, voice = sr._detect_spans(runs, 100.0)
    assert sum(b - a for a, b in spans) <= sr.DETECT_S + 1e-6
    assert voice < sr.DETECT_S - 2 * sr.PAD_S * (len(spans) - 1) + 1e-6   # voice never counts padding
    one, v1 = sr._detect_spans([(5.0, 95.0)], 100.0)
    assert sum(b - a for a, b in one) == pytest.approx(sr.DETECT_S) and v1 == pytest.approx(sr.DETECT_S - 2 * sr.PAD_S)


def test_detect_spans_with_only_short_runs_take_the_longest():
    spans, voice = sr._detect_spans([(0.0, 0.4), (2.0, 2.8)], 10.0)
    assert voice == pytest.approx(0.8) and len(spans) == 1


def test_a_narration_of_short_sentences_reaches_five_seconds_of_voice(step, tmp_path):
    runs = [(0.5 + i * 2.4, 0.5 + i * 2.4 + 1.8) for i in range(6)]          # six 1.8 s sentences, 0.6 s apart
    media = make_wav_runs(tmp_path / "narr.wav", runs)
    w = step.install([("pt", 0.99)])
    res = step.transcribe(media, str(tmp_path / "n"), "m")
    m = marker(tmp_path / "n")
    assert m["voice_s"] >= 5.0 and res["languageHeard"]["code"] == "pt"


def make_wav_runs(path, runs):
    from tests.test_speech_runs import make_wav as mw
    return mw(path, runs, runs[-1][1] + 1.0)


def test_the_detect_needs_p_95(step, tmp_path):
    step.install([("pt", 0.94)])
    assert "languageHeard" not in step.transcribe(talk(tmp_path, 7.0), str(tmp_path / "o"), "m")


# a detect never changes the step

def test_a_detect_that_times_out_is_none_and_prints_nothing(monkeypatch, capsys):
    import subprocess

    def hang(cmd, **k):
        raise subprocess.TimeoutExpired(cmd, k.get("timeout"))
    monkeypatch.setattr(sr, "run", hang)
    monkeypatch.setattr(sr, "find_whisper_bin", lambda: "whisper-cli")
    assert sr._detect_clips(["a.wav"], "m.bin") == [None]
    assert capsys.readouterr().err == ""
    seen = {}
    monkeypatch.setattr(sr, "run", lambda cmd, **k: (seen.update(k), type("R", (), {"stdout": "", "stderr": ""})())[1])
    sr._detect_clips(["a.wav"], "m.bin")
    assert seen["timeout"] == 180 and seen["check"] is False


def test_a_detect_that_never_finishes_does_not_hold_the_step_up(step, tmp_path, monkeypatch, capsys):
    release = threading.Event()
    step.install()
    monkeypatch.setattr(sr, "_detect_clips", lambda clips, model: (release.wait(30), [("pt", 0.99)])[1])
    monkeypatch.setattr(sr, "DETECT_JOIN_S", 0.3)
    t0 = time.time()
    res = step.transcribe(talk(tmp_path), str(tmp_path / "o"), "m")
    release.set()
    assert time.time() - t0 < 10 and "languageHeard" not in res and res["word_count"] == 1
    assert capsys.readouterr().err == ""


def test_a_detect_that_fails_cannot_kill_a_whole_file_transcription(step, tmp_path, monkeypatch, capsys):
    from lib.common import fail
    step.install()
    monkeypatch.setattr(sr, "detect_languages_p", lambda medias, model: fail("transcription_failed", "detect boom"))
    res = step.transcribe(talk(tmp_path), str(tmp_path / "o"), "m", whole_file=True)
    assert res["word_count"] == 1 and "languageHeard" not in res
    assert "boom" not in capsys.readouterr().err


def test_quiet_failures_cover_the_detects_own_reads(tmp_path, monkeypatch, capsys):
    """A source whose audio cannot be read: the pool path's decode fails inside quiet_failures, silently."""
    monkeypatch.setattr(sr, "find_whisper_bin", lambda: "whisper-cli")
    got = sr.detect_languages_p([str(tmp_path / "missing.wav")], "m.bin")
    assert got == {str(tmp_path / "missing.wav"): None} and capsys.readouterr().err == ""


# the probability is not rounded up to 1

def test_p_is_floored_not_rounded_up(step, tmp_path):
    step.install([("pt", 0.9993)])
    msg = step.transcribe(talk(tmp_path), str(tmp_path / "o"), "m")["languageHeard"]["message"]
    assert "p 0.99)" in msg and "1.00" not in msg


# real whisper.cpp output

def test_the_real_dl_log_parses_to_75_detects():
    """whisper.cpp v1.9.4, `-l auto -dl` over 75 clips with the large-v3-turbo-q5_0 weight, captured 2026-11-11."""
    log = (REPO_ROOT / "tests" / "fixtures" / "whisper_dl_v1.9.4_2026-11-11.txt").read_text()
    blocks = sr._PROCESSING.split(log)[1:]
    assert len(blocks) == 75
    found = [sr._DETECTED.search(b) for b in blocks]
    assert all(found)
    assert (found[0].group(1), float(found[0].group(2))) == ("en", 0.986984)


def test_detect_clips_reads_the_real_log(monkeypatch):
    log = (REPO_ROOT / "tests" / "fixtures" / "whisper_dl_v1.9.4_2026-11-11.txt").read_text()
    monkeypatch.setattr(sr, "find_whisper_bin", lambda: "whisper-cli")
    monkeypatch.setattr(sr, "BATCH", 100)                  # the log is one call's output for all 75
    monkeypatch.setattr(sr, "_run_detect", lambda cmd, timeout: type("R", (), {"stdout": "", "stderr": log})())
    got = sr._detect_clips([f"c{i:03d}.wav" for i in range(75)], "m.bin")
    assert len(got) == 75 and all(g for g in got) and got[0] == ("en", 0.986984)


# the language reaches the answer

def test_every_source_in_one_language_gives_the_transcript_and_the_track_that_language(tmp_path, monkeypatch):
    from lib.caption_translation import record_source_language
    item = source(tmp_path, "a", "pt", {"asked": "auto", "given": True, "heard": "pt"})
    got, _ = words(tmp_path, [item], "auto", monkeypatch)
    assert got.language == "pt"
    out = tmp_path / "w.json"
    caption_words.write_transcript(got, str(out))
    assert json.loads(out.read_text())["result"] == {"language": "pt"}
    assert record_source_language({}, "auto", str(out))["lang"] == "pt"
    mixed = [source(tmp_path, "b", "pt", {"asked": "auto", "given": True, "heard": "pt"}),
             source(tmp_path, "c", "en", {"asked": "auto", "given": True, "heard": "en"})]
    mixed[1].update(start=9.0, end=18.0)
    got, _ = words(tmp_path, mixed, "auto", monkeypatch)
    assert got.language is None
    caption_words.write_transcript(got, str(out))
    assert "result" not in json.loads(out.read_text())


def test_the_step_answer_carries_the_language_of_reused_transcripts(tmp_path, monkeypatch, capsys):
    from tests.test_generate_captions import _load_step_module
    mod = _load_step_module()
    proj = tmp_path / "proj"
    proj.mkdir()
    media = make_wav_runs(proj / "a.wav", [(0.5, 3.0)])
    (proj / "a.json").write_text(json.dumps({"result": {"language": "pt"}, "transcription": [
        {"text": " Ola", "offsets": {"from": 500, "to": 900}}],
        "montaj": {"language": {"asked": "auto", "given": True, "heard": "pt"}}}))
    (proj / "project.json").write_text(json.dumps({"id": "p1", "tracks": [{"id": "t", "items": [
        {"id": "c", "type": "video", "src": media, "start": 0, "end": 3, "inPoint": 0, "outPoint": 3}]}]}))
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: proj)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a, **k: None)
    monkeypatch.setattr(mod, "whisper_runaway_timeout_for", lambda p: 1)

    def fake_run(cmd, **kw):
        assert "transcribe.py" not in " ".join(cmd)                      # the sources' own words were used
        if "caption.py" in " ".join(cmd):
            (proj / "_caption_track.json").write_text(json.dumps({"style": "pop", "segments": [
                {"text": "Ola", "start": 0.5, "end": 0.9, "words": []}]}))
    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(mod.sys, "argv", ["generate_captions.py", "--project-id", "p1", "--language", "auto"])
    mod.main()
    ans = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert ans["language"] == "pt"
    assert json.loads((proj / "project.json").read_text())["captions"]["lang"] == "pt"
