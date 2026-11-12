"""onnxruntime with its usage telemetry off. Montaj imports onnxruntime only
through load().

onnxruntime 1.31.1 on macOS starts Microsoft's telemetry when it is imported:
it writes a device id and an event store under ~/Library/Application Support/
Microsoft/DeveloperTools/.onnxruntime/ and flushes them at process exit, and
that exit flush once held a finished process for 35 minutes.
ORT_DISABLE_TELEMETRY=1, read when onnxruntime creates its telemetry, stops it
being created at all, so it must be set before the first import.
disable_telemetry_events() only stops further events, so it is the fallback for
a process that imported onnxruntime before load(); older builds without it
skip it.
"""
import os


def load():
    """Import onnxruntime with telemetry off and return the module. Raises
    ImportError, named onnxruntime, when it is not installed."""
    os.environ["ORT_DISABLE_TELEMETRY"] = "1"
    import onnxruntime
    off = getattr(onnxruntime, "disable_telemetry_events", None)
    if callable(off):
        try:
            off()
        except Exception:
            pass
    return onnxruntime
