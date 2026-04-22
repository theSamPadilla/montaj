#!/usr/bin/env python3
"""Generate a music clip from a text prompt via Gemini Lyria 3.

Generation step — produces a file on disk and prints JSON metadata. No ffmpeg.
"""
import argparse, json, os, sys

# File lives at steps/<category>/<name>.py — reach lib/ and project root
# by going up two levels.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, get_duration
from connectors import ConnectorError
from connectors.gemini import DEFAULT_MUSIC_MODEL


def main():
    p = argparse.ArgumentParser(description="Generate a music clip from a text prompt")
    p.add_argument("--prompt",       required=True, help="Music description (genre, mood, instrumentation)")
    p.add_argument("--out",          required=True, help="Output audio file path")
    p.add_argument("--model",        help="Override Lyria model (default: lyria-3-clip-preview)")
    p.add_argument("--seed",         type=int, help="RNG seed for reproducibility")
    p.add_argument("--with-vocals",  dest="with_vocals", action="store_true",
                   help="Allow vocals (default: instrumental-only)")
    # --json on the step controls the step's own stdout format when invoked as a subprocess
    # by the CLI wrapper. The CLI wrapper has its own --json (via add_global_flags) which
    # controls emit() formatting. Two layers, two concerns — not a duplicate declaration.
    p.add_argument("--json",         action="store_true", help="Emit full JSON envelope")
    args = p.parse_args()

    try:
        from connectors import gemini
        kwargs = {
            "prompt":       args.prompt,
            "out_path":     args.out,
            "instrumental": not args.with_vocals,
        }
        if args.model:     kwargs["model"] = args.model
        if args.seed is not None: kwargs["seed"] = args.seed
        path = gemini.generate_music(**kwargs)
    except ConnectorError as e:
        fail("api_error", str(e))

    duration = get_duration(path)

    result = {
        "path": path,
        "duration_seconds": duration,
        "vendor": "gemini",
        "model": args.model or DEFAULT_MUSIC_MODEL,
        "instrumental": not args.with_vocals,
    }

    if args.json:
        print(json.dumps(result))
    else:
        print(path)


if __name__ == "__main__":
    main()
