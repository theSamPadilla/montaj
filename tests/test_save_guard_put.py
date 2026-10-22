"""§477 engine save guard on PUT and GET /api/projects/{id}: a write carries the revision
of every field it changes and serve compares under the project lock. Real FastAPI app,
real lock; every project lives under tmp_path."""
import json
import threading
import time

import pytest
from starlette.testclient import TestClient

import serve.routes.projects as projects_mod
from lib.project_lock import project_lock, write_json_atomic
from lib.project_revisions import revision_of, revisions_of
from lib.project_tracks import normalize_tracks
from serve import save_guard
from serve.common import get_project_dir
from serve.server import app

PID = "guard-proj"
SECRET = "5e" * 32
OTHER = "a1" * 32


class _StubBroadcaster:
    def publish(self, *a, **k):
        pass


def _base():
    return {
        "id": PID, "name": "first", "status": "draft", "notes": [{"id": "n1", "text": "hi"}],
        "tracks": [{"id": "trk-0", "items": []}], "sources": [],
    }


def _start(monkeypatch, *, guard=True, secret=SECRET, canary=True):
    if guard:
        monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    else:
        monkeypatch.delenv("MONTAJ_ENGINE_GUARD", raising=False)
    monkeypatch.delenv("MONTAJ_SHELL_SECRET_STDIN", raising=False)
    if not canary:
        monkeypatch.setattr(save_guard.project_revisions, "canary_ok", lambda: False)
    save_guard._state.update({"secret": None, "logged": False, "secret_logged": False})
    if secret:
        save_guard._inject_secret_for_tests(secret)
    save_guard.startup()


@pytest.fixture
def proj(tmp_path, monkeypatch):
    saved = dict(save_guard._state)
    project_dir = tmp_path / PID
    project_dir.mkdir()
    write_json_atomic(project_dir / "project.json", _base())

    async def _no_previews(*a, **k):
        return None

    async def _no_dims(project_id, project_dir, project, broadcaster=None):
        return project

    monkeypatch.setattr(projects_mod, "_queue_previews_for_changed_items", _no_previews)
    monkeypatch.setattr(projects_mod, "ensure_source_dims", _no_dims)
    app.state.broadcaster = _StubBroadcaster()
    app.dependency_overrides[get_project_dir] = lambda: project_dir
    try:
        yield project_dir
    finally:
        app.dependency_overrides.pop(get_project_dir, None)
        save_guard._state.clear()
        save_guard._state.update(saved)


def _client():
    return TestClient(app, raise_server_exceptions=False)


def _bytes(project_dir):
    return (project_dir / "project.json").read_bytes()


def _disk(project_dir):
    return json.loads(_bytes(project_dir))


def _revs(project_dir, *fields):
    return revisions_of(normalize_tracks(_disk(project_dir)), fields)


def _put(body, read=None, headers=None, client=None):
    h = dict(headers or {})
    if read is not None:
        h["x-montaj-read-revisions"] = read if isinstance(read, str) else json.dumps(read)
    return (client or _client()).put(f"/api/projects/{PID}", json={"id": PID, **body}, headers=h)


def _guard_headers(resp):
    return {k: v for k, v in resp.headers.items() if k.startswith("x-montaj-")}


# ── unset: byte for byte as before ─────────────────────────────────────────────

def test_without_the_env_a_put_with_or_without_read_behaves_as_before(proj, tmp_path, monkeypatch):
    _start(monkeypatch, guard=False)
    twin = tmp_path / "twin"
    twin.mkdir()
    write_json_atomic(twin / "project.json", _base())
    body = {"name": "second", "notes": None}

    plain = _put(body)
    plain_disk = _bytes(proj)
    app.dependency_overrides[get_project_dir] = lambda: twin
    stale = _put(body, read={"name": "000000000000", "notes": "bad"},
                 headers={"x-montaj-writer": "editor", "x-montaj-guard": "advisory", "x-montaj-shell": OTHER})
    assert plain.status_code == stale.status_code == 200
    assert plain.json() == stale.json()
    assert plain_disk == _bytes(twin)
    assert _guard_headers(plain) == {} and _guard_headers(stale) == {}
    assert "notes" not in _disk(twin) and _disk(twin)["name"] == "second"


def test_without_the_env_a_get_carries_no_revisions(proj, monkeypatch):
    _start(monkeypatch, guard=False)
    resp = _client().get(f"/api/projects/{PID}?fields=name")
    assert resp.status_code == 200
    assert _guard_headers(resp) == {}


def test_canary_mismatch_ignores_every_header(proj, monkeypatch):
    _start(monkeypatch, canary=False)
    resp = _put({"name": "second"}, read={"name": "000000000000"})
    assert resp.status_code == 200
    assert _guard_headers(resp) == {}
    assert _disk(proj)["name"] == "second"
    assert _put({"status": "final"}).status_code == 200


