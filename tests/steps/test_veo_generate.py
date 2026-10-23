"""Step-level tests for steps/generate/veo_generate.py.

Every test monkeypatches connectors.gemini.generate_video directly (the
connector's own tests in test_connectors_gemini.py cover what it does).
Nothing here makes a network call or needs a Gemini key.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from connectors import ConnectorError
import connectors.gemini as gemini_mod
import lib.ai_video as av

_STEP_PATH = REPO_ROOT / "steps" / "generate" / "veo_generate.py"


@pytest.fixture(autouse=True)
def _video_on(monkeypatch):
    """These pin the step with Gemini video on; TestVideoOff turns it off (§550)."""
    monkeypatch.setattr(gemini_mod, "VIDEO_ON", True)


@pytest.fixture
def step_module():
    spec = importlib.util.spec_from_file_location("veo_generate_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def seen(monkeypatch):
    """Capture generate_video kwargs; it returns the out path."""
    captured = {}

    def capture(**kw):
        captured.clear()
        captured.update(kw)
        return kw["out_path"]
    monkeypatch.setattr(gemini_mod, "generate_video", capture)
    return captured


def _last_stderr_json(capsys):
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


def _run(step_module, monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["veo_generate.py", *argv])
    step_module.main()


def _png(path, size=None):
    """A real PNG when Pillow is there and a size is wanted, else dummy bytes."""
    if size:
        from PIL import Image
        Image.new("RGB", size).save(path)
    else:
        Path(path).write_bytes(b"fake")
    return str(path)


def _fails(step_module, monkeypatch, capsys, code, *argv):
    with pytest.raises(SystemExit) as ei:
        _run(step_module, monkeypatch, *argv)
    assert ei.value.code == 1
    assert _last_stderr_json(capsys)["error"] == code


class TestStandaloneModes:
    def test_t2v(self, step_module, monkeypatch, capsys, tmp_path, seen):
        out = str(tmp_path / "o.mp4")
        _run(step_module, monkeypatch, "--prompt", "a cat", "--out", out, "--json")
        assert json.loads(capsys.readouterr().out) == {
            "path": out, "model": gemini_mod.DEFAULT_VIDEO_MODEL, "mode": "t2v"}
        assert seen["prompt"] == "a cat"
        assert seen["image_path"] is None
        assert seen["last_frame_path"] is None
        assert seen["reference_image_paths"] is None
        assert seen["duration"] == 8
        assert seen["aspect_ratio"] == "9:16"
        assert seen["resolution"] == "720p"
        assert seen["model"] == gemini_mod.DEFAULT_VIDEO_MODEL
        assert seen["negative_prompt"] is None

    def test_i2v(self, step_module, monkeypatch, capsys, tmp_path, seen):
        img = _png(tmp_path / "first.png")
        _run(step_module, monkeypatch, "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
             "--image", img, "--duration", "6", "--json")
        assert json.loads(capsys.readouterr().out)["mode"] == "i2v"
        assert seen["image_path"] == img
        assert seen["last_frame_path"] is None
        assert seen["duration"] == 6

    def test_frames(self, step_module, monkeypatch, capsys, tmp_path, seen):
        first = _png(tmp_path / "a.png")
        last = _png(tmp_path / "b.png")
        _run(step_module, monkeypatch, "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
             "--image", first, "--last-frame", last, "--json")
        assert json.loads(capsys.readouterr().out)["mode"] == "frames"
        assert seen["image_path"] == first
        assert seen["last_frame_path"] == last

    def test_r2v(self, step_module, monkeypatch, capsys, tmp_path, seen):
        r1 = _png(tmp_path / "r1.png")
        r2 = _png(tmp_path / "r2.png")
        _run(step_module, monkeypatch, "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
             "--ref-image", r1, "--ref-image", r2, "--json")
        assert json.loads(capsys.readouterr().out)["mode"] == "r2v"
        assert seen["reference_image_paths"] == [r1, r2]
        assert seen["image_path"] is None

    def test_passes_resolution_model_and_negative_prompt(self, step_module, monkeypatch, tmp_path, seen):
        _run(step_module, monkeypatch, "--prompt", "x", "--out", str(tmp_path / "o.mp4"),
             "--resolution", "720p", "--model", "gemini-omni-1.1-flash",
             "--negative-prompt", "blur", "--aspect-ratio", "16:9")
        assert seen["resolution"] == "720p"
        assert seen["model"] == "gemini-omni-1.1-flash"
        assert seen["negative_prompt"] == "blur"
        assert seen["aspect_ratio"] == "16:9"

    def test_bare_path_without_json_flag(self, step_module, monkeypatch, capsys, tmp_path, seen):
        out = str(tmp_path / "o.mp4")
        _run(step_module, monkeypatch, "--prompt", "x", "--out", out)
        assert capsys.readouterr().out.strip() == out


class TestDefaultAspect:
    def test_portrait_first_frame_is_9_16(self, step_module, monkeypatch, tmp_path, seen):
        pytest.importorskip("PIL")
        img = _png(tmp_path / "p.png", (100, 200))
        _run(step_module, monkeypatch, "--prompt", "x", "--out", str(tmp_path / "o.mp4"), "--image", img)
        assert seen["aspect_ratio"] == "9:16"

    def test_landscape_first_frame_is_16_9(self, step_module, monkeypatch, tmp_path, seen):
        pytest.importorskip("PIL")
        img = _png(tmp_path / "l.png", (200, 100))
        _run(step_module, monkeypatch, "--prompt", "x", "--out", str(tmp_path / "o.mp4"), "--image", img)
        assert seen["aspect_ratio"] == "16:9"

    def test_unreadable_image_falls_back_to_9_16(self, step_module):
        assert step_module._default_aspect(None) == "9:16"
        assert step_module._default_aspect("/nonexistent.png") == "9:16"


class TestInvalidCombinations:
    """Each fails before the connector (Gemini video bills per second once sent)."""

    @pytest.fixture(autouse=True)
    def _no_connector(self, monkeypatch):
        def boom(**kw):
            raise AssertionError("must not reach the connector")
        monkeypatch.setattr(gemini_mod, "generate_video", boom)

    def test_image_and_ref_image(self, step_module, monkeypatch, capsys, tmp_path):
        img, ref = _png(tmp_path / "i.png"), _png(tmp_path / "r.png")
        _fails(step_module, monkeypatch, capsys, "invalid_args", "--prompt", "x",
               "--out", str(tmp_path / "o.mp4"), "--image", img, "--ref-image", ref)

    def test_last_frame_requires_image(self, step_module, monkeypatch, capsys, tmp_path):
        last = _png(tmp_path / "e.png")
        _fails(step_module, monkeypatch, capsys, "invalid_args", "--prompt", "x",
               "--out", str(tmp_path / "o.mp4"), "--last-frame", last)

    def test_empty_prompt(self, step_module, monkeypatch, capsys, tmp_path):
        _fails(step_module, monkeypatch, capsys, "invalid_args", "--out", str(tmp_path / "o.mp4"))

    def test_four_refs(self, step_module, monkeypatch, capsys, tmp_path):
        refs = []
        for i in range(4):
            refs += ["--ref-image", _png(tmp_path / f"r{i}.png")]
        _fails(step_module, monkeypatch, capsys, "invalid_args", "--prompt", "x",
               "--out", str(tmp_path / "o.mp4"), *refs)

    @pytest.mark.parametrize("seconds", ["2", "11"])
    def test_duration_outside_3_to_10(self, step_module, monkeypatch, capsys, tmp_path, seconds):
        _fails(step_module, monkeypatch, capsys, "invalid_args", "--prompt", "x",
               "--out", str(tmp_path / "o.mp4"), "--duration", seconds)

    @pytest.mark.parametrize("flag, value", [
        ("--resolution", "1080p"), ("--resolution", "4k"), ("--model", "veo-3.1-generate-preview"),
    ])
    def test_unpriced_resolutions_and_retired_models_are_refused(self, step_module, monkeypatch, capsys, tmp_path, flag, value):
        """§550: only 720p has a Google price, and every Veo 3.1 id is shut down; the message says so."""
        _fails(step_module, monkeypatch, capsys, "invalid_args", "--prompt", "x",
               "--out", str(tmp_path / "o.mp4"), flag, value)

    def test_unsupported_image_type(self, step_module, monkeypatch, capsys, tmp_path):
        gif = tmp_path / "a.gif"
        gif.write_bytes(b"x")
        _fails(step_module, monkeypatch, capsys, "invalid_args", "--prompt", "x",
               "--out", str(tmp_path / "o.mp4"), "--image", str(gif))

    def test_project_id_without_scene_id(self, step_module, monkeypatch, capsys, tmp_path):
        _fails(step_module, monkeypatch, capsys, "invalid_args", "--prompt", "x",
               "--out", str(tmp_path / "o.mp4"), "--project-id", "p1")

    def test_missing_image_file(self, step_module, monkeypatch, capsys, tmp_path):
        _fails(step_module, monkeypatch, capsys, "file_not_found", "--prompt", "x",
               "--out", str(tmp_path / "o.mp4"), "--image", str(tmp_path / "missing.png"))


class TestStandaloneConnectorError:
    def test_connector_error_maps_through_fail_for(self, step_module, monkeypatch, capsys, tmp_path):
        def raise_it(**kw):
            raise ConnectorError("Veo needs a billed Gemini key", reason="insufficient_credit")
        monkeypatch.setattr(gemini_mod, "generate_video", raise_it)
        with pytest.raises(SystemExit):
            _run(step_module, monkeypatch, "--prompt", "x", "--out", str(tmp_path / "o.mp4"))
        err = _last_stderr_json(capsys)
        assert err["error"] == "insufficient_credit"
        assert "billed" in err["message"]


# ── project-aware mode ────────────────────────────────────────────────────────

def _project(tmp_path, monkeypatch, duration=5, aspect="9:16", ref_count=0, scene_extra=None):
    """Write a workspace with one project; point lib.ai_video at it."""
    ws = tmp_path / "ws"
    pdir = ws / "p1"
    pdir.mkdir(parents=True)
    image_refs, ref_ids = [], []
    for i in range(ref_count):
        img = tmp_path / f"ref{i}.png"
        img.write_bytes(b"fake")
        image_refs.append({"id": f"ref{i}", "label": f"Hero{i}", "refImages": [str(img)]})
        ref_ids.append(f"ref{i}")
    storyboard = {"styleAnchor": "style", "imageRefs": image_refs,
                  "scenes": [{"id": "s1", "prompt": "Hero0 walks", "duration": duration,
                              "refImages": ref_ids, **(scene_extra or {})}]}
    if aspect is not None:
        storyboard["aspectRatio"] = aspect
    path = pdir / "project.json"
    path.write_text(json.dumps({"id": "p1", "status": "pending", "storyboard": storyboard, "tracks": []}))
    monkeypatch.setattr(av, "resolve_workspace", lambda: ws)
    monkeypatch.setattr(av, "probe_video", lambda p: None)
    monkeypatch.setattr(av, "get_duration", lambda p: 8.0)
    return path


def _pargs(tmp_path, *extra):
    return ("--out", str(tmp_path / "clip.mp4"), "--project-id", "p1", "--scene-id", "s1", *extra)


class TestProjectMode:
    @pytest.mark.parametrize("scene_s,clip_s", [(1, 3), (3, 3), (4.5, 5), (7, 7), (8, 8), (9.2, 10), (10, 10)])
    def test_duration_rounds_up(self, step_module, monkeypatch, tmp_path, seen, scene_s, clip_s):
        _project(tmp_path, monkeypatch, duration=scene_s)
        _run(step_module, monkeypatch, *_pargs(tmp_path))
        assert seen["duration"] == clip_s

    def test_over_10_fails_before_connector(self, step_module, monkeypatch, capsys, tmp_path, seen):
        _project(tmp_path, monkeypatch, duration=10.5)
        _fails(step_module, monkeypatch, capsys, "invalid_args", *_pargs(tmp_path))
        assert seen == {}

    def test_no_scene_duration_fails(self, step_module, monkeypatch, capsys, tmp_path, seen):
        _project(tmp_path, monkeypatch, duration=0)
        _fails(step_module, monkeypatch, capsys, "invalid_args", *_pargs(tmp_path))
        assert seen == {}

    def test_unknown_scene(self, step_module, monkeypatch, capsys, tmp_path, seen):
        _project(tmp_path, monkeypatch)
        _fails(step_module, monkeypatch, capsys, "not_found", "--out", str(tmp_path / "c.mp4"),
               "--project-id", "p1", "--scene-id", "nope")

    @pytest.mark.parametrize("aspect", ["1:1", "4:5"])
    def test_unsupported_storyboard_aspect_fails(self, step_module, monkeypatch, capsys, tmp_path, seen, aspect):
        _project(tmp_path, monkeypatch, aspect=aspect)
        _fails(step_module, monkeypatch, capsys, "invalid_args", *_pargs(tmp_path))
        assert seen == {}

    @pytest.mark.parametrize("aspect,want", [("9:16", "9:16"), ("16:9", "16:9"), (None, "16:9")])
    def test_aspect_comes_from_storyboard(self, step_module, monkeypatch, tmp_path, seen, aspect, want):
        _project(tmp_path, monkeypatch, aspect=aspect)
        _run(step_module, monkeypatch, *_pargs(tmp_path))
        assert seen["aspect_ratio"] == want

    def test_four_refs_fail(self, step_module, monkeypatch, capsys, tmp_path, seen):
        _project(tmp_path, monkeypatch, ref_count=4)
        _fails(step_module, monkeypatch, capsys, "invalid_args", *_pargs(tmp_path))
        assert seen == {}

    def test_refs_keep_the_scene_length_and_have_no_tokens(self, step_module, monkeypatch, tmp_path, seen):
        _project(tmp_path, monkeypatch, duration=4, ref_count=2)
        _run(step_module, monkeypatch, *_pargs(tmp_path))
        assert seen["duration"] == 4
        assert len(seen["reference_image_paths"]) == 2
        assert "<<<image_" not in seen["prompt"]

    def test_prompt_is_composed_from_project_not_the_flag(self, step_module, monkeypatch, tmp_path, seen):
        _project(tmp_path, monkeypatch)
        _run(step_module, monkeypatch, *_pargs(tmp_path, "--prompt", "ignored"))
        assert "Hero0 walks" in seen["prompt"]
        assert "style" in seen["prompt"]
        assert "ignored" not in seen["prompt"]

    def test_saves_clip_to_track0_with_gemini_provider(self, step_module, monkeypatch, capsys, tmp_path, seen):
        path = _project(tmp_path, monkeypatch, duration=5)
        _run(step_module, monkeypatch, *_pargs(tmp_path, "--json"))
        out = json.loads(capsys.readouterr().out)
        assert out == {"path": str(tmp_path / "clip.mp4"),
                       "model": gemini_mod.DEFAULT_VIDEO_MODEL, "mode": "t2v"}
        saved = json.loads(path.read_text())
        clips = saved["tracks"][0]["items"]
        assert len(clips) == 1
        gen = clips[0]["generation"]
        assert gen["provider"] == "gemini"
        assert gen["model"] == gemini_mod.DEFAULT_VIDEO_MODEL
        assert gen["sceneId"] == "s1"
        # the clip is trimmed to the scene (5 s), not the 6 s Veo clip
        assert clips[0]["end"] - clips[0]["start"] == 5

    def test_json_mode_is_r2v_with_refs(self, step_module, monkeypatch, capsys, tmp_path, seen):
        _project(tmp_path, monkeypatch, ref_count=1)
        _run(step_module, monkeypatch, *_pargs(tmp_path, "--json"))
        assert json.loads(capsys.readouterr().out)["mode"] == "r2v"

    def test_connector_error_saves_last_error_and_fails(self, step_module, monkeypatch, capsys, tmp_path):
        path = _project(tmp_path, monkeypatch)

        def raise_it(**kw):
            raise ConnectorError("Veo blocked this video", reason="content_refused")
        monkeypatch.setattr(gemini_mod, "generate_video", raise_it)
        with pytest.raises(SystemExit) as ei:
            _run(step_module, monkeypatch, *_pargs(tmp_path))
        assert ei.value.code == 1
        err = _last_stderr_json(capsys)
        assert err["error"] == "content_refused"
        saved = json.loads(path.read_text())
        assert "blocked" in saved["storyboard"]["scenes"][0]["lastError"]["message"]
        assert saved["tracks"] == []


class TestVideoOff:
    """§550: with Gemini video off the step fails at once, before any read, write or call."""

    @pytest.fixture(autouse=True)
    def _video_on(self, monkeypatch):
        monkeypatch.setattr(gemini_mod, "VIDEO_ON", False)

    def test_standalone_fails_before_any_call(self, step_module, monkeypatch, capsys, seen, tmp_path):
        with pytest.raises(SystemExit) as ei:
            _run(step_module, monkeypatch, "--prompt", "a cat", "--out", str(tmp_path / "o.mp4"))
        assert ei.value.code == 1
        err = _last_stderr_json(capsys)
        assert (err["error"], err["message"]) == ("video_off", gemini_mod.VIDEO_OFF_MESSAGE)
        assert seen == {}

    def test_project_mode_fails_before_reading_the_project(self, step_module, monkeypatch, capsys, seen, tmp_path):
        _fails(step_module, monkeypatch, capsys, "video_off",
               "--project-id", "no-such-project", "--scene-id", "s1", "--out", str(tmp_path / "o.mp4"))
        assert seen == {}

    def test_the_connector_refuses_before_making_a_client(self, monkeypatch, tmp_path):
        def no_client():
            raise AssertionError("no client may be made with video off")
        monkeypatch.setattr(gemini_mod, "_client", no_client)
        assert gemini_mod.video_request_problem("a cat") == gemini_mod.VIDEO_OFF_MESSAGE
        with pytest.raises(ConnectorError) as ei:
            gemini_mod.generate_video(prompt="a cat", out_path=str(tmp_path / "o.mp4"))
        assert str(ei.value) == gemini_mod.VIDEO_OFF_MESSAGE
