"""How many heavy subprocesses (one ffmpeg each) a batch step runs at once.

A batch step used to start one worker per input, so a 20-clip import ran 20
silencedetect ffmpegs together (about 600 MB each) next to the proxy encodes,
and the Mac went to load 200 and into swap (§338). The cap here is the smallest
of: MAX_BATCH_WORKERS, half the cores, one worker per GB the OS can hand out
right now, and the number of inputs; never below 1.
"""
import os
import re
import subprocess
import sys

MAX_BATCH_WORKERS = 4
GB = 1 << 30


def available_memory_bytes() -> int | None:
    """Memory the OS can give a new process now without swapping, or None when it
    cannot be read (then only cores and MAX_BATCH_WORKERS cap the batch)."""
    try:
        if sys.platform == "darwin":
            vm_stat = "/usr/bin/vm_stat" if os.path.exists("/usr/bin/vm_stat") else "vm_stat"
            out = subprocess.run([vm_stat], capture_output=True, text=True, timeout=5).stdout
            return _darwin_available(out)
        if sys.platform.startswith("linux"):
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemAvailable:"):
                        return int(line.split()[1]) * 1024
            return None
        if sys.platform == "win32":
            import ctypes

            class _MemoryStatusEx(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            status = _MemoryStatusEx()
            status.dwLength = ctypes.sizeof(status)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return int(status.ullAvailPhys)
    except Exception:
        return None
    return None


def _darwin_available(vm_stat_output: str) -> int | None:
    """free + inactive + speculative pages, from `vm_stat`'s text."""
    m = re.search(r"page size of (\d+) bytes", vm_stat_output)
    if not m:
        return None
    pages = 0
    for key in ("Pages free", "Pages inactive", "Pages speculative"):
        k = re.search(rf"^{key}:\s+(\d+)\.", vm_stat_output, re.M)
        if k:
            pages += int(k.group(1))
    return pages * int(m.group(1))


def batch_workers(n_items: int, requested: int = 0, *, per_worker_bytes: int = GB,
                  cores: int | None = None, available: int | None | bool = True) -> int:
    """Workers for a batch of `n_items`. `requested` (a caller's -P) is honoured
    only up to the same cap, so no caller can fan out past what the machine can
    hold. `cores` and `available` are for tests; `available=True` reads it now."""
    cores = cores if cores is not None else (os.cpu_count() or 1)
    if available is True:
        available = available_memory_bytes()
    cap = min(MAX_BATCH_WORKERS, max(1, cores // 2))
    if isinstance(available, int) and not isinstance(available, bool):
        cap = min(cap, max(1, available // per_worker_bytes))
    want = requested if requested and requested > 0 else n_items
    return max(1, min(want, cap, n_items))
