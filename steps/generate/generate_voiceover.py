#!/usr/bin/env python3
"""Generate a voiceover audio file from text via ElevenLabs, Gemini or Kling TTS.

Without --vendor, the first connected of elevenlabs, gemini, kling is used.

Generation step — produces a file on disk and prints JSON metadata. No ffmpeg.
Composition into the project timeline happens elsewhere: a skill/workflow
appends an AudioTrack entry to project.audio.tracks[]; render/mix-audio.js
mixes at render time.
"""
import argparse, json, os, re, sys, tempfile

# File lives at steps/<category>/<name>.py — reach lib/ and project root
# by going up two levels.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import fail, get_duration
from connectors import ConnectorError
from connectors.gemini import invalid_api_key_message
from lib.credentials import is_configured, provider_name
from _fail_reasons import fail_for


# ElevenLabs refuses a request over its model's character limit. Unlisted models get the lowest.
ELEVENLABS_CHAR_LIMITS = {"eleven_multilingual_v2": 10000, "eleven_flash_v2_5": 40000, "eleven_turbo_v2_5": 40000}
ELEVENLABS_DEFAULT_LIMIT = 5000


def _looks_like_file_name(text: str) -> bool:
    """A single word that ends .txt/.md or names a file on disk: the AI passed a file's name as the script."""
    t = text.strip()
    if not t or (re.search(r"\s", t) and not os.path.isfile(t)):
        return False
    return t.lower().endswith((".txt", ".md")) or os.path.isfile(t)


def split_text(text: str, limit: int) -> list:
    """Pieces of at most `limit` characters, cut at a paragraph, else a sentence end, else a space."""
    pieces, rest = [], text.strip()
    while len(rest) > limit:
        window = rest[:limit]
        ends = [m.end() for m in re.finditer(r"[.!?\u2026\u3002]['\")\]]*\s", window)]
        # The first kind of break that leaves a sizeable piece: paragraph, sentence, line, word.
        found = (window.rfind("\n\n"), max(ends, default=-1), window.rfind("\n"), window.rfind(" "))
        cut = next((c for c in found if c > limit // 4), limit)
        pieces.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    return pieces + ([rest] if rest else [])


def join_mp3(paths: list, out_path: str) -> str:
    """The mp3 pieces joined in order, copied without re-encoding."""
    from common import ffmpeg_bin, ff_path, run
    with tempfile.TemporaryDirectory() as d:
        listing = os.path.join(d, "list.txt")
        with open(listing, "w", encoding="utf-8") as f:
            for p in paths:
                f.write("file '" + os.path.abspath(p).replace("'", "'\\''") + "'\n")
        r = run([ffmpeg_bin(), "-y", "-f", "concat", "-safe", "0", "-i", ff_path(listing), "-c", "copy",
                 ff_path(out_path)], timeout=600, check=False)
    if r.returncode != 0:
        fail("ffmpeg_error", "Could not join the voiceover pieces: " + r.stderr[-300:])
    return out_path


def read_text(args) -> str:
    if args.text and args.text_file:
        fail("invalid_args", "Pass either --text or --text-file, not both")
    if args.text:
        if _looks_like_file_name(args.text):
            fail("invalid_args", f"'text' is the file name {args.text.strip()!r}, not the script, so nothing was "
                                 "generated. Pass the script itself as text, or the file as text-file.")
        return args.text
    if args.text_file:
        try:
            with open(args.text_file, "r", encoding="utf-8") as f:
                return f.read().strip()
        except OSError as e:
            fail("not_found", f"Could not read text file: {e}")
    fail("invalid_args", "One of --text or --text-file is required")


VENDOR_ORDER = ("elevenlabs", "gemini", "kling")


def default_vendor() -> str:
    """The first connected vendor in VENDOR_ORDER; fails when none is."""
    for v in VENDOR_ORDER:
        if is_configured(v):
            return v
    tiles = ", ".join(provider_name(v) for v in VENDOR_ORDER)
    fail("api_error", f"No voice key. Add one in Montaj under Connectors: {tiles}.")


def main():
    p = argparse.ArgumentParser(description="Generate voiceover audio from text")
    p.add_argument("--text",      help="Script text (inline)")
    p.add_argument("--text-file", dest="text_file", help="Path to a file containing the script")
    p.add_argument("--voice",     required=True, help="Voice identifier (vendor-specific)")
    p.add_argument("--out",       required=True, help="Output audio file path")
    p.add_argument("--vendor",    choices=["elevenlabs", "gemini", "kling"],
                   help="TTS vendor (default: the first connected of elevenlabs, gemini, kling)")
    p.add_argument("--model",     help="Override vendor default model")
    p.add_argument("--speed",     type=float, default=1.0,
                   help="Playback speed (Kling only; ignored for Gemini and ElevenLabs)")
    p.add_argument("--language",  help="Language hint (Kling only; ignored for Gemini and ElevenLabs)")
    # --json on the step controls the step's own stdout format when invoked as a subprocess
    # by the CLI wrapper. The CLI wrapper has its own --json (via add_global_flags) which
    # controls emit() formatting. Two layers, two concerns — not a duplicate declaration.
    p.add_argument("--json",      action="store_true", help="Emit full JSON envelope")
    args = p.parse_args()

    text = read_text(args)
    if not args.vendor:
        args.vendor = default_vendor()

    try:
        if args.vendor == "kling":
            from connectors import kling
            kwargs = {"text": text, "voice": args.voice, "out_path": args.out, "speed": args.speed}
            if args.language: kwargs["language"] = args.language
            path = kling.generate_speech(**kwargs)
        elif args.vendor == "gemini":
            from connectors import gemini
            kwargs = {"text": text, "voice": args.voice, "out_path": args.out}
            if args.model: kwargs["model"] = args.model
            path = gemini.generate_speech(**kwargs)
        else:  # elevenlabs
            from connectors import elevenlabs
            kwargs = {"text": text, "voice": args.voice, "out_path": args.out}
            if args.model: kwargs["model"] = args.model
            limit = ELEVENLABS_CHAR_LIMITS.get(args.model or elevenlabs.DEFAULT_TTS_MODEL, ELEVENLABS_DEFAULT_LIMIT)
            pieces = split_text(text, limit)
            if len(pieces) == 1:
                path = elevenlabs.generate_speech(**kwargs)
            else:
                with tempfile.TemporaryDirectory() as d:
                    parts = [elevenlabs.generate_speech(**{**kwargs, "text": piece,
                                                           "out_path": os.path.join(d, f"part{i}.mp3")})
                             for i, piece in enumerate(pieces)]
                    path = join_mp3(parts, elevenlabs.retarget_extension(args.out, ".mp3"))
    except ConnectorError as e:
        if args.vendor == "gemini" and e.reason == "invalid_api_key":
            fail("invalid_api_key", invalid_api_key_message(e))
        fail_for(e, {"kling": "Kling", "gemini": "Gemini", "elevenlabs": "ElevenLabs"}[args.vendor])

    duration = get_duration(path)

    result = {
        "path": path,
        "type": "audio",
        "duration_seconds": duration,
        "vendor": args.vendor,
        "voice": args.voice,
        "text_length_chars": len(text),
    }
    # Always the JSON answer: serve never passes --json (it is not a declared param), and the vendor the step
    # chose itself is read from this answer (serve/provenance.entry_for). --json is still accepted.
    print(json.dumps({**result, "type": "audio"}))


if __name__ == "__main__":
    main()
