"""Tests for connectors.elevenlabs — speech, sound effects and music (PV29 T6)."""
import json as json_module
import os

import pytest

from connectors import ConnectorError


@pytest.fixture(autouse=True)
def _fake_api_key(monkeypatch):
    """Every test in this file supplies its own obviously-fake credential via
    the env var, so nothing here ever depends on (or could accidentally read)
    a real ~/.montaj/credentials.json — this file must pass under any HOME,
    including a fresh one with no credentials file at all."""
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _FakeResponse:
    """Minimal stand-in for a `requests.Response`."""

    def __init__(self, status_code, body=None, content=b""):
        self.status_code = status_code
        self._body = body
        self.text = json_module.dumps(body) if body is not None else ""
        self.content = content

    def json(self):
        if self._body is None:
            raise ValueError("no JSON body")
        return self._body


def _scripted(*responses):
    """A request_with_retry fake that returns each response in order and
    records every call. Used for retry-composition tests, where a single
    canned-response function can't distinguish attempt 1 from attempt 2."""
    remaining = list(responses)
    calls = []

    def fn(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if not remaining:
            raise AssertionError("unexpected extra HTTP call")
        return remaining.pop(0)

    fn.calls = calls
    return fn


_VOICES_BODY = {
    "voices": [
        {"voice_id": "id-george", "name": "George - Warm, Captivating Storyteller"},
        {"voice_id": "id-sarah", "name": "Sarah - Mature, Reassuring, Confident"},
    ]
}

_MODELS_BODY = [
    {"model_id": "eleven_v4", "name": "Eleven v4", "can_do_text_to_speech": True},
    {"model_id": "eleven_v3", "name": "Eleven v3", "can_do_text_to_speech": True},
    {"model_id": "eleven_multilingual_v2", "name": "Multilingual v2", "can_do_text_to_speech": True},
]


# ---------------------------------------------------------------------------
# generate_speech: request shape and voice-name resolution
# ---------------------------------------------------------------------------

class TestGenerateSpeech:
    def test_empty_text_raises(self, tmp_path):
        import connectors.elevenlabs as mod
        with pytest.raises(ConnectorError, match="text must not be empty"):
            mod.generate_speech("", "id-george", str(tmp_path / "out.mp3"))

    def test_whitespace_text_raises(self, tmp_path):
        import connectors.elevenlabs as mod
        with pytest.raises(ConnectorError, match="text must not be empty"):
            mod.generate_speech("   ", "id-george", str(tmp_path / "out.mp3"))

    def test_no_out_path_raises(self):
        import connectors.elevenlabs as mod
        with pytest.raises(ConnectorError, match="out_path is required"):
            mod.generate_speech("hello", "id-george", "")

    def test_voice_name_resolves_and_request_shape(self, monkeypatch, tmp_path):
        """A name ('George') resolves to its voice_id via /v1/voices, and the
        TTS POST carries the resolved voice_id in the URL plus {text, model_id}
        in the body with Accept: audio/mpeg."""
        calls = []

        def fake_retry(method, url, **kwargs):
            calls.append((method, url, kwargs))
            if url.endswith("/v1/voices"):
                return _FakeResponse(200, _VOICES_BODY)
            return _FakeResponse(200, content=b"mp3-bytes")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        out = str(tmp_path / "out.mp3")
        result = mod.generate_speech("Montaj test line.", "george", out)

        assert result == out
        with open(out, "rb") as f:
            assert f.read() == b"mp3-bytes"

        tts_calls = [c for c in calls if "/v1/text-to-speech/" in c[1]]
        assert len(tts_calls) == 1
        method, url, kwargs = tts_calls[0]
        assert method == "POST"
        assert url == f"{mod.BASE}/v1/text-to-speech/id-george"
        assert kwargs["json"] == {"text": "Montaj test line.", "model_id": mod.DEFAULT_TTS_MODEL}
        assert kwargs["headers"]["Accept"] == "audio/mpeg"
        assert kwargs["headers"]["xi-api-key"]

    def test_voice_name_match_is_case_insensitive(self, monkeypatch, tmp_path):
        def fake_retry(method, url, **kwargs):
            if url.endswith("/v1/voices"):
                return _FakeResponse(200, _VOICES_BODY)
            return _FakeResponse(200, content=b"mp3-bytes")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        out = str(tmp_path / "out.mp3")
        mod.generate_speech("hi", "SARAH", out)
        # Resolved without error means id-sarah was matched from "SARAH".

    def test_voice_id_passes_through(self, monkeypatch, tmp_path):
        """A raw voice_id (already in the /v1/voices list) is used as-is,
        not treated as an unresolvable name."""
        seen_urls = []

        def fake_retry(method, url, **kwargs):
            seen_urls.append(url)
            if url.endswith("/v1/voices"):
                return _FakeResponse(200, _VOICES_BODY)
            return _FakeResponse(200, content=b"mp3-bytes")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        out = str(tmp_path / "out.mp3")
        mod.generate_speech("hi", "id-sarah", out)
        assert f"{mod.BASE}/v1/text-to-speech/id-sarah" in seen_urls

    def test_unknown_voice_raises_with_available_names(self, monkeypatch, tmp_path):
        def fake_retry(method, url, **kwargs):
            return _FakeResponse(200, _VOICES_BODY)

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        with pytest.raises(ConnectorError, match="Unknown ElevenLabs voice") as ei:
            mod.generate_speech("hi", "nobody", str(tmp_path / "out.mp3"))
        assert "george" in str(ei.value)
        assert "sarah" in str(ei.value)

    def test_custom_model_passed_through(self, monkeypatch, tmp_path):
        captured = {}

        def fake_retry(method, url, **kwargs):
            if url.endswith("/v1/voices"):
                return _FakeResponse(200, _VOICES_BODY)
            captured["body"] = kwargs.get("json")
            return _FakeResponse(200, content=b"mp3-bytes")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        mod.generate_speech("hi", "id-george", str(tmp_path / "out.mp3"), model="eleven_multilingual_v2")
        assert captured["body"]["model_id"] == "eleven_multilingual_v2"

    def test_wav_out_path_is_retargeted_to_mp3(self, monkeypatch, tmp_path):
        """PV29 review item 10: `_post_audio` writes MP3 bytes to whatever
        out_path says, so `--out bed.wav` wrote an MP3 named .wav. The
        written file must actually be named .mp3, and the .wav path must
        not exist."""
        def fake_retry(method, url, **kwargs):
            if url.endswith("/v1/voices"):
                return _FakeResponse(200, _VOICES_BODY)
            return _FakeResponse(200, content=b"mp3-bytes")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        asked = str(tmp_path / "voiceover.wav")
        result = mod.generate_speech("hi", "id-george", asked)

        assert result == str(tmp_path / "voiceover.mp3")
        assert not os.path.exists(asked)
        with open(result, "rb") as f:
            assert f.read() == b"mp3-bytes"

    def test_401_raises_invalid_api_key(self, monkeypatch, tmp_path):
        def fake_retry(method, url, **kwargs):
            if url.endswith("/v1/voices"):
                return _FakeResponse(200, _VOICES_BODY)
            return _FakeResponse(401, {"detail": {"status": "invalid_api_key", "message": "Invalid API key"}})

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        with pytest.raises(ConnectorError) as ei:
            mod.generate_speech("hi", "id-george", str(tmp_path / "out.mp3"))
        assert ei.value.reason == "invalid_api_key"


# ---------------------------------------------------------------------------
# generate_sfx: duration bounds
# ---------------------------------------------------------------------------

class TestGenerateSfx:
    def test_empty_text_raises(self, tmp_path):
        import connectors.elevenlabs as mod
        with pytest.raises(ConnectorError, match="text must not be empty"):
            mod.generate_sfx("", str(tmp_path / "out.mp3"))

    def test_duration_too_short_raises_before_http(self, monkeypatch, tmp_path):
        def fail_if_called(*a, **kw):
            raise AssertionError("must not call HTTP when duration is out of bounds")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fail_if_called)

        with pytest.raises(ConnectorError, match="duration_seconds must be between"):
            mod.generate_sfx("glass breaking", str(tmp_path / "out.mp3"), duration_seconds=0.1)

    def test_duration_too_long_raises_before_http(self, monkeypatch, tmp_path):
        def fail_if_called(*a, **kw):
            raise AssertionError("must not call HTTP when duration is out of bounds")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fail_if_called)

        with pytest.raises(ConnectorError, match="duration_seconds must be between"):
            mod.generate_sfx("glass breaking", str(tmp_path / "out.mp3"), duration_seconds=31)

    def test_boundary_durations_are_valid(self, monkeypatch, tmp_path):
        captured = []

        def fake_retry(method, url, **kwargs):
            captured.append(kwargs.get("json"))
            return _FakeResponse(200, content=b"sfx-bytes")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        mod.generate_sfx("tick", str(tmp_path / "a.mp3"), duration_seconds=0.5)
        mod.generate_sfx("tock", str(tmp_path / "b.mp3"), duration_seconds=30)
        assert captured[0]["duration_seconds"] == 0.5
        assert captured[1]["duration_seconds"] == 30

    def test_no_duration_omits_field_and_writes_bytes(self, monkeypatch, tmp_path):
        captured = {}

        def fake_retry(method, url, **kwargs):
            captured["json"] = kwargs.get("json")
            captured["url"] = url
            return _FakeResponse(200, content=b"sfx-bytes")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        out = str(tmp_path / "out.mp3")
        result = mod.generate_sfx("glass breaking", out)
        assert result == out
        assert "duration_seconds" not in captured["json"]
        assert captured["json"] == {"text": "glass breaking", "model_id": mod.DEFAULT_SFX_MODEL}
        assert captured["url"] == f"{mod.BASE}/v1/sound-generation"
        with open(out, "rb") as f:
            assert f.read() == b"sfx-bytes"


