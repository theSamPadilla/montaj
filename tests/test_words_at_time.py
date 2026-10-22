"""words_at_time: per-source words mapped through the current tracks. Whisper is stubbed with a sidecar file."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))
from lib.speech_words_at import words_at  # noqa: E402
from serve.routes.steps import scan_steps  # noqa: E402
from serve.server import app  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

STEP = ROOT / "steps" / "speech" / "words_at_time.py"


def _sidecar(tmp, name, words):
    (tmp / f"{name}.mp4").write_bytes(b"")
    (tmp / f"{name}.json").write_text(json.dumps({"transcription": [
        {"text": " " + t, "offsets": {"from": int(a * 1000), "to": int(b * 1000)}} for t, a, b in words]}))
    return str(tmp / f"{name}.mp4")


def _clip(i, src, start, end, a, b, **kw):
    return {"id": i, "type": "video", "src": src, "start": start, "end": end, "inPoint": a, "outPoint": b, **kw}


def _proj(*items):
    return {"id": "p", "tracks": [{"id": "trk-0", "items": list(items)}]}


WORDS = [("one", 0, 1), ("two", 1, 2), ("three", 2, 3), ("four", 3, 4)]


def texts(r):
    return [w["text"] for w in r]


def test_offset_trim_and_straddle(tmp_path):
    src = _sidecar(tmp_path, "a", WORDS)
    # source 1..3 (two, three) plays at timeline 10..12
    p = _proj(_clip("c1", src, 10, 12, 1, 3))
    r = words_at(p, str(tmp_path), 0, 100)
    assert [(w["text"], w["start"], w["end"]) for w in r] == [("two", 10, 11), ("three", 11, 12)]
    assert r[0]["sourceStart"] == 1 and r[0]["source"] == src
    r = words_at(p, str(tmp_path), 10.5, 11.5)  # straddles two/three
    assert texts(r) == ["two", "three"]
    assert words_at(p, str(tmp_path), 12.5, 13) == [] and words_at(p, str(tmp_path), 0, 9) == []
    assert texts(words_at(p, str(tmp_path), 11.5, 11.5)) == ["three"]  # point


def test_two_sources_across_cut(tmp_path):
    a = _sidecar(tmp_path, "a", WORDS)
    b = _sidecar(tmp_path, "b", [("alpha", 5, 6), ("beta", 6, 7)])
    p = _proj(_clip("c1", a, 0, 2, 0, 2), _clip("c2", b, 2, 4, 5, 7))
    r = words_at(p, str(tmp_path), 1.5, 2.5)
    assert [(w["text"], w["start"], w["end"]) for w in r] == [("two", 1, 2), ("alpha", 2, 3)]


def test_stale_transcript_follows_current_cut(tmp_path):
    src = _sidecar(tmp_path, "a", WORDS)
    old = _proj(_clip("c1", src, 0, 4, 0, 4))
    new = _proj(_clip("c1", src, 0, 1, 0, 1), _clip("c2", src, 1, 3, 3, 5))
    assert [(w["text"], w["start"]) for w in words_at(old, str(tmp_path), 0, 100)] == \
        [("one", 0), ("two", 1), ("three", 2), ("four", 3)]
    assert [(w["text"], w["start"]) for w in words_at(new, str(tmp_path), 0, 100)] == [("one", 0), ("four", 1)]
    assert texts(words_at(new, str(tmp_path), 1.2, 1.4)) == ["four"]


def test_speed(tmp_path):
    src = _sidecar(tmp_path, "a", WORDS)
    p = _proj(_clip("c1", src, 5, 7, 0, 4, speed=2))
    r = words_at(p, str(tmp_path), 0, 100)
    assert [(w["text"], w["start"], w["end"]) for w in r] == [
        ("one", 5, 5.5), ("two", 5.5, 6), ("three", 6, 6.5), ("four", 6.5, 7)]


def test_step_cli_and_schema(tmp_path):
    src = _sidecar(tmp_path, "a", WORDS)
    pj = tmp_path / "project.json"
    pj.write_text(json.dumps(_proj(_clip("c1", src, 10, 12, 1, 3))))
    run = lambda *a: subprocess.run([sys.executable, str(STEP), "--project", str(pj), *a], capture_output=True, text=True)
    out = run("--t", "10.5")
    assert out.returncode == 0
    d = json.loads(out.stdout)
    assert d["count"] == 1 and d["words"][0]["text"] == "two"
    assert run("--start", "1").returncode == 1
    assert run("--start", "5", "--end", "2").returncode == 1
    steps = scan_steps()
    schema = steps["words_at_time"][0]
    assert {p["name"] for p in schema["params"]} == {"project", "t", "start", "end", "track"}


def test_through_serve_route_declared_params_arrive(tmp_path, monkeypatch):
    """/api/steps drops undeclared params, so t/start/end/track must reach the step."""
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-21-demo"
    pdir.mkdir(parents=True)
    src = _sidecar(pdir, "a", WORDS)
    proj = _proj(_clip("c1", src, 10, 12, 1, 3))
    proj["id"] = "11111111-1111-4111-8111-111111111111"
    (pdir / "project.json").write_text(json.dumps(proj))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    with TestClient(app, raise_server_exceptions=False) as client:
        r = client.post("/api/steps/words_at_time", json={"project": proj["id"], "start": 10.5, "end": 11.5})
        assert r.status_code == 200, r.text
        assert [w["text"] for w in r.json()["words"]] == ["two", "three"]
        r = client.post("/api/steps/words_at_time", json={"project": proj["id"], "t": 11.5, "track": "trk-0"})
        assert [w["text"] for w in r.json()["words"]] == ["three"]
        r = client.post("/api/steps/words_at_time", json={"project": proj["id"], "t": 11.5, "track": "nope"})
        assert r.json()["count"] == 0
