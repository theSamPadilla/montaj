"""The provenance record's one writer (serve/provenance.py `record_provenance`)
and its routes: POST/GET /api/projects/{id}/provenance, the optional entry on
upload-asset and sources, and GET /generated reading both the new record and
the older AI-only `.generated.json`."""
import asyncio
import json
import os
import threading
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import serve.routes.projects as projects_mod
from serve import provenance
from serve.routes.projects import _IngestJob, _run_ingest_detached
from serve.server import app
from serve.sse import SSEBroadcaster

client = TestClient(app)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-20-demo"
    (pdir / "assets").mkdir(parents=True)
    pid = str(uuid.uuid4())
    (pdir / "project.json").write_text(json.dumps({"id": pid, "tracks": [], "sources": [],
                                                   "settings": {"colorSpace": "sdr-bt709"}}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    return pid, pdir


def _record(pdir):
    p = pdir / "assets" / ".provenance.json"
    return json.loads(p.read_text()) if p.exists() else {}


def _post(pid, path, entry):
    return client.post(f"/api/projects/{pid}/provenance", json={"path": path, "entry": entry})


def _strip_at(entry):
    return {k: v for k, v in entry.items() if k not in ("at", "bytes")}


# ── the route records each kind the app writes ───────────────────────────────

@pytest.mark.parametrize("entry", [
    {"kind": "user", "via": "drop"},
    {"kind": "user", "via": "record"},
    {"kind": "library", "id": "adult-04", "version": 1, "spdx": "MIT", "source": "montaj-library",
     "notice": "Character by someone, MIT"},
    {"kind": "template", "templateId": "glass-plate-promo"},
    {"kind": "brand_kit", "profileId": "acme"},
    {"kind": "montaj", "what": "sample"},
    {"kind": "web", "via": "url", "sourceUrl": "https://example.com/a.mp4", "title": "A"},
    {"kind": "web", "via": "youtube", "sourceUrl": "https://youtu.be/x", "uploader": "Chan"},
])
def test_the_route_records_each_kind(env, entry):
    pid, pdir = env
    (pdir / "assets" / "a.mp4").write_bytes(b"x")
    r = _post(pid, "assets/a.mp4", entry)
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "assets/a.mp4"
    stored = _record(pdir)["assets/a.mp4"]
    assert _strip_at(stored) == entry and r.json()["entry"] == stored
    assert stored["at"].endswith("+00:00")
    assert client.get(f"/api/projects/{pid}/provenance").json()["provenance"] == {"assets/a.mp4": stored}


def test_an_absolute_path_inside_the_project_and_a_given_time(env):
    pid, pdir = env
    r = _post(pid, str(pdir / "clip.mov"), {"kind": "user", "via": "picker", "at": "2026-10-20T09:00:00Z"})
    assert r.status_code == 200, r.text
    assert _record(pdir) == {"clip.mov": {"kind": "user", "at": "2026-10-20T09:00:00+00:00", "via": "picker"}}


def test_a_later_entry_for_a_path_replaces_the_earlier_one(env):
    pid, pdir = env
    _post(pid, "a.png", {"kind": "user", "via": "drop"})
    _post(pid, "b.png", {"kind": "user", "via": "drop"})
    _post(pid, "a.png", {"kind": "brand_kit", "profileId": "acme"})
    assert {k: e["kind"] for k, e in _record(pdir).items()} == {"a.png": "brand_kit", "b.png": "user"}


def test_long_strings_are_capped(env):
    pid, pdir = env
    _post(pid, "a.png", {"kind": "library", "id": "x", "notice": "n" * 5000})
    _post(pid, "b.png", {"kind": "ai", "provider": "gemini", "step": "generate_image", "prompt": "p" * 5000,
                         "model": "m" * 5000})
    rec = _record(pdir)
    assert len(rec["a.png"]["notice"]) == 1000
    assert len(rec["b.png"]["prompt"]) == 2000 and len(rec["b.png"]["model"]) == 1000


# ── refusals ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("entry, says", [
    (None, "object"),
    ("user", "object"),
    ({"via": "drop"}, "kind"),
    ({"kind": "pirated"}, "kind"),
    ({"kind": "user"}, "via"),                                   # required
    ({"kind": "user", "via": "telepathy"}, "via"),               # outside its values
    ({"kind": "user", "via": "drop", "licence": "MIT"}, "licence"),  # not a user field
    ({"kind": "stock", "source": "flickr"}, "source"),
    ({"kind": "stock", "licence": 4}, "licence"),                # not a string
    ({"kind": "derived", "step": "trim", "from": "a.mp4"}, "from"),
    ({"kind": "derived", "step": "trim", "from": [1]}, "from"),
    ({"kind": "library", "id": "x", "version": True}, "version"),
    ({"kind": "ai", "provider": "gemini"}, "step"),
    ({"kind": "template"}, "templateId"),
    ({"kind": "brand_kit", "profileId": "  "}, "profileId"),
    ({"kind": "montaj", "what": "logo"}, "what"),
    ({"kind": "user", "via": "drop", "at": "yesterday"}, "at"),
    ({"kind": "user", "via": "drop", "at": "2026-10-20T09:00:00.5Z"}, "at"),
    ({"kind": "user", "via": "drop", "at": "2026-10-20T09:00:00-05:00"}, "at"),
    ({"kind": "user", "via": "drop", "at": "2026-13-40T09:00:00Z"}, "at"),
])
def test_an_entry_the_record_refuses_is_a_422_and_writes_nothing(env, entry, says):
    pid, pdir = env
    r = _post(pid, "a.png", entry)
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "invalid_entry" and says in r.json()["detail"]["message"]
    assert not (pdir / "assets" / ".provenance.json").exists()


