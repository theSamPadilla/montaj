"""Tests for connectors.kling — no network. HTTP paths run against a fake
requests module; nothing here can reach Kling."""
import base64
import pytest

from connectors import ConnectorError
from connectors.kling import build_payload, _file_to_base64, MAX_PROMPT_CHARS, MAX_REF_IMAGES, DEFAULT_MODEL, MODELS


# ---------------------------------------------------------------------------
# _file_to_base64
# ---------------------------------------------------------------------------

def test_file_to_base64(tmp_path):
    p = tmp_path / "pixel.bin"
    p.write_bytes(b"\x89PNG\r\n\x1a\nfakedata")
    result = _file_to_base64(str(p))
    assert result == base64.b64encode(b"\x89PNG\r\n\x1a\nfakedata").decode("ascii")


# ---------------------------------------------------------------------------
# build_payload — text only
# ---------------------------------------------------------------------------

def test_build_payload_text_only():
    result = build_payload(prompt="A cat walking")
    body = result["body"]
    assert body["model_name"] == DEFAULT_MODEL
    assert body["prompt"] == "A cat walking"
    assert "image_list" not in body
    assert result["truncated"] is False
    assert result["original_prompt_length"] == len("A cat walking")


# ---------------------------------------------------------------------------
# build_payload — first frame only
# ---------------------------------------------------------------------------

def test_build_payload_first_frame(tmp_path):
    img = tmp_path / "first.png"
    img.write_bytes(b"\x00\x01\x02")
    result = build_payload(prompt="test", first_frame_path=str(img))
    body = result["body"]
    assert "image_list" in body
    assert len(body["image_list"]) == 1
    assert body["image_list"][0]["type"] == "first_frame"
    assert body["image_list"][0]["image_url"] == base64.b64encode(b"\x00\x01\x02").decode("ascii")


# ---------------------------------------------------------------------------
# build_payload — first + last frame
# ---------------------------------------------------------------------------

def test_build_payload_first_and_last_frame(tmp_path):
    first = tmp_path / "first.png"
    first.write_bytes(b"FIRST")
    last = tmp_path / "last.png"
    last.write_bytes(b"LAST")
    result = build_payload(prompt="test", first_frame_path=str(first), last_frame_path=str(last))
    body = result["body"]
    assert len(body["image_list"]) == 2
    assert body["image_list"][0]["type"] == "first_frame"
    assert body["image_list"][1]["type"] == "end_frame"


# ---------------------------------------------------------------------------
# build_payload — reference images (connector is pure pass-through;
# caller owns <<<image_N>>> token placement in the prompt)
# ---------------------------------------------------------------------------

def test_build_payload_reference_images(tmp_path):
    ref1 = tmp_path / "ref1.png"
    ref1.write_bytes(b"R1")
    ref2 = tmp_path / "ref2.png"
    ref2.write_bytes(b"R2")
    result = build_payload(prompt="a person dancing", reference_image_paths=[str(ref1), str(ref2)])
    body = result["body"]
    # Connector is pure pass-through — does NOT mutate the prompt.
    assert body["prompt"] == "a person dancing"
    # reference images have no type key
    assert len(body["image_list"]) == 2
    assert "type" not in body["image_list"][0]
    assert "type" not in body["image_list"][1]


def test_build_payload_ref_images_after_first_frame(tmp_path):
    """Ref images are appended after first_frame in image_list."""
    first = tmp_path / "first.png"
    first.write_bytes(b"F")
    ref1 = tmp_path / "ref1.png"
    ref1.write_bytes(b"R1")
    result = build_payload(
        prompt="test", first_frame_path=str(first),
        reference_image_paths=[str(ref1)],
    )
    body = result["body"]
    # first_frame is image_list[0], ref is image_list[1]
    assert body["image_list"][0]["type"] == "first_frame"
    assert "type" not in body["image_list"][1]
    assert len(body["image_list"]) == 2


def test_build_payload_preserves_caller_placed_tokens(tmp_path):
    """Connector preserves caller-placed <<<image_N>>> tokens as-is."""
    ref1 = tmp_path / "ref1.png"
    ref1.write_bytes(b"R1")
    ref2 = tmp_path / "ref2.png"
    ref2.write_bytes(b"R2")
    prompt = "The man <<<image_1>>> walks past the <<<image_2>>> tree"
    result = build_payload(prompt=prompt, reference_image_paths=[str(ref1), str(ref2)])
    assert result["body"]["prompt"] == prompt


