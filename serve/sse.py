"""Per-project SSE broadcaster. One asyncio.Queue per active connection."""
import asyncio


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
