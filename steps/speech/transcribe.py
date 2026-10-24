#!/usr/bin/env python3
"""Transcribe audio/video using whisper.cpp. Outputs SRT and word-level JSON."""
import json, mimetypes, os, sys, tempfile, argparse
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from common import fail, require_file, check_output, run, run_whisper, find_whisper_bin, require_whisper_model, ffmpeg_bin, get_duration, DEFAULT_WHISPER_MODEL, WHISPER_MODEL_CHOICES, ff_input
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


def _write_srt(entries, path):
    """One cue per word, from whisper `transcription` entries (offsets in ms)."""
    cues = [e for e in entries if (e.get("text") or "").strip()
            and "from" in e.get("offsets", {}) and "to" in e.get("offsets", {})]
    Path(path).write_text("".join(
        f"{n}\n{_srt_ts(e['offsets']['from'])} --> {_srt_ts(e['offsets']['to'])}\n{e['text'].strip()}\n\n"
        for n, e in enumerate(cues, 1)))


def transcribe(input_path, out=None, model=DEFAULT_WHISPER_MODEL, language="en", max_context=None, fit_pauses=False):
    """Transcribe one file (or trim spec) and write `<out>.srt` and `<out>.json` (default: beside the
    input). Returns {srt, words} plus the speech stats. cut calls this for an untranscribed clip."""

    require_file(input_path)

    # Managed dir first, then the legacy whisper.cpp dir for older installs —
    # same chain as lib/common.transcribe_words(). No weight: whisper_model_missing.
    _, model_path = require_whisper_model(model, language)

    whisper_bin = find_whisper_bin()

    trim_spec_data = None
    if is_trim_spec(input_path):
        trim_spec_data = load_spec(input_path)
        source_path = trim_spec_data["input"]
        keeps = trim_spec_data["keeps"]
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        tmp_audio = tmp.name
        extract_audio_at_keeps(source_path, keeps, tmp_audio)
        audio_input = tmp_audio
        output_prefix = out or os.path.splitext(source_path)[0]
    else:
        source_path = input_path
        keeps = None
        tmp_audio = None
        audio_input = input_path
        mime = mimetypes.guess_type(input_path)[0] or ""
        if mime.startswith("video/"):
            tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            tmp.close()
            tmp_audio = tmp.name
            run([ffmpeg_bin(), "-y", "-i", ff_input(input_path), "-vn", "-acodec", "pcm_s16le",
                 "-ar", "16000", "-ac", "1", tmp_audio])
            audio_input = tmp_audio
        output_prefix = out or os.path.splitext(input_path)[0]

    pauses = heard_s = None
    try:
        # Single pass: word-level JSON + SRT in one decode
        whisper_cmd = [whisper_bin, "-m", model_path, "-f", audio_input, "-l", language,
                       "--split-on-word", "--max-len", "1", "--output-srt", "--output-json",
                       "--output-file", output_prefix]
        if max_context is not None:
            whisper_cmd += ["-mc", str(max_context)]
        run_whisper(whisper_cmd, audio_input, check=True)
        # Measured on the audio whisper heard, so in its time base (the spec's, for a trim spec).
        if fit_pauses:
            from lib.caption_timing import caption_pauses
            from lib.speech_pauses import silences
            heard_s = get_duration(audio_input)
            pauses = caption_pauses(silences(audio_input), heard_s)
    finally:
        if tmp_audio and os.path.exists(tmp_audio):
            os.unlink(tmp_audio)

    words_path = f"{output_prefix}.json"
    if os.path.exists(words_path):
        data = json.loads(Path(words_path).read_text())
        if pauses is not None:
            from lib.caption_timing import fit_transcription
            data["transcription"] = fit_transcription(data.get("transcription", []), pauses, heard_s)
            _write_srt(data["transcription"], f"{output_prefix}.srt")  # still in whisper's time base
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
            data["montaj"] = {"input": "spec", "spec": os.path.abspath(input_path), "keeps": keeps,
                              "offsets": "source", "timestamps": "source", "srt": "spec"}
        else:
            data["montaj"] = {"input": "file", "offsets": "source",
                              "timestamps": "source", "srt": "source"}
        if pauses is not None:
            data["montaj"]["fit_pauses"] = True
            if trim_spec_data is None:
                for word in data.get("transcription", []):
                    o = word.get("offsets", {})
                    if "from" in o and "to" in o:
                        word["timestamps"] = {"from": _srt_ts(o["from"]), "to": _srt_ts(o["to"])}
        Path(words_path).write_text(json.dumps(data))

    srt_path = f"{output_prefix}.srt"
    words_path = f"{output_prefix}.json"
    check_output(srt_path)
    result = {"srt": srt_path, "words": words_path}
    try:
        result.update(speech_stats(json.loads(Path(words_path).read_text())))
    except Exception:
        pass  # an unreadable words file leaves the stats out; it never fails the step
    return result


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
    parser.add_argument("--fit-pauses", action="store_true",
                        help="For captions: fit word times to the pauses measured in the audio, so a word "
                             "after a pause starts on the voice. Leave it off for anything that cuts on word times.")
    args = parser.parse_args()
    result = transcribe(args.input, args.out, args.model, args.language, args.max_context, args.fit_pauses)
    print(json.dumps(result))

if __name__ == "__main__":
    main()
