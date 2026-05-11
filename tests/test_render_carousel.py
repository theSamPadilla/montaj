"""Regression tests for carousel render path dispatch.

Verifies that both serve/routes/projects.py and project/render.py resolve
render-carousel.js via render_runtime_dir() — not the hardcoded site-packages
path (MONTAJ_ROOT / "montaj_assets" / "render" / "render-carousel.js").

The bug: carousel branch used MONTAJ_ROOT directly, so in a prod install
(site-packages) Node would fail with ERR_MODULE_NOT_FOUND when importing
esbuild because node_modules lives in ~/.cache/montaj/render, not
site-packages/montaj_assets/render.
"""
import asyncio
import json
import os
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from starlette.testclient import TestClient

from serve.server import app
from serve.sse import SSEBroadcaster

client = TestClient(app, raise_server_exceptions=False)

_FAKE_CACHE_DIR_SUFFIX = "cache/montaj/render"  # appended to tmp_path in serve test


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """Standard workspace fixture: env var + in-process resolve_workspace patch
    + broadcaster stub."""
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setattr("serve.routes.projects.resolve_workspace", lambda: tmp_path)

    if not hasattr(app.state, "broadcaster"):
        app.state.broadcaster = SSEBroadcaster()

    return tmp_path


@pytest.fixture
def carousel_project_dir(workspace) -> Path:
    """Create a minimal carousel project directory on disk (skips the full
    /api/run subprocess chain — we only need project.json to exist so the
    render endpoint can read projectType)."""
    project_id = str(uuid.uuid4())
    project_dir = workspace / project_id
    project_dir.mkdir(parents=True)
    project_json = {
        "id": project_id,
        "projectType": "carousel",
        "name": "Regression Carousel",
        "status": "draft",
    }
    (project_dir / "project.json").write_text(json.dumps(project_json))
    return project_dir


# ---------------------------------------------------------------------------
# serve/routes/projects.py — POST /api/projects/{id}/render carousel branch
# ---------------------------------------------------------------------------

class TestServeRenderCarouselPath:
    """The render endpoint must call Node with a path under render_runtime_dir(),
    not under MONTAJ_ROOT / montaj_assets / render."""

    def test_carousel_render_uses_runtime_dir_not_montaj_root(
        self, carousel_project_dir, tmp_path, monkeypatch
    ):
        """Spawned Node command must reference render_runtime_dir()/render-carousel.js,
        not MONTAJ_ROOT/montaj_assets/render/render-carousel.js."""
        from serve.common import get_project_dir

        # Use a tmp_path-based fake cache dir so is_file() checks can pass on a
        # real filesystem (not read-only /fake/…).
        fake_cache_dir = tmp_path / _FAKE_CACHE_DIR_SUFFIX
        fake_cache_dir.mkdir(parents=True, exist_ok=True)

        # Create the fake script so the is_file() guard in the endpoint passes.
        fake_script = fake_cache_dir / "render-carousel.js"
        fake_script.touch()

        # Override render_runtime_dir to return our controlled tmp path.
        monkeypatch.setattr(
            "serve.routes.projects.render_runtime_dir",
            lambda: str(fake_cache_dir),
        )

        captured = {}

        async def fake_create_subprocess(*args, **kwargs):
            # Record the full arg list so we can inspect the script path.
            captured["args"] = list(args)
            proc = MagicMock()
            proc.pid = 99999
            proc.stdout = AsyncMock()
            proc.stderr = AsyncMock()
            proc.stdout.__aiter__ = AsyncMock(return_value=iter([]))
            proc.stderr.read = AsyncMock(return_value=b"")
            proc.wait = AsyncMock(return_value=0)
            proc.returncode = 0
            return proc

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess)

        # Patch get_project_dir dependency so FastAPI resolves our fixture dir.
        app.dependency_overrides[get_project_dir] = lambda: carousel_project_dir

        try:
            project_id = carousel_project_dir.name
            # Use stream=True so TestClient doesn't block on the SSE body.
            with client.stream("POST", f"/api/projects/{project_id}/render") as resp:
                # Consume at least the first chunk to trigger subprocess creation.
                for chunk in resp.iter_bytes():
                    break
        except Exception:
            pass
        finally:
            app.dependency_overrides.pop(get_project_dir, None)

        assert captured, "create_subprocess_exec was never called"
        script_arg = captured["args"][1]  # node_bin is args[0], script is args[1]
        assert str(script_arg) == str(fake_cache_dir / "render-carousel.js"), (
            f"Expected script under render_runtime_dir(), got: {script_arg}"
        )
        assert "montaj_assets" not in str(script_arg), (
            f"Script path must not reference site-packages montaj_assets/render: {script_arg}"
        )


