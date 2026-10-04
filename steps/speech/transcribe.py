#!/usr/bin/env python3
"""Transcribe audio/video using whisper.cpp. Outputs SRT and word-level JSON."""
import json, mimetypes, os, sys, tempfile, argparse
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail, require_file, check_output, run, run_whisper, find_whisper_bin, require_whisper_model, ffmpeg_bin, DEFAULT_WHISPER_MODEL, WHISPER_MODEL_CHOICES
from trim_spec import is_trim_spec, load as load_spec, extract_audio_at_keeps, remap_timestamp

def speech_stats(data):
    """word_count, speech_s and wpm from a words JSON, by the rule profiles/analyze.py uses.

    A word is an entry whose text has a letter or digit. speech_s runs from the first
    counted word's start to the last one's end; wpm is 0 when that span is 0.
    """
    words = [w for w in (data or {}).get("transcription", [])
             if any(ch.isalnum() for ch in (w.get("text") or ""))]
    if not words:
        return {"word_count": 0, "speech_s": 0.0, "wpm": 0}
    start = words[0].get("offsets", {}).get("from", 0) / 1000.0
    end = words[-1].get("offsets", {}).get("to", 0) / 1000.0
    span = max(end - start, 0.0)
    wpm = round(len(words) / (span / 60), 1) if span > 0 else 0
    return {"word_count": len(words), "speech_s": round(span, 3), "wpm": wpm}


def _srt_ts(ms):
    return f"{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}"


def main():
    parser = argparse.ArgumentParser(description="Transcribe audio or video using whisper.cpp")
    parser.add_argument("--input", required=True, help="Audio or video file to transcribe")
    parser.add_argument("--out", help="Output file prefix (default: input without extension)")
    parser.add_argument("--model", default=DEFAULT_WHISPER_MODEL,
                        choices=list(WHISPER_MODEL_CHOICES),
                        help="Whisper model. Larger = slower + more accurate. "
                             "English-only (*.en) models are auto-upgraded to a multilingual "
                             "sibling when --language is non-English.")
    parser.add_argument("--language", default="en", help="Language code (e.g. en, fr, de), or 'auto' for whisper-cli language auto-detection")
    parser.add_argument("--max-context", type=int, default=None,
                        help="Cap on prior-text tokens carried between windows (whisper.cpp -mc). "
                             "Set to 0 to disable cross-window context — the reliable fix for the "
                             "repetition-loop hallucination (one phrase repeated to EOF) that whisper "
                             "can fall into on long audio, especially non-English. Unset = whisper default.")
    args = parser.parse_args()

    require_file(args.input)

    # Managed dir first, then the legacy whisper.cpp dir for older installs —
    # same chain as lib/common.transcribe_words(). No weight: whisper_model_missing.
    _, model_path = require_whisper_model(args.model, args.language)

    whisper_bin = find_whisper_bin()

    trim_spec_data = None
    if is_trim_spec(args.input):
        trim_spec_data = load_spec(args.input)
        source_path = trim_spec_data["input"]
        keeps = trim_spec_data["keeps"]
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        tmp_audio = tmp.name
        extract_audio_at_keeps(source_path, keeps, tmp_audio)
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
            run([ffmpeg_bin(), "-y", "-i", args.input, "-vn", "-acodec", "pcm_s16le",
                 "-ar", "16000", "-ac", "1", tmp_audio])
            audio_input = tmp_audio
        output_prefix = args.out or os.path.splitext(args.input)[0]

    try:
        # Single pass: word-level JSON + SRT in one decode
        whisper_cmd = [whisper_bin, "-m", model_path, "-f", audio_input, "-l", args.language,
                       "--split-on-word", "--max-len", "1", "--output-srt", "--output-json",
                       "--output-file", output_prefix]
        if args.max_context is not None:
            whisper_cmd += ["-mc", str(args.max_context)]
        run_whisper(whisper_cmd, audio_input, check=True)
    finally:
        if tmp_audio and os.path.exists(tmp_audio):
            os.unlink(tmp_audio)

    words_path = f"{output_prefix}.json"
    if os.path.exists(words_path):
        data = json.loads(Path(words_path).read_text())
        if trim_spec_data is not None:
            for word in data.get("transcription", []):
                offsets = word.get("offsets", {})
                if "from" in offsets:
                    offsets["from"] = int(remap_timestamp(offsets["from"] / 1000.0, keeps) * 1000)
                if "to" in offsets:
                    offsets["to"] = int(remap_timestamp(offsets["to"] / 1000.0, keeps) * 1000)
                if "from" in offsets and "to" in offsets:
                    word["timestamps"] = {"from": _srt_ts(offsets["from"]), "to": _srt_ts(offsets["to"])}
            # The .srt is left in the spec's own time (keeps back to back).
            data["montaj"] = {"input": "spec", "spec": os.path.abspath(args.input), "keeps": keeps,
                              "offsets": "source", "timestamps": "source", "srt": "spec"}
        else:
            data["montaj"] = {"input": "file", "offsets": "source",
                              "timestamps": "source", "srt": "source"}
        Path(words_path).write_text(json.dumps(data))

    srt_path = f"{output_prefix}.srt"
    words_path = f"{output_prefix}.json"
    check_output(srt_path)
    result = {"srt": srt_path, "words": words_path}
    try:
        result.update(speech_stats(json.loads(Path(words_path).read_text())))
    except Exception:
        pass  # an unreadable words file leaves the stats out; it never fails the step
    print(json.dumps(result))

if __name__ == "__main__":
    main()
