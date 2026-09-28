"""Tests for scripts/check-keys.sh — PV29 T8a, extended for the 2026-09-28
"never block on what this machine can't verify" rule.

check-keys.sh is the pre-release guard against FQ1 #22 (a retired connector
default model reaching users unnoticed). It shells out to the real
steps/credentials/check_key.py for every provider in lib/credentials.py's
KNOWN_PROVIDERS, and must never make a real vendor call and never run
against this machine's real ~/.montaj/credentials.json.

Operator decision, 2026-09-28: a release must never be blocked because a
provider can't be verified on this machine — no key, a rejected key, a key
with no credit, a deliberately skipped provider, and a default model that
can't be verified by a free call are all warnings, not failures. Only a
confirmed retired default model or an unclassified error still blocks. The
guard must still name every gap: a SUMMARY line with counts, and a
NOT VERIFIED line listing every provider that wasn't fully verified with why
(or "NOT VERIFIED: none").

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

lib/credentials.py's real KNOWN_PROVIDERS (copied verbatim into the mirror)
is {kling, gemini, openai, serpapi, fal, elevenlabs} — six providers. As of
PV29 T7 the real check_key.py (also copied verbatim) supports five of those —
gemini, openai, kling, fal and elevenlabs — leaving only serpapi (a search
API, not a generation vendor) as "no check yet", which several assertions
below account for explicitly.
"""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
SCRIPT = REPO_ROOT / "scripts" / "check-keys.sh"

# check-keys.sh is maintainer-only release tooling and, like the other release
# scripts, is kept out of git (a4d06b6: scripts/ is gitignored). On a fresh clone
# or in CI the script does not exist, so these tests skip rather than fail; they
# run wherever the maintainer's copy is present.
pytestmark = pytest.mark.skipif(
    not SCRIPT.exists(),
    reason="scripts/check-keys.sh is local release tooling, not tracked in git",
)

ALL_KNOWN_PROVIDERS = ("kling", "gemini", "openai", "serpapi", "fal", "elevenlabs")
UNSUPPORTED_BY_DEFAULT = ("serpapi",)


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


# Matches the whole `PROVIDERS = { ... }` dict literal regardless of how it's
# laid out on disk (one line or several) — robust to check_key.py's PROVIDERS
# growing from a single-line dict (T3) to a multi-line one (T7). Values are
# plain strings with no braces of their own, so a non-greedy match up to the
# FIRST "}" always lands on the real closing brace.
_PROVIDERS_RE = re.compile(r"PROVIDERS = \{.*?\}", re.DOTALL)


def _patch_providers(mirror: Path, extra: str) -> None:
    path = mirror / "steps" / "credentials" / "check_key.py"
    text = path.read_text()
    m = _PROVIDERS_RE.search(text)
    assert m, "check_key.py's PROVIDERS dict not found — update this test"
    block = m.group(0)
    new_block = block[:-1].rstrip().rstrip(",") + extra + "}"
    path.write_text(text[:m.start()] + new_block + text[m.end():])


def _add_provider_support(mirror: Path, provider: str, module: str) -> None:
    """Patch the MIRROR's copy of check_key.py to support one more provider
    — proves check-keys.sh reads the supported list at runtime rather than
    carrying its own hardcoded copy. Never touches the real repo file."""
    _patch_providers(mirror, f', "{provider}": "{module}"')


def _add_all_provider_support(mirror: Path, providers: tuple[str, ...]) -> None:
    """Like _add_provider_support but for several providers in one patch."""
    _patch_providers(mirror, "".join(f', "{p}": "connectors.{p}"' for p in providers))


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


def _not_verified_line(stdout: str) -> str:
    lines = [l for l in stdout.splitlines() if l.startswith("NOT VERIFIED:")]
    assert lines, stdout
    return lines[0]


