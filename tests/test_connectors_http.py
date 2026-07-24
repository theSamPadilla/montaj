"""Tests for connectors._http — retry/backoff + download, no network."""
import pytest

from connectors import ConnectorError, _http


class _FakeResponse:
    def __init__(self, status_code=200, content=b"", text=""):
        self.status_code = status_code
        self._content = content
        self.text = text

    def iter_content(self, chunk_size=None):
        yield self._content


class _FakeRequestException(Exception):
    pass


class _FakeRequests:
    """Stands in for the requests module: scripted responses/exceptions."""
    RequestException = _FakeRequestException

    def __init__(self, script):
        # script: list of _FakeResponse or Exception instances, consumed per call
        self.script = list(script)
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture
def no_sleep(monkeypatch):
    sleeps = []
    monkeypatch.setattr(_http.time, "sleep", lambda s: sleeps.append(s))
    return sleeps


def _wire(monkeypatch, fake):
    monkeypatch.setattr(_http, "_require_requests", lambda: fake)
    return fake


def test_retries_connection_error_then_succeeds(monkeypatch, no_sleep):
    fake = _wire(monkeypatch, _FakeRequests([
        _FakeRequestException("boom"),
        _FakeResponse(200),
    ]))
    r = _http.request_with_retry("GET", "http://x", timeout=5)
    assert r.status_code == 200
    assert len(fake.calls) == 2
    assert len(no_sleep) == 1


def test_retries_transient_status_then_succeeds(monkeypatch, no_sleep):
    fake = _wire(monkeypatch, _FakeRequests([
        _FakeResponse(503),
        _FakeResponse(429),
        _FakeResponse(200),
    ]))
    r = _http.request_with_retry("GET", "http://x")
    assert r.status_code == 200
    assert len(fake.calls) == 3
    # exponential backoff: base, base*2
    assert no_sleep == [_http.RETRY_BACKOFF_S, _http.RETRY_BACKOFF_S * 2]


def test_non_transient_status_returned_immediately(monkeypatch, no_sleep):
    fake = _wire(monkeypatch, _FakeRequests([_FakeResponse(400)]))
    r = _http.request_with_retry("GET", "http://x")
    assert r.status_code == 400
    assert len(fake.calls) == 1
    assert no_sleep == []


def test_exhausted_attempts_raises_connector_error(monkeypatch, no_sleep):
    fake = _wire(monkeypatch, _FakeRequests([
        _FakeRequestException("a"),
        _FakeRequestException("b"),
        _FakeRequestException("c"),
    ]))
    with pytest.raises(ConnectorError, match="after 3 attempts"):
        _http.request_with_retry("GET", "http://x")
    assert len(fake.calls) == 3


def test_exhausted_transient_status_returns_last_response(monkeypatch, no_sleep):
    fake = _wire(monkeypatch, _FakeRequests([
        _FakeResponse(503), _FakeResponse(503), _FakeResponse(503),
    ]))
    r = _http.request_with_retry("GET", "http://x")
    assert r.status_code == 503
    assert len(fake.calls) == 3


def test_custom_retry_statuses_429_only(monkeypatch, no_sleep):
    # A paid-POST caller retries 429 but never 500.
    fake = _wire(monkeypatch, _FakeRequests([_FakeResponse(500)]))
    r = _http.request_with_retry("POST", "http://x", retry_statuses=frozenset({429}))
    assert r.status_code == 500
    assert len(fake.calls) == 1


def test_retry_exceptions_false_raises_on_first_error(monkeypatch, no_sleep):
    fake = _wire(monkeypatch, _FakeRequests([_FakeRequestException("timeout")]))
    with pytest.raises(ConnectorError):
        _http.request_with_retry("POST", "http://x", retry_exceptions=False)
    assert len(fake.calls) == 1
    assert no_sleep == []


def test_download_file_streams_to_disk(monkeypatch, no_sleep, tmp_path):
    _wire(monkeypatch, _FakeRequests([_FakeResponse(200, content=b"payload")]))
    out = tmp_path / "sub" / "file.bin"
    result = _http.download_file("http://x/f.bin", str(out))
    assert result == str(out)
    assert out.read_bytes() == b"payload"


def test_download_file_http_error_raises(monkeypatch, no_sleep, tmp_path):
    _wire(monkeypatch, _FakeRequests([_FakeResponse(404)]))
    with pytest.raises(ConnectorError, match="HTTP 404"):
        _http.download_file("http://x/f.bin", str(tmp_path / "f.bin"))


# ---------------------------------------------------------------------------
# kling.poll_until_done — transient failures must not abandon a paid task
# ---------------------------------------------------------------------------

def test_poll_tolerates_transient_query_failures(monkeypatch):
    from connectors import kling

    monkeypatch.setattr(kling.time, "sleep", lambda s: None)
    calls = {"n": 0}

    def flaky_query(task_id, path_template=kling.VIDEO_QUERY_PATH):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise ConnectorError("HTTP 502")
        return {"task_status": "succeed", "task_result": {}}

    monkeypatch.setattr(kling, "query_task", flaky_query)
    result = kling.poll_until_done("task-1")
    assert result["task_status"] == "succeed"
    assert calls["n"] == 3


def test_poll_gives_up_after_consecutive_failures(monkeypatch):
    from connectors import kling

    monkeypatch.setattr(kling.time, "sleep", lambda s: None)

    def always_fail(task_id, path_template=kling.VIDEO_QUERY_PATH):
        raise ConnectorError("HTTP 502")

    monkeypatch.setattr(kling, "query_task", always_fail)
    with pytest.raises(ConnectorError, match="consecutive"):
        kling.poll_until_done("task-1")


def test_poll_task_failed_still_raises_immediately(monkeypatch):
    from connectors import kling

    monkeypatch.setattr(kling.time, "sleep", lambda s: None)
    monkeypatch.setattr(kling, "query_task",
                        lambda *a, **k: {"task_status": "failed", "task_status_msg": "nsfw"})
    with pytest.raises(ConnectorError, match="failed: nsfw"):
        kling.poll_until_done("task-1")
