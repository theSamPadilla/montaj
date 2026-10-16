"""A generate step's output that lands in a project is recorded in the
project's `assets/.generated.json` (serve/provenance.py), and
GET /api/projects/{id}/generated reads it back. The step subprocess is
stubbed; no vendor is called."""
import json
import threading
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import serve.routes.steps as steps_mod
from serve import provenance
from serve.server import app
from tests.conftest import STEPS_DIR

client = TestClient(app)
GENERATE = Path(STEPS_DIR) / "generate"
IMAGE = json.loads((GENERATE / "generate_image.json").read_text())
MUSIC = json.loads((GENERATE / "generate_music.json").read_text())
PLAIN = {"name": "trim_thing", "description": "d", "input": {"type": "video"}, "output": {"type": "video"},
         "params": [{"name": "out", "type": "path", "description": "o"}]}


@pytest.fixture()
def env(tmp_path, monkeypatch):
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-16-demo"
    pdir.mkdir(parents=True)
    pid = str(uuid.uuid4())
    (pdir / "project.json").write_text(json.dumps({"id": pid, "tracks": []}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    steps_mod._RESERVED_OUTS.clear()
    schemas = {"generate_image": IMAGE, "generate_music": MUSIC, "trim_thing": PLAIN}
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {k: (v, Path("x.py")) for k, v in schemas.items()})
    replies = {}

    async def fake_run(cmd, **kw):
        out = cmd[cmd.index("--out") + 1]
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(b"x")
        reply = replies.get("next")
        if reply == "fail":
            return "", '{"error": "vendor_down", "message": "no"}', 1
        if reply is not None:
            return json.dumps({**reply, "path": out}) + "\n", "", 0
        return out + "\n", "", 0

    monkeypatch.setattr(steps_mod, "run_subprocess", fake_run)
    return pid, pdir, replies


def _record(pdir):
    p = pdir / "assets" / ".generated.json"
    return json.loads(p.read_text()) if p.exists() else {}


def test_a_generated_image_in_a_project_is_recorded_by_its_path_in_the_project(env):
    pid, pdir, _ = env
    r = client.post("/api/steps/generate_image", json={"prompt": "a cat on a sofa", "_project": pid})
    assert r.status_code == 200, r.text
    rec = _record(pdir)
    [(key, entry)] = rec.items()
    assert key == Path(r.json()["out"]).relative_to(pdir).as_posix() and key.startswith("assets/generate_image-")
    assert entry["provider"] == "gemini"          # the param's default
    assert entry["step"] == "generate_image"
    assert entry["prompt"] == "a cat on a sofa"
    assert entry["at"].endswith("+00:00")
    assert "model" not in entry                   # none given, none defaulted


def test_the_provider_param_and_the_model_the_step_reports(env):
    pid, pdir, replies = env
    replies["next"] = {"model": "gpt-image-1"}
    client.post("/api/steps/generate_image", json={"prompt": "p", "provider": "openai", "_project": pid, "out": "hero"})
    assert _record(pdir)["assets/hero.png"]["provider"] == "openai"
    assert _record(pdir)["assets/hero.png"]["model"] == "gpt-image-1"
    replies["next"] = {"vendor": "elevenlabs", "duration_seconds": 30}
    client.post("/api/steps/generate_music", json={"prompt": "calm", "vendor": "elevenlabs", "_project": pid, "out": "bed"})
    assert _record(pdir)["assets/bed.mp3"]["provider"] == "elevenlabs"
    assert set(_record(pdir)) == {"assets/hero.png", "assets/bed.mp3"}


def test_an_absolute_out_inside_a_project_is_recorded_without__project(env):
    pid, pdir, _ = env
    out = pdir / "assets" / "music.mp3"
    r = client.post("/api/steps/generate_music", json={"prompt": "calm", "out": str(out)})
    assert r.status_code == 200, r.text
    assert _record(pdir)["assets/music.mp3"]["provider"] == "gemini"


def test_output_outside_every_project_is_not_recorded(env, tmp_path):
    pid, pdir, _ = env
    out = tmp_path / "elsewhere" / "x.png"
    assert client.post("/api/steps/generate_image", json={"prompt": "p", "out": str(out)}).status_code == 200
    assert not (pdir / "assets" / ".generated.json").exists()
    assert not (out.parent / ".generated.json").exists()


def test_a_step_without_provenance_and_a_failed_step_record_nothing(env):
    pid, pdir, replies = env
    out = pdir / "assets" / "cut.mp4"
    assert client.post("/api/steps/trim_thing", json={"out": str(out)}).status_code == 200
    replies["next"] = "fail"
    assert client.post("/api/steps/generate_image", json={"prompt": "p", "_project": pid}).status_code == 500
    assert _record(pdir) == {}


def test_a_record_that_cannot_be_written_never_fails_the_step(env, monkeypatch):
    pid, pdir, _ = env
    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(provenance, "record", boom)
    r = client.post("/api/steps/generate_image", json={"prompt": "p", "_project": pid})
    assert r.status_code == 200 and r.json()["out"]


def test_concurrent_records_keep_every_entry(tmp_path):
    pdir = tmp_path / "p"
    (pdir / "assets").mkdir(parents=True)
    (pdir / "project.json").write_text("{}")
    files = [pdir / "assets" / f"f{i}.png" for i in range(40)]
    threads = [threading.Thread(target=provenance.record, args=(pdir, str(f), {"provider": "gemini"})) for f in files]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(provenance.read(pdir)) == 40
    assert not list((pdir / "assets").glob("*.tmp"))


def test_the_record_reads_back_through_the_project_route(env):
    pid, pdir, _ = env
    empty = client.get(f"/api/projects/{pid}/generated").json()
    assert empty["generated"] == {} and Path(empty["dir"]).resolve() == pdir.resolve()
    client.post("/api/steps/generate_image", json={"prompt": "p", "_project": pid, "out": "a"})
    got = client.get(f"/api/projects/{pid}/generated").json()
    assert list(got["generated"]) == ["assets/a.png"] and got["generated"]["assets/a.png"]["provider"] == "gemini"
    assert (Path(got["dir"]) / "assets/a.png").is_file()
    (pdir / "assets" / ".generated.json").write_text("not json")
    assert client.get(f"/api/projects/{pid}/generated").json()["generated"] == {}


def test_every_generate_step_declares_its_provider():
    for path in sorted(GENERATE.glob("*.json")):
        schema = json.loads(path.read_text())
        prov = schema.get("provenance")
        assert isinstance(prov, dict) and len(prov) == 1, path.name
        if "providerParam" in prov:
            assert any(p["name"] == prov["providerParam"] for p in schema["params"]), path.name
        else:
            assert prov["provider"] in {"kling", "fal", "kinovi", "gemini", "openai", "elevenlabs"}, path.name
