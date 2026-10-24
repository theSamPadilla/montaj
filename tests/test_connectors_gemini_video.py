"""connectors.gemini.generate_video on Gemini Omni Flash through the Interactions API (§550).

The request and answer shapes are Google's documented ones, not captured payloads:
POST /v1beta/interactions with model, input, response_format (ai.google.dev/gemini-api/docs/omni,
read 2026-10-23), the answer's steps[] with a model_output video item (the same page, and
google-genai 2.33.0's own Interaction.output_video walk), and the error body
{"error": {"code", "message"}} with ai.google.dev/gemini-api/docs/api-errors's statuses.
The conftest guard keeps every credential off; each test sets a fake Gemini key."""
import base64
import json

import pytest

from connectors import ConnectorError, _http, CONTENT_REFUSED, INSUFFICIENT_CREDIT, MODEL_RETIRED, UNREACHABLE
import connectors.gemini as gemini

URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
MP4 = b"\x00\x00\x00\x18ftypmp42fake-video"


class _Resp:
    def __init__(self, status=200, body=None, content=b""):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body) if body is not None else ""
        self.content = content

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class _Exc:
    class RequestException(Exception):
        pass

    class ConnectionError(RequestException):
        pass

    class Timeout(RequestException):
        pass

    class ConnectTimeout(ConnectionError, Timeout):
        pass

    class ReadTimeout(Timeout):
        pass


class _FakeRequests:
    exceptions = _Exc
    RequestException = _Exc.RequestException

    def __init__(self):
        self.posts, self.gets, self.post_script, self.get_script = [], [], [], []

    def post(self, url, **kw):
        self.posts.append((url, kw))
        item = self.post_script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def request(self, method, url, **kw):
        assert method == "GET", "only the file checks and the download use _http"
        self.gets.append((url, kw))
        item = self.get_script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture
def fake(monkeypatch):
    f = _FakeRequests()
    monkeypatch.setattr(_http, "_require_requests", lambda: f)
    monkeypatch.setattr(gemini.time, "sleep", lambda s: None)
    monkeypatch.setattr(_http.time, "sleep", lambda s: None)
    monkeypatch.setattr(gemini, "VIDEO_ON", True)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-0000000000")
    return f


def _done(item, usage=None, status="completed"):
    body = {"id": "v1_abc", "status": status, "model": "gemini-omni-1.1-flash", "object": "interaction",
            "steps": [{"type": "user_input", "content": []}, {"type": "thought"},
                      {"type": "model_output", "content": [item]}]}
    if usage:
        body["usage"] = usage
    return _Resp(200, body)


def _inline():
    return {"type": "video", "mime_type": "video/mp4", "data": base64.b64encode(MP4).decode()}


def _png(tmp_path, name):
    p = tmp_path / name
    p.write_bytes(b"\x89PNG fake " + name.encode())
    return str(p)


def _gen(tmp_path, **kw):
    return gemini.generate_video(prompt=kw.pop("prompt", "a red ball rolls"), out_path=str(tmp_path / "o.mp4"), **kw)


