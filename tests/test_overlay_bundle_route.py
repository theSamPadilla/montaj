"""GET /api/overlays/bundle (PV49 T2). Real node runs, plus mocked-subprocess mappings.

node is REQUIRED: a missing node fails these tests, it does not skip them.
"""
import asyncio
import json
import shutil
import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from starlette.testclient import TestClient

from serve.routes import overlays as overlays_route
from serve.server import app


@pytest.fixture(autouse=True)
def _require_node():
    assert shutil.which("node"), "node is required for the overlay bundle route tests"


@pytest.fixture
def env(tmp_path, monkeypatch):
    base = tmp_path.resolve()
    home = base / "home"
    ws = base / "ws"
    home.mkdir(); ws.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    return base, home, ws


def _chain(ws: Path) -> Path:
    d = ws / "ov"
    d.mkdir(parents=True)
    (d / "nested.js").write_text("export const N = 'n'\n")
    (d / "helper.js").write_text("import { N } from './nested.js'\nexport const H = N + 'h'\n")
    (d / "ov.jsx").write_text(
        "import { H } from './helper.js'\n"
        "export default function Ov() { return <div>{H}</div> }\n"
    )
    return d / "ov.jsx"


def _get(path):
    return TestClient(app).get("/api/overlays/bundle", params={"path": str(path)})


def test_chain_ok(env):
    _, _, ws = env
    entry = _chain(ws)
    r = _get(entry)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    assert body["code"]
    d = ws / "ov"
    assert sorted(body["inputs"]) == sorted(str(d / n) for n in ("ov.jsx", "helper.js", "nested.js"))


def test_symlinked_workspace_watcher_spelling(env, monkeypatch):
    base, _, _ = env
    real_ws = base / "realws"
    real_ws.mkdir()
    link = base / "linkws"
    link.symlink_to(real_ws)
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(link))
    entry = _chain(real_ws)
    r = _get(link / "ov" / "ov.jsx")
    assert r.status_code == 200, r.text
    # Measured 2026-09-29: on darwin the watcher reports REAL paths even when
    # scheduled on a symlink; elsewhere it reports the scheduled (link) spelling.
    base_dir = real_ws if sys.platform == "darwin" else link
    assert sorted(r.json()["inputs"]) == sorted(
        str(base_dir / "ov" / n) for n in ("ov.jsx", "helper.js", "nested.js")
    )


def test_watcher_spelling_rebase_off_darwin(env, monkeypatch):
    base, _, _ = env
    real_ws = base / "realws"
    real_ws.mkdir()
    link = base / "linkws"
    link.symlink_to(real_ws)
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(link))
    monkeypatch.setattr(overlays_route.sys, "platform", "linux")
    assert overlays_route._watcher_spelling(real_ws / "a" / "x.js") == str(link / "a" / "x.js")
    assert overlays_route._watcher_spelling(base / "elsewhere.js") == str(base / "elsewhere.js")


def test_helper_outside_roots(env):
    base, _, ws = env
    outside = base / "outside"
    outside.mkdir()
    (outside / "secret.js").write_text("export const S = 1\n")
    d = ws / "ov"
    d.mkdir()
    (d / "ov.jsx").write_text(
        f"import {{ S }} from '{outside / 'secret.js'}'\nexport default function O() {{ return <b>{{S}}</b> }}\n"
    )
    r = _get(d / "ov.jsx")
    assert r.status_code == 403
    detail = r.json()["detail"]
    assert detail["error"] == "import_outside_roots"
    assert "secret.js" in detail["message"]


def test_syntax_error_422(env):
    _, _, ws = env
    d = ws / "ov"; d.mkdir()
    (d / "ov.jsx").write_text("export default function O() { return <div> }\n")
    r = _get(d / "ov.jsx")
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["error"] == "build_failed"
    assert "ov.jsx" in detail["message"]


def test_import_remotion_422(env):
    _, _, ws = env
    d = ws / "ov"; d.mkdir()
    (d / "ov.jsx").write_text(
        "import { useCurrentFrame } from 'remotion'\nexport default function O() { return <i/> }\n"
    )
    r = _get(d / "ov.jsx")
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["error"] == "build_failed"
    assert "remotion" in detail["message"]


def test_missing_404(env):
    _, _, ws = env
    r = _get(ws / "nope.jsx")
    assert r.status_code == 404


def test_relative_and_missing_param_400(env):
    assert _get("rel/ov.jsx").status_code == 400
    assert TestClient(app).get("/api/overlays/bundle").status_code == 400


def test_entry_outside_roots_403(env):
    base, _, _ = env
    f = base / "stray.jsx"
    f.write_text("export default () => null\n")
    r = _get(f)
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "forbidden"


# ── mocked subprocess ─────────────────────────────────────────────────────────