# ---------------------------------------------------------------------------
# build_payload — prompt truncation
# ---------------------------------------------------------------------------

def test_build_payload_truncates_long_prompt():
    long_prompt = "x" * (MAX_PROMPT_CHARS + 500)
    result = build_payload(prompt=long_prompt)
    assert result["truncated"] is True
    assert len(result["body"]["prompt"]) == MAX_PROMPT_CHARS


def test_build_payload_exact_limit_not_truncated():
    exact_prompt = "y" * MAX_PROMPT_CHARS
    result = build_payload(prompt=exact_prompt)
    assert result["truncated"] is False
    assert len(result["body"]["prompt"]) == MAX_PROMPT_CHARS


# ---------------------------------------------------------------------------
# build_payload — duration clamping
# ---------------------------------------------------------------------------

def test_build_payload_clamps_duration_below_min():
    result = build_payload(prompt="test", duration_seconds=1)
    assert result["body"]["duration"] == "3"


def test_build_payload_clamps_duration_above_max():
    result = build_payload(prompt="test", duration_seconds=30)
    assert result["body"]["duration"] == "15"


def test_build_payload_keeps_valid_duration():
    result = build_payload(prompt="test", duration_seconds=10)
    assert result["body"]["duration"] == "10"


# ---------------------------------------------------------------------------
# build_payload — optional fields
# ---------------------------------------------------------------------------

def test_build_payload_negative_prompt():
    result = build_payload(prompt="test", negative_prompt="blurry")
    assert result["body"]["negative_prompt"] == "blurry"


def test_build_payload_no_negative_prompt():
    result = build_payload(prompt="test")
    assert "negative_prompt" not in result["body"]


def test_build_payload_custom_params():
    result = build_payload(prompt="test", sound="off", aspect_ratio="9:16", mode="pro")
    body = result["body"]
    assert body["sound"] == "off"
    assert body["aspect_ratio"] == "9:16"
    assert body["mode"] == "pro"


def test_build_payload_external_task_id_included_when_set():
    result = build_payload(prompt="test", external_task_id="scene-abc123")
    assert result["body"]["external_task_id"] == "scene-abc123"


def test_build_payload_external_task_id_omitted_when_none():
    result = build_payload(prompt="test")
    assert "external_task_id" not in result["body"]


# ---------------------------------------------------------------------------
# Validation — empty prompt, ref-image limit, missing file
# ---------------------------------------------------------------------------

def test_build_payload_rejects_empty_prompt():
    with pytest.raises(ConnectorError, match="empty"):
        build_payload(prompt="")


def test_build_payload_rejects_whitespace_prompt():
    with pytest.raises(ConnectorError, match="empty"):
        build_payload(prompt="   ")


def test_build_payload_rejects_too_many_ref_images(tmp_path):
    paths = []
    for i in range(MAX_REF_IMAGES + 1):
        p = tmp_path / f"ref{i}.png"
        p.write_bytes(b"X")
        paths.append(str(p))
    with pytest.raises(ConnectorError, match="Too many reference images"):
        build_payload(prompt="test", reference_image_paths=paths)


def test_file_to_base64_missing_file():
    with pytest.raises(ConnectorError, match="Could not read"):
        _file_to_base64("/nonexistent/path.png")


# ---------------------------------------------------------------------------
# Multi-shot mode
# ---------------------------------------------------------------------------

def _valid_multi_prompt():
    return [
        {"index": 1, "prompt": "A café in the morning.", "duration": "3"},
        {"index": 2, "prompt": "Two people meet eyes.",   "duration": "4"},
    ]


def test_multi_shot_customize_basic():
    result = build_payload(
        multi_shot=True, shot_type="customize", multi_prompt=_valid_multi_prompt()
    )
    body = result["body"]
    assert body["multi_shot"] is True
    assert body["shot_type"] == "customize"
    assert body["multi_prompt"] == _valid_multi_prompt()
    # prompt field is omitted in customize mode (per docs: "prompt is invalid")
    assert "prompt" not in body
    # duration is computed from the sum of shot durations (3 + 4 = 7)
    assert body["duration"] == "7"


