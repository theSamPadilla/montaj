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
            _collect(tokens + [sub_name], sub_parser, out,
                     description=sub_help.get(sub_name))
        return

    # Leaf parser — build the tool definition
    properties  = {}
    required    = []
    positionals = []

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
        elif getattr(action, 'required', False):
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
        '_has_json':    has_json,
    })


def export():
    """Return list of MCP tool dicts for all usable CLI commands."""
    from cli.commands import (
        run, render, workflow, fetch, profile,
        probe, snapshot, filler, waveform_trim, rm_nonspeech,
        materialize_cut, resize, normalize, extract_audio,
        transcribe, caption, status, remove_bg, init,
    )

    parser     = argparse.ArgumentParser(prog='montaj')
    subparsers = parser.add_subparsers(dest='command')

    for mod in [
        run, render, workflow, fetch, profile,
        probe, snapshot, filler, waveform_trim, rm_nonspeech,
        materialize_cut, resize, normalize, extract_audio,
        transcribe, caption, status, remove_bg, init,
    ]:
        mod.register(subparsers)

    top_help = {a.dest: a.help for a in subparsers._choices_actions}

    tools = []
    for name, sub in subparsers.choices.items():
        if name not in _SKIP_COMMANDS:
            _collect([name], sub, tools, description=top_help.get(name))
    return tools


if __name__ == '__main__':
    print(json.dumps(export(), indent=2))
