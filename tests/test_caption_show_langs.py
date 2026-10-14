"""§244: which languages the captions draw (`captions.showLangs`), the source language the captions record
(`captions.lang`), and add_caption_translation's `show`."""
import asyncio
import json
import sys

import pytest
from fastapi import HTTPException

from lib.caption_translation import TranslationError, apply_show, record_source_language, show_new_language
from serve.routes.projects import _run_caption_pipeline
from tests.test_caption_translation_route import (
    PHRASES, PID, WORDS_A, WORDS_B, _project_dir, _translate, seg,
)
from tests.test_generate_captions import _FakeBroadcaster, _audible_project, _load_step_module, _patch_caption_subprocess


def _captions(lang="en", extra=None):
    s0 = {"id": "cap-0", "text": "hello", "start": 0, "end": 2, "words": [{"word": "hello", "start": 0, "end": 1}]}
    es = {"id": "cap-1", "text": "hola", "start": 0, "end": 2, "lane": 1, "lang": "es", "translationOf": ["cap-0"]}
    fr = {"id": "cap-2", "text": "salut", "start": 0, "end": 2, "lane": 2, "lang": "fr", "translationOf": ["cap-0"]}
    c = {"style": "plate", "segments": [s0, es, fr]}
    if lang:
        c["lang"] = lang
    c.update(extra or {})
    return c


class TestApplyShow:
    def test_a_subset_is_stored_in_drawing_order_source_first(self):
        assert apply_show(_captions(), ["fr", "en"])["showLangs"] == ["en", "fr"]
        assert apply_show(_captions(), ["es"])["showLangs"] == ["es"]

    def test_naming_every_language_clears_the_field(self):
        out = apply_show(_captions(extra={"showLangs": ["es"]}), ["en", "es", "fr"])
        assert "showLangs" not in out

    def test_source_is_the_alias_for_the_source_language(self):
        assert apply_show(_captions(), ["source", "fr"])["showLangs"] == ["en", "fr"]
        assert apply_show(_captions(lang=None), ["source"])["showLangs"] == ["source"]

    def test_never_mutates_the_input(self):
        c = _captions()
        apply_show(c, ["es"])
        assert "showLangs" not in c

    @pytest.mark.parametrize("bad, code", [([], "bad_show"), ("es", "bad_show"), ([1], "bad_show"), (None, "bad_show")])
    def test_a_bad_list_is_refused(self, bad, code):
        with pytest.raises(TranslationError) as e:
            apply_show(_captions(), bad)
        assert e.value.code == code

    def test_a_language_the_track_does_not_have_is_refused_naming_what_it_has(self):
        with pytest.raises(TranslationError) as e:
            apply_show(_captions(), ["de"])
        assert e.value.code == "unknown_language"
        assert "en, es, fr" in e.value.message

    def test_no_captions(self):
        with pytest.raises(TranslationError) as e:
            apply_show({"style": "plate", "segments": []}, ["en"])
        assert e.value.code == "no_captions"


class TestRecordSourceLanguage:
    def test_the_requested_code(self):
        assert record_source_language({}, "en")["lang"] == "en"
        assert record_source_language({}, "pt-BR")["lang"] == "pt-BR"

    def test_auto_takes_what_whisper_detected(self, tmp_path):
        p = tmp_path / "w.json"
        p.write_text(json.dumps({"result": {"language": "es"}, "transcription": []}))
        assert record_source_language({}, "auto", p)["lang"] == "es"

    def test_auto_with_nothing_detected_drops_a_stale_language(self, tmp_path):
        assert "lang" not in record_source_language({"lang": "en"}, "auto", tmp_path / "missing.json")
        p = tmp_path / "w.json"
        p.write_text("not json")
        assert "lang" not in record_source_language({"lang": "en"}, "auto", p)

    def test_a_malformed_code_is_not_recorded(self):
        assert "lang" not in record_source_language({}, "english please!")