def test_multi_shot_intelligence_uses_single_prompt():
    result = build_payload(
        prompt="A whole cohesive story",
        multi_shot=True, shot_type="intelligence",
        duration_seconds=10,
    )
    body = result["body"]
    assert body["multi_shot"] is True
    assert body["shot_type"] == "intelligence"
    assert body["prompt"] == "A whole cohesive story"
    assert "multi_prompt" not in body
    assert body["duration"] == "10"


def test_multi_shot_rejects_missing_shot_type():
    with pytest.raises(ConnectorError, match="shot_type"):
        build_payload(multi_shot=True, multi_prompt=_valid_multi_prompt())


def test_multi_shot_rejects_bad_shot_type():
    with pytest.raises(ConnectorError, match="shot_type"):
        build_payload(multi_shot=True, shot_type="freestyle", multi_prompt=_valid_multi_prompt())


def test_multi_shot_customize_requires_multi_prompt():
    with pytest.raises(ConnectorError, match="multi_prompt"):
        build_payload(multi_shot=True, shot_type="customize")


def test_multi_shot_intelligence_requires_prompt():
    with pytest.raises(ConnectorError, match="non-empty prompt"):
        build_payload(multi_shot=True, shot_type="intelligence")


def test_multi_shot_rejects_first_frame(tmp_path):
    img = tmp_path / "first.png"
    img.write_bytes(b"\x00\x01")
    with pytest.raises(ConnectorError, match="first_frame"):
        build_payload(
            multi_shot=True, shot_type="customize",
            multi_prompt=_valid_multi_prompt(),
            first_frame_path=str(img),
        )


def test_multi_shot_rejects_too_many_shots():
    too_many = [
        {"index": i, "prompt": f"shot {i}", "duration": "1"}
        for i in range(1, 8)  # 7 entries, cap is 6
    ]
    with pytest.raises(ConnectorError, match="1-6 entries"):
        build_payload(multi_shot=True, shot_type="customize", multi_prompt=too_many)


def test_multi_shot_rejects_empty_shots():
    with pytest.raises(ConnectorError, match="1-6 entries"):
        build_payload(multi_shot=True, shot_type="customize", multi_prompt=[])


def test_multi_shot_rejects_oversize_shot_prompt():
    oversized = [
        {"index": 1, "prompt": "x" * 513, "duration": "3"},
    ]
    with pytest.raises(ConnectorError, match="512 chars"):
        build_payload(multi_shot=True, shot_type="customize", multi_prompt=oversized)


def test_multi_shot_rejects_missing_entry_fields():
    bad = [{"index": 1, "prompt": "ok"}]  # missing duration
    with pytest.raises(ConnectorError, match="duration"):
        build_payload(multi_shot=True, shot_type="customize", multi_prompt=bad)


def test_multi_shot_rejects_non_integer_duration():
    bad = [{"index": 1, "prompt": "ok", "duration": "three"}]
    with pytest.raises(ConnectorError, match="integer durations"):
        build_payload(multi_shot=True, shot_type="customize", multi_prompt=bad)


def test_single_shot_ignores_multi_prompt_silently():
    # multi_prompt passed without multi_shot=True is a no-op.
    result = build_payload(prompt="hello", multi_prompt=_valid_multi_prompt())
    body = result["body"]
    assert "multi_shot" not in body
    assert "multi_prompt" not in body
    assert body["prompt"] == "hello"


def test_multi_shot_customize_with_ref_images(tmp_path):
    ref1 = tmp_path / "ref1.png"
    ref1.write_bytes(b"R1")
    result = build_payload(
        multi_shot=True, shot_type="customize",
        multi_prompt=_valid_multi_prompt(),
        reference_image_paths=[str(ref1)],
    )
    body = result["body"]
    assert body["multi_shot"] is True
    assert len(body["image_list"]) == 1
    # In customize mode, prompt is omitted from body — per-shot prompts in multi_prompt.
    assert "prompt" not in body


# ---------------------------------------------------------------------------
# Model selection
# ---------------------------------------------------------------------------

def test_model_defaults_to_v3_omni():
    result = build_payload(prompt="test")
    assert result["body"]["model_name"] == "kling-v3-omni"


