"""§477: the caption translation route compares the `captions` revision a request read
(x-montaj-read-revisions) under the project lock when the engine guard is on. Strict for the
ai and tool writers (a missing captions read is 400 read_required, a stale one 409);
advisory for the window's editor (applied, a stale one logged). Guard off: as before."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

import serve.routes.projects as projects_mod
from lib import project_revisions
from serve import save_guard
from serve.routes.projects import caption_translation
from tests.test_caption_translation_route import PHRASES, PID, WORDS_A, WORDS_B, _project_dir, seg


@pytest.fixture(autouse=True)
def _clean():
    projects_mod._active_caption_jobs.clear()
    yield
    projects_mod._active_caption_jobs.clear()


@pytest.fixture
def guard(monkeypatch):
    def set_on(on):
        monkeypatch.setitem(save_guard._state, "requested", on)
        monkeypatch.setitem(save_guard._state, "canary", "ok")
        monkeypatch.setitem(save_guard._state, "secret", "5e" * 32)
    return set_on


SECRET = "5e" * 32


def _request(read=None, writer=None):
    headers = {} if read is None else {"x-montaj-read-revisions": json.dumps(read)}
    if writer is not None:
        headers.update({"x-montaj-shell": SECRET, "x-montaj-writer": writer})
    return SimpleNamespace(headers=headers, app=SimpleNamespace(state=SimpleNamespace(broadcaster=Mock())))


def _translate(d, body, read=None, writer=None):
    return asyncio.run(caption_translation(PID, body=body, request=_request(read, writer), project_dir=d))


def _setup(tmp_path):
    d = _project_dir(tmp_path, {"style": "subtitle", "segments": [seg(WORDS_A), seg(WORDS_B)]})
    path = d / "project.json"
    return d, path, json.loads(path.read_text())


def test_fresh_read_writes(guard, tmp_path):
    guard(True)
    d, path, project = _setup(tmp_path)
    read = {"captions": project_revisions.revision_of(project["captions"])}
    answer = _translate(d, {"lang": "es", "phrases": PHRASES}, read)
    assert answer["phrases"] == 2
    assert any(s.get("lang") == "es" for s in json.loads(path.read_text())["captions"]["segments"])


def test_stale_read_is_refused_and_nothing_written(guard, tmp_path):
    guard(True)
    d, path, project = _setup(tmp_path)
    read = {"captions": project_revisions.revision_of(project["captions"])}
    doc = json.loads(path.read_text())
    doc["captions"]["style"] = "pop"          # the captions moved after the read
    path.write_text(json.dumps(doc))
    before = path.read_bytes()
    with pytest.raises(HTTPException) as exc:
        _translate(d, {"lang": "es", "phrases": PHRASES}, read)
    assert exc.value.status_code == 409
    assert exc.value.detail == {"error": "project_changed", "stale": ["captions"], "missing": [],
                                "message": save_guard.stale_message(["captions"], [])}
    assert path.read_bytes() == before


@pytest.mark.parametrize("writer", [None, "ai", "tool", "bogus"])
@pytest.mark.parametrize("read", [None, {"name": "000000000000"}, {"captions": ""}])
def test_ai_and_tool_without_a_captions_read_are_refused_read_required(guard, tmp_path, writer, read):
    guard(True)
    d, path, _ = _setup(tmp_path)
    before = path.read_bytes()
    with pytest.raises(HTTPException) as exc:
        _translate(d, {"lang": "es", "phrases": PHRASES}, read, writer)
    assert exc.value.status_code == 400
    detail = exc.value.detail
    assert (detail["error"], detail["stale"], detail["missing"]) == ("read_required", [], ["captions"])
    assert "captions" in detail["message"] and "save_project" not in detail["message"]
    assert path.read_bytes() == before


def test_a_tool_with_a_stale_read_is_refused(guard, tmp_path):
    guard(True)
    d, path, _ = _setup(tmp_path)
    with pytest.raises(HTTPException) as exc:
        _translate(d, {"lang": "es", "phrases": PHRASES}, {"captions": "000000000000"}, "tool")
    assert exc.value.status_code == 409


def test_a_forged_editor_without_the_secret_is_strict(guard, tmp_path):
    guard(True)
    d, path, _ = _setup(tmp_path)
    req = _request()
    req.headers.update({"x-montaj-shell": "a1" * 32, "x-montaj-writer": "editor"})
    with pytest.raises(HTTPException) as exc:
        asyncio.run(caption_translation(PID, body={"lang": "es", "phrases": PHRASES}, request=req, project_dir=d))
    assert exc.value.status_code == 400


def test_the_editor_is_advisory_no_read_applies(guard, tmp_path, capsys):
    guard(True)
    d, path, _ = _setup(tmp_path)
    capsys.readouterr()
    assert _translate(d, {"lang": "es", "phrases": PHRASES}, None, "editor")["phrases"] == 2
    out = capsys.readouterr()
    assert "save-guard:" not in out.out + out.err


def test_the_editor_with_a_stale_read_applies_and_logs_the_override(guard, tmp_path, capsys):
    guard(True)
    d, path, _ = _setup(tmp_path)
    capsys.readouterr()
    assert _translate(d, {"lang": "es", "phrases": PHRASES}, {"captions": "000000000000"}, "editor")["phrases"] == 2
    out = capsys.readouterr()
    lines = [l for l in (out.out + out.err).splitlines() if l.startswith("save-guard:")]
    assert lines == ["save-guard: advisory override editor fields=captions"]


def test_guard_off_needs_no_read(guard, tmp_path):
    guard(False)
    d, path, _ = _setup(tmp_path)
    assert _translate(d, {"lang": "es", "phrases": PHRASES})["phrases"] == 2


def test_guard_off_ignores_a_stale_read(guard, tmp_path):
    guard(False)
    d, path, project = _setup(tmp_path)
    read = {"captions": "000000000000"}
    assert _translate(d, {"lang": "es", "phrases": PHRASES}, read)["phrases"] == 2


def test_show_only_request_is_compared_too(guard, tmp_path):
    guard(True)
    d, path, _ = _setup(tmp_path)
    with pytest.raises(HTTPException) as exc:
        _translate(d, {"show": ["source"]}, {"captions": "000000000000"})
    assert exc.value.status_code == 409
