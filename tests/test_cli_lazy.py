"""CLI must import only the invoked command's module (startup latency)."""
import subprocess
import sys
from importlib.metadata import version as _pkg_version


def pkg_version(name):
    """Mirror cli.main's fallback: a dev checkout that isn't pip-installed has
    no dist-info, and the CLI prints "dev" there — the test must expect the
    same instead of crashing on PackageNotFoundError."""
    try:
        return _pkg_version(name)
    except Exception:
        return "dev"

from tests.conftest import REPO_ROOT


def _run(*args):
    return subprocess.run([sys.executable, "-X", "importtime", "-m", "cli.main", *args],
                          capture_output=True, text=True, cwd=REPO_ROOT)


def test_single_command_does_not_import_siblings():
    # render is a still-hand-written command (probe is now schema-generated).
    r = _run("render", "--help")
    assert r.returncode == 0
    assert "cli.commands.render" in r.stderr
    assert "cli.commands.upload" not in r.stderr
    # the deleted per-command modules must not be imported (or exist).
    assert "cli.commands.probe" not in r.stderr


def test_migrated_command_uses_generator_and_imports_no_siblings():
    # A migrated single-step command is built from its schema via
    # cli.step_command; invoking it must not import any sibling command module.
    r = _run("probe", "--help")
    assert r.returncode == 0
    assert "cli.step_command" in r.stderr          # went through the generator
    assert "cli.commands.render" not in r.stderr
    assert "cli.commands.transcribe" not in r.stderr


def test_global_help_lists_all_commands():
    r = _run("--help")
    assert r.returncode == 0
    for cmd in ("render", "serve", "workflow", "status"):
        assert cmd in r.stdout


def test_unknown_command_errors_with_choices():
    r = _run("definitely-not-a-command")
    assert r.returncode != 0
    assert "invalid choice" in r.stderr or "invalid choice" in r.stdout


def test_version_flag_fast_path():
    expected = f"montaj {pkg_version('montaj')}"

    r = _run("--version")
    assert r.returncode == 0
    assert r.stdout.strip() == expected
    assert "cli.commands.render" not in r.stderr

    r2 = _run("-v")
    assert r2.returncode == 0
    assert r2.stdout.strip() == expected
    assert "cli.commands.render" not in r2.stderr
