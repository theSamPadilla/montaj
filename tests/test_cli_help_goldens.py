"""Golden capture of CLI --help output and MCP schema introspection.

Pins the CURRENT (pre-migration) behavior of the 16 commands the
consolidation plan is about to touch, so later tasks can diff their output
against a known-good baseline. A failure here means behavior changed —
that's either the point of a later task (regenerate deliberately) or a bug
(fix the code, not the golden).

Regenerate after a deliberate, reviewed change:
    python -m tests.test_cli_help_goldens --update-goldens
"""
import json
import subprocess
import sys

import pytest

from tests.conftest import REPO_ROOT

GOLDENS_DIR = REPO_ROOT / "tests" / "goldens" / "cli_help"

# Exact hyphenation as it appears in cli.main._COMMANDS.
COMMANDS = (
    "probe", "transcribe", "caption", "extract-audio", "resize",
    "rm-nonspeech", "stem-separation", "lyrics-sync", "lyrics-render",
    "generate-image", "generate-music", "generate-voiceover",
    "kling-generate", "analyze-media", "snapshot", "filler",
)

# cli.mcp_schema.export() doesn't wire these five commands up yet (see its
# module-level import list) — that absence is itself part of the pinned,
# current behavior, not an omission in this test.
NOT_EXPORTED = "NOT_EXPORTED\n"


def _capture_help(cmd: str) -> str:
    """stdout of `python -m cli.main <cmd> --help`.

    Run via subprocess with capture_output=True so stdout is a pipe, not a
    TTY — ColorHelpFormatter (cli/help.py) checks sys.stdout.isatty() and
    stays plain, matching how the golden files are read back.
    """
    r = subprocess.run(
        [sys.executable, "-m", "cli.main", cmd, "--help"],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert r.returncode == 0, f"{cmd} --help failed: {r.stderr}"
    assert "\x1b" not in r.stdout, f"{cmd} --help emitted ANSI color in a non-TTY pipe"
    return r.stdout


def _capture_mcp(cmd: str) -> str:
    """Pretty-printed JSON of the command's tool entry from
    cli.mcp_schema.export(), or NOT_EXPORTED if export() doesn't currently
    expose it."""
    from cli.mcp_schema import export
    name = cmd.replace("-", "_")
    tool = next((t for t in export() if t["name"] == name), None)
    if tool is None:
        return NOT_EXPORTED
    return json.dumps(tool, indent=2) + "\n"


def _help_path(cmd: str):
    return GOLDENS_DIR / f"{cmd}.help.txt"


def _mcp_path(cmd: str):
    return GOLDENS_DIR / f"{cmd}.mcp.txt"


@pytest.mark.parametrize("cmd", COMMANDS)
def test_help_golden(cmd):
    assert _capture_help(cmd) == _help_path(cmd).read_text()


@pytest.mark.parametrize("cmd", COMMANDS)
def test_mcp_schema_golden(cmd):
    assert _capture_mcp(cmd) == _mcp_path(cmd).read_text()


def _update_goldens():
    GOLDENS_DIR.mkdir(parents=True, exist_ok=True)
    for cmd in COMMANDS:
        _help_path(cmd).write_text(_capture_help(cmd))
        _mcp_path(cmd).write_text(_capture_mcp(cmd))
    print(f"Wrote {2 * len(COMMANDS)} golden files to {GOLDENS_DIR}")


if __name__ == "__main__":
    if "--update-goldens" in sys.argv:
        _update_goldens()
    else:
        sys.exit("Run with --update-goldens to (re)capture goldens; "
                  "otherwise run this file under pytest.")
