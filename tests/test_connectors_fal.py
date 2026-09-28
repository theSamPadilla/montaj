"""Tests for connectors.fal (Seedance on fal.ai), no network.

HTTP is mocked at the `requests` layer (`_http._require_requests`), as in
test_connectors_http.py, so the real retry helper and download run against a
scripted fake. An autouse fixture wires an empty script by default: any call a
test did not script fails the test instead of reaching fal.ai.
"""
import base64
import io
import json

import pytest
from PIL import Image

from connectors import (ConnectorError, _http, INVALID_API_KEY, INSUFFICIENT_CREDIT,
                        MODEL_RETIRED, UNREACHABLE)
from connectors import fal


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
    """Stands in for the requests module: scripted responses/exceptions."""
    RequestException = _FakeRequestException

    def __init__(self, script=()):
        self.script = list(script)
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
    monkeypatch.setenv("FAL_API_KEY", "test-key")
    monkeypatch.setattr(_http.time, "sleep", lambda s: None)
    monkeypatch.setattr(fal.time, "sleep", lambda s: None)
    f = _FakeRequests()
    monkeypatch.setattr(_http, "_require_requests", lambda: f)
    return f


def _png(path, size=(64, 32), mode="RGB", color=(200, 10, 10)):
    Image.new(mode, size, color).save(path, format="PNG")
    return str(path)


def _decode_data_uri(uri):
    prefix = "data:image/jpeg;base64,"
    assert uri.startswith(prefix)
    return Image.open(io.BytesIO(base64.b64decode(uri[len(prefix):])))


QUEUED = {
    "status": "IN_QUEUE",
    "request_id": "req-1",
    "status_url": "https://queue.fal.run/bytedance/seedance-2.5/requests/req-1/status",
    "response_url": "https://queue.fal.run/bytedance/seedance-2.5/requests/req-1",
}
RESULT = {"video": {"url": "https://v3.fal.media/files/out.mp4", "content_type": "video/mp4"},
          "seed": 42, "draft_id": None}


# ---------------------------------------------------------------------------
# Model table
# ---------------------------------------------------------------------------

def test_default_model_is_seedance_2_5():
    assert fal.DEFAULT_MODEL == "seedance-2.5"
    m = fal.MODELS["seedance-2.5"]
    assert m["t2v"] == "bytedance/seedance-2.5/text-to-video"
    assert m["i2v"] == "bytedance/seedance-2.5/image-to-video"
    assert m["r2v"] == "bytedance/seedance-2.5/reference-to-video"


def test_seedance_2_0_listed():
    m = fal.MODELS["seedance-2.0"]
    assert m["t2v"] == "bytedance/seedance-2.0/text-to-video"
    assert m["i2v"] == "bytedance/seedance-2.0/image-to-video"
    assert m["r2v"] == "bytedance/seedance-2.0/reference-to-video"


def test_v1_lite_is_retired():
    for mode in ("text", "image", "reference"):
        assert f"fal-ai/bytedance/seedance/v1/lite/{mode}-to-video" in fal.RETIRED_MODELS


# ---------------------------------------------------------------------------
# build_request: model ID choice and payloads
# ---------------------------------------------------------------------------

def test_t2v_payload():
    endpoint, body = fal.build_request("a cat walks")
    assert endpoint == "bytedance/seedance-2.5/text-to-video"
    assert body == {"prompt": "a cat walks", "duration": "5", "aspect_ratio": "9:16",
                    "resolution": "720p", "generate_audio": False}


def test_i2v_payload_uses_data_uri(tmp_path):
    img = _png(tmp_path / "first.png")
    endpoint, body = fal.build_request("she turns", image_path=img, duration=10)
    assert endpoint == "bytedance/seedance-2.5/image-to-video"
    assert body["duration"] == "10"
    decoded = _decode_data_uri(body["image_url"])
    assert decoded.format == "JPEG"
    assert decoded.size == (64, 32)
    assert body["aspect_ratio"] == "auto"
    assert "end_image_url" not in body
    assert "image_urls" not in body


def test_i2v_end_frame(tmp_path):
    first = _png(tmp_path / "first.png")
    last = _png(tmp_path / "last.png", color=(0, 0, 255))
    _, body = fal.build_request("x", image_path=first, end_image_path=last)
    _decode_data_uri(body["end_image_url"])


