"""Tests for generate_model on Tripo (§246 U2): the request body, the resume
record, the texture guard hook-up, the step's argument checks and fail codes,
and `_project` saving a .glb. No network: the connector's HTTP functions are
monkeypatched, and the one end-to-end test scripts the `requests` layer.

Tripo payloads are Tripo's own, captured in one paid run on 2026-10-18 and loaded
from tests/fixtures/tripo/captures (README there): the text-to-model task the stubs
return, and the upload, image-to-model submit and task of the end-to-end test. The
task ids and credits in the stubs below are the captured ones; the placeholder ids
that are only arguments (task_earlier, task_given, ...) are not responses. A GLB
built here is a synthetic GLB built by the test, not a Tripo output.
"""
import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from connectors import (ConnectorError, _http, CONTENT_REFUSED, INSUFFICIENT_CREDIT,  # noqa: E402
                        INVALID_API_KEY)
import connectors.tripo as tripo  # noqa: E402
from lib.glb_textures import GlbTextureError  # noqa: E402
from tests.tripo_captures import captured  # noqa: E402

_STEP_PATH = REPO_ROOT / "steps" / "generate" / "generate_model.py"
_SCHEMA_PATH = REPO_ROOT / "steps" / "generate" / "generate_model.json"

FORBIDDEN = {"quad", "compress", "generate_parts", "smart_low_poly", "export_orientation"}
COMMON_KEYS = {"model", "texture", "pbr", "texture_quality", "face_limit"}

# captured 2026-10-18: POST /generation/text-to-model and its finished task (20.0 credits)
TASK_ID = captured("text-to-model-submit")["data"]["task_id"]
TASK_SUCCESS = captured("task-text-to-model-success")["data"]
CREDITS = TASK_SUCCESS["credits_consumed"]

REPORT = {"reencoded": 1, "formats": {"image/webp": 1}}


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(tripo.time, "sleep", lambda s: None)


# ---------------------------------------------------------------------------
# build_generation_body: pure
# ---------------------------------------------------------------------------

def test_text_body_has_exactly_these_keys():
    endpoint, body = tripo.build_generation_body(prompt="a cat in a spacesuit")
    assert endpoint == "/generation/text-to-model"
    assert set(body) == {"prompt"} | COMMON_KEYS
    assert body == {"prompt": "a cat in a spacesuit", "model": "v3.1-20260211", "texture": True,
                    "pbr": True, "texture_quality": "standard", "face_limit": 30000}


def test_text_body_with_a_negative_prompt():
    _, body = tripo.build_generation_body(prompt="a cat", negative_prompt="blurry, broken mesh",
                                          texture="detailed")
    assert set(body) == {"prompt", "negative_prompt"} | COMMON_KEYS
    assert body["negative_prompt"] == "blurry, broken mesh" and body["texture_quality"] == "detailed"


def test_image_body_has_exactly_these_keys():
    endpoint, body = tripo.build_generation_body(image_input="file_abc123")
    assert endpoint == "/generation/image-to-model"
    assert set(body) == {"input"} | COMMON_KEYS
    assert body["input"] == "file_abc123"


def test_multiview_body_uses_view_keys_in_the_canonical_order():
    endpoint, body = tripo.build_generation_body(
        views={"right": "https://example.com/right.png", "front": "file_f", "back": "file_b", "left": None})
    assert endpoint == "/generation/multiview-to-model"
    assert set(body) == {"inputs"} | COMMON_KEYS
    # generation-multiview-to-model/standard.md: an array of objects, each with exactly one view key.
    assert body["inputs"] == [{"front": "file_f"}, {"back": "file_b"}, {"right": "https://example.com/right.png"}]


@pytest.mark.parametrize("kwargs", [
    {"prompt": "a cat"}, {"prompt": "a cat", "negative_prompt": "x", "texture": "detailed"},
    {"image_input": "file_abc123"}, {"views": {"front": "a", "left": "b", "back": "c", "right": "d"}},
])
def test_no_body_ever_carries_the_options_montaj_never_sends(kwargs):
    _, body = tripo.build_generation_body(**kwargs)
    assert not FORBIDDEN & set(body)
    assert body["model"] == tripo.DEFAULT_MODEL == "v3.1-20260211"
    assert body["texture"] is True and body["pbr"] is True


