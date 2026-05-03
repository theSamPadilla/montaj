import os
import sys
from unittest.mock import patch

import pytest
from starlette.testclient import TestClient


@pytest.fixture(autouse=True)
def _isolate_headless_env():
    """Ensure MONTAJ_HEADLESS doesn't leak between tests OR to other test
    modules in the same pytest session. Captures original state (env + any
    pre-existing cached serve.* modules), restores BOTH in teardown.

    Restoring the cached modules (rather than deleting them) is critical:
    other test files (e.g. test_server_reserve_path.py) import
    `from serve.server import app` at collection time and later
    `monkeypatch.setattr("serve.server.resolve_workspace", ...)`. If we left
    sys.modules in a deleted-or-replaced state, monkeypatch would patch a
    fresh module that the held `app` reference doesn't share, and the
    patched routes would 404 against the real workspace.
    """
    original_env = os.environ.get("MONTAJ_HEADLESS")
    original_modules = {m: sys.modules[m] for m in list(sys.modules) if m.startswith("serve.") or m == "serve"}
    yield
    # Restore env.
    if original_env is None:
        os.environ.pop("MONTAJ_HEADLESS", None)
    else:
        os.environ["MONTAJ_HEADLESS"] = original_env
    # Restore the cached serve.* modules to their pre-test identities so any
    # other test file's already-imported `app` reference stays consistent
    # with `monkeypatch.setattr("serve.server.<name>", ...)` lookups. We also
    # restore the parent `serve` package's `server` attribute — `import
    # serve.server` resolves via the parent package's attribute, not just
    # sys.modules, so without this an `import` after our reload still returns
    # the headless module even though sys.modules was restored.
    for m in [m for m in list(sys.modules) if m.startswith("serve.") or m == "serve"]:
        if m not in original_modules:
            del sys.modules[m]
    for m, mod in original_modules.items():
        sys.modules[m] = mod
    # Re-bind direct submodule attributes on the serve package — `import
    # serve.server` looks up `serve.server` as an attribute of the `serve`
    # package, so without this an `import serve.server` after reload picks
    # up the headless module's binding even when sys.modules is correct.
    serve_pkg = original_modules.get("serve")
    if serve_pkg is not None:
        for m, mod in original_modules.items():
            if m.startswith("serve.") and m.count(".") == 1:
                attr = m.split(".", 1)[1]
                setattr(serve_pkg, attr, mod)


def _reload_server_with_headless(headless: bool):
    """Re-import serve.server with HEADLESS env set so module-level
    conditional route registration takes the desired branch."""
    if headless:
        os.environ["MONTAJ_HEADLESS"] = "1"
    else:
        os.environ.pop("MONTAJ_HEADLESS", None)
    # Drop any cached import so the module-level `if not HEADLESS:` re-evaluates.
    for mod in [m for m in list(sys.modules) if m.startswith("serve.")]:
        del sys.modules[mod]
    import serve.server  # noqa: F401
    return sys.modules["serve.server"].app


def test_headless_spa_route_returns_404():
    app = _reload_server_with_headless(True)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/")
    assert resp.status_code == 404
    resp = client.get("/some-spa-path")
    assert resp.status_code == 404


def test_headless_api_routes_still_work():
    app = _reload_server_with_headless(True)
    client = TestClient(app, raise_server_exceptions=False)
    # /api/info exists in current server.py and requires no project; safe smoke test.
    resp = client.get("/api/info")
    assert resp.status_code == 200


def test_default_mode_spa_route_registered():
    app = _reload_server_with_headless(False)
    # Don't actually GET (would try to read dist/ or proxy to Vite).
    # Instead, inspect the route table.
    paths = [r.path for r in app.routes]
    assert "/{full_path:path}" in paths


def test_headless_mode_spa_route_not_registered():
    app = _reload_server_with_headless(True)
    paths = [r.path for r in app.routes]
    assert "/{full_path:path}" not in paths


def test_headless_lifespan_skips_vite_and_browser(tmp_path):
    """The lifespan-level gates (Vite spawn, webbrowser.open) only fire when
    lifespan() actually runs. TestClient triggers lifespan only when used as
    a context manager — `with TestClient(app) as client:`.

    We patch four things:
      - `subprocess.Popen` and `webbrowser.open` are the gates under test.
        Confirmed (via grep) that subprocess.Popen has exactly one call site
        in serve/server.py — the Vite spawn — so a flat assert_not_called()
        is correct. If a future change adds another Popen call site in
        lifespan, this assertion will need to narrow to inspect call_args.
      - `ProjectWatcher` and `GlobalOverlayWatcher` are patched to no-ops so
        the test doesn't start real filesystem watchers (which would bind to
        a real workspace dir and live for the duration of the `with` block).
      - `resolve_workspace` is patched to return tmp_path so lifespan's
        `workspace.mkdir(parents=True, exist_ok=True)` doesn't create the
        user's real `~/Montaj` (or configured workspace) directory."""
    app = _reload_server_with_headless(True)
    with patch("serve.server.subprocess.Popen") as mock_popen, \
         patch("serve.server.webbrowser.open") as mock_browser, \
         patch("serve.server.ProjectWatcher"), \
         patch("serve.server.GlobalOverlayWatcher"), \
         patch("serve.server.resolve_workspace", return_value=tmp_path):
        with TestClient(app, raise_server_exceptions=False) as client:
            # Hit any /api endpoint to ensure lifespan startup completed.
            client.get("/api/info")
        mock_popen.assert_not_called()
        mock_browser.assert_not_called()