def test_r2v_payload_keeps_prompt(tmp_path):
    refs = [_png(tmp_path / f"r{i}.png") for i in range(3)]
    prompt = "@Image1 waves at @Image2 beside @Image3"
    endpoint, body = fal.build_request(prompt, reference_image_paths=refs)
    assert endpoint == "bytedance/seedance-2.5/reference-to-video"
    assert body["prompt"] == prompt
    assert len(body["image_urls"]) == 3
    for uri in body["image_urls"]:
        _decode_data_uri(uri)
    assert "image_url" not in body


def test_model_choice_2_0(tmp_path):
    endpoint, _ = fal.build_request("x", model="seedance-2.0")
    assert endpoint == "bytedance/seedance-2.0/text-to-video"


def test_oversized_frames_capped_at_2048(tmp_path):
    img = _png(tmp_path / "big.png", size=(3000, 1500))
    _, body = fal.build_request("x", image_path=img, end_image_path=img)
    assert _decode_data_uri(body["image_url"]).size == (2048, 1024)
    assert _decode_data_uri(body["end_image_url"]).size == (2048, 1024)


def test_oversized_references_capped_at_1024(tmp_path):
    img = _png(tmp_path / "big.png", size=(3000, 1500))
    _, body = fal.build_request("x", reference_image_paths=[img])
    assert _decode_data_uri(body["image_urls"][0]).size == (1024, 512)


def test_transparent_image_is_flattened(tmp_path):
    img = _png(tmp_path / "cutout.png", mode="RGBA", color=(0, 0, 0, 0))
    _, body = fal.build_request("x", image_path=img)
    decoded = _decode_data_uri(body["image_url"])
    assert decoded.mode == "RGB"
    assert decoded.getpixel((10, 10))[0] > 240   # transparent → white, not black


def test_unreadable_image_raises(tmp_path):
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"not an image")
    with pytest.raises(ConnectorError, match="bad.png"):
        fal.build_request("x", image_path=str(bad))


def test_negative_prompt_appended():
    _, body = fal.build_request("a beach", negative_prompt="text, watermark")
    assert body["prompt"] == "a beach\n\nAvoid: text, watermark"
    assert "negative_prompt" not in body


def _warns(capsys):
    return [json.loads(line)["warn"] for line in capsys.readouterr().err.splitlines()
            if line.startswith("{") and "warn" in json.loads(line)]


def test_audio_passes_through():
    assert fal.build_request("x", generate_audio=True)[1]["generate_audio"] is True


def test_seed_sent_for_2_5_references(tmp_path, capsys):
    img = _png(tmp_path / "i.png")
    _, body = fal.build_request("x", reference_image_paths=[img], seed=7)
    assert body["seed"] == 7
    assert _warns(capsys) == []


@pytest.mark.parametrize("model, mode", [
    ("seedance-2.5", "t2v"), ("seedance-2.5", "i2v"),
    ("seedance-2.0", "t2v"), ("seedance-2.0", "i2v"), ("seedance-2.0", "r2v"),
])
def test_seed_dropped_with_note_elsewhere(tmp_path, capsys, model, mode):
    img = _png(tmp_path / "i.png")
    kw = {"i2v": {"image_path": img}, "r2v": {"reference_image_paths": [img]}}.get(mode, {})
    _, body = fal.build_request("x", model=model, seed=7, **kw)
    assert "seed" not in body
    assert any("seed" in w for w in _warns(capsys))


def test_2_5_i2v_aspect_ratio_forced_auto_with_note(tmp_path, capsys):
    img = _png(tmp_path / "i.png")
    _, body = fal.build_request("x", image_path=img, aspect_ratio="16:9")
    assert body["aspect_ratio"] == "auto"
    assert any("aspect" in w for w in _warns(capsys))


def test_2_5_i2v_default_aspect_ratio_no_note(tmp_path, capsys):
    img = _png(tmp_path / "i.png")
    _, body = fal.build_request("x", image_path=img)
    assert body["aspect_ratio"] == "auto"
    assert _warns(capsys) == []


def test_2_0_i2v_keeps_aspect_ratio(tmp_path, capsys):
    img = _png(tmp_path / "i.png")
    _, body = fal.build_request("x", image_path=img, aspect_ratio="16:9", model="seedance-2.0")
    assert body["aspect_ratio"] == "16:9"
    assert _warns(capsys) == []


