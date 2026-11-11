"""§706 item 3: Portuguese narration captioned as English. transcribe's default language stays en (whisper given -l en on
Portuguese translates it), so a run on that default hears the language once (a detect) and says so, every transcript records
what was asked / given / heard, and captions reuse a source's transcript only when its language fits. Whisper is stubbed:
tones and silence written here, a fake whisper-cli for the transcription and for `-l auto -dl`."""
import json
import re
import sys
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
    if marker_ is not None:
        doc["montaj"] = {"language": marker_}
    (tmp_path / (name + ".json")).write_text(json.dumps(doc))
    return {"id": name, "type": "voiceover", "src": media, "start": 0, "end": seconds + 1.5, "inPoint": 0,
            "outPoint": seconds + 1.5}


def words(tmp_path, items, language, monkeypatch, detects=None):
    w = Whisper(detects)
    monkeypatch.setattr(sr, "run_whisper", w)
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
    got, w = words(tmp_path, [item], "auto", monkeypatch, [("en", 0.999)])
    assert got
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
