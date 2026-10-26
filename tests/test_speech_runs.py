"""PL89 A1 T1: lib/speech_runs, a take transcribed by voiced run (one whisper call, a clip a run), the transcribe
step's `by-runs` param and cut's redo of an old full-file transcript. Synthetic only: tones and silence written here,
a fake whisper that writes `<wav>.json` per `-f`, invented words."""
import json
import math
import struct
import sys
import wave
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

from lib import speech_runs as sr  # noqa: E402
from lib import speech_units  # noqa: E402
from lib.speech_lines import load_words  # noqa: E402
from tests.conftest import HAS_FFMPEG  # noqa: E402

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not installed")

RATE = 16000


def make_wav(path, spans, total):
    """16 kHz mono: a 200 Hz tone over each (start, end) of `spans`, digital silence elsewhere."""
    n = int(total * RATE)
    frames = bytearray()
    for i in range(n):
        t = i / RATE
        on = any(a <= t < b for a, b in spans)
        frames += struct.pack("<h", int(0.5 * 32767 * math.sin(2 * math.pi * 200 * t)) if on else 0)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(frames))
    return str(path)


class FakeWhisper:
    """Stands in for run_whisper: for every `-f clip` writes `<clip>.json` from plan[clip index] =
    [(text, from_s, to_s)] in the clip's own time. A clip is named run-<index>.wav."""

    def __init__(self, plan=None, detected="es"):
        self.plan = plan or {}
        self.detected = detected
        self.calls = []

    def __call__(self, cmd, audio_path, check=False, duration_s=None):
        self.calls.append({"cmd": list(cmd), "duration_s": duration_s, "audio": audio_path})
        files = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-f"]
        lang = cmd[cmd.index("-l") + 1]
        for f in files:
            idx = int(Path(f).stem.split("-")[1])
            Path(f + ".json").write_text(json.dumps({
                "systeminfo": "fake", "model": {"type": "fake"}, "params": {"language": lang},
                "result": {"language": self.detected if lang == "auto" else lang},
                "transcription": [{"text": " " + t, "offsets": {"from": round(a * 1000), "to": round(b * 1000)}}
                                  for t, a, b in self.plan.get(idx, [])]}))


@pytest.fixture
def fake(monkeypatch):
    def install(plan=None, detected="es"):
        f = FakeWhisper(plan, detected)
        monkeypatch.setattr(sr, "run_whisper", f)
        monkeypatch.setattr(sr, "find_whisper_bin", lambda: "whisper-cli")
        return f
    return install


def load(prefix):
    return json.loads(Path(str(prefix) + ".json").read_text())


# ── voiced runs ──────────────────────────────────────────────────────────────

def test_voiced_runs_are_the_sound_and_a_blip_is_not_one(tmp_path):
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.5), (2.5, 3.0), (4.0, 4.05)], 5.0)
    runs = sr.voiced_runs(media)
    assert len(runs) == 2
    assert runs[0][0] == pytest.approx(0.5, abs=0.05) and runs[0][1] == pytest.approx(1.5, abs=0.05)
    assert runs[1][0] == pytest.approx(2.5, abs=0.05) and runs[1][1] == pytest.approx(3.0, abs=0.05)


def test_a_blip_gets_no_clip(tmp_path, fake):
    f = fake({0: [("Hello", 0.6, 1.0)]})
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.5), (4.0, 4.05)], 5.0)
    out = sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    files = [a for c in f.calls for a in c["cmd"] if a.endswith(".wav")]
    assert len(files) == 1 and out["runs"] == 1
    assert len(load(tmp_path / "out")["montaj"]["runs"]) == 1


# ── one whisper call, batches ───────────────────────────────────────────────

def test_all_runs_go_through_one_whisper_call_with_the_step_s_flags(tmp_path, fake):
    f = fake()
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.5), (2.5, 3.0), (4.0, 4.6)], 5.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    assert len(f.calls) == 1
    cmd = f.calls[0]["cmd"]
    assert cmd.count("-f") == 3
    assert cmd[cmd.index("-m") + 1] == "model.bin" and cmd[cmd.index("-l") + 1] == "en"
    for flag in ("--split-on-word", "--output-json", "-np"):
        assert flag in cmd
    assert cmd[cmd.index("--max-len") + 1] == "1" and cmd[cmd.index("-mc") + 1] == "0"
    assert "-of" not in cmd and "--output-file" not in cmd
    assert f.calls[0]["duration_s"] > 0       # the guard is told the summed length, not left to a missing file