def test_t2v_and_r2v_default_aspect_ratio_is_vertical(tmp_path):
    img = _png(tmp_path / "i.png")
    assert fal.build_request("x")[1]["aspect_ratio"] == "9:16"
    assert fal.build_request("x", reference_image_paths=[img])[1]["aspect_ratio"] == "9:16"


def test_2_0_takes_4k():
    assert fal.build_request("x", model="seedance-2.0", resolution="4k")[1]["resolution"] == "4k"


def test_duration_auto_and_string():
    assert fal.build_request("x", duration="auto")[1]["duration"] == "auto"
    assert fal.build_request("x", duration="30")[1]["duration"] == "30"


@pytest.mark.parametrize("duration, mode, model", [
    (3, "t2v", "seedance-2.5"), (31, "t2v", "seedance-2.5"), (31, "i2v", "seedance-2.5"),
    (31, "r2v", "seedance-2.5"), (16, "t2v", "seedance-2.0"), (16, "i2v", "seedance-2.0"),
    (16, "r2v", "seedance-2.0"), ("five", "t2v", "seedance-2.5"), (5.5, "t2v", "seedance-2.5"),
    (True, "t2v", "seedance-2.5"),
])
def test_unknown_duration_rejected_before_http(tmp_path, fake, duration, mode, model):
    img = _png(tmp_path / "i.png")
    kw = {"i2v": {"image_path": img}, "r2v": {"reference_image_paths": [img]}}.get(mode, {})
    with pytest.raises(ConnectorError, match="duration"):
        fal.generate_video("x", str(tmp_path / "out.mp4"), duration=duration, model=model, **kw)
    assert fake.calls == []


@pytest.mark.parametrize("model, top", [("seedance-2.5", 30), ("seedance-2.0", 15)])
def test_duration_bounds_accepted_in_every_mode(tmp_path, model, top):
    img = _png(tmp_path / "i.png")
    for kw in ({}, {"image_path": img}, {"reference_image_paths": [img]}):
        for d in (4, top, "auto"):
            fal.build_request("x", model=model, duration=d, **kw)


@pytest.mark.parametrize("kw, match", [
    ({"aspect_ratio": "2:1"}, "aspect_ratio"),
    ({"resolution": "4k"}, "resolution"),
    ({"model": "seedance-9"}, "model"),
])
def test_bad_options_rejected(kw, match):
    with pytest.raises(ConnectorError, match=match):
        fal.build_request("x", **kw)


def test_empty_prompt_rejected():
    with pytest.raises(ConnectorError, match="rompt"):
        fal.build_request("  ")


def test_retired_model_named_before_http(fake):
    with pytest.raises(ConnectorError) as ei:
        fal.generate_video("x", "/nonexistent/out.mp4",
                           model="fal-ai/bytedance/seedance/v1/lite/text-to-video")
    assert ei.value.reason == MODEL_RETIRED
    assert "v1/lite" in str(ei.value)
    assert fal.RETIRED_MODELS["fal-ai/bytedance/seedance/v1/lite/text-to-video"] in str(ei.value)
    assert fake.calls == []


def test_image_and_references_are_exclusive(tmp_path):
    img = _png(tmp_path / "i.png")
    with pytest.raises(ConnectorError):
        fal.build_request("x", image_path=img, reference_image_paths=[img])


def test_end_frame_needs_first_frame(tmp_path):
    img = _png(tmp_path / "i.png")
    with pytest.raises(ConnectorError):
        fal.build_request("x", end_image_path=img)


@pytest.mark.parametrize("model, cap", [("seedance-2.5", 30), ("seedance-2.0", 9)])
def test_reference_cap_per_model(tmp_path, model, cap):
    img = _png(tmp_path / "i.png")
    assert len(fal.build_request("x", model=model,
                                 reference_image_paths=[img] * cap)[1]["image_urls"]) == cap
    with pytest.raises(ConnectorError, match=str(cap)):
        fal.build_request("x", model=model, reference_image_paths=[img] * (cap + 1))


# ---------------------------------------------------------------------------
# generate_video: submit → poll → result → download
# ---------------------------------------------------------------------------