# ── strict ─────────────────────────────────────────────────────────────────────

def test_matching_read_applies_and_answers_the_written_revisions(proj, monkeypatch):
    _start(monkeypatch)
    resp = _put({"name": "second"}, read=_revs(proj, "name"))
    assert resp.status_code == 200, resp.text
    assert _disk(proj)["name"] == "second"
    revs = json.loads(resp.headers["x-montaj-revisions"])
    assert revs == {"name": revision_of("second")}
    assert resp.headers["x-montaj-revisions-final"] == "1"
    assert "x-montaj-overrode" not in resp.headers


def test_answer_revisions_are_the_answer_bodys(proj, monkeypatch):
    """Including fields the save changed that the body did not name (a legacy shape
    normalised on write)."""
    _start(monkeypatch)
    legacy = {**_base(), "tracks": [[{"id": "c1", "type": "image", "src": "/x.png", "start": 0, "end": 1}]]}
    write_json_atomic(proj / "project.json", legacy)
    resp = _put({"name": "second", "status": "final"}, read=_revs(proj, "name", "status"))
    assert resp.status_code == 200, resp.text
    revs = json.loads(resp.headers["x-montaj-revisions"])
    assert set(revs) == {"name", "status", "tracks"}
    assert revs == revisions_of(resp.json(), list(revs))


def test_missing_read_is_400_read_required_and_nothing_is_written(proj, monkeypatch):
    _start(monkeypatch)
    before = _bytes(proj)
    resp = _put({"name": "second", "status": "final"}, read={"name": _revs(proj, "name")["name"]})
    print("WIRE 400:", resp.text)
    assert resp.status_code == 400
    assert resp.json() == {"detail": {
        "error": "read_required", "stale": [], "missing": ["status"],
        "message": 'save_project needs the revision of every field you change. Call get_project with '
                   'fields ["status"] (the fields you are changing), then call save_project again with '
                   'read set to the revisions it returned.',
    }}
    assert _bytes(proj) == before


@pytest.mark.parametrize("header", [None, "not json", "[1,2]", '"name"'])
def test_an_absent_or_unparseable_read_is_treated_as_absent(proj, monkeypatch, header):
    _start(monkeypatch)
    before = _bytes(proj)
    resp = _put({"name": "second"}, read=header)
    assert resp.status_code == 400
    assert resp.json()["detail"]["missing"] == ["name"]
    assert _bytes(proj) == before


def test_stale_read_is_409_project_changed_and_the_file_is_byte_identical(proj, monkeypatch):
    _start(monkeypatch)
    old = _revs(proj, "name")
    _put({"name": "second"}, read=old)
    before = _bytes(proj)
    resp = _put({"name": "third"}, read=old)
    print("WIRE 409:", resp.text)
    assert resp.status_code == 409
    assert resp.json() == {"detail": {
        "error": "project_changed", "stale": ["name"], "missing": [],
        "message": 'name changed since you read it (you or the user edited it, or Montaj updated it), so '
                   'nothing was saved: call get_project with fields ["name"] and redo your change on what '
                   'it returns, then save with the new revisions.',
    }}
    assert _bytes(proj) == before


def test_stale_and_missing_together_name_both(proj, monkeypatch):
    _start(monkeypatch)
    resp = _put({"name": "x", "status": "final"}, read={"name": "000000000000"})
    assert resp.status_code == 409
    d = resp.json()["detail"]
    assert (d["stale"], d["missing"]) == (["name"], ["status"])
    assert d["message"].startswith("name, status changed since you read it (you or the user edited it, "
                                   "or Montaj updated it) (you never read status), so nothing was saved")


def test_a_stale_field_beside_a_fresh_one_refuses_the_whole_write(proj, monkeypatch):
    _start(monkeypatch)
    read = {**_revs(proj, "name"), "status": revision_of("final")}
    before = _bytes(proj)
    resp = _put({"name": "second", "status": "pending"}, read=read)
    assert resp.status_code == 409
    assert resp.json()["detail"]["stale"] == ["status"]
    assert _bytes(proj) == before


def test_read_for_a_field_the_body_does_not_change_is_ignored(proj, monkeypatch):
    _start(monkeypatch)
    resp = _put({"name": "second"}, read={**_revs(proj, "name"), "tracks": "000000000000"})
    assert resp.status_code == 200, resp.text


def test_a_null_that_clears_a_field_is_compared_too(proj, monkeypatch):
    _start(monkeypatch)
    before = _bytes(proj)
    assert _put({"notes": None}, read={"notes": revision_of([])}).status_code == 409
    assert _bytes(proj) == before
    resp = _put({"notes": None}, read=_revs(proj, "notes"))
    assert resp.status_code == 200
    assert "notes" not in _disk(proj)
    assert json.loads(resp.headers["x-montaj-revisions"]) == {"notes": revision_of(None)}


