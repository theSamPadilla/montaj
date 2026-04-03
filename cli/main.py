#!/usr/bin/env python3
"""montaj — video editing toolkit CLI."""
import argparse, os, sys
from cli.help import ColorHelpFormatter

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def add_global_flags(parser):
    parser.add_argument("--json",  action="store_true", help="Output result as JSON")
    parser.add_argument("--out",   metavar="PATH",      help="Output file path")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output")


def main():
    from cli.commands import (
        run, serve, render, workflow, step,
        fetch, profile,
        probe, snapshot,
        filler, waveform_trim, rm_nonspeech, trim, concat, resize,
        normalize, extract_audio, ffmpeg_captions,
        transcribe, caption,
        best_take, jump_cut_detect, pacing,
        init, status, mcp, adaptor, models,
        create_step, validate, install,
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
        "trim", "concat", "resize", "normalize", "extract-audio", "ffmpeg-captions",
        "transcribe", "caption",
        "best-take", "jump-cut-detect", "pacing",
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
    trim.register(subparsers)
    concat.register(subparsers)
    resize.register(subparsers)
    normalize.register(subparsers)
    extract_audio.register(subparsers)
    ffmpeg_captions.register(subparsers)
    transcribe.register(subparsers)
    caption.register(subparsers)
    best_take.register(subparsers)
    jump_cut_detect.register(subparsers)
    pacing.register(subparsers)
    init.register(subparsers)
    status.register(subparsers)
    mcp.register(subparsers)
    adaptor.register(subparsers)
    models.register(subparsers)
    create_step.register(subparsers)
    validate.register(subparsers)
    install.register(subparsers)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
