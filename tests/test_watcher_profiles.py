"""Profiles created after server start must still emit overlay .jsx SSE events."""
import queue
import time

import pytest


class _SyncLoop:
    def call_soon_threadsafe(self, cb, *args):
        cb(*args)


def _drain_until(q, timeout=10.0):
    """Poll an asyncio.Queue from the test thread until a frame arrives."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            return q.get_nowait()
        except Exception:
            time.sleep(0.05)
    return None


def test_new_profile_overlay_edit_publishes(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))  # Path.home() reads HOME at call time

    from serve.sse import SSEBroadcaster
    from serve.watcher import GlobalOverlayWatcher, JSX_GLOBAL_CHANNEL

    b = SSEBroadcaster()
    q = b.subscribe(JSX_GLOBAL_CHANNEL)
    w = GlobalOverlayWatcher(b, _SyncLoop())
    w.start()
    try:
        # Profile born AFTER the watcher started — the old code never saw it.
        overlays = tmp_path / ".montaj" / "profiles" / "newprof" / "overlays"
        overlays.mkdir(parents=True)
        time.sleep(0.2)  # let the observer settle on macOS FSEvents
        (overlays / "card.jsx").write_text("export default () => null\n")
        frame = _drain_until(q)
        assert frame is not None, "no SSE frame for a post-startup profile overlay edit"
    finally:
        w.stop()
