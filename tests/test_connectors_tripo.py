"""Tests for connectors.tripo (Tripo's v3 task API), no network.

HTTP is mocked at the `requests` layer (`_http._require_requests`), as in
test_connectors_kinovi.py, so the real retry helper and download run against a
scripted fake. An autouse fixture wires an empty script by default: any call a
test did not script fails the test instead of reaching Tripo.

Fixtures are copied from Tripo's own docs (developers.tripo3d.ai/en/docs/<page>,
read 2026-10-13) and say which page. Where the docs show no payload, the fixture
is built from the documented envelope and says so: a fixture is an assumption
written down, not a capture (CLAUDE.md, "MEASURED may have measured a fixture").
"""
import json
from pathlib import Path

import pytest

from connectors import (ConnectorError, _http, INVALID_API_KEY, INSUFFICIENT_CREDIT,
                        CONTENT_REFUSED, MODEL_RETIRED, UNREACHABLE)
from connectors import tripo
from lib.credentials import CredentialError

API = tripo.API


class _FakeResponse:
    def __init__(self, status_code=200, body=None, content=b"", headers=None):
        self.status_code = status_code
        self._body = body
        self._content = content
        self.headers = headers or {}
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
    monkeypatch.setenv("TRIPO_API_KEY", "test-key")
    f = _FakeRequests()
    monkeypatch.setattr(_http, "_require_requests", lambda: f)
    return f


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    """A fake monotonic clock: it moves only when something sleeps (or a test moves it)."""
    now = [1000.0]
    monkeypatch.setattr(tripo.time, "monotonic", lambda: now[0])
    return now


@pytest.fixture(autouse=True)
def sleeps(monkeypatch, clock):
    """Every sleep (the transport's backoff and the connector's own), recorded and
    skipped; each one moves the fake clock by its length."""
    slept = []

    def sleep(seconds):
        slept.append(seconds)
        clock[0] += seconds
    monkeypatch.setattr(tripo.time, "sleep", sleep)
    return slept


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

# documented example, developers.tripo3d.ai/en/docs/files.md, read 2026-10-13
UPLOAD_OK = {"code": 0, "data": {"file_token": "file_abc123"}}

# documented example, developers.tripo3d.ai/en/docs/generation-image-to-model.md, read 2026-10-13
CREATE_OK = {"code": 0, "data": {"task_id": "task_abc123"}}

# documented example, developers.tripo3d.ai/en/docs/task-query.md, read 2026-10-13
TASK_SUCCESS = {
    "code": 0,
    "data": {
        "task_id": "task_abc123",
        "type": "text_to_model",
        "status": "success",
        "progress": 100,
        "output": {
            "model_url": "https://cdn.tripo3d.ai/output/model_pbr.glb",
            "rendered_image_url": "https://cdn.tripo3d.ai/output/preview.png",
        },
        "credits_consumed": 100.00,
        "created_at": "2026-04-28T12:00:00Z",
        "completed_at": "2026-04-28T12:01:30Z",
    },
}


def _task(status, **fields):
    """The documented task shape (task-query.md, above) with another status and
    fields. The docs show no payload for queued, running, failed, banned, expired
    or cancelled: only the status table (task-lifecycle.md) and the field list
    (task-query.md: error_code and error_message are present when failed), so
    these are built from the documented shape, not captured."""
    data = {"task_id": "task_abc123", "type": "image_to_model", "status": status,
            "progress": 0, "created_at": "2026-04-28T12:00:00Z"}
    data.update(fields)
    return _FakeResponse(200, {"code": 0, "data": data})


# documented example, developers.tripo3d.ai/en/docs/billing.md, read 2026-10-13
BALANCE = {"code": 0, "data": {"balance": 10000.00, "frozen": 200.00}}

# documented example, developers.tripo3d.ai/en/docs/error-handling.md, read 2026-10-13
ERR_INSUFFICIENT = {
    "code": 2010,
    "message": "Insufficient credits",
    "suggestion": "Please top up your account at https://platform.tripo3d.ai",
    "request_id": "req_abc123",
}

# documented example, developers.tripo3d.ai/en/docs/rate-limits.md, read 2026-10-13
ERR_RATE_LIMIT = {
    "code": 1007,
    "message": "Rate limit exceeded, you've generated too many requests in a short amount of time",
    "suggestion": "Please wait for a while and try again",
}

# documented example, developers.tripo3d.ai/en/docs/rate-limits.md, read 2026-10-13
ERR_CONCURRENCY = {
    "code": 2000,
    "message": "You have exceeded the limit of generation",
    "suggestion": "Try again later. You can also check `Retry-After` header.",
}


def _error_body(code, message):
    """The documented unified error envelope {code, message, suggestion}
    (error-handling.md) with the message the error-code table gives for `code`.
    The docs show no response body for these codes, only the table, so the
    wording is the table's meaning, not a captured payload."""
    return {"code": code, "message": message, "suggestion": "see the Tripo error code reference"}


ERR_INVALID_KEY = _error_body(1000, "Invalid API Key")
ERR_UNAUTHORIZED = _error_body(1001, "Unauthorized")
ERR_CONTENT = _error_body(2008, "Content policy violation")
ERR_DEPRECATED = _error_body(2015, "Version deprecated")

# Built from the documented envelope (error-handling.md, read 2026-10-13): the docs
# show no body for 2002, only its table row, so the message and suggestion are that
# row's "Meaning" and "Recommended Handling", not a captured payload.
ERR_UNSUPPORTED_PARAM = {
    "code": 2002,
    "message": "Unsupported request parameter",
    "suggestion": "Check whether request body field names and values match the documentation",
}


# ---------------------------------------------------------------------------
# Constants and the key
# ---------------------------------------------------------------------------

def test_constants():
    assert tripo.API == "https://openapi.tripo3d.ai/v3"
    assert tripo.DEFAULT_MODEL == "v3.1-20260211"


def test_tripo_is_a_registered_provider():
    from lib.credentials import KNOWN_PROVIDERS, build_env_overlay
    from cli.commands.credentials import _PROVIDER_INFO
    assert KNOWN_PROVIDERS["tripo"] == ["api_key"]
    assert build_env_overlay({"tripo": {"api_key": "k"}}) == {"TRIPO_API_KEY": "k"}
    assert set(_PROVIDER_INFO["tripo"]["keys"]) == {"api_key"} and _PROVIDER_INFO["tripo"]["display"] == "Tripo"
    # Tripo's own pricing page links this as "Get API key".
    assert _PROVIDER_INFO["tripo"]["url"] == "https://developers.tripo3d.ai/en/keys"


def test_a_missing_key_fails_before_any_call(fake, monkeypatch, tmp_path):
    monkeypatch.delenv("TRIPO_API_KEY")
    monkeypatch.setattr("lib.credentials.CREDENTIALS_PATH", str(tmp_path / "no-credentials.json"))
    with pytest.raises(CredentialError, match="Tripo needs an API key") as e:
        tripo.check_key()
    assert "TRIPO_API_KEY" in str(e.value)
    assert fake.calls == []


# ---------------------------------------------------------------------------
# check_key
# ---------------------------------------------------------------------------

def test_check_key_reads_the_balance_with_the_bearer_key(fake):
    fake.script = [_FakeResponse(200, BALANCE)]
    result = tripo.check_key()
    method, url, kw = fake.calls[0]
    assert (method, url) == ("GET", f"{API}/account/balance")
    assert kw["headers"] == {"Authorization": "Bearer test-key"}
    assert result == {
        "ok": True, "default_model": "v3.1-20260211", "default_model_ok": True,
        "default_model_verified": False, "credits": 10000.0, "frozen": 200.0,
        "detail": "balance 10000 credits",
    }
    assert isinstance(result["credits"], float)


def test_check_key_keeps_the_decimals_of_a_balance(fake):
    fake.script = [_FakeResponse(200, {"code": 0, "data": {"balance": 48.25}})]
    result = tripo.check_key()
    assert result["credits"] == 48.25 and result["detail"] == "balance 48.25 credits"
    assert "frozen" not in result