class TestRequest:
    def test_text_to_video_is_one_documented_post(self, fake, tmp_path):
        fake.post_script = [_done(_inline())]
        out = _gen(tmp_path, duration=4, aspect_ratio="9:16")
        assert open(out, "rb").read() == MP4
        assert len(fake.posts) == 1
        url, kw = fake.posts[0]
        assert url == URL
        assert kw["headers"]["x-goog-api-key"] == "test-key-0000000000"
        assert kw["timeout"] == (15, gemini.VIDEO_REQUEST_TIMEOUT_S)
        assert kw["json"] == {
            "model": "gemini-omni-1.1-flash",
            "input": "a red ball rolls",
            "response_format": {"type": "video", "aspect_ratio": "9:16", "resolution": "720p",
                                "duration": "4s", "delivery": "inline"},
            "background": False, "store": False, "stream": False,
        }

    @pytest.mark.parametrize("mode", ["text", "image", "refs"])
    def test_inline_delivery_goes_with_store_false(self, fake, tmp_path, mode):
        """§564: Google answers HTTP 400 "store=true is required when response format
        has video delivery set to URI" (app 1.4.3, 2026-10-24). The clip comes back inline
        so the interaction is not stored; a URI would need store true."""
        fake.post_script = [_done(_inline())]
        kw = {"image": {"image_path": _png(tmp_path, "first.png")},
              "refs": {"reference_image_paths": [_png(tmp_path, "r1.png")]}}.get(mode, {})
        _gen(tmp_path, **kw)
        body = fake.posts[0][1]["json"]
        assert body["store"] is False
        assert body["response_format"]["delivery"] == "inline"

    def test_first_frame_then_text(self, fake, tmp_path):
        fake.post_script = [_done(_inline())]
        first = _png(tmp_path, "first.png")
        _gen(tmp_path, image_path=first)
        body = fake.posts[0][1]["json"]
        assert [i["type"] for i in body["input"]] == ["image", "text"]
        assert body["input"][0] == {"type": "image", "mime_type": "image/png",
                                    "data": base64.b64encode(open(first, "rb").read()).decode()}
        assert "generation_config" not in body  # the guide's image-to-video example sets no task

    def test_first_and_last_frame_in_order(self, fake, tmp_path):
        fake.post_script = [_done(_inline())]
        first, last = _png(tmp_path, "a.png"), _png(tmp_path, "b.png")
        _gen(tmp_path, image_path=first, last_frame_path=last)
        body = fake.posts[0][1]["json"]
        datas = [i.get("data") for i in body["input"][:2]]
        assert datas == [base64.b64encode(open(p, "rb").read()).decode() for p in (first, last)]
        assert "generation_config" not in body

    def test_reference_images_say_so(self, fake, tmp_path):
        fake.post_script = [_done(_inline())]
        refs = [_png(tmp_path, "r1.png"), _png(tmp_path, "r2.png")]
        _gen(tmp_path, reference_image_paths=refs)
        body = fake.posts[0][1]["json"]
        assert [i["type"] for i in body["input"]] == ["image", "image", "text"]
        assert body["generation_config"]["video_config"]["task"] == "reference_to_video"

    def test_negative_prompt_goes_in_the_prompt(self, fake, tmp_path):
        fake.post_script = [_done(_inline())]
        _gen(tmp_path, negative_prompt="blur")
        assert fake.posts[0][1]["json"]["input"] == "a red ball rolls\n\nAvoid: blur"

    @pytest.mark.parametrize("kw", [{"duration": 11}, {"duration": 2}, {"resolution": "1080p"},
                                    {"model": "veo-3.1-generate-preview"}, {"aspect_ratio": "1:1"}])
    def test_a_bad_request_sends_nothing(self, fake, tmp_path, kw):
        with pytest.raises(ConnectorError):
            _gen(tmp_path, **kw)
        assert fake.posts == []

    def test_a_missing_key_sends_nothing(self, fake, tmp_path, monkeypatch):
        from lib.credentials import MissingCredentialError
        monkeypatch.delenv("GEMINI_API_KEY")
        with pytest.raises(MissingCredentialError):
            _gen(tmp_path)
        assert fake.posts == []

    def test_the_billed_request_is_never_retried(self, fake, tmp_path):
        fake.post_script = [_Resp(503, {"error": {"code": "service_unavailable", "message": "try later"}})]
        with pytest.raises(ConnectorError):
            _gen(tmp_path)
        assert len(fake.posts) == 1

    def test_progress_reports_the_price_and_the_tokens_used(self, fake, tmp_path, capsys):
        fake.post_script = [_done(_inline(), usage={"total_output_tokens": 46336})]
        _gen(tmp_path, duration=8)
        lines = [json.loads(line)["progress"] for line in capsys.readouterr().err.splitlines() if line.strip()]
        assert any("about $0.80" in line for line in lines)
        assert any("46336 output tokens, about $0.81" in line for line in lines)


