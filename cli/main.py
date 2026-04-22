#!/usr/bin/env python3
"""montaj — video editing toolkit CLI."""
import argparse, os, sys
import static_ffmpeg
static_ffmpeg.add_paths()
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


def main():
    from cli.commands import (
        run, serve, render, workflow, step,
        fetch, profile,
        probe, snapshot,
        filler, waveform_trim, rm_nonspeech, materialize_cut, resize,
        normalize, extract_audio,
        transcribe, caption, lyrics_sync, lyrics_render, stem_separation,
        init, status, approve, regen, mcp, models,

        create_step, validate, install, update,
        remove_bg,
        kling_generate, analyze_media, generate_image, generate_voiceover,
        generate_music,
    )

    parser = argparse.ArgumentParser(
        prog="montaj",
        description="Video editing toolkit",
        formatter_class=ColorHelpFormatter,
    )
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

    run.register(subparsers)
    serve.register(subparsers)
    fetch.register(subparsers)
    profile.register(subparsers)
    render.register(subparsers)
    workflow.register(subparsers)
    step.register(subparsers)
    probe.register(subparsers)
    snapshot.register(subparsers)
    filler.register(subparsers)
    waveform_trim.register(subparsers)
    rm_nonspeech.register(subparsers)
    materialize_cut.register(subparsers)
    resize.register(subparsers)
    normalize.register(subparsers)
    extract_audio.register(subparsers)
    transcribe.register(subparsers)
    caption.register(subparsers)
    lyrics_sync.register(subparsers)
    lyrics_render.register(subparsers)
    stem_separation.register(subparsers)
    init.register(subparsers)
    status.register(subparsers)
    approve.register(subparsers)
    regen.register(subparsers)
    mcp.register(subparsers)
    models.register(subparsers)
    create_step.register(subparsers)
    validate.register(subparsers)
    install.register(subparsers)
    update.register(subparsers)
    remove_bg.register(subparsers)
    kling_generate.register(subparsers)
    analyze_media.register(subparsers)
    generate_image.register(subparsers)
    generate_voiceover.register(subparsers)
    generate_music.register(subparsers)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
