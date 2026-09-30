#!/usr/bin/env python3
"""Export MCP tool definitions by introspecting CLI argparse parsers.

Called by mcp/server.js at startup:
    python3 cli/mcp_schema.py   →  JSON array of tool definitions

Each tool has:
  name         — underscore-joined command path, e.g. "render", "workflow_list"
  description  — from the argparse parser description
  inputSchema  — JSON Schema for MCP callers
  _cli_tokens  — the CLI subcommand tokens, e.g. ["render"] or ["workflow", "list"]
  _positionals — ordered list of positional arg dests (for CLI arg building)
  _has_json    — bool: whether --json flag is available (added by add_global_flags)
"""
import argparse
import json
import os
import sys

# Ensure MONTAJ_ROOT is importable as a package root even if not installed
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Top-level commands to omit from MCP tools (dev / infra / interactive commands)
_SKIP_COMMANDS = frozenset({
    'mcp',           # would be recursive
    'serve',         # starts HTTP server; not useful for tool calls
    'install',       # one-time setup; not useful for tool calls
    'create-step',   # scaffolding; not useful for tool calls
    'validate',      # developer validation; not useful for tool calls
    'models',        # whisper model download; not useful for tool calls
    'step',          # meta-command for running steps by name; redundant
})

# argparse arg dests to exclude from MCP input schemas
_SKIP_DESTS = frozenset({'json', 'quiet', 'func', 'help'})

# Subcommands to omit from MCP tools even though their parent command is
# allowlisted, keyed by the full (command, subcommand) token path. `workflow
# new` and `workflow edit` are both authoring commands, not connector
# operations: `edit` launches $EDITOR on the user's machine, which hangs or
# does nothing from an AI client with no TTY, and scaffolding a new workflow
# is an authoring task outside the connector's editing surface. `workflow
# list` and `workflow run` stay exported.
_EXCLUDED_SUBCOMMANDS = frozenset({
    ('workflow', 'new'),
    ('workflow', 'edit'),
})


def _action_to_prop(action):
    """Convert an argparse action to a JSON Schema property dict."""
    help_text = (action.help or action.dest)
    # Strip argparse default-value annotations like '(default: %(default)s)'
    help_text = help_text.split('(default:')[0].rstrip('. ')
    prop = {'description': help_text}

    if isinstance(action, (argparse._StoreTrueAction, argparse._StoreFalseAction)):
        prop['type'] = 'boolean'
    elif action.type is int:
        prop['type'] = 'integer'
    elif action.type is float:
        prop['type'] = 'number'
    elif action.nargs in ('*', '+'):
        prop['type'] = 'array'
        prop['items'] = {'type': 'string'}
    else:
        prop['type'] = 'string'

    if action.choices:
        prop['enum'] = list(action.choices)
    if (action.default is not None
            and action.default is not argparse.SUPPRESS
            and not isinstance(action.default, type)):
        prop['default'] = action.default

    return prop


def _primary_flag(option_strings):
    """Pick the flag string to use when rebuilding CLI args from a dest.

    An argparse option's `dest` is not always derivable from its flag: a
    command can deliberately name the flag differently from the dest it
    populates (e.g. cli/commands/init.py's `--clip` with dest="clips" — the
    flag is singular for CLI ergonomics, the dest matches the downstream
    flag it forwards to). Prefer a long option ('--foo'), since that's what
    a human — and an MCP caller rebuilding argv — would type; fall back to
    the first option string if only short forms exist.
    """
    long_opts = [s for s in option_strings if s.startswith('--')]
    return long_opts[0] if long_opts else option_strings[0]


def _collect(tokens, parser, out, description=None):
    """Recursively walk a parser, flattening subcommands into separate tools."""
    sub_action = next(
        (a for a in parser._actions if isinstance(a, argparse._SubParsersAction)),
        None,
    )
    if sub_action:
        # Build help-text map from the subparsers pseudo-actions
        sub_help = {a.dest: a.help for a in sub_action._choices_actions}
        for sub_name, sub_parser in sub_action.choices.items():
            if tuple(tokens + [sub_name]) in _EXCLUDED_SUBCOMMANDS:
                continue
            _collect(tokens + [sub_name], sub_parser, out,
                     description=sub_help.get(sub_name))
        return

    # Leaf parser — build the tool definition
    properties  = {}
    required    = []
    positionals = []
    flags       = {}

    for action in parser._actions:
        if isinstance(action, (argparse._HelpAction, argparse._SubParsersAction)):
            continue
        if action.dest in _SKIP_DESTS:
            continue

        properties[action.dest] = _action_to_prop(action)

        if not action.option_strings:  # positional
            positionals.append(action.dest)
            # Required unless nargs allows zero matches or there is a default
            if action.nargs not in ('?', '*') and action.default is None:
                required.append(action.dest)
        else:
            # Record the real flag for every optional, not just the ones
            # known to mismatch today — deriving "--" + dest.replace('_',
            # '-') from the property name is exactly the bug this closes,
            # and it's silent for any option whose dest happens to differ
            # from its flag, not just `init`'s.
            flags[action.dest] = _primary_flag(action.option_strings)
            if getattr(action, 'required', False):
                required.append(action.dest)

    has_json = any(
        a.dest == 'json'
        for a in parser._actions
        if not isinstance(a, argparse._HelpAction)
    )

    name = '_'.join(tokens).replace('-', '_')
    out.append({
        'name':         name,
        'description':  description or parser.description or ' '.join(tokens),
        'inputSchema':  {
            'type':       'object',
            'properties': properties,
            **({'required': required} if required else {}),
        },
        '_cli_tokens':  tokens,
        '_positionals': positionals,
        '_flags':       flags,
        '_has_json':    has_json,
    })


# Explicit allowlist of top-level commands exported as MCP tools. A conscious
# surface choice, NOT registry drift. One tool only: `render`, the agent's
# way to produce the final video file. No step command is exported: a step
# runs through the CLI (`montaj <command>`) or serve's POST /api/steps/<name>,
# and the Montaj app's connector adds its own `run_step` tool over that route.
# Project setup (`init`, `run`, `workflow`), `status`, `normalize`, `upload`,
# `log` and `profile` are CLI-only too: the app has its own project, workflow,
# progress and profile tools (Sam, 2026-09-30, PL11).
_EXPORTED_COMMANDS = frozenset({'render'})


def export():
    """Return list of MCP tool dicts for the allowlisted CLI commands.

    Builds each command's parser through ``cli.main``'s command registry (so
    migrated single-step commands come from their schema-driven generator and
    hand-written commands from their modules), rather than a hardcoded import
    list. The exported tool set is fixed by ``_EXPORTED_COMMANDS``.
    """
    from cli.main import register_command

    parser     = argparse.ArgumentParser(prog='montaj')
    subparsers = parser.add_subparsers(dest='command')

    for name in sorted(_EXPORTED_COMMANDS):
        register_command(name, subparsers)

    top_help = {a.dest: a.help for a in subparsers._choices_actions}

    tools = []
    for name, sub in subparsers.choices.items():
        if name not in _SKIP_COMMANDS:
            _collect([name], sub, tools, description=top_help.get(name))

    return tools


if __name__ == '__main__':
    print(json.dumps(export(), indent=2))