@pytest.mark.parametrize("kwargs,message", [
    ({}, "exactly one of a prompt, an image or views"),
    ({"prompt": "a", "image_input": "file_x"}, "got text and image"),
    ({"image_input": "file_x", "views": {"front": "a", "left": "b"}}, "got image and multiview"),
    ({"prompt": "   "}, "must not be empty"),
    ({"prompt": "x" * 1025}, "up to 1024 characters"),
    ({"prompt": "a", "negative_prompt": "x" * 256}, "up to 255 characters"),
    ({"image_input": "file_x", "negative_prompt": "blurry"}, "text prompt only"),
    ({"image_input": ""}, "needs an image"),
    ({"views": {"left": "a", "back": "b"}}, "needs a front view"),
    ({"views": {"front": "a"}}, "at least 2 views"),
    ({"views": {"front": "a", "left": None}}, "at least 2 views"),
    ({"views": {"front": "a", "top": "b"}}, "got top"),
    ({"views": {"front": "a", "left": "  "}}, "left view is empty"),
    ({"views": ["a", "b"]}, "must map front"),
    ({"prompt": "a", "texture": "extreme"}, "texture must be one of standard, detailed"),
])
def test_invalid_input_is_refused_naming_tripo(kwargs, message):
    with pytest.raises(ConnectorError, match=message) as e:
        tripo.build_generation_body(**kwargs)
    assert e.value.reason is None and "Tripo" in str(e.value)


def test_a_blank_negative_prompt_is_left_out():
    _, body = tripo.build_generation_body(prompt="a cat", negative_prompt="  ")
    assert "negative_prompt" not in body


@pytest.mark.parametrize("given,sent", [(None, 30000), (1000, 1000), (150000, 150000), (80000, 80000),
                                        (999, 1000), (-5, 1000), (150001, 150000), (2_000_000, 150000)])
def test_face_limit_defaults_and_is_clamped(given, sent, capsys):
    _, body = tripo.build_generation_body(prompt="a cat", face_limit=given)
    assert body["face_limit"] == sent
    err = capsys.readouterr().err
    assert ("outside" in err) == (given is not None and given != sent)


@pytest.mark.parametrize("bad", ["5000", 5000.0, True, [5000]])
def test_face_limit_must_be_a_whole_number(bad):
    with pytest.raises(ConnectorError, match="face_limit must be a whole number"):
        tripo.build_generation_body(prompt="a cat", face_limit=bad)


# ---------------------------------------------------------------------------
# generate_model: order of calls, the resume record, the guard
# ---------------------------------------------------------------------------

@pytest.fixture
def vendor(monkeypatch):
    """tripo's HTTP functions replaced by recorders. `events` is the order of calls."""
    state = {"events": [], "bodies": [], "uploads": [], "task": dict(TASK_SUCCESS), "wait_error": None,
             "download_error": None, "guard_error": None, "sidecar_at_wait": None, "wait_kw": [],
             "download_kw": []}

    def upload(path):
        state["events"].append("upload")
        state["uploads"].append(path)
        return f"file_{Path(path).stem}"

    def create(endpoint, body):
        state["events"].append("create")
        state["bodies"].append((endpoint, body))
        return TASK_ID

    def wait(task_id, **kw):
        state["events"].append(f"wait:{task_id}")
        state["wait_kw"].append(kw)
        state["sidecar_at_wait"] = state.get("sidecar_reader", lambda: None)()
        if state["wait_error"]:
            raise state["wait_error"]
        return dict(state["task"], task_id=task_id)

    def download(url, out_path, **kw):
        state["events"].append("download")
        state["download_kw"].append(kw)
        if state["download_error"]:
            raise state["download_error"]
        Path(out_path).write_bytes(b"glTF-synthetic")
        return out_path

    def guard(path):
        state["events"].append(f"guard:{Path(path).name}")
        if state["guard_error"]:
            raise state["guard_error"]
        return dict(REPORT)

    monkeypatch.setattr(tripo, "upload", upload)
    monkeypatch.setattr(tripo, "create", create)
    monkeypatch.setattr(tripo, "wait", wait)
    monkeypatch.setattr(tripo, "download", download)
    monkeypatch.setattr(tripo, "ensure_supported_textures", guard)
    return state


