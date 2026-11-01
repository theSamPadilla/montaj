#!/usr/bin/env python3
"""Generate a music clip from a text prompt via Gemini Lyria 3 or ElevenLabs.

Generation step — produces a file on disk and prints JSON metadata. ffmpeg runs
only to trim a track the vendor returned longer than --duration.
"""
import argparse, json, os, subprocess, sys

# File lives at steps/<category>/<name>.py — reach lib/ and project root
# by going up two levels.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import fail, get_duration, ffmpeg_bin, ffmpeg_error_tail, ffprobe_value, ff_path
from connectors import ConnectorError
from connectors.gemini import DEFAULT_MUSIC_MODEL, invalid_api_key_message
from _fail_reasons import fail_for


FADE_MAX_S = 1.5
TRIM_TIMEOUT_S = 120   # a re-encode of a few minutes of audio takes seconds; a hung ffmpeg must not hang the step
SLACK_S = 0.1          # a vendor track within this of the ask is not worth an encode
# Source codec -> (encoder args). Trimming needs one encode; the codec family is
# kept so the file still matches its extension.
ENCODERS = {
    "mp3":       ["-c:a", "libmp3lame", "-q:a", "2"],
    "aac":       ["-c:a", "aac", "-b:a", "192k"],
    "vorbis":    ["-c:a", "libvorbis", "-q:a", "6"],
    "opus":      ["-c:a", "libopus", "-b:a", "160k"],
    "flac":      ["-c:a", "flac"],
    "pcm_s16le": ["-c:a", "pcm_s16le"],
}


def trim_to(path, duration):
    """Cut `path` to `duration` s with a short fade-out, re-encoding in the same
    codec family. Returns (codec, None) on success, (None, note) when it kept the
    vendor file (unknown codec or encode failure) — a trim is never a refusal."""
    codec = ffprobe_value(path, "stream=codec_name", "a:0")
    enc = ENCODERS.get(codec)
    if enc is None:
        return None, f"kept the vendor's {codec} track untrimmed (no matching encoder)"
    fade = min(FADE_MAX_S, 0.1 * duration)
    path = ff_path(path)
    tmp = path + ".trim" + os.path.splitext(path)[1]
    cmd = [ffmpeg_bin(), "-nostdin", "-v", "error", "-y", "-i", path, "-vn", "-t", f"{duration:.3f}",
           "-af", f"afade=t=out:st={duration - fade:.3f}:d={fade:.3f}", *enc, tmp]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=TRIM_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        if os.path.exists(tmp):
            os.remove(tmp)
        return None, f"kept the vendor track untrimmed: the trim took over {TRIM_TIMEOUT_S} s"
    if r.returncode != 0:
        if os.path.exists(tmp):
            os.remove(tmp)
        return None, "kept the vendor track untrimmed: " + ffmpeg_error_tail(r.stderr)
    os.replace(tmp, path)
    return codec, None


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
                        "Gemini's longer track is trimmed to it with a fade-out.")
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

    vendor_seconds = duration = get_duration(path)
    trimmed, note = None, None
    if args.vendor == "gemini" and args.duration is not None and args.duration > 0:
        if duration > args.duration + SLACK_S:
            trimmed, note = trim_to(path, args.duration)
            if trimmed:
                duration = get_duration(path)
        elif duration < args.duration - SLACK_S:
            note = f"vendor returned {duration:.1f}s, shorter than the {args.duration:g}s asked; kept as is"

    result = {
        "path": path,
        "duration_seconds": duration,
        "seconds": duration,
        "vendorSeconds": vendor_seconds,
        "trimmed": trimmed is not None,
        "trimCodec": trimmed,
        "note": note,
        "vendor": args.vendor,
        "model": model,
        # Gemini's --with-vocals actually controls this; ElevenLabs takes no
        # such flag and nothing forces instrumental-only output there, so
        # reporting True for it would claim a guarantee that doesn't exist.
        "instrumental": (not args.with_vocals) if args.vendor == "gemini" else None,
    }

    if args.json:
        print(json.dumps(result))
    else:
        print(path)


if __name__ == "__main__":
    main()