def test_model_o1_sets_model_name():
    result = build_payload(prompt="test", model="kling-video-o1", duration_seconds=5)
    assert result["body"]["model_name"] == "kling-video-o1"


def test_model_o1_snaps_duration_to_5_or_10():
    # 7s should snap to nearest allowed (5)
    result = build_payload(prompt="test", model="kling-video-o1", duration_seconds=7)
    assert result["body"]["duration"] == "5"
    # 8s should snap to 10
    result = build_payload(prompt="test", model="kling-video-o1", duration_seconds=8)
    assert result["body"]["duration"] == "10"
    # 3s should snap to 5
    result = build_payload(prompt="test", model="kling-video-o1", duration_seconds=3)
    assert result["body"]["duration"] == "5"


def test_model_o1_rejects_multi_shot():
    with pytest.raises(ConnectorError, match="does not support multi-shot"):
        build_payload(
            multi_shot=True, shot_type="customize",
            multi_prompt=_valid_multi_prompt(),
            model="kling-video-o1",
        )


def test_model_o1_rejects_end_frame_in_std(tmp_path):
    first = tmp_path / "first.png"
    first.write_bytes(b"F")
    last = tmp_path / "last.png"
    last.write_bytes(b"L")
    with pytest.raises(ConnectorError, match="end frame.*pro"):
        build_payload(
            prompt="test",
            first_frame_path=str(first),
            last_frame_path=str(last),
            model="kling-video-o1",
            mode="std",
            duration_seconds=5,
        )


def test_model_o1_allows_end_frame_in_pro(tmp_path):
    first = tmp_path / "first.png"
    first.write_bytes(b"F")
    last = tmp_path / "last.png"
    last.write_bytes(b"L")
    result = build_payload(
        prompt="test",
        first_frame_path=str(first),
        last_frame_path=str(last),
        model="kling-video-o1",
        mode="pro",
        duration_seconds=5,
    )
    assert result["body"]["model_name"] == "kling-video-o1"
    assert result["body"]["mode"] == "pro"
    assert len(result["body"]["image_list"]) == 2


def test_model_unknown_rejected():
    with pytest.raises(ConnectorError, match="Unknown model"):
        build_payload(prompt="test", model="kling-v99")


def test_model_v3_omni_allows_any_duration():
    for dur in [3, 7, 12, 15]:
        result = build_payload(prompt="test", model="kling-v3-omni", duration_seconds=dur)
        assert result["body"]["duration"] == str(dur)


def test_mode_defaults_to_pro():
    assert build_payload(prompt="test")["body"]["mode"] == "pro"


# ---------------------------------------------------------------------------
# HTTP paths — PV29 T4. Error reasons, the 429 split, retired models,
# check_key. Every call hits _FakeRequests; the bodies are the ones Kling
# returned live (docs/plans/PV29-vendor-facts.md in montaj-app).
# ---------------------------------------------------------------------------

import importlib.util  # noqa: E402
import json  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402

from connectors import (  # noqa: E402
    _http, kling, INVALID_API_KEY, INSUFFICIENT_CREDIT, MODEL_RETIRED, UNREACHABLE,
)

OUT_OF_CREDIT = "Your Kling account is out of credits. Top up a resource pack at kling.ai/dev."
BALANCE_429 = {"code": 1102, "message": "Account balance not enough"}
KEY_401 = {"code": 1002, "message": "access key not found"}
RATE_429 = {"code": 1302, "message": "API request too fast"}
CREATED = {"code": 0, "message": "SUCCEED", "data": {"task_id": "t-1", "task_status": "submitted"}}


class _Resp:
    def __init__(self, status_code, body=None, text=None):
        self.status_code = status_code
        self._body = body
        self.text = text if text is not None else json.dumps(body)

    def json(self):
        if self._body is None:
            raise ValueError("not JSON")
        return self._body


class _FakeRequests:
    """Stands in for the requests module; replays a script, records calls."""

    class RequestException(Exception):
        pass

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if not self.script:
            raise AssertionError(f"unexpected HTTP call: {method} {url}")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture
