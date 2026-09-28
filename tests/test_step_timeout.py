"""serve's per-step subprocess ceiling (PV27 follow-up).

Every step runs under the flat STEP_TIMEOUT_S except a whisper step, whose
ceiling outlasts its own whisper runaway guard on the input's duration, so a
long CPU transcription is not killed part-way and a stuck one fails as the
step's structured transcription_timeout rather than a bare 504.
"""
import json

import pytest

import lib.common as lib_common
import serve.routes.steps as steps

WHISPER = {"params": [{"name": "model", "type": "enum", "default": lib_common.DEFAULT_WHISPER_MODEL}]}
PLAIN = {"params": [{"name": "width", "type": "int"}]}


@pytest.fixture
def duration(monkeypatch):
    seen = {}

    def fake(path):
        seen["path"] = path
        return seen["value"]

    monkeypatch.setattr(lib_common, "get_duration", fake)
    return seen


def test_a_non_whisper_step_keeps_the_flat_ceiling(duration):
    duration["value"] = 3600
    assert steps._step_timeout(PLAIN, {"input": "/a.mp4"}) == steps.STEP_TIMEOUT_S


def test_a_long_whisper_input_gets_the_guard_plus_overhead(duration):
    duration["value"] = 600  # guard 2400 s
    assert steps._step_timeout(WHISPER, {"input": "/a.mp4"}) == 2400 + steps.WHISPER_STEP_OVERHEAD_S
    assert duration["path"] == "/a.mp4"


def test_a_short_whisper_input_outlasts_the_inner_floor(duration):
    duration["value"] = 10  # guard floor 900 s
    t = steps._step_timeout(WHISPER, {"input": "/a.mp4"})
    assert t > lib_common.WHISPER_RUNAWAY_FLOOR_S and t >= steps.STEP_TIMEOUT_S


def test_inputs_list_is_read_too(duration):
    duration["value"] = 600
    assert steps._step_timeout(WHISPER, {"inputs": ["/b.mp4"]}) == 2400 + steps.WHISPER_STEP_OVERHEAD_S
    assert duration["path"] == "/b.mp4"


def test_a_trim_spec_is_sized_by_its_source(duration, tmp_path):
    spec = tmp_path / "spec.json"
    spec.write_text(json.dumps({"input": "/source.mp4", "keeps": [[0, 5]]}))
    duration["value"] = 1200
    assert steps._step_timeout(WHISPER, {"input": str(spec)}) == 4800 + steps.WHISPER_STEP_OVERHEAD_S
    assert duration["path"] == "/source.mp4"


def test_a_whisper_step_serve_cannot_size_gets_the_backstop(monkeypatch):
    monkeypatch.setattr(lib_common, "get_duration", lambda _p: (_ for _ in ()).throw(SystemExit(1)))
    assert steps._step_timeout(WHISPER, {"input": "/unprobeable.mp4"}) == steps.WHISPER_STEP_NO_DURATION_S
    assert steps._step_timeout(WHISPER, {"project-id": "p1"}) == steps.WHISPER_STEP_NO_DURATION_S


def test_montaj_step_timeout_still_raises_every_step(monkeypatch, duration):
    monkeypatch.setattr(steps, "STEP_TIMEOUT_S", 99999)
    duration["value"] = 10
    assert steps._step_timeout(PLAIN, {}) == 99999
    assert steps._step_timeout(WHISPER, {"input": "/a.mp4"}) == 99999