def _summary_line(stdout: str) -> str:
    lines = [l for l in stdout.splitlines() if l.startswith("SUMMARY:")]
    assert lines, stdout
    return lines[0]


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
    def test_exits_zero_and_names_the_gap(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        # No connectors/gemini.py or connectors/openai.py needed at all —
        # has_key() short-circuits before check_key.py is ever invoked.
        result = _run(mirror)

        assert result.returncode == 0, result.stderr
        assert "gemini: no key" in result.stdout
        assert "openai: no key" in result.stdout
        not_verified = _not_verified_line(result.stdout)
        assert "gemini (no key)" in not_verified
        assert "openai (no key)" in not_verified


class TestUnsupportedProvidersToday:
    def test_serpapi_is_no_check_yet(self, tmp_path):
        """serpapi is a search API, not a generation vendor, and has no
        check_key() (T7 added kling/fal/elevenlabs but not serpapi). Every
        KNOWN_PROVIDERS entry check_key doesn't support must warn, not fail."""
        mirror = _mirror_repo(tmp_path)
        result = _run(mirror)

        assert result.returncode == 0, result.stderr
        for provider in UNSUPPORTED_BY_DEFAULT:
            assert f"{provider}: no check yet" in result.stdout
        not_verified = _not_verified_line(result.stdout)
        for provider in UNSUPPORTED_BY_DEFAULT:
            assert f"{provider} (no check yet)" in not_verified


class TestAllOk:
    def test_exits_zero(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        _write_connector(mirror, "gemini", OK_GEMINI)
        _write_connector(mirror, "openai", OK_OPENAI)

        result = _run(mirror, {"GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key"})

        assert result.returncode == 0, result.stderr
        assert "gemini: ok" in result.stdout
        assert "openai: ok" in result.stdout
        assert f"SUMMARY: 2 of {len(ALL_KNOWN_PROVIDERS)} providers verified" in result.stdout
        # gemini/openai are fully verified — not in the gap line. The other
        # four are still unsupported and still named.
        not_verified = _not_verified_line(result.stdout)
        assert "gemini" not in not_verified
        assert "openai" not in not_verified
        for provider in UNSUPPORTED_BY_DEFAULT:
            assert f"{provider} (no check yet)" in not_verified


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
        assert "1 retired" in _summary_line(result.stdout)
        assert "openai (default model retired)" in _not_verified_line(result.stdout)


class TestUnclassifiedErrorStillBlocks:
    def test_unknown_error_code_exits_nonzero(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        _write_connector(mirror, "gemini", OK_GEMINI)
        _write_connector(mirror, "openai", """
from connectors import ConnectorError
def check_key():
    raise ConnectorError("something weird happened", reason="mystery_error")
""")

        result = _run(mirror, {"GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key"})

        assert result.returncode != 0
        assert "openai: error: check_failed" in result.stdout
        assert "1 error" in _summary_line(result.stdout)
        assert "openai (error: check_failed)" in _not_verified_line(result.stdout)


class TestRejectedKeyIsAWarningNotABlock:
    def test_exits_zero_and_is_named_unverifiable(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        _write_connector(mirror, "gemini", """
from connectors import ConnectorError
def check_key():
    raise ConnectorError("Gemini rejected the API key: bad key", reason="invalid_api_key")
""")
        _write_connector(mirror, "openai", OK_OPENAI)

        result = _run(mirror, {"GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key"})

        assert result.returncode == 0, result.stderr
        assert "gemini: unverifiable (key rejected)" in result.stdout
        assert "1 unverifiable" in _summary_line(result.stdout)
        assert "gemini (key rejected)" in _not_verified_line(result.stdout)


class TestInsufficientCreditIsAWarningNotABlock:
    def test_exits_zero_and_is_named_unverifiable(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        _write_connector(mirror, "gemini", OK_GEMINI)
        _write_connector(mirror, "openai", """
from connectors import ConnectorError
def check_key():
    raise ConnectorError("out of credit", reason="insufficient_credit")
""")

        result = _run(mirror, {"GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key"})

        assert result.returncode == 0, result.stderr
        assert "openai: unverifiable (no credit)" in result.stdout
        assert "1 unverifiable" in _summary_line(result.stdout)
        assert "openai (no credit)" in _not_verified_line(result.stdout)


class TestUnreachableDoesNotBlock:
    def test_unreachable_alone_exits_zero(self, tmp_path):
        """A flaky network shouldn't block a release — only a retired default
        model or an unclassified error do."""
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
        assert "1 unreachable" in _summary_line(result.stdout)
        assert "openai (unreachable)" in _not_verified_line(result.stdout)


class TestDefaultModelNotVerifiable:
    def test_ok_but_unverified_model_does_not_block(self, tmp_path):
        """Kling's case: the key is good but there is no free call that
        confirms the default model specifically."""
        mirror = _mirror_repo(tmp_path)
        _write_connector(mirror, "gemini", OK_GEMINI)
        _write_connector(mirror, "openai", """
def check_key():
    return {"ok": True, "default_model": "kling-v2", "default_model_ok": True,
            "default_model_verified": False, "detail": "no free verification call"}
""")

        result = _run(mirror, {"GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key"})

        assert result.returncode == 0, result.stderr
        assert "openai: ok, default model not verifiable (kling-v2)" in result.stdout
        assert "1 model not verifiable" in _summary_line(result.stdout)
        assert "openai (default model not verifiable)" in _not_verified_line(result.stdout)
        # not fully verified, so not counted in the "N of M" verified count
        assert "SUMMARY: 1 of" in _summary_line(result.stdout)


class TestSkipList:
    def test_skipped_providers_are_not_checked(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        _write_connector(mirror, "gemini", OK_GEMINI)
        # Deliberately no connectors/openai.py — if the skip didn't take,
        # check_key.py would import it and crash.

        result = _run(mirror, {
            "GEMINI_API_KEY": "test-key",
            "CHECK_KEYS_SKIP": "openai,kling",
        })

        assert result.returncode == 0, result.stderr
        assert "gemini: ok" in result.stdout
        assert "openai: skipped (CHECK_KEYS_SKIP)" in result.stdout
        assert "kling: skipped (CHECK_KEYS_SKIP)" in result.stdout
        not_verified = _not_verified_line(result.stdout)
        assert "openai (skipped)" in not_verified
        assert "kling (skipped)" in not_verified
        assert "2 skipped" in _summary_line(result.stdout)


class TestAllVerifiedNoGaps:
    def test_not_verified_is_none_when_everything_checks_out(self, tmp_path):
        mirror = _mirror_repo(tmp_path)
        # kling/fal/elevenlabs are real support in the copied check_key.py
        # (T7) — only serpapi still needs the runtime patch.
        extra_providers = ("kling", "serpapi", "fal", "elevenlabs")
        _add_all_provider_support(mirror, ("serpapi",))

        env = {"GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key"}
        for provider in ("gemini", "openai") + extra_providers:
            _write_connector(mirror, provider, f"""
def check_key():
    return {{"ok": True, "default_model": "fake-{provider}-model",
            "default_model_ok": True, "default_model_verified": True, "detail": "ok"}}
""")
        env.update({
            "KLING_ACCESS_KEY": "test-key", "KLING_SECRET_KEY": "test-key",
            "SERPAPI_API_KEY": "test-key", "FAL_API_KEY": "test-key",
            "ELEVENLABS_API_KEY": "test-key",
        })

        result = _run(mirror, env)

        assert result.returncode == 0, result.stderr
        assert f"SUMMARY: {len(ALL_KNOWN_PROVIDERS)} of {len(ALL_KNOWN_PROVIDERS)} providers verified" in result.stdout
        assert "NOT VERIFIED: none" in result.stdout


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
        that provider for real instead of printing 'no check yet'. Uses
        serpapi — the one KNOWN_PROVIDERS entry check_key.py genuinely
        doesn't support after T7 — so the "newly supported" premise is real."""
        mirror = _mirror_repo(tmp_path)
        _add_provider_support(mirror, "serpapi", "connectors.serpapi")
        _write_connector(mirror, "gemini", OK_GEMINI)
        _write_connector(mirror, "openai", OK_OPENAI)
        _write_connector(mirror, "serpapi", """
def check_key():
    return {"ok": True, "default_model": "fake-serpapi-model",
            "default_model_ok": True, "detail": "ok"}
""")

        result = _run(mirror, {
            "GEMINI_API_KEY": "test-key", "OPENAI_API_KEY": "test-key", "SERPAPI_API_KEY": "test-key",
        })

        assert result.returncode == 0, result.stderr
        assert "serpapi: ok" in result.stdout
        assert "serpapi: no check yet" not in result.stdout
        # serpapi is now fully verified, so it must not appear in the gap line.
        assert "serpapi" not in _not_verified_line(result.stdout)


class TestScriptExists:
    def test_script_is_executable(self):
        assert SCRIPT.is_file()
        assert os.access(SCRIPT, os.X_OK)