class TestDelivery:
    def test_uri_delivery_waits_for_active_then_downloads(self, fake, tmp_path):
        """Never asked for (inline is, §564), but a URI answer is still collected."""
        uri = "https://generativelanguage.googleapis.com/v1beta/files/abc123:download?alt=media"
        fake.post_script = [_done({"type": "video", "mime_type": "video/mp4", "uri": uri})]
        fake.get_script = [_Resp(200, {"name": "files/abc123", "state": "PROCESSING"}),
                           _Resp(200, {"name": "files/abc123", "state": "ACTIVE"}),
                           _Resp(200, None, content=MP4)]
        out = _gen(tmp_path)
        assert open(out, "rb").read() == MP4
        assert [u for u, _ in fake.gets] == [
            "https://generativelanguage.googleapis.com/v1beta/files/abc123",
            "https://generativelanguage.googleapis.com/v1beta/files/abc123",
            uri,
        ]
        assert all(kw["headers"]["x-goog-api-key"] == "test-key-0000000000" for _, kw in fake.gets)

    def test_a_failed_file_says_so(self, fake, tmp_path):
        fake.post_script = [_done({"type": "video", "uri": "https://x/v1beta/files/f1:download?alt=media"})]
        fake.get_script = [_Resp(200, {"state": "FAILED"})]
        with pytest.raises(ConnectorError, match="failed on Google's side"):
            _gen(tmp_path)

    def test_a_failed_download_says_it_was_charged(self, fake, tmp_path):
        fake.post_script = [_done({"type": "video", "uri": "https://x/v1beta/files/f1:download?alt=media"})]
        fake.get_script = [_Resp(200, {"state": "ACTIVE"})] + [_Resp(500, None)] * gemini.VIDEO_DOWNLOAD_ATTEMPTS
        with pytest.raises(ConnectorError, match="charged, so don't regenerate"):
            _gen(tmp_path)
        assert not (tmp_path / "o.mp4").exists()

    def test_no_video_in_the_answer(self, fake, tmp_path):
        fake.post_script = [_Resp(200, {"status": "completed", "steps": [{"type": "model_output", "content": []}]})]
        with pytest.raises(ConnectorError, match="no video. It may have been charged"):
            _gen(tmp_path)

    def test_the_short_file_uri_form(self, fake, tmp_path):
        """The guide's own example names the file "files/<id>"; both URLs are built from the id."""
        fake.post_script = [_done({"type": "video", "uri": "files/abc-123"})]
        fake.get_script = [_Resp(200, {"state": "ACTIVE"}), _Resp(200, None, content=MP4)]
        assert open(_gen(tmp_path), "rb").read() == MP4
        assert [u for u, _ in fake.gets] == [
            "https://generativelanguage.googleapis.com/v1beta/files/abc-123",
            "https://generativelanguage.googleapis.com/v1beta/files/abc-123:download?alt=media",
        ]

    def test_the_key_never_goes_to_another_host(self, fake, tmp_path):
        fake.post_script = [_done({"type": "video", "uri": "https://evil.example/v1beta/files/x1:download?alt=media"})]
        fake.get_script = [_Resp(200, {"state": "ACTIVE"}), _Resp(200, None, content=MP4)]
        _gen(tmp_path)
        assert all(u.startswith("https://generativelanguage.googleapis.com/") for u, _ in fake.gets)

    def test_a_file_check_that_keeps_failing_says_it_was_charged(self, fake, tmp_path):
        fake.post_script = [_done({"type": "video", "uri": "files/f1"})]
        fake.get_script = [_Exc.ConnectionError("reset")] * _http.RETRY_ATTEMPTS
        with pytest.raises(ConnectorError, match="could not be checked.*It may have been charged"):
            _gen(tmp_path)

    def test_the_deadline_stops_the_wait(self, fake, tmp_path, monkeypatch):
        clock = iter([0.0] + [gemini.VIDEO_DEADLINE_S + 1.0] * 50)
        monkeypatch.setattr(gemini.time, "monotonic", lambda: next(clock))
        fake.post_script = [_done({"type": "video", "uri": "files/f1"})]
        with pytest.raises(ConnectorError, match="not ready in time.*It may have been charged"):
            _gen(tmp_path)
        assert fake.gets == []


