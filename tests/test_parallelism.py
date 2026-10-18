"""§338: a batch step's fan-out is capped by cores and free memory, never one
ffmpeg per input (a 20-clip import ran 20 silencedetects at once)."""
import importlib.util
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import parallelism  # noqa: E402
from parallelism import GB, MAX_BATCH_WORKERS, batch_workers, _darwin_available  # noqa: E402


@pytest.mark.parametrize("n, requested, cores, available, expected", [
    (20, 0, 24, 64 * GB, MAX_BATCH_WORKERS),   # a big Mac still stops at 4
    (20, 0, 4, 64 * GB, 2),                    # half the cores
    (20, 0, 24, 2 * GB + 1, 2),                # one worker per free GB
    (20, 0, 24, GB // 2, 1),                   # nearly out of memory: one at a time
    (2, 0, 24, 64 * GB, 2),                    # never more than the inputs
    (20, 3, 24, 64 * GB, 3),                   # an explicit -P below the cap is kept
    (20, 13, 24, 64 * GB, MAX_BATCH_WORKERS),  # an explicit -P above it is capped
    (20, 13, 24, GB, 1),
    (20, 0, 1, 64 * GB, 1),                    # one core
    (20, 0, 24, None, MAX_BATCH_WORKERS),      # memory unreadable: cores and the max decide
])
def test_batch_workers_cap(n, requested, cores, available, expected):
    assert batch_workers(n, requested, cores=cores, available=available) == expected


def test_batch_workers_reads_memory_when_not_given(monkeypatch):
    monkeypatch.setattr(parallelism, "available_memory_bytes", lambda: GB + 1)
    assert batch_workers(20, cores=24) == 1


def test_darwin_vm_stat_parse():
    out = ("Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
           "Pages free:                               65536.\n"
           "Pages active:                            900000.\n"
           "Pages inactive:                           65536.\n"
           "Pages speculative:                        65536.\n"
           "Pages wired down:                        200000.\n")
    assert _darwin_available(out) == 3 * 65536 * 16384
    assert _darwin_available("no header") is None


def test_available_memory_is_readable_here():
    got = parallelism.available_memory_bytes()
    assert got is None or got > 0


def _load_waveform_trim():
    path = os.path.join(os.path.dirname(__file__), "..", "steps", "audio", "waveform_trim.py")
    spec = importlib.util.spec_from_file_location("waveform_trim_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("argv_extra, available, expected", [
    ([], 64 * GB, MAX_BATCH_WORKERS),
    ([], GB, 1),
    (["-P", "20"], 64 * GB, MAX_BATCH_WORKERS),
])
def test_waveform_trim_batch_uses_the_cap(monkeypatch, capsys, argv_extra, available, expected):
    mod = _load_waveform_trim()
    seen = {}
    real_pool = mod.ThreadPoolExecutor

    class RecordingPool(real_pool):
        def __init__(self, max_workers=None, **kw):
            seen["max_workers"] = max_workers
            super().__init__(max_workers=max_workers, **kw)

    monkeypatch.setattr(mod, "ThreadPoolExecutor", RecordingPool)
    monkeypatch.setattr(mod, "process_one", lambda path, t, m: {"input": path, "keeps": [[0, 1]]})
    monkeypatch.setattr(parallelism, "available_memory_bytes", lambda: available)
    monkeypatch.setattr(parallelism.os, "cpu_count", lambda: 24)
    inputs = [f"/clips/{i}.mov" for i in range(20)]
    monkeypatch.setattr(sys, "argv", ["waveform_trim.py", "--inputs", *inputs, *argv_extra])
    mod.main()
    assert seen["max_workers"] == expected
    assert '"/clips/19.mov"' in capsys.readouterr().out
