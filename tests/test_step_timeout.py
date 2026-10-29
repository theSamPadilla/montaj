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


@pytest.mark.parametrize("declared", [float("inf"), float("-inf"), float("nan"), 0, -5])
def test_a_non_finite_or_non_positive_declared_timeout_is_ignored(declared):
    assert steps._step_timeout({**PLAIN, "timeout_s": declared}, {}) == steps.STEP_TIMEOUT_S


def test_a_declared_timeout_raises_the_ceiling():
    assert steps._step_timeout({**PLAIN, "timeout_s": steps.STEP_TIMEOUT_S + 600}, {}) == steps.STEP_TIMEOUT_S + 600


def test_the_probe_gets_an_absolute_path_never_a_protocol_string(duration, tmp_path):
    """ffprobe reads `concat:...` or `http://...` as a protocol; serve probes the path as a file (§563)."""
    duration["value"] = 10
    steps._step_timeout(WHISPER, {"input": "concat:/a.mp4|/b.mp4"})
    assert duration["path"].startswith("/") and duration["path"].endswith("concat:/a.mp4|/b.mp4")
    spec = tmp_path / "spec.json"
    spec.write_text(json.dumps({"input": "concat:/source.mp4", "keeps": [[0, 5]]}))
    steps._step_timeout(WHISPER, {"input": str(spec)})
    assert duration["path"].startswith("/") and duration["path"] != "concat:/source.mp4"


def test_a_relative_input_is_the_workspace_s_not_serve_s_cwd(duration, tmp_path, monkeypatch):
    """The step runs with the workspace as its cwd, so serve sizes a relative input (and a relative spec and
    its input) from the workspace too (§563 review)."""
    monkeypatch.setattr(steps, "resolve_workspace", lambda: tmp_path)
    duration["value"] = 10
    steps._step_timeout(WHISPER, {"input": "clips/a.mp4"})
    assert duration["path"] == str(tmp_path / "clips" / "a.mp4")
    (tmp_path / "spec.json").write_text(json.dumps({"input": "clips/b.mp4", "keeps": [[0, 5]]}))
    steps._step_timeout(WHISPER, {"input": "spec.json"})
    assert duration["path"] == str(tmp_path / "clips" / "b.mp4")


def test_an_absolute_input_never_asks_for_the_workspace(duration, tmp_path, monkeypatch):
    """resolve_workspace() only for a relative path (§563 review): an absolute input or spec input is used as is."""
    def no_workspace():
        raise AssertionError("resolve_workspace() called for an absolute path")
    monkeypatch.setattr(steps, "resolve_workspace", no_workspace)
    duration["value"] = 10
    steps._step_timeout(WHISPER, {"input": "/clips/a.mp4"})
    assert duration["path"] == "/clips/a.mp4"
    spec = tmp_path / "spec.json"
    spec.write_text(json.dumps({"input": "/clips/b.mp4", "keeps": [[0, 5]]}))
    steps._step_timeout(WHISPER, {"input": str(spec)})
    assert duration["path"] == "/clips/b.mp4"


KLING = {"name": "kling_generate", "params": [{"name": "model", "type": "enum", "default": "kling-v3-omni"}]}


def test_kling_legacy_models_keep_the_flat_ceiling():
    assert steps._step_timeout(KLING, {"prompt": "a"}) == steps.STEP_TIMEOUT_S
    assert steps._step_timeout(KLING, {"model": "kling-video-o1", "duration": 10}) == steps.STEP_TIMEOUT_S


def test_kling_4_outlasts_its_poll_ceiling():
    from connectors.kling import poll_ceiling_s
    t = steps._step_timeout(KLING, {"model": "kling-4.0", "duration": 30, "resolution": "1080p"})
    assert t == int(poll_ceiling_s("kling-4.0", 30, "1080p")) + steps.KLING_STEP_OVERHEAD_S == 2550
    assert steps._step_timeout(KLING, {"model": "kling-4.0", "duration": 5, "resolution": "720p"}) == steps.STEP_TIMEOUT_S


def test_kling_4_in_project_mode_sizes_for_the_longest_clip():
    """The scene sets the duration there, which serve cannot see."""
    t = steps._step_timeout(KLING, {"model": "kling-4.0", "project-id": "p", "scene-id": "s", "duration": 5})
    assert t == 2250 + steps.KLING_STEP_OVERHEAD_S