def test_check_key_rejected_and_unreachable(fake):
    fake.script = [_FakeResponse(401, ERR_INVALID_KEY)]
    with pytest.raises(ConnectorError) as e:
        tripo.check_key()
    assert e.value.reason == INVALID_API_KEY
    fake.script = [_FakeRequestException("down")] * 3
    with pytest.raises(ConnectorError) as e:
        tripo.check_key()
    assert e.value.reason == UNREACHABLE and "Tripo" in str(e.value)


def test_check_key_answers_a_429_at_once_without_retry_after_waits(fake, sleeps):
    # The app gives a key check 20 s: three Retry-After waits (up to 30 s each) would outlast it.
    fake.script = [_FakeResponse(429, ERR_RATE_LIMIT, headers={"Retry-After": "30"})]
    with pytest.raises(ConnectorError, match=r"Tripo is busy: it refused the key check \(Rate limit"):
        tripo.check_key()
    assert len(fake.calls) == 1 and sleeps == []


def test_a_200_that_is_not_json_is_not_a_good_key(fake):
    fake.script = [_FakeResponse(200, content=b"<html>proxy</html>")]
    with pytest.raises(ConnectorError, match="unreadable response") as e:
        tripo.check_key()
    assert e.value.reason == UNREACHABLE


# ---------------------------------------------------------------------------
# Error mapping
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("status,body", [
    (401, ERR_INVALID_KEY),
    (401, ERR_UNAUTHORIZED),
    (401, None),            # a 401 decides on its own, whatever the body
    (400, ERR_INVALID_KEY),  # the codes decide on their own too; the docs pair no status with them
    (403, ERR_UNAUTHORIZED),
])
def test_a_rejected_key_says_where_keys_come_from(fake, status, body):
    fake.script = [_FakeResponse(status, body)]
    with pytest.raises(ConnectorError) as e:
        tripo.check_key()
    assert e.value.reason == INVALID_API_KEY
    message = str(e.value)
    assert "Tripo rejected the API key" in message and "tripo3d.ai" in message and "China" in message


@pytest.mark.parametrize("status", [403, 400, 200])
def test_insufficient_credit_by_code_whatever_the_status(fake, status):
    # error-handling.md: HTTP 403 means "no permission, or your credits are insufficient".
    fake.script = [_FakeResponse(status, ERR_INSUFFICIENT)]
    with pytest.raises(ConnectorError) as e:
        tripo.create("/generation/image-to-model", {"input": "file_abc123"})
    assert e.value.reason == INSUFFICIENT_CREDIT
    assert "Tripo" in str(e.value) and "credit" in str(e.value)


def test_another_403_keeps_tripos_message(fake):
    fake.script = [_FakeResponse(403, _error_body(2004, "Unsupported file type"))]
    with pytest.raises(ConnectorError) as e:
        tripo.create("/generation/image-to-model", {"input": "file_abc123"})
    assert e.value.reason is None
    assert "Tripo" in str(e.value) and "Unsupported file type" in str(e.value)


def test_content_policy_code_is_content_refused(fake):
    fake.script = [_FakeResponse(400, ERR_CONTENT)]
    with pytest.raises(ConnectorError, match="Tripo's content policy refused the input") as e:
        tripo.create("/generation/text-to-model", {"prompt": "x"})
    assert e.value.reason == CONTENT_REFUSED


def test_deprecated_version_is_model_retired(fake):
    fake.script = [_FakeResponse(400, ERR_DEPRECATED)]
    with pytest.raises(ConnectorError, match="deprecated") as e:
        tripo.create("/generation/text-to-model", {"prompt": "x"})
    assert e.value.reason == MODEL_RETIRED and "Tripo" in str(e.value)


def test_any_other_error_carries_tripos_message_and_suggestion(fake):
    fake.script = [_FakeResponse(400, ERR_UNSUPPORTED_PARAM)]
    with pytest.raises(ConnectorError) as e:
        tripo.create("/generation/text-to-model", {"promt": "x"})
    message = str(e.value)
    assert e.value.reason is None
    assert message.startswith("Tripo") and "code 2002" in message
    assert "Unsupported request parameter" in message and "field names and values" in message


def test_a_5xx_is_unreachable_after_the_transport_retries(fake):
    fake.script = [_FakeResponse(503)] * 3
    with pytest.raises(ConnectorError, match="Tripo") as e:
        tripo.check_key()
    assert e.value.reason == UNREACHABLE
    assert len(fake.calls) == 3


# A submit whose answer was lost may already be a paid task. UNREACHABLE's remedy
# (run the step again) would pay twice, so none of these carries it.

def test_a_5xx_on_submit_is_not_repeated_and_says_to_check_the_console(fake):
    fake.script = [_FakeResponse(500)]
    with pytest.raises(ConnectorError) as e:
        tripo.create("/generation/text-to-model", {"prompt": "x"})
    assert e.value.reason is None and len(fake.calls) == 1
    assert "The task may exist: check the Tripo console before running again" in str(e.value)
    assert "try again shortly" not in str(e.value)


def test_a_timed_out_submit_is_not_retried_and_says_it_may_exist(fake):
    fake.script = [_FakeRequestException("read timed out")]
    with pytest.raises(ConnectorError, match="The task may exist: check the Tripo console before running again") as e:
        tripo.create("/generation/text-to-model", {"prompt": "x"})
    assert e.value.reason is None and len(fake.calls) == 1


def test_an_unreadable_200_on_submit_says_it_may_exist(fake):
    fake.script = [_FakeResponse(200, content=b"<html>proxy</html>")]
    with pytest.raises(ConnectorError, match="unreadable response.*The task may exist: check the Tripo console") as e:
        tripo.create("/generation/text-to-model", {"prompt": "x"})
    assert e.value.reason is None and len(fake.calls) == 1


# ---------------------------------------------------------------------------
# 429: wait for the server's Retry-After, a few times
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("body", [ERR_RATE_LIMIT, ERR_CONCURRENCY])
def test_a_429_is_repeated_after_retry_after_then_succeeds(fake, sleeps, body):
    fake.script = [_FakeResponse(429, body, headers={"Retry-After": "7"}), _FakeResponse(200, CREATE_OK)]
    assert tripo.create("/generation/image-to-model", {"input": "file_abc123"}) == "task_abc123"
    assert sleeps == [7.0]
    assert len(fake.calls) == 2 and fake.calls[0][2]["json"] == fake.calls[1][2]["json"]


def test_retry_after_defaults_to_five_seconds_and_is_capped(fake, sleeps):
    fake.script = [_FakeResponse(429, ERR_RATE_LIMIT),
                   _FakeResponse(429, ERR_RATE_LIMIT, headers={"Retry-After": "600"}),
                   _FakeResponse(429, ERR_RATE_LIMIT, headers={"Retry-After": "soon"}),
                   _FakeResponse(200, CREATE_OK)]
    tripo.create("/generation/image-to-model", {"input": "file_abc123"})
    assert sleeps == [5.0, 30.0, 5.0]


def test_the_codes_alone_count_as_busy(fake, sleeps):
    # rate-limits.md pairs 1007 and 2000 with HTTP 429; the codes are enough here.
    fake.script = [_FakeResponse(400, ERR_CONCURRENCY), _FakeResponse(200, CREATE_OK)]
    assert tripo.create("/generation/image-to-model", {"input": "file_abc123"}) == "task_abc123"
    assert sleeps == [5.0]


def test_a_429_that_keeps_coming_says_tripo_is_busy(fake, sleeps):
    refusals = tripo.BUSY_RETRIES + 1
    fake.script = [_FakeResponse(429, ERR_CONCURRENCY, headers={"Retry-After": "2"})] * refusals
    with pytest.raises(ConnectorError, match="Tripo is busy") as e:
        tripo.create("/generation/image-to-model", {"input": "file_abc123"})
    assert e.value.reason is None
    assert len(fake.calls) == refusals and sleeps == [2.0] * tripo.BUSY_RETRIES


# ---------------------------------------------------------------------------
# upload
# ---------------------------------------------------------------------------

