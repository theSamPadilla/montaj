"""serve refuses a Host outside MONTAJ_SERVE_TRUSTED_HOSTS (DNS rebinding).

A page whose hostname resolves to 127.0.0.1 is same-origin with serve, so
`montaj serve` sets MONTAJ_SERVE_TRUSTED_HOSTS=127.0.0.1,localhost unless
--network. Unset, nothing is checked (TestClient's Host is `testserver`).
"""
import os
import types

import pytest
import uvicorn
from starlette.testclient import TestClient

from cli.commands import serve as serve_cmd
from serve.server import app

ENV = "MONTAJ_SERVE_TRUSTED_HOSTS"


def _get(host=None):
    headers = {"host": host} if host else {}
    return TestClient(app, raise_server_exceptions=False).get("/api/info", headers=headers)


@pytest.fixture
def trusted(monkeypatch):
    monkeypatch.setenv(ENV, "127.0.0.1,localhost")


@pytest.mark.parametrize("host", ["127.0.0.1:12345", "localhost:12345", "127.0.0.1", "localhost"])
def test_loopback_host_passes(trusted, host):
    assert _get(host).status_code == 200


@pytest.mark.parametrize("host", [
    "evil.example",
    "evil.example:12345",
    "127.0.0.1.evil.example",
    "127.0.0.1.evil.example:12345",
    "localhost.evil.example",
    "testserver",
])
def test_other_host_is_refused(trusted, host):
    resp = _get(host)
    assert resp.status_code == 400
    assert resp.text == "Invalid host header"


def test_unset_checks_nothing(monkeypatch):
    monkeypatch.delenv(ENV, raising=False)
    assert _get().status_code == 200
    assert _get("evil.example").status_code == 200


def test_env_set_after_import_takes_effect(monkeypatch):
    # `app` was built at import, above. The check reads the env per request,
    # so a value set afterwards (as the CLI's may be) still applies.
    monkeypatch.delenv(ENV, raising=False)
    assert _get("evil.example").status_code == 200
    monkeypatch.setenv(ENV, "127.0.0.1,localhost")
    assert _get("evil.example").status_code == 400
    assert _get("127.0.0.1:12345").status_code == 200


# ── the CLI sets it ──────────────────────────────────────────────────────────

def _serve(monkeypatch, network):
    # handle() writes these into os.environ. setenv then delenv makes
    # monkeypatch restore each one's original state, absent included.
    for name in ("MONTAJ_SERVE_PORT", "MONTAJ_HEADLESS", "MONTAJ_DEBUG", ENV):
        monkeypatch.setenv(name, "")
        monkeypatch.delenv(name)
    monkeypatch.setattr(serve_cmd, "check_fatal_deps", lambda: [])
    monkeypatch.setattr(serve_cmd, "check_nonfatal_deps", lambda: [])
    seen = []
    monkeypatch.setattr(uvicorn, "run", lambda *a, **k: seen.append((os.environ.get(ENV), k["host"])))
    args = types.SimpleNamespace(port=3999, network=network, debug=False, headless=True)
    serve_cmd.handle(args)
    return seen


def test_cli_sets_trusted_hosts_on_loopback(monkeypatch):
    assert _serve(monkeypatch, network=False) == [("127.0.0.1,localhost", "127.0.0.1")]


def test_cli_leaves_network_unchecked(monkeypatch):
    assert _serve(monkeypatch, network=True) == [(None, "0.0.0.0")]
