"""Your playback always wins (§683).

While the editor preview plays, heavy background work (a headless browser per
sample, a proxy encode) starves the decoder feeding the preview, and the
picture freezes while the clock runs. So a heavy step that starts while the
preview plays waits for a pause, never longer than `HOLD_CAP_SEC` (an AI never
waits forever), and the ones that waited then run one at a time.

Fails open throughout: nothing is refused, an unreadable play state reads as
"not playing", and work already running is left alone.

The play state is the editor's own context report (`serve/context.py`, POSTed
about once a second, and at once on play or pause). A report older than
`PLAYING_FRESH_SEC` no longer counts as playing: a closed or hidden editor
stops reporting, and its last "playing" must not hold work back.
"""
import asyncio
import os
import shutil
import sys
import time
from contextlib import asynccontextmanager

from serve import context as context_store

HOLD_CAP_SEC = 20.0
PLAYING_FRESH_SEC = 5.0
POLL_SEC = 0.25
NICE_LEVEL = 10

# Steps that render (a headless browser, esbuild) or encode: what starves the preview.
HEAVY_STEPS = frozenset({
    "sample_frame", "look", "contact_sheet", "filmstrip", "place", "frame_broll", "snapshot",
    "proxy", "normalize",
})

# Held encodes wait for the pause but never take the one-at-a-time slot: an encode
# runs for minutes, and a short AI step queued behind it would wait out the cap.
SERIAL_STEPS = HEAVY_STEPS - {"proxy", "normalize"}

_lock: asyncio.Lock | None = None
_lock_loop: asyncio.AbstractEventLoop | None = None


def _heavy_lock() -> asyncio.Lock:
    """One lock per event loop (tests run several loops)."""
    global _lock, _lock_loop
    loop = asyncio.get_running_loop()
    if _lock is None or _lock_loop is not loop:
        _lock, _lock_loop = asyncio.Lock(), loop
    return _lock


def preview_playing() -> bool:
    """Whether an editor reported, within `PLAYING_FRESH_SEC`, that its preview is playing."""
    try:
        now = time.monotonic()
        return any(
            s.playing is True and now - s.reported_at < PLAYING_FRESH_SEC
            for s in list(context_store._contexts.values())
        )
    except Exception:
        return False


async def wait_for_pause(cap: float | None = None) -> bool:
    """Wait while the preview plays, at most `cap` seconds. True when it waited at all."""
    if not preview_playing():
        return False
    deadline = time.monotonic() + (HOLD_CAP_SEC if cap is None else cap)
    while preview_playing() and time.monotonic() < deadline:
        await asyncio.sleep(POLL_SEC)
    return True


@asynccontextmanager
async def heavy_slot(name: str | None = None):
    """Run the body as heavy work: held while the preview plays, then one at a time.

    `name` limits it to `HEAVY_STEPS`; None always counts as heavy. Work that
    starts while nothing plays runs at once, as before. The whole delay, the
    pause and the queue behind other held work, is capped at `HOLD_CAP_SEC`:
    past it the body runs anyway, so a long encode ahead never holds an AI.
    """
    start = time.monotonic()
    held = False
    if name is None or name in HEAVY_STEPS:
        try:
            held = await wait_for_pause()
        except asyncio.CancelledError:
            raise
        except Exception:
            held = False
    got = False
    if held and (name is None or name in SERIAL_STEPS):
        lock = _heavy_lock()
        try:
            await asyncio.wait_for(lock.acquire(), max(0.0, HOLD_CAP_SEC - (time.monotonic() - start)))
            got = True
        except asyncio.TimeoutError:
            got = False
    try:
        yield
    finally:
        if got:
            lock.release()


def _nice_bin() -> str | None:
    if os.path.exists("/usr/bin/nice"):
        return "/usr/bin/nice"
    return shutil.which("nice")


def low_priority(cmd: list[str], name: str | None = None) -> list[str]:
    """`cmd` run at POSIX niceness `NICE_LEVEL` (its children inherit it), so a
    step never outbids the preview for the CPU. An `export_*` step (one the user
    started and is waiting on) keeps normal priority. Windows, or no `nice`: as is."""
    if sys.platform == "win32" or (name or "").startswith("export_"):
        return cmd
    nice = _nice_bin()
    return [nice, "-n", str(NICE_LEVEL), *cmd] if nice else cmd


def playback_env() -> dict[str, str]:
    """The environment that lets a render the user started see the preview's play state (§698): serve's own
    `GET /api/playback` on loopback, for the render to rest its extra workers while the preview plays. Empty when
    serve's port is unknown (a render then never yields: fails open)."""
    port = os.environ.get("MONTAJ_SERVE_PORT", "").strip()
    if not port.isdigit():
        return {}
    return {"MONTAJ_PLAYBACK_URL": f"http://127.0.0.1:{port}/api/playback"}
