"""§683: heavy steps wait out the editor preview's playback (capped), one at a time, niced."""
import asyncio
import sys
import time

import pytest

from serve import context as context_store
from serve import playback_gate as gate


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    context_store.clear_all()
    monkeypatch.setattr(gate, "POLL_SEC", 0.01)
    yield
    context_store.clear_all()


def _report(playing, project="p1"):
    context_store.report(project, {"playheadSec": 1.0, "playing": playing})


def test_not_playing_when_nothing_reported_or_paused():
    assert gate.preview_playing() is False
    _report(False)
    assert gate.preview_playing() is False
    _report(None)
    assert gate.preview_playing() is False


def test_playing_while_a_fresh_report_says_so():
    _report(True)
    assert gate.preview_playing() is True


def test_a_stale_playing_report_no_longer_counts(monkeypatch):
    _report(True)
    later = time.monotonic() + gate.PLAYING_FRESH_SEC + 1
    monkeypatch.setattr(gate.time, "monotonic", lambda: later)
    assert gate.preview_playing() is False


def test_unreadable_state_reads_as_not_playing(monkeypatch):
    class Broken(dict):
        def values(self):
            raise RuntimeError("unreadable")

    monkeypatch.setattr(context_store, "_contexts", Broken())
    assert gate.preview_playing() is False


def test_a_heavy_step_waits_for_the_pause():
    async def run():
        _report(True)
        ran = []

        async def job():
            async with gate.heavy_slot("sample_frame"):
                ran.append(time.monotonic())

        task = asyncio.create_task(job())
        await asyncio.sleep(0.1)
        assert ran == []  # held while playing
        _report(False)
        await asyncio.wait_for(task, 1)
        assert len(ran) == 1

    asyncio.run(run())


def test_the_hold_is_capped(monkeypatch):
    monkeypatch.setattr(gate, "HOLD_CAP_SEC", 0.1)

    async def run():
        _report(True)
        t0 = time.monotonic()
        async with gate.heavy_slot("sample_frame"):
            pass
        return time.monotonic() - t0

    waited = asyncio.run(run())
    assert 0.09 <= waited < 1.0


def test_a_light_step_never_waits():
    async def run():
        _report(True)
        async with gate.heavy_slot("probe"):
            return True

    assert asyncio.run(asyncio.wait_for(run(), 0.5))


def test_nothing_waits_when_nothing_plays():
    async def run():
        async with gate.heavy_slot("sample_frame"):
            return True

    assert asyncio.run(asyncio.wait_for(run(), 0.5))


def test_held_steps_then_run_one_at_a_time():
    async def run():
        _report(True)
        active, peak = 0, 0

        async def job():
            nonlocal active, peak
            async with gate.heavy_slot("sample_frame"):
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.05)
                active -= 1

        tasks = [asyncio.create_task(job()) for _ in range(3)]
        await asyncio.sleep(0.05)
        _report(False)
        await asyncio.wait_for(asyncio.gather(*tasks), 2)
        return peak

    assert asyncio.run(run()) == 1


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX nice")
def test_low_priority_prefixes_nice():
    cmd = gate.low_priority(["python", "x.py"])
    assert cmd[-2:] == ["python", "x.py"]
    assert cmd[0].endswith("nice") and cmd[1:3] == ["-n", str(gate.NICE_LEVEL)]


def test_low_priority_without_nice_runs_as_is(monkeypatch):
    monkeypatch.setattr(gate, "_nice_bin", lambda: None)
    assert gate.low_priority(["python", "x.py"]) == ["python", "x.py"]


def test_the_queue_behind_held_work_is_capped_too(monkeypatch):
    """A held job behind a long held one still runs by the cap."""
    monkeypatch.setattr(gate, "HOLD_CAP_SEC", 0.3)

    async def run():
        _report(True)
        release = asyncio.Event()

        async def long_encode():
            async with gate.heavy_slot("look"):
                await release.wait()

        enc = asyncio.create_task(long_encode())
        await asyncio.sleep(0.05)
        _report(False)  # the encode takes the slot
        await asyncio.sleep(0.05)
        _report(True)
        t0 = time.monotonic()
        async with gate.heavy_slot("sample_frame"):
            waited = time.monotonic() - t0
        release.set()
        await enc
        return waited

    waited = asyncio.run(asyncio.wait_for(run(), 3))
    assert waited < 0.6


def test_a_held_encode_never_takes_the_one_at_a_time_slot():
    """After the pause, a short AI step does not queue behind a minutes-long encode."""
    async def run():
        _report(True)
        release = asyncio.Event()
        started = asyncio.Event()

        async def encode():
            async with gate.heavy_slot("proxy"):
                started.set()
                await release.wait()

        enc = asyncio.create_task(encode())
        sample_ran = []

        async def sample():
            async with gate.heavy_slot("sample_frame"):
                sample_ran.append(True)

        s = asyncio.create_task(sample())
        await asyncio.sleep(0.05)
        _report(False)
        await asyncio.wait_for(started.wait(), 1)
        await asyncio.wait_for(s, 1)  # ran while the encode still runs
        release.set()
        await enc
        return sample_ran

    assert asyncio.run(asyncio.wait_for(run(), 3)) == [True]


def test_a_cancel_while_holding_or_waiting_frees_the_slot():
    async def run():
        _report(True)

        async def holder():
            async with gate.heavy_slot("look"):
                await asyncio.sleep(10)

        async def waiter():
            async with gate.heavy_slot("look"):
                pass

        h = asyncio.create_task(holder())
        w = asyncio.create_task(waiter())
        await asyncio.sleep(0.05)
        _report(False)
        await asyncio.sleep(0.05)  # holder has the slot, waiter queues on it
        h.cancel()
        w.cancel()
        await asyncio.gather(h, w, return_exceptions=True)
        _report(True)
        t = asyncio.create_task(holder())
        await asyncio.sleep(0.02)
        _report(False)
        await asyncio.sleep(0.05)
        locked = gate._heavy_lock().locked()  # the new holder got the slot: it was free
        t.cancel()
        await asyncio.gather(t, return_exceptions=True)
        return locked, gate._heavy_lock().locked()

    assert asyncio.run(asyncio.wait_for(run(), 3)) == (True, False)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX nice")
def test_an_export_step_keeps_normal_priority():
    assert gate.low_priority(["python", "x.py"], "export_editor") == ["python", "x.py"]
    assert gate.low_priority(["python", "x.py"], "sample_frame")[1:3] == ["-n", str(gate.NICE_LEVEL)]
