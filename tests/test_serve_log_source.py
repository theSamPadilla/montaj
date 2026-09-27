"""POST /api/projects/<id>/log optionally forwards a `source` field (PV22 Task 2).

`source` names which assistant posted the progress line. It rides along in the
SSE `log` frame only when it is a short lowercase-kebab id and not "unknown" —
anything else is dropped silently, never a 400, so callers that never send it
keep publishing exactly the same bytes as before.
"""
import json
import re
import uuid

import pytest
from starlette.testclient import TestClient

from serve.server import app
from serve.sse import SSEBroadcaster


client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def broadcaster(monkeypatch):
    b = SSEBroadcaster()
    monkeypatch.setattr(app.state, "broadcaster", b, raising=False)
    published = []
    monkeypatch.setattr(b, "publish", lambda project_id, data: published.append((project_id, data)))
    return published


def _frame_data(frame: str) -> dict:
    """Pull the JSON payload out of an `event: log\\ndata: {...}\\n\\n` frame."""
    m = re.search(r"^data: (.*)$", frame, re.MULTILINE)
    assert m, f"no data line in frame: {frame!r}"
    return json.loads(m.group(1))


def test_message_only_publishes_unchanged_frame(broadcaster):
    pid = str(uuid.uuid4())
    resp = client.post(f"/api/projects/{pid}/log", json={"message": "cutting clip 3"})

    assert resp.status_code == 204, resp.text
    assert len(broadcaster) == 1
    published_id, frame = broadcaster[0]
    assert published_id == pid
    assert frame == f"event: log\ndata: {json.dumps({'message': 'cutting clip 3'})}\n\n"
    assert _frame_data(frame) == {"message": "cutting clip 3"}


def test_valid_source_is_included(broadcaster):
    pid = str(uuid.uuid4())
    resp = client.post(
        f"/api/projects/{pid}/log",
        json={"message": "cutting clip 3", "source": "claude-desktop"},
    )

    assert resp.status_code == 204, resp.text
    _, frame = broadcaster[0]
    assert _frame_data(frame) == {"message": "cutting clip 3", "source": "claude-desktop"}


@pytest.mark.parametrize(
    "source",
    [
        "Bad Name",  # uppercase and a space
        5,  # not a string
        "unknown",  # explicitly excluded
        "a" * 65,  # over the length cap
        "",  # empty string
        "bad_name",  # underscore not allowed
        "claude-desktop\n",  # trailing newline
    ],
)
def test_invalid_source_is_dropped_not_rejected(broadcaster, source):
    pid = str(uuid.uuid4())
    resp = client.post(
        f"/api/projects/{pid}/log",
        json={"message": "cutting clip 3", "source": source},
    )

    assert resp.status_code == 204, resp.text
    _, frame = broadcaster[0]
    data = _frame_data(frame)
    assert "source" not in data
    assert data == {"message": "cutting clip 3"}


def test_missing_message_is_still_400(broadcaster):
    pid = str(uuid.uuid4())
    resp = client.post(f"/api/projects/{pid}/log", json={"source": "claude-desktop"})

    assert resp.status_code == 400, resp.text
    assert broadcaster == []
