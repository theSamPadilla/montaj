"""The provenance record's one writer (serve/provenance.py `record_many` and
`record_provenance`) and its routes: POST/GET /api/projects/{id}/provenance, the
optional entry on upload-asset and sources, GET /generated reading both the new
record and the older AI-only `.generated.json`, the engine guard on who may
record, and every other way into the record file being refused."""
import asyncio
import json
import os
import threading
import unicodedata
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import serve.routes.projects as projects_mod
from serve import provenance, save_guard, save_media
from serve.routes.projects import _IngestJob, _run_ingest_detached
from serve.server import app
from serve.sse import SSEBroadcaster

client = TestClient(app)
SECRET = "5e" * 32


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


def _touch(pdir, *names, data=b"x"):
    for name in names:
        (pdir / name).parent.mkdir(parents=True, exist_ok=True)
        (pdir / name).write_bytes(data)


def _post(pid, path, entry, headers=None):
    return client.post(f"/api/projects/{pid}/provenance", json={"path": path, "entry": entry}, headers=headers)


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
    _touch(pdir, "assets/a.mp4")
    r = _post(pid, "assets/a.mp4", entry)
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "assets/a.mp4"
    stored = _record(pdir)["assets/a.mp4"]
    assert _strip_at(stored) == entry and r.json()["entry"] == stored
    assert stored["at"].endswith("+00:00") and stored["bytes"] == 1
    assert client.get(f"/api/projects/{pid}/provenance").json()["provenance"] == {"assets/a.mp4": stored}


def test_an_absolute_path_inside_the_project_and_a_given_time(env):
    pid, pdir = env
    _touch(pdir, "clip.mov")
    r = _post(pid, str(pdir / "clip.mov"), {"kind": "user", "via": "picker", "at": "2026-10-20T09:00:00Z"})
    assert r.status_code == 200, r.text
    assert _record(pdir) == {"clip.mov": {"kind": "user", "at": "2026-10-20T09:00:00+00:00", "via": "picker",
                                          "bytes": 1}}


def test_a_later_entry_for_a_path_replaces_the_earlier_one(env):
    pid, pdir = env
    _touch(pdir, "a.png", "b.png")
    _post(pid, "a.png", {"kind": "user", "via": "drop"})
    _post(pid, "b.png", {"kind": "user", "via": "drop"})
    _post(pid, "a.png", {"kind": "brand_kit", "profileId": "acme"})
    assert {k: e["kind"] for k, e in _record(pdir).items()} == {"a.png": "brand_kit", "b.png": "user"}


def test_long_strings_are_capped(env):
    pid, pdir = env
    _touch(pdir, "a.png", "b.png")
    _post(pid, "a.png", {"kind": "library", "id": "x", "notice": "n" * 5000})
    _post(pid, "b.png", {"kind": "ai", "provider": "gemini", "step": "generate_image", "prompt": "p" * 5000,
                         "model": "m" * 5000})
    rec = _record(pdir)
    assert len(rec["a.png"]["notice"]) == 1000
    assert len(rec["b.png"]["prompt"]) == 2000 and len(rec["b.png"]["model"]) == 1000


def test_a_folder_is_recorded_without_bytes(env):
    pid, pdir = env
    (pdir / "models" / "robot").mkdir(parents=True)
    r = _post(pid, "models/robot", {"kind": "user", "via": "import_model"})
    assert r.status_code == 200 and "bytes" not in r.json()["entry"]


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
    ({"kind": "user", "via": "drop", "bytes": 5}, "bytes"),      # the writer's, never a caller's
    ({"kind": "user", "via": "drop", "stale": False}, "stale"),  # the reader's
])
def test_an_entry_the_record_refuses_is_a_422_and_writes_nothing(env, entry, says):
    pid, pdir = env
    _touch(pdir, "a.png")
    r = _post(pid, "a.png", entry)
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "invalid_entry" and says in r.json()["detail"]["message"]
    assert not (pdir / "assets" / ".provenance.json").exists()


def test_a_file_that_does_not_exist_is_refused(env):
    pid, pdir = env
    r = _post(pid, "assets/later.png", {"kind": "user", "via": "drop"})
    assert r.status_code == 422 and r.json()["detail"]["error"] == "file_not_found"
    assert _record(pdir) == {}


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