def test_clips_run_in_batches(tmp_path, fake, monkeypatch):
    monkeypatch.setattr(sr, "BATCH", 2)
    f = fake()
    spans = [(0.5 + 1.5 * k, 1.2 + 1.5 * k) for k in range(5)]
    media = make_wav(tmp_path / "a.wav", spans, 9.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    assert [c["cmd"].count("-f") for c in f.calls] == [2, 2, 1]


def test_the_guard_gets_the_summed_clip_length(tmp_path, fake):
    f = fake()
    media = make_wav(tmp_path / "a.wav", [(3.0, 4.0), (6.0, 7.0)], 8.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    # each clip is its run plus 1.5 s of context and 0.2 s of pad: 2 x 2.7 s
    assert f.calls[0]["duration_s"] == pytest.approx(5.4, abs=0.15)


# ── words: context dropped, clamped in order ────────────────────────────────

def test_context_words_are_dropped_and_words_are_clamped_into_their_run(tmp_path, fake):
    # run B is 2.5-3.0; its clip starts at 1.0 (1.5 s of context): clip time t is source time 1.0 + t
    f = fake({
        0: [("alpha", 0.5, 0.9)],
        1: [("context", 0.2, 0.6),            # source 1.2-1.6, before run B: the previous run's word
            ("early", 1.45, 1.8),             # source 2.45-2.8: starts before the run
            ("middle", 1.8, 2.0),
            ("late", 2.0, 2.45)],             # source 3.0-3.45: past the run's end
    })
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.0), (2.5, 3.0)], 4.0)
    runs = sr.voiced_runs(media)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    words = [w for w in load(tmp_path / "out")["transcription"] if w["run"] == 1]
    assert [w["text"].strip() for w in words] == ["early", "middle", "late"]
    lo, hi = runs[1]
    prev_end = lo
    for w in words:
        s, e = w["offsets"]["from"] / 1000, w["offsets"]["to"] / 1000
        assert lo - 1e-6 <= s <= e <= hi + 1e-6
        assert s >= prev_end - 1e-6          # no word starts before the one before ends
        assert e - s >= 0.002 - 1e-6
        prev_end = e


def test_a_word_of_no_length_gets_two_milliseconds(tmp_path, fake):
    fake({0: [("hm", 0.6, 0.6), ("ok", 0.6, 0.6), ("fine", 0.6, 1.0)]})
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.5)], 3.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    for w in load(tmp_path / "out")["transcription"]:
        assert w["offsets"]["to"] - w["offsets"]["from"] >= 2


# ── hallucinations ──────────────────────────────────────────────────────────

def test_thank_you_on_a_short_run_is_dropped_and_a_real_short_word_kept(tmp_path, fake):
    # run 0 and run 1 are 0.3 s of sound; run 2 is 1.0 s
    # a clip opens 1.5 s before its run: run 0 at clip time 0.5, runs 1 and 2 at 1.5
    fake({0: [("Thank", 0.5, 0.7), ("you.", 0.7, 1.0)],
          1: [("Compute.", 1.5, 1.9)],
          2: [("Thank", 1.5, 2.0), ("you.", 2.0, 2.5)]})
    media = make_wav(tmp_path / "a.wav", [(0.5, 0.8), (2.0, 2.3), (4.0, 5.0)], 6.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    data = load(tmp_path / "out")
    by_run = {}
    for w in data["transcription"]:
        by_run.setdefault(w["run"], []).append(w["text"].strip())
    assert 0 not in by_run
    assert by_run[1] == ["Compute."]
    assert by_run[2] == ["Thank", "you."]            # a long run keeps what it heard
    assert len(data["montaj"]["runs"]) == 3          # the run stays in the list: indexes do not shift


# ── language ────────────────────────────────────────────────────────────────

def test_auto_language_is_detected_once_on_the_longest_run(tmp_path, fake):
    f = fake({}, detected="es")
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.0), (2.0, 4.0), (5.0, 5.5)], 6.5)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "auto")
    langs = [c["cmd"][c["cmd"].index("-l") + 1] for c in f.calls]
    assert langs == ["auto", "es"]
    assert f.calls[0]["cmd"].count("-f") == 1
    assert f.calls[0]["cmd"][f.calls[0]["cmd"].index("-f") + 1].endswith("run-001.wav")   # the 2 s run
    assert f.calls[1]["cmd"].count("-f") == 3
    assert load(tmp_path / "out")["result"]["language"] == "es"