def test_upload_sends_the_file_as_multipart_field_file(fake, tmp_path):
    img = tmp_path / "photo.PNG"
    img.write_bytes(b"\x89PNG-bytes")
    fake.script = [_FakeResponse(200, UPLOAD_OK)]
    assert tripo.upload(str(img)) == "file_abc123"
    method, url, kw = fake.calls[0]
    assert (method, url) == ("POST", f"{API}/files")
    assert kw["headers"] == {"Authorization": "Bearer test-key"}, "no Content-Type: requests sets the boundary"
    assert kw["files"] == {"file": ("photo.PNG", b"\x89PNG-bytes", "image/png")}


def test_upload_takes_models_too(fake, tmp_path):
    glb = tmp_path / "robot.glb"
    glb.write_bytes(b"glTF")
    fake.script = [_FakeResponse(200, UPLOAD_OK)]
    assert tripo.upload(str(glb)) == "file_abc123"
    assert fake.calls[0][2]["files"]["file"][0] == "robot.glb"


@pytest.mark.parametrize("name", ["photo.webp", "clip.mp4", "model.usdz", "noextension"])
def test_upload_refuses_a_type_tripo_does_not_take(fake, tmp_path, name):
    p = tmp_path / name
    p.write_bytes(b"x")
    with pytest.raises(ConnectorError, match="Tripo takes images as JPEG or PNG and models as GLB"):
        tripo.upload(str(p))
    assert fake.calls == []


@pytest.mark.parametrize("name,limit_mb", [("big.jpg", 20), ("big.png", 20), ("big.glb", 150), ("big.fbx", 150)])
def test_upload_refuses_a_file_over_its_limit_without_reading_it(fake, tmp_path, name, limit_mb):
    p = tmp_path / name
    with open(p, "wb") as f:
        f.truncate(limit_mb * 1024 * 1024 + 1)   # sparse: nothing is written or read
    with pytest.raises(ConnectorError, match=f"up to {limit_mb} MB") as e:
        tripo.upload(str(p))
    assert "Tripo" in str(e.value)
    assert fake.calls == []