def _sidecar(out):
    return Path(str(out) + ".tripo.json")


def test_generate_records_the_task_before_polling_then_downloads_and_guards(vendor, tmp_path):
    out = tmp_path / "robot.glb"
    vendor["sidecar_reader"] = lambda: json.loads(_sidecar(out).read_text()) if _sidecar(out).exists() else None

    result = tripo.generate_model(out_path=str(out), prompt="a robot")

    assert vendor["events"] == ["create", f"wait:{TASK_ID}", "download", "guard:robot.glb.download"]
    at_wait = vendor["sidecar_at_wait"]
    assert at_wait is not None, "the task must be recorded before polling"
    assert {k: at_wait[k] for k in ("task_id", "kind", "model", "endpoint")} == {
        "task_id": TASK_ID, "kind": "model", "model": "v3.1-20260211",
        "endpoint": "/generation/text-to-model"}
    datetime.fromisoformat(at_wait["created"])
    assert "credits_consumed" not in at_wait
    assert result == {"path": str(out), "taskId": TASK_ID, "model": "v3.1-20260211",
                      "creditsUsed": 20.0, "textures": REPORT}
    assert out.read_bytes() == b"glTF-synthetic"
    after = json.loads(_sidecar(out).read_text())
    assert after["credits_consumed"] == 20.0 and after["task_id"] == TASK_ID
    assert sorted(p.name for p in tmp_path.iterdir()) == ["robot.glb", "robot.glb.tripo.json"]


def test_local_images_are_uploaded_and_urls_pass_through(vendor, tmp_path):
    tripo.generate_model(out_path=str(tmp_path / "a.glb"), image_path=str(tmp_path / "photo.png"))
    assert vendor["uploads"] == [str(tmp_path / "photo.png")]
    assert vendor["bodies"][-1] == ("/generation/image-to-model",
                                    tripo.build_generation_body(image_input="file_photo")[1])

    tripo.generate_model(out_path=str(tmp_path / "b.glb"), view_paths={
        "front": str(tmp_path / "f.png"), "left": None, "back": "https://example.com/back.png", "right": None})
    endpoint, body = vendor["bodies"][-1]
    assert endpoint == "/generation/multiview-to-model"
    assert body["inputs"] == [{"front": "file_f"}, {"back": "https://example.com/back.png"}]
    assert vendor["uploads"][-1] == str(tmp_path / "f.png") and len(vendor["uploads"]) == 2


@pytest.mark.parametrize("kwargs", [
    {"image_path": "photo.png", "negative_prompt": "blurry"},
    {"view_paths": {"front": "f.png", "left": None, "back": None, "right": None}},
    {"prompt": "a", "image_path": "photo.png"},
])
def test_a_bad_input_costs_no_upload_and_no_task(vendor, tmp_path, kwargs):
    with pytest.raises(ConnectorError):
        tripo.generate_model(out_path=str(tmp_path / "m.glb"), **kwargs)
    assert vendor["events"] == []
    assert list(tmp_path.iterdir()) == []


def test_a_retry_with_the_same_out_reattaches_to_the_recorded_task(vendor, tmp_path, capsys):
    out = tmp_path / "robot.glb"
    record = {"task_id": "task_earlier", "kind": "model", "model": "v3.1-20260211",
              "endpoint": "/generation/text-to-model", "created": "2026-10-13T10:00:00+00:00"}
    _sidecar(out).write_text(json.dumps(record))

    result = tripo.generate_model(out_path=str(out), prompt="a robot")

    assert vendor["events"] == ["wait:task_earlier", "download", "guard:robot.glb.download"]
    assert result["taskId"] == "task_earlier" and result["model"] == "v3.1-20260211"
    assert json.loads(_sidecar(out).read_text()) == {**record, "credits_consumed": 20.0}
    assert "Re-attaching to Tripo task task_earlier" in capsys.readouterr().err


