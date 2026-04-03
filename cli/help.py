"""Color help formatter for argparse — zero dependencies."""
import argparse

R  = "\033[0m"
B  = "\033[1m"       # bold
Y  = "\033[33;1m"    # yellow bold  — section headers / usage label
G  = "\033[32m"      # green        — flags
C  = "\033[36m"      # cyan         — subcommand / positional names
D  = "\033[2m"       # dim          — metavar hints


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
