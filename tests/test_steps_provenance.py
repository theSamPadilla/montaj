"""Every file a step run makes in a project's folder is recorded in the
project's `assets/.provenance.json` (serve/provenance.py) by serve's step
funnel: kind ai for a generate step, the declared kind for fetch_image
(stock), synth_audio (synth), fetch and capture_site (web), and derived for
any other step. The step subprocess is stubbed; no vendor and no site is
called."""
import json
import os
import threading
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient

import serve.routes.steps as steps_mod
from serve import provenance
from serve.server import app
from tests.conftest import STEPS_DIR

client = TestClient(app)
GENERATE = Path(STEPS_DIR) / "generate"
MEDIA = Path(STEPS_DIR) / "media"


def _schema(path: Path) -> dict:
    return json.loads(path.read_text())


SCHEMAS = {
    "generate_image": _schema(GENERATE / "generate_image.json"),
    "generate_music": _schema(GENERATE / "generate_music.json"),
    "fetch_image": _schema(MEDIA / "fetch_image.json"),
    "fetch": _schema(MEDIA / "fetch.json"),
    "capture_site": _schema(MEDIA / "capture_site.json"),
    "synth_audio": _schema(Path(STEPS_DIR) / "audio" / "synth_audio.json"),
    "trim_thing": {"name": "trim_thing", "description": "d", "input": {"type": "video"}, "output": {"type": "video"},
                   "params": [{"name": "out", "type": "path", "description": "o"},
                              {"name": "mask", "type": "path", "description": "m"}]},
}