def test_a_path_outside_the_project_is_a_422(env, tmp_path):
    pid, pdir = env
    elsewhere = tmp_path / "elsewhere.png"
    elsewhere.write_bytes(b"x")
    (pdir / "link.png").symlink_to(elsewhere)
    other = pdir.parent / "2026-10-19-other"
    other.mkdir()
    for path in (str(elsewhere), "../2026-10-19-other/a.png", "assets/../../x.png", "link.png", str(pdir), "."):
        r = _post(pid, path, {"kind": "user", "via": "drop"})
        assert r.status_code == 422, (path, r.text)
        assert r.json()["detail"]["error"] == "outside_project", path
    assert not (pdir / "assets" / ".provenance.json").exists()


@pytest.mark.parametrize("path", ["project.json", "assets/.provenance.json", "assets/.generated.json",
                                  ".project.lock", ".git/HEAD", "", 7])
def test_the_projects_own_files_and_a_missing_path_are_refused(env, path):
    pid, pdir = env
    r = _post(pid, path, {"kind": "user", "via": "drop"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "invalid_path"


def test_a_full_record_is_refused_and_kept(env, monkeypatch):
    pid, pdir = env
    assert _post(pid, "a.png", {"kind": "user", "via": "drop"}).status_code == 200
    before = (pdir / "assets" / ".provenance.json").read_bytes()
    monkeypatch.setattr(provenance, "_RECORD_MAX_BYTES", len(before) + 10)
    r = _post(pid, "b.png", {"kind": "user", "via": "drop"})
    assert r.status_code == 422 and r.json()["detail"]["error"] == "record_full"
    monkeypatch.setattr(provenance, "_RECORD_MAX_BYTES", len(before) - 1)   # already over: never reset to {}
    r = _post(pid, "c.png", {"kind": "user", "via": "drop"})
    assert r.status_code == 422 and r.json()["detail"]["error"] == "record_full"
    assert (pdir / "assets" / ".provenance.json").read_bytes() == before


def test_an_unreadable_record_is_kept_aside_not_lost(env):
    pid, pdir = env
    (pdir / "assets" / ".provenance.json").write_text("{not json")
    assert _post(pid, "a.png", {"kind": "user", "via": "drop"}).status_code == 200
    assert list(_record(pdir)) == ["a.png"]
    [aside] = (pdir / "assets").glob(".provenance.json.unreadable-*")
    assert aside.read_text() == "{not json"


# ── one writer, serialised ───────────────────────────────────────────────────

def test_concurrent_writers_lose_no_entry(env):
    pid, pdir = env
    files = [f"assets/f{i}.png" for i in range(40)]
    errors = []

    def write(path):
        try:
            provenance.record_provenance(pdir, path, {"kind": "user", "via": "drop"})
        except Exception as e:   # pragma: no cover - reported below
            errors.append(e)
    threads = [threading.Thread(target=write, args=(f,)) for f in files]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert set(provenance.read(pdir)) == set(files)
    assert not list((pdir / "assets").glob("*.tmp"))


def test_concurrent_route_writers_lose_no_entry(env):
    pid, pdir = env
    files = [f"assets/r{i}.png" for i in range(20)]
    answers = []
    threads = [threading.Thread(target=lambda f=f: answers.append(_post(pid, f, {"kind": "montaj", "what": "preset"})))
               for f in files]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert all(a.status_code == 200 for a in answers)
    assert set(_record(pdir)) == set(files)


# ── the older AI-only record ─────────────────────────────────────────────────

def test_the_older_generated_json_is_still_read_by_both_routes(env):
    pid, pdir = env
    old = {"assets/old.png": {"provider": "kling", "model": "kling-v3-omni", "prompt": "p",
                              "step": "kling_generate", "at": "2026-10-01T10:00:00+00:00"},
           "assets/both.png": {"provider": "gemini", "step": "generate_image", "at": "2026-10-01T10:00:00+00:00"}}
    (pdir / "assets" / ".generated.json").write_text(json.dumps(old))
    for name in ("old.png", "both.png", "new.png", "mine.mov"):
        (pdir / "assets" / name).write_bytes(b"x")
    _post(pid, "assets/new.png", {"kind": "ai", "provider": "openai", "step": "generate_image", "model": "gpt-image-1"})
    _post(pid, "assets/both.png", {"kind": "user", "via": "drop"})   # the newer record wins
    _post(pid, "assets/mine.mov", {"kind": "user", "via": "picker"})

    prov = client.get(f"/api/projects/{pid}/provenance").json()
    assert Path(prov["dir"]).resolve() == pdir.resolve()
    assert prov["provenance"]["assets/old.png"] == {**old["assets/old.png"], "kind": "ai"}
    assert prov["provenance"]["assets/both.png"]["kind"] == "user"
    assert set(prov["provenance"]) == {"assets/old.png", "assets/both.png", "assets/new.png", "assets/mine.mov"}

    gen = client.get(f"/api/projects/{pid}/generated").json()
    assert Path(gen["dir"]).resolve() == pdir.resolve()
    assert set(gen["generated"]) == {"assets/old.png", "assets/new.png"}
    assert gen["generated"]["assets/old.png"] == old["assets/old.png"]      # exactly as it was answered before
    assert "kind" not in gen["generated"]["assets/new.png"]
    assert gen["generated"]["assets/new.png"]["provider"] == "openai"
    # the old file is read, never written
    assert json.loads((pdir / "assets" / ".generated.json").read_text()) == old


# ── bytes, and an entry whose file is no longer the one recorded ────────────

def test_an_entry_records_the_files_size_when_the_file_exists(env):
    pid, pdir = env
    (pdir / "assets" / "here.png").write_bytes(b"12345")
    assert _post(pid, "assets/here.png", {"kind": "user", "via": "drop"}).json()["entry"]["bytes"] == 5
    assert "bytes" not in _post(pid, "assets/later.png", {"kind": "user", "via": "drop"}).json()["entry"]
    (pdir / "models" / "robot").mkdir(parents=True)
    assert "bytes" not in _post(pid, "models/robot", {"kind": "user", "via": "import_model"}).json()["entry"]
    assert _record(pdir)["assets/here.png"]["bytes"] == 5


@pytest.mark.parametrize("field", [{"bytes": 5}, {"stale": False}])
def test_bytes_and_stale_are_the_writers_and_the_readers_never_a_callers(env, field):
    pid, pdir = env
    r = _post(pid, "a.png", {"kind": "user", "via": "drop", **field})
    assert r.status_code == 422 and r.json()["detail"]["error"] == "invalid_entry"


def test_a_new_file_under_a_deleted_files_name_inherits_nothing(env):
    pid, pdir = env
    gen = pdir / "assets" / "hero.png"
    gen.write_bytes(b"made by a model")
    _post(pid, "assets/hero.png", {"kind": "ai", "provider": "gemini", "step": "generate_image"})
    (pdir / "assets" / "kept.png").write_bytes(b"k")
    _post(pid, "assets/kept.png", {"kind": "user", "via": "drop"})
    gone = pdir / "assets" / "gone.png"
    gone.write_bytes(b"g")
    _post(pid, "assets/gone.png", {"kind": "user", "via": "drop"})
    _post(pid, "assets/never.png", {"kind": "user", "via": "drop"})       # recorded before the file existed

    gen.unlink()
    gen.write_bytes(b"the user's own photo, a different file")
    gone.unlink()
    prov = client.get(f"/api/projects/{pid}/provenance").json()["provenance"]
    assert prov["assets/hero.png"]["stale"] is True and prov["assets/hero.png"]["kind"] == "ai"
    assert prov["assets/gone.png"]["stale"] is True
    assert prov["assets/never.png"]["stale"] is True                      # no bytes, and no file
    assert "stale" not in prov["assets/kept.png"]
    gen_route = client.get(f"/api/projects/{pid}/generated").json()["generated"]
    assert gen_route["assets/hero.png"]["stale"] is True                  # marked, not dropped
    # nothing is deleted or rewritten by reading
    assert set(_record(pdir)) == {"assets/hero.png", "assets/kept.png", "assets/gone.png", "assets/never.png"}
    assert not any("stale" in e for e in _record(pdir).values())

    (pdir / "assets" / "never.png").write_bytes(b"n")                     # no bytes to compare: not stale
    assert "stale" not in client.get(f"/api/projects/{pid}/provenance").json()["provenance"]["assets/never.png"]


def test_an_older_ai_entry_whose_file_is_gone_reads_as_stale(env):
    pid, pdir = env
    (pdir / "assets" / ".generated.json").write_text(json.dumps({
        "assets/old.png": {"provider": "kling", "step": "kling_generate", "at": "2026-10-01T10:00:00+00:00"}}))
    assert client.get(f"/api/projects/{pid}/generated").json()["generated"]["assets/old.png"]["stale"] is True
    (pdir / "assets" / "old.png").write_bytes(b"x")
    assert "stale" not in client.get(f"/api/projects/{pid}/generated").json()["generated"]["assets/old.png"]


def test_both_routes_answer_empty_for_a_project_with_no_record(env):
    pid, pdir = env
    assert client.get(f"/api/projects/{pid}/provenance").json()["provenance"] == {}
    assert client.get(f"/api/projects/{pid}/generated").json()["generated"] == {}
    (pdir / "assets" / ".generated.json").write_text("not json")
    assert client.get(f"/api/projects/{pid}/generated").json()["generated"] == {}


# ── upload-asset and sources ─────────────────────────────────────────────────

def test_upload_asset_records_the_entry_it_is_given(env):
    pid, pdir = env
    r = client.post(f"/api/projects/{pid}/upload-asset", files={"file": ("drop.png", b"img")},
                    data={"provenance": json.dumps({"kind": "user", "via": "drop"})})
    assert r.status_code == 200, r.text
    key = Path(r.json()["path"]).resolve().relative_to(pdir.resolve()).as_posix()
    assert _strip_at(_record(pdir)[key]) == {"kind": "user", "via": "drop"}
    assert "provenanceError" not in r.json()


def test_upload_asset_without_an_entry_records_nothing(env):
    pid, pdir = env
    r = client.post(f"/api/projects/{pid}/upload-asset", files={"file": ("drop.png", b"img")})
    assert r.status_code == 200 and Path(r.json()["path"]).is_file()
    assert _record(pdir) == {}


@pytest.mark.parametrize("field", ["not json", json.dumps({"kind": "user"}), json.dumps(["user"])])
def test_upload_asset_with_a_bad_entry_is_a_422_and_stores_nothing(env, field):
    pid, pdir = env
    r = client.post(f"/api/projects/{pid}/upload-asset", files={"file": ("bad.png", b"img")},
                    data={"provenance": field})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "invalid_entry"
    assert not (pdir / "bad.png").exists() and _record(pdir) == {}


def test_upload_asset_keeps_the_file_when_the_record_cannot_be_written(env, monkeypatch):
    pid, pdir = env

    def full(*a, **k):
        raise provenance.ProvenanceError("record_full", "The project's provenance record is full")
    monkeypatch.setattr(provenance, "record_provenance", full)
    r = client.post(f"/api/projects/{pid}/upload-asset", files={"file": ("kept.png", b"img")},
                    data={"provenance": json.dumps({"kind": "user", "via": "drop"})})
    assert r.status_code == 200 and Path(r.json()["path"]).is_file()
    assert r.json()["provenanceError"]["error"] == "record_full"


def test_sources_refuses_a_bad_entry_before_anything_runs(env, monkeypatch, tmp_path):
    pid, pdir = env
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"v")
    ran = []
    monkeypatch.setattr(projects_mod, "_run_ingest_detached", lambda *a, **k: ran.append(a))
    r = client.post(f"/api/projects/{pid}/sources",
                    json={"path": str(clip), "provenance": {"kind": "user", "via": "carrier pigeon"}})
    assert r.status_code == 422 and r.json()["detail"]["error"] == "invalid_entry"
    assert not ran


def test_an_ingested_source_records_its_entry_for_each_file_it_stores(env, monkeypatch):
    pid, pdir = env
    src, normalized = pdir / "clip.mp4", pdir / "clip_sdr.mp4"
    src.write_bytes(b"v")
    normalized.write_bytes(b"v")
    monkeypatch.setattr(projects_mod, "ingest_source", lambda *a, **k: {
        "type": "video", "src": str(src), "normalizedSrc": str(normalized), "start": 0.0, "end": 0.0})
    monkeypatch.setattr(projects_mod, "_ensure_current_proxies",
                        lambda *a, **k: {"scheduled": 0, "alreadyFresh": 0})
    job = _IngestJob()
    asyncio.run(_run_ingest_detached(pid, pdir, "/picked/clip.mp4", "sdr-bt709", SSEBroadcaster(), job,
                                     provenance_entry=provenance.validate_entry({"kind": "user", "via": "picker"})))
    assert job.status == "done", job.error
    rec = _record(pdir)
    assert set(rec) == {"clip.mp4", "clip_sdr.mp4"}
    assert all(_strip_at(e) == {"kind": "user", "via": "picker"} for e in rec.values())


def test_an_ingested_source_without_an_entry_records_nothing(env, monkeypatch):
    pid, pdir = env
    monkeypatch.setattr(projects_mod, "ingest_source", lambda *a, **k: {
        "type": "video", "src": str(pdir / "clip.mp4"), "start": 0.0, "end": 0.0})
    monkeypatch.setattr(projects_mod, "_ensure_current_proxies",
                        lambda *a, **k: {"scheduled": 0, "alreadyFresh": 0})
    job = _IngestJob()
    asyncio.run(_run_ingest_detached(pid, pdir, "/picked/clip.mp4", "sdr-bt709", SSEBroadcaster(), job))
    assert job.status == "done", job.error
    assert _record(pdir) == {}
