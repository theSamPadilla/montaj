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