def test_upload_at_the_limit_is_allowed(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(tripo, "MAX_IMAGE_BYTES", 4)
    p = tmp_path / "ok.jpg"
    p.write_bytes(b"1234")
    fake.script = [_FakeResponse(200, UPLOAD_OK)]
    assert tripo.upload(str(p)) == "file_abc123"


def test_upload_refuses_an_empty_or_missing_file(fake, tmp_path):
    empty = tmp_path / "empty.png"
    empty.write_bytes(b"")
    with pytest.raises(ConnectorError, match="file is empty"):
        tripo.upload(str(empty))
    with pytest.raises(ConnectorError, match="Could not read"):
        tripo.upload(str(tmp_path / "missing.png"))
    assert fake.calls == []


def test_upload_without_a_token_in_the_answer(fake, tmp_path):
    p = tmp_path / "a.png"
    p.write_bytes(b"x")
    fake.script = [_FakeResponse(200, {"code": 0, "data": {}})]
    with pytest.raises(ConnectorError, match="no file_token"):
        tripo.upload(str(p))


# ---------------------------------------------------------------------------
# create
# ---------------------------------------------------------------------------

def test_create_posts_the_body_to_the_endpoint_and_returns_the_task_id(fake):
    body = {"input": "file_abc123", "model": tripo.DEFAULT_MODEL}
    fake.script = [_FakeResponse(200, CREATE_OK)]
    assert tripo.create("/generation/image-to-model", body) == "task_abc123"
    method, url, kw = fake.calls[0]
    assert (method, url) == ("POST", f"{API}/generation/image-to-model")
    assert kw["json"] == body
    assert kw["headers"] == {"Authorization": "Bearer test-key"}


def test_create_without_a_task_id_in_the_answer(fake):
    fake.script = [_FakeResponse(200, {"code": 0, "data": {}})]
    with pytest.raises(ConnectorError, match="no task_id"):
        tripo.create("/generation/text-to-model", {"prompt": "x"})


def test_create_refuses_a_bad_endpoint_before_any_call(fake):
    with pytest.raises(ConnectorError, match="starting with '/'"):
        tripo.create("generation/text-to-model", {"prompt": "x"})
    assert fake.calls == []


# ---------------------------------------------------------------------------
# wait
# ---------------------------------------------------------------------------

def test_wait_polls_queued_running_success(fake, sleeps):
    fake.script = [_task("queued"), _task("running", progress=50), _FakeResponse(200, TASK_SUCCESS)]
    task = tripo.wait("task_abc123")
    assert task["status"] == "success" and task["output"]["model_url"].endswith("model_pbr.glb")
    assert [c[:2] for c in fake.calls] == [("GET", f"{API}/tasks/task_abc123")] * 3
    assert fake.calls[0][2]["headers"] == {"Authorization": "Bearer test-key"}
    assert sleeps == [tripo.POLL_INTERVAL_S] * 2


def test_wait_failed_names_the_error_code_and_message(fake):
    fake.script = [_task("failed", error_code=2018, error_message="Model too complex")]
    with pytest.raises(ConnectorError, match=r"Tripo task task_abc123 failed \(2018: Model too complex\)") as e:
        tripo.wait("task_abc123")
    assert e.value.reason is None


@pytest.mark.parametrize("code", [2008, "2008"])
def test_wait_failed_on_content_policy_is_content_refused(fake, code):
    fake.script = [_task("failed", error_code=code, error_message="Content policy violation")]
    with pytest.raises(ConnectorError, match="Tripo's content policy refused task task_abc123") as e:
        tripo.wait("task_abc123")
    assert e.value.reason == CONTENT_REFUSED
    assert "2008" in str(e.value) and "not charged" in str(e.value)


def test_wait_failed_without_an_error_code(fake):
    fake.script = [_task("failed")]
    with pytest.raises(ConnectorError, match="Tripo task task_abc123 failed. A failed task is not charged"):
        tripo.wait("task_abc123")


def test_wait_banned_is_content_refused(fake):
    fake.script = [_task("banned")]
    with pytest.raises(ConnectorError, match="content policy") as e:
        tripo.wait("task_abc123")
    assert e.value.reason == CONTENT_REFUSED and "Tripo" in str(e.value)


def test_wait_expired_says_the_output_is_gone(fake):
    fake.script = [_task("expired")]
    with pytest.raises(ConnectorError, match="expired.*no longer available") as e:
        tripo.wait("task_abc123")
    assert e.value.reason is None


def test_wait_cancelled(fake):
    fake.script = [_task("cancelled")]
    with pytest.raises(ConnectorError, match="Tripo task task_abc123 was cancelled"):
        tripo.wait("task_abc123")


def test_an_unknown_status_is_still_running_until_the_timeout_names_the_task(fake, monkeypatch):
    monkeypatch.setattr(tripo, "MAX_POLL_S", 15.0)
    fake.script = [_task("warming_up"), _task("warming_up"), _task("warming_up")]
    with pytest.raises(ConnectorError, match="--task-id task_abc123") as e:
        tripo.wait("task_abc123")
    assert "Tripo" in str(e.value) and "still running" in str(e.value)
    assert len(fake.calls) == 3


def test_the_time_a_status_check_takes_counts_toward_the_limit(fake, monkeypatch, clock, sleeps):
    # Each status check takes 100 s of wall time here; counting only the sleeps
    # would allow 168 checks (840 s / 5 s), the wall clock allows 8.
    def slow_running(method, url, **kwargs):
        fake.calls.append((method, url, kwargs))
        clock[0] += 100.0
        return _task("running")
    monkeypatch.setattr(fake, "request", slow_running)
    with pytest.raises(ConnectorError, match="still running after 840 s"):
        tripo.wait("task_abc123")
    assert len(fake.calls) == 8
    assert sleeps == [tripo.POLL_INTERVAL_S] * 8


def test_status_checks_that_keep_failing_name_the_task(fake):
    fake.script = [_FakeRequestException("down")] * 15
    with pytest.raises(ConnectorError, match=r"running the same step with --task-id task_abc123 \(no new charge\)") as e:
        tripo.wait("task_abc123")
    assert "generating again" not in str(e.value)


def test_a_429_while_polling_is_a_missed_tick_not_a_failure(fake, sleeps):
    fake.script = [_FakeResponse(429, ERR_RATE_LIMIT, headers={"Retry-After": "30"}),
                   _FakeResponse(200, TASK_SUCCESS)]
    assert tripo.wait("task_abc123")["status"] == "success"
    assert sleeps == [tripo.POLL_INTERVAL_S], "the poll loop is the retry: no 30 s Retry-After wait inside it"


def test_429s_while_polling_never_count_toward_the_failure_stop(fake, sleeps):
    many = tripo.MAX_CONSECUTIVE_POLL_FAILURES + 3
    fake.script = [_FakeResponse(429, ERR_CONCURRENCY)] * many + [_FakeResponse(200, TASK_SUCCESS)]
    assert tripo.wait("task_abc123")["status"] == "success"
    assert len(fake.calls) == many + 1


def test_429s_neither_count_nor_reset_the_failures_between_them(fake):
    # One failed status check is three transport attempts (a GET is repeated by _http).
    busy, down = _FakeResponse(429, ERR_CONCURRENCY), [_FakeRequestException("down")] * 3
    fake.script = [*down, *down, busy, *down, *down, *down]
    with pytest.raises(ConnectorError, match=r"5 status checks failed in a row"):
        tripo.wait("task_abc123")


def test_a_bad_key_while_polling_stops_at_once(fake):
    fake.script = [_FakeResponse(401, ERR_INVALID_KEY)]
    with pytest.raises(ConnectorError) as e:
        tripo.wait("task_abc123")
    assert e.value.reason == INVALID_API_KEY and len(fake.calls) == 1


def test_the_task_id_is_one_path_segment(fake):
    fake.script = [_FakeResponse(200, TASK_SUCCESS)]
    tripo.wait("../account/balance")
    assert fake.calls[0][1] == f"{API}/tasks/..%2Faccount%2Fbalance"


# ---------------------------------------------------------------------------
# download and resume_model (collect a task already submitted)
# ---------------------------------------------------------------------------

def test_resume_model_waits_downloads_model_url_and_returns_credits_as_a_float(fake, tmp_path):
    fake.script = [_FakeResponse(200, TASK_SUCCESS), _FakeResponse(200, content=_glb_bytes())]
    out = tmp_path / "robot.glb"
    result = tripo.resume_model("task_abc123", str(out))
    assert out.read_bytes() == _glb_bytes()
    assert result == {"path": str(out), "taskId": "task_abc123", "model": None, "creditsUsed": 100.0,
                      "textures": {"reencoded": 0, "ktx2": 0, "formats": {}}}
    assert isinstance(result["creditsUsed"], float)
    assert fake.calls[-1][:2] == ("GET", "https://cdn.tripo3d.ai/output/model_pbr.glb")
    assert "headers" not in fake.calls[-1][2], "the API key never goes to the CDN"
    assert not any(c[0] == "POST" for c in fake.calls), "no new task, no new charge"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["robot.glb", "robot.glb.tripo.json"], \
        "no .part or .download file left behind"


def test_the_unused_bare_resume_is_gone():
    # Every collect goes through resume_model/_rig/_animation, which run the texture guard.
    assert not hasattr(tripo, "resume")


@pytest.mark.parametrize("credits,expected", [(48, 48.0), (12.5, 12.5), (None, None)])
def test_credits_are_a_float_or_none_never_an_int(fake, tmp_path, credits, expected):
    data = dict(TASK_SUCCESS["data"], credits_consumed=credits)
    if credits is None:
        del data["credits_consumed"]
    fake.script = [_FakeResponse(200, {"code": 0, "data": data}), _FakeResponse(200, content=_glb_bytes())]
    result = tripo.resume_model("task_abc123", str(tmp_path / "m.glb"))
    assert result["creditsUsed"] == expected
    assert result["creditsUsed"] is None or type(result["creditsUsed"]) is float


def test_a_failed_download_leaves_no_model_and_names_the_task(fake, tmp_path):
    fake.script = [_FakeResponse(200, TASK_SUCCESS), _FakeResponse(404)]
    out = tmp_path / "robot.glb"
    with pytest.raises(ConnectorError, match=r"Tripo download failed \(HTTP 404\)") as e:
        tripo.resume_model("task_abc123", str(out))
    assert e.value.reason is None
    assert "--task-id task_abc123 (no new charge)" in str(e.value)
    assert [p.name for p in tmp_path.iterdir()] == ["robot.glb.tripo.json"], "only the record of the paid task"


def test_a_download_that_cannot_connect_after_a_paid_task_is_not_unreachable(fake, tmp_path):
    # UNREACHABLE's remedy in the app is "run the step again": that would pay twice.
    fake.script = [_FakeResponse(200, TASK_SUCCESS), *[_FakeRequestException("connection reset")] * 3]
    with pytest.raises(ConnectorError) as e:
        tripo.resume_model("task_abc123", str(tmp_path / "robot.glb"))
    assert e.value.reason is None
    message = str(e.value)
    assert "connection reset" in message and "made and paid for" in message
    assert "running the same step with --task-id task_abc123 (no new charge)" in message


def test_a_download_that_cannot_connect_is_unreachable_and_names_tripo(fake, tmp_path):
    fake.script = [_FakeRequestException("connection reset")] * 3
    with pytest.raises(ConnectorError) as e:
        tripo.download("https://cdn.tripo3d.ai/output/model_pbr.glb", str(tmp_path / "m.glb"))
    assert e.value.reason == UNREACHABLE
    assert str(e.value).startswith("Tripo download") and "connection reset" in str(e.value)
    assert list(tmp_path.iterdir()) == []


def test_a_download_5xx_is_unreachable_after_the_transport_retries(fake, tmp_path):
    fake.script = [_FakeResponse(503)] * 3
    with pytest.raises(ConnectorError, match="Tripo download failed") as e:
        tripo.download("https://cdn.tripo3d.ai/output/model_pbr.glb", str(tmp_path / "m.glb"))
    assert e.value.reason == UNREACHABLE and len(fake.calls) == 3


def test_a_download_stream_that_drops_is_unreachable(fake, tmp_path):
    class _Dropping(_FakeResponse):
        def iter_content(self, chunk_size=None):
            yield b"GLB"
            raise _FakeRequestException("stream dropped")
    fake.script = [_Dropping(200)]
    out = tmp_path / "m.glb"
    with pytest.raises(ConnectorError, match="stream dropped") as e:
        tripo.download("https://cdn.tripo3d.ai/output/model_pbr.glb", str(out))
    assert e.value.reason == UNREACHABLE and list(tmp_path.iterdir()) == []


def test_a_download_error_does_not_repeat_the_url_signature(fake, tmp_path):
    fake.script = [_FakeResponse(403)]
    with pytest.raises(ConnectorError) as e:
        tripo.download("https://cdn.tripo3d.ai/output/model_pbr.glb?Signature=secret&Expires=1",
                       str(tmp_path / "m.glb"))
    assert "cdn.tripo3d.ai/output/model_pbr.glb" in str(e.value) and "secret" not in str(e.value)


SIGNED = "https://cdn.tripo3d.ai/output/model_pbr.glb?Signature=s3cr3tSIGvalue&Key-Pair-Id=K2ABCDEF&Expires=1760000000"
QUERY = "Signature=s3cr3tSIGvalue&Key-Pair-Id=K2ABCDEF&Expires=1760000000"


def _messages(exc):
    """The exception's text and that of every exception chained to it."""
    seen = []
    while exc is not None and exc not in seen:
        seen.append(exc)
        exc = exc.__cause__
    return " | ".join(str(x) for x in seen)


def _assert_no_signature(text):
    assert "s3cr3tSIGvalue" not in text and "K2ABCDEF" not in text and QUERY not in text and SIGNED not in text


def test_a_request_error_quoting_the_signed_url_is_scrubbed(fake, tmp_path):
    # requests' own text quotes the path and query without the host; _http adds the full URL.
    quoted = (f"HTTPSConnectionPool(host='cdn.tripo3d.ai', port=443): Max retries exceeded with url: "
              f"/output/model_pbr.glb?{QUERY} (Caused by ReadTimeoutError)")
    fake.script = [_FakeRequestException(quoted)] * 3
    with pytest.raises(ConnectorError) as e:
        tripo.download(SIGNED, str(tmp_path / "m.glb"))
    _assert_no_signature(_messages(e.value))
    assert "https://cdn.tripo3d.ai/output/model_pbr.glb" in str(e.value) and "Max retries exceeded" in str(e.value)
    assert e.value.reason == UNREACHABLE


def test_a_stream_error_quoting_the_signed_url_is_scrubbed(fake, tmp_path):
    class _Dropping(_FakeResponse):
        def iter_content(self, chunk_size=None):
            yield b"GLB"
            raise _FakeRequestException(f"Connection broken while reading {SIGNED}")
    fake.script = [_Dropping(200)]
    with pytest.raises(ConnectorError) as e:
        tripo.download(SIGNED, str(tmp_path / "m.glb"))
    _assert_no_signature(_messages(e.value))
    assert "Connection broken" in str(e.value)


def test_a_paid_task_whose_download_fails_names_the_task_but_not_the_signature(fake, tmp_path):
    data = dict(TASK_SUCCESS["data"], output={"model_url": SIGNED})
    fake.script = [_FakeResponse(200, {"code": 0, "data": data}),
                   *[_FakeRequestException(f"timed out: /output/model_pbr.glb?{QUERY}")] * 3]
    with pytest.raises(ConnectorError) as e:
        tripo.resume_model("task_abc123", str(tmp_path / "m.glb"))
    _assert_no_signature(_messages(e.value))
    assert "--task-id task_abc123" in str(e.value)


def test_scrub_removes_a_percent_decoded_query_too():
    url = "https://cdn.tripo3d.ai/m.glb?Signature=ab%2Fcd%3D%3Defgh&Expires=1"
    text = tripo._scrub(f"GET {url} failed: /m.glb?Signature=ab/cd==efgh&Expires=1 and ab/cd==efgh", url)
    assert "ab/cd==efgh" not in text and "ab%2Fcd" not in text and "https://cdn.tripo3d.ai/m.glb" in text


def test_a_failed_download_keeps_an_existing_file(fake, tmp_path):
    out = tmp_path / "robot.glb"
    out.write_bytes(b"OLD")
    fake.script = [_FakeResponse(404)]
    with pytest.raises(ConnectorError):
        tripo.download("https://cdn.tripo3d.ai/output/model_pbr.glb", str(out))
    assert out.read_bytes() == b"OLD"
    assert [p.name for p in tmp_path.iterdir()] == ["robot.glb"]


def test_resume_without_a_model_url(fake, tmp_path):
    data = dict(TASK_SUCCESS["data"], output={"rendered_image_url": "https://cdn.tripo3d.ai/output/preview.png"})
    fake.script = [_FakeResponse(200, {"code": 0, "data": data})]
    with pytest.raises(ConnectorError, match="succeeded but returned no model_url"):
        tripo.resume_model("task_abc123", str(tmp_path / "m.glb"))


def test_resume_of_a_task_still_running_names_its_id_and_collects_it_later(fake, monkeypatch, tmp_path):
    monkeypatch.setattr(tripo, "STEP_BUDGET_S", 10.0)
    fake.script = [_task("running"), _task("running")]
    with pytest.raises(ConnectorError, match=r"--task-id task_abc123 \(no new charge\)"):
        tripo.resume_model("task_abc123", str(tmp_path / "m.glb"))
    monkeypatch.setattr(tripo, "STEP_BUDGET_S", 840.0)
    fake.script = [_FakeResponse(200, TASK_SUCCESS), _FakeResponse(200, content=_glb_bytes())]
    assert tripo.resume_model("task_abc123", str(tmp_path / "m.glb"))["path"] == str(tmp_path / "m.glb")


def test_resume_needs_a_task_id_and_a_path(fake, tmp_path):
    with pytest.raises(ConnectorError, match="task_id is required"):
        tripo.resume_model("", str(tmp_path / "m.glb"))
    with pytest.raises(ConnectorError, match="out_path is required"):
        tripo.resume_model("task_abc123", "")
    assert fake.calls == []


@pytest.mark.parametrize("url", ["", None, "file:///etc/passwd", "ftp://example.com/m.glb"])
def test_download_refuses_a_url_that_is_not_http(fake, tmp_path, url):
    with pytest.raises(ConnectorError, match="unusable download URL"):
        tripo.download(url, str(tmp_path / "m.glb"))
    assert fake.calls == []


# ---------------------------------------------------------------------------
# Rigging and animation, at the requests layer (rig_model, animate_model)
# ---------------------------------------------------------------------------

def _glb_bytes() -> bytes:
    """A minimal valid GLB (JSON chunk only), built here: the real texture guard
    leaves it byte-identical. Not a Tripo output."""
    import struct
    js = json.dumps({"asset": {"version": "2.0"}}).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<II", len(js), 0x4E4F534A) + js
    return b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body


# documented example ("Create task"), developers.tripo3d.ai/en/docs/animations-rig-check.md, read 2026-10-13
CHECK_CREATED = {"code": 0, "data": {"task_id": "task_check"}}

# documented example ("Task result"), developers.tripo3d.ai/en/docs/animations-rig-check.md, read 2026-10-13
# (the docs show task_def456 here and task_abc123 above: two examples, not one task)
CHECK_RESULT = {
    "code": 0,
    "data": {"task_id": "task_def456", "status": "success",
             "output": {"riggable": True, "rig_type": "biped"}, "credits_consumed": 0.00},
}

# Built from the documented field list (animations-rig-check.md, read 2026-10-13): the docs show
# only the riggable: true answer, so this one is an assumption of the shape, not a capture.
CHECK_NOT_RIGGABLE = {
    "code": 0,
    "data": {"task_id": "task_def456", "status": "success",
             "output": {"riggable": False, "rig_type": "quadruped"}, "credits_consumed": 0.00},
}

# documented example ("Create task"), developers.tripo3d.ai/en/docs/animations-rig.md, read 2026-10-13
RIG_CREATED = {"code": 0, "data": {"task_id": "task_rig"}}

# documented example ("Task result"), developers.tripo3d.ai/en/docs/animations-rig.md, read 2026-10-13
RIG_RESULT = {
    "code": 0,
    "data": {"task_id": "task_def456", "status": "success",
             "output": {"model_url": "https://cdn.tripo3d.ai/output/rigged.glb"}, "credits_consumed": 30.00},
}

# documented example ("Create task"), developers.tripo3d.ai/en/docs/animations-retarget.md, read 2026-10-13
RETARGET_CREATED = {"code": 0, "data": {"task_id": "task_anim"}}

# documented example ("Task result"), developers.tripo3d.ai/en/docs/animations-retarget.md, read 2026-10-13
RETARGET_RESULT = {
    "code": 0,
    "data": {"task_id": "task_def456", "status": "success",
             "output": {"model_url": "https://cdn.tripo3d.ai/output/animated.glb"}, "credits_consumed": 20.00},
}


def _generated(tmp_path, name="robot.glb", task="task_gen"):
    """A model as generate_model leaves it: the .glb and its finished-task record."""
    glb = tmp_path / name
    glb.write_bytes(b"glTF-source")
    Path(f"{glb}.tripo.json").write_text(json.dumps(
        {"task_id": task, "kind": "model", "model": "v3.1-20260211", "endpoint": "/generation/text-to-model",
         "created": "2026-10-13T10:00:00+00:00", "credits_consumed": 100.0}))
    return glb


def _rigged_by_rig_model(tmp_path, name="rigged.glb", rig_type="biped", rig_model="v1.0-20240301"):
    glb = tmp_path / name
    glb.write_bytes(b"glTF-rigged")
    Path(f"{glb}.tripo.json").write_text(json.dumps(
        {"task_id": "task_rig", "kind": "rig", "rig_model": rig_model, "rig_type": rig_type,
         "spec": "mixamo" if rig_type == "biped" else "tripo", "source_task_id": "task_gen",
         "created": "2026-10-13T10:00:00+00:00", "credits_consumed": 30.0}))
    return glb


def test_rig_from_a_generated_model_sends_its_task_and_follows_the_documented_flow(fake, tmp_path):
    src, out = _generated(tmp_path), tmp_path / "rigged.glb"
    fake.script = [_FakeResponse(200, CHECK_CREATED), _FakeResponse(200, CHECK_RESULT),
                   _FakeResponse(200, RIG_CREATED), _FakeResponse(200, RIG_RESULT),
                   _FakeResponse(200, content=_glb_bytes())]

    result = tripo.rig_model(model_path=str(src), out_path=str(out))

    assert [c[:2] for c in fake.calls] == [
        ("POST", f"{API}/animations/rig-check"), ("GET", f"{API}/tasks/task_check"),
        ("POST", f"{API}/animations/rig"), ("GET", f"{API}/tasks/task_rig"),
        ("GET", "https://cdn.tripo3d.ai/output/rigged.glb")]
    assert fake.calls[0][2]["json"] == {"input": "task_gen"}, "no upload: the generation task is the input"
    assert fake.calls[2][2]["json"] == {"input": "task_gen", "model": "v1.0-20240301", "rig_type": "biped",
                                        "spec": "mixamo", "out_format": "glb"}
    assert result == {"path": str(out), "taskId": "task_rig", "rigType": "biped", "rigModel": "v1.0-20240301",
                      "spec": "mixamo", "creditsUsed": 30.0,
                      "textures": {"reencoded": 0, "ktx2": 0, "formats": {}}}
    assert isinstance(result["creditsUsed"], float)
    assert out.read_bytes() == _glb_bytes()
    record = json.loads(Path(f"{out}.tripo.json").read_text())
    assert {k: record[k] for k in ("task_id", "kind", "rig_model", "rig_type", "spec", "source_task_id",
                                   "credits_consumed")} == {
        "task_id": "task_rig", "kind": "rig", "rig_model": "v1.0-20240301", "rig_type": "biped",
        "spec": "mixamo", "source_task_id": "task_gen", "credits_consumed": 30.0}
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "rigged.glb", "rigged.glb.tripo.json", "robot.glb", "robot.glb.tripo.json"]