def wire(monkeypatch):
    """wire(*responses) -> fake. Fake credentials, no sleeping, no network."""
    monkeypatch.setenv("KLING_ACCESS_KEY", "test-access-key-0000000000000000")
    monkeypatch.setenv("KLING_SECRET_KEY", "test-secret-key-0000000000000000")
    sleeps = []
    monkeypatch.setattr(_http.time, "sleep", sleeps.append)

    def _wire(*script):
        fake = _FakeRequests(script)
        fake.sleeps = sleeps
        monkeypatch.setattr(_http, "_require_requests", lambda: fake)
        return fake
    return _wire


def _body(model=DEFAULT_MODEL):
    return build_payload(prompt="a cat", model=model)["body"]


class TestCreateTaskErrors:
    def test_401_is_invalid_api_key(self, wire):
        fake = wire(_Resp(401, KEY_401))
        with pytest.raises(ConnectorError) as ei:
            kling.create_task(_body())
        assert ei.value.reason == INVALID_API_KEY
        assert str(ei.value) == "Kling rejected the key: access key not found"
        assert len(fake.calls) == 1

    def test_balance_429_is_insufficient_credit_and_not_retried(self, wire):
        fake = wire(_Resp(429, BALANCE_429), _Resp(200, CREATED))
        with pytest.raises(ConnectorError) as ei:
            kling.create_task(_body())
        assert ei.value.reason == INSUFFICIENT_CREDIT
        assert str(ei.value) == OUT_OF_CREDIT
        assert len(fake.calls) == 1
        assert fake.sleeps == []

    def test_balance_words_without_a_code_are_not_retried(self, wire):
        fake = wire(_Resp(429, {"message": "Account balance not enough"}), _Resp(200, CREATED))
        with pytest.raises(ConnectorError) as ei:
            kling.create_task(_body())
        assert ei.value.reason == INSUFFICIENT_CREDIT
        assert len(fake.calls) == 1

    def test_unparseable_429_is_not_retried(self, wire):
        fake = wire(_Resp(429, None, text="<html>busy</html>"), _Resp(200, CREATED))
        with pytest.raises(ConnectorError, match="HTTP 429") as ei:
            kling.create_task(_body())
        assert ei.value.reason is None
        assert len(fake.calls) == 1
        assert fake.sleeps == []

    def test_known_non_rate_limit_429_is_not_retried(self, wire):
        # 1100 "account exception": waiting does not fix it.
        fake = wire(_Resp(429, {"code": 1100, "message": "Account exception"}), _Resp(200, CREATED))
        with pytest.raises(ConnectorError):
            kling.create_task(_body())
        assert len(fake.calls) == 1

    def test_rate_limit_429_is_retried_then_succeeds(self, wire):
        fake = wire(_Resp(429, RATE_429), _Resp(200, CREATED))
        assert kling.create_task(_body())["task_id"] == "t-1"
        assert len(fake.calls) == 2
        assert len(fake.sleeps) == 1

    def test_plain_parsed_429_without_balance_signal_is_retried(self, wire):
        fake = wire(_Resp(429, {"message": "Too many requests"}), _Resp(200, CREATED))
        assert kling.create_task(_body())["task_id"] == "t-1"
        assert len(fake.calls) == 2

    def test_rate_limit_retry_is_bounded(self, wire):
        fake = wire(*[_Resp(429, RATE_429)] * _http.RETRY_ATTEMPTS)
        with pytest.raises(ConnectorError, match="HTTP 429"):
            kling.create_task(_body())
        assert len(fake.calls) == _http.RETRY_ATTEMPTS

    def test_5xx_is_not_retried_on_create(self, wire):
        # A 5xx POST may have created a paid task; resubmitting could bill twice.
        fake = wire(_Resp(500, {"code": 5000, "message": "server error"}), _Resp(200, CREATED))
        with pytest.raises(ConnectorError, match="HTTP 500"):
            kling.create_task(_body())
        assert len(fake.calls) == 1

    def test_model_not_supported_is_model_retired(self, wire):
        wire(_Resp(400, {"code": 1201, "message": "model is not supported"}))
        with pytest.raises(ConnectorError) as ei:
            kling.create_task(_body("kling-v3-omni"))
        assert ei.value.reason == MODEL_RETIRED
        assert "kling-v3-omni" in str(ei.value)
        assert '"model is not supported"' in str(ei.value)

    def test_other_1201_stays_generic(self, wire):
        msg = "aspect_ratio value '4:5' is invalid, allowed values: 16:9, 9:16, 1:1"
        wire(_Resp(400, {"code": 1201, "message": msg}))
        with pytest.raises(ConnectorError) as ei:
            kling.create_task(_body())
        assert ei.value.reason is None
        assert msg in str(ei.value)

    def test_200_with_nonzero_code_is_classified(self, wire):
        wire(_Resp(200, BALANCE_429))
        with pytest.raises(ConnectorError) as ei:
            kling.create_task(_body())
        assert ei.value.reason == INSUFFICIENT_CREDIT


