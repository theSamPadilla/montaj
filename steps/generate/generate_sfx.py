#!/usr/bin/env python3
"""Generate a sound effect from a text description via ElevenLabs.

Generation step — produces a file on disk and prints JSON metadata. No ffmpeg.
"""
import argparse, json, os, sys

# File lives at steps/<category>/<name>.py — reach lib/ and project root
# by going up two levels.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import fail, get_duration
from connectors import ConnectorError
from connectors.elevenlabs import DEFAULT_SFX_MODEL
from _fail_reasons import fail_for


def main():
    p = argparse.ArgumentParser(description="Generate a sound effect from text via ElevenLabs")
    p.add_argument("--text",     required=True, help="Sound effect description")
    p.add_argument("--out",      required=True, help="Output audio file path")
    p.add_argument("--duration", type=float,
                   help="Length in seconds (0.5-30). Omit to let ElevenLabs choose.")
    p.add_argument("--model",    help=f"Override the connector's default model (default: {DEFAULT_SFX_MODEL})")
    # --json on the step controls the step's own stdout format when invoked as a subprocess
    # by the CLI wrapper. The CLI wrapper has its own --json (via add_global_flags) which
    # controls emit() formatting. Two layers, two concerns — not a duplicate declaration.
    p.add_argument("--json",     action="store_true", help="Emit full JSON envelope")
    args = p.parse_args()

    try:
        from connectors import elevenlabs
        kwargs = {"text": args.text, "out_path": args.out}
        if args.duration is not None:
            kwargs["duration_seconds"] = args.duration
        if args.model:
            kwargs["model"] = args.model
        path = elevenlabs.generate_sfx(**kwargs)
    except ConnectorError as e:
        fail_for(e, "ElevenLabs")

    duration = get_duration(path)

    result = {
        "path": path,
        "duration_seconds": duration,
        "vendor": "elevenlabs",
        "model": args.model or DEFAULT_SFX_MODEL,
    }

    if args.json:
        print(json.dumps(result))
    else:
        print(path)


if __name__ == "__main__":
    main()