# ---------------------------------------------------------------------------
# generate_music: length validation and the plan gate
# ---------------------------------------------------------------------------

class TestGenerateMusic:
    def test_empty_prompt_raises(self, tmp_path):
        import connectors.elevenlabs as mod
        with pytest.raises(ConnectorError, match="prompt must not be empty"):
            mod.generate_music("", str(tmp_path / "out.mp3"), length_ms=5000)

    def test_length_below_minimum_raises_before_http(self, monkeypatch, tmp_path):
        def fail_if_called(*a, **kw):
            raise AssertionError("must not call HTTP when length_ms is out of bounds")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fail_if_called)

        with pytest.raises(ConnectorError, match="length_ms must be at least"):
            mod.generate_music("ambient pad", str(tmp_path / "out.mp3"), length_ms=2999)

    def test_wav_out_path_is_retargeted_to_mp3(self, monkeypatch, tmp_path):
        """PV29 review item 10: `generate_music --out bed.wav` wrote an MP3
        named .wav. The written file must actually be named .mp3."""
        def fake_retry(method, url, **kwargs):
            return _FakeResponse(200, content=b"music-bytes")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        asked = str(tmp_path / "bed.wav")
        result = mod.generate_music("ambient pad", asked, length_ms=5000)

        assert result == str(tmp_path / "bed.mp3")
        assert not os.path.exists(asked)
        with open(result, "rb") as f:
            assert f.read() == b"music-bytes"

    def test_request_shape_omits_model_id_by_default(self, monkeypatch, tmp_path):
        captured = {}

        def fake_retry(method, url, **kwargs):
            captured["json"] = kwargs.get("json")
            captured["url"] = url
            return _FakeResponse(200, content=b"music-bytes")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        out = str(tmp_path / "out.mp3")
        result = mod.generate_music("ambient pad", out, length_ms=5000)
        assert result == out
        assert captured["json"] == {"prompt": "ambient pad", "music_length_ms": 5000}
        assert captured["url"] == f"{mod.BASE}/v1/music"
        with open(out, "rb") as f:
            assert f.read() == b"music-bytes"

    def test_explicit_model_is_included(self, monkeypatch, tmp_path):
        captured = {}

        def fake_retry(method, url, **kwargs):
            captured["json"] = kwargs.get("json")
            return _FakeResponse(200, content=b"music-bytes")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        mod.generate_music("ambient pad", str(tmp_path / "out.mp3"), length_ms=5000, model="some-music-model")
        assert captured["json"]["model_id"] == "some-music-model"

    def test_plan_gate_raises_insufficient_credit(self, monkeypatch, tmp_path):
        """The free-plan 402 (code=paid_plan_required) becomes the fixed
        operator-facing message, not the vendor's raw wording."""
        body = {
            "detail": {
                "type": "payment_required",
                "code": "paid_plan_required",
                "message": "Music API is not available for free users. Please upgrade to a paid plan to use the API.",
                "status": "limited_access",
            }
        }

        def fake_retry(method, url, **kwargs):
            return _FakeResponse(402, body)

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        with pytest.raises(ConnectorError) as ei:
            mod.generate_music("ambient pad", str(tmp_path / "out.mp3"), length_ms=5000)
        assert ei.value.reason == "insufficient_credit"
        assert str(ei.value) == "ElevenLabs music needs a paid plan."

    def test_never_retries_the_plan_gate(self, monkeypatch, tmp_path):
        """Billing errors must not be retried — a second call would risk a
        second charge/attempt for something that will never succeed."""
        call_count = {"n": 0}

        def fake_retry(method, url, **kwargs):
            call_count["n"] += 1
            assert kwargs.get("retry_exceptions") is False
            assert 402 not in kwargs.get("retry_statuses", frozenset())
            return _FakeResponse(402, {"detail": {"code": "paid_plan_required", "message": "nope"}})

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        with pytest.raises(ConnectorError):
            mod.generate_music("ambient pad", str(tmp_path / "out.mp3"), length_ms=5000)
        assert call_count["n"] == 1


