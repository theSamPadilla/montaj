"""PL89 A1 T1: lib/speech_runs, a take transcribed by voiced run (one whisper call, a clip a run), the transcribe
step's `whole-file` param (off: by runs) and cut's redo of an old full-file transcript. Synthetic only: tones and silence written here,
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
    media = make_wav(tmp_path / "a.wav", [(3.0, 4.5), (6.0, 7.5)], 8.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    # a run of 1 s or more has no context: each clip is its run plus 0.2 s of pad each side, 2 x 1.9 s
    assert f.calls[0]["duration_s"] == pytest.approx(3.8, abs=0.15)


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


# ── the opening words of a clip ─────────────────────────────────────────────

def by_run(tmp_path):
    out = {}
    for w in load(tmp_path / "out")["transcription"]:
        out.setdefault(w["run"], []).append(w)
    return out


def test_a_long_run_s_clip_has_no_context_so_words_stamped_at_zero_are_kept(tmp_path, fake):
    # run 1.0-3.0 (2 s): its clip opens 0.2 s before it. Whisper stamps the opening words from the clip's own 0.0.
    f = fake({0: [("You", 0.0, 0.3), ("may", 0.3, 0.6), ("already", 0.6, 1.0), ("have", 1.0, 1.4)]})
    media = make_wav(tmp_path / "a.wav", [(1.0, 3.0)], 4.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    words = by_run(tmp_path)[0]
    assert [w["text"].strip() for w in words] == ["You", "may", "already", "have"]
    assert all(0.99 <= w["offsets"]["from"] / 1000 <= w["offsets"]["to"] / 1000 <= 3.01 for w in words)


def test_a_short_run_with_context_drops_the_previous_runs_echoed_tail_by_text(tmp_path, fake):
    # run 0 is 0.5-2.0 (clip from 0.3); run 1 is 3.0-3.5 (0.5 s: a clip from 1.5). Whisper writes run 0's last words
    # again at the clip's start, stamped INSIDE run 1, then the real word.
    fake({0: [("Mount", 0.3, 0.6), ("the", 0.6, 0.9), ("phone", 0.9, 1.4)],
          1: [("the", 1.5, 1.7), ("phone", 1.7, 1.9), ("Compute.", 1.9, 2.3)]})
    media = make_wav(tmp_path / "a.wav", [(0.5, 2.0), (3.0, 3.5)], 5.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    got = by_run(tmp_path)
    assert [w["text"].strip() for w in got[0]] == ["Mount", "the", "phone"]
    assert [w["text"].strip() for w in got[1]] == ["Compute."]


def test_a_short_run_whose_echo_does_not_match_keeps_the_words_that_end_inside_it(tmp_path, fake):
    fake({0: [("Mount", 0.3, 0.6), ("phone", 0.9, 1.4)],
          1: [("stray", 0.0, 0.4),                 # source 1.5-1.9: ends before the run (3.0) less the pad
              ("other", 1.5, 1.9), ("thing", 1.9, 2.3)]})
    media = make_wav(tmp_path / "a.wav", [(0.5, 2.0), (3.0, 3.5)], 5.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    assert [w["text"].strip() for w in by_run(tmp_path)[1]] == ["other", "thing"]


# ── hallucinations ──────────────────────────────────────────────────────────

def test_a_voiced_short_run_keeps_its_words_even_a_stock_phrase(tmp_path, fake):
    # run 0 and run 1 are 0.3 s of sound; run 2 is 1.0 s
    # a short run's clip opens 1.5 s before it (run 0: at 0, so 0.5; run 1: 1.5); a long run's 0.2 s (run 2: 0.2)
    fake({0: [("Thank", 0.5, 0.7), ("you.", 0.7, 1.0)],
          1: [("Compute.", 1.5, 1.9)],
          2: [("Thank", 0.2, 0.7), ("you.", 0.7, 1.2)]})
    media = make_wav(tmp_path / "a.wav", [(0.5, 0.8), (2.0, 2.3), (4.0, 5.2)], 6.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    data = load(tmp_path / "out")
    by_run = {}
    for w in data["transcription"]:
        by_run.setdefault(w["run"], []).append(w["text"].strip())
    assert by_run[0] == ["Thank", "you."]            # the source's first run: a real opening is never dropped
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


def test_step_whole_file_keeps_the_full_file_path(step, tmp_path, fake, monkeypatch):
    f = fake()
    calls = []
    full_file_whisper(monkeypatch, step, calls)
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.5)], 3.0)
    step.transcribe(media, str(tmp_path / "out"), "base.en", "en", whole_file=True)
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


def test_step_cli_flag_whole_file(step, tmp_path, fake, monkeypatch):
    f = fake()
    calls = []
    full_file_whisper(monkeypatch, step, calls)
    media = make_wav(tmp_path / "a.wav", [(0.5, 1.5)], 3.0)
    monkeypatch.setattr(sys, "argv", ["transcribe.py", "--input", media, "--out", str(tmp_path / "out"), "--whole-file"])
    step.main()
    assert f.calls == [] and len(calls) == 1


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


def test_a_run_starts_at_the_voice_not_at_a_bump_of_no_voice_before_it(tmp_path):
    """Real take D: a -47 dB bump 0.15 s before the voice opened the run on loudness alone, so the run's first word was
    clamped onto the bump, on no voice, and cut removed it. The runs are read with cut's own voice check: the run starts
    at the voice."""
    import numpy as np
    from tests.test_voice import band, scaled, vowel
    rng = np.random.default_rng(3)
    n = int(3.0 * RATE)
    x = scaled(rng.standard_normal(n), -72)                         # the room
    a, b = int(1.0 * RATE), int(2.0 * RATE)
    x[a:b] += scaled(vowel(rng, b - a, 120), -20)                   # the voice
    c = int(0.85 * RATE)
    x[c:c + 160] += scaled(band(rng, 160, 1500, 7000), -40)         # a 10 ms bump of no voice, 0.15 s before it
    path = tmp_path / "bump.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    runs = sr.voiced_runs(str(path))
    assert len(runs) == 1
    assert runs[0][0] == pytest.approx(1.0, abs=0.03)



# ── review should-fixes (PL89 review 4, 5) ─────────────────────────────────

def test_a_back_to_back_short_retake_keeps_its_only_word(tmp_path, fake):
    """"It's called PhoneBot." then a 0.4 s "PhoneBot." said again: the short run's echo match would take its only
    word, and cut would then remove its sound. Its words that lie inside the run by time stay."""
    fake({0: [("It's", 0.3, 0.6), ("called", 0.6, 1.0), ("PhoneBot.", 1.0, 1.6)],
          1: [("PhoneBot.", 1.55, 1.85)]})                 # clip from 1.1: source 2.65-2.95, inside the run
    media = make_wav(tmp_path / "a.wav", [(0.5, 2.0), (2.6, 3.0)], 4.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    assert [w["text"].strip() for w in by_run(tmp_path)[1]] == ["PhoneBot."]


def test_a_real_sign_off_on_the_last_run_is_kept(tmp_path, fake):
    fake({0: [("Follow", 0.2, 0.6), ("me.", 0.6, 1.2)], 1: [("Bye!", 1.5, 1.8)]})
    media = make_wav(tmp_path / "a.wav", [(0.5, 2.0), (2.6, 3.0)], 4.0)
    sr.transcribe_runs(media, str(tmp_path / "out"), "model.bin", "en")
    assert [w["text"].strip() for w in by_run(tmp_path)[1]] == ["Bye!"]


def test_a_stock_phrase_goes_only_on_a_short_middle_run_with_little_voice():
    words = [("Thank", 3.0, 3.2), ("you.", 3.2, 3.4)]
    assert sr._hallucination(words, (3.0, 3.4), share=0.1)
    assert not sr._hallucination(words, (3.0, 3.4), share=0.9)                 # a voice said it
    assert not sr._hallucination(words, (3.0, 3.4), share=0.1, edge=True)      # first or last run
    assert not sr._hallucination(words, (3.0, 3.4), share=None)                # no voice check: kept
    assert not sr._hallucination(words, (3.0, 4.0), share=0.1)                 # a long run



# ── review should-fix 6: the redo keeps the old file and says every skip ────────────────────────────────────

def test_the_redo_keeps_the_old_transcript_as_full_json_and_writes_the_new_srt(tmp_path):
    d, src, side = clip_dir(tmp_path, OLD)
    old = side.read_bytes()
    (d / "clip.srt").write_text("1\n00:00:00,000 --> 00:00:00,500\nold\n\n")
    old_srt = (d / "clip.srt").read_bytes()

    def transcribe(inp, out=None, model=None, language="en", **kw):
        res = by_runs_transcript(out)
        Path(out + ".srt").write_text("1\n00:00:00,500 --> 00:00:00,900\nnew\n\n")
        return res

    done, _, warnings = speech_units.transcribe_missing(
        project_for(src), "t", str(d / "project.json"), str(d), "m", "auto", transcribe, redo_full_file=True)
    assert done == ["c1"] and json.loads(side.read_text())["montaj"]["by"] == "runs"
    assert (d / "clip.full.json").read_bytes() == old
    assert (d / "clip.full.srt").read_bytes() == old_srt
    assert "new" in (d / "clip.srt").read_text()


def test_the_redo_never_overwrites_an_earlier_full_json(tmp_path):
    d, src, side = clip_dir(tmp_path, OLD)
    (d / "clip.full.json").write_text("kept")

    def transcribe(inp, out=None, model=None, language="en", **kw):
        return by_runs_transcript(out)

    done, _, _ = speech_units.transcribe_missing(
        project_for(src), "t", str(d / "project.json"), str(d), "m", "auto", transcribe, redo_full_file=True)
    assert done == ["c1"] and (d / "clip.full.json").read_text() == "kept"
    assert json.loads((d / "clip.full-2.json").read_text()) == OLD


def test_a_redo_with_no_voiced_run_says_it_kept_the_older_transcript(tmp_path):
    d, src, side = clip_dir(tmp_path, OLD)

    def transcribe(inp, out=None, model=None, language="en", **kw):      # no voiced run: the full-file fallback
        Path(out + ".json").write_text(json.dumps(OLD))
        Path(out + ".srt").write_text("")
        return {}

    done, _, warnings = speech_units.transcribe_missing(
        project_for(src), "t", str(d / "project.json"), str(d), "m", "auto", transcribe, redo_full_file=True)
    assert done == [] and json.loads(side.read_text()) == OLD
    assert any("kept the older transcript of clip.mp4" in w for w in warnings), warnings
