"""Tests for connectors.kinovi (Kinovi's job API), no network.

HTTP is mocked at the `requests` layer (`_http._require_requests`), as in
test_connectors_fal.py, so the real retry helper and download run against a
scripted fake. An autouse fixture wires an empty script by default: any call a
test did not script fails the test instead of reaching Kinovi.
"""
import json

import pytest
from PIL import Image

from connectors import (ConnectorError, _http, INVALID_API_KEY, INSUFFICIENT_CREDIT,
                        CONTENT_REFUSED, UNREACHABLE)
from connectors import kinovi

API = kinovi.API


class _FakeResponse:
    def __init__(self, status_code=200, body=None, content=b""):
        self.status_code = status_code
        self._body = body
        self._content = content
        self.text = json.dumps(body) if body is not None else ""

    def json(self):
        if self._body is None:
            raise ValueError("no JSON body")
        return self._body

    def iter_content(self, chunk_size=None):
        yield self._content


class _FakeRequestException(Exception):
    pass


class _FakeRequests:
    RequestException = _FakeRequestException

    def __init__(self):
        self.script = []
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if not self.script:
            raise AssertionError(f"unscripted HTTP call: {method} {url}")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture(autouse=True)
def fake(monkeypatch):
    monkeypatch.setenv("KINOVI_API_KEY", "test-key")
    monkeypatch.setattr(_http.time, "sleep", lambda s: None)
    monkeypatch.setattr(kinovi.time, "sleep", lambda s: None)
    f = _FakeRequests()
    monkeypatch.setattr(_http, "_require_requests", lambda: f)
    return f


def _png(path, size=(400, 300), mode="RGB", color=(200, 10, 10)):
    Image.new(mode, size, color).save(path, format="PNG")
    return str(path)


def _record(status, **extra):
    return _FakeResponse(200, {"taskId": "t-1", "model": "seedance2-5", "status": status, **extra})


SUCCESS = _record("success", creditsUsed=295, output=[
    {"url": "https://static.kinovi.ai/out/t-1.mp4", "width": 1280, "height": 720, "mediaType": "video/mp4"}])

# The inputs each kind of model takes, from Kinovi's model pages (2026-10-12).
SEEDANCE_KEYS = {"prompt", "imageUrls", "videoUrls", "audioUrls", "mode", "duration", "outputResolution",
                 "aspectRatio", "generate_audio", "seed", "draft"}
WAN_KEYS = {"prompt", "imageUrls", "aspectRatio", "duration", "outputResolution", "audio", "seed"}


# ---------------------------------------------------------------------------
# Inputs: checked against the model's table before anything is sent
# ---------------------------------------------------------------------------

def test_defaults():
    assert kinovi.DEFAULT_VIDEO_MODEL == "seedance2-5"
    assert kinovi.DEFAULT_IMAGE_MODEL == "nanobanana-pro"


def test_text_to_video_sends_every_setting_explicitly():
    assert kinovi.build_video_inputs("seedance2-5", "a fox") == {
        "prompt": "a fox", "duration": 5, "outputResolution": "720p",
        "aspectRatio": "16:9", "generate_audio": False}


def test_frames_are_keyframe_mode_and_follow_the_first_frame(capsys):
    inputs = kinovi.build_video_inputs("seedance-20", "a fox", image_urls=["a", "b"], aspect_ratio="9:16")
    assert inputs["mode"] == "keyframe" and inputs["imageUrls"] == ["a", "b"]
    assert "aspectRatio" not in inputs
    assert "follows the first frame" in capsys.readouterr().err


def test_references_are_reference_mode_and_keep_the_aspect():
    inputs = kinovi.build_video_inputs("seedance2-5", "a fox", image_urls=["a", "b", "c"], reference=True,
                                       video_urls=["v"], aspect_ratio="9:16", sound=True)
    assert inputs["mode"] == "reference" and inputs["aspectRatio"] == "9:16"
    assert inputs["videoUrls"] == ["v"] and inputs["generate_audio"] is True


def test_wan_uses_its_own_sound_field_and_adaptive_frames():
    t2v = kinovi.build_video_inputs("wan3.0-text-to-video", "a fox", duration=2)
    assert t2v["audio"] is False and "generate_audio" not in t2v and "mode" not in t2v
    i2v = kinovi.build_video_inputs("wan3.0-image-to-video", "a fox", image_urls=["a"])
    assert i2v["aspectRatio"] == "adaptive" and i2v["imageUrls"] == ["a"]