# ---------------------------------------------------------------------------
# check_key — ok / 401 / music entitlement
# ---------------------------------------------------------------------------

class TestCheckKey:
    def test_ok_paid_plan_default_model_present(self, monkeypatch):
        def fake_retry(method, url, **kwargs):
            if url.endswith("/v1/user"):
                return _FakeResponse(200, {"subscription": {"tier": "creator"}})
            if url.endswith("/v1/models"):
                return _FakeResponse(200, _MODELS_BODY)
            raise AssertionError(f"unexpected URL {url}")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        result = mod.check_key()
        assert result["ok"] is True
        assert result["default_model"] == mod.DEFAULT_TTS_MODEL
        assert result["default_model_ok"] is True
        assert result["music"] is True

    def test_free_plan_music_false(self, monkeypatch):
        def fake_retry(method, url, **kwargs):
            if url.endswith("/v1/user"):
                return _FakeResponse(200, {"subscription": {"tier": "free"}})
            if url.endswith("/v1/models"):
                return _FakeResponse(200, _MODELS_BODY)
            raise AssertionError(f"unexpected URL {url}")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        result = mod.check_key()
        assert result["music"] is False
        assert result["default_model_ok"] is True

    def test_default_model_missing(self, monkeypatch):
        def fake_retry(method, url, **kwargs):
            if url.endswith("/v1/user"):
                return _FakeResponse(200, {"subscription": {"tier": "free"}})
            if url.endswith("/v1/models"):
                return _FakeResponse(200, [{"model_id": "eleven_multilingual_v2", "can_do_text_to_speech": True}])
            raise AssertionError(f"unexpected URL {url}")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        result = mod.check_key()
        assert result["default_model_ok"] is False

    def test_401_raises_invalid_api_key(self, monkeypatch):
        def fake_retry(method, url, **kwargs):
            return _FakeResponse(401, {"detail": {"status": "invalid_api_key", "message": "Invalid API key"}})

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        with pytest.raises(ConnectorError) as ei:
            mod.check_key()
        assert ei.value.reason == "invalid_api_key"

    def test_connection_failure_raises_unreachable(self, monkeypatch):
        def boom(*a, **kw):
            raise ConnectorError("GET https://api.elevenlabs.io/v1/user failed after 3 attempts: timed out")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", boom)

        with pytest.raises(ConnectorError) as ei:
            mod.check_key()
        assert ei.value.reason == "unreachable"

    def test_never_sends_a_real_request(self, monkeypatch):
        """Guard: this test file must never let check_key reach the network."""
        def fail_if_called(*a, **kw):
            raise AssertionError("check_key must not call the real requests module")

        monkeypatch.setattr("connectors._http._require_requests", fail_if_called)

        def fake_retry(method, url, **kwargs):
            if url.endswith("/v1/user"):
                return _FakeResponse(200, {"subscription": {"tier": "free"}})
            return _FakeResponse(200, _MODELS_BODY)

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)
        mod.check_key()  # would raise via fail_if_called if it fell through to real requests


