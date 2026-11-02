"""§657: `cut` on a timeline with no video spine. Track 0 holds 3D shots (overlays), lane 0 is one narration. The cut
plans and applies silence cuts on the lane; the narration becomes back-to-back lane-0 items, and the 3D shots,
captions and shot keyframes ripple by the same time map. Transcription is a sidecar beside the wav: no model runs."""
import contextlib
import io
import json
import math
import random
import struct
import sys
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

import steps.edit.cut as cc  # noqa: E402

# (seconds, voiced): speech 0-1, silence 1-1.8, speech 1.8-3, silence 3-3.9, speech 3.9-4.9
SEGMENTS = [(1.0, True), (0.8, False), (1.2, True), (0.9, False), (1.0, True)]
DUR = sum(d for d, _ in SEGMENTS)
WORDS = [(" One", 0, 450), (" two", 500, 1000), (" three", 1800, 2400), (" four.", 2450, 3000), (" five", 3900, 4400),
         (" six.", 4450, 4900)]


def make(d):
    rng = random.Random(1)
    frames = []
    for secs, loud in SEGMENTS:
        for i in range(int(secs * 16000)):
            frames.append(int(8000 * math.sin(i * 0.35) if loud else rng.randint(-3, 3)))
    with wave.open(str(d / "vo.wav"), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"".join(struct.pack("<h", x) for x in frames))
    (d / "vo.json").write_text(json.dumps({"transcription": [
        {"text": t, "offsets": {"from": a, "to": b}} for t, a, b in WORDS]}))
    shot = lambda i, a, b: {"id": i, "type": "overlay", "src": "engine:scene3d", "start": a, "end": b,
                            "props": {"scene": "s"}}
    project = {
        "version": "0.1", "id": "all3d", "name": "all3d", "status": "draft", "workflow": "blank", "editingPrompt": "",
        "settings": {"resolution": [1080, 1920], "fps": 30},
        "tracks": [{"id": "t0", "items": [shot("sh1", 0.0, 2.5), shot("sh2", 2.5, DUR)]}],
        "audio": {"tracks": [{"id": "vo0", "type": "voiceover", "lane": 0, "src": "vo.wav", "start": 0.0, "end": DUR,
                              "inPoint": 0.0, "outPoint": DUR, "volume": 1}]},
        "captions": {"segments": [
            {"id": "c1", "text": "five six", "start": 3.9, "end": 4.9},
        ]},
    }
    (d / "project.json").write_text(json.dumps(project, indent=2))


def run(d, monkeypatch, *extra):
    monkeypatch.setattr(sys, "argv", ["cut.py", "--project", str(d / "project.json"), "--speech", "audio:lane-0",
                                      *extra])
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        cc.main()
    return json.loads(out.getvalue())


def test_an_all_3d_timeline_cuts_its_narration_and_ripples_everything(tmp_path, monkeypatch):
    make(tmp_path)
    plan = run(tmp_path, monkeypatch)
    assert plan["mode"] == "plan"
    applied = run(tmp_path, monkeypatch, "--plan", str(tmp_path / "cut-plan.md"))
    assert applied["mode"] == "applied"
    p = json.loads((tmp_path / "project.json").read_text())

    vo = sorted(p["audio"]["tracks"], key=lambda a: a["start"])
    assert len(vo) == 3 and all(a["lane"] == 0 for a in vo)
    assert vo[0]["start"] == 0.0
    for a, b in zip(vo, vo[1:]):
        assert abs(a["end"] - b["start"]) < 1e-3, "back to back"
    assert abs(vo[-1]["end"] - applied["duration"]) < 1e-3

    shots = p["tracks"][0]["items"]
    assert [s["id"] for s in shots] == ["sh1", "sh2"]
    assert shots[0]["start"] == 0.0 and abs(shots[0]["end"] - shots[1]["start"]) < 1e-3
    assert abs(shots[1]["end"] - applied["duration"]) < 1e-3

    seg = p["captions"]["segments"][0]
    last = vo[-1]
    assert abs(seg["start"] - last["start"]) < 0.1 and abs(seg["end"] - last["end"]) < 0.1