@pytest.mark.parametrize("model,kwargs", [
    ("seedance2-5", {}), ("seedance2-5", {"image_urls": ["a"]}),
    ("seedance2-5", {"image_urls": ["a", "b", "c"], "reference": True, "video_urls": ["v"], "audio_urls": ["m"]}),
    ("seedance2-5", {"resolution": "480p", "draft": True, "seed": 7}),
    ("seedance2.0-mini", {"resolution": "480p"}),
    ("wan3.0-text-to-video", {"seed": 5}), ("wan3.0-image-to-video", {"image_urls": ["a", "b"]}),
])
def test_only_fields_the_model_takes_are_sent(model, kwargs):
    # Kinovi drops an unknown key silently, so a misspelled one must never leave here.
    inputs = kinovi.build_video_inputs(model, "a fox", **kwargs)
    allowed = WAN_KEYS if model.startswith("wan") else SEEDANCE_KEYS
    assert set(inputs) <= allowed, set(inputs) - allowed


@pytest.mark.parametrize("model,kwargs,message", [
    ("seedance-20", {"duration": 16}, "duration must be 4-15"),
    ("seedance2-5", {"duration": 31}, "duration must be 4-30"),
    ("wan3.0-text-to-video", {"duration": 1}, "duration must be 2-30"),
    ("seedance2.0-mini", {"resolution": "1080p"}, "resolution must be one of 480p, 720p"),
    ("seedance2-5", {"resolution": "4k"}, "resolution must be one of"),
    ("wan3.0-text-to-video", {"aspect_ratio": "21:9"}, "aspect_ratio must be one of"),
    ("wan3.0-text-to-video", {"seed": 4294967295}, "seed must be 0-2147483647"),
    ("wan3.0-text-to-video", {"image_urls": ["a"]}, "text-to-video"),
    ("wan3.0-image-to-video", {}, "needs a first frame"),
    ("wan3.0-image-to-video", {"image_urls": ["a", "b", "c"]}, "1-2 frame images"),
    ("seedance2-fast", {"image_urls": ["a", "b", "c"]}, "more than 2 images are references"),
    ("seedance-20", {"image_urls": ["x"] * 10, "reference": True}, "up to 9 images"),
    ("seedance-20", {"video_urls": ["v"] * 4}, "up to 3 reference videos"),
    ("seedance2-5", {"audio_urls": ["m"]}, "needs at least one image or video"),
    ("seedance-20", {"draft": True, "resolution": "480p"}, "no draft mode"),
    ("seedance2-5", {"draft": True}, "drafts are 480p only"),
    ("seedance-2.0", {}, "Unknown Kinovi video model"),
])
def test_bad_inputs_are_refused_before_any_call(fake, model, kwargs, message):
    with pytest.raises(ConnectorError, match=message):
        kinovi.build_video_inputs(model, "a fox", **kwargs)
    assert fake.calls == []


def test_prompt_rules():
    with pytest.raises(ConnectorError, match="must not be empty"):
        kinovi.build_video_inputs("seedance2-5", "  ")
    with pytest.raises(ConnectorError, match="limit is 10000"):
        kinovi.build_video_inputs("seedance-20", "x" * 10001)


def test_image_inputs():
    assert kinovi.build_image_inputs("nanobanana-pro", "a fox") == {"prompt": "a fox", "resolution": "2k"}
    assert kinovi.build_image_inputs("gpt-image-2", "a fox", quality="high", aspect_ratio="auto") == {
        "prompt": "a fox", "aspectRatio": "auto", "resolution": "1k", "quality": "high"}
    with pytest.raises(ConnectorError, match="no quality setting"):
        kinovi.build_image_inputs("nanobanana2", "a fox", quality="high")
    with pytest.raises(ConnectorError, match="resolution must be one of 2k, 4k"):
        kinovi.build_image_inputs("nanobanana2", "a fox", resolution="1k")
    with pytest.raises(ConnectorError, match="up to 9 reference images"):
        kinovi.build_image_inputs("nanobanana-pro", "a fox", ref_urls=["u"] * 10)
    with pytest.raises(ConnectorError, match="no output format"):
        kinovi.build_image_inputs("nanobanana-pro", "a fox", output_format="png")


# ---------------------------------------------------------------------------
# The job flow
# ---------------------------------------------------------------------------

