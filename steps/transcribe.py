#!/usr/bin/env python3
"""Transcribe audio/video using whisper.cpp. Outputs SRT and word-level JSON."""
import json, mimetypes, os, sys, tempfile, argparse
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
import models as _models
from common import fail, require_file, check_output, run, find_whisper_bin
from trim_spec import is_trim_spec, load as load_spec, audio_extract_cmd, remap_timestamp

def main():
    parser = argparse.ArgumentParser(description="Transcribe audio or video using whisper.cpp")
    parser.add_argument("--input", required=True, help="Audio or video file to transcribe")
    parser.add_argument("--out", help="Output file prefix (default: input without extension)")
    parser.add_argument("--model", default="base.en",
                        choices=["tiny.en", "base.en", "medium.en", "large"],
                        help="Whisper model. Larger = slower + more accurate.")
    parser.add_argument("--language", default="en", help="Language code (e.g. en, fr, de)")
    args = parser.parse_args()

    require_file(args.input)

    model_path = _models.model_path("whisper", f"ggml-{args.model}.bin")
    require_file(model_path)

    whisper_bin = find_whisper_bin()

    trim_spec_data = None
    if is_trim_spec(args.input):
        trim_spec_data = load_spec(args.input)
        source_path = trim_spec_data["input"]
        keeps = trim_spec_data["keeps"]
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        tmp_audio = tmp.name
        run(audio_extract_cmd(source_path, keeps, tmp_audio))
        audio_input = tmp_audio
        output_prefix = args.out or os.path.splitext(source_path)[0]
    else:
        source_path = args.input
        keeps = None
        tmp_audio = None
        audio_input = args.input
        mime = mimetypes.guess_type(args.input)[0] or ""
        if mime.startswith("video/"):
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp.close()
            tmp_audio = tmp.name
            run(["ffmpeg", "-y", "-i", args.input, "-vn", "-acodec", "pcm_s16le",
                 "-ar", "16000", "-ac", "1", tmp_audio])
            audio_input = tmp_audio
        output_prefix = args.out or os.path.splitext(args.input)[0]

    try:
        # SRT: segment-level (readable)
        run([whisper_bin, "-m", model_path, "-f", audio_input, "-l", args.language,
             "--output-srt", "--output-file", output_prefix])
        # JSON: word-level via --split-on-word --max-len 1 (canonical format for downstream steps)
        run([whisper_bin, "-m", model_path, "-f", audio_input, "-l", args.language,
             "--split-on-word", "--max-len", "1", "--output-json", "--output-file", output_prefix],
            check=False)
    finally:
        if tmp_audio and os.path.exists(tmp_audio):
            os.unlink(tmp_audio)

    if trim_spec_data is not None:
        words_path = f"{output_prefix}.json"
        if os.path.exists(words_path):
            data = json.loads(Path(words_path).read_text())
            for word in data.get("transcription", []):
                offsets = word.get("offsets", {})
                if "from" in offsets:
                    offsets["from"] = int(remap_timestamp(offsets["from"] / 1000.0, keeps) * 1000)
                if "to" in offsets:
                    offsets["to"] = int(remap_timestamp(offsets["to"] / 1000.0, keeps) * 1000)
            Path(words_path).write_text(json.dumps(data))

    srt_path = f"{output_prefix}.srt"
    words_path = f"{output_prefix}.json"
    check_output(srt_path)
    print(json.dumps({"srt": srt_path, "words": words_path}))

if __name__ == "__main__":
    main()