def test_generate_video_polls_to_completion_and_downloads(tmp_path, fake):
    fake.script = [
        _FakeResponse(200, QUEUED),
        _FakeResponse(200, {"status": "IN_QUEUE"}),
        _FakeResponse(200, {"status": "IN_PROGRESS"}),
        _FakeResponse(200, {"status": "COMPLETED"}),
        _FakeResponse(200, RESULT),
        _FakeResponse(200, content=b"MP4DATA"),
    ]
    out = tmp_path / "clips" / "out.mp4"
    assert fal.generate_video("a cat", str(out)) == str(out)
    assert out.read_bytes() == b"MP4DATA"

    method, url, kw = fake.calls[0]
    assert (method, url) == ("POST", "https://queue.fal.run/bytedance/seedance-2.5/text-to-video")
    assert kw["headers"]["Authorization"] == "Key test-key"
    assert kw["json"]["prompt"] == "a cat"
    assert [c[1] for c in fake.calls[1:4]] == [QUEUED["status_url"]] * 3
    assert fake.calls[4][1] == QUEUED["response_url"]
    assert fake.calls[5][1] == RESULT["video"]["url"]
    assert "Authorization" not in (fake.calls[5][2].get("headers") or {})


def test_generate_video_i2v_submits_to_image_endpoint(tmp_path, fake):
    fake.script = [_FakeResponse(200, QUEUED), _FakeResponse(200, {"status": "COMPLETED"}),
                   _FakeResponse(200, RESULT), _FakeResponse(200, content=b"V")]
    img = _png(tmp_path / "i.png")
    fal.generate_video("x", str(tmp_path / "o.mp4"), image_path=img)
    assert fake.calls[0][1] == "https://queue.fal.run/bytedance/seedance-2.5/image-to-video"
    assert fake.calls[0][2]["json"]["image_url"].startswith("data:image/jpeg;base64,")


def test_failed_job_raises_vendor_message(tmp_path, fake):
    fake.script = [_FakeResponse(200, QUEUED),
                   _FakeResponse(200, {"status": "FAILED", "error": "content policy violation"})]
    with pytest.raises(ConnectorError, match="content policy violation"):
        fal.generate_video("x", str(tmp_path / "o.mp4"))


def test_completed_with_error_raises(tmp_path, fake):
    fake.script = [_FakeResponse(200, QUEUED),
                   _FakeResponse(200, {"status": "COMPLETED", "error": "Internal server error",
                                       "error_type": "runner_disconnected"})]
    with pytest.raises(ConnectorError, match="Internal server error"):
        fal.generate_video("x", str(tmp_path / "o.mp4"))


def test_result_error_raises_detail(tmp_path, fake):
    detail = [{"loc": ["body", "prompt"], "msg": "The content could not be processed",
               "type": "content_policy_violation", "input": "x"}]
    fake.script = [_FakeResponse(200, QUEUED), _FakeResponse(200, {"status": "COMPLETED"}),
                   _FakeResponse(422, {"detail": detail})]
    with pytest.raises(ConnectorError, match="could not be processed"):
        fal.generate_video("x", str(tmp_path / "o.mp4"))


def test_result_without_video_url_raises(tmp_path, fake):
    fake.script = [_FakeResponse(200, QUEUED), _FakeResponse(200, {"status": "COMPLETED"}),
                   _FakeResponse(200, {"seed": 1})]
    with pytest.raises(ConnectorError, match="video"):
        fal.generate_video("x", str(tmp_path / "o.mp4"))


# ---------------------------------------------------------------------------
# submit: error reasons and the no-duplicate-billing retry rule
# ---------------------------------------------------------------------------

def test_submit_401_is_invalid_api_key(fake):
    fake.script = [_FakeResponse(401, {"detail": "invalid key credentials"})]
    with pytest.raises(ConnectorError) as ei:
        fal.submit("bytedance/seedance-2.5/text-to-video", {"prompt": "x"})
    assert ei.value.reason == INVALID_API_KEY
    assert "invalid key credentials" in str(ei.value)
    assert "test-key" not in str(ei.value)
    assert len(fake.calls) == 1


def test_submit_exhausted_balance_is_insufficient_credit(fake):
    fake.script = [_FakeResponse(403, {"detail": "User is locked. Reason: Exhausted balance. "
                                                 "Top up your balance at fal.ai/dashboard/billing."})]
    with pytest.raises(ConnectorError) as ei:
        fal.submit("bytedance/seedance-2.5/text-to-video", {"prompt": "x"})
    assert ei.value.reason == INSUFFICIENT_CREDIT