class TestErrors:
    def _err(self, fake, tmp_path, status, code, message):
        fake.post_script = [_Resp(status, {"error": {"code": code, "message": message}})]
        with pytest.raises(ConnectorError) as ei:
            _gen(tmp_path)
        return ei.value

    @pytest.mark.parametrize("status, code, message", [
        (401, "authentication", "API key missing, invalid, or expired."),
        (400, "invalid_request", "API key not valid. Please pass a valid API key."),
    ])
    def test_a_rejected_key(self, fake, tmp_path, status, code, message):
        e = self._err(fake, tmp_path, status, code, message)
        assert e.reason == "invalid_api_key"
        assert str(e) == f"{gemini.INVALID_API_KEY_MESSAGE} Google said: {message}"

    def test_a_zero_quota_means_no_billing(self, fake, tmp_path):
        e = self._err(fake, tmp_path, 429, "quota_exceeded", "Quota exceeded, limit: 0")
        assert e.reason == INSUFFICIENT_CREDIT

    def test_a_reached_quota(self, fake, tmp_path):
        e = self._err(fake, tmp_path, 429, "rate_limit_exceeded", "Too many requests")
        assert e.reason is None and "quota was reached" in str(e)

    def test_payment_required(self, fake, tmp_path):
        assert self._err(fake, tmp_path, 402, "payment_required", "Billing required").reason == INSUFFICIENT_CREDIT

    def test_model_not_found(self, fake, tmp_path):
        assert self._err(fake, tmp_path, 404, "model_not_found", "not found").reason == MODEL_RETIRED

    def test_a_safety_block(self, fake, tmp_path):
        e = self._err(fake, tmp_path, 400, "safety", "Safety violations blocked the request")
        assert e.reason == CONTENT_REFUSED and "safety" in str(e)

    @pytest.mark.parametrize("code", ["content_blocked", "image_safety", "prohibited_content", "spii"])
    def test_a_blocked_code_is_a_refusal_whatever_the_message(self, fake, tmp_path, code):
        assert self._err(fake, tmp_path, 400, code, "Request could not be completed").reason == CONTENT_REFUSED

    def test_a_failed_interaction_with_a_uri_code_is_a_refusal(self, fake, tmp_path):
        fake.post_script = [_Resp(200, {"status": "failed", "errors": [
            {"code": "https://generativelanguage.googleapis.com/errors/image_other", "message": "Could not be completed"}]})]
        with pytest.raises(ConnectorError) as ei:
            _gen(tmp_path)
        assert ei.value.reason == CONTENT_REFUSED

    def test_a_failed_interaction_otherwise_says_it_was_charged(self, fake, tmp_path):
        fake.post_script = [_Resp(200, {"status": "failed", "errors": [{"code": "api_error", "message": "internal"}]})]
        with pytest.raises(ConnectorError, match="failed on Google's side.*It may have been charged"):
            _gen(tmp_path)

    def test_a_5xx_says_it_may_be_charged_and_a_4xx_does_not(self, fake, tmp_path):
        assert "may have been charged" in str(self._err(fake, tmp_path, 504, "deadline_exceeded", "late"))
        assert "charged" not in str(self._err(fake, tmp_path, 400, "invalid_request", "bad field"))

    def test_a_dropped_connection_says_it_may_be_charged(self, fake, tmp_path):
        fake.post_script = [_Exc.ConnectionError("('Connection aborted.', RemoteDisconnected())")]
        with pytest.raises(ConnectorError) as ei:
            _gen(tmp_path)
        assert ei.value.reason is None and "may have been charged" in str(ei.value)

    def test_a_failed_interaction_on_safety(self, fake, tmp_path):
        fake.post_script = [_Resp(200, {"status": "failed", "errors": [
            {"code": "safety", "message": "The prompt was blocked by the usage policy"}]})]
        with pytest.raises(ConnectorError) as ei:
            _gen(tmp_path)
        assert ei.value.reason == CONTENT_REFUSED

    def test_a_key_shaped_token_never_reaches_the_message(self, fake, tmp_path):
        e = self._err(fake, tmp_path, 500, "internal", "boom AIzaSyFAKEFAKEFAKEFAKEFAKE")
        assert "AIza" not in str(e)

    def test_a_read_timeout_says_it_may_be_charged(self, fake, tmp_path):
        fake.post_script = [_Exc.ReadTimeout("read timed out")]
        with pytest.raises(ConnectorError) as ei:
            _gen(tmp_path)
        assert ei.value.reason is None and "may have been charged" in str(ei.value)
        assert len(fake.posts) == 1

    def test_a_connect_timeout_is_unreachable(self, fake, tmp_path):
        fake.post_script = [_Exc.ConnectTimeout("connect timed out")]
        with pytest.raises(ConnectorError) as ei:
            _gen(tmp_path)
        assert ei.value.reason == UNREACHABLE
