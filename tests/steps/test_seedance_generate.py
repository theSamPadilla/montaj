"""Step-level tests for steps/generate/seedance_generate.py — PV29 T7.

Every test monkeypatches connectors.fal.generate_video directly — the
connector's own HTTP-mocked tests (test_connectors_fal.py) cover what
generate_video() itself does. Nothing here makes a real network call.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from connectors import ConnectorError
import connectors.fal as fal_mod

_STEP_PATH = REPO_ROOT / "steps" / "generate" / "seedance_generate.py"


@pytest.fixture
def step_module():
    spec = importlib.util.spec_from_file_location("seedance_generate_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _last_stderr_json(capsys):
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


class TestModeDetection:
    def test_t2v_when_no_image_or_refs(self, step_module, monkeypatch, capsys, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(fal_mod, "generate_video", capture)
        monkeypatch.setattr(sys, "argv", [
            "seedance_generate.py", "--prompt", "a cat", "--out", str(tmp_path / "o.mp4"), "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["mode"] == "t2v"
        assert out["model"] == fal_mod.DEFAULT_MODEL
        assert out["path"] == str(tmp_path / "o.mp4")

    def test_i2v_when_image_given(self, step_module, monkeypatch, capsys, tmp_path):
        img = tmp_path / "first.png"
        img.write_bytes(b"fake")
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(fal_mod, "generate_video", capture)
        monkeypatch.setattr(sys, "argv", [
            "seedance_generate.py", "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
            "--image", str(img), "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["mode"] == "i2v"
        assert seen["image_path"] == str(img)

    def test_r2v_when_ref_images_given(self, step_module, monkeypatch, capsys, tmp_path):
        r1 = tmp_path / "r1.png"
        r2 = tmp_path / "r2.png"
        r1.write_bytes(b"fake")
        r2.write_bytes(b"fake")
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(fal_mod, "generate_video", capture)
        monkeypatch.setattr(sys, "argv", [
            "seedance_generate.py", "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
            "--ref-image", str(r1), "--ref-image", str(r2), "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out["mode"] == "r2v"
        assert seen["reference_image_paths"] == [str(r1), str(r2)]


class TestJsonOutput:
    def test_bare_path_without_json_flag(self, step_module, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(fal_mod, "generate_video", lambda **kw: kw["out_path"])
        monkeypatch.setattr(sys, "argv", [
            "seedance_generate.py", "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
        ])
        step_module.main()
        assert capsys.readouterr().out.strip() == str(tmp_path / "o.mp4")

    def test_full_dict_with_json_flag(self, step_module, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(fal_mod, "generate_video", lambda **kw: kw["out_path"])
        monkeypatch.setattr(sys, "argv", [
            "seedance_generate.py", "--prompt", "x", "--out", str(tmp_path / "o.mp4"), "--json",
        ])
        step_module.main()
        out = json.loads(capsys.readouterr().out)
        assert out == {"path": str(tmp_path / "o.mp4"), "model": fal_mod.DEFAULT_MODEL, "mode": "t2v"}


class TestFlagValidation:
    def test_image_and_ref_image_are_mutually_exclusive(self, step_module, monkeypatch, capsys, tmp_path):
        img = tmp_path / "i.png"
        ref = tmp_path / "r.png"
        img.write_bytes(b"x")
        ref.write_bytes(b"x")
        monkeypatch.setattr(sys, "argv", [
            "seedance_generate.py", "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
            "--image", str(img), "--ref-image", str(ref),
        ])
        with pytest.raises(SystemExit) as ei:
            step_module.main()
        assert ei.value.code == 1
        err = _last_stderr_json(capsys)
        assert err["error"] == "invalid_args"

    def test_end_image_requires_image(self, step_module, monkeypatch, capsys, tmp_path):
        end = tmp_path / "e.png"
        end.write_bytes(b"x")
        monkeypatch.setattr(sys, "argv", [
            "seedance_generate.py", "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
            "--end-image", str(end),
        ])
        with pytest.raises(SystemExit) as ei:
            step_module.main()
        assert ei.value.code == 1
        err = _last_stderr_json(capsys)
        assert err["error"] == "invalid_args"

    def test_missing_image_file_fails_before_connector_call(self, step_module, monkeypatch, capsys, tmp_path):
        def boom(**kw):
            raise AssertionError("must not reach the connector")
        monkeypatch.setattr(fal_mod, "generate_video", boom)
        monkeypatch.setattr(sys, "argv", [
            "seedance_generate.py", "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
            "--image", str(tmp_path / "missing.png"),
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["error"] == "file_not_found"


class TestConnectorErrorMapping:
    @pytest.mark.parametrize("reason,code", [
        ("invalid_api_key", "invalid_api_key"),
        ("insufficient_credit", "insufficient_credit"),
        ("model_retired", "model_retired"),
        ("unreachable", "provider_unreachable"),
        (None, "api_error"),
    ])
    def test_reason_maps_to_fail_code(self, step_module, monkeypatch, capsys, tmp_path, reason, code):
        def boom(**kw):
            raise ConnectorError("fal.ai rejected the request: boom", reason=reason)
        monkeypatch.setattr(fal_mod, "generate_video", boom)
        monkeypatch.setattr(sys, "argv", [
            "seedance_generate.py", "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
        ])
        with pytest.raises(SystemExit) as ei:
            step_module.main()
        assert ei.value.code == 1
        err = _last_stderr_json(capsys)
        assert err["error"] == code

    def test_vendor_prefixed_onto_a_bare_message(self, step_module, monkeypatch, capsys, tmp_path):
        def boom(**kw):
            raise ConnectorError("Prompt must not be empty")
        monkeypatch.setattr(fal_mod, "generate_video", boom)
        monkeypatch.setattr(sys, "argv", [
            "seedance_generate.py", "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
        ])
        with pytest.raises(SystemExit):
            step_module.main()
        err = _last_stderr_json(capsys)
        assert err["message"] == "Seedance: Prompt must not be empty"


class TestDefaults:
    def test_default_model_and_sound_off(self, step_module, monkeypatch, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(fal_mod, "generate_video", capture)
        monkeypatch.setattr(sys, "argv", [
            "seedance_generate.py", "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
        ])
        step_module.main()
        assert seen["model"] == fal_mod.DEFAULT_MODEL
        assert seen["generate_audio"] is False
        assert seen["duration"] == "5"

    def test_sound_flag_sets_generate_audio(self, step_module, monkeypatch, tmp_path):
        seen = {}

        def capture(**kw):
            seen.update(kw)
            return kw["out_path"]
        monkeypatch.setattr(fal_mod, "generate_video", capture)
        monkeypatch.setattr(sys, "argv", [
            "seedance_generate.py", "--prompt", "x", "--out", str(tmp_path / "o.mp4"), "--sound",
        ])
        step_module.main()
        assert seen["generate_audio"] is True