def test_id_mismatch_is_still_400_first(proj, monkeypatch):
    _start(monkeypatch)
    resp = _client().put(f"/api/projects/{PID}", json={"id": "other", "name": "x"})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "id_mismatch"


def test_a_hub_template_only_body_needs_no_read(proj, monkeypatch):
    _start(monkeypatch)
    resp = _put({"hubTemplate": {"id": "t1"}})
    assert resp.status_code == 200, resp.text
    assert _disk(proj)["hubTemplate"] == {"id": "t1"}
    assert json.loads(resp.headers["x-montaj-revisions"]) == {"hubTemplate": revision_of({"id": "t1"})}
    assert _put({"hubTemplate": {"id": "t2"}, "name": "x"}).status_code == 400


def test_report_keys_in_the_body_are_not_fields(proj, monkeypatch):
    _start(monkeypatch)
    resp = _put({"name": "second", "copied": [], "warnings": []}, read=_revs(proj, "name"))
    assert resp.status_code == 200, resp.text


def test_a_legacy_tracks_project_is_compared_in_its_normalised_form(proj, monkeypatch):
    _start(monkeypatch)
    legacy = {**_base(), "tracks": [[{"id": "c1", "type": "image", "src": "/x.png", "start": 0, "end": 1}]]}
    write_json_atomic(proj / "project.json", legacy)
    before = _bytes(proj)
    raw_rev = {"tracks": revision_of(legacy["tracks"])}
    assert _put({"tracks": normalize_tracks(legacy)["tracks"]}, read=raw_rev).status_code == 409
    assert _bytes(proj) == before
    norm_rev = {"tracks": revision_of(normalize_tracks(legacy)["tracks"])}
    resp = _put({"tracks": normalize_tracks(legacy)["tracks"]}, read=norm_rev)
    assert resp.status_code == 200, resp.text


# ── who may ask for what ───────────────────────────────────────────────────────

@pytest.mark.parametrize("shell", [None, OTHER, ""])
def test_forged_editor_or_advisory_without_the_secret_stays_strict(proj, monkeypatch, shell):
    _start(monkeypatch)
    before = _bytes(proj)
    headers = {"x-montaj-writer": "editor", "x-montaj-guard": "advisory"}
    if shell is not None:
        headers["x-montaj-shell"] = shell
    assert _put({"name": "x"}, headers=headers).status_code == 400
    assert _put({"name": "x"}, read={"name": "000000000000"}, headers=headers).status_code == 409
    assert _bytes(proj) == before


def test_without_a_received_secret_the_guard_is_off_for_the_process(proj, monkeypatch):
    """No secret means the shell's launch went wrong: serve steps aside (the shell's own guard
    still runs) rather than refuse the window's saves as ai."""
    _start(monkeypatch, secret=None)
    headers = {"x-montaj-writer": "editor", "x-montaj-guard": "advisory", "x-montaj-shell": ""}
    resp = _put({"name": "x"}, headers=headers)
    assert resp.status_code == 200
    assert _guard_headers(resp) == {}
    assert not save_guard.secret_valid("")


@pytest.mark.parametrize("writer", ["ai", "tool", "bogus"])
def test_ai_and_tool_with_the_secret_are_strict_even_asking_advisory(proj, monkeypatch, writer):
    _start(monkeypatch)
    headers = {"x-montaj-shell": SECRET, "x-montaj-writer": writer, "x-montaj-guard": "advisory"}
    assert _put({"name": "x"}, read={"name": "000000000000"}, headers=headers).status_code == 409


def test_editor_with_the_secret_but_strict_mode_is_strict(proj, monkeypatch):
    _start(monkeypatch)
    headers = {"x-montaj-shell": SECRET, "x-montaj-writer": "editor", "x-montaj-guard": "strict"}
    assert _put({"name": "x"}, read={"name": "000000000000"}, headers=headers).status_code == 409


def test_advisory_editor_with_the_secret_applies_and_logs_the_override_once(proj, monkeypatch, capsys):
    _start(monkeypatch)
    headers = {"x-montaj-shell": SECRET, "x-montaj-writer": "editor", "x-montaj-guard": "advisory"}
    capsys.readouterr()
    resp = _put({"name": "x", "status": "final", "sources": []},
                read={"name": "000000000000", **_revs(proj, "sources")}, headers=headers)
    assert resp.status_code == 200, resp.text
    # status was never read: a save with no read is not an override, so only the stale name counts.
    assert resp.headers["x-montaj-overrode"] == "name"
    assert _disk(proj)["name"] == "x" and _disk(proj)["status"] == "final"
    out = capsys.readouterr()
    lines = [l for l in (out.out + out.err).splitlines() if l.startswith("save-guard:")]
    assert lines == ["save-guard: advisory override editor fields=name"]