def test_rig_of_a_plain_glb_uploads_it_and_sends_the_file_token(fake, tmp_path):
    src, out = tmp_path / "hero.glb", tmp_path / "rigged.glb"
    src.write_bytes(b"glTF-from-elsewhere")
    fake.script = [_FakeResponse(200, UPLOAD_OK), _FakeResponse(200, CHECK_CREATED), _FakeResponse(200, CHECK_RESULT),
                   _FakeResponse(200, RIG_CREATED), _FakeResponse(200, RIG_RESULT),
                   _FakeResponse(200, content=_glb_bytes())]

    tripo.rig_model(model_path=str(src), out_path=str(out))

    assert fake.calls[0][:2] == ("POST", f"{API}/files")
    assert fake.calls[0][2]["files"]["file"][0] == "hero.glb"
    assert fake.calls[1][2]["json"] == {"input": "file_abc123"}
    assert fake.calls[3][2]["json"]["input"] == "file_abc123"
    assert json.loads(Path(f"{out}.tripo.json").read_text())["source_task_id"] is None


def test_a_model_the_check_calls_not_riggable_makes_no_rig_task(fake, tmp_path):
    src, out = _generated(tmp_path), tmp_path / "rigged.glb"
    fake.script = [_FakeResponse(200, CHECK_CREATED), _FakeResponse(200, CHECK_NOT_RIGGABLE)]

    with pytest.raises(tripo.NotRiggable, match=r"riggable: false.*recommended rig type: quadruped") as e:
        tripo.rig_model(model_path=str(src), out_path=str(out), rig_type="biped")

    assert e.value.rig_type == "quadruped" and isinstance(e.value, ConnectorError)
    assert "Nothing was spent" in str(e.value)
    assert [c[:2] for c in fake.calls] == [("POST", f"{API}/animations/rig-check"), ("GET", f"{API}/tasks/task_check")]
    assert not out.exists() and not Path(f"{out}.tripo.json").exists()


