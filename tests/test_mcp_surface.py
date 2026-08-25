"""MCP tool surface ↔ step registry parity.

`cli/mcp_schema.py` exports a fixed allowlist of CLI commands as MCP tools
(``_EXPORTED_COMMANDS``); the step registry (``serve/routes/steps.py``'s
``scan_steps()``) independently discovers every step under ``steps/``. The two
sets are NOT meant to be equal — ``mcp_schema.py``'s own comment calls the
step-command omissions "a conscious surface choice, NOT registry drift" — so
this test does not assert equality. Instead it freezes the *intent*: exactly
which steps are HTTP-only, exactly which MCP tools name no step, and that the
`cli/main.py` remap table (e.g. the CLI's ``filler`` command → the
``rm_fillers`` step) still resolves correctly. Any new step or MCP tool that
isn't already accounted for FAILS this test until someone makes the
conscious choice to add it to the MCP allowlist or to the frozen exception
list below — that forcing function is the test's job, not forbidding growth.

Failure messages spell out both options so the developer isn't left guessing
what to do next.
"""
import json
import subprocess
import sys

from serve.common import MONTAJ_ROOT
from serve.routes.steps import scan_steps
from cli.main import _STEP_COMMANDS
from tests.conftest import REPO_ROOT
from tests.test_step_schema_conformance import MIGRATED_STEPS, _locate

# ── ground truth loaders ─────────────────────────────────────────────────────

def _all_steps() -> set[str]:
    """Every step name scan_steps() discovers, filtered to builtin steps only.

    scan_steps() ALSO scans ~/.montaj/steps (user-installed custom steps) and
    takes no scope parameter to opt out. On a machine with user steps
    installed, the raw scan_steps() result would silently drift from the
    frozen sets below. Filtering to py_path's under MONTAJ_ROOT/steps is what
    keeps this test's expectations machine-independent.
    """
    builtin_root = (MONTAJ_ROOT / "steps").resolve()
    return {
        name
        for name, (_schema, py_path) in scan_steps().items()
        if builtin_root in py_path.resolve().parents
    }