def test_advisory_editor_with_no_read_applies_and_overrides_nothing(proj, monkeypatch, capsys):
    _start(monkeypatch)
    headers = {"x-montaj-shell": SECRET, "x-montaj-writer": "editor", "x-montaj-guard": "advisory"}
    capsys.readouterr()
    resp = _put({"name": "x", "status": "final"}, headers=headers)
    assert resp.status_code == 200, resp.text
    assert "x-montaj-overrode" not in resp.headers
    assert _disk(proj)["name"] == "x"
    out = capsys.readouterr()
    assert "save-guard:" not in out.out + out.err


def test_advisory_editor_with_fresh_revisions_overrides_nothing(proj, monkeypatch, capsys):
    _start(monkeypatch)
    headers = {"x-montaj-shell": SECRET, "x-montaj-writer": "editor", "x-montaj-guard": "advisory"}
    capsys.readouterr()
    resp = _put({"name": "x"}, read=_revs(proj, "name"), headers=headers)
    assert resp.status_code == 200
    assert "x-montaj-overrode" not in resp.headers
    out = capsys.readouterr()
    assert "save-guard:" not in out.out + out.err


# ── media copy: the answer's revisions are the final document's ───────────────

def test_a_copy_patch_that_lands_in_time_is_in_the_answer_revisions(proj, monkeypatch):
    _start(monkeypatch)
    patched_sources = [{"id": "s1", "src": "/copied.mp4"}]
    monkeypatch.setattr(projects_mod, "_plan_save_media", lambda *a: ({"k": "/borrowed.mp4"}, {}))

    async def fake_copy(project_id, project_dir, previous, wanted, also, broadcaster, follow_ups, on_late=None):
        read = (project_dir / "project.json").read_text()
        doc = json.loads(read)
        doc["sources"] = patched_sources
        write_json_atomic(project_dir / "project.json", doc)
        return doc, {"copied": ["/borrowed.mp4"], projects_mod._PATCH_READ_KEY: read}
    monkeypatch.setattr(projects_mod, "_copy_and_patch_media", fake_copy)
    resp = _put({"name": "second"}, read=_revs(proj, "name"))
    assert resp.status_code == 200, resp.text
    revs = json.loads(resp.headers["x-montaj-revisions"])
    assert revs == {"name": revision_of("second"), "sources": revision_of(patched_sources)}
    assert resp.headers["x-montaj-revisions-final"] == "1"


def _real_copy_with(monkeypatch, during_copy):
    """The real copy and patch, with the copy itself and the swap faked: during_copy runs
    in the copy thread (where a concurrent writer can land), then sources is repointed."""
    monkeypatch.setattr(projects_mod, "_plan_save_media", lambda *a: ({"k": "/borrowed.mp4"}, {}))

    def fake_copy(wanted, project_dir):
        during_copy(project_dir)
        return {"k": "/copied.mp4"}, []

    def fake_apply(previous, project, made, also=()):
        project["sources"] = [{"id": "s1", "src": "/copied.mp4"}]
        return [{"from": "/borrowed.mp4", "to": "/copied.mp4"}]
    monkeypatch.setattr(projects_mod, "copy_borrowed_media", fake_copy)
    monkeypatch.setattr(projects_mod, "apply_borrowed_media", fake_apply)


def test_a_copy_patch_over_a_write_that_landed_mid_copy_answers_the_saves_own_revisions(proj, monkeypatch):
    """The patch re-reads project.json. A human edit that landed during the copy is in what
    it re-read, so the answer must not hand those revisions to the AI as if it had seen them."""
    _start(monkeypatch)

    def human_writes(project_dir):
        path = project_dir / "project.json"
        with project_lock(path):
            doc = json.loads(path.read_text())
            doc["status"] = "final"
            write_json_atomic(path, doc)
    _real_copy_with(monkeypatch, human_writes)
    resp = _put({"name": "second"}, read=_revs(proj, "name"))
    assert resp.status_code == 200, resp.text
    assert _disk(proj)["status"] == "final" and _disk(proj)["sources"] == [{"id": "s1", "src": "/copied.mp4"}]
    revs = json.loads(resp.headers["x-montaj-revisions"])
    saved = {**_base(), "name": "second"}
    assert revs == revisions_of(saved, list(revs)) and "name" in revs
    assert resp.headers["x-montaj-revisions-final"] == "0"
    assert "_patchRead" not in resp.json()
    before = _bytes(proj)
    again = _put({"status": "draft"}, read={**revs, "status": revision_of("draft")})
    assert again.status_code == 409, again.text
    assert again.json()["detail"]["stale"] == ["status"]
    assert _bytes(proj) == before