# ---------------------------------------------------------------------------
# 401s: ElevenLabs puts the real meaning in detail.status, not just the HTTP
# code — PV29 T6 follow-up.
# ---------------------------------------------------------------------------

class Test401StatusClassification:
    def test_quota_exceeded_is_insufficient_credit(self, monkeypatch):
        body = {"detail": {"status": "quota_exceeded",
                            "message": "You have run out of credits."}}
        calls = []

        def fake_retry(method, url, **kwargs):
            calls.append(1)
            return _FakeResponse(401, body)

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        with pytest.raises(ConnectorError) as ei:
            mod.check_key()
        assert ei.value.reason == "insufficient_credit"
        assert str(ei.value) == (
            'Your ElevenLabs account is out of credits. '
            'ElevenLabs says: "You have run out of credits."'
        )
        # Only the first (/v1/user) call happens — it raises before /v1/models,
        # and a billing error is never retried.
        assert len(calls) == 1

    def test_missing_permissions_in_generation_is_reason_none_not_invalid_key(self, monkeypatch, tmp_path):
        body = {"detail": {"status": "missing_permissions",
                            "message": "The API key is missing the permission to access this endpoint"}}

        def fake_retry(method, url, **kwargs):
            if url.endswith("/v1/voices"):
                return _FakeResponse(200, _VOICES_BODY)
            return _FakeResponse(401, body)

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        with pytest.raises(ConnectorError) as ei:
            mod.generate_speech("hi", "id-george", str(tmp_path / "out.mp3"))
        assert ei.value.reason is None
        assert "missing the permission" in str(ei.value)

    def test_detected_unusual_activity_is_reason_none(self, monkeypatch):
        body = {"detail": {"status": "detected_unusual_activity",
                            "message": "Unusual activity detected. Please verify your identity."}}

        def fake_retry(method, url, **kwargs):
            return _FakeResponse(401, body)

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        with pytest.raises(ConnectorError) as ei:
            mod.check_key()
        assert ei.value.reason is None
        assert "Unusual activity" in str(ei.value)

    def test_invalid_api_key_status_is_invalid_api_key(self, monkeypatch):
        body = {"detail": {"status": "invalid_api_key", "message": "Invalid API key"}}

        def fake_retry(method, url, **kwargs):
            return _FakeResponse(401, body)

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        with pytest.raises(ConnectorError) as ei:
            mod.check_key()
        assert ei.value.reason == "invalid_api_key"

    def test_unrecognised_401_status_is_invalid_api_key(self, monkeypatch):
        """Only a recognised non-key status (quota_exceeded,
        missing_permissions, detected_unusual_activity) escapes the bad-key
        classification. Anything else — including a status this connector
        has never seen — falls back to invalid_api_key."""
        body = {"detail": {"status": "some_future_status", "message": "no idea"}}

        def fake_retry(method, url, **kwargs):
            return _FakeResponse(401, body)

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        with pytest.raises(ConnectorError) as ei:
            mod.check_key()
        assert ei.value.reason == "invalid_api_key"

    def test_401_with_no_parseable_status_is_invalid_api_key(self, monkeypatch):
        def fake_retry(method, url, **kwargs):
            return _FakeResponse(401, None)  # unparseable body

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        with pytest.raises(ConnectorError) as ei:
            mod.check_key()
        assert ei.value.reason == "invalid_api_key"


