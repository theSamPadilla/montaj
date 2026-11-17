"""Run 5 (Sam): the captions led the speech, more and more within each clip (+1.63 s at 18.9 s). generate_captions
transcribed the timeline's mix again and fitted its words to pauses found on that mix (--fit-pauses), which squeezed
them early; montaj's own per-source transcripts, which the cut was made on, were right. Captions now take each audible
clip's and voiceover's own transcript, mapped through the timeline, and transcribe the mix only when one has none."""
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from lib import caption_words  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "speech_text"
STEP_PY = ROOT / "steps" / "transform" / "generate_captions.py"


def source_words():
    d = json.loads((FIX / "speech.json").read_text())
    return [(w["text"].strip(), w["offsets"]["from"] / 1000, w["offsets"]["to"] / 1000)
            for w in d["transcription"] if w["text"].strip() and any(c.isalnum() for c in w["text"])]


def project(tmp_path, music=True):
    d = tmp_path / "proj"
    d.mkdir()
    shutil.copy(FIX / "speech.mp4", d / "talk.mp4")
    shutil.copy(FIX / "speech.json", d / "talk.json")
    shutil.copy(FIX / "speech.mp4", d / "bed.mp4")          # music: no transcript, never captioned
    items = [{"id": "a", "type": "video", "src": str(d / "talk.mp4"), "start": 0.0, "end": 6.0, "inPoint": 8.0, "outPoint": 14.0},
             {"id": "b", "type": "video", "src": "talk.mp4", "start": 6.0, "end": 9.5, "inPoint": 1.0, "outPoint": 4.5},
             {"id": "r", "type": "video", "src": str(d / "bed.mp4"), "start": 2.0, "end": 3.0, "inPoint": 0.0, "outPoint": 1.0, "muted": True}]
    p = {"id": "p1", "name": "t", "settings": {"colorSpace": "sdr", "fps": 30},
         "tracks": [{"id": "trk-0", "items": items[:2]}, {"id": "br", "items": items[2:]}],
         "audio": {"tracks": [{"id": "m", "type": "music", "src": str(d / "bed.mp4"), "start": 0.0, "end": 9.5,
                                "inPoint": 0.0, "outPoint": 9.5, "volume": 0.2}] if music else []}}
    (d / "project.json").write_text(json.dumps(p))
    return d, p


def expected(p):
    out = []
    for it in p["tracks"][0]["items"]:
        for t, a, b in source_words():
            if it["inPoint"] <= (a + b) / 2 < it["outPoint"]:
                out.append((t, max(it["start"], it["start"] + a - it["inPoint"])))   # a word begun before the cut: at it
    return out


def test_the_words_are_each_clips_own_mapped_through_the_timeline(tmp_path):
    d, p = project(tmp_path)
    got = caption_words.timeline_words(p, str(d))
    want = expected(p)
    assert [w["text"] for w in got] == [t for t, _ in want]
    assert all(abs(w["start"] - t) < 1e-3 for w, (_, t) in zip(got, want))


def test_a_clip_with_no_transcript_leaves_it_to_the_mix(tmp_path):
    d, p = project(tmp_path)
    (d / "talk.json").unlink()
    assert caption_words.timeline_words(p, str(d)) is None


def test_the_step_captions_from_the_transcripts_within_a_tenth_and_never_transcribes_the_mix(tmp_path, monkeypatch, capsys):
    d, p = project(tmp_path)
    spec = importlib.util.spec_from_file_location("generate_captions_words", STEP_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: d)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a, **k: None)
    monkeypatch.setattr(mod, "ink_pass", lambda p: [])
    ran = []

    def fake_run(cmd, **kw):
        ran.append(" ".join(map(str, cmd)))
        assert "transcribe.py" not in ran[-1] and "mix_timeline.py" not in ran[-1], ran[-1]
        return subprocess.run(cmd, check=True, capture_output=True, text=True)
    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["generate_captions.py", "--project-id", "p1", "--script", ""])
    mod.main()
    segs = json.loads((d / "project.json").read_text())["captions"]["segments"]
    words = [(w["word"], w["start"]) for s in segs for w in s["words"]]
    want = expected(p)
    assert [w for w, _ in words] == [t for t, _ in want]
    assert max(abs(a - b) for (_, a), (_, b) in zip(words, want)) < 0.1