@pytest.mark.parametrize("path", [
    "project.json", "assets/.provenance.json", "assets/.generated.json", ".project.lock", ".git/HEAD", "", 7,
    "Project.JSON", "project.json.", "ASSETS/.Provenance.json", "assets/.provenance.json.unreadable-1",
    "assets/.ｐrovenance.json", ".GIT/config", "project.json.tmp",
])
def test_the_projects_own_files_and_a_missing_path_are_refused(env, path):
    pid, pdir = env
    r = _post(pid, path, {"kind": "user", "via": "drop"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "invalid_path"


def test_a_hard_link_to_project_json_is_refused(env):
    pid, pdir = env
    os.link(pdir / "project.json", pdir / "assets" / "innocent.json")
    r = _post(pid, "assets/innocent.json", {"kind": "user", "via": "drop"})
    assert r.status_code == 422 and r.json()["detail"]["error"] == "invalid_path"


def test_a_key_is_the_composed_spelling_of_its_name(env):
    pid, pdir = env
    decomposed = unicodedata.normalize("NFD", "café.png")
    _touch(pdir, decomposed)
    r = _post(pid, decomposed, {"kind": "user", "via": "drop"})
    assert r.status_code == 200, r.text
    assert r.json()["path"] == unicodedata.normalize("NFC", "café.png") != decomposed


def test_a_record_past_the_cap_drops_the_entries_whose_file_is_gone(env, monkeypatch):
    pid, pdir = env
    _touch(pdir, *(f"old{i}.png" for i in range(5)), "kept.png", "new.png")
    for i in range(5):
        _post(pid, f"old{i}.png", {"kind": "user", "via": "drop"})
    _post(pid, "kept.png", {"kind": "user", "via": "drop"})
    for i in range(5):
        (pdir / f"old{i}.png").unlink()
    monkeypatch.setattr(provenance, "_RECORD_MAX_BYTES", len((pdir / "assets" / ".provenance.json").read_bytes()))
    r = _post(pid, "new.png", {"kind": "user", "via": "drop"})
    assert r.status_code == 200, r.text
    assert set(_record(pdir)) == {"kept.png", "new.png"}


def test_a_full_record_with_nothing_to_drop_is_refused_and_kept(env, monkeypatch):
    pid, pdir = env
    _touch(pdir, "a.png", "b.png")
    assert _post(pid, "a.png", {"kind": "user", "via": "drop"}).status_code == 200
    before = (pdir / "assets" / ".provenance.json").read_bytes()
    monkeypatch.setattr(provenance, "_RECORD_MAX_BYTES", len(before) + 10)
    r = _post(pid, "b.png", {"kind": "user", "via": "drop"})
    assert r.status_code == 422 and r.json()["detail"]["error"] == "record_full"
    assert (pdir / "assets" / ".provenance.json").read_bytes() == before


def test_an_unreadable_record_is_kept_aside_not_lost(env):
    pid, pdir = env
    _touch(pdir, "a.png")
    (pdir / "assets" / ".provenance.json").write_text("{not json")
    assert _post(pid, "a.png", {"kind": "user", "via": "drop"}).status_code == 200
    assert list(_record(pdir)) == ["a.png"]
    [aside] = (pdir / "assets").glob(".provenance.json.unreadable-*")
    assert aside.read_text() == "{not json"


def test_a_deleted_project_is_never_made_again(env):
    pid, pdir = env
    _touch(pdir, "a.png")
    (pdir / "project.json").unlink()
    (pdir / "assets").rmdir()
    with pytest.raises(provenance.ProvenanceError) as e:
        provenance.record_provenance(pdir, "a.png", {"kind": "user", "via": "drop"})
    assert e.value.code == "project_gone"
    assert not (pdir / "assets").exists() and not (pdir / ".project.lock").exists()


def test_a_project_being_deleted_is_not_written(env):
    pid, pdir = env
    _touch(pdir, "a.png")
    with save_media.project_deleting(pdir):
        with pytest.raises(provenance.ProvenanceError) as e:
            provenance.record_provenance(pdir, "a.png", {"kind": "user", "via": "drop"})
    assert e.value.code == "project_gone" and _record(pdir) == {}


# ── one writer, serialised ───────────────────────────────────────────────────

def test_concurrent_writers_lose_no_entry(env):
    pid, pdir = env
    files = [f"assets/f{i}.png" for i in range(40)]
    _touch(pdir, *files)
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
    _touch(pdir, *files)
    answers = []
    threads = [threading.Thread(target=lambda f=f: answers.append(_post(pid, f, {"kind": "montaj", "what": "preset"})))
               for f in files]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert all(a.status_code == 200 for a in answers)
    assert set(_record(pdir)) == set(files)


def test_record_many_writes_once_and_reports_what_it_refused(env, monkeypatch):
    pid, pdir = env
    _touch(pdir, "a.png", "b.png")
    writes = []
    real = provenance.write_text_atomic
    monkeypatch.setattr(provenance, "write_text_atomic", lambda path, text: (writes.append(path), real(path, text)))
    written, refused = provenance.record_many(pdir, [
        ("a.png", {"kind": "user", "via": "drop"}), ("b.png", {"kind": "user", "via": "drop"}),
        ("missing.png", {"kind": "user", "via": "drop"}), ("project.json", {"kind": "user", "via": "drop"}),
        ("a.png", None)])
    assert len(writes) == 1
    assert set(written) == {"a.png", "b.png"}
    assert sorted((p, e.code) for p, e in refused) == [("missing.png", "file_not_found"),
                                                       ("project.json", "invalid_path")]


# ── the older AI-only record ─────────────────────────────────────────────────

def test_the_older_generated_json_is_still_read_by_both_routes(env):
    pid, pdir = env
    old = {"assets/old.png": {"provider": "kling", "model": "kling-v3-omni", "prompt": "p",
                              "step": "kling_generate", "at": "2026-10-01T10:00:00+00:00"},
           "assets/both.png": {"provider": "gemini", "step": "generate_image", "at": "2026-10-01T10:00:00+00:00"}}
    (pdir / "assets" / ".generated.json").write_text(json.dumps(old))
    _touch(pdir, "assets/old.png", "assets/both.png", "assets/new.png", "assets/mine.mov")
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

def test_an_entry_records_the_files_size(env):
    pid, pdir = env
    _touch(pdir, "assets/here.png", data=b"12345")
    assert _post(pid, "assets/here.png", {"kind": "user", "via": "drop"}).json()["entry"]["bytes"] == 5
    assert _record(pdir)["assets/here.png"]["bytes"] == 5


def test_a_new_file_under_a_deleted_files_name_inherits_nothing(env):
    pid, pdir = env
    _touch(pdir, "assets/hero.png", data=b"made by a model")
    _post(pid, "assets/hero.png", {"kind": "ai", "provider": "gemini", "step": "generate_image"})
    _touch(pdir, "assets/kept.png", "assets/gone.png")
    _post(pid, "assets/kept.png", {"kind": "user", "via": "drop"})
    _post(pid, "assets/gone.png", {"kind": "user", "via": "drop"})

    (pdir / "assets" / "hero.png").unlink()
    _touch(pdir, "assets/hero.png", data=b"the user's own photo, a different file")
    (pdir / "assets" / "gone.png").unlink()
    prov = client.get(f"/api/projects/{pid}/provenance").json()["provenance"]
    assert prov["assets/hero.png"]["stale"] is True and prov["assets/hero.png"]["kind"] == "ai"
    assert prov["assets/gone.png"]["stale"] is True
    assert "stale" not in prov["assets/kept.png"]
    # /generated leaves the stale ai entry out: the new hero.png is not AI-made
    assert client.get(f"/api/projects/{pid}/generated").json()["generated"] == {}
    # nothing is deleted or rewritten by reading
    assert set(_record(pdir)) == {"assets/hero.png", "assets/kept.png", "assets/gone.png"}
    assert not any("stale" in e for e in _record(pdir).values())


def test_an_older_ai_entry_whose_file_is_gone_is_left_out_of_generated(env):
    pid, pdir = env
    (pdir / "assets" / ".generated.json").write_text(json.dumps({
        "assets/old.png": {"provider": "kling", "step": "kling_generate", "at": "2026-10-01T10:00:00+00:00"}}))
    assert client.get(f"/api/projects/{pid}/generated").json()["generated"] == {}
    assert client.get(f"/api/projects/{pid}/provenance").json()["provenance"]["assets/old.png"]["stale"] is True
    _touch(pdir, "assets/old.png")      # no bytes to compare: there is a file, so it is not stale
    assert "stale" not in client.get(f"/api/projects/{pid}/generated").json()["generated"]["assets/old.png"]


def test_both_routes_answer_empty_for_a_project_with_no_record(env):
    pid, pdir = env
    assert client.get(f"/api/projects/{pid}/provenance").json()["provenance"] == {}
    assert client.get(f"/api/projects/{pid}/generated").json()["generated"] == {}
    (pdir / "assets" / ".generated.json").write_text("not json")
    assert client.get(f"/api/projects/{pid}/generated").json()["generated"] == {}


# ── nothing else writes the record ───────────────────────────────────────────

@pytest.mark.parametrize("name", [".provenance.json", ".generated.json", ".Provenance.JSON", ".provenance.json."])
def test_post_files_refuses_the_record(env, name):
    pid, pdir = env
    target = pdir / "assets" / name
    r = client.post("/api/files", json={"path": str(target), "content": "{}"})
    assert r.status_code == 400 and r.json()["detail"]["error"] == "project_file_protected"
    assert not target.exists()


def test_delete_files_refuses_the_record(env):
    pid, pdir = env
    _touch(pdir, "a.png")
    _post(pid, "a.png", {"kind": "user", "via": "drop"})
    r = client.request("DELETE", f"/api/projects/{pid}/files", json={"paths": ["assets/.provenance.json"]})
    assert r.json()["results"] == [{"path": "assets/.provenance.json", "status": "error",
                                    "error": "project_file_protected"}]
    assert list(_record(pdir)) == ["a.png"]


def test_a_copy_into_assets_never_takes_a_records_name():
    assert save_media._reserved(".provenance.json") and save_media._reserved(".generated.json")


# ── upload-asset and sources ─────────────────────────────────────────────────

def test_upload_asset_records_the_entry_it_is_given(env):
    pid, pdir = env
    r = client.post(f"/api/projects/{pid}/upload-asset", files={"file": ("drop.png", b"img")},
                    data={"provenance": json.dumps({"kind": "user", "via": "drop"})})
    assert r.status_code == 200, r.text
    key = Path(r.json()["path"]).resolve().relative_to(pdir.resolve()).as_posix()
    assert _strip_at(_record(pdir)[key]) == {"kind": "user", "via": "drop"}
    assert _record(pdir)[key]["bytes"] == 3
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


# ── with the engine guard on, only the app records ───────────────────────────

@pytest.fixture()
def guard(monkeypatch):
    saved = dict(save_guard._state)
    monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    monkeypatch.delenv("MONTAJ_SHELL_SECRET_STDIN", raising=False)
    save_guard._state.update({"secret": None, "logged": False, "secret_logged": False})
    save_guard._inject_secret_for_tests(SECRET)
    save_guard.startup()
    assert save_guard.enabled()
    yield
    save_guard._state.clear()
    save_guard._state.update(saved)


ALLOWED = [{"x-montaj-shell": SECRET, "x-montaj-writer": "editor"},
           {"x-montaj-shell": SECRET, "x-montaj-writer": "tool"}]
REFUSED = [{"x-montaj-shell": SECRET, "x-montaj-writer": "ai"},
           {"x-montaj-writer": "editor"},                                     # no secret
           {"x-montaj-shell": "0" * 64, "x-montaj-writer": "tool"},          # a wrong one
           {}]


@pytest.mark.parametrize("headers", ALLOWED)
def test_with_the_guard_on_the_window_and_the_main_process_record(env, guard, headers):
    pid, pdir = env
    _touch(pdir, "a.png")
    assert _post(pid, "a.png", {"kind": "user", "via": "drop"}, headers).status_code == 200
    r = client.post(f"/api/projects/{pid}/upload-asset", files={"file": ("up.png", b"img")},
                    data={"provenance": json.dumps({"kind": "user", "via": "drop"})}, headers=headers)
    assert r.status_code == 200, r.text
    assert set(_record(pdir)) == {"a.png", "up.png"}


@pytest.mark.parametrize("headers", REFUSED)
def test_with_the_guard_on_the_ai_and_an_untrusted_caller_are_refused(env, guard, headers, tmp_path, monkeypatch):
    pid, pdir = env
    _touch(pdir, "a.png")
    r = _post(pid, "a.png", {"kind": "user", "via": "drop"}, headers)
    assert r.status_code == 403 and r.json()["detail"]["error"] == "shell_only"
    r = client.post(f"/api/projects/{pid}/upload-asset", files={"file": ("up.png", b"img")},
                    data={"provenance": json.dumps({"kind": "user", "via": "drop"})}, headers=headers)
    assert r.status_code == 403 and not (pdir / "up.png").exists()
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"v")
    ran = []
    monkeypatch.setattr(projects_mod, "_run_ingest_detached", lambda *a, **k: ran.append(a))
    r = client.post(f"/api/projects/{pid}/sources",
                    json={"path": str(clip), "provenance": {"kind": "user", "via": "picker"}}, headers=headers)
    assert r.status_code == 403 and not ran
    assert _record(pdir) == {}
    # without a provenance field, upload-asset is as open as before
    r = client.post(f"/api/projects/{pid}/upload-asset", files={"file": ("plain.png", b"img")}, headers=headers)
    assert r.status_code == 200


def test_with_the_guard_off_any_caller_records(env):
    pid, pdir = env
    assert not save_guard.enabled()
    _touch(pdir, "a.png")
    assert _post(pid, "a.png", {"kind": "user", "via": "drop"}, {"x-montaj-writer": "ai"}).status_code == 200