class TestRetiredModels:
    def test_retired_model_raises_before_any_http(self, wire, monkeypatch, tmp_path):
        monkeypatch.setitem(kling.RETIRED_MODELS, "kling-v2-old", "kling-v3-omni")
        fake = wire()  # any call fails the test
        with pytest.raises(ConnectorError) as ei:
            kling.generate(prompt="a cat", out_path=str(tmp_path / "o.mp4"), model="kling-v2-old")
        assert ei.value.reason == MODEL_RETIRED
        assert str(ei.value) == "kling-v2-old is retired; use kling-v3-omni"
        assert fake.calls == []

    def test_retired_names_are_not_offered(self):
        assert not set(kling.RETIRED_MODELS) & set(MODELS)

    def test_default_model_is_current(self):
        assert DEFAULT_MODEL == "kling-v3-omni"
        assert DEFAULT_MODEL in MODELS
        assert DEFAULT_MODEL not in kling.RETIRED_MODELS


class TestOtherCalls:
    def test_speech_balance_429_is_not_retried(self, wire, tmp_path):
        fake = wire(_Resp(429, BALANCE_429), _Resp(200, CREATED))
        with pytest.raises(ConnectorError) as ei:
            kling.generate_speech("hi", "sunny", str(tmp_path / "o.mp3"))
        assert ei.value.reason == INSUFFICIENT_CREDIT
        assert str(ei.value) == OUT_OF_CREDIT
        assert len(fake.calls) == 1

    def test_speech_401_is_invalid_api_key(self, wire, tmp_path):
        wire(_Resp(401, KEY_401))
        with pytest.raises(ConnectorError) as ei:
            kling.generate_speech("hi", "sunny", str(tmp_path / "o.mp3"))
        assert ei.value.reason == INVALID_API_KEY

    def test_query_balance_429_is_not_retried(self, wire):
        fake = wire(_Resp(429, BALANCE_429), _Resp(200, CREATED))
        with pytest.raises(ConnectorError) as ei:
            kling.query_task("t-1")
        assert ei.value.reason == INSUFFICIENT_CREDIT
        assert len(fake.calls) == 1

    def test_query_5xx_is_still_retried(self, wire):
        # Status checks are idempotent: transient 5xx keeps its retry.
        done = {"code": 0, "data": {"task_status": "processing"}}
        fake = wire(_Resp(502, None, text="bad gateway"), _Resp(200, done))
        assert kling.query_task("t-1")["task_status"] == "processing"
        assert len(fake.calls) == 2

    def test_poll_give_up_keeps_the_reason(self, monkeypatch):
        monkeypatch.setattr(kling.time, "sleep", lambda s: None)

        def rejected(task_id, path_template=kling.VIDEO_QUERY_PATH):
            raise ConnectorError("Kling rejected the key: access key not found", reason=INVALID_API_KEY)

        monkeypatch.setattr(kling, "query_task", rejected)
        with pytest.raises(ConnectorError, match="consecutive") as ei:
            kling.poll_until_done("t-1")
        assert ei.value.reason == INVALID_API_KEY


