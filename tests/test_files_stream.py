"""File-change SSE: global jsx:* channel + /api/files/stream endpoint modes.

The editor multiplexes all overlay-JSX watching over ONE SSE connection
(GET /api/files/stream with no ?path=) subscribed to the global `jsx:*`
channel; each frame carries {"path": ...} so the client filters. The legacy
per-path form (?path=<abs path> → channel `jsx:{path}`) must keep working.
"""
import json

from serve.sse import SSEBroadcaster, JSX_GLOBAL_CHANNEL
from serve.watcher import _Handler


class _SyncLoop:
    """Stub loop: run call_soon_threadsafe callbacks inline."""
    def call_soon_threadsafe(self, fn, *args):
        fn(*args)


class _FakeEvent:
    is_directory = False
    def __init__(self, path: str):
        self.src_path = path


def test_jsx_write_publishes_to_per_path_and_global_channels():
    b = SSEBroadcaster()
    per_path = b.subscribe("jsx:/tmp/ws/overlay.jsx")
    global_q = b.subscribe(JSX_GLOBAL_CHANNEL)
    other    = b.subscribe("jsx:/tmp/ws/unrelated.jsx")

    _Handler(b, _SyncLoop())._handle(_FakeEvent("/tmp/ws/overlay.jsx"))

    frame = per_path.get_nowait()
    assert frame.startswith("data: ")
    assert json.loads(frame[len("data: "):]) == {"path": "/tmp/ws/overlay.jsx"}

    gframe = global_q.get_nowait()
    assert json.loads(gframe[len("data: "):]) == {"path": "/tmp/ws/overlay.jsx"}

    assert other.empty()


def test_non_jsx_write_does_not_hit_global_channel():
    b = SSEBroadcaster()
    global_q = b.subscribe(JSX_GLOBAL_CHANNEL)
    _Handler(b, _SyncLoop())._handle(_FakeEvent("/tmp/ws/notes.txt"))
    assert global_q.empty()


# ── endpoint integration ─────────────────────────────────────────────────────
# Real path: watchdog thread → loop.call_soon_threadsafe → broadcaster → SSE.
#
# These tests run a REAL uvicorn server on an ephemeral port in a background
# thread and hit it with a real socket (httpx). starlette's in-process
# TestClient can't drive an SSE endpoint like this one: it buffers the entire
# response body before returning (portal.call blocks until the app coroutine
# finishes), and /api/files/stream only finishes when the client disconnects —
# but the in-process transport never surfaces a disconnect, so the generator
# loops forever and TestClient deadlocks. A real socket streams frames
# incrementally and delivers a genuine disconnect when the `with` block exits,
# which is exactly the behaviour the browser relies on.

import os
import socket
import threading
import time

import httpx
import pytest
import uvicorn

import serve.server as server_mod


@pytest.fixture(scope="module")
def workspace(tmp_path_factory):
    # .resolve() because watchdog reports filesystem events through the
    # macOS-resolved path (/private/var/... not /var/...); if the fixture
    # yields the unresolved tmp_path_factory path, the SSE channel key the
    # test subscribes to (jsx:/var/...) never matches the channel the
    # watcher publishes to (jsx:/private/var/...) and the stream hangs.
    ws = tmp_path_factory.mktemp("stream_ws").resolve()
    old = os.environ.get("MONTAJ_WORKSPACE_DIR")
    os.environ["MONTAJ_WORKSPACE_DIR"] = str(ws)
    yield ws
    if old is None:
        os.environ.pop("MONTAJ_WORKSPACE_DIR", None)
    else:
        os.environ["MONTAJ_WORKSPACE_DIR"] = old


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def base_url(workspace):
    # HEADLESS is read at import time; force it so the lifespan doesn't spawn
    # Vite or open a browser during tests. The lifespan (which starts
    # ProjectWatcher on MONTAJ_WORKSPACE_DIR) runs inside uvicorn's own loop,
    # so the watcher captures that loop for call_soon_threadsafe.
    old_headless = server_mod.HEADLESS
    server_mod.HEADLESS = True
    port = _free_port()
    config = uvicorn.Config(
        server_mod.app, host="127.0.0.1", port=port, log_level="warning"
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 15
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    assert server.started, "uvicorn did not start in time"
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=15)
        server_mod.HEADLESS = old_headless


def _first_data_frame(resp, *, max_lines: int = 50) -> dict:
    """Read SSE lines until the first `data:` frame; skip keepalive comments.
    Caps at max_lines so a broken stream fails instead of hanging forever."""
    for i, line in enumerate(resp.iter_lines()):
        if line.startswith("data: "):
            return json.loads(line[len("data: "):])
        if i >= max_lines:
            break
    raise AssertionError("no data frame received")


def _touch_later(path, delay: float = 0.5):
    def _write():
        time.sleep(delay)
        path.write_text("export default () => null\n")
    t = threading.Thread(target=_write, daemon=True)
    t.start()
    return t


def test_stream_without_path_receives_any_jsx_change(base_url, workspace):
    target = workspace / "some_overlay.jsx"
    with httpx.Client(timeout=15) as c:
        with c.stream("GET", f"{base_url}/api/files/stream") as resp:
            assert resp.status_code == 200
            assert resp.headers["content-type"].startswith("text/event-stream")
            _touch_later(target)
            frame = _first_data_frame(resp)
    assert frame["path"].endswith("some_overlay.jsx")


def test_stream_with_path_still_scopes_to_that_file(base_url, workspace):
    target = workspace / "scoped_overlay.jsx"
    target.write_text("export default () => null\n")
    with httpx.Client(timeout=15) as c:
        with c.stream(
            "GET", f"{base_url}/api/files/stream", params={"path": str(target)}
        ) as resp:
            assert resp.status_code == 200
            _touch_later(target)
            frame = _first_data_frame(resp)
    assert frame["path"] == str(target)