# §652: captions read the narration by default.

def _load_step(monkeypatch, d, argv, ran):
    spec = importlib.util.spec_from_file_location("generate_captions_audio", STEP_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: d)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a, **k: None)
    monkeypatch.setattr(mod, "ink_pass", lambda p: [])

    def fake_run(cmd, **kw):          # lowest call faked: no mix, no whisper
        ran.append([str(c) for c in cmd])
        joined = " ".join(map(str, cmd))
        if "transcribe.py" in joined:
            shutil.copy(FIX / "speech.json", d / "_caption_words.json")
            return None
        if "mix_timeline.py" in joined:
            return None
        return subprocess.run(cmd, check=True, capture_output=True, text=True)
    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["generate_captions.py", "--project-id", "p1", "--script", ""] + argv)
    return mod


def _untyped_bed_project(tmp_path):
    d, p = project(tmp_path)
    p["audio"]["tracks"][0].pop("type")           # a music bed nobody marked: it has no transcript
    p["audio"]["tracks"][0]["id"] = "bed"
    (d / "project.json").write_text(json.dumps(p))
    return d, p


def test_default_skips_a_music_track_and_keeps_the_narration(tmp_path, monkeypatch, capsys):
    d, p = _untyped_bed_project(tmp_path)
    ran = []
    _load_step(monkeypatch, d, [], ran).main()
    assert not any("transcribe.py" in " ".join(c) or "mix_timeline.py" in " ".join(c) for c in ran)
    answer = json.loads(capsys.readouterr().out)
    assert "noVoiceTrack" not in answer
    assert [w["word"] for s in answer["segments"] for w in s["words"]] == [t for t, _ in expected(p)]


def test_an_explicit_audio_param_includes_the_music_track(tmp_path, monkeypatch, capsys):
    d, p = _untyped_bed_project(tmp_path)
    ran = []
    _load_step(monkeypatch, d, ["--audio", "bed"], ran).main()
    assert any("mix_timeline.py" in " ".join(c) for c in ran)       # the bed has no transcript: the mix is read
    assert "noVoiceTrack" not in json.loads(capsys.readouterr().out)


def test_no_voice_track_and_nothing_else_audible_falls_back_and_says_so(tmp_path, monkeypatch, capsys):
    d, p = _untyped_bed_project(tmp_path)
    for it in p["tracks"][0]["items"]:
        it["muted"] = True                                          # no clip audio: only the bed is left
    (d / "project.json").write_text(json.dumps(p))
    ran = []
    _load_step(monkeypatch, d, [], ran).main()
    answer = json.loads(capsys.readouterr().out)
    assert answer["segments"] and "noVoiceTrack" in answer
    assert any("mix_timeline.py" in " ".join(c) for c in ran)


# -- Mayflower gap 56: a generated voice's words say so, from the provenance record --------------------------------
# The script pass puts back a word the transcriber dropped only for a voice made from the script: generate_voiceover's
# file (an ai entry, step generate_voiceover, unchanged since), or one a step derived from such files alone. A file the
# record says nothing of, or one that changed since, is a person's: its words are never filled.

def _voice_project(tmp_path, record=None, voice="vo.mp4"):
    from serve import provenance
    d = tmp_path / "proj"
    d.mkdir(parents=True)
    for name in ("vo-raw.mp4", "vo.mp4", "talk.mp4"):
        shutil.copy(FIX / "speech.mp4", d / name)
        shutil.copy(FIX / "speech.json", d / (name[:-4] + ".json"))
    p = {"id": "p1", "name": "t", "settings": {"colorSpace": "sdr", "fps": 30},
         "tracks": [{"id": "trk-0", "items": [{"id": "a", "type": "video", "src": str(d / "talk.mp4"), "start": 0.0, "end": 3.0,
                                                "inPoint": 8.0, "outPoint": 11.0}]}],
         "audio": {"tracks": [{"id": "v", "type": "voiceover", "src": str(d / voice), "start": 3.0, "end": 9.0,
                                "inPoint": 8.0, "outPoint": 14.0}]}}
    (d / "project.json").write_text(json.dumps(p))
    for path, entry in (record or {}).items():
        provenance.record_provenance(d, path, entry)
    return d, p


