"""§477: the caption translation route compares the `captions` revision a request read
(x-montaj-read-revisions) under the project lock when the engine guard is on. Without that
revision, today's source-words check stays the guard; a request never has to send it."""
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


def _request(read=None):
    headers = {} if read is None else {"x-montaj-read-revisions": json.dumps(read)}
    return SimpleNamespace(headers=headers, app=SimpleNamespace(state=SimpleNamespace(broadcaster=Mock())))


def _translate(d, body, read=None):
    return asyncio.run(caption_translation(PID, body=body, request=_request(read), project_dir=d))


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


def test_no_read_keeps_todays_behaviour(guard, tmp_path):
    guard(True)
    d, path, _ = _setup(tmp_path)
    doc = json.loads(path.read_text())
    doc["captions"]["style"] = "pop"
    path.write_text(json.dumps(doc))
    assert _translate(d, {"lang": "es", "phrases": PHRASES})["phrases"] == 2


def test_a_read_without_captions_is_not_required(guard, tmp_path):
    guard(True)
    d, _, _ = _setup(tmp_path)
    assert _translate(d, {"lang": "es", "phrases": PHRASES}, {"name": "000000000000"})["phrases"] == 2


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
