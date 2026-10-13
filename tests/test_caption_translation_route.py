"""§244 wiring: POST /projects/{id}/captions/translation, and both caption
regeneration paths (the SSE route's pipeline and the generate_captions step)
keeping a translated row."""
import asyncio
import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

import serve.routes.projects as projects_mod
from serve.routes.projects import _run_caption_pipeline, caption_translation
from tests.test_generate_captions import _FakeBroadcaster, _audible_project, _load_step_module, _patch_caption_subprocess

PID = "24424424-4244-4244-8244-244244244244"


def W(word, start, end):
    return {"word": word, "start": start, "end": end}


def seg(words):
    return {"text": " ".join(w["word"] for w in words), "start": words[0]["start"], "end": words[-1]["end"], "words": words}


WORDS_A = [W("So", 0.0, 0.1), W("an", 0.1, 0.3), W("example,", 0.3, 0.8), W("you", 0.8, 0.9)]
WORDS_B = [W("can't", 0.9, 1.1), W("develop", 1.1, 1.6), W("wheels.", 1.6, 2.0)]
PHRASES = [{"source": "So an example,", "text": "Por ejemplo,"},
           {"source": "you can't develop wheels.", "text": "no se pueden desarrollar ruedas."}]


def _project_dir(tmp_path, captions):
    d = tmp_path / "proj"
    d.mkdir()
    (d / "project.json").write_text(json.dumps(_audible_project(id=PID, captions=captions)))
    return d


def _request():
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(broadcaster=Mock())))


@pytest.fixture(autouse=True)
def _clean():
    projects_mod._active_caption_jobs.clear()
    yield
    projects_mod._active_caption_jobs.clear()


def _translate(d, body, request=None):
    return asyncio.run(caption_translation(PID, body=body, request=request or _request(), project_dir=d))


def test_route_writes_the_row_and_tells_an_open_editor(tmp_path):
    d = _project_dir(tmp_path, {"style": "subtitle", "segments": [seg(WORDS_A), seg(WORDS_B)]})
    request = _request()
    answer = _translate(d, {"lang": "es", "phrases": PHRASES}, request)
    assert (answer["lang"], answer["lane"], answer["phrases"]) == ("es", 1, 2)
    saved = json.loads((d / "project.json").read_text())["captions"]
    assert saved == answer["captions"]
    es = [s for s in saved["segments"] if s.get("lang") == "es"]
    assert [s["text"] for s in es] == ["Por ejemplo,", "no se pueden desarrollar ruedas."]
    assert request.app.state.broadcaster.publish.call_count == 1


def test_route_refusal_is_a_400_with_the_code_and_writes_nothing(tmp_path):
    d = _project_dir(tmp_path, {"style": "subtitle", "segments": [seg(WORDS_A), seg(WORDS_B)]})
    before = (d / "project.json").read_text()
    with pytest.raises(HTTPException) as e:
        _translate(d, {"lang": "es", "phrases": PHRASES[:1]})
    assert e.value.status_code == 400 and e.value.detail["error"] == "incomplete"
    assert (d / "project.json").read_text() == before


def test_route_waits_for_a_running_caption_job(tmp_path):
    d = _project_dir(tmp_path, {"style": "subtitle", "segments": [seg(WORDS_A), seg(WORDS_B)]})
    projects_mod._active_caption_jobs.add(PID)
    with pytest.raises(HTTPException) as e:
        _translate(d, {"lang": "es", "phrases": PHRASES})
    assert e.value.status_code == 409


def _translated_captions():
    from lib.caption_translation import apply_translation
    return apply_translation({"style": "subtitle", "fontFamily": "Inter", "segments": [seg(WORDS_A), seg(WORDS_B)]}, "es", PHRASES)


def _assert_kept(captions):
    src = [s for s in captions["segments"] if not s.get("lane")]
    es = [s for s in captions["segments"] if s.get("lang") == "es"]
    assert [s["text"] for s in src] == ["So an example,", "you can't develop wheels."]
    assert [s["text"] for s in es] == ["Por ejemplo,", "no se pueden desarrollar ruedas."]
    assert [t["translationOf"] for t in es] == [[s["id"]] for s in src]
    assert captions["fontFamily"] == "Inter"


def test_sse_pipeline_keeps_the_translated_row(tmp_path, monkeypatch):
    _patch_caption_subprocess(monkeypatch)
    d = tmp_path / "proj"
    d.mkdir()
    (d / "_caption_track.json").write_text(json.dumps({"style": "subtitle", "segments": [seg(WORDS_A), seg(WORDS_B)]}))
    track = asyncio.run(_run_caption_pipeline(
        PID, d, _audible_project(captions=_translated_captions()),
        model="base.en", language="auto", style="subtitle", broadcaster=_FakeBroadcaster(),
    ))
    _assert_kept(track)
    _assert_kept(json.loads((d / "project.json").read_text())["captions"])


def test_generate_captions_step_keeps_the_translated_row_and_the_whole_theme(tmp_path, monkeypatch, capsys):
    mod = _load_step_module()
    d = tmp_path / "proj"
    d.mkdir()
    (d / "project.json").write_text(json.dumps(_audible_project(captions=_translated_captions())))

    def fake_run(cmd, **kwargs):
        if cmd[1].endswith("caption.py"):
            out = cmd[cmd.index("--out") + 1]
            with open(out, "w") as f:
                json.dump({"style": "subtitle", "segments": [seg(WORDS_A), seg(WORDS_B)]}, f)

    monkeypatch.setattr(mod, "run", fake_run)
    monkeypatch.setattr(mod, "require_whisper_model", lambda *a: None)
    monkeypatch.setattr(mod, "build_audio_mix_spec", lambda project: {"inputs": []})
    monkeypatch.setattr(mod, "get_project_dir", lambda pid: d)
    monkeypatch.setattr(sys, "argv", ["generate_captions.py", "--project-id", PID])
    mod.main()
    _assert_kept(json.loads((d / "project.json").read_text())["captions"])
    _assert_kept(json.loads(capsys.readouterr().out))