def test_submit_402_is_insufficient_credit(fake):
    fake.script = [_FakeResponse(402, {"detail": "Payment required"})]
    with pytest.raises(ConnectorError) as ei:
        fal.submit("m/a/b", {"prompt": "x"})
    assert ei.value.reason == INSUFFICIENT_CREDIT


def test_submit_retries_plain_429(fake):
    fake.script = [_FakeResponse(429, {"detail": "Too many requests"}), _FakeResponse(200, QUEUED)]
    assert fal.submit("m/a/b", {"prompt": "x"})["request_id"] == "req-1"
    assert len(fake.calls) == 2


def test_submit_does_not_retry_billing_429(fake):
    fake.script = [_FakeResponse(429, {"detail": "Account balance not enough"})]
    with pytest.raises(ConnectorError) as ei:
        fal.submit("m/a/b", {"prompt": "x"})
    assert ei.value.reason == INSUFFICIENT_CREDIT
    assert len(fake.calls) == 1


def test_submit_does_not_retry_unclassified_429(fake):
    """A 429 that is neither a recognised rate-limit message nor a billing
    one must not be retried — retrying against a positive rate-limit signal
    is the rule; an unrecognised 429 is not assumed to be one."""
    fake.script = [_FakeResponse(429, {"detail": "something else"})]
    with pytest.raises(ConnectorError) as ei:
        fal.submit("m/a/b", {"prompt": "x"})
    assert ei.value.reason is None
    assert len(fake.calls) == 1


def test_submit_does_not_retry_unparseable_429(fake):
    fake.script = [_FakeResponse(429, content=b"not json")]  # body=None -> .json() raises
    with pytest.raises(ConnectorError) as ei:
        fal.submit("m/a/b", {"prompt": "x"})
    assert ei.value.reason is None
    assert len(fake.calls) == 1


def test_submit_does_not_retry_5xx_or_network(fake):
    fake.script = [_FakeResponse(503, {"detail": "unavailable"})]
    with pytest.raises(ConnectorError):
        fal.submit("m/a/b", {"prompt": "x"})
    assert len(fake.calls) == 1

    fake.calls.clear()
    fake.script = [_FakeRequestException("timed out")]
    with pytest.raises(ConnectorError) as ei:
        fal.submit("m/a/b", {"prompt": "x"})
    # PV29 review item 15: a submit that timed out may already have been
    # billed — UNREACHABLE reads as "nothing happened" and invites a
    # wrongful re-run, so this must not be classified UNREACHABLE, and the
    # message must say not to regenerate.
    assert ei.value.reason is None
    assert "don't regenerate" in str(ei.value)
    assert len(fake.calls) == 1


def test_missing_key_raises_before_http(fake, monkeypatch, tmp_path):
    monkeypatch.delenv("FAL_API_KEY", raising=False)
    monkeypatch.setattr("lib.credentials.CREDENTIALS_PATH", str(tmp_path / "none.json"))
    with pytest.raises(ConnectorError, match="fal"):
        fal.submit("m/a/b", {"prompt": "x"})
    assert fake.calls == []


# ---------------------------------------------------------------------------
# wait: transient failures tolerated, a paid job is not abandoned early
# ---------------------------------------------------------------------------

def test_wait_tolerates_transient_failures(fake, monkeypatch):
    monkeypatch.setattr(_http, "RETRY_ATTEMPTS", 1)
    fake.script = [_FakeRequestException("reset"), _FakeResponse(503, {"detail": "busy"}),
                   _FakeResponse(200, {"status": "COMPLETED"})]
    assert fal.wait(QUEUED["status_url"])["status"] == "COMPLETED"


def test_wait_gives_up_after_consecutive_failures(fake, monkeypatch):
    monkeypatch.setattr(_http, "RETRY_ATTEMPTS", 1)
    fake.script = [_FakeRequestException("reset")] * fal.MAX_CONSECUTIVE_POLL_FAILURES
    with pytest.raises(ConnectorError, match="req-1") as ei:
        fal.wait(QUEUED["status_url"])
    assert len(fake.calls) == fal.MAX_CONSECUTIVE_POLL_FAILURES
    # PV29 review item 15: this is a post-submit failure (the job is
    # already queued and billed) — reason must not be UNREACHABLE, which
    # reads as "nothing happened", and the message must say not to
    # regenerate.
    assert ei.value.reason is None
    assert "don't regenerate" in str(ei.value)


