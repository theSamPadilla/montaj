"""Where a running `montaj serve` announces itself.

The MCP server is a separate process launched by Claude Desktop; it shares no
environment with `montaj serve` (`MONTAJ_SERVE_PORT` is set in serve's OWN
os.environ and never reaches a sibling process). This file is the handshake:
serve writes it at startup, removes it at shutdown, and any other local process
reads it to find the port.

Liveness is checked by pid, not by connecting: a hard-killed serve leaves the
file behind, and a stale file that still parses is worse than no file at all.
"""
import json
import os
from pathlib import Path


def _lockfile_path() -> Path:
    return Path.home() / ".montaj" / "serve.json"


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Exists but is owned by someone else — still a live process.
        return True
    except (OverflowError, ValueError):
        return False
    return True


def write(*, port: int, workspace: Path) -> None:
    """Announce this process. Atomic — a reader never sees a half-written file."""
    path = _lockfile_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"port": port, "pid": os.getpid(), "workspace": str(workspace)}
    tmp = path.with_suffix(f".json.tmp{os.getpid()}")
    tmp.write_text(json.dumps(payload))
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def read() -> dict | None:
    """The live serve's info, or None when there isn't one.

    Returns None for: absent, unparseable, missing keys, or a pid that is gone.
    Callers get one clean "no serve" answer instead of five failure modes.
    """
    path = _lockfile_path()
    try:
        info = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(info, dict):
        return None
    port, pid = info.get("port"), info.get("pid")
    if not isinstance(port, int) or not isinstance(pid, int):
        return None
    if not _pid_alive(pid):
        return None
    return info


def remove() -> None:
    """Idempotent, and only ever removes OUR announcement.

    A second serve overwrites this file with its own pid; if that one exits
    first, unlinking unconditionally would un-announce the serve still running
    and leave the MCP server reporting "not running" against a live process.
    """
    try:
        info = json.loads(_lockfile_path().read_text())
        if info.get("pid") != os.getpid():
            return
        _lockfile_path().unlink()
    except (OSError, ValueError, AttributeError):
        pass