def test_task_id_collects_a_task_with_no_new_charge(vendor, tmp_path):
    out = tmp_path / "robot.glb"
    vendor["sidecar_reader"] = lambda: json.loads(_sidecar(out).read_text())
    result = tripo.resume_model("task_given", str(out))
    assert vendor["events"] == ["wait:task_given", "download", "guard:robot.glb.download"]
    assert vendor["sidecar_at_wait"]["task_id"] == "task_given"
    assert result["taskId"] == "task_given" and result["model"] is None and result["textures"] == REPORT


def test_task_id_keeps_what_the_record_for_the_same_task_says(vendor, tmp_path):
    out = tmp_path / "robot.glb"
    record = {"task_id": "task_given", "kind": "model", "model": "v3.1-20260211",
              "endpoint": "/generation/image-to-model", "created": "2026-10-13T10:00:00+00:00"}
    _sidecar(out).write_text(json.dumps(record))
    assert tripo.resume_model("task_given", str(out))["model"] == "v3.1-20260211"
    assert json.loads(_sidecar(out).read_text())["endpoint"] == "/generation/image-to-model"


@pytest.mark.parametrize("kind", ["model", "rig"])
def test_task_id_refuses_an_out_that_records_another_task_not_yet_collected(vendor, tmp_path, kind):
    # The record may be the only note of a paid task: it is never overwritten by another id.
    out = tmp_path / "robot.glb"
    record = {"task_id": "task_A", "kind": kind, "created": "2026-10-13T10:00:00+00:00"}
    _sidecar(out).write_text(json.dumps(record))
    with pytest.raises(tripo.InvalidInput, match=f"{out} records Tripo task task_A, not collected yet; choose another out"):
        tripo.resume_model("task_B", str(out))
    assert vendor["events"] == [] and json.loads(_sidecar(out).read_text()) == record


def test_task_id_may_replace_the_record_of_a_task_already_collected(vendor, tmp_path):
    out = tmp_path / "robot.glb"
    _sidecar(out).write_text(json.dumps({"task_id": "task_A", "kind": "model", "credits_consumed": 30.0}))
    assert tripo.resume_model("task_B", str(out))["taskId"] == "task_B"
    assert json.loads(_sidecar(out).read_text())["task_id"] == "task_B"


@pytest.mark.parametrize("call", ["generate", "resume"])
def test_an_existing_out_is_never_overwritten(vendor, tmp_path, call):
    out = tmp_path / "robot.glb"
    out.write_bytes(b"MINE")
    _sidecar(out).write_text(json.dumps({"task_id": "task_earlier", "kind": "model"}))
    with pytest.raises(ConnectorError, match="already exists"):
        if call == "generate":
            tripo.generate_model(out_path=str(out), prompt="a robot")
        else:
            tripo.resume_model("task_x", str(out))
    assert vendor["events"] == [] and out.read_bytes() == b"MINE"


def test_out_must_be_a_glb(vendor, tmp_path):
    with pytest.raises(ConnectorError, match="must end in .glb"):
        tripo.generate_model(out_path=str(tmp_path / "robot.fbx"), prompt="a robot")
    assert vendor["events"] == []


def test_an_unreadable_record_is_refused_rather_than_paying_again(vendor, tmp_path):
    out = tmp_path / "robot.glb"
    _sidecar(out).write_text("{not json")
    with pytest.raises(ConnectorError, match="unreadable"):
        tripo.generate_model(out_path=str(out), prompt="a robot")
    assert vendor["events"] == []


def test_a_record_of_another_kind_is_refused(vendor, tmp_path):
    out = tmp_path / "robot.glb"
    _sidecar(out).write_text(json.dumps({"task_id": "task_rig", "kind": "rig"}))
    with pytest.raises(ConnectorError, match="records a Tripo rig task"):
        tripo.generate_model(out_path=str(out), prompt="a robot")
    assert vendor["events"] == []


def test_a_task_that_ended_drops_its_record_so_a_retry_submits_again(vendor, tmp_path):
    out = tmp_path / "robot.glb"
    vendor["wait_error"] = tripo._TaskEnded(f"Tripo task {TASK_ID} failed (2018: Model too complex).")
    with pytest.raises(ConnectorError, match="Model too complex"):
        tripo.generate_model(out_path=str(out), prompt="a robot")
    assert not _sidecar(out).exists() and not out.exists()

    vendor["wait_error"] = None
    tripo.generate_model(out_path=str(out), prompt="a robot")
    assert vendor["events"].count("create") == 2