# ── the file ────────────────────────────────────────────────────────────────

def test_the_json_is_whisper_s_shape_with_the_runs_and_load_words_reads_it(tmp_path, fake):
    fake({0: [("Hello", 0.5, 0.9)], 1: [("world", 1.5, 1.9)]})
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.0), (3.0, 3.5)], 5.0)
    out = sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    data = load(tmp_path / "out")
    assert out["words"] == str(tmp_path / "out.json") and out["srt"] == str(tmp_path / "out.srt")
    m = data["montaj"]
    assert (m["input"], m["by"], m["offsets"], m["timestamps"], m["srt"], m["version"]) == \
        ("file", "runs", "source", "source", "source", "speech-runs v1")
    assert len(m["runs"]) == 2 and m["runs"][1][0] == pytest.approx(3.0, abs=0.05)
    assert data["systeminfo"] == "fake" and data["model"] == {"type": "fake"} and "params" in data
    first = data["transcription"][0]
    assert first["run"] == 0 and first["timestamps"]["from"].count(":") == 2 and "," in first["timestamps"]["from"]
    words = load_words(str(tmp_path / "out.json"))
    assert [w.text for w in words] == ["Hello", "world"]
    assert words[0].start == pytest.approx(0.5, abs=0.06)
    assert words[1].start == pytest.approx(3.0, abs=0.06)
    srt = Path(out["srt"]).read_text()
    assert "Hello" in srt and "world" in srt and "-->" in srt


def test_runs_of_run_of_and_is_full_file_montaj(tmp_path, fake):
    fake({0: [("Hello", 0.5, 0.9)], 1: [("world", 1.5, 1.9)]})
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.0), (3.0, 3.5)], 5.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    side = str(tmp_path / "out.json")
    runs = sr.runs_of(side)
    assert len(runs) == 2 and all(isinstance(r, tuple) for r in runs)
    words = load_words(side)
    assert sr.run_of(words, runs) == [0, 1]
    stray = [type(words[0])(0, "x", "x", 2.0, 2.2)]            # between the runs
    assert sr.run_of(stray, runs) == [None]
    assert sr.run_of(words, None) is None
    assert sr.is_full_file_montaj(side) is False

    full = tmp_path / "full.json"
    full.write_text(json.dumps({"transcription": [], "montaj": {"input": "file", "offsets": "source"}}))
    assert sr.runs_of(str(full)) is None and sr.is_full_file_montaj(str(full)) is True
    spec = tmp_path / "spec.json"
    spec.write_text(json.dumps({"transcription": [], "montaj": {"input": "spec"}}))
    assert sr.is_full_file_montaj(str(spec)) is True
    person = tmp_path / "person.json"
    person.write_text(json.dumps({"transcription": []}))
    assert sr.runs_of(str(person)) is None and sr.is_full_file_montaj(str(person)) is False
    assert sr.is_full_file_montaj(str(tmp_path / "nope.json")) is False


def test_a_take_with_voice_and_no_words_still_writes_a_srt_the_step_accepts(tmp_path, fake):
    fake()
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.5)], 3.0)
    out = sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    assert load(tmp_path / "out")["transcription"] == [] and Path(out["srt"]).stat().st_size > 0


def test_no_voiced_run_falls_back_and_says_so(tmp_path, fake):
    f = fake()
    media = make_wav(tmp_path / "a.wav", [], 2.0)
    out = sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    assert out["fell_back"] is True and f.calls == []
    assert not (tmp_path / "out.json").exists()


# ── the step ────────────────────────────────────────────────────────────────

@pytest.fixture
def step(monkeypatch, tmp_path, fake):
    import steps.speech.transcribe as T
    monkeypatch.setattr(T, "require_whisper_model", lambda model, language: (model, str(tmp_path / "m.bin")))
    monkeypatch.setattr(T, "find_whisper_bin", lambda: "whisper-cli")
    return T