GEN = {"kind": "ai", "provider": "elevenlabs", "step": "generate_voiceover", "prompt": "the script"}


def _flags(d, p):
    words = caption_words.timeline_words(p, str(d))
    return {w.get("generated") is True for w in words if w["start"] >= 3.0}, {w.get("generated") is True for w in words if w["start"] < 3.0}


def test_a_generated_voiceover_s_words_are_marked_and_a_clip_s_are_not(tmp_path):
    d, p = _voice_project(tmp_path, {"vo.mp4": GEN})
    assert _flags(d, p) == ({True}, {False})


def test_a_voice_derived_from_a_generated_one_alone_is_generated_and_a_mix_with_a_person_is_not(tmp_path):
    d, p = _voice_project(tmp_path, {"vo-raw.mp4": GEN, "vo.mp4": {"kind": "derived", "step": "normalize_audio", "from": ["vo-raw.mp4"]}})
    assert _flags(d, p)[0] == {True}
    d2, p2 = _voice_project(tmp_path / "b", {"vo-raw.mp4": GEN, "vo.mp4": {"kind": "derived", "step": "mix", "from": ["vo-raw.mp4", "talk.mp4"]}})
    assert _flags(d2, p2)[0] == {False}


def test_a_voice_the_record_does_not_know_or_that_changed_since_is_a_person_s(tmp_path):
    d, p = _voice_project(tmp_path)
    assert _flags(d, p)[0] == {False}
    d2, p2 = _voice_project(tmp_path / "b", {"vo.mp4": GEN})
    (d2 / "vo.mp4").write_bytes(b"another file now")
    assert _flags(d2, p2)[0] == {False}
    d3, p3 = _voice_project(tmp_path / "c", {"vo.mp4": {"kind": "ai", "provider": "elevenlabs", "step": "generate_sfx"}})
    assert _flags(d3, p3)[0] == {False}


def test_write_transcript_carries_generated_for_the_script_pass(tmp_path):
    d, p = _voice_project(tmp_path, {"vo.mp4": GEN})
    out = d / "w.json"
    caption_words.write_transcript(caption_words.timeline_words(p, str(d)), out)
    entries = json.loads(out.read_text())["transcription"]
    assert {e.get("generated") for e in entries if e["offsets"]["from"] >= 3000} == {True}
    assert {e.get("generated") for e in entries if e["offsets"]["from"] < 3000} == {None}


def test_the_step_puts_back_a_word_a_generated_voice_said_and_answers_inserted(tmp_path, monkeypatch, capsys):
    d, p = _voice_project(tmp_path, {"vo.mp4": GEN})
    p["tracks"] = []
    p["audio"]["tracks"][0].update({"start": 0.0, "end": 2.0, "inPoint": 0.0, "outPoint": 2.0})
    (d / "project.json").write_text(json.dumps(p))
    (d / "vo.json").write_text(json.dumps({"transcription": [
        {"text": " We", "offsets": {"from": 0, "to": 300}}, {"text": " home", "offsets": {"from": 300, "to": 1200}}]}))
    ran = []
    mod = _load_step(monkeypatch, d, [], ran)
    monkeypatch.setattr(sys, "argv", ["generate_captions.py", "--project-id", "p1", "--script", "We sail home."])
    mod.main()
    answer = json.loads(capsys.readouterr().out)
    assert [w["word"] for s in answer["segments"] for w in s["words"]] == ["We", "sail", "home."]
    assert answer["inserted"] == 1