class TestRoute:
    def _captions_dir(self, tmp_path, captions):
        return _project_dir(tmp_path, captions)

    def test_show_alone_needs_no_phrases(self, tmp_path):
        d = self._captions_dir(tmp_path, _captions())
        answer = _translate(d, {"show": ["es"]})
        assert answer["showLangs"] == ["es"]
        saved = json.loads((d / "project.json").read_text())["captions"]
        assert saved["showLangs"] == ["es"]
        assert [s["id"] for s in saved["segments"]] == ["cap-0", "cap-1", "cap-2"]

    def test_show_with_phrases_applies_after_the_translation(self, tmp_path):
        d = self._captions_dir(tmp_path, {"style": "subtitle", "lang": "en", "segments": [seg(WORDS_A), seg(WORDS_B)]})
        answer = _translate(d, {"lang": "es", "phrases": PHRASES, "show": ["es"]})
        assert answer["showLangs"] == ["es"]

    def test_neither_phrases_nor_show_is_refused(self, tmp_path):
        d = self._captions_dir(tmp_path, _captions())
        with pytest.raises(HTTPException) as e:
            _translate(d, {"lang": "es"})
        assert e.value.status_code == 400

    def test_unknown_language_is_a_400_with_the_code(self, tmp_path):
        d = self._captions_dir(tmp_path, _captions())
        with pytest.raises(HTTPException) as e:
            _translate(d, {"show": ["de"]})
        assert e.value.status_code == 400
        assert "unknown_language" in json.dumps(e.value.detail)

    def test_removing_a_language_keeps_the_route_working_and_the_filter_safe(self, tmp_path):
        d = self._captions_dir(tmp_path, _captions(extra={"showLangs": ["es"]}))
        _translate(d, {"lang": "es", "phrases": []})
        saved = json.loads((d / "project.json").read_text())["captions"]
        assert saved["showLangs"] == ["es"]  # stale on purpose: the draw filter ignores a list that matches no row


class TestGenerationRecordsTheSourceLanguage:
    def test_the_sse_pipeline_records_the_requested_language(self, tmp_path, monkeypatch):
        _patch_caption_subprocess(monkeypatch)
        d = tmp_path / "proj"
        d.mkdir()
        (d / "_caption_track.json").write_text(json.dumps({"style": "subtitle", "segments": [seg(WORDS_A), seg(WORDS_B)]}))
        track = asyncio.run(_run_caption_pipeline(
            PID, d, _audible_project(captions={"style": "subtitle", "lang": "fr", "segments": []}),
            model="base.en", language="en", style="subtitle", broadcaster=_FakeBroadcaster(),
        ))
        assert track["lang"] == "en"
        assert json.loads((d / "project.json").read_text())["captions"]["lang"] == "en"

    def test_auto_with_no_detection_leaves_it_unknown_not_the_old_one(self, tmp_path, monkeypatch):
        _patch_caption_subprocess(monkeypatch)
        d = tmp_path / "proj"
        d.mkdir()
        (d / "_caption_track.json").write_text(json.dumps({"style": "subtitle", "segments": [seg(WORDS_A), seg(WORDS_B)]}))
        prev = {"style": "subtitle", "lang": "fr", "segments": []}
        (d / "project.json").write_text(json.dumps(_audible_project(captions=prev)))
        track = asyncio.run(_run_caption_pipeline(
            PID, d, _audible_project(captions=prev),
            model="base.en", language="auto", style="subtitle", broadcaster=_FakeBroadcaster(),
        ))
        assert "lang" not in track

    def test_the_step_records_it_too(self, tmp_path, monkeypatch, capsys):
        mod = _load_step_module()
        d = tmp_path / "proj"
        d.mkdir()
        (d / "project.json").write_text(json.dumps(_audible_project(captions={"style": "subtitle", "segments": []})))

        def fake_run(cmd, **kwargs):
            if cmd[1].endswith("transcribe.py"):
                (d / "_caption_words.json").write_text(json.dumps({"result": {"language": "es"}}))
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
        assert json.loads((d / "project.json").read_text())["captions"]["lang"] == "es"


class TestANewLanguageIsShown:
    def test_it_joins_an_active_choice(self):
        out = show_new_language(_captions(extra={"showLangs": ["en"]}), "es")
        assert out["showLangs"] == ["en", "es"]

    def test_all_languages_shown_clears_the_field(self):
        out = show_new_language(_captions(extra={"showLangs": ["en", "es"]}), "fr")
        assert "showLangs" not in out

    def test_no_active_choice_changes_nothing(self):
        c = _captions()
        assert show_new_language(c, "es") is c

    def test_stale_entries_are_dropped(self):
        out = show_new_language(_captions(extra={"showLangs": ["de", "en"]}), "es")
        assert out["showLangs"] == ["en", "es"]

    def test_the_route_does_it_when_a_row_is_first_written(self, tmp_path):
        d = _project_dir(tmp_path, {"style": "subtitle", "lang": "en", "showLangs": ["en"], "segments": [seg(WORDS_A), seg(WORDS_B)]})
        answer = _translate(d, {"lang": "es", "phrases": PHRASES})
        assert answer["showLangs"] is None  # en and es both shown: everything, the default

    def test_replacing_a_hidden_language_leaves_it_hidden(self, tmp_path):
        d = _project_dir(tmp_path, {"style": "subtitle", "lang": "en", "segments": [seg(WORDS_A), seg(WORDS_B)]})
        _translate(d, {"lang": "es", "phrases": PHRASES})
        _translate(d, {"show": ["en"]})
        answer = _translate(d, {"lang": "es", "phrases": PHRASES})
        assert answer["showLangs"] == ["en"]