def test_a_check_that_fails_stops_without_a_rig_task_and_a_slow_one_says_to_run_it_again(fake, tmp_path, monkeypatch):
    src, out = tmp_path / "hero.glb", tmp_path / "rigged.glb"
    src.write_bytes(b"glTF-from-elsewhere")
    fake.script = [_FakeResponse(200, UPLOAD_OK), _FakeResponse(200, CHECK_CREATED),
                   _task("failed", error_code=2018, error_message="Model too complex")]
    with pytest.raises(ConnectorError, match="Model too complex"):
        tripo.rig_model(model_path=str(src), out_path=str(out))
    assert len(fake.calls) == 3 and not Path(f"{out}.tripo.json").exists()

    monkeypatch.setattr(tripo, "STEP_BUDGET_S", 10.0)
    fake.calls.clear()
    fake.script = [_FakeResponse(200, UPLOAD_OK), _FakeResponse(200, CHECK_CREATED), _task("running"),
                   _task("running")]
    with pytest.raises(ConnectorError, match="The check is free: run it again") as e:
        tripo.rig_model(model_path=str(src), out_path=str(out))
    assert "--task-id" not in str(e.value), "a free check has nothing to collect"
    assert not any(c[1].endswith("/animations/rig") for c in fake.calls)


def test_wait_says_task_id_unless_the_task_is_a_free_check(fake, monkeypatch):
    monkeypatch.setattr(tripo, "MAX_POLL_S", 10.0)
    fake.script = [_task("running"), _task("running")]
    with pytest.raises(ConnectorError, match=r"running the same step with --task-id task_x \(no new charge\)"):
        tripo.wait("task_x")
    fake.script = [_task("running"), _task("running")]
    with pytest.raises(ConnectorError, match="run it again"):
        tripo.wait("task_x", resumable=False)
    fake.script = [_FakeRequestException("down")] * 15
    with pytest.raises(ConnectorError, match="The check is free: run it again"):
        tripo.wait("task_x", resumable=False)


@pytest.mark.parametrize("call", ["rig", "animate"])
@pytest.mark.parametrize("status,body,reason", [
    (401, ERR_INVALID_KEY, INVALID_API_KEY),
    (403, ERR_INSUFFICIENT, INSUFFICIENT_CREDIT),
    (400, ERR_CONTENT, CONTENT_REFUSED),
])
def test_a_refused_submit_maps_to_its_reason_and_records_nothing(fake, tmp_path, call, status, body, reason):
    out = tmp_path / "out.glb"
    if call == "rig":
        src = _generated(tmp_path)
        fake.script = [_FakeResponse(200, CHECK_CREATED), _FakeResponse(200, CHECK_RESULT), _FakeResponse(status, body)]
        run = lambda: tripo.rig_model(model_path=str(src), out_path=str(out))   # noqa: E731
    else:
        src = _rigged_by_rig_model(tmp_path)
        fake.script = [_FakeResponse(status, body)]
        run = lambda: tripo.animate_model(model_path=str(src), out_path=str(out), animations=["preset:biped:walk"])   # noqa: E731
    with pytest.raises(ConnectorError) as e:
        run()
    assert e.value.reason == reason
    assert not out.exists() and not Path(f"{out}.tripo.json").exists()
    assert fake.calls[-1][1].endswith("/animations/rig" if call == "rig" else "/animations/retarget")


def test_a_rejected_key_at_the_check_costs_nothing_more(fake, tmp_path):
    src = _generated(tmp_path)
    fake.script = [_FakeResponse(401, ERR_INVALID_KEY)]
    with pytest.raises(ConnectorError) as e:
        tripo.rig_model(model_path=str(src), out_path=str(tmp_path / "rigged.glb"))
    assert e.value.reason == INVALID_API_KEY and len(fake.calls) == 1


