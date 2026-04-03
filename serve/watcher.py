"""Watchdog file watcher. Detects project.json and .jsx writes and pushes to SSE broadcaster."""
import asyncio
import json
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from serve.sse import SSEBroadcaster


class _Handler(FileSystemEventHandler):
    def __init__(self, broadcaster: SSEBroadcaster, loop: asyncio.AbstractEventLoop):
        self._broadcaster = broadcaster
        self._loop = loop

    def on_modified(self, event):
        self._handle(event)

    def on_created(self, event):
        self._handle(event)

    def _handle(self, event):
        if event.is_directory:
            return
        path = event.src_path
        if path.endswith("project.json"):
            try:
                text = Path(path).read_text()
                data = json.loads(text)
                project_id = data.get("id")
                if not project_id:
                    return
                self._loop.call_soon_threadsafe(
                    self._broadcaster.publish, project_id, f"data: {text}\n\n"
                )
            except Exception:
                pass
        elif path.endswith(".jsx"):
            data = json.dumps({"path": path})
            self._loop.call_soon_threadsafe(
                self._broadcaster.publish, f"jsx:{path}", f"data: {data}\n\n"
            )


class GlobalOverlayWatcher:
    def __init__(self, broadcaster: SSEBroadcaster, loop: asyncio.AbstractEventLoop):
        self._broadcaster = broadcaster
        self._loop = loop
        self._observer = Observer()

    def start(self) -> None:
        handler = _Handler(self._broadcaster, self._loop)
        montaj_dir = Path.home() / ".montaj"

        # Watch global overlays
        overlays_dir = montaj_dir / "overlays"
        overlays_dir.mkdir(parents=True, exist_ok=True)
        self._observer.schedule(handler, str(overlays_dir), recursive=True)

        # Watch overlay dirs for any existing profiles
        profiles_dir = montaj_dir / "profiles"
        if profiles_dir.exists():
            for profile_dir in profiles_dir.iterdir():
                if not profile_dir.is_dir():
                    continue
                profile_overlays = profile_dir / "overlays"
                profile_overlays.mkdir(parents=True, exist_ok=True)
                self._observer.schedule(handler, str(profile_overlays), recursive=True)

        self._observer.start()

    def stop(self) -> None:
        self._observer.stop()
        self._observer.join()


class ProjectWatcher:
    def __init__(
        self,
        workspace_dir: Path,
        broadcaster: SSEBroadcaster,
        loop: asyncio.AbstractEventLoop,
    ):
        self._workspace_dir = workspace_dir
        self._broadcaster = broadcaster
        self._loop = loop
        self._observer = Observer()

    def start(self) -> None:
        handler = _Handler(self._broadcaster, self._loop)
        self._observer.schedule(handler, str(self._workspace_dir), recursive=True)
        self._observer.start()

    def stop(self) -> None:
        self._observer.stop()
        self._observer.join()
