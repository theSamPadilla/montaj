"""Golden capture of CLI --help output and MCP schema introspection.

Pins the CURRENT (pre-migration) behavior of the 16 commands the
consolidation plan is about to touch, so later tasks can diff their output
against a known-good baseline. A failure here means behavior changed —
that's either the point of a later task (regenerate deliberately) or a bug
(fix the code, not the golden).

Regenerate after a deliberate, reviewed change:
    python -m tests.test_cli_help_goldens --update-goldens
"""
import re
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


# The leading `usage: ...` block, up to the first blank line.
_USAGE_BLOCK = re.compile(r"\Ausage:.*?(?=\n\n|\Z)", re.DOTALL)


def _normalize_usage(text: str) -> str:
    """Collapse whitespace inside the leading `usage:` block only.

    argparse's usage-line wrapping is Python-version dependent: 3.13+ breaks
    lines by option+metavar pairs where 3.11 packed them tighter, so the same
    CLI surface renders differently under different interpreters (CI runs
    3.11; local venvs are on 3.13). Only `lyrics-render` is long enough to
    cross the boundary today, but any command could.

    Collapsing runs of whitespace to single spaces *inside the usage block*
    makes the comparison wrap-insensitive while every other line — option
    names, help text, indentation, blank-line structure — stays byte-exact,
    so the golden keeps its value as a tripwire on real CLI changes. Applied
    to both sides, so it holds whichever interpreter captured the golden.
    """
    return _USAGE_BLOCK.sub(
        lambda m: re.sub(r"\s+", " ", m.group(0)).strip(), text, count=1
    )


def _help_path(cmd: str):
    return GOLDENS_DIR / f"{cmd}.help.txt"


@pytest.mark.parametrize("cmd", COMMANDS)
def test_help_golden(cmd):
    assert _normalize_usage(_capture_help(cmd)) == _normalize_usage(
        _help_path(cmd).read_text()
    )


def test_no_command_here_is_exported_to_mcp():
    # Every command in COMMANDS is a step command, and no step is an MCP tool
    # (PL11): the per-command MCP schema goldens are gone with the export.
    from cli.mcp_schema import export
    exported = {t["name"] for t in export()}
    assert not {c.replace("-", "_") for c in COMMANDS} & exported


def _update_goldens():
    GOLDENS_DIR.mkdir(parents=True, exist_ok=True)
    for cmd in COMMANDS:
        _help_path(cmd).write_text(_capture_help(cmd))
    print(f"Wrote {len(COMMANDS)} golden files to {GOLDENS_DIR}")


if __name__ == "__main__":
    if "--update-goldens" in sys.argv:
        _update_goldens()
    else:
        sys.exit("Run with --update-goldens to (re)capture goldens; "
                  "otherwise run this file under pytest.")