# ---------------------------------------------------------------------------
# 429: only a rate-limit status retries — PV29 T6 follow-up.
# ---------------------------------------------------------------------------

class Test429RateLimitClassification:
    def test_too_many_concurrent_requests_is_retried_then_succeeds(self, monkeypatch, tmp_path):
        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod.time, "sleep", lambda s: None)
        fake = _scripted(
            _FakeResponse(429, {"detail": {"status": "too_many_concurrent_requests",
                                            "message": "slow down"}}),
            _FakeResponse(200, content=b"sfx-bytes"),
        )
        monkeypatch.setattr(mod._http, "request_with_retry", fake)

        out = str(tmp_path / "out.mp3")
        result = mod.generate_sfx("glass breaking", out)
        assert result == out
        assert len(fake.calls) == 2

    def test_system_busy_is_retried_then_succeeds(self, monkeypatch, tmp_path):
        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod.time, "sleep", lambda s: None)
        fake = _scripted(
            _FakeResponse(429, {"detail": {"status": "system_busy", "message": "at capacity"}}),
            _FakeResponse(200, content=b"sfx-bytes"),
        )
        monkeypatch.setattr(mod._http, "request_with_retry", fake)

        result = mod.generate_sfx("glass breaking", str(tmp_path / "out.mp3"))
        assert len(fake.calls) == 2

    def test_other_429_status_is_not_retried(self, monkeypatch, tmp_path):
        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod.time, "sleep", lambda s: None)
        fake = _scripted(
            _FakeResponse(429, {"detail": {"status": "some_abuse_signal", "message": "nope"}}),
            _FakeResponse(200, content=b"sfx-bytes"),
        )
        monkeypatch.setattr(mod._http, "request_with_retry", fake)

        with pytest.raises(ConnectorError, match="HTTP 429"):
            mod.generate_sfx("glass breaking", str(tmp_path / "out.mp3"))
        assert len(fake.calls) == 1

    def test_unparseable_429_is_not_retried(self, monkeypatch, tmp_path):
        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod.time, "sleep", lambda s: None)
        fake = _scripted(
            _FakeResponse(429, None),
            _FakeResponse(200, content=b"sfx-bytes"),
        )
        monkeypatch.setattr(mod._http, "request_with_retry", fake)

        with pytest.raises(ConnectorError, match="HTTP 429"):
            mod.generate_sfx("glass breaking", str(tmp_path / "out.mp3"))
        assert len(fake.calls) == 1

    def test_rate_limit_retry_is_bounded(self, monkeypatch, tmp_path):
        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod.time, "sleep", lambda s: None)
        body = {"detail": {"status": "system_busy", "message": "still busy"}}
        fake = _scripted(*[_FakeResponse(429, body) for _ in range(mod._http.RETRY_ATTEMPTS)])
        monkeypatch.setattr(mod._http, "request_with_retry", fake)

        with pytest.raises(ConnectorError, match="HTTP 429"):
            mod.generate_sfx("glass breaking", str(tmp_path / "out.mp3"))
        assert len(fake.calls) == mod._http.RETRY_ATTEMPTS

    def test_never_retries_a_rate_limit_on_a_fresh_call_beyond_the_attempts_cap(self, monkeypatch, tmp_path):
        """A GET (idempotent) also stops retrying at the bound, same as a POST."""
        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod.time, "sleep", lambda s: None)
        body = {"detail": {"status": "too_many_concurrent_requests", "message": "slow down"}}
        fake = _scripted(*[_FakeResponse(429, body) for _ in range(mod._http.RETRY_ATTEMPTS)])
        monkeypatch.setattr(mod._http, "request_with_retry", fake)

        with pytest.raises(ConnectorError, match="HTTP 429"):
            mod.check_key()
        assert len(fake.calls) == mod._http.RETRY_ATTEMPTS