def test_animate_single_sends_animation_and_the_documented_options(fake, tmp_path):
    src, out = _rigged_by_rig_model(tmp_path), tmp_path / "walk.glb"
    fake.script = [_FakeResponse(200, RETARGET_CREATED), _FakeResponse(200, RETARGET_RESULT),
                   _FakeResponse(200, content=_glb_bytes())]

    result = tripo.animate_model(model_path=str(src), out_path=str(out), animations=["preset:biped:walk"])

    assert [c[:2] for c in fake.calls] == [
        ("POST", f"{API}/animations/retarget"), ("GET", f"{API}/tasks/task_anim"),
        ("GET", "https://cdn.tripo3d.ai/output/animated.glb")]
    assert fake.calls[0][2]["json"] == {
        "input": "task_rig", "animation": "preset:biped:walk", "out_format": "glb",
        "bake_animation": True, "export_with_geometry": True, "animate_in_place": True}
    assert result["path"] == str(out) and result["taskId"] == "task_anim"
    assert result["animations"] == ["preset:biped:walk"] and result["inPlace"] is True
    assert result["creditsUsed"] == 20.0
    record = json.loads(Path(f"{out}.tripo.json").read_text())
    assert record["kind"] == "animation" and record["rig_task_id"] == "task_rig"
    assert (record["rig_model"], record["rig_type"], record["in_place"]) == ("v1.0-20240301", "biped", True)


def test_animate_several_sends_animations_and_in_place_false_when_asked(fake, tmp_path):
    src, out = _rigged_by_rig_model(tmp_path), tmp_path / "moves.glb"
    fake.script = [_FakeResponse(200, RETARGET_CREATED), _FakeResponse(200, RETARGET_RESULT),
                   _FakeResponse(200, content=_glb_bytes())]
    tripo.animate_model(model_path=str(src), out_path=str(out), in_place=False,
                        animations=["preset:biped:idle", "preset:biped:walk", "preset:biped:run"])
    assert fake.calls[0][2]["json"] == {
        "input": "task_rig", "animations": ["preset:biped:idle", "preset:biped:walk", "preset:biped:run"],
        "out_format": "glb", "bake_animation": True, "export_with_geometry": True, "animate_in_place": False}
    assert "animation" not in fake.calls[0][2]["json"]


def test_animate_of_a_plain_glb_makes_no_call(fake, tmp_path):
    plain = tmp_path / "plain.glb"
    plain.write_bytes(b"glTF")
    with pytest.raises(tripo.InvalidInput, match="Rig it first with rig_model"):
        tripo.animate_model(model_path=str(plain), out_path=str(tmp_path / "x.glb"), animations=["preset:biped:walk"])
    assert fake.calls == []


# ---------------------------------------------------------------------------
# One deadline per step run (STEP_BUDGET_S), shared by every wait and the download
# ---------------------------------------------------------------------------

def _timed(monkeypatch, fake, clock, items):
    """fake.request replaced: each item is (seconds the call takes on the fake clock, response)."""
    items = list(items)

    def request(method, url, **kwargs):
        fake.calls.append((method, url, kwargs))
        if not items:
            raise AssertionError(f"unscripted HTTP call: {method} {url}")
        seconds, response = items.pop(0)
        clock[0] += seconds
        if isinstance(response, Exception):
            raise response
        return response
    monkeypatch.setattr(fake, "request", request)


def test_a_task_done_too_late_to_download_is_named_and_not_downloaded(fake, monkeypatch, clock, tmp_path):
    # Six status checks of 100 s and one of 130 s (plus 5 s between them): done at 760 s,
    # with 80 s of the 840 s left, under MIN_LEFT_S. No CDN call is made.
    out = tmp_path / "robot.glb"
    _timed(monkeypatch, fake, clock, [(0, _FakeResponse(200, CREATE_OK))]
           + [(100, _task("running"))] * 6 + [(130, _FakeResponse(200, TASK_SUCCESS))])
    with pytest.raises(ConnectorError) as e:
        tripo.generate_model(out_path=str(out), prompt="a robot")
    message = str(e.value)
    assert "is done, but only 80 s of this run are left" in message
    assert "running the same step with --task-id task_abc123 (no new charge)" in message
    assert e.value.reason is None
    assert not any("cdn.tripo3d.ai" in c[1] for c in fake.calls)
    assert not out.exists() and "credits_consumed" not in json.loads(Path(f"{out}.tripo.json").read_text())


def test_the_rig_check_and_the_rig_share_one_deadline_so_a_late_rig_is_not_submitted(fake, monkeypatch, clock, tmp_path):
    src, out = _generated(tmp_path), tmp_path / "rigged.glb"
    _timed(monkeypatch, fake, clock, [(0, _FakeResponse(200, CHECK_CREATED)), (760, _FakeResponse(200, CHECK_RESULT))])
    with pytest.raises(ConnectorError, match="Only 80 s of this run are left.*Nothing was spent: run the step again"):
        tripo.rig_model(model_path=str(src), out_path=str(out))
    assert [c[1] for c in fake.calls] == [f"{API}/animations/rig-check", f"{API}/tasks/task_check"]
    assert not Path(f"{out}.tripo.json").exists()


def test_the_rig_wait_ends_at_the_steps_deadline_and_names_the_rig_type(fake, monkeypatch, clock, tmp_path):
    # The check takes 300 s; the rig wait gets what is left of the 840 s, not 840 s of its own.
    src, out = _generated(tmp_path), tmp_path / "rigged.glb"
    start = clock[0]
    _timed(monkeypatch, fake, clock, [(0, _FakeResponse(200, CHECK_CREATED)), (300, _FakeResponse(200, CHECK_RESULT)),
                                      (0, _FakeResponse(200, RIG_CREATED))] + [(100, _task("running"))] * 6)
    with pytest.raises(ConnectorError) as e:
        tripo.rig_model(model_path=str(src), out_path=str(out))
    message = str(e.value)
    assert "Tripo task task_rig is still running" in message
    assert "running the same step with --task-id task_rig --rig-type biped (no new charge)" in message
    assert "generat" not in message
    assert clock[0] - start < tripo.STEP_BUDGET_S + 100
    assert fake.calls[-1][2]["timeout"] == 5.0, "a status check near the deadline gets a short timeout"
    assert json.loads(Path(f"{out}.tripo.json").read_text())["task_id"] == "task_rig"


@pytest.mark.parametrize("collect,hint", [
    (lambda out: tripo.resume_rig("task_rig", out, rig_type="quadruped"), "--task-id task_rig --rig-type quadruped"),
    (lambda out: tripo.resume_rig("task_rig", out), "--task-id task_rig ("),
    (lambda out: tripo.resume_animation("task_anim", out), "--task-id task_anim ("),
    (lambda out: tripo.resume_model("task_abc123", out), "--task-id task_abc123 ("),
])
def test_every_collect_has_its_own_deadline_and_names_how_to_collect_again(fake, monkeypatch, tmp_path, collect, hint):
    monkeypatch.setattr(tripo, "STEP_BUDGET_S", 10.0)
    fake.script = [_task("running"), _task("running")]
    with pytest.raises(ConnectorError) as e:
        collect(str(tmp_path / "m.glb"))
    assert hint in str(e.value) and "generating again" not in str(e.value)


def test_a_download_fits_its_timeout_in_the_time_left(fake, clock, tmp_path):
    fake.script = [_FakeResponse(200, content=b"GLB")]
    tripo.download("https://cdn.tripo3d.ai/output/model_pbr.glb", str(tmp_path / "m.glb"), deadline=clock[0] + 120)
    assert fake.calls[0][2]["timeout"] == 40.0, "120 s left over the transport's 3 attempts"
    fake.script = [_FakeResponse(200, content=b"GLB")]
    tripo.download("https://cdn.tripo3d.ai/output/model_pbr.glb", str(tmp_path / "n.glb"))
    assert fake.calls[1][2]["timeout"] == tripo.DOWNLOAD_TIMEOUT_S