class TestCheckKey:
    OK = {"code": 0, "message": "SUCCEED", "data": {"code": 0, "msg": "success"}}

    def test_ok_calls_account_costs_once(self, wire):
        fake = wire(_Resp(200, self.OK))
        result = kling.check_key()
        assert result["ok"] is True
        assert result["default_model"] == DEFAULT_MODEL
        assert result["default_model_ok"] is True
        assert len(fake.calls) == 1
        method, url, kwargs = fake.calls[0]
        assert method == "GET"
        assert url == f"{kling.BASE_URL}/account/costs"  # no /v1: that path 404s
        params = kwargs["params"]
        assert params["end_time"] - params["start_time"] == 7 * 24 * 3600 * 1000
        assert kwargs["headers"]["Authorization"].startswith("Bearer ")

    def test_401_is_invalid_api_key(self, wire):
        fake = wire(_Resp(401, KEY_401))
        with pytest.raises(ConnectorError) as ei:
            kling.check_key()
        assert ei.value.reason == INVALID_API_KEY
        assert "access key not found" in str(ei.value)
        assert len(fake.calls) == 1

    def test_429_is_not_retried(self, wire):
        # The endpoint allows about 1 QPS; a retry would only add to it.
        fake = wire(_Resp(429, RATE_429), _Resp(200, self.OK))
        with pytest.raises(ConnectorError):
            kling.check_key()
        assert len(fake.calls) == 1

    def test_connection_failure_is_unreachable(self, wire):
        fake = wire(_FakeRequests.RequestException("connection refused"), _Resp(200, self.OK))
        with pytest.raises(ConnectorError) as ei:
            kling.check_key()
        assert ei.value.reason == UNREACHABLE
        assert len(fake.calls) == 1

    def test_retired_default_is_reported(self, wire, monkeypatch):
        monkeypatch.setitem(kling.RETIRED_MODELS, DEFAULT_MODEL, "kling-next")
        wire(_Resp(200, self.OK))
        result = kling.check_key()
        assert result["ok"] is True
        assert result["default_model_ok"] is False


# ---------------------------------------------------------------------------
# steps/generate/kling_generate.py — reason → fail() code, message verbatim.
# ---------------------------------------------------------------------------

_STEP = Path(__file__).parent.parent / "steps" / "generate" / "kling_generate.py"


@pytest.fixture
def step():
    spec = importlib.util.spec_from_file_location("kling_generate_step", _STEP)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _run_failing(step, monkeypatch, capsys, argv, error):
    def boom(**kw):
        raise error
    monkeypatch.setattr(step.kling, "generate", boom)
    monkeypatch.setattr(sys, "argv", ["kling_generate.py", *argv])
    with pytest.raises(SystemExit) as ei:
        step.main()
    assert ei.value.code == 1
    return json.loads(capsys.readouterr().err.strip().splitlines()[-1])


_STANDALONE = ["--prompt", "a cat", "--out", "o.mp4"]
_CASES = [
    (ConnectorError("Kling rejected the key: access key not found", reason=INVALID_API_KEY),
     "invalid_api_key"),
    (ConnectorError(OUT_OF_CREDIT, reason=INSUFFICIENT_CREDIT), "insufficient_credit"),
    (ConnectorError("kling-v2-old is retired; use kling-v3-omni", reason=MODEL_RETIRED),
     "model_retired"),
    (ConnectorError("Kling API error (HTTP 500): boom"), "api_error"),
]


@pytest.mark.parametrize("error,code", _CASES)
def test_step_standalone_maps_reason(step, monkeypatch, capsys, error, code):
    err = _run_failing(step, monkeypatch, capsys, _STANDALONE, error)
    assert err == {"error": code, "message": str(error)}


@pytest.mark.parametrize("error,code", _CASES)
def test_step_project_mode_maps_reason(step, monkeypatch, capsys, error, code):
    project = {"storyboard": {"scenes": [{"id": "s1", "duration": 5}]}}
    saved = []
    monkeypatch.setattr(step, "find_project", lambda pid: ("p.json", project))
    monkeypatch.setattr(step, "compose_prompt", lambda p, s: "a cat")
    monkeypatch.setattr(step, "resolve_ref_paths", lambda p, s: [])
    monkeypatch.setattr(step, "save_error_to_project",
                        lambda path, proj, sid, msg: saved.append((sid, msg)))
    err = _run_failing(step, monkeypatch, capsys,
                       ["--project-id", "p", "--scene-id", "s1", "--out", "o.mp4"], error)
    assert err == {"error": code, "message": str(error)}
    assert saved == [("s1", str(error))]


def test_step_mode_defaults_to_pro(step, monkeypatch):
    seen = {}

    def capture(**kw):
        seen.update(kw)
        return kw["out_path"]
    monkeypatch.setattr(step.kling, "generate", capture)
    monkeypatch.setattr(sys, "argv", ["kling_generate.py", *_STANDALONE])
    step.main()
    assert seen["mode"] == "pro"
