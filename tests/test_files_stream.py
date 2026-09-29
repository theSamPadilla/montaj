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


# ── helper sources + atomic-rename saves ─────────────────────────────────────
import os
import time

import pytest


class _MovedEvent:
    is_directory = False
    def __init__(self, src: str, dest: str, is_directory: bool = False):
        self.src_path = src
        self.dest_path = dest
        self.is_directory = is_directory


@pytest.mark.parametrize("ext", [".jsx", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".json", ".txt"])
def test_source_extensions_publish_on_both_channels(ext):
    b = SSEBroadcaster()
    p = f"/tmp/ws/helper{ext}"
    per_path = b.subscribe(f"jsx:{p}")
    global_q = b.subscribe(JSX_GLOBAL_CHANNEL)
    _Handler(b, _SyncLoop())._handle(_FakeEvent(p))
    assert json.loads(per_path.get_nowait()[len("data: "):]) == {"path": p}
    assert json.loads(global_q.get_nowait()[len("data: "):]) == {"path": p}


def test_png_publishes_nothing():
    b = SSEBroadcaster()
    global_q = b.subscribe(JSX_GLOBAL_CHANNEL)
    _Handler(b, _SyncLoop())._handle(_FakeEvent("/tmp/ws/a.png"))
    assert global_q.empty()


def test_project_json_lookalike_is_a_source_file(tmp_path):
    f = tmp_path / "foo-project.json"
    f.write_text(json.dumps({"id": "proj1"}))
    b = SSEBroadcaster()
    proj_q = b.subscribe("proj1")
    global_q = b.subscribe(JSX_GLOBAL_CHANNEL)
    _Handler(b, _SyncLoop())._handle(_FakeEvent(str(f)))
    assert proj_q.empty()
    assert json.loads(global_q.get_nowait()[len("data: "):]) == {"path": str(f)}


def test_project_json_stays_on_project_channel_only(tmp_path):
    pj = tmp_path / "project.json"
    pj.write_text(json.dumps({"id": "proj1"}))
    b = SSEBroadcaster()
    proj_q = b.subscribe("proj1")
    global_q = b.subscribe(JSX_GLOBAL_CHANNEL)
    per_path = b.subscribe(f"jsx:{pj}")
    _Handler(b, _SyncLoop())._handle(_FakeEvent(str(pj)))
    assert not proj_q.empty()
    assert global_q.empty() and per_path.empty()


def test_moved_event_uses_dest_path():
    b = SSEBroadcaster()
    global_q = b.subscribe(JSX_GLOBAL_CHANNEL)
    _Handler(b, _SyncLoop()).on_moved(_MovedEvent("/tmp/ws/h.js.tmp", "/tmp/ws/h.js"))
    assert json.loads(global_q.get_nowait()[len("data: "):]) == {"path": "/tmp/ws/h.js"}
    assert global_q.empty()


def test_moved_directory_ignored():
    b = SSEBroadcaster()
    global_q = b.subscribe(JSX_GLOBAL_CHANNEL)
    _Handler(b, _SyncLoop()).on_moved(_MovedEvent("/tmp/a", "/tmp/b.js", is_directory=True))
    assert global_q.empty()


def _wait_for_path(q, path, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            frame = q.get_nowait()
        except Exception:
            time.sleep(0.05)
            continue
        if json.loads(frame[len("data: "):]).get("path") == path:
            return True
    return False


def test_real_watchdog_helper_write_and_atomic_rename(tmp_path):
    from watchdog.observers import Observer

    b = SSEBroadcaster()
    q = b.subscribe(JSX_GLOBAL_CHANNEL)
    obs = Observer()
    obs.schedule(_Handler(b, _SyncLoop()), str(tmp_path), recursive=True)
    obs.start()
    try:
        time.sleep(0.2)  # let the observer settle on macOS FSEvents
        helper = tmp_path / "helper.js"
        helper.write_text("export const a = 1\n")
        assert _wait_for_path(q, str(helper)), "no frame for helper.js write"
        while not q.empty():
            q.get_nowait()

        # Rename phase: FSEvents coalescing adds created/modified events for the
        # target, so only a handler with those muted proves on_moved publishes.
        class _MovedOnly(_Handler):
            def on_created(self, event):
                pass

            def on_modified(self, event):
                pass

        obs.unschedule_all()
        obs.schedule(_MovedOnly(b, _SyncLoop()), str(tmp_path), recursive=True)
        time.sleep(0.2)
        while not q.empty():
            q.get_nowait()

        tmp = tmp_path / "helper.js.tmp"
        tmp.write_text("export const a = 2\n")
        os.replace(tmp, helper)
        assert _wait_for_path(q, str(helper)), "no frame for atomic rename onto helper.js"
    finally:
        obs.stop()
        obs.join()
