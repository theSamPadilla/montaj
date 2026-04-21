"""Color help formatter + shared ANSI utilities for the CLI — zero dependencies."""
import argparse, os, sys

# ── Color support detection ───────────────────────────────────────────────────

def _supports_color() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("FORCE_COLOR"):
        return True
    return hasattr(sys.stdout, "isatty") and sys.stdout.isatty()

USE_COLOR = _supports_color()

# ── ANSI primitives ──────────────────────────────────────────────────────────

R  = "\033[0m"       if USE_COLOR else ""
B  = "\033[1m"       if USE_COLOR else ""   # bold
Y  = "\033[33;1m"    if USE_COLOR else ""   # yellow bold  — section headers
G  = "\033[32m"      if USE_COLOR else ""   # green        — flags, success
C  = "\033[36m"      if USE_COLOR else ""   # cyan         — subcommand names
D  = "\033[2m"       if USE_COLOR else ""   # dim          — hints

# ── Semantic helpers (import these in command files) ─────────────────────────

def c(code: str, text: str) -> str:
    """Apply an arbitrary ANSI code. e.g. c("1;36", "bold cyan")."""
    return f"\033[{code}m{text}\033[0m" if USE_COLOR else text

def bold(t: str) -> str:    return c("1", t)
def dim(t: str) -> str:     return c("2", t)
def red(t: str) -> str:     return c("31", t)
def green(t: str) -> str:   return c("32", t)
def yellow(t: str) -> str:  return c("33", t)
def blue(t: str) -> str:    return c("34", t)
def cyan(t: str) -> str:    return c("36", t)

# ── Argparse formatter ───────────────────────────────────────────────────────

class ColorHelpFormatter(argparse.HelpFormatter):
    def start_section(self, heading):
        super().start_section(f"{Y}{heading}{R}" if heading else heading)

    def _format_usage(self, usage, actions, groups, prefix):
        if prefix is None:
            prefix = f"{Y}usage{R}: "
        return super()._format_usage(usage, actions, groups, prefix)

    def _format_action_invocation(self, action):
        text = super()._format_action_invocation(action)
        if action.option_strings:
            for opt in action.option_strings:
                text = text.replace(opt, f"{G}{opt}{R}", 1)
        elif action.dest not in ("command",):
            # subcommand names and bare positionals
            text = f"{C}{text}{R}"
        return text

    def _format_action(self, action):
        if isinstance(action, argparse._SubParsersAction):
            # Skip the "{cmd,...}" header; skip suppressed subcommands.
            parts = []
            for subaction in self._iter_indented_subactions(action):
                if subaction.help is argparse.SUPPRESS:
                    continue
                parts.append(self._format_action(subaction))
            return self._join_parts(parts)
        return super()._format_action(action)