def test_fetch_result_network_failure_is_not_unreachable(fake, monkeypatch):
    """PV29 review item 15: same rule as wait() — the job was already
    submitted and billed by the time fetch_result runs, so a network
    failure here must not be classified UNREACHABLE."""
    monkeypatch.setattr(_http, "RETRY_ATTEMPTS", 1)
    fake.script = [_FakeRequestException("reset")]
    with pytest.raises(ConnectorError, match="req-1") as ei:
        fal.fetch_result(QUEUED["response_url"])
    assert ei.value.reason is None
    assert "don't regenerate" in str(ei.value)


def test_wait_times_out(fake, monkeypatch):
    monkeypatch.setattr(fal, "MAX_POLL_S", fal.POLL_INTERVAL_S * 2)
    fake.script = [_FakeResponse(200, {"status": "IN_PROGRESS"})] * 2
    with pytest.raises(ConnectorError, match="did not complete"):
        fal.wait(QUEUED["status_url"])


def test_wait_401_raises_at_once(fake):
    fake.script = [_FakeResponse(401, {"detail": "invalid key credentials"})]
    with pytest.raises(ConnectorError) as ei:
        fal.wait(QUEUED["status_url"])
    assert ei.value.reason == INVALID_API_KEY
    assert len(fake.calls) == 1


# ---------------------------------------------------------------------------
# check_key: free status lookup + model availability
# ---------------------------------------------------------------------------

KEY_CHECK_URL = ("https://queue.fal.run/bytedance/seedance-2.5/requests/"
                 "00000000-0000-0000-0000-000000000000/status")


def _models(status="active", endpoint="bytedance/seedance-2.5/text-to-video"):
    return {"models": [{"endpoint_id": endpoint, "metadata": {"status": status}}]}


def test_check_key_ok(fake):
    fake.script = [_FakeResponse(404, {"status": "NOT_FOUND"}), _FakeResponse(200, _models())]
    result = fal.check_key()
    assert result["ok"] is True
    assert result["default_model"] == "seedance-2.5"
    assert result["default_model_ok"] is True
    assert isinstance(result["detail"], str)

    method, url, kw = fake.calls[0]
    assert (method, url) == ("GET", KEY_CHECK_URL)
    assert kw["headers"]["Authorization"] == "Key test-key"
    method, url, kw = fake.calls[1]
    assert (method, url) == ("GET", "https://api.fal.ai/v1/models")
    assert kw["params"] == {"endpoint_id": "bytedance/seedance-2.5/text-to-video"}


def test_check_key_bad_key(fake):
    fake.script = [_FakeResponse(401, {"detail": "invalid key credentials"})]
    with pytest.raises(ConnectorError) as ei:
        fal.check_key()
    assert ei.value.reason == INVALID_API_KEY
    assert "invalid key credentials" in str(ei.value)
    assert "test-key" not in str(ei.value)
    assert len(fake.calls) == 1


def test_check_key_deprecated_default(fake):
    fake.script = [_FakeResponse(404, {"status": "NOT_FOUND"}),
                   _FakeResponse(200, _models(status="deprecated"))]
    assert fal.check_key()["default_model_ok"] is False


def test_check_key_default_not_listed(fake):
    fake.script = [_FakeResponse(404, {"status": "NOT_FOUND"}), _FakeResponse(200, {"models": []})]
    assert fal.check_key()["default_model_ok"] is False


def test_check_key_default_retired_locally(fake, monkeypatch):
    monkeypatch.setitem(fal.RETIRED_MODELS, "seedance-2.5", "seedance-3")
    fake.script = [_FakeResponse(404, {"status": "NOT_FOUND"})]
    result = fal.check_key()
    assert result["ok"] is True
    assert result["default_model_ok"] is False
    assert len(fake.calls) == 1


def test_check_key_unreachable(fake, monkeypatch):
    monkeypatch.setattr(_http, "RETRY_ATTEMPTS", 1)
    fake.script = [_FakeRequestException("connection refused")]
    with pytest.raises(ConnectorError) as ei:
        fal.check_key()
    assert ei.value.reason == UNREACHABLE
