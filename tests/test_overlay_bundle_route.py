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
    # PV54: the read boundary refuses the import unread, and the route names
    # the refused file and nothing else.
    assert detail["message"] == f"Overlay imports a file outside the allowed roots: {outside / 'secret.js'}"


def test_relative_import_climbing_out_403_names_the_file(env):
    base, _, ws = env
    outside = base / "outside"; outside.mkdir()
    (outside / "palette.json").write_text('{"accent": "#c0ffee"}\n')
    d = ws / "ov"; d.mkdir()
    (d / "ov.jsx").write_text(
        "import p from '../../outside/palette.json'\nexport default function O() { return <b>{p.accent}</b> }\n"
    )
    r = _get(d / "ov.jsx")
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == {
        "error": "import_outside_roots",
        "message": f"Overlay imports a file outside the allowed roots: {outside / 'palette.json'}",
    }
    assert "c0ffee" not in r.text


def test_directory_import_outside_403_names_the_directory_not_its_main(env):
    # PV54: refused before esbuild resolves it, so esbuild never reads the
    # folder's package.json. Its `main` is package.json content, so a message
    # naming `lib/entry.js` would mean the file had been read.
    base, _, ws = env
    lib = base / "outside" / "lib"; lib.mkdir(parents=True)
    (lib / "package.json").write_text('{"name": "lib", "main": "entry.js"}\n')
    (lib / "entry.js").write_text("export const accent = 1\n")
    d = ws / "ov"; d.mkdir()
    (d / "ov.jsx").write_text(
        f"import {{ accent }} from '{lib}'\nexport default function O() {{ return <b>{{accent}}</b> }}\n"
    )
    r = _get(d / "ov.jsx")
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["message"] == f"Overlay imports a file outside the allowed roots: {lib}"
    assert "entry.js" not in r.text


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
    # esbuild's first line is deliberately in `firstError` now (§136); the
    # message and the log-only stderr stay generic.
    assert r.json()["detail"]["firstError"] == 'oops "hunter2-SECRET"'


def test_exit_2_message_without_location_carries_first_error_paths_shortened(env):
    _, _, ws = env
    msg = f'Could not resolve "{ws}/ov/ov.jsx"\n  second line {ws}/x'
    out = json.dumps({"ok": False, "error": "build_failed", "message": msg}).encode()
    r = _run_mocked(env, _FakeProc(rc=2, out=out))
    assert r.status_code == 422
    d = r.json()["detail"]
    assert d["error"] == "build_failed" and d["message"] == "build failed"
    assert d["firstError"] == 'Could not resolve "ov.jsx"'
    assert str(ws) not in r.text and "second line" not in r.text


def test_first_error_is_project_relative_and_capped():
    base = Path("/w/proj")
    f = overlays_route._first_error_line
    assert f('Could not resolve "/w/proj/ov/a.jsx" and "/etc/x/b.js"', base) == 'Could not resolve "ov/a.jsx" and "b.js"'
    assert f("react/jsx-runtime missing", None) == "react/jsx-runtime missing"
    assert len(f("x" * 1000, None)) == 300


def test_exit_2_outside_roots_is_403_without_esbuild_text(env):
    base, _, _ = env
    out = json.dumps({"ok": False, "error": "build_failed",
                      "message": f'{base}/outside/s.js:1:23: Expected ";" but found "hunter2"'}).encode()
    r = _run_mocked(env, _FakeProc(rc=2, out=out))
    assert r.status_code == 403
    assert "hunter2" not in r.text


def test_import_from_a_missing_folder_in_the_workspace_is_422_not_403(env):
    # A typo is a plain not-found, not a refusal: a missing path inside the
    # roots is judged by its nearest existing folder (PV54 T3).
    _, _, ws = env
    d = ws / "ov"; d.mkdir()
    (d / "ov.jsx").write_text(
        "import { H } from './lib/helpers.js'\nexport default function O() { return <b>{H}</b> }\n"
    )
    r = _get(d / "ov.jsx")
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "build_failed"
    assert "Could not resolve" in r.json()["detail"]["message"]


def test_exit_2_read_boundary_refusal_is_403_naming_only_the_refused_path(env):
    # The guard's refusal is an esbuild plugin error located at the IMPORTER,
    # which is inside the roots (measured shape, PV54). Classified by the
    # marker, not by the location, or it would be a 422 without the path.
    base, _, ws = env
    importer = ws / "ov" / "ov.jsx"
    out = json.dumps({"ok": False, "error": "build_failed",
                      "message": f"{importer}:1:18: {overlays_route._IMPORT_REFUSED} {base}/outside/s.js"}).encode()
    r = _run_mocked(env, _FakeProc(rc=2, out=out))
    assert r.status_code == 403
    assert r.json()["detail"] == {
        "error": "import_outside_roots",
        "message": f"Overlay imports a file outside the allowed roots: {base}/outside/s.js",
    }


def test_exit_2_read_boundary_refusal_without_location_is_403(env):
    base, _, _ = env
    out = json.dumps({"ok": False, "error": "build_failed",
                      "message": f"{overlays_route._IMPORT_REFUSED} {base}/outside/s.js"}).encode()
    r = _run_mocked(env, _FakeProc(rc=2, out=out))
    assert r.status_code == 403
    assert r.json()["detail"]["message"] == f"Overlay imports a file outside the allowed roots: {base}/outside/s.js"


def test_exit_2_marker_quoted_inside_a_syntax_error_is_not_a_refusal(env):
    # Only the guard's own error STARTS with the marker after the location; a
    # syntax error that merely quotes it is an ordinary 422 in an inside file.
    _, _, ws = env
    loc = str(ws / "ov" / "helper.js")
    message = f'{loc}:1:2: Expected ";" but found "{overlays_route._IMPORT_REFUSED} /x"'
    out = json.dumps({"ok": False, "error": "build_failed", "message": message}).encode()
    r = _run_mocked(env, _FakeProc(rc=2, out=out))
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "build_failed"


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


# --- drive-letter paths (Windows esbuild locations) -------------------------

def test_refused_import_on_a_drive_letter_path():
    msg = r"C:\Users\a\x.jsx:1:18: import outside the allowed folders: C:\o\y.js"
    assert overlays_route._refused_import(msg) == r"C:\o\y.js"


@pytest.mark.parametrize("msg,path", [
    (r"C:\Users\a b\x.jsx:3:4: Unexpected", r"C:\Users\a b\x.jsx"),
    ("C:/Users/a/x.jsx:3:4: Unexpected", "C:/Users/a/x.jsx"),
    ("/Users/a/x.jsx:3:4: Unexpected", "/Users/a/x.jsx"),
])
def test_esbuild_loc_matches_drive_letter_and_posix(msg, path):
    m = overlays_route._ESBUILD_LOC.match(msg)
    assert m is not None and m.groups() == (path, "3", "4")