def test_a_run_that_stops_waiting_keeps_its_record(vendor, tmp_path):
    out = tmp_path / "robot.glb"
    vendor["wait_error"] = ConnectorError(f"Tripo task {TASK_ID} is still running after 840 s.")
    with pytest.raises(ConnectorError, match="still running"):
        tripo.generate_model(out_path=str(out), prompt="a robot")
    assert json.loads(_sidecar(out).read_text())["task_id"] == TASK_ID
    assert not out.exists()


def test_a_failed_download_names_the_task_to_collect(vendor, tmp_path):
    out = tmp_path / "robot.glb"
    vendor["download_error"] = ConnectorError("Tripo download failed (HTTP 404): https://cdn.tripo3d.ai/x.glb")
    with pytest.raises(ConnectorError, match=f"--task-id {TASK_ID} \\(no new charge\\)"):
        tripo.generate_model(out_path=str(out), prompt="a robot")
    assert not out.exists() and _sidecar(out).exists()


def test_a_download_that_cannot_connect_after_the_task_is_never_unreachable(vendor, tmp_path):
    # The app's hint for provider_unreachable is "run the step again": a paid task would be paid twice.
    from connectors import UNREACHABLE
    vendor["download_error"] = ConnectorError("Tripo download of https://cdn.tripo3d.ai/x.glb failed: reset",
                                              reason=UNREACHABLE)
    with pytest.raises(ConnectorError) as e:
        tripo.generate_model(out_path=str(tmp_path / "robot.glb"), prompt="a robot")
    assert e.value.reason is None
    assert f"running the same step with --task-id {TASK_ID} (no new charge)" in str(e.value)


def test_the_wait_and_the_download_share_one_deadline_and_the_hint(vendor, tmp_path):
    tripo.generate_model(out_path=str(tmp_path / "robot.glb"), prompt="a robot")
    (wait_kw,), (download_kw,) = vendor["wait_kw"], vendor["download_kw"]
    assert wait_kw["resume_hint"] == f"--task-id {TASK_ID}"
    assert wait_kw["deadline"] == download_kw["deadline"] is not None


def test_a_model_the_guard_refuses_never_lands_at_out_and_its_bytes_are_kept(vendor, tmp_path):
    out = tmp_path / "robot.glb"
    vendor["guard_error"] = GlbTextureError("compressed geometry the file requires (KHR_draco_mesh_compression)",
                                            "compressed")
    with pytest.raises(tripo.UnsupportedModel) as e:
        tripo.generate_model(out_path=str(out), prompt="a robot")
    kept = tmp_path / "robot.unsupported.glb"
    assert str(e.value).startswith("Tripo returned a compressed model; Montaj needs it uncompressed")
    assert f"The file Tripo made is kept at {kept}." in str(e.value)
    assert e.value.kind == "compressed" and e.value.task_id == TASK_ID and e.value.kept == str(kept)
    assert isinstance(e.value, ConnectorError)
    assert kept.read_bytes() == b"glTF-synthetic", "the paid bytes, as downloaded"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["robot.glb.tripo.json", "robot.unsupported.glb"], \
        "no staged file left, nothing at out"


def test_a_kept_unsupported_model_never_replaces_another(vendor, tmp_path):
    (tmp_path / "robot.unsupported.glb").write_bytes(b"EARLIER")
    vendor["guard_error"] = GlbTextureError("image 0 is stored outside the file (a.png)", "external")
    with pytest.raises(tripo.UnsupportedModel, match="Tripo returned a model Montaj can't use: image 0 is stored") as e:
        tripo.generate_model(out_path=str(tmp_path / "robot.glb"), prompt="a robot")
    assert e.value.kept == str(tmp_path / "robot.unsupported-2.glb")
    assert (tmp_path / "robot.unsupported.glb").read_bytes() == b"EARLIER"
    assert (tmp_path / "robot.unsupported-2.glb").read_bytes() == b"glTF-synthetic"