def full_file_whisper(monkeypatch, step, calls):
    """The step's own (full-file) whisper call: writes <--output-file>.json and .srt."""
    def go(cmd, audio, check=False, **kw):
        calls.append(cmd)
        prefix = cmd[cmd.index("--output-file") + 1]
        Path(prefix + ".json").write_text(json.dumps({"transcription": [
            {"text": " Hello", "offsets": {"from": 0, "to": 500}}]}))
        Path(prefix + ".srt").write_text("1\n00:00:00,000 --> 00:00:00,500\nHello\n\n")
    monkeypatch.setattr(step, "run_whisper", go)


def test_step_by_runs_is_the_default(step, tmp_path, fake):
    f = fake({0: [("Hello", 0.5, 0.9)]})
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.5)], 3.0)
    res = step.transcribe(media, str(tmp_path / "out"), "base.en", "en")
    data = load(tmp_path / "out")
    assert data["montaj"]["by"] == "runs" and len(f.calls) == 1
    assert res["word_count"] == 1 and Path(res["srt"]).exists() and res["words"] == str(tmp_path / "out.json")


def test_step_by_runs_false_keeps_the_full_file_path(step, tmp_path, fake, monkeypatch):
    f = fake()
    calls = []
    full_file_whisper(monkeypatch, step, calls)
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.5)], 3.0)
    step.transcribe(media, str(tmp_path / "out"), "base.en", "en", by_runs=False)
    assert f.calls == [] and len(calls) == 1 and "--output-file" in calls[0] and "-f" in calls[0]
    assert load(tmp_path / "out")["montaj"] == {"input": "file", "offsets": "source", "timestamps": "source", "srt": "source"}


def test_step_trim_spec_keeps_the_full_file_path(step, tmp_path, fake, monkeypatch):
    f = fake()
    calls = []
    full_file_whisper(monkeypatch, step, calls)
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.5)], 3.0)
    spec = tmp_path / "spec.json"
    spec.write_text(json.dumps({"input": media, "keeps": [[0.0, 2.0]]}))
    step.transcribe(str(spec), str(tmp_path / "out"), "base.en", "en")
    assert f.calls == [] and len(calls) == 1
    assert load(tmp_path / "out")["montaj"]["input"] == "spec"


def test_step_max_context_is_ignored_by_runs(step, tmp_path, fake):
    f = fake({0: [("Hello", 0.6, 1.0)]})
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.5)], 3.0)
    step.transcribe(media, str(tmp_path / "out"), "base.en", "en", max_context=5)
    cmd = f.calls[0]["cmd"]
    assert cmd[cmd.index("-mc") + 1] == "0"


def test_step_no_voice_falls_back_to_the_full_file_run(step, tmp_path, fake, monkeypatch):
    f = fake()
    calls = []
    full_file_whisper(monkeypatch, step, calls)
    media = make_wav(tmp_path / "a.wav", [], 2.0)
    step.transcribe(media, str(tmp_path / "out"), "base.en", "en")
    assert f.calls == [] and len(calls) == 1
    assert "by" not in load(tmp_path / "out")["montaj"]


def test_step_fit_pauses_applies_after_runs_and_keeps_the_run_index(step, tmp_path, fake):
    fake({0: [("Hello", 0.5, 0.9)], 1: [("world", 1.5, 1.9)]})
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.0), (3.0, 3.5)], 5.0)
    step.transcribe(media, str(tmp_path / "out"), "base.en", "en", fit_pauses=True)
    data = load(tmp_path / "out")
    assert data["montaj"]["fit_pauses"] is True and data["montaj"]["by"] == "runs"
    assert [w["run"] for w in data["transcription"]] == [0, 1]
    assert abs(data["transcription"][1]["offsets"]["from"] / 1000 - 3.0) <= 0.06


# ── cut: an old full-file transcript is redone, once ────────────────────────

def project_for(src):
    return {"id": "p", "tracks": [{"id": "t", "type": "video",
                                   "items": [{"id": "c1", "type": "video", "src": src, "start": 0, "end": 3}]}]}


def by_runs_transcript(prefix, text="new"):
    Path(prefix + ".json").write_text(json.dumps({
        "transcription": [{"text": " " + text, "offsets": {"from": 500, "to": 900}, "run": 0}],
        "montaj": {"input": "file", "by": "runs", "runs": [[0.5, 1.5]], "version": "speech-runs v1"}}))
    Path(prefix + ".srt").write_text("")
    return {"words": prefix + ".json"}


