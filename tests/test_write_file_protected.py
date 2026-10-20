"""POST /api/files never writes a project's own project.json, its temp file or its lock
file (§477): those go through save_project, which takes the lock and compares revisions.
Always, guard on or off."""
import json
import os

import pytest
from starlette.testclient import TestClient

from serve import save_guard
from serve.server import app


@pytest.fixture(params=["off", "on"])
def ws(tmp_path, monkeypatch, request):
    saved = dict(save_guard._state)
    if request.param == "on":
        monkeypatch.setenv("MONTAJ_ENGINE_GUARD", "1")
    else:
        monkeypatch.delenv("MONTAJ_ENGINE_GUARD", raising=False)
    monkeypatch.delenv("MONTAJ_SHELL_SECRET_STDIN", raising=False)
    save_guard._inject_secret_for_tests("5e" * 32)
    save_guard.startup()
    ws = (tmp_path / "ws").resolve()
    (ws / "proj").mkdir(parents=True)
    (ws / "proj" / "project.json").write_text('{"id": "proj"}')
    monkeypatch.setattr("serve.routes.files.resolve_workspace", lambda: ws)
    yield ws
    save_guard._state.clear()
    save_guard._state.update(saved)


def _write(path, content="{}"):
    return TestClient(app, raise_server_exceptions=False).post(
        "/api/files", json={"path": str(path), "content": content})


@pytest.mark.parametrize("name", [
    "project.json", "Project.JSON", "project.json.", "project.json. . ", "project.json ",
    "project.json.tmp", "PROJECT.JSON.TMP", ".project.lock", ".Project.Lock.",
])
def test_protected_names_are_refused_and_nothing_is_written(ws, name):
    target = ws / "proj" / name
    before = {p.name: p.read_bytes() for p in (ws / "proj").iterdir()}
    resp = _write(target, '{"id": "evil"}')
    print("WIRE write_file:", resp.text)
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["error"] == "project_file_protected"
    assert "save_project" in detail["message"]
    assert {p.name: p.read_bytes() for p in (ws / "proj").iterdir()} == before


def test_a_new_project_json_in_a_new_folder_is_refused_too(ws):
    resp = _write(ws / "fresh" / "project.json")
    assert resp.status_code == 400
    assert not (ws / "fresh").exists()


def test_a_symlink_to_project_json_is_refused_by_its_resolved_path(ws):
    link = ws / "proj" / "notes.txt"
    os.symlink(ws / "proj" / "project.json", link)
    resp = _write(link, '{"id": "evil"}')
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "project_file_protected"
    assert json.loads((ws / "proj" / "project.json").read_text()) == {"id": "proj"}


def test_a_backslash_path_naming_project_json_is_refused(ws):
    resp = _write(str(ws / "proj") + "\\project.json")
    assert resp.status_code == 400


@pytest.mark.parametrize("name", ["project.json.bak", "my-project.json", "project.jsonx", "overlay.json"])
def test_other_names_still_write(ws, name):
    resp = _write(ws / "proj" / name, "x")
    assert resp.status_code == 200, resp.text
    assert (ws / "proj" / name).read_text() == "x"


# ── aliases a case-folding filesystem lands on the same file (always on) ─────────

LONG_S = "project.jſon"            # LATIN SMALL LETTER LONG S folds to s
KELVIN = ".project.locK"           # KELVIN SIGN folds to k


@pytest.mark.parametrize("name", [
    LONG_S, "PROJECT.JſON", KELVIN, ".PROJECT.LOCK", "project.json․",
    "ｐroject.json", "project.ȷson".replace("ȷ", "j"), "PROJECT.JSON.TMP",
    "project.jſon.tmp",
])
def test_casefold_alias_bypasses_protection(ws, name):
    """The reviewer's case: macOS APFS folds U+017F to s, so project.jſon IS project.json.
    Refused by the NFKC casefold of the name, and by samefile where the alias exists."""
    (ws / "proj" / ".project.lock").write_text("")
    before = {p.name: p.read_bytes() for p in (ws / "proj").iterdir()}
    resp = _write(ws / "proj" / name, '{"id": "proj", "name": "STALE AI"}')
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"]["error"] == "project_file_protected"
    assert {p.name: p.read_bytes() for p in (ws / "proj").iterdir()} == before