def _mcp_tools() -> list[dict]:
    """MCP tool definitions, via subprocess exactly as mcp/server.js invokes them.

    The plan specifies "subprocess python3 cli/mcp_schema.py -> tool list".
    cli/mcp_schema.py does have a __main__ block that prints json.dumps(export()),
    so the subprocess call the plan describes is exactly what's exercised here
    (rather than diverging to an in-process import).
    """
    r = subprocess.run(
        [sys.executable, str(REPO_ROOT / "cli" / "mcp_schema.py")],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert r.returncode == 0, f"cli/mcp_schema.py failed:\n{r.stderr}"
    return json.loads(r.stdout)


# Command name (underscored) -> step name it actually runs, per cli/main.py's
# own quirks table. Identity for every command except the one deliberate
# rename: the CLI's "filler" command runs the "rm_fillers" step.
_REMAP = {
    cmd.replace("-", "_"): quirks.get("step_name", cmd.replace("-", "_"))
    for cmd, quirks in _STEP_COMMANDS.items()
}

# ── frozen expected sets ─────────────────────────────────────────────────────

# Steps with no MCP tool. Quoting cli/mcp_schema.py's own allowlist comment:
#
#   # Explicit allowlist of top-level commands exported as MCP tools. A conscious
#   # surface choice, NOT registry drift: this is exactly the set the previous
#   # hardcoded import list registered. Notably it OMITS the 5 step commands
#   # (stem-separation, lyrics-sync, lyrics-render, generate-music,
#   # generate-voiceover) — expanding MCP's surface is a separate decision. Commands
#   # with subcommands (workflow, sample, profile) flatten into multiple tools.
#
# The 5 named above account for 5 of these 20; the rest (crop_spec, cross_cut,
# fetch_image, filmstrip, generate_captions, jump_cut, mix_timeline, montage,
# normalize_window, proxy, search_images, search_news, virtual_to_original,
# waveform_image, waveform_peaks) were never CLI commands at all — they're
# HTTP/editor-only steps with no corresponding top-level command to allowlist.
# `mix_timeline` is an internal leg of the caption pipeline (the caption route
# and `generate_captions` both spawn it directly by path), so it stays off the
# MCP surface for the same reason.
EXPECTED_HTTP_ONLY = frozenset({
    "crop_spec", "cross_cut", "fetch_image", "filmstrip", "generate_captions",
    "generate_music", "generate_voiceover", "jump_cut", "lyrics_render",
    "lyrics_sync", "mix_timeline", "montage", "normalize_window", "proxy",
    "search_images", "search_news", "stem_separation", "virtual_to_original",
    "waveform_image", "waveform_peaks",
})

# MCP tools that name no step at all — run/render/status/upload/init are
# general-purpose or admin commands, and workflow_*/profile_* are subcommands
# of orchestration/asset-management commands, not single-step wrappers.
EXPECTED_MCP_ONLY = frozenset({
    "init", "profile_analyze", "profile_asset_add", "profile_asset_list",
    "profile_asset_rm", "profile_asset_summary", "profile_list", "render",
    "run", "status", "upload", "workflow_edit", "workflow_list",
    "workflow_new", "workflow_run",
})

_OPTIONS_MSG = (
    "\nThis test pins the MCP surface as a CONSCIOUS choice, not registry "
    "drift (see cli/mcp_schema.py's allowlist comment). You have two options:\n"
    "  1. Add it to cli/mcp_schema.py's _EXPORTED_COMMANDS allowlist "
    "(expands the MCP surface), or\n"
    "  2. Add it to the frozen EXPECTED_HTTP_ONLY / EXPECTED_MCP_ONLY set in "
    "tests/test_mcp_surface.py (keeps it HTTP/editor-only).\n"
    "Either way, update the corresponding frozen set here once the choice is made."
)


def _classify(steps: set[str], mcp_tools: list[dict]):
    """Split mcp tool names into ones that name a real step vs. ones that don't.

    Returns (step_tools, mcp_step_tools, tools_by_name, resolved_to_tool):
      - step_tools: MCP tool names (tool-name space) that resolve to a real step
      - mcp_step_tools: the same, resolved into step-name space
      - tools_by_name: {tool name: tool dict}
      - resolved_to_tool: {step name: tool name that exposes it}
    """
    tools_by_name = {t["name"]: t for t in mcp_tools}
    step_tools: set[str] = set()
    mcp_step_tools: set[str] = set()
    resolved_to_tool: dict[str, str] = {}
    for name in tools_by_name:
        resolved = _REMAP.get(name, name)
        if resolved in steps:
            step_tools.add(name)
            mcp_step_tools.add(resolved)
            resolved_to_tool[resolved] = name
    return step_tools, mcp_step_tools, tools_by_name, resolved_to_tool


# ── (a) remap resolves every step-naming MCP tool to a real step ────────────

def test_remap_resolves_every_step_tool_to_a_real_step():
    steps = _all_steps()
    mcp_tools = _mcp_tools()
    step_tools, mcp_step_tools, _tools_by_name, _resolved_to_tool = _classify(steps, mcp_tools)

    # The pinned case: the CLI's "filler" command is the one deliberate
    # rename in the remap table, and it must keep resolving to "rm_fillers".
    assert _REMAP.get("filler") == "rm_fillers", (
        "cli/main.py's _STEP_COMMANDS['filler'] no longer remaps to "
        "'rm_fillers' — the MCP 'filler' tool would stop resolving to a real "
        "step." + _OPTIONS_MSG
    )

    # General case: every MCP tool identified as naming a step must resolve
    # (via the remap, or identity when absent from it) to a name scan_steps()
    # actually returns.
    unresolved = [
        name for name in step_tools
        if _REMAP.get(name, name) not in steps
    ]
    assert not unresolved, (
        f"MCP tool(s) {unresolved} claim to name a step but resolve to a "
        f"name scan_steps() doesn't return." + _OPTIONS_MSG
    )


# ── (b) steps with no MCP tool == frozen allowlist ───────────────────────────

def test_http_only_steps_match_frozen_set():
    steps = _all_steps()
    mcp_tools = _mcp_tools()
    _step_tools, mcp_step_tools, _tools_by_name, _resolved_to_tool = _classify(steps, mcp_tools)

    http_only = steps - mcp_step_tools
    assert http_only == EXPECTED_HTTP_ONLY, (
        f"steps with no MCP tool changed.\n"
        f"  newly HTTP-only (not in frozen set): {sorted(http_only - EXPECTED_HTTP_ONLY)}\n"
        f"  no longer HTTP-only (now MCP-exposed, stale in frozen set): "
        f"{sorted(EXPECTED_HTTP_ONLY - http_only)}\n"
        + _OPTIONS_MSG
    )


# ── (c) MCP tools naming no step == frozen allowlist ─────────────────────────

def test_mcp_only_tools_match_frozen_set():
    steps = _all_steps()
    mcp_tools = _mcp_tools()
    step_tools, _mcp_step_tools, _tools_by_name, _resolved_to_tool = _classify(steps, mcp_tools)

    mcp_tool_names = {t["name"] for t in mcp_tools}
    mcp_only = mcp_tool_names - step_tools
    assert mcp_only == EXPECTED_MCP_ONLY, (
        f"MCP tools naming no step changed.\n"
        f"  newly step-less (not in frozen set): {sorted(mcp_only - EXPECTED_MCP_ONLY)}\n"
        f"  no longer step-less (now names a step, stale in frozen set): "
        f"{sorted(EXPECTED_MCP_ONLY - mcp_only)}\n"
        + _OPTIONS_MSG
    )


# ── (d) param parity for the MCP-exposed ∩ schema-conformance-reconciled set ─

def test_exposed_migrated_steps_cover_required_schema_params():
    """For every step that's both MCP-exposed AND in
    test_step_schema_conformance.py's MIGRATED_STEPS (the reconciled
    schema<->argparse set), the MCP tool's argparse-derived inputSchema
    properties must cover the step schema's required params — an MCP caller
    given only the tool's inputSchema must be able to see every parameter the
    step actually requires.
    """
    steps = _all_steps()
    mcp_tools = _mcp_tools()
    _step_tools, mcp_step_tools, tools_by_name, resolved_to_tool = _classify(steps, mcp_tools)

    reconciled_and_exposed = mcp_step_tools & set(MIGRATED_STEPS)
    assert reconciled_and_exposed, "sanity check: expected a non-empty intersection"

    failures = []
    for step_name in sorted(reconciled_and_exposed):
        schema_path, _script_path = _locate(step_name)
        schema = json.loads(schema_path.read_text())
        required = {
            p["name"].replace("-", "_")
            for p in schema.get("params", [])
            if p.get("required")
        }
        tool = tools_by_name[resolved_to_tool[step_name]]
        properties = set(tool["inputSchema"].get("properties", {}).keys())
        missing = required - properties
        if missing:
            failures.append(
                f"{step_name} (tool '{tool['name']}'): required schema param(s) "
                f"{sorted(missing)} missing from the MCP inputSchema properties "
                f"{sorted(properties)}"
            )

    assert not failures, "\n" + "\n".join(failures)