def test_a_download_still_streaming_at_the_deadline_stops_and_leaves_nothing(fake, clock, tmp_path):
    class _Slow(_FakeResponse):
        def iter_content(self, chunk_size=None):
            for _ in range(3):
                clock[0] += 40.0
                yield b"GLB-"
    fake.script = [_Slow(200)]
    with pytest.raises(ConnectorError, match="out of time") as e:
        tripo.download("https://cdn.tripo3d.ai/output/model_pbr.glb", str(tmp_path / "m.glb"), deadline=clock[0] + 50)
    assert e.value.reason is None and list(tmp_path.iterdir()) == []


# ---------------------------------------------------------------------------
# A generation task Tripo no longer takes as a rig input: upload the .glb instead
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("refusal", ["at submit", "check task failed"])
def test_a_source_task_the_check_cannot_use_falls_back_to_uploading_the_glb(fake, tmp_path, capsys, refusal):
    # The docs name no code for a task id Tripo no longer takes (expired, or made by another
    # key); ERR_UNSUPPORTED_PARAM (built from the documented envelope, above) stands in for it.
    src, out = _generated(tmp_path), tmp_path / "rigged.glb"
    first = ([_FakeResponse(400, ERR_UNSUPPORTED_PARAM)] if refusal == "at submit" else
             [_FakeResponse(200, CHECK_CREATED), _task("failed", error_code=2002, error_message="Unsupported request parameter")])
    fake.script = [*first, _FakeResponse(200, UPLOAD_OK), _FakeResponse(200, CHECK_CREATED),
                   _FakeResponse(200, CHECK_RESULT), _FakeResponse(200, RIG_CREATED), _FakeResponse(200, RIG_RESULT),
                   _FakeResponse(200, content=_glb_bytes())]

    result = tripo.rig_model(model_path=str(src), out_path=str(out))

    assert fake.calls[0][2]["json"] == {"input": "task_gen"}
    posts = [(c[1], c[2].get("json")) for c in fake.calls if c[0] == "POST"]
    assert posts[-3:] == [(f"{API}/files", None), (f"{API}/animations/rig-check", {"input": "file_abc123"}),
                          (f"{API}/animations/rig", {"input": "file_abc123", "model": "v1.0-20240301",
                                                     "rig_type": "biped", "spec": "mixamo", "out_format": "glb"})]
    assert result["taskId"] == "task_rig"
    assert json.loads(Path(f"{out}.tripo.json").read_text())["source_task_id"] is None
    assert "could not use task task_gen" in capsys.readouterr().err


@pytest.mark.parametrize("body,reason", [(ERR_INSUFFICIENT, INSUFFICIENT_CREDIT), (ERR_CONTENT, CONTENT_REFUSED)])
def test_a_check_refused_for_another_reason_does_not_upload(fake, tmp_path, body, reason):
    src = _generated(tmp_path)
    fake.script = [_FakeResponse(403 if reason == INSUFFICIENT_CREDIT else 400, body)]
    with pytest.raises(ConnectorError) as e:
        tripo.rig_model(model_path=str(src), out_path=str(tmp_path / "rigged.glb"))
    assert e.value.reason == reason and len(fake.calls) == 1


def test_the_free_check_is_repeated_on_a_5xx_and_an_unreachable_one_does_not_upload(fake, tmp_path):
    # The check costs nothing, so the transport repeats it; a paid submit never is.
    src = _generated(tmp_path)
    fake.script = [_FakeResponse(503)] * 3
    with pytest.raises(ConnectorError) as e:
        tripo.rig_model(model_path=str(src), out_path=str(tmp_path / "rigged.glb"))
    assert e.value.reason == UNREACHABLE and len(fake.calls) == 3
    assert all(c[1] == f"{API}/animations/rig-check" for c in fake.calls), "no upload for a network failure"


# ---------------------------------------------------------------------------
# MONTAJ_TRIPO_CAPTURE: a real run's calls, written for fixtures. Inert when unset;
# never the key, a URL's query or a key- or token-named field's value.
# ---------------------------------------------------------------------------

SIGNED_TASK = {
    "code": 0,
    "data": {
        "task_id": "task_abc123", "type": "image_to_model", "status": "success", "progress": 100,
        "output": {"model_url": "https://cdn.tripo3d.ai/output/model_pbr.glb?Expires=1&Signature=sig-secret-1"},
        "credits_consumed": 30,
    },
}


def _captures(folder):
    return sorted(Path(folder).glob("*.json"))


def test_capture_does_nothing_when_unset(fake, tmp_path, monkeypatch):
    monkeypatch.delenv(tripo.CAPTURE_ENV, raising=False)
    monkeypatch.chdir(tmp_path)
    before = tripo._capture_count
    fake.script = [_FakeResponse(200, BALANCE)]
    assert tripo.check_key()["ok"] is True
    assert tripo._capture_count == before
    assert list(tmp_path.iterdir()) == []


def test_capture_writes_each_call_with_no_key_no_url_query_and_no_token(fake, tmp_path, monkeypatch):
    cap = tmp_path / "cap"
    monkeypatch.setenv(tripo.CAPTURE_ENV, str(cap))
    fake.script = [_FakeResponse(200, CREATE_OK), _FakeResponse(200, SIGNED_TASK), _FakeResponse(200, BALANCE)]
    body = {"type": "image_to_model", "file": {"type": "png", "file_token": "tok-secret-2"},
            "image_url": "https://img.example/a.png?X-Amz-Signature=sig-secret-3", "apiKey": "key-secret-4"}
    assert tripo.create("/generation/image-to-model", body) == "task_abc123"
    tripo.wait("task_abc123")
    tripo.check_key()

    files = _captures(cap)
    assert len(files) == 3
    assert all(f.resolve().parent == cap.resolve() for f in files)
    text = "".join(f.read_text() for f in files)
    for secret in ("test-key", "Bearer", "Authorization", "sig-secret-1", "tok-secret-2", "sig-secret-3", "key-secret-4"):
        assert secret not in text, secret
    submit, task, balance = (json.loads(f.read_text()) for f in files)
    assert (submit["method"], submit["path"], submit["status"]) == ("POST", "/generation/image-to-model", 200)
    assert submit["request"]["file"] == {"type": "png", "file_token": "<redacted>"}
    assert submit["request"]["image_url"] == "https://img.example/a.png?<query removed>"
    assert submit["response"] == CREATE_OK
    assert task["path"] == "/tasks/task_abc123" and "request" not in task
    assert task["response"]["data"]["output"]["model_url"] == "https://cdn.tripo3d.ai/output/model_pbr.glb?<query removed>"
    assert balance["response"] == BALANCE


def test_capture_redacts_a_url_inside_text_and_a_token_in_an_error(fake, tmp_path, monkeypatch):
    cap = tmp_path / "cap"
    monkeypatch.setenv(tripo.CAPTURE_ENV, str(cap))
    err = {"code": 2010, "message": "see https://x.example/p?token=sig-secret-5", "session_token": "s-secret-6"}
    fake.script = [_FakeResponse(403, err)]
    with pytest.raises(ConnectorError):
        tripo.check_key()
    (f,) = _captures(cap)
    record = json.loads(f.read_text())
    assert record["status"] == 403
    assert record["response"] == {"code": 2010, "message": "see https://x.example/p?<query removed>",
                                  "session_token": "<redacted>"}


def test_capture_stays_in_its_folder_and_never_fails_a_call(fake, tmp_path, monkeypatch):
    cap = tmp_path / "cap"
    monkeypatch.setenv(tripo.CAPTURE_ENV, str(cap))
    fake.script = [_FakeResponse(200, BALANCE)]
    tripo._request("GET", "/../../escape", "probe")
    assert [f.resolve().parent for f in _captures(cap)] == [cap.resolve()]
    assert not list(tmp_path.glob("*.json")) and not (tmp_path.parent / "escape").exists()

    blocker = tmp_path / "a-file"
    blocker.write_text("not a folder")
    monkeypatch.setenv(tripo.CAPTURE_ENV, str(blocker))
    fake.script = [_FakeResponse(200, BALANCE)]
    assert tripo.check_key()["ok"] is True
