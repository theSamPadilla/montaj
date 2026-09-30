#!/usr/bin/env python3
"""Separate an audio/video file into stems (vocals, drums, bass, other) using Demucs.
Outputs a JSON with paths to each separated stem file.
"""
import json, os, subprocess, sys, argparse
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, ffmpeg_bin, ffprobe_bin


STEM_NAMES = ["vocals", "drums", "bass", "other"]
DEFAULT_MODEL = "htdemucs"


def _channel_count(path):
    r = subprocess.run([ffprobe_bin(), "-v", "error", "-select_streams", "a:0",
                        "-show_entries", "stream=channels", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    try:
        return int(r.stdout.strip().split(",")[0])
    except ValueError:
        return 2


def _decode(np, path, sr):
    """Decode to (2, n) float32 at sr via ffmpeg. Mono is copied to both
    channels at full level (-ac 2 would upmix at -3 dB). Stereo is unchanged; surround
    gets ffmpeg's stereo downmix, which keeps the centre. Audio and video
    inputs both decode here."""
    mix = (["-af", "pan=stereo|c0=c0|c1=c0"] if _channel_count(path) == 1
           else ["-ac", "2"])
    r = subprocess.run([ffmpeg_bin(), "-v", "error", "-i", path, "-map", "0:a:0",
                        "-f", "f32le", "-ar", str(sr), *mix, "-"], capture_output=True)
    if r.returncode != 0:
        fail("decode_failed", r.stderr.decode(errors="replace").strip()[-500:])
    return np.frombuffer(r.stdout, "<f4").reshape(-1, 2).T.copy()


def _encode(np, samples, sr, out_path):
    """Write (2, n) float32 as pcm_f32le WAV via ffmpeg."""
    data = np.ascontiguousarray(samples.T, dtype="<f4").tobytes()
    r = subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-f", "f32le", "-ac", "2",
                        "-ar", str(sr), "-i", "-", "-c:a", "pcm_f32le", out_path],
                       input=data, capture_output=True)
    if r.returncode != 0:
        fail("encode_failed", r.stderr.decode(errors="replace").strip()[-500:])


def separate(audio_path, stems_requested, model_name, out_dir):
    """Run Demucs separation. Returns {stem_name: path} for each requested stem."""
    try:
        import numpy as np
        import torch
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
    except ImportError as e:
        fail("missing_dependency",
             f"stem_separation needs {e.name or e}. Run: montaj install demucs")

    if torch.backends.mps.is_available():
        device = torch.device("mps")
    elif torch.cuda.is_available():
        device = torch.device("cuda")
    else:
        device = torch.device("cpu")

    model = get_model(model_name)
    model.eval()
    model.to(device)

    wav = torch.from_numpy(_decode(np, audio_path, model.samplerate))
    wav = wav.unsqueeze(0).to(device)

    with torch.no_grad():
        sources = apply_model(model, wav, progress=True)

    sources = sources[0]  # (num_sources, channels, samples)

    os.makedirs(out_dir, exist_ok=True)
    result = {}
    for i, name in enumerate(model.sources):
        if stems_requested != ["all"] and name not in stems_requested:
            continue
        out_path = os.path.join(out_dir, f"{name}.wav")
        _encode(np, sources[i].cpu().numpy(), model.samplerate, out_path)
        result[name] = out_path

    return result


def main():
    parser = argparse.ArgumentParser(
        description="Separate audio into stems (vocals, drums, bass, other) using Demucs.")
    parser.add_argument("--input",   required=True, help="Audio or video file")
    parser.add_argument("--stems",   default="all",
                        help="Comma-separated stems to output: vocals,drums,bass,other or 'all' (default: all)")
    parser.add_argument("--model",   default=DEFAULT_MODEL,
                        choices=["htdemucs", "htdemucs_ft", "mdx_extra"],
                        help="Demucs model (default: htdemucs)")
    parser.add_argument("--out-dir", help="Directory for stem WAV files (default: <input>_stems/)")
    parser.add_argument("--out",     help="Output JSON path (default: <input>_stems.json)")
    args = parser.parse_args()

    require_file(args.input)

    stems_requested = ["all"] if args.stems == "all" else [s.strip() for s in args.stems.split(",")]
    invalid = [s for s in stems_requested if s != "all" and s not in STEM_NAMES]
    if invalid:
        fail("invalid_stems", f"Unknown stems: {invalid}. Valid: {STEM_NAMES}")

    base = os.path.splitext(args.input)[0]
    out_dir  = args.out_dir or f"{base}_stems"
    out_json = args.out     or f"{base}_stems.json"

    stem_paths = separate(args.input, stems_requested, args.model, out_dir)

    if not stem_paths:
        fail("no_stems", "No stems were produced")

    with open(out_json, "w") as f:
        json.dump(stem_paths, f, indent=2)

    check_output(out_json)
    print(out_json)


if __name__ == "__main__":
    main()
