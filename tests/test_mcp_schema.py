"""Unit tests for cli/mcp_schema.py's argparse -> MCP schema conversion.

Focus: an argparse option's `dest` can deliberately differ from its flag
string (e.g. `--clip` with `dest="clips"` in cli/commands/init.py — the CLI
flag is singular for nicer UX, the dest is plural to match the downstream
project/init.py flag it forwards to). The generated schema must carry the
real flag alongside the dest-keyed property, so a caller (montaj_assets/mcp/
server.js's buildCliArgs) can round-trip `{"clips": [...]}` back into
`--clip ...` instead of guessing `--clips` from the property name — which is
exactly the bug this test guards against (see CHANGELOG's `## Unreleased`
entry).
"""
import argparse

from cli.mcp_schema import _collect


def _tool_for(parser: argparse.ArgumentParser) -> dict:
    out = []
    _collect(["test"], parser, out)
    assert len(out) == 1
    return out[0]


def test_flag_recorded_for_dest_that_differs_from_its_flag():
    """Synthetic case mirroring --clip/dest=clips: the generated tool must
    carry the real flag string, not assume it's derivable from the dest."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--clip", dest="clips", action="append", default=[])
    tool = _tool_for(parser)
    assert tool["_flags"]["clips"] == "--clip"


def test_flag_recorded_for_dest_that_matches_its_flag():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", dest="name")
    tool = _tool_for(parser)
    assert tool["_flags"]["name"] == "--name"


def test_flag_map_omits_positionals():
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    tool = _tool_for(parser)
    assert "path" not in tool.get("_flags", {})
    assert tool["_positionals"] == ["path"]


def test_init_tool_flags_survive_dest_flag_mismatches():
    """Integration-level: cli/commands/init.py's real argparse setup has
    several options where the flag differs from its dest. The exported
    schema must record each real flag so montaj_assets/mcp/server.js can
    rebuild the CLI invocation correctly."""
    # `init` is no longer exported (PL11), but the mechanism is general:
    # build its tool entry the way export() builds every tool.
    from cli.main import register_command

    parser = argparse.ArgumentParser(prog="montaj")
    subparsers = parser.add_subparsers(dest="command")
    register_command("init", subparsers)
    out = []
    _collect(["init"], subparsers.choices["init"], out)
    init_tool = next(t for t in out if t["name"] == "init")
    flags = init_tool["_flags"]
    assert flags["clips"] == "--clip"
    assert flags["assets"] == "--asset"
    assert flags["remote_clips"] == "--remote-clip"
    assert flags["remote_assets"] == "--remote-asset"
    # sanity: a dest that already matches its flag still round-trips
    assert flags["prompt"] == "--prompt"
