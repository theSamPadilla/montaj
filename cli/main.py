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


# Command name (as typed on the CLI) -> module import path. 1:1 with the
# former bulk `from cli.commands import (...)`, alphabetical.
_COMMANDS = {
    "analyze-media":      "cli.commands.analyze_media",
    "approve":            "cli.commands.approve",
    "caption":            "cli.commands.caption",
    "create-step":        "cli.commands.create_step",
    "credentials":        "cli.commands.credentials",
    "doctor":             "cli.commands.doctor",
    "extract-audio":      "cli.commands.extract_audio",
    "fetch":              "cli.commands.fetch",
    "filler":             "cli.commands.filler",
    "generate-image":     "cli.commands.generate_image",
    "generate-music":     "cli.commands.generate_music",
    "generate-voiceover": "cli.commands.generate_voiceover",
    "init":               "cli.commands.init",
    "install":            "cli.commands.install",
    "kling-generate":     "cli.commands.kling_generate",
    "lyrics-render":      "cli.commands.lyrics_render",
    "lyrics-sync":        "cli.commands.lyrics_sync",
    "materialize-cut":    "cli.commands.materialize_cut",
    "mcp":                "cli.commands.mcp",
    "models":             "cli.commands.models",
    "normalize":          "cli.commands.normalize",
    "probe":              "cli.commands.probe",
    "profile":            "cli.commands.profile",
    "regen":              "cli.commands.regen",
    "remove-bg":          "cli.commands.remove_bg",
    "render":             "cli.commands.render",
    "resize":             "cli.commands.resize",
    "rm-nonspeech":       "cli.commands.rm_nonspeech",
    "run":                "cli.commands.run",
    "sample":             "cli.commands.sample",
    "serve":              "cli.commands.serve",
    "snapshot":           "cli.commands.snapshot",
    "status":             "cli.commands.status",
    "stem-separation":    "cli.commands.stem_separation",
    "step":               "cli.commands.step",
    "transcribe":         "cli.commands.transcribe",
    "update":             "cli.commands.update",
    "upload":             "cli.commands.upload",
    "validate":           "cli.commands.validate",
    "waveform-trim":      "cli.commands.waveform_trim",
    "workflow":           "cli.commands.workflow",
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
    "generate-voiceover", "generate-music",
)


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

    # Individual step commands — available but not listed in top-level help.
    # Discover them via `montaj step --list`.
    _HIDDEN = {
        "probe", "snapshot",
        "filler", "waveform-trim", "rm-nonspeech",
        "materialize-cut", "resize", "normalize", "extract-audio",
        "transcribe", "caption", "lyrics-sync", "lyrics-render", "stem-separation",
        "remove-bg",
        "kling-generate", "analyze-media", "generate-image", "generate-voiceover",
        "generate-music",
    }

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

    # Import only the invoked command's module. Anything else (no command,
    # unknown command, -h/--help) falls back to registering everything so
    # argparse's own help/error output is unchanged.
    #
    # Uses __import__() rather than importlib.import_module(): on the
    # dotted-module path used here, import_module() doesn't get its own
    # "-X importtime" trace line (only its dependencies do), which makes
    # lazy-loading unverifiable from the outside. __import__() does.
    def _load(modpath):
        __import__(modpath)
        return sys.modules[modpath]

    cmd = next((a for a in argv if not a.startswith("-")), None)
    if cmd in _COMMANDS:
        _load(_COMMANDS[cmd]).register(subparsers)
    else:
        for name in _REGISTRATION_ORDER:
            _load(_COMMANDS[name]).register(subparsers)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