# ---------------------------------------------------------------------------
# project/render.py — CLI render dispatcher carousel branch
# ---------------------------------------------------------------------------

class TestCliRenderCarouselPath:
    """project/render.main() must build the Node command with a render-carousel.js
    path resolved from render_runtime_dir(), not from MONTAJ_ROOT."""

    def test_carousel_cmd_uses_render_runtime_dir(self, tmp_path, monkeypatch):
        """render.main() carousel branch: cmd[1] (the script path) must come from
        render_runtime_dir(), not from MONTAJ_ROOT/montaj_assets/render/."""
        fake_cache_dir = str(tmp_path / _FAKE_CACHE_DIR_SUFFIX)

        # Build a minimal project.json with projectType=carousel.
        project_json = tmp_path / "project.json"
        project_json.write_text(json.dumps({"projectType": "carousel"}))

        captured = {}

        def fake_execvpe(file, args, env):
            captured["args"] = list(args)
            # Don't actually exec — just record and return.

        monkeypatch.setattr(os, "execvpe", fake_execvpe)

        from project import render as render_module
        # Reload to pick up the monkeypatch on render_runtime_dir.
        import importlib
        importlib.reload(render_module)
        # Re-apply the patches on the freshly reloaded module.
        monkeypatch.setattr(render_module, "render_runtime_dir", lambda: fake_cache_dir)
        monkeypatch.setattr(os, "execvpe", fake_execvpe)

        render_module.main(project_path=str(project_json))

        assert captured, "os.execvpe was never called"
        script_arg = captured["args"][1]  # args[0] is "node"
        assert script_arg == os.path.join(fake_cache_dir, "render-carousel.js"), (
            f"Expected script under render_runtime_dir(), got: {script_arg}"
        )
        assert "montaj_assets" not in script_arg, (
            f"Script must not reference site-packages montaj_assets/render: {script_arg}"
        )

    def test_non_carousel_cmd_uses_render_runtime_dir(self, tmp_path, monkeypatch):
        """render.main() non-carousel branch: also resolved via render_runtime_dir()."""
        fake_cache_dir = str(tmp_path / _FAKE_CACHE_DIR_SUFFIX)

        project_json = tmp_path / "project.json"
        project_json.write_text(json.dumps({"projectType": "lyrics_video"}))

        captured = {}

        def fake_execvpe(file, args, env):
            captured["args"] = list(args)

        monkeypatch.setattr(os, "execvpe", fake_execvpe)

        from project import render as render_module
        import importlib
        importlib.reload(render_module)
        monkeypatch.setattr(render_module, "render_runtime_dir", lambda: fake_cache_dir)
        monkeypatch.setattr(os, "execvpe", fake_execvpe)

        render_module.main(project_path=str(project_json))

        assert captured, "os.execvpe was never called"
        script_arg = captured["args"][1]
        assert script_arg == os.path.join(fake_cache_dir, "render.js"), (
            f"Expected script under render_runtime_dir(), got: {script_arg}"
        )
        assert "montaj_assets" not in script_arg, (
            f"Script must not reference site-packages montaj_assets/render: {script_arg}"
        )