def test_a_model_with_ktx2_textures_lands_with_a_warning(vendor, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(tripo, "ensure_supported_textures",
                        lambda path: {"reencoded": 0, "ktx2": 2, "formats": {"image/ktx2": 2}})
    out = tmp_path / "robot.glb"
    result = tripo.generate_model(out_path=str(out), prompt="a robot")
    assert out.exists() and result["textures"]["ktx2"] == 2
    warn = json.loads(capsys.readouterr().err.strip().splitlines()[-1])["warn"]
    assert "2 KTX2 textures" in warn and "base colour" in warn


# ---------------------------------------------------------------------------
# End to end at the requests layer, with the real guard
# ---------------------------------------------------------------------------

class _Resp:
    def __init__(self, status=200, body=None, content=b""):
        self.status_code, self._body, self._content, self.headers = status, body, content, {}
        self.text = json.dumps(body) if body is not None else ""

    def json(self):
        if self._body is None:
            raise ValueError("no JSON")
        return self._body

    def iter_content(self, chunk_size=None):
        yield self._content


class _Requests:
    class RequestException(Exception):
        pass

    def __init__(self, script):
        self.script, self.calls = list(script), []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if not self.script:
            raise AssertionError(f"unscripted HTTP call: {method} {url}")
        return self.script.pop(0)


def test_end_to_end_an_image_becomes_a_glb_with_jpeg_textures(monkeypatch, tmp_path):
    pytest.importorskip("PIL")
    from PIL import features
    if not features.check("webp"):
        pytest.skip("this Pillow can't encode WebP")
    from tests.test_glb_textures import build_glb, read_glb, scene, webp_opaque

    # Synthetic GLB built by the test, not a Tripo output: Tripo's real files hold JPEG and PNG
    # (tests/fixtures/tripo), so a WebP texture is the case the guard is there for.
    glb = build_glb(*scene([(webp_opaque(), "image/webp", True)]))
    photo = tmp_path / "photo.png"
    photo.write_bytes(b"\x89PNG\r\n\x1a\n-bytes")
    # captured 2026-10-18: the upload, the image-to-model submit and its finished task
    upload, created, done = (captured(n) for n in ("files-upload", "image-to-model-submit",
                                                   "task-image-to-model-success"))
    file_token, task_id, model_url = (upload["data"]["file_token"], created["data"]["task_id"],
                                      done["data"]["output"]["model_url"])
    fake = _Requests([_Resp(200, upload), _Resp(200, created), _Resp(200, done), _Resp(200, content=glb)])
    monkeypatch.setenv("TRIPO_API_KEY", "test-key")
    monkeypatch.setattr(_http, "_require_requests", lambda: fake)
    out = tmp_path / "robot.glb"

    result = tripo.generate_model(out_path=str(out), image_path=str(photo))

    assert [c[:2] for c in fake.calls] == [
        ("POST", f"{tripo.API}/files"), ("POST", f"{tripo.API}/generation/image-to-model"),
        ("GET", f"{tripo.API}/tasks/{task_id}"), ("GET", model_url)]
    assert fake.calls[1][2]["json"] == {"input": file_token, "model": "v3.1-20260211", "texture": True,
                                        "pbr": True, "texture_quality": "standard", "face_limit": 30000}
    assert result["textures"] == {"reencoded": 1, "ktx2": 0, "formats": {"image/webp": 1}}
    assert result["taskId"] == task_id and result["creditsUsed"] == 30.0
    gltf, _ = read_glb(out.read_bytes())
    assert gltf["images"][0]["mimeType"] == "image/jpeg" and "extensionsUsed" not in gltf
    assert sorted(p.name for p in tmp_path.iterdir()) == ["photo.png", "robot.glb", "robot.glb.tripo.json"]


# ---------------------------------------------------------------------------
# The step
# ---------------------------------------------------------------------------

@pytest.fixture
def step_module():
    spec = importlib.util.spec_from_file_location("generate_model_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _result(path, task=TASK_ID):
    return {"path": path, "taskId": task, "model": "v3.1-20260211", "creditsUsed": CREDITS, "textures": REPORT}


def _run(step_module, monkeypatch, argv):
    monkeypatch.setattr(sys, "argv", ["generate_model.py", *argv])
    step_module.main()


@pytest.fixture
def calls(monkeypatch):
    seen = {"generate": [], "resume": []}

    def generate(**kw):
        seen["generate"].append(kw)
        return _result(kw["out_path"])

    def resume(task_id, out):
        seen["resume"].append((task_id, out))
        return _result(out, task_id)

    monkeypatch.setattr(tripo, "generate_model", generate)
    monkeypatch.setattr(tripo, "resume_model", resume)
    return seen


def test_step_prompt_with_the_defaults(step_module, monkeypatch, capsys, calls, tmp_path):
    out = str(tmp_path / "m.glb")
    _run(step_module, monkeypatch, ["--prompt", "a robot", "--out", out, "--json"])
    assert json.loads(capsys.readouterr().out) == _result(out)
    assert calls["generate"] == [{"out_path": out, "prompt": "a robot", "image_path": None, "view_paths": None,
                                  "texture": "standard", "face_limit": 30000, "negative_prompt": None}]


def test_step_without_json_prints_the_path(step_module, monkeypatch, capsys, calls, tmp_path):
    out = str(tmp_path / "m.glb")
    _run(step_module, monkeypatch, ["--prompt", "a robot", "--out", out, "--texture", "detailed",
                                    "--face-limit", "80000", "--negative-prompt", "blurry"])
    assert capsys.readouterr().out.strip() == out
    kw = calls["generate"][0]
    assert (kw["texture"], kw["face_limit"], kw["negative_prompt"]) == ("detailed", 80000, "blurry")


def test_step_views_pass_all_four_keys(step_module, monkeypatch, calls, tmp_path):
    front, back = tmp_path / "f.png", tmp_path / "b.png"
    front.write_bytes(b"x")
    back.write_bytes(b"x")
    _run(step_module, monkeypatch, ["--view-front", str(front), "--view-back", str(back),
                                    "--view-right", "https://example.com/r.png", "--out", str(tmp_path / "m.glb")])
    assert calls["generate"][0]["view_paths"] == {"front": str(front), "left": None, "back": str(back),
                                                  "right": "https://example.com/r.png"}
    assert calls["generate"][0]["prompt"] is None and calls["generate"][0]["image_path"] is None


def test_step_task_id_resumes_without_a_new_task(step_module, monkeypatch, capsys, calls, tmp_path):
    out = str(tmp_path / "m.glb")
    _run(step_module, monkeypatch, ["--task-id", "task_9", "--out", out])
    assert calls["resume"] == [("task_9", out)] and calls["generate"] == []
    assert capsys.readouterr().out.strip() == out


@pytest.mark.parametrize("argv,message", [
    ([], "exactly one of --prompt, --image or views"),
    (["--prompt", "a", "--image", "https://example.com/a.png"], "got --prompt and --image"),
    (["--prompt", "a", "--view-front", "https://e.com/f.png", "--view-left", "https://e.com/l.png"],
     "got --prompt and views"),
    (["--prompt", " "], "--prompt must not be empty"),
    (["--image", ""], "--image must not be empty"),
    (["--view-left", "https://e.com/l.png", "--view-back", "https://e.com/b.png"], "needs --view-front"),
    (["--view-front", "https://e.com/f.png"], "at least one of --view-left"),
    (["--image", "https://e.com/a.png", "--negative-prompt", "blurry"], "--negative-prompt goes with --prompt"),
])
def test_step_invalid_args(step_module, monkeypatch, capsys, calls, tmp_path, argv, message):
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, [*argv, "--out", str(tmp_path / "m.glb")])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "invalid_args" and message in err["message"]
    assert calls["generate"] == [] and calls["resume"] == []


def test_step_a_missing_local_image(step_module, monkeypatch, capsys, calls, tmp_path):
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--image", str(tmp_path / "nope.png"), "--out", str(tmp_path / "m.glb")])
    assert json.loads(capsys.readouterr().err)["error"] == "file_not_found"


@pytest.mark.parametrize("extra", [[], ["--task-id", "task_9"]])
def test_step_refuses_to_overwrite_an_existing_out(step_module, monkeypatch, capsys, calls, tmp_path, extra):
    out = tmp_path / "m.glb"
    out.write_bytes(b"MINE")
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--prompt", "a robot", "--out", str(out), *extra])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "invalid_out" and "already exists" in err["message"]
    assert out.read_bytes() == b"MINE" and calls["generate"] == [] and calls["resume"] == []


def test_step_out_must_be_a_glb(step_module, monkeypatch, capsys, calls, tmp_path):
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--prompt", "a robot", "--out", str(tmp_path / "m.fbx")])
    assert json.loads(capsys.readouterr().err)["error"] == "invalid_out"


@pytest.mark.parametrize("reason,code", [(INVALID_API_KEY, "invalid_api_key"),
                                         (INSUFFICIENT_CREDIT, "insufficient_credit"),
                                         (CONTENT_REFUSED, "content_refused"),
                                         (None, "api_error")])
def test_step_failures_map_to_their_codes(step_module, monkeypatch, capsys, tmp_path, reason, code):
    def boom(**kw):
        raise ConnectorError("Tripo refused it", reason=reason)
    monkeypatch.setattr(tripo, "generate_model", boom)
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--prompt", "a robot", "--out", str(tmp_path / "m.glb")])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == code and "Tripo" in err["message"]


def test_step_an_unusable_model_is_unsupported_model(step_module, monkeypatch, capsys, tmp_path):
    def boom(**kw):
        raise tripo.UnsupportedModel("Tripo returned a compressed model; Montaj needs it uncompressed "
                                     f"(compressed geometry (EXT_meshopt_compression), task {TASK_ID}).",
                                     "compressed", TASK_ID)
    monkeypatch.setattr(tripo, "generate_model", boom)
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--prompt", "a robot", "--out", str(tmp_path / "m.glb")])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "unsupported_model"
    assert err["message"].startswith("Tripo returned a compressed model; Montaj needs it uncompressed")


def test_step_an_out_holding_another_tasks_record_is_invalid_args(step_module, monkeypatch, capsys, tmp_path):
    def boom(task_id, out):
        raise tripo.InvalidInput(f"{out} records Tripo task task_A, not collected yet; choose another out.")
    monkeypatch.setattr(tripo, "resume_model", boom)
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--out", str(tmp_path / "m.glb"), "--task-id", "task_B"])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "invalid_args" and "task_A, not collected yet" in err["message"]


def test_step_schema_says_model_output():
    schema = json.loads(_SCHEMA_PATH.read_text())
    assert schema["name"] == "generate_model" and schema["output"]["type"] == "model"
    assert {p["name"] for p in schema["params"]} == {
        "prompt", "image", "view-front", "view-left", "view-back", "view-right", "out", "texture",
        "face-limit", "negative-prompt", "task-id"}


def test_step_schema_leads_with_task_id_to_collect_a_paid_task():
    # In the app every run gets a fresh out, so a same-out re-attach never happens there:
    # task-id is the only way back to a paid task, and the description must say so first.
    schema = json.loads(_SCHEMA_PATH.read_text())
    assert "task-id" in schema["description"] and "no new charge" in schema["description"]
    assert "same --out" not in schema["description"]


# ---------------------------------------------------------------------------
# serve: `_project` saves a .glb
# ---------------------------------------------------------------------------

def test_project_out_is_a_glb_in_the_assets_folder(tmp_path, monkeypatch):
    import re
    import serve.routes.steps as steps_mod
    assert steps_mod._OUT_EXT["model"] == ".glb"
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-13-robots"
    pdir.mkdir(parents=True)
    (pdir / "project.json").write_text(json.dumps({"id": "p-1", "tracks": []}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    monkeypatch.setattr(steps_mod, "_RESERVED_OUTS", set())
    schema = json.loads(_SCHEMA_PATH.read_text())

    body = {"prompt": "a robot", "_project": str(pdir)}
    out = steps_mod.resolve_project_out("generate_model", schema, body)
    assert re.fullmatch(re.escape(str(pdir.resolve() / "assets")) + r"/generate_model-\d{8}-\d{6}\.glb", out)
    assert body["out"] == out and "_project" not in body

    body = {"prompt": "a robot", "_project": str(pdir), "out": "robot"}
    assert steps_mod.resolve_project_out("generate_model", schema, body) == str(pdir.resolve() / "assets" / "robot.glb")


def test_validate_step_accepts_the_model_output_type():
    sys.path.insert(0, str(REPO_ROOT / "engine"))
    import validate_step
    assert "model" in validate_step.VALID_OUTPUT_TYPES
