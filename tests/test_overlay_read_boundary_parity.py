"""PV54: the render read boundary's roots match serve's.

montaj_assets/render/overlay-build.js computes, in Node, the folders an overlay
page may read under (overlayReadRoots). Its workspace must be serve's workspace
and its roots must cover serve's _allowed_file_roots(), or render and serve
disagree about what an overlay may use: a file the editor serves would fail to
render, or the reverse. Checked for each way the workspace is chosen.

Also pins the refusal marker: serve's bundle route recognises an import the
boundary refused by IMPORT_REFUSED's exact text, and if the two spellings drift
a refusal silently degrades from 403 import_outside_roots to a generic 422.

node is REQUIRED: a missing node fails these tests, it does not skip them.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from serve.common import _allowed_file_roots, resolve_workspace
from serve.routes import overlays as overlays_route

REPO = Path(__file__).resolve().parents[1]
OVERLAY_BUILD = REPO / "montaj_assets" / "render" / "overlay-build.js"

_JS = """
import { overlayReadRoots, workspaceDir, IMPORT_REFUSED } from %s
process.stdout.write(JSON.stringify({ roots: overlayReadRoots(), workspace: workspaceDir(), marker: IMPORT_REFUSED }))
"""


def _js() -> dict:
    """overlay-build.js's view, from a node child with this process's env."""
    node = shutil.which("node")
    assert node, "node is required for the read-boundary parity tests"
    r = subprocess.run(
        [node, "--input-type=module", "-e", _JS % json.dumps(OVERLAY_BUILD.as_uri())],
        capture_output=True, text=True, env=os.environ.copy(), timeout=60,
    )
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path.resolve() / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("MONTAJ_WORKSPACE_DIR", raising=False)
    return home


def _write_config(home: Path, cfg) -> None:
    (home / ".montaj").mkdir(exist_ok=True)
    (home / ".montaj" / "config.json").write_text(cfg if isinstance(cfg, str) else json.dumps(cfg))


def _assert_parity() -> None:
    js = _js()
    py_roots = [str(r) for r in _allowed_file_roots()]
    # The workspace: the same folder, resolved the same way, and first.
    assert str(Path(js["workspace"]).resolve()) == str(resolve_workspace().resolve())
    assert js["roots"][0] == py_roots[0]
    # serve's other roots are render's too. serve's is render's templates/overlays;
    # render's root is templates/, which holds it (and the caption templates).
    assert py_roots[1] in js["roots"] and py_roots[2] in js["roots"]
    templates = str((OVERLAY_BUILD.parent / "templates").resolve())
    assert templates in js["roots"]
    assert Path(py_roots[3]).is_relative_to(templates)


def test_compares_this_checkout():
    # Parity between this repo's Python and some other checkout's JS proves nothing.
    assert Path(overlays_route.__file__).resolve().is_relative_to(REPO)
    assert OVERLAY_BUILD.is_file()


def test_env_workspace(home, tmp_path, monkeypatch):
    ws = tmp_path.resolve() / "env-ws"
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    _write_config(home, {"workspaceDir": str(tmp_path / "config-ws")})  # the env var wins
    _assert_parity()
    assert _js()["roots"][0] == str(ws)


def test_config_workspace(home, tmp_path):
    ws = tmp_path.resolve() / "config-ws"
    ws.mkdir()
    _write_config(home, {"workspaceDir": str(ws)})
    _assert_parity()
    assert _js()["roots"][0] == str(ws)


def test_default_workspace(home):
    _assert_parity()
    assert _js()["roots"][0] == str(home / "Montaj")


def test_default_workspace_that_does_not_exist_yet(home):
    # A fresh machine: ~/Montaj is created later, and both sides still name it.
    assert not (home / "Montaj").exists()
    _assert_parity()


@pytest.mark.parametrize("cfg", ['{"workspaceDir": 42}', "not json", '["workspaceDir"]', "{}"])
def test_unusable_config_falls_back_to_default(home, cfg):
    _write_config(home, cfg)
    _assert_parity()
    assert _js()["roots"][0] == str(home / "Montaj")


def test_symlinked_workspace_compares_by_realpath(home, tmp_path, monkeypatch):
    real = tmp_path.resolve() / "real-ws"
    real.mkdir()
    link = tmp_path.resolve() / "link-ws"
    link.symlink_to(real)
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(link))
    _assert_parity()
    assert _js()["roots"][0] == str(real)


def test_refusal_marker_matches_the_route():
    assert _js()["marker"] == overlays_route._IMPORT_REFUSED
