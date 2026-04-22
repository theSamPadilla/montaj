#!/usr/bin/env python3
"""Generate a voiceover audio file from text via Kling or Gemini TTS.

Generation step — produces a file on disk and prints JSON metadata. No ffmpeg.
Composition into the project timeline happens elsewhere: a skill/workflow
appends an AudioTrack entry to project.audio.tracks[]; render/mix-audio.js
mixes at render time.
"""
import argparse, json, os, sys

# File lives at steps/<category>/<name>.py — reach lib/ and project root
# by going up two levels.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, get_duration
from connectors import ConnectorError


def read_text(args) -> str:
    if args.text and args.text_file:
        fail("invalid_args", "Pass either --text or --text-file, not both")
    if args.text:
        return args.text
    if args.text_file:
        try:
            with open(args.text_file, "r", encoding="utf-8") as f:
                return f.read().strip()
        except OSError as e:
            fail("not_found", f"Could not read text file: {e}")
    fail("invalid_args", "One of --text or --text-file is required")


def main():
    p = argparse.ArgumentParser(description="Generate voiceover audio from text")
    p.add_argument("--text",      help="Script text (inline)")
    p.add_argument("--text-file", dest="text_file", help="Path to a file containing the script")
    p.add_argument("--voice",     required=True, help="Voice identifier (vendor-specific)")
    p.add_argument("--out",       required=True, help="Output audio file path")
    p.add_argument("--vendor",    default="kling", choices=["kling", "gemini"],
                   help="TTS vendor (default: kling)")
    p.add_argument("--model",     help="Override vendor default model")
    p.add_argument("--speed",     type=float, default=1.0,
                   help="Playback speed (Kling only; ignored for Gemini)")
    p.add_argument("--language",  help="Language hint (Kling only; ignored for Gemini)")
    # --json on the step controls the step's own stdout format when invoked as a subprocess
    # by the CLI wrapper. The CLI wrapper has its own --json (via add_global_flags) which
    # controls emit() formatting. Two layers, two concerns — not a duplicate declaration.
    p.add_argument("--json",      action="store_true", help="Emit full JSON envelope")
    args = p.parse_args()

    text = read_text(args)

    try:
        if args.vendor == "kling":
            from connectors import kling
            kwargs = {"text": text, "voice": args.voice, "out_path": args.out, "speed": args.speed}
            if args.model:    kwargs["model"]    = args.model
            if args.language: kwargs["language"] = args.language
            path = kling.generate_speech(**kwargs)
        else:  # gemini
            from connectors import gemini
            kwargs = {"text": text, "voice": args.voice, "out_path": args.out}
            if args.model: kwargs["model"] = args.model
            path = gemini.generate_speech(**kwargs)
    except ConnectorError as e:
        fail("api_error", str(e))

    duration = get_duration(path)

    result = {
        "path": path,
        "duration_seconds": duration,
        "vendor": args.vendor,
        "voice": args.voice,
        "text_length_chars": len(text),
    }

    if args.json:
        print(json.dumps(result))
    else:
        print(path)


if __name__ == "__main__":
    main()