def test_text_to_video_submits_polls_and_downloads(fake, tmp_path):
    fake.script = [_FakeResponse(200, {"taskId": "t-1"}), _record("waiting"), _record("generating"), SUCCESS,
                   _FakeResponse(200, content=b"MP4")]
    out = tmp_path / "clip.mp4"
    result = kinovi.generate_video("a fox", str(out), duration=6)
    assert out.read_bytes() == b"MP4"
    assert result == {"path": str(out), "taskId": "t-1", "model": "seedance2-5", "creditsUsed": 295, "draft": False}
    method, url, kw = fake.calls[0]
    assert (method, url) == ("POST", f"{API}/jobs/createTask")
    assert kw["headers"]["Authorization"] == "Bearer test-key"
    assert kw["json"] == {"model": "seedance2-5", "inputs": {
        "prompt": "a fox", "duration": 6, "outputResolution": "720p", "aspectRatio": "16:9", "generate_audio": False}}
    assert fake.calls[1][1] == f"{API}/jobs/recordInfo" and fake.calls[1][2]["params"] == {"taskId": "t-1"}
    assert fake.calls[-1][1] == "https://static.kinovi.ai/out/t-1.mp4"


def test_a_local_first_frame_is_uploaded_then_named_by_its_url(fake, tmp_path):
    slot = {"uploadUrl": "https://bucket.r2.example/put?sig=1", "url": "https://static.kinovi.ai/temp/f.jpg",
            "contentType": "image/jpeg", "path": "temp/f.jpg"}
    fake.script = [_FakeResponse(200, slot), _FakeResponse(200), _FakeResponse(200, {"taskId": "t-1"}), SUCCESS,
                   _FakeResponse(200, content=b"MP4")]
    kinovi.generate_video("a fox", str(tmp_path / "c.mp4"), image_path=_png(tmp_path / "f.png"))
    post, put, create = fake.calls[0], fake.calls[1], fake.calls[2]
    assert post[1] == f"{API}/uploads" and post[2]["json"] == {"fileName": "f.jpg"}
    assert put[0] == "PUT" and put[1] == slot["uploadUrl"]
    assert put[2]["headers"] == {"Content-Type": "image/jpeg"}, "the signed URL is the credential: no key on the PUT"
    assert put[2]["data"][:2] == b"\xff\xd8", "re-encoded as JPEG"
    assert create[2]["json"]["inputs"]["imageUrls"] == [slot["url"]]
    assert create[2]["json"]["inputs"]["mode"] == "keyframe"


def test_a_bad_input_costs_neither_an_upload_nor_a_submit(fake, tmp_path):
    with pytest.raises(ConnectorError, match="duration must be 4-30"):
        kinovi.generate_video("a fox", str(tmp_path / "c.mp4"), image_path=_png(tmp_path / "f.png"), duration=99)
    assert fake.calls == []


def test_a_concurrency_refusal_waits_for_a_slot(fake, tmp_path):
    busy = _FakeResponse(429, {"message": "Concurrency limit reached", "limit": 3, "current": 3})
    fake.script = [busy, busy, _FakeResponse(200, {"taskId": "t-1"}), SUCCESS, _FakeResponse(200, content=b"MP4")]
    assert kinovi.generate_video("a fox", str(tmp_path / "c.mp4"))["taskId"] == "t-1"


def test_a_concurrency_refusal_that_lasts_says_so(fake, monkeypatch, tmp_path):
    monkeypatch.setattr(kinovi, "CONCURRENCY_WAIT_S", 30.0)
    busy = _FakeResponse(429, {"message": "Concurrency limit reached", "limit": 3, "current": 3})
    fake.script = [busy, busy, busy]
    with pytest.raises(ConnectorError, match="already running 3 of the 3 tasks"):
        kinovi.generate_video("a fox", str(tmp_path / "c.mp4"))


def test_insufficient_credit_names_what_it_needs(fake, tmp_path):
    fake.script = [_FakeResponse(402, {"message": "Insufficient credits", "required": 295, "available": 40})]
    with pytest.raises(ConnectorError, match="needs 295 credits; the balance is 40") as e:
        kinovi.generate_video("a fox", str(tmp_path / "c.mp4"))
    assert e.value.reason == INSUFFICIENT_CREDIT


def test_a_rejected_key(fake, tmp_path):
    fake.script = [_FakeResponse(401, {"message": "Invalid API Key"})]
    with pytest.raises(ConnectorError) as e:
        kinovi.generate_video("a fox", str(tmp_path / "c.mp4"))
    assert e.value.reason == INVALID_API_KEY


def test_a_timed_out_submit_is_not_retried(fake, tmp_path):
    fake.script = [_FakeRequestException("read timed out")]
    with pytest.raises(ConnectorError, match="may still have been created and charged"):
        kinovi.generate_video("a fox", str(tmp_path / "c.mp4"))
    assert len(fake.calls) == 1