def test_a_copy_patch_with_nothing_landing_mid_copy_answers_the_patched_revisions(proj, monkeypatch):
    _start(monkeypatch)
    _real_copy_with(monkeypatch, lambda project_dir: None)
    resp = _put({"name": "second"}, read=_revs(proj, "name"))
    assert resp.status_code == 200, resp.text
    revs = json.loads(resp.headers["x-montaj-revisions"])
    assert revs == {"name": revision_of("second"), "sources": revision_of([{"id": "s1", "src": "/copied.mp4"}])}
    assert resp.headers["x-montaj-revisions-final"] == "1"
    assert _put({"sources": []}, read=revs).status_code == 200


def test_a_copy_still_pending_marks_the_revisions_not_final(proj, monkeypatch):
    _start(monkeypatch)
    monkeypatch.setattr(projects_mod, "_plan_save_media", lambda *a: ({"k": "/borrowed.mp4"}, {}))

    async def fake_copy(project_id, project_dir, previous, wanted, also, broadcaster, follow_ups, on_late=None):
        on_late()
        return None, {"warnings": ["still copying"]}
    monkeypatch.setattr(projects_mod, "_copy_and_patch_media", fake_copy)
    resp = _put({"name": "second"}, read=_revs(proj, "name"))
    assert resp.status_code == 200, resp.text
    assert resp.headers["x-montaj-revisions-final"] == "0"
    assert json.loads(resp.headers["x-montaj-revisions"]) == {"name": revision_of("second")}


def test_a_copy_late_path_calls_on_late(tmp_path, monkeypatch):
    """The real `_copy_and_patch_media`: past the wait, it says the copy is still pending."""
    import asyncio
    monkeypatch.setattr(projects_mod, "_SAVE_COPY_WAIT_SECONDS", 0.05)

    def slow_copy(wanted, project_dir):
        time.sleep(0.3)
        return {}, []
    monkeypatch.setattr(projects_mod, "copy_borrowed_media", slow_copy)
    d = tmp_path / "p"
    d.mkdir()
    write_json_atomic(d / "project.json", {"id": "p"})
    late = []

    async def main():
        out = await projects_mod._copy_and_patch_media(
            "p", d, {}, {"k": "/b"}, (), _StubBroadcaster(), False, on_late=lambda: late.append(1))
        await asyncio.sleep(0.5)
        return out
    patched, report = asyncio.run(main())
    assert patched is None and late == [1]


# ── GET ?fields ─────────────────────────────────────────────────────────────────

def test_get_answers_revisions_for_the_fields_asked_and_the_body_is_unchanged(proj, monkeypatch):
    _start(monkeypatch)
    c = _client()
    whole = c.get(f"/api/projects/{PID}")
    some = c.get(f"/api/projects/{PID}?fields=name,status,missing")
    assert whole.json() == some.json()
    assert json.loads(some.headers["x-montaj-revisions"]) == revisions_of(some.json(), ["name", "status", "missing"])
    assert json.loads(whole.headers["x-montaj-revisions"]) == revisions_of(whole.json())


def test_get_revisions_after_a_legacy_open_are_the_normalised_ones(proj, monkeypatch):
    _start(monkeypatch)
    legacy = {**_base(), "tracks": [[{"id": "c1", "type": "image", "src": "/x.png", "start": 0, "end": 1}]]}
    write_json_atomic(proj / "project.json", legacy)
    resp = _client().get(f"/api/projects/{PID}?fields=tracks")
    assert json.loads(resp.headers["x-montaj-revisions"]) == {
        "tracks": revision_of(normalize_tracks(legacy)["tracks"])}


def test_get_then_put_round_trips(proj, monkeypatch):
    _start(monkeypatch)
    c = _client()
    read = json.loads(c.get(f"/api/projects/{PID}?fields=name").headers["x-montaj-revisions"])
    put = _put({"name": "second"}, read=read, client=c)
    assert put.status_code == 200
    again = _put({"name": "third"}, read=json.loads(put.headers["x-montaj-revisions"]), client=c)
    assert again.status_code == 200


# ── races (matrix item 3) ──────────────────────────────────────────────────────

def test_a_strict_put_loses_to_a_writer_that_took_the_lock_first(proj, monkeypatch):
    _start(monkeypatch)
    read = _revs(proj, "name")
    path = proj / "project.json"
    held, results = threading.Event(), {}

    def step_writer():
        with project_lock(path):
            held.set()
            time.sleep(0.3)   # the PUT arrives and waits for the lock
            doc = json.loads(path.read_text())
            doc["name"] = "by the step"
            write_json_atomic(path, doc)

    def put():
        results["put"] = _put({"name": "by the ai"}, read=read)

    w = threading.Thread(target=step_writer)
    w.start()
    held.wait()
    p = threading.Thread(target=put)
    p.start()
    w.join()
    p.join()
    assert results["put"].status_code == 409
    assert _disk(proj)["name"] == "by the step"


