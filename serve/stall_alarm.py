"""Serve's stall alarm (§688), the twin of the app's main-process one.

Serve runs one asyncio loop: synchronous work inside a route blocks every other
request, the editor's media bytes included, so the preview starves. Any block of
the loop over THRESHOLD_SEC is printed to stderr (the app keeps serve's log) as

    [montaj] stall: serve loop blocked 640 ms; entered: PUT /api/projects/:id; in flight (2): ...

naming the requests that entered during the block and those in flight. Paths
carry no ids, file names or queries. Cheap enough to leave on: one task waking
every TICK_SEC, a small ring and a dict. Never raises into a request.
"""
import asyncio
import re
import sys
import time
from collections import deque
from urllib.parse import unquote

THRESHOLD_SEC = 0.1
TICK_SEC = 0.05
MAX_LINES_PER_MIN = 30
IN_FLIGHT_SHOWN = 6

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_HEX_OR_NUM = re.compile(r"^(?:[0-9a-f]{16,}|\d+)$", re.I)
_ODD = re.compile(r"[\s.@\\]")

_recent: deque = deque(maxlen=64)  # (label, at)
_open: dict[int, tuple[str, float]] = {}
_next_id = 0


def route_label(method: str, path: str) -> str:
    """`METHOD /api/projects/:id/...`: ids, hashes, numbers and odd segments dropped."""
    try:
        out = []
        for seg in (path or "").split("/"):
            if not seg:
                out.append(seg)
                continue
            d = unquote(seg)
            if _UUID.match(d) or _HEX_OR_NUM.match(d):
                out.append(":id")
            elif len(d) > 40 or _ODD.search(d):
                out.append(":x")
            else:
                out.append(seg)
        return f"{(method or '').upper()} {'/'.join(out)[:120]}"
    except Exception:
        return f"{method} ?"


def _enter(label: str) -> int:
    global _next_id
    _next_id += 1
    at = time.monotonic()
    _recent.append((label, at))
    _open[_next_id] = (label, at)
    return _next_id


class StallLabels:
    """ASGI middleware: every HTTP request is labelled while it runs."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        try:
            rid = _enter(route_label(scope.get("method", ""), scope.get("path", "")))
        except Exception:
            rid = None
        try:
            return await self.app(scope, receive, send)
        finally:
            if rid is not None:
                _open.pop(rid, None)


def report(blocked: float, now: float) -> str:
    start = now - blocked - TICK_SEC
    during: list[str] = []
    for label, at in reversed(_recent):
        if at < start or len(during) >= 6:
            break
        if label not in during:
            during.append(label)
    parts = [f"stall: serve loop blocked {round(blocked * 1000)} ms"]
    if during:
        parts.append("entered: " + ", ".join(reversed(during)))
    elif _recent:
        label, at = _recent[-1]
        parts.append(f"last entered: {label} {round((now - at) * 1000)} ms ago")
    flight = sorted(_open.values(), key=lambda o: -o[1])[:IN_FLIGHT_SHOWN]  # newest first: an SSE stream stays open for minutes
    if flight:
        parts.append(f"in flight ({len(_open)}): " + ", ".join(f"{label} {now - at:.1f}s" for label, at in flight))
    return "; ".join(parts)


async def run(*, write=None, clock=time.monotonic, sleep=asyncio.sleep, threshold: float = THRESHOLD_SEC,
              max_per_min: int = MAX_LINES_PER_MIN, ticks: int | None = None) -> None:
    """The ticker. Runs until cancelled (or `ticks` ticks, for tests)."""
    out = write or (lambda line: print(f"[montaj] {line}", file=sys.stderr, flush=True))
    window, logged, suppressed, worst = clock(), 0, 0, 0.0
    n = 0
    while ticks is None or n < ticks:
        n += 1
        before = clock()
        await sleep(TICK_SEC)
        try:
            now = clock()
            lag = now - before - TICK_SEC
            if now - window >= 60:
                if suppressed:
                    out(f"stall: {suppressed} more blocks over {round(threshold * 1000)} ms in the last minute (worst {round(worst * 1000)} ms)")
                window, logged, suppressed, worst = now, 0, 0, 0.0
            if lag <= threshold:
                continue
            if logged >= max_per_min:
                suppressed += 1
                worst = max(worst, lag)
                continue
            logged += 1
            out(report(lag, now))
        except Exception:
            pass
