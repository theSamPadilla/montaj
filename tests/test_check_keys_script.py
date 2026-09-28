"""Tests for scripts/check-keys.sh — PV29 T8a.

check-keys.sh is the pre-release guard against FQ1 #22 (a retired connector
default model reaching users unnoticed). It shells out to the real
steps/credentials/check_key.py for every provider in lib/credentials.py's
KNOWN_PROVIDERS, and must never make a real vendor call and never run
against this machine's real ~/.montaj/credentials.json.

Test mechanism (documented per the task spec, which asks for whichever
approach "needs no production code path for tests"): every test builds an
isolated MIRROR repo under pytest's tmp_path —

    mirror/
      lib/__init__.py, lib/common.py, lib/credentials.py   (byte-for-byte
      connectors/__init__.py                                copies of the
      steps/__init__.py, steps/credentials/check_key.py     REAL files)
      connectors/gemini.py, connectors/openai.py            (FAKES written
                                                               per test)
      scripts/check-keys.sh                                 (copy of the
                                                               script under
                                                               test)

check-keys.sh resolves its own repo root from its own location
(dirname($0)/..), so running the copy inside the mirror makes every relative
path (lib/, connectors/, steps/credentials/check_key.py) resolve inside the
mirror, completely isolated from the real repo tree. The production files
above (lib/credentials.py, lib/common.py, connectors/__init__.py,
steps/credentials/check_key.py) are copied VERBATIM, never edited — this
needs no test-only branch in any of them, and steps/credentials/ and
connectors/ are never touched on disk in the real tree. Only the two
connector modules the fake providers dispatch to (connectors/gemini.py,
connectors/openai.py) are fakes, written fresh per test with a
`check_key()` that returns/raises exactly what the scenario needs — no
network call, ever.

Every subprocess run gets an explicit, minimal env (never os.environ.copy())
with HOME pointed at an empty tmp_path directory, so there is no path by
which a real key from this machine's ~/.montaj/credentials.json or shell
environment could reach the script.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
SCRIPT = REPO_ROOT / "scripts" / "check-keys.sh"


def _mirror_repo(tmp_path: Path) -> Path:
    """Build an isolated repo mirror with real production files copied
    verbatim (never modified) plus an empty scaffold for fake connectors."""
    mirror = tmp_path / "mirror"
    (mirror / "lib").mkdir(parents=True)
    (mirror / "connectors").mkdir(parents=True)
    (mirror / "steps" / "credentials").mkdir(parents=True)
    (mirror / "scripts").mkdir(parents=True)

    shutil.copy2(REPO_ROOT / "lib" / "__init__.py", mirror / "lib" / "__init__.py")
    shutil.copy2(REPO_ROOT / "lib" / "common.py", mirror / "lib" / "common.py")
    shutil.copy2(REPO_ROOT / "lib" / "credentials.py", mirror / "lib" / "credentials.py")
    shutil.copy2(REPO_ROOT / "connectors" / "__init__.py", mirror / "connectors" / "__init__.py")
    shutil.copy2(REPO_ROOT / "steps" / "__init__.py", mirror / "steps" / "__init__.py")
    shutil.copy2(
        REPO_ROOT / "steps" / "credentials" / "check_key.py",
        mirror / "steps" / "credentials" / "check_key.py",
    )
    shutil.copy2(SCRIPT, mirror / "scripts" / "check-keys.sh")
    os.chmod(mirror / "scripts" / "check-keys.sh", 0o755)

    return mirror


def _write_connector(mirror: Path, provider: str, source: str) -> None:
    (mirror / "connectors" / f"{provider}.py").write_text(source)


def _add_provider_support(mirror: Path, provider: str, module: str) -> None:
    """Patch the MIRROR's copy of check_key.py to support one more provider
    — proves check-keys.sh reads the supported list at runtime rather than
    carrying its own hardcoded copy. Never touches the real repo file."""
    path = mirror / "steps" / "credentials" / "check_key.py"
    text = path.read_text()
    old = 'PROVIDERS = {"gemini": "connectors.gemini", "openai": "connectors.openai"}'
    assert old in text, "check_key.py's PROVIDERS line changed shape — update this test"
    new = old[:-1] + f', "{provider}": "{module}"}}'
    path.write_text(text.replace(old, new))


def _run(mirror: Path, extra_env: dict | None = None) -> subprocess.CompletedProcess:
    home = mirror.parent / "home"
    home.mkdir(exist_ok=True)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "PYTHON": sys.executable,
    }
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [str(mirror / "scripts" / "check-keys.sh")],
        cwd=mirror, env=env, capture_output=True, text=True, timeout=30,
    )


OK_GEMINI = """
def check_key():
    return {"ok": True, "default_model": "fake-gemini-model",
            "default_model_ok": True, "detail": "2 models available"}
"""

OK_OPENAI = """
def check_key():
    return {"ok": True, "default_model": "fake-openai-model",
            "default_model_ok": True, "detail": "ok"}