def test_two_puts_with_the_same_revision_exactly_one_wins(proj, monkeypatch):
    _start(monkeypatch)
    for round_ in range(5):
        read = _revs(proj, "name")
        go, results = threading.Barrier(2), []

        def put(n):
            c = _client()
            go.wait()
            results.append((n, _put({"name": f"r{round_}-{n}"}, read=read, client=c).status_code))

        threads = [threading.Thread(target=put, args=(n,)) for n in (1, 2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        codes = sorted(code for _, code in results)
        assert codes == [200, 409], results
        winner = next(n for n, code in results if code == 200)
        assert _disk(proj)["name"] == f"r{round_}-{winner}"


def test_the_revision_moves_after_every_write(proj, monkeypatch):
    """The cache is keyed by file content: a write between two reads is never answered
    from the old version."""
    _start(monkeypatch)
    c = _client()
    r1 = c.get(f"/api/projects/{PID}?fields=name").headers["x-montaj-revisions"]
    doc = _disk(proj)
    doc["name"] = "outside"
    write_json_atomic(proj / "project.json", doc)
    r2 = c.get(f"/api/projects/{PID}?fields=name").headers["x-montaj-revisions"]
    assert r1 != r2
    assert _put({"name": "x"}, read=json.loads(r1), client=c).status_code == 409


# ── the revision cache after a save (only changed fields are hashed again) ────────

def _counting(monkeypatch):
    """Count revision_of calls per top-level value (by equality to the document's)."""
    from lib import project_revisions as pr
    calls = []
    real = pr.revision_of

    def counted(value):
        calls.append(value)
        return real(value)
    monkeypatch.setattr(pr, "revision_of", counted)
    return calls


def test_a_save_reuses_the_revisions_of_the_fields_it_did_not_change(proj, monkeypatch):
    _start(monkeypatch)
    from lib import project_revisions as pr
    big = [{"id": "trk-0", "items": [{"id": f"c{i}", "type": "image", "src": f"/x{i}.png", "start": i, "end": i + 1}
                                     for i in range(200)]}]
    write_json_atomic(proj / "project.json", {**_base(), "tracks": big})
    pr.clear_cache()
    calls = _counting(monkeypatch)
    c = _client()
    read = json.loads(c.get(f"/api/projects/{PID}?fields=tracks,name").headers["x-montaj-revisions"])
    assert sum(1 for v in calls if v == big) == 1
    put = _put({"name": "second"}, read={"name": read["name"]}, client=c)
    assert put.status_code == 200, put.text
    again = json.loads(c.get(f"/api/projects/{PID}?fields=tracks,name,status").headers["x-montaj-revisions"])
    # The save changed name only: tracks is never hashed again, here or in the next check.
    assert sum(1 for v in calls if v == big) == 1
    assert _put({"tracks": big, "status": "final"},
                read={"tracks": again["tracks"], "status": again["status"]}, client=c).status_code == 200
    assert sum(1 for v in calls if v == big) == 2           # tracks was in the body: hashed once more
    disk = normalize_tracks(_disk(proj))
    final = json.loads(c.get(f"/api/projects/{PID}").headers["x-montaj-revisions"])
    pr.clear_cache()
    assert final == revisions_of(disk) and again["tracks"] == revision_of(big) == final["tracks"]
    assert again == revisions_of({**_base(), "tracks": big, "name": "second"}, ["tracks", "name", "status"])


# ── G-2: an advisory editor write with no read reports what it changed of another writer's (§482) ──

EDITOR = {"x-montaj-shell": SECRET, "x-montaj-writer": "editor", "x-montaj-guard": "advisory"}
TOOL = {"x-montaj-shell": SECRET, "x-montaj-writer": "tool"}
# Marks are set only by the app's Studio sync pull: a trusted tool write naming origin sync.
SYNC = {**TOOL, "x-montaj-write-origin": "sync"}
UNREAD = "x-montaj-unread"
OVERRODE = "x-montaj-overrode"


def _tool_put(proj, body, client=None):
    resp = _put(body, read=_revs(proj, *body), headers=SYNC, client=client)
    assert resp.status_code == 200, resp.text
    return resp


def test_a_readless_editor_write_that_changes_a_field_the_tool_wrote_reports_it_and_applies(proj, monkeypatch, capsys):
    _start(monkeypatch)
    tool = _tool_put(proj, {"name": "pulled"})
    assert UNREAD not in tool.headers
    capsys.readouterr()
    resp = _put({"name": "stale view"}, headers=EDITOR)
    assert resp.status_code == 200, resp.text
    assert resp.headers[UNREAD] == "name"
    assert OVERRODE not in resp.headers
    assert _disk(proj)["name"] == "stale view"
    assert json.loads(resp.headers["x-montaj-revisions"]) == {"name": revision_of("stale view")}
    out = capsys.readouterr()
    lines = [l for l in (out.out + out.err).splitlines() if l.startswith("save-guard:")]
    assert lines == ["save-guard: advisory unread editor fields=name"]


def test_a_readless_editor_write_that_leaves_the_tools_value_reports_nothing_for_it(proj, monkeypatch):
    """A whole-document writer sends every field: a field merely present, with the tool's value, is not named."""
    _start(monkeypatch)
    _tool_put(proj, {"name": "pulled", "status": "final"})
    resp = _put({**_disk(proj), "status": "draft"}, headers=EDITOR)
    assert resp.status_code == 200, resp.text
    assert resp.headers[UNREAD] == "status"
    assert _disk(proj)["name"] == "pulled" and _disk(proj)["status"] == "draft"


def test_a_readless_editor_write_that_changes_only_fields_the_tool_left_alone_reports_nothing(proj, monkeypatch):
    _start(monkeypatch)
    _tool_put(proj, {"name": "pulled", "status": "draft"})   # status sent with its own value: not changed
    resp = _put({**_disk(proj), "status": "final", "notes": []}, headers=EDITOR)
    assert resp.status_code == 200, resp.text
    assert UNREAD not in resp.headers and OVERRODE not in resp.headers


def test_with_no_prior_guarded_write_a_readless_editor_write_reports_nothing(proj, monkeypatch):
    _start(monkeypatch)
    resp = _put({"name": "x", "status": "final"}, headers=EDITOR)
    assert resp.status_code == 200, resp.text
    assert UNREAD not in resp.headers


def test_a_change_written_outside_the_guard_is_not_a_guarded_write(proj, monkeypatch):
    _start(monkeypatch)
    doc = _disk(proj)
    doc["name"] = "by a step"
    write_json_atomic(proj / "project.json", doc)
    resp = _put({"name": "x"}, headers=EDITOR)
    assert resp.status_code == 200, resp.text
    assert UNREAD not in resp.headers


def test_once_the_file_no_longer_holds_the_tools_value_nothing_is_reported(proj, monkeypatch):
    """A step rewrote the field after the tool: the tool's value is gone, so the editor overwrote the step's."""
    _start(monkeypatch)
    _tool_put(proj, {"name": "pulled"})
    doc = _disk(proj)
    doc["name"] = "by a step"
    write_json_atomic(proj / "project.json", doc)
    resp = _put({"name": "x"}, headers=EDITOR)
    assert resp.status_code == 200, resp.text
    assert UNREAD not in resp.headers


def test_a_field_is_reported_once_then_the_editors_own_value_is_its_to_change(proj, monkeypatch):
    _start(monkeypatch)
    _tool_put(proj, {"name": "pulled"})
    assert _put({"name": "a"}, headers=EDITOR).headers[UNREAD] == "name"
    again = _put({"name": "b"}, headers=EDITOR)
    assert again.status_code == 200 and UNREAD not in again.headers
    _tool_put(proj, {"name": "pulled again"})
    assert _put({"name": "c"}, headers=EDITOR).headers[UNREAD] == "name"


def test_a_tracks_change_is_reported_as_tracks(proj, monkeypatch):
    _start(monkeypatch)
    pulled = [{"id": "trk-0", "items": [{"id": "c1", "type": "image", "src": "/a.png", "start": 0, "end": 1},
                                        {"id": "c2", "type": "image", "src": "/b.png", "start": 1, "end": 2}]}]
    _tool_put(proj, {"tracks": pulled})
    mine = [{"id": "trk-0", "items": [{**pulled[0]["items"][0], "end": 0.5}, pulled[0]["items"][1]]}]
    resp = _put({"tracks": mine}, headers=EDITOR)
    assert resp.status_code == 200, resp.text
    assert resp.headers[UNREAD] == "tracks"
    assert normalize_tracks(_disk(proj))["tracks"] == mine


def test_a_field_sent_with_a_read_beside_an_unread_one_is_judged_by_its_read(proj, monkeypatch):
    _start(monkeypatch)
    _tool_put(proj, {"name": "pulled", "status": "final"})
    resp = _put({"name": "x", "status": "draft"}, read=_revs(proj, "name"), headers=EDITOR)
    assert resp.status_code == 200, resp.text
    assert resp.headers[UNREAD] == "status"
    assert OVERRODE not in resp.headers


def test_editor_writes_with_a_read_behave_as_before_and_take_the_field_over(proj, monkeypatch):
    _start(monkeypatch)
    _tool_put(proj, {"name": "pulled", "status": "final"})
    fresh = _put({"name": "x"}, read=_revs(proj, "name"), headers=EDITOR)
    assert fresh.status_code == 200 and UNREAD not in fresh.headers and OVERRODE not in fresh.headers
    stale = _put({"status": "draft"}, read={"status": "000000000000"}, headers=EDITOR)
    assert stale.status_code == 200 and stale.headers[OVERRODE] == "status" and UNREAD not in stale.headers
    # Both fields were the editor's to write from then on: a later write with no read names neither.
    later = _put({"name": "y", "status": "pending"}, headers=EDITOR)
    assert later.status_code == 200 and UNREAD not in later.headers


def test_non_editor_writers_never_answer_unread(proj, monkeypatch):
    _start(monkeypatch)
    _tool_put(proj, {"name": "pulled"})
    ai = _put({"name": "by the ai"}, read=_revs(proj, "name"))
    assert ai.status_code == 200 and UNREAD not in ai.headers
    assert _put({"name": "x"}, headers=SYNC).status_code == 400
    assert _put({"name": "x"}).status_code == 400


def test_an_ai_write_and_a_plain_tool_write_set_no_marks(proj, monkeypatch):
    """Narrowed (sync only): only a trusted tool write with origin sync marks fields."""
    _start(monkeypatch)
    assert _put({"name": "by the ai"}, read=_revs(proj, "name")).status_code == 200
    assert UNREAD not in _put({"name": "x"}, headers=EDITOR).headers
    assert _put({"status": "final"}, read=_revs(proj, "status"), headers=TOOL).status_code == 200
    assert UNREAD not in _put({"status": "draft"}, headers=EDITOR).headers


def test_a_forged_sync_origin_sets_no_marks(proj, monkeypatch):
    _start(monkeypatch)
    forged = {"x-montaj-writer": "tool", "x-montaj-write-origin": "sync"}
    wrong = {"x-montaj-shell": "a1" * 32, **forged}
    for headers in (forged, wrong):
        assert _put({"name": "forged"}, read=_revs(proj, "name"), headers=headers).status_code == 200
        assert UNREAD not in _put({"name": "x"}, headers=EDITOR).headers


def test_a_trusted_ai_write_naming_sync_sets_no_marks(proj, monkeypatch):
    _start(monkeypatch)
    ai_sync = {"x-montaj-shell": SECRET, "x-montaj-writer": "ai", "x-montaj-write-origin": "sync"}
    assert _put({"name": "ai"}, read=_revs(proj, "name"), headers=ai_sync).status_code == 200
    assert UNREAD not in _put({"name": "x"}, headers=EDITOR).headers


def test_a_refused_tool_write_records_nothing(proj, monkeypatch):
    _start(monkeypatch)
    assert _put({"name": "pulled"}, read={"name": "000000000000"}, headers=SYNC).status_code == 409
    resp = _put({"name": "x"}, headers=EDITOR)
    assert resp.status_code == 200 and UNREAD not in resp.headers


def test_a_hub_template_change_is_never_reported(proj, monkeypatch):
    _start(monkeypatch)
    assert _put({"hubTemplate": {"id": "t1"}}, headers=SYNC).status_code == 200
    resp = _put({"hubTemplate": {"id": "t2"}, "name": "x"}, headers=EDITOR)
    assert resp.status_code == 200 and UNREAD not in resp.headers


def test_without_the_guard_nothing_is_recorded_or_reported(proj, monkeypatch):
    _start(monkeypatch, guard=False)
    _put({"name": "pulled"}, headers=SYNC)
    resp = _put({"name": "x"}, headers=EDITOR)
    assert resp.status_code == 200 and _guard_headers(resp) == {}


def test_reporting_an_unread_field_hashes_nothing_more(proj, monkeypatch):
    """The report compares the revisions the guard already computes: tracks is hashed once per write
    that carries it (the body's value, for the answer), never for the comparison."""
    _start(monkeypatch)
    from lib import project_revisions as pr
    big = [{"id": "trk-0", "items": [{"id": f"c{i}", "type": "image", "src": f"/x{i}.png", "start": i, "end": i + 1}
                                     for i in range(200)]}]
    mine = [{"id": "trk-0", "items": big[0]["items"][:-1]}]
    pr.clear_cache()
    calls = _counting(monkeypatch)
    c = _client()
    _tool_put(proj, {"tracks": big}, client=c)
    assert sum(1 for v in calls if v == big) == 1
    resp = _put({"tracks": mine}, headers=EDITOR, client=c)
    assert resp.status_code == 200 and resp.headers[UNREAD] == "tracks"
    assert sum(1 for v in calls if v == big) == 1
    assert sum(1 for v in calls if v == mine) == 1
