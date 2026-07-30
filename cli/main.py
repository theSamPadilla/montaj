#!/usr/bin/env python3
"""montaj — video editing toolkit CLI."""
import argparse, os, sys
from cli.help import ColorHelpFormatter

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def find_step(name):
    """Resolve a built-in step executable: steps/<category>/<name>.py (or flat fallback)."""
    steps_dir = os.path.join(MONTAJ_ROOT, "steps")
    flat = os.path.join(steps_dir, f"{name}.py")
    if os.path.isfile(flat):
        return flat
    for entry in os.scandir(steps_dir):
        if entry.is_dir() and not entry.name.startswith((".", "_")):
            path = os.path.join(entry.path, f"{name}.py")
            if os.path.isfile(path):
                return path
    raise FileNotFoundError(f"Built-in step not found: {name}")


def add_global_flags(parser):
    parser.add_argument("--json",  action="store_true", help="Output result as JSON")
    parser.add_argument("--out",   metavar="PATH",      help="Output file path")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output")


# Hand-written commands: command name (as typed on the CLI) -> module import
# path. The 16 pure single-step commands moved to _STEP_COMMANDS below (they are
# generated from their step JSON schema instead of a hand-written module).
_COMMANDS = {
    "approve":            "cli.commands.approve",
    "create-step":        "cli.commands.create_step",
    "credentials":        "cli.commands.credentials",
    "doctor":             "cli.commands.doctor",
    "fetch":              "cli.commands.fetch",
    "init":               "cli.commands.init",
    "install":            "cli.commands.install",
    "materialize-cut":    "cli.commands.materialize_cut",
    "mcp":                "cli.commands.mcp",
    "models":             "cli.commands.models",
    "normalize":          "cli.commands.normalize",
    "profile":            "cli.commands.profile",
    "regen":              "cli.commands.regen",
    "remove-bg":          "cli.commands.remove_bg",
    "render":             "cli.commands.render",
    "run":                "cli.commands.run",
    "sample":             "cli.commands.sample",
    "serve":              "cli.commands.serve",
    "status":             "cli.commands.status",
    "step":               "cli.commands.step",
    "update":             "cli.commands.update",
    "upload":             "cli.commands.upload",
    "validate":           "cli.commands.validate",
    "waveform-trim":      "cli.commands.waveform_trim",
    "workflow":           "cli.commands.workflow",
}

# Schema-driven single-step commands: command name -> per-command quirks dict
# passed to register_step_command (the canonical parity table). The command
# NAMES and their order/visibility are preserved in _REGISTRATION_ORDER and
# _HIDDEN below exactly as before (filler keeps its name→rm_fillers step remap).
_STEP_COMMANDS = {
    "analyze-media":      {},
    "caption":            {},
    "detect-shots":       {},
    "extract-audio":      {},
    "filler":             {"step_name": "rm_fillers"},
    "generate-image":     {"required_out": True},
    "generate-music":     {"required_out": True, "forward_json": True},
    "generate-voiceover": {"required_out": True, "forward_json": True, "xor": ("text", "text_file")},
    "kling-generate":     {"required_out": True},
    "lyrics-render":      {"emit_json": False, "file_prechecks": ["captions", "audio"]},
    "lyrics-sync":        {"emit_json": False, "file_prechecks": ["lyrics"]},
    "probe":              {},
    "resize":             {},
    "rm-nonspeech":       {},
    "shot-sheet":         {},
    "snapshot":           {},
    "stem-separation":    {"emit_json": False},
    "transcribe":         {"emit_json": False},
}

# Order commands were registered in before this change — preserved so that a
# full "register everything" pass (bare invocation, -h/--help, unknown
# command) renders --help identically to before.
_REGISTRATION_ORDER = (
    "run", "serve", "fetch", "profile", "render", "sample", "workflow", "step",
    "probe", "snapshot", "filler", "waveform-trim", "rm-nonspeech",
    "materialize-cut", "resize", "normalize", "extract-audio", "transcribe",
    "caption", "lyrics-sync", "lyrics-render", "stem-separation", "init",
    "status", "upload", "approve", "regen", "mcp", "models", "doctor",
    "create-step", "validate", "install", "credentials", "update",
    "remove-bg", "kling-generate", "analyze-media", "generate-image",
    "generate-voiceover", "generate-music", "detect-shots", "shot-sheet",
)

# Individual step commands — available but not listed in top-level help.
# Discover them via `montaj step --list`. Module-level (not local to main())
# so it's introspectable the same way _STEP_COMMANDS/_REGISTRATION_ORDER are.
_HIDDEN = {
    "probe", "snapshot",
    "filler", "waveform-trim", "rm-nonspeech",
    "materialize-cut", "resize", "normalize", "extract-audio",
    "transcribe", "caption", "lyrics-sync", "lyrics-render", "stem-separation",
    "remove-bg",
    "kling-generate", "analyze-media", "generate-image", "generate-voiceover",
    "generate-music", "detect-shots", "shot-sheet",
}


def _load(modpath):
    # __import__() (not importlib.import_module): on the dotted-module path used
    # here, import_module() doesn't get its own "-X importtime" trace line (only
    # its dependencies do), which makes lazy-loading unverifiable from outside.
    # __import__() does.
    __import__(modpath)
    return sys.modules[modpath]


def register_command(name, subparsers):
    """Register one command's subparser onto ``subparsers``.

    Migrated single-step commands are generated from their step JSON schema via
    ``cli.step_command`` (imported lazily, so a single-command invocation never
    pulls it in unless that command is the one invoked); every other command is
    a hand-written module exposing ``register(subparsers)``.
    """
    if name in _STEP_COMMANDS:
        from cli.step_command import register_step_command
        register_step_command(subparsers, name, quirks=_STEP_COMMANDS[name])
    else:
        _load(_COMMANDS[name]).register(subparsers)


def main():
    from importlib.metadata import version as pkg_version
    try:
        __version__ = pkg_version("montaj")
    except Exception:
        __version__ = "dev"

    parser = argparse.ArgumentParser(
        prog="montaj",
        description="Video editing toolkit",
        formatter_class=ColorHelpFormatter,
    )
    from cli.help import bold, cyan
    parser.add_argument("-v", "--version", action="version",
                        version=f"{bold('montaj')} {cyan(__version__)}")
    subparsers = parser.add_subparsers(dest="command", required=True, metavar="<command>")

    # Inject formatter into every subcommand without touching each command file
    _orig_add_parser = subparsers.add_parser
    def _add_parser(name, **kw):
        kw.setdefault("formatter_class", ColorHelpFormatter)
        if name in _HIDDEN:
            kw["help"] = argparse.SUPPRESS
        return _orig_add_parser(name, **kw)
    subparsers.add_parser = _add_parser

    # Version fast path: skip command-module discovery/import entirely.
    # Byte-identical to the "-v"/"--version" argparse action registered above
    # (same __version__, same bold/cyan formatting) — just reached without
    # paying to import any cli.commands module first.
    argv = sys.argv[1:]
    if argv and argv[0] in ("-v", "--version"):
        print(f"{bold('montaj')} {cyan(__version__)}")
        return

    # Register only the invoked command. Anything else (no command, unknown
    # command, -h/--help) falls back to registering everything so argparse's own
    # help/error output is unchanged.
    cmd = next((a for a in argv if not a.startswith("-")), None)
    if cmd in _COMMANDS or cmd in _STEP_COMMANDS:
        register_command(cmd, subparsers)
    else:
        for name in _REGISTRATION_ORDER:
            register_command(name, subparsers)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
