"""MCP tool surface: `render` only, and no step under another name.

`cli/mcp_schema.py` exports a fixed allowlist of CLI commands as MCP tools
(``_EXPORTED_COMMANDS``). Since PL11 (Sam, 2026-09-30) no step command is on
it: a step runs through the CLI or serve's ``POST /api/steps/<name>``, and the
Montaj app's connector adds its own ``run_step`` tool over that route. Project
setup, status, normalize, upload, log and profile are CLI-only too. This
test freezes that choice. A new MCP tool FAILS it until someone adds the name
to ``EXPECTED_MCP_TOOLS`` on purpose, and a tool that is only a step under
another name fails it outright.
"""
import json
import subprocess
import sys

from serve.common import MONTAJ_ROOT
from serve.routes.steps import scan_steps
from cli.main import _STEP_COMMANDS
from cli.mcp_schema import _EXPORTED_COMMANDS
from tests.conftest import REPO_ROOT


def _all_steps() -> set[str]:
    """Every builtin step name scan_steps() discovers.

    scan_steps() also scans ~/.montaj/steps (user-installed steps), so filter
    to py_path's under MONTAJ_ROOT/steps to stay machine-independent.
    """
    builtin_root = (MONTAJ_ROOT / "steps").resolve()
    return {
        name
        for name, (_schema, py_path) in scan_steps().items()
        if builtin_root in py_path.resolve().parents
    }


def _mcp_tool_names() -> set[str]:
    """MCP tool names, via subprocess exactly as mcp/server.js invokes them."""
    r = subprocess.run(
        [sys.executable, str(REPO_ROOT / "cli" / "mcp_schema.py")],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert r.returncode == 0, f"cli/mcp_schema.py failed:\n{r.stderr}"
    return {t["name"] for t in json.loads(r.stdout)}


# Command name (underscored) -> the step it runs, per cli/main.py's own table.
# Identity except the one rename: the `filler` command runs `rm_fillers`.
_REMAP = {
    cmd.replace("-", "_"): quirks.get("step_name", cmd.replace("-", "_"))
    for cmd, quirks in _STEP_COMMANDS.items()
}

# The whole MCP surface.
EXPECTED_MCP_TOOLS = frozenset({"render"})

_OPTIONS_MSG = (
    "\nThe MCP surface is a conscious choice (see cli/mcp_schema.py's allowlist "
    "comment). A step is never exported as its own tool: it runs through the CLI "
    "or POST /api/steps/<name>. If this is a real project-level tool, add it to "
    "EXPECTED_MCP_TOOLS in tests/test_mcp_surface.py."
)


def test_mcp_surface_is_exactly_the_frozen_set():
    names = _mcp_tool_names()
    assert names == EXPECTED_MCP_TOOLS, (
        f"MCP tools changed.\n  new: {sorted(names - EXPECTED_MCP_TOOLS)}\n"
        f"  gone: {sorted(EXPECTED_MCP_TOOLS - names)}" + _OPTIONS_MSG
    )


def test_no_mcp_tool_is_a_step_under_another_name():
    steps = _all_steps()
    duplicates = {
        name for name in _mcp_tool_names() if _REMAP.get(name, name) in steps
    }
    assert not duplicates, (
        f"MCP tool(s) {sorted(duplicates)} are a step under another name." + _OPTIONS_MSG
    )


def test_no_step_command_is_on_the_mcp_allowlist():
    on_allowlist = set(_STEP_COMMANDS) & set(_EXPORTED_COMMANDS)
    assert not on_allowlist, (
        f"step command(s) {sorted(on_allowlist)} are in _EXPORTED_COMMANDS." + _OPTIONS_MSG
    )


def test_filler_command_still_runs_rm_fillers():
    # The Montaj app redirects a call to the retired `filler` tool to the
    # `rm_fillers` step, so this rename must hold.
    assert _REMAP.get("filler") == "rm_fillers"
    assert "rm_fillers" in _all_steps()


def test_no_workflow_subcommand_is_exported():
    """Since PL11 no `workflow` subcommand is an MCP tool: `workflow run`
    creates a project, which is CLI-only, and `workflow edit` launches
    $EDITOR, which hangs from an AI client."""
    names = _mcp_tool_names()
    assert not {n for n in names if n.startswith("workflow_")}