OLD = {"transcription": [{"text": " old", "offsets": {"from": 0, "to": 500}}],
       "montaj": {"input": "file", "offsets": "source", "timestamps": "source", "srt": "source"}}


def clip_dir(tmp_path, sidecar):
    d = tmp_path / "proj"
    d.mkdir()
    src = d / "clip.mp4"
    src.write_bytes(b"x")
    side = d / "clip.json"
    if sidecar is not None:
        side.write_text(json.dumps(sidecar))
    (d / "project.json").write_text("{}")
    return d, str(src), side


def test_cut_redoes_a_montaj_full_file_transcript_by_runs_once(tmp_path):
    d, src, side = clip_dir(tmp_path, OLD)
    calls = []

    def transcribe(inp, out=None, model=None, language="en", **kw):
        calls.append(inp)
        return by_runs_transcript(out)

    done, failed, warnings = speech_units.transcribe_missing(
        project_for(src), "t", str(d / "project.json"), str(d), "m", "auto", transcribe, redo_full_file=True)
    assert done == ["c1"] and failed == [] and warnings == [] and calls == [src]
    assert json.loads(side.read_text())["montaj"]["by"] == "runs"
    # a second cut finds a by-runs transcript and does nothing
    done, _, _ = speech_units.transcribe_missing(
        project_for(src), "t", str(d / "project.json"), str(d), "m", "auto", transcribe, redo_full_file=True)
    assert done == [] and calls == [src]


def test_cut_keeps_a_person_s_own_transcript(tmp_path):
    own = {"transcription": [{"text": " mine", "offsets": {"from": 0, "to": 500}}]}
    d, src, side = clip_dir(tmp_path, own)
    before = side.read_bytes()

    def transcribe(*a, **k):
        raise AssertionError("must not run")

    done, failed, warnings = speech_units.transcribe_missing(
        project_for(src), "t", str(d / "project.json"), str(d), "m", "auto", transcribe, redo_full_file=True)
    assert done == [] and side.read_bytes() == before


def test_cut_never_replaces_a_file_that_changed_meanwhile(tmp_path):
    d, src, side = clip_dir(tmp_path, OLD)
    person = {"transcription": [{"text": " typed by hand", "offsets": {"from": 0, "to": 500}}]}

    def transcribe(inp, out=None, model=None, language="en", **kw):
        side.write_text(json.dumps(person))           # someone saved their own meanwhile
        return by_runs_transcript(out)

    done, failed, warnings = speech_units.transcribe_missing(
        project_for(src), "t", str(d / "project.json"), str(d), "m", "auto", transcribe, redo_full_file=True)
    assert done == [] and json.loads(side.read_text()) == person
    assert any("changed meanwhile" in w for w in warnings)


def test_cut_keeps_the_old_transcript_when_the_redo_is_not_by_runs(tmp_path):
    d, src, side = clip_dir(tmp_path, OLD)

    def transcribe(inp, out=None, model=None, language="en", **kw):      # no voiced run: the full-file fallback
        Path(out + ".json").write_text(json.dumps(OLD))
        Path(out + ".srt").write_text("")
        return {}

    done, _, _ = speech_units.transcribe_missing(
        project_for(src), "t", str(d / "project.json"), str(d), "m", "auto", transcribe, redo_full_file=True)
    assert done == [] and json.loads(side.read_text()) == OLD


def test_cut_keeps_the_old_transcript_when_the_redo_fails(tmp_path):
    d, src, side = clip_dir(tmp_path, OLD)

    def transcribe(inp, out=None, model=None, language="en", **kw):
        speech_units.fail("transcription_failed", "stub")

    done, failed, warnings = speech_units.transcribe_missing(
        project_for(src), "t", str(d / "project.json"), str(d), "m", "auto", transcribe, redo_full_file=True)
    assert done == [] and json.loads(side.read_text()) == OLD and warnings


def test_without_redo_full_file_an_old_transcript_is_left_alone(tmp_path):
    """place (which passes nothing) never transcribes a clip that has a transcript."""
    d, src, side = clip_dir(tmp_path, OLD)

    def transcribe(*a, **k):
        raise AssertionError("must not run")

    done, _, _ = speech_units.transcribe_missing(
        project_for(src), "t", str(d / "project.json"), str(d), "m", "auto", transcribe)
    assert done == [] and json.loads(side.read_text()) == OLD