@pytest.mark.parametrize("error,words", [
    ({"code": "500", "message": "FaceDetectionSuspect"}, "real, identifiable person"),
    ({"code": 500, "message": "Your content was blocked by moderation."}, "content review refused"),
    ({"code": "asset_review_failed", "message": "reference rejected"}, "content review refused"),
])
def test_refusals_are_content_refused(fake, tmp_path, error, words):
    fake.script = [_FakeResponse(200, {"taskId": "t-1"}), _record("fail", error=error)]
    with pytest.raises(ConnectorError, match=words) as e:
        kinovi.generate_video("a fox", str(tmp_path / "c.mp4"))
    assert e.value.reason == CONTENT_REFUSED


def test_another_failure_says_it_is_refunded(fake, tmp_path):
    fake.script = [_FakeResponse(200, {"taskId": "t-1"}),
                   _record("fail", error={"code": "500", "message": "ServiceUnavailable"})]
    with pytest.raises(ConnectorError, match="Its credits are refunded") as e:
        kinovi.generate_video("a fox", str(tmp_path / "c.mp4"))
    assert e.value.reason is None


def test_a_task_still_running_names_its_id_and_resume_collects_it_without_a_new_task(fake, monkeypatch, tmp_path):
    monkeypatch.setattr(kinovi, "MAX_POLL_S", 10.0)
    fake.script = [_FakeResponse(200, {"taskId": "t-1"}), _record("generating"), _record("generating")]
    with pytest.raises(ConnectorError, match="--task-id t-1"):
        kinovi.generate_video("a fox", str(tmp_path / "c.mp4"))
    fake.calls.clear()
    fake.script = [SUCCESS, _FakeResponse(200, content=b"MP4")]
    assert kinovi.resume("t-1", str(tmp_path / "c.mp4"))["path"] == str(tmp_path / "c.mp4")
    assert not any(url.endswith("createTask") for _, url, _ in fake.calls)


def test_status_checks_that_keep_failing_name_the_task(fake, tmp_path):
    fake.script = [_FakeResponse(200, {"taskId": "t-1"})] + [_FakeRequestException("down")] * 15
    with pytest.raises(ConnectorError, match="resume it with --task-id t-1"):
        kinovi.generate_video("a fox", str(tmp_path / "c.mp4"))


def test_a_draft_upgrade(fake, tmp_path):
    fake.script = [_FakeResponse(200, {"taskId": "t-2", "sourceTaskId": "t-1"}),
                   _FakeResponse(200, {"taskId": "t-2", "status": "success", "output": [
                       {"url": "https://static.kinovi.ai/out/t-2.mp4", "mediaType": "video/mp4"}]}),
                   _FakeResponse(200, content=b"MP4")]
    result = kinovi.upgrade_draft("t-1", str(tmp_path / "hd.mp4"))
    assert fake.calls[0][1] == f"{API}/jobs/upgradeDraft" and fake.calls[0][2]["json"] == {"taskId": "t-1"}
    assert result["taskId"] == "t-2"


def test_an_image_is_named_after_its_bytes(fake, tmp_path):
    fake.script = [_FakeResponse(200, {"taskId": "i-1"}),
                   _FakeResponse(200, {"taskId": "i-1", "status": "success", "output": [
                       {"url": "https://static.kinovi.ai/out/i-1.jpg", "mediaType": "image/jpeg"}]}),
                   _FakeResponse(200, content=b"JPG")]
    path = kinovi.generate_image("a fox", str(tmp_path / "fox.png"), model="nanobanana2")
    assert path == str(tmp_path / "fox.jpg")
    assert fake.calls[0][2]["json"] == {"model": "nanobanana2", "inputs": {"prompt": "a fox", "resolution": "2k"}}


def test_check_key_reads_the_balance_and_nothing_else(fake):
    fake.script = [_FakeResponse(200, {"userId": "u", "email": "someone@example.com", "name": "S",
                                       "credits": 2150.5, "createdAt": 1})]
    result = kinovi.check_key()
    assert fake.calls[0][:2] == ("GET", f"{API}/account")
    assert result["ok"] is True and result["credits"] == 2150.5
    assert result["default_model"] == "seedance2-5" and result["default_model_verified"] is False
    assert "someone@example.com" not in json.dumps(result)


def test_check_key_rejected_and_unreachable(fake):
    fake.script = [_FakeResponse(401, {"message": "Invalid API Key"})]
    with pytest.raises(ConnectorError) as e:
        kinovi.check_key()
    assert e.value.reason == INVALID_API_KEY
    fake.script = [_FakeRequestException("down")] * 3
    with pytest.raises(ConnectorError) as e:
        kinovi.check_key()
    assert e.value.reason == UNREACHABLE
