#!/usr/bin/env python3
"""Generate a music clip from a text prompt via Gemini Lyria 3 or ElevenLabs.

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
from connectors.gemini import DEFAULT_MUSIC_MODEL, invalid_api_key_message
from _fail_reasons import fail_for


def main():
    p = argparse.ArgumentParser(description="Generate a music clip from a text prompt")
    p.add_argument("--prompt",       required=True, help="Music description (genre, mood, instrumentation)")
    p.add_argument("--out",          required=True, help="Output audio file path")
    p.add_argument("--vendor",       default="gemini", choices=["gemini", "elevenlabs"],
                   help="Music vendor (default: gemini). ElevenLabs music needs their paid plan.")
    p.add_argument("--model",        help="Override the vendor's default model")
    p.add_argument("--seed",         type=int,
                   help="RNG seed for reproducibility. Gemini only; ignored for ElevenLabs.")
    p.add_argument("--with-vocals",  dest="with_vocals", action="store_true",
                   help="Allow vocals (default: instrumental-only). Gemini only; ElevenLabs ignores this.")
    p.add_argument("--duration",     type=float,
                   help="Clip length in seconds. Required for --vendor elevenlabs (minimum 3s); "
                        "ignored for Gemini, whose Lyria model produces a fixed-length clip.")
    # --json on the step controls the step's own stdout format when invoked as a subprocess
    # by the CLI wrapper. The CLI wrapper has its own --json (via add_global_flags) which
    # controls emit() formatting. Two layers, two concerns — not a duplicate declaration.
    p.add_argument("--json",         action="store_true", help="Emit full JSON envelope")
    args = p.parse_args()

    if args.vendor == "elevenlabs" and args.duration is None:
        fail("invalid_args", "--duration is required for --vendor elevenlabs")

    try:
        if args.vendor == "gemini":
            from connectors import gemini
            kwargs = {
                "prompt":       args.prompt,
                "out_path":     args.out,
                "instrumental": not args.with_vocals,
            }
            if args.model:     kwargs["model"] = args.model
            if args.seed is not None: kwargs["seed"] = args.seed
            path = gemini.generate_music(**kwargs)
            model = args.model or DEFAULT_MUSIC_MODEL
        else:  # elevenlabs
            from connectors import elevenlabs
            kwargs = {
                "prompt":    args.prompt,
                "out_path":  args.out,
                "length_ms": int(args.duration * 1000),
            }
            if args.model: kwargs["model"] = args.model
            path = elevenlabs.generate_music(**kwargs)
            model = args.model or elevenlabs.DEFAULT_MUSIC_MODEL
    except ConnectorError as e:
        if args.vendor == "gemini" and e.reason == "invalid_api_key":
            fail("invalid_api_key", invalid_api_key_message(e))
        fail_for(e, "Gemini" if args.vendor == "gemini" else "ElevenLabs")

    duration = get_duration(path)

    result = {
        "path": path,
        "duration_seconds": duration,
        "vendor": args.vendor,
        "model": model,
        "instrumental": not args.with_vocals,
    }

    if args.json:
        print(json.dumps(result))
    else:
        print(path)


if __name__ == "__main__":
    main()