def test_a_name_the_filesystem_folds_but_nfkc_does_not_is_refused_by_samefile(ws, monkeypatch):
    """A folding rule NFKC + casefold does not know: the filesystem says it is the same
    file, and that is what counts."""
    import serve.common as common
    monkeypatch.setattr(common, "_norm_name", lambda name: name)   # name rule blind
    pj = ws / "proj" / "project.json"
    alias = ws / "proj" / "alias-of-project.json"
    os.link(pj, alias)                                               # same file, other name
    resp = _write(alias, '{"id": "evil"}')
    assert resp.status_code == 400
    assert json.loads(pj.read_text()) == {"id": "proj"}


@pytest.mark.parametrize("name", ["projıect.json", "PROJİECT.JSON", "project.jsıon"])
def test_turkish_dotted_and_dotless_i_are_other_files(ws, name):
    """Neither protected name has an i, so a dotless or dotted I makes a different file:
    the write lands beside project.json and never on it."""
    resp = _write(ws / "proj" / name, "x")
    assert resp.status_code == 200, resp.text
    assert json.loads((ws / "proj" / "project.json").read_text()) == {"id": "proj"}


@pytest.mark.parametrize("rel", ["sub/../project.json", "sub/../project.jſon", "./sub/../.project.locK"])
def test_dot_dot_paths_are_refused(ws, rel):
    (ws / "proj" / "sub").mkdir()
    resp = _write(str(ws / "proj") + "/" + rel)
    assert resp.status_code == 400
    assert json.loads((ws / "proj" / "project.json").read_text()) == {"id": "proj"}


@pytest.mark.parametrize("tail", ["/..", "/.", "/"])
def test_a_path_that_names_no_file_is_refused(ws, tail):
    resp = _write(str(ws / "proj" / "project.json") + tail)
    assert resp.status_code == 400
    assert json.loads((ws / "proj" / "project.json").read_text()) == {"id": "proj"}


def test_a_symlink_alias_to_project_json_under_a_folded_name_is_refused(ws):
    link = ws / "proj" / "x.txt"
    os.symlink(ws / "proj" / "PROJECT.JſON", link)
    assert _write(link, '{"id": "evil"}').status_code == 400
    assert json.loads((ws / "proj" / "project.json").read_text()) == {"id": "proj"}


# ── DELETE /projects/:id/files never deletes project.json or the lock (always on) ─

@pytest.fixture
def proj_dir(ws):
    from serve.common import get_project_dir
    d = ws / "proj"
    (d / ".project.lock").write_text("")
    (d / "assets").mkdir()
    (d / "assets" / "a.png").write_bytes(b"a")
    os.symlink(d / "project.json", d / "link.json")
    app.dependency_overrides[get_project_dir] = lambda: d
    yield d
    app.dependency_overrides.pop(get_project_dir, None)


def _delete(paths, headers=None):
    return TestClient(app, raise_server_exceptions=False).request(
        "DELETE", "/api/projects/proj/files", json={"paths": paths}, headers=headers or {})


@pytest.mark.parametrize("rel", [
    "project.json", "PROJECT.JSON", LONG_S, ".project.lock", KELVIN, "project.json.tmp",
    "assets/../project.json", "link.json", "./project.json",
])
def test_delete_files_refuses_the_project_file_and_its_lock(proj_dir, monkeypatch, rel):
    from serve import save_guard
    save_guard._inject_secret_for_tests("5e" * 32)
    (proj_dir / "project.json.tmp").write_text("t")
    before = {p.name: p.read_bytes() for p in proj_dir.iterdir() if p.is_file()}
    resp = _delete([rel], headers={"x-montaj-shell": "5e" * 32, "x-montaj-writer": "editor"})
    assert resp.status_code == 207, resp.text
    assert resp.json()["results"] == [{"path": rel, "status": "error", "error": "project_file_protected"}]
    assert {p.name: p.read_bytes() for p in proj_dir.iterdir() if p.is_file()} == before


def test_delete_files_still_deletes_other_files(proj_dir):
    from serve import save_guard
    save_guard._inject_secret_for_tests("5e" * 32)
    resp = _delete(["assets/a.png"], headers={"x-montaj-shell": "5e" * 32, "x-montaj-writer": "editor"})
    assert resp.status_code == 200, resp.text
    assert not (proj_dir / "assets" / "a.png").exists()
