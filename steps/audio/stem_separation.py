#!/usr/bin/env python3
"""Separate an audio/video file into stems (vocals, drums, bass, other) using Demucs.
Outputs a JSON with paths to each separated stem file.
"""
import json, mimetypes, os, sys, tempfile, argparse
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run


STEM_NAMES = ["vocals", "drums", "bass", "other"]
DEFAULT_MODEL = "htdemucs"


def separate(audio_path, stems_requested, model_name, out_dir):
    """Run Demucs separation. Returns {stem_name: path} for each requested stem."""
    try:
        import torch
        import torchaudio
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
    except ImportError:
        fail("missing_dependency",
             "demucs not installed. Run: montaj install demucs")

    if torch.backends.mps.is_available():
        device = torch.device("mps")
    elif torch.cuda.is_available():
        device = torch.device("cuda")
    else:
        device = torch.device("cpu")

    model = get_model(model_name)
    model.eval()
    model.to(device)

    wav, sr = torchaudio.load(audio_path)
    if sr != model.samplerate:
        wav = torchaudio.functional.resample(wav, sr, model.samplerate)
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
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
        torchaudio.save(out_path, sources[i].cpu(), model.samplerate)
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

    # Convert video → wav if needed
    mime      = mimetypes.guess_type(args.input)[0] or ""
    tmp_audio = None
    audio_in  = args.input
    if mime.startswith("video/"):
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        tmp_audio = tmp.name
        run(["ffmpeg", "-y", "-i", args.input, "-vn", "-acodec", "pcm_s16le",
             "-ar", "44100", "-ac", "2", tmp_audio])
        audio_in = tmp_audio

    try:
        stem_paths = separate(audio_in, stems_requested, args.model, out_dir)
    finally:
        if tmp_audio and os.path.exists(tmp_audio):
            os.unlink(tmp_audio)

    if not stem_paths:
        fail("no_stems", "No stems were produced")

    with open(out_json, "w") as f:
        json.dump(stem_paths, f, indent=2)

    check_output(out_json)
    print(out_json)


if __name__ == "__main__":
    main()