@pytest.fixture()
def env(tmp_path, monkeypatch):
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-16-demo"
    pdir.mkdir(parents=True)
    pid = str(uuid.uuid4())
    (pdir / "project.json").write_text(json.dumps({"id": pid, "tracks": []}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    steps_mod._RESERVED_OUTS.clear()
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {k: (v, Path("x.py")) for k, v in SCHEMAS.items()})
    replies = {}

    async def fake_run(cmd, **kw):
        reply = replies.get("next")
        if reply == "fail":
            return "", '{"error": "vendor_down", "message": "no"}', 1
        if "--out-dir" in cmd:     # capture_site
            d = Path(cmd[cmd.index("--out-dir") + 1])
            (d / "logos").mkdir(parents=True, exist_ok=True)
            for name in ("desktop.png", "mobile.png", "full.png", "logos/logo-0.svg"):
                (d / name).write_bytes(b"x")
            (d / "manifest.json").write_text(json.dumps({
                "url": "https://example.com/", "title": "Example",
                "screenshots": {"desktop": "desktop.png", "mobile": "mobile.png", "full": "full.png"},
                "logos": [{"path": "logos/logo-0.svg", "source": "svg"}], "palette": [], "fonts": []}))
            return json.dumps({"path": str(d / "manifest.json")}) + "\n", "", 0
        out = cmd[cmd.index("--out") + 1]
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_bytes(b"x")
        if reply is not None:
            return json.dumps({"path": out, **reply}) + "\n", "", 0
        return out + "\n", "", 0

    monkeypatch.setattr(steps_mod, "run_subprocess", fake_run)
    return pid, pdir, replies


def _record(pdir):
    p = pdir / "assets" / ".provenance.json"
    return json.loads(p.read_text()) if p.exists() else {}


def _fields(entry, size=1):
    """An entry's kind fields: without `at`, and `bytes`, checked to be the file's
    size (these fakes write b"x")."""
    assert entry.get("bytes") == size, entry
    return {k: v for k, v in entry.items() if k not in ("at", "bytes")}


# ── ai ───────────────────────────────────────────────────────────────────────

def test_a_generated_image_in_a_project_is_recorded_by_its_path_in_the_project(env):
    pid, pdir, _ = env
    r = client.post("/api/steps/generate_image", json={"prompt": "a cat on a sofa", "_project": pid})
    assert r.status_code == 200, r.text
    [(key, entry)] = _record(pdir).items()
    assert key == Path(r.json()["out"]).relative_to(pdir).as_posix() and key.startswith("assets/generate_image-")
    assert entry["kind"] == "ai"
    assert entry["provider"] == "gemini"          # the param's default
    assert entry["step"] == "generate_image"
    assert entry["prompt"] == "a cat on a sofa"
    assert entry["at"].endswith("+00:00") and len(entry["at"]) == 25
    assert "model" not in entry                   # none given, none defaulted
    assert not (pdir / "assets" / ".generated.json").exists()   # the old record is no longer written


def test_the_provider_param_and_the_model_the_step_reports(env):
    pid, pdir, replies = env
    replies["next"] = {"model": "gpt-image-1"}
    client.post("/api/steps/generate_image", json={"prompt": "p", "provider": "kinovi", "_project": pid, "out": "hero"})
    assert _record(pdir)["assets/hero.png"]["provider"] == "kinovi"
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


def test_a_long_prompt_is_capped(env):
    pid, pdir, _ = env
    client.post("/api/steps/generate_image", json={"prompt": "x" * 5000, "_project": pid, "out": "long"})
    assert len(_record(pdir)["assets/long.png"]["prompt"]) == 2000


# ── stock ────────────────────────────────────────────────────────────────────

def test_fetch_image_records_the_search_results_licence_as_stock(env):
    pid, pdir, _ = env
    r = client.post("/api/steps/fetch_image", json={
        "url": "https://upload.wikimedia.org/a/elon.jpg", "_project": pid, "out": "elon.jpg",
        "licence": "CC BY-SA 4.0", "artist": "Jane Doe", "source": "commons", "title": "Elon at the IPO"})
    assert r.status_code == 200, r.text
    entry = _record(pdir)["assets/elon.jpg"]
    assert _fields(entry) == {
        "kind": "stock", "source": "commons", "licence": "CC BY-SA 4.0", "artist": "Jane Doe",
        "sourceUrl": "https://upload.wikimedia.org/a/elon.jpg", "title": "Elon at the IPO"}


def test_fetch_image_without_the_licence_params_is_still_stock_with_its_url(env):
    pid, pdir, _ = env
    client.post("/api/steps/fetch_image", json={
        "url": "https://upload.wikimedia.org/b.jpg", "_project": pid, "out": "b.jpg",
        "source-url": "https://commons.wikimedia.org/wiki/File:b.jpg"})
    entry = _record(pdir)["assets/b.jpg"]
    assert _fields(entry) == {
        "kind": "stock", "sourceUrl": "https://commons.wikimedia.org/wiki/File:b.jpg"}


def test_fetch_image_refuses_a_source_outside_its_options_before_it_runs(env):
    pid, pdir, _ = env
    r = client.post("/api/steps/fetch_image", json={
        "url": "https://upload.wikimedia.org/c.jpg", "_project": pid, "out": "c.jpg", "source": "flickr"})
    assert r.status_code == 422, r.text
    assert _record(pdir) == {} and not (pdir / "assets" / "c.jpg").exists()


# ── synth ────────────────────────────────────────────────────────────────────

def test_synth_audio_is_recorded_as_synth(env):
    pid, pdir, replies = env
    cues = pdir / "cues.json"
    cues.write_text("{}")
    replies["next"] = {"duration": 2.0, "peak_db": -1.0}
    r = client.post("/api/steps/synth_audio", json={"cues": str(cues), "_project": pid, "out": "beat"})
    assert r.status_code == 200, r.text
    entry = _record(pdir)["assets/beat.wav"]
    assert _fields(entry) == {"kind": "synth", "step": "synth_audio"} and "at" in entry


# ── web ──────────────────────────────────────────────────────────────────────

def test_fetch_records_a_downloaded_video_as_web_with_its_url(env):
    pid, pdir, _ = env
    r = client.post("/api/steps/fetch", json={"url": "https://youtu.be/abc", "_project": pid, "out": "talk.mp4"})
    assert r.status_code == 200, r.text
    entry = _record(pdir)["assets/talk.mp4"]
    assert _fields(entry) == {
        "kind": "web", "via": "fetch", "sourceUrl": "https://youtu.be/abc"}


def test_fetch_takes_the_title_and_page_url_from_its_meta(env):
    pid, pdir, replies = env
    out = pdir / "assets" / "clip.mp4"
    replies["next"] = {"paths": [str(out)], "videos": [{
        "id": "abc", "path": str(out), "url": "https://www.youtube.com/watch?v=abc", "title": "A talk",
        "uploader": "Some Channel"}]}
    r = client.post("/api/steps/fetch", json={"url": "https://youtu.be/abc", "out": str(out), "meta": True})
    assert r.status_code == 200, r.text
    entry = _record(pdir)["assets/clip.mp4"]
    assert entry["sourceUrl"] == "https://www.youtube.com/watch?v=abc"
    assert entry["title"] == "A talk" and entry["uploader"] == "Some Channel" and entry["via"] == "fetch"


def test_capture_site_records_every_file_its_manifest_lists_as_web(env):
    pid, pdir, _ = env
    r = client.post("/api/steps/capture_site", json={"url": "https://example.com", "out-dir": str(pdir / "site")})
    assert r.status_code == 200, r.text
    rec = _record(pdir)
    assert set(rec) == {"site/manifest.json", "site/desktop.png", "site/mobile.png", "site/full.png",
                        "site/logos/logo-0.svg"}
    for key, entry in rec.items():
        assert _fields(entry, (pdir / key).stat().st_size) == {
            "kind": "web", "via": "capture_site", "sourceUrl": "https://example.com/", "title": "Example"}


# ── derived ──────────────────────────────────────────────────────────────────

def test_any_other_step_in_a_project_is_derived_from_its_inputs_inside_the_project(env, tmp_path):
    pid, pdir, _ = env
    (pdir / "clip.mp4").write_bytes(b"v")
    outside = tmp_path / "mask.png"
    outside.write_bytes(b"m")
    r = client.post("/api/steps/trim_thing", json={
        "input": str(pdir / "clip.mp4"), "mask": str(outside), "out": str(pdir / "assets" / "cut.mp4")})
    assert r.status_code == 200, r.text
    entry = _record(pdir)["assets/cut.mp4"]
    assert _fields(entry) == {
        "kind": "derived", "step": "trim_thing", "from": ["clip.mp4"]}


def test_a_derived_output_with_no_input_in_the_project_has_no_from(env, tmp_path):
    pid, pdir, _ = env
    src = tmp_path / "elsewhere.mp4"
    src.write_bytes(b"v")
    client.post("/api/steps/trim_thing", json={"input": str(src), "out": str(pdir / "assets" / "cut.mp4")})
    assert _fields(_record(pdir)["assets/cut.mp4"]) == {"kind": "derived", "step": "trim_thing"}


def test_a_file_a_step_rewrites_in_place_keeps_its_record_with_its_new_size(env):
    pid, pdir, _ = env
    clip = pdir / "clip.mp4"
    clip.write_bytes(b"vvvv")
    _, before = provenance.record_provenance(pdir, "clip.mp4", {"kind": "user", "via": "drop"})
    assert before["bytes"] == 4
    client.post("/api/steps/trim_thing", json={"input": str(clip), "out": str(clip)})   # the fake writes b"x"
    entry = _record(pdir)["clip.mp4"]
    assert entry == {**before, "bytes": 1}                     # same kind and time, the size it has now
    got = client.get(f"/api/projects/{pid}/provenance").json()["provenance"]["clip.mp4"]
    assert "stale" not in got


def test_a_run_that_makes_several_files_writes_the_record_once(env, monkeypatch):
    pid, pdir, _ = env
    writes = []
    real = provenance.write_text_atomic
    monkeypatch.setattr(provenance, "write_text_atomic", lambda path, text: (writes.append(path), real(path, text)))
    client.post("/api/steps/capture_site", json={"url": "https://example.com", "out-dir": str(pdir / "site")})
    assert len(_record(pdir)) == 5 and len(writes) == 1


@pytest.mark.parametrize("out", ["assets/.provenance.json", "assets/.generated.json", "assets/.Provenance.JSON"])
def test_a_step_out_on_the_record_is_refused_before_it_runs(env, out):
    pid, pdir, _ = env
    r = client.post("/api/steps/trim_thing", json={"out": str(pdir / out)})
    assert r.status_code == 422 and "project" in r.json()["detail"]["message"].lower()
    r = client.post("/api/steps/generate_image", json={"prompt": "p", "_project": pid, "out": ".provenance.json"})
    assert r.status_code == 422
    assert not (pdir / "assets" / ".provenance.json").exists()


@pytest.mark.parametrize("name", ["project.json", "project.json.tmp", ".project.lock", "PROJECT.JSON"])
def test_a_step_out_on_a_project_file_is_refused(env, name):
    # M10: `out` onto a project's own files bypasses the project lock and the §477 save guard.
    pid, pdir, _ = env
    before = (pdir / "project.json").read_text()
    r = client.post("/api/steps/trim_thing", json={"out": str(pdir / name)})
    assert r.status_code == 422 and "project" in r.json()["detail"]["message"].lower()
    assert (pdir / "project.json").read_text() == before  # never overwritten
    r = client.post("/api/steps/generate_image", json={"prompt": "p", "_project": pid, "out": "project.json"})
    assert r.status_code == 422


def test_transcribe_out_whose_sidecar_is_project_json_is_refused(env):
    # transcribe's `out` is a prefix; `<out>.json` would be project.json (M10).
    from serve.routes.steps import _refuse_record_out
    pid, pdir, _ = env
    with pytest.raises(HTTPException) as e:
        _refuse_record_out(str(pdir / "project"), name="transcribe")
    assert e.value.status_code == 422
    _refuse_record_out(str(pdir / "notes"), name="transcribe")  # notes.json / notes.srt are fine


# ── what records nothing ─────────────────────────────────────────────────────

def test_output_outside_every_project_is_not_recorded(env):
    # Inside the workspace but in no project folder: the out guard allows it (M11 dropped the temp
    # allowance, so the target must be inside the workspace), and provenance records nothing.
    pid, pdir, _ = env
    ws = pdir.parent
    out = ws / "elsewhere" / "x.png"
    assert client.post("/api/steps/generate_image", json={"prompt": "p", "out": str(out)}).status_code == 200
    src = ws / "in.mp4"
    src.write_bytes(b"v")
    assert client.post("/api/steps/trim_thing", json={"input": str(src), "out": str(ws / "cut.mp4")}).status_code == 200
    assert not (pdir / "assets" / ".provenance.json").exists()
    assert not list(ws.rglob(".provenance.json"))


def test_a_failed_step_records_nothing(env):
    pid, pdir, replies = env
    replies["next"] = "fail"
    assert client.post("/api/steps/generate_image", json={"prompt": "p", "_project": pid}).status_code == 500
    assert client.post("/api/steps/trim_thing", json={"out": str(pdir / "assets" / "cut.mp4")}).status_code == 500
    assert _record(pdir) == {}


def test_a_record_that_cannot_be_written_never_fails_the_step(env, monkeypatch):
    pid, pdir, _ = env

    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(provenance, "record_provenance", boom)
    r = client.post("/api/steps/generate_image", json={"prompt": "p", "_project": pid})
    assert r.status_code == 200 and r.json()["out"]
    monkeypatch.setattr(provenance, "step_records", boom)
    r = client.post("/api/steps/generate_image", json={"prompt": "p", "_project": pid})
    assert r.status_code == 200 and r.json()["out"]


# ── declarations ─────────────────────────────────────────────────────────────

def test_every_generate_step_declares_its_provider():
    for path in sorted(GENERATE.glob("*.json")):
        schema = json.loads(path.read_text())
        prov = schema.get("provenance")
        assert isinstance(prov, dict) and len(prov) == 1, path.name
        if "providerParam" in prov:
            assert any(p["name"] == prov["providerParam"] for p in schema["params"]), path.name
        else:
            assert prov["provider"] in {"kling", "fal", "kinovi", "gemini", "openai", "elevenlabs", "tripo"}, path.name


def test_every_kind_declaration_is_one_the_funnel_reads():
    declared = {}
    for path in sorted(Path(STEPS_DIR).glob("*/*.json")):
        prov = json.loads(path.read_text()).get("provenance")
        if isinstance(prov, dict) and "kind" in prov:
            declared[path.stem] = prov
            assert prov["kind"] in provenance.STEP_KINDS, path.name
            if prov["kind"] == "web":
                assert prov["via"] in provenance.WEB_VIA, path.name
    assert set(declared) == {"fetch_image", "synth_audio", "fetch", "capture_site"}

