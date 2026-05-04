"""Per-project SSE broadcaster. One asyncio.Queue per active connection."""
import asyncio
from collections.abc import AsyncIterator

from fastapi import Request


class SSEBroadcaster:
    def __init__(self):
        # project_id → list of queues (one per connected SSE client)
        self._subscribers: dict[str, list[asyncio.Queue]] = {}

    def subscribe(self, project_id: str) -> asyncio.Queue:
        """Register a new SSE connection. Returns a queue to read events from."""
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.setdefault(project_id, []).append(q)
        return q

    def unsubscribe(self, project_id: str, queue: asyncio.Queue) -> None:
        """Remove a queue when its connection closes."""
        subs = self._subscribers.get(project_id, [])
        try:
            subs.remove(queue)
        except ValueError:
            pass
        if not subs:
            self._subscribers.pop(project_id, None)

    def publish(self, project_id: str, data: str) -> None:
        """Push an event string to all queues for a project.
        Safe to call from a non-async thread via loop.call_soon_threadsafe."""
        for q in list(self._subscribers.get(project_id, [])):
            q.put_nowait(data)


async def sse_stream(
    request: Request,
    queue: asyncio.Queue,
    *,
    initial_frame: str | None = None,
) -> AsyncIterator[str]:
    """SSE event-loop helper.

    Yields `initial_frame` (if provided) once on entry, then drains `queue`
    with a 25s keepalive timeout. Caller owns subscribe/unsubscribe; this
    helper only reads from the queue.

    `initial_frame` is precomputed by the caller — the helper does no I/O
    of its own. This keeps the helper agnostic of where the initial state
    comes from (e.g. /projects/{id}/stream reads project.json; /files/stream
    has no initial frame).
    """
    if initial_frame is not None:
        yield initial_frame
    while True:
        if await request.is_disconnected():
            return
        try:
            yield await asyncio.wait_for(queue.get(), timeout=25)
        except asyncio.TimeoutError:
            yield ": keepalive\n\n"