class _FakeProc:
    def __init__(self, rc=0, out=b"", err=b"", hang=False):
        self.returncode = rc
        self._out, self._err, self._hang = out, err, hang
        self.killed = False

    async def communicate(self):
        if self._hang:
            await asyncio.sleep(3600)
        return self._out, self._err

    def kill(self):
        self.killed = True
        self.returncode = -9
        self._hang = False

    async def wait(self):
        return self.returncode


def _run_mocked(env, proc, timeout=None):
    _, _, ws = env
    entry = _chain(ws)

    async def fake_exec(*a, **k):
        return proc

    with patch.object(overlays_route.asyncio, "create_subprocess_exec", fake_exec):
        if timeout is not None:
            with patch.object(overlays_route, "_BUNDLE_TIMEOUT_S", timeout):
                return _get(entry)
        return _get(entry)


def test_timeout_kills_child_504(env):
    proc = _FakeProc(hang=True)
    r = _run_mocked(env, proc, timeout=0.05)
    assert r.status_code == 504
    assert r.json()["detail"]["error"] == "bundle_timeout"
    assert proc.killed


def test_exit_1_is_500_without_stderr_in_body(env):
    r = _run_mocked(env, _FakeProc(rc=1, err=b'/x/s.js:1:2: Expected ";" but found "hunter2-SECRET"'))
    assert r.status_code == 500
    assert "hunter2" not in r.text


def test_exit_2_is_422(env):
    _, _, ws = env
    loc = str(ws / "ov" / "helper.js")
    out = json.dumps({"ok": False, "error": "build_failed", "message": f"{loc}:1:2: bad"}).encode()
    r = _run_mocked(env, _FakeProc(rc=2, out=out))
    assert r.status_code == 422
    assert r.json()["detail"] == {"error": "build_failed", "message": f"{loc}:1:2: bad"}


def test_exit_2_message_without_location_is_generic(env):
    out = json.dumps({"ok": False, "error": "build_failed", "message": 'oops "hunter2-SECRET"'}).encode()
    r = _run_mocked(env, _FakeProc(rc=2, out=out))
    assert r.status_code == 422
    assert r.json()["detail"]["message"] == "build failed"
    assert "hunter2" not in r.text


def test_exit_2_outside_roots_is_403_without_esbuild_text(env):
    base, _, _ = env
    out = json.dumps({"ok": False, "error": "build_failed",
                      "message": f'{base}/outside/s.js:1:23: Expected ";" but found "hunter2"'}).encode()
    r = _run_mocked(env, _FakeProc(rc=2, out=out))
    assert r.status_code == 403
    assert "hunter2" not in r.text


def test_cancellation_kills_and_reaps_child(env):
    _, _, ws = env
    entry = _chain(ws)
    proc = _FakeProc(hang=True)
    waited = []
    orig_wait = proc.wait

    async def wait():
        waited.append(True)
        return await orig_wait()
    proc.wait = wait

    async def fake_exec(*a, **k):
        return proc

    async def go():
        with patch.object(overlays_route.asyncio, "create_subprocess_exec", fake_exec):
            t = asyncio.ensure_future(overlays_route.bundle_overlay(path=str(entry)))
            await asyncio.sleep(0.1)
            t.cancel()
            with pytest.raises(asyncio.CancelledError):
                await t

    asyncio.run(go())
    assert proc.killed and waited


def test_exit_0_garbage_is_500(env):
    r = _run_mocked(env, _FakeProc(rc=0, out=b"not json hunter2-SECRET"))
    assert r.status_code == 500
    assert "hunter2" not in r.text


@pytest.mark.parametrize("name,body", [
    ("s.js", 'export const S = "a" "hunter2-SECRET"\n'),
    ("s.json", '{"k": 1 "hunter2-SECRET"}\n'),
])
def test_real_syntax_error_outside_roots_403_no_leak(env, name, body):
    base, _, ws = env
    outside = base / "outside"; outside.mkdir()
    (outside / name).write_text(body)
    d = ws / "ov"; d.mkdir()
    (d / "ov.jsx").write_text(
        f"import S from '{outside / name}'\nexport default function O() {{ return <b>{{String(S)}}</b> }}\n"
    )
    r = _get(d / "ov.jsx")
    assert r.status_code == 403, r.text
    assert "hunter2" not in r.text
    assert name in r.json()["detail"]["message"]


def test_real_syntax_error_in_imported_helper_inside_roots_422(env):
    _, _, ws = env
    d = ws / "ov"; d.mkdir()
    (d / "h.js").write_text("export const S = = 1\n")
    (d / "ov.jsx").write_text(
        "import { S } from './h.js'\nexport default function O() { return <b>{S}</b> }\n"
    )
    r = _get(d / "ov.jsx")
    assert r.status_code == 422, r.text
    assert "h.js" in r.json()["detail"]["message"]
