"""Every skill is read by an agent that may be working in the Montaj app, which
has no CLI and cannot open montaj's repo files. So a skill line never names a
path on a developer's machine, never points at a doc in the repo instead of
saying what it needs, and names a CLI install command only for the command
line."""
import re
from pathlib import Path

SKILLS = Path(__file__).resolve().parent.parent / "skills"

HOME_PATH = re.compile(r"/Users/|/home/|[A-Za-z]:\\\\Users\\\\")
DOC_POINTER = re.compile(r"\bdocs/[\w./-]+")
CLI_INSTALL = re.compile(r"montaj install|setup/install\.sh|\bpip3? install\b|\bbrew install\b")


def _lines():
    files = sorted(SKILLS.rglob("*.md"))
    assert files, f"no skills under {SKILLS}"
    for f in files:
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            yield f"{f.relative_to(SKILLS.parent)}:{n}", line


def test_no_skill_names_a_path_on_a_developers_machine():
    assert [where for where, line in _lines() if HOME_PATH.search(line)] == []


def test_no_skill_sends_the_agent_to_a_repo_doc():
    assert [where for where, line in _lines() if DOC_POINTER.search(line)] == []


def test_a_cli_install_command_appears_only_for_the_command_line():
    assert [where for where, line in _lines() if CLI_INSTALL.search(line) and "command line" not in line] == []