# ---------------------------------------------------------------------------
# check_key: a valid-but-scope-restricted key must never be refused at save
# — PV29 T6 follow-up.
# ---------------------------------------------------------------------------

class TestCheckKeyRestrictedKey:
    def test_user_missing_permissions_ok_with_music_unknown(self, monkeypatch):
        def fake_retry(method, url, **kwargs):
            if url.endswith("/v1/user"):
                return _FakeResponse(401, {"detail": {"status": "missing_permissions",
                                                        "message": "no user_read"}})
            if url.endswith("/v1/models"):
                return _FakeResponse(200, _MODELS_BODY)
            raise AssertionError(f"unexpected URL {url}")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        result = mod.check_key()  # must not raise
        assert result["ok"] is True
        assert result["music"] is None
        assert result["default_model_ok"] is True
        assert "default_model_verified" not in result
        assert result["detail"] == (
            "Key works but can't read the account plan (missing user_read permission)"
        )

    def test_user_restricted_default_model_still_computed_for_real(self, monkeypatch):
        """default_model_ok is computed from the real /v1/models answer when
        that call itself is not restricted — it is only forced True when
        /v1/models is ALSO restricted."""
        def fake_retry(method, url, **kwargs):
            if url.endswith("/v1/user"):
                return _FakeResponse(401, {"detail": {"status": "missing_permissions",
                                                        "message": "no user_read"}})
            if url.endswith("/v1/models"):
                return _FakeResponse(200, [{"model_id": "eleven_multilingual_v2",
                                             "can_do_text_to_speech": True}])
            raise AssertionError(f"unexpected URL {url}")

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        result = mod.check_key()
        assert result["default_model_ok"] is False  # eleven_v4 not in this list
        assert "default_model_verified" not in result

    def test_user_and_models_both_restricted(self, monkeypatch):
        def fake_retry(method, url, **kwargs):
            return _FakeResponse(401, {"detail": {"status": "missing_permissions",
                                                    "message": "no permission"}})

        import connectors.elevenlabs as mod
        monkeypatch.setattr(mod._http, "request_with_retry", fake_retry)

        result = mod.check_key()  # must not raise
        assert result["ok"] is True
        assert result["music"] is None
        assert result["default_model_ok"] is True
        assert result["default_model_verified"] is False
        assert "Key works but can't read the account plan" in result["detail"]
        assert "could not verify" in result["detail"].lower()


# ---------------------------------------------------------------------------
# Module import
# ---------------------------------------------------------------------------

class TestModuleImportsCleanly:
    def test_import(self):
        import connectors.elevenlabs  # noqa: F401
        assert hasattr(connectors.elevenlabs, "generate_speech")
        assert hasattr(connectors.elevenlabs, "generate_sfx")
        assert hasattr(connectors.elevenlabs, "generate_music")
        assert hasattr(connectors.elevenlabs, "check_key")
        assert hasattr(connectors.elevenlabs, "DEFAULT_TTS_MODEL")