"""


class TestNoKeys:
    def test_exits_zero_with_skip_warning(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        # No connectors/gemini.py or connectors/openai.py needed at all —
        # has_key() short-circuits before check_key.py is ever invoked.
        result = _run(mirror)

        assert result.returncode == 0, result.stderr
        assert "gemini: no key" in result.stdout
        assert "openai: no key" in result.stdout
        assert "no key (skipped)" in result.stdout
        assert "gemini" in result.stdout.split("no key (skipped):")[1]
        assert "openai" in result.stdout.split("no key (skipped):")[1]


class TestUnsupportedProvidersToday:
    def test_kling_serpapi_fal_elevenlabs_are_no_check_yet(self, tmp_path):
        """Controller clarification: check_key only supports gemini/openai
        today. Every other KNOWN_PROVIDERS entry must warn, not fail."""
        mirror = _mirror_repo(tmp_path)
        result = _run(mirror)

        assert result.returncode == 0, result.stderr
        for provider in ("kling", "serpapi", "fal", "elevenlabs"):
            assert f"{provider}: no check yet" in result.stdout
        skip_line = [l for l in result.stdout.splitlines() if l.startswith("not yet supported")]
        assert skip_line, result.stdout
        for provider in ("kling", "serpapi", "fal", "elevenlabs"):
            assert provider in skip_line[0]


class TestAllOk:
    def test_exits_zero(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        _write_connector(mirror, "gemini", OK_GEMINI)
        _write_connector(mirror, "openai", OK_OPENAI)

        result = _run(mirror, {"GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key"})

        assert result.returncode == 0, result.stderr
        assert "gemini: ok" in result.stdout
        assert "openai: ok" in result.stdout
        assert "SUMMARY: 2 ok, 0 retired model, 0 rejected, 0 insufficient credit, 0 unreachable" in result.stdout


class TestRetiredDefaultModel:
    def test_exits_nonzero_and_names_the_model(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        _write_connector(mirror, "gemini", OK_GEMINI)
        _write_connector(mirror, "openai", """
def check_key():
    return {"ok": True, "default_model": "totally-retired-model-xyz",
            "default_model_ok": False, "detail": "model not in list"}
""")

        result = _run(mirror, {"GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key"})

        assert result.returncode != 0
        assert "openai: DEFAULT MODEL RETIRED: totally-retired-model-xyz" in result.stdout
        assert "1 retired model" in result.stdout


class TestRejectedKey:
    def test_exits_nonzero(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        _write_connector(mirror, "gemini", """
from connectors import ConnectorError
def check_key():
    raise ConnectorError("Gemini rejected the API key: bad key", reason="invalid_api_key")
""")
        _write_connector(mirror, "openai", OK_OPENAI)

        result = _run(mirror, {"GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key"})

        assert result.returncode != 0
        assert "gemini: rejected" in result.stdout
        assert "1 rejected" in result.stdout


class TestInsufficientCredit:
    def test_exits_nonzero(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        _write_connector(mirror, "gemini", OK_GEMINI)
        _write_connector(mirror, "openai", """
from connectors import ConnectorError
def check_key():
    raise ConnectorError("out of credit", reason="insufficient_credit")
""")

        result = _run(mirror, {"GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key"})

        assert result.returncode != 0
        assert "openai: insufficient credit" in result.stdout
        assert "1 insufficient credit" in result.stdout


class TestUnreachableDoesNotBlock:
    def test_unreachable_alone_exits_zero(self, tmp_path):
        """A flaky network shouldn't block a release — only rejected /
        insufficient_credit / a retired default model do."""
        mirror = _mirror_repo(tmp_path)
        _write_connector(mirror, "gemini", OK_GEMINI)
        _write_connector(mirror, "openai", """
from connectors import ConnectorError
def check_key():
    raise ConnectorError("could not reach the API: timed out", reason="unreachable")
""")

        result = _run(mirror, {"GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key"})

        assert result.returncode == 0, result.stderr
        assert "openai: unreachable" in result.stdout
        assert "1 unreachable" in result.stdout


class TestNeverPrintsKeyValue:
    def test_key_value_never_appears_in_output(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        _write_connector(mirror, "gemini", OK_GEMINI)
        _write_connector(mirror, "openai", OK_OPENAI)
        secret = "sk-should-never-appear-in-any-output-abc123"

        result = _run(mirror, {"GEMINI_API_KEY": secret, "OPENAI_API_KEY": secret})

        assert result.returncode == 0, result.stderr
        assert secret not in result.stdout
        assert secret not in result.stderr


class TestReadsSupportedListAtRuntime:
    def test_a_newly_supported_provider_is_checked_for_real(self, tmp_path):
        """Proves the runtime-introspection requirement: check-keys.sh must
        not carry its own copy of which providers check_key supports. Patch
        ONLY the mirror's copy of check_key.py to add a provider, add no
        matching branch to check-keys.sh, and confirm it starts checking
        that provider for real instead of printing 'no check yet'."""
        mirror = _mirror_repo(tmp_path)
        _add_provider_support(mirror, "fal", "connectors.fal")
        _write_connector(mirror, "gemini", OK_GEMINI)
        _write_connector(mirror, "openai", OK_OPENAI)
        _write_connector(mirror, "fal", """
def check_key():
    return {"ok": True, "default_model": "fake-fal-model",
            "default_model_ok": True, "detail": "ok"}
""")

        result = _run(mirror, {
            "GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key", "FAL_API_KEY": "test-key",
        })

        assert result.returncode == 0, result.stderr
        assert "fal: ok" in result.stdout
        assert "fal: no check yet" not in result.stdout
        no_check_lines = [l for l in result.stdout.splitlines() if l.startswith("not yet supported")]
        if no_check_lines:
            assert "fal" not in no_check_lines[0]


class TestScriptExists:
    def test_script_is_executable(self):
        assert SCRIPT.is_file()
        assert os.access(SCRIPT, os.X_OK)
