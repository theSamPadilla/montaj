"""Caption words from the transcripts the timeline already has (run 5).

The captions of kung fu run 5 led the speech, more and more within each clip (+1.63 s at 18.9 s): generate_captions
transcribed the timeline's mix again and fitted its words to pauses found on that mix (transcribe --fit-pauses), and on a
mix of clips at different levels quiet speech reads as pause, so the words were squeezed early. montaj's own per-source
transcripts (made by voiced runs, PL89 A1), which the cut itself was made on, were right. So the words are each audible
clip's and voiceover's own transcript, mapped through the timeline the way the mix places their audio (serve.caption_job's
segments: in point, start, speed); music and sfx are never captioned. When an audible clip or voiceover has no
transcript, there is nothing to map and the caller transcribes the mix.
"""
import json
import os

from lib.speech_lines import _sidecar_has_transcription, load_words, sidecar_for

NOT_SPEECH = ("music", "sfx")


def _sidecar(src):
    """The transcript of `src`, or of the original a normalized copy was made from."""
    found = sidecar_for({"src": src})
    if found:
        return found
    from serve.caption_job import _stem      # a normalized master's original stem
    p = _stem(src) + ".json"
    return p if _sidecar_has_transcription(p) else None


def timeline_words(project, project_dir):
    """[{"text", "start", "end"}] in timeline seconds, in time order, from each audible speech source's own transcript
    (a word belongs to a segment when its middle is in the part it plays), or None when one has no transcript."""
    from serve.caption_job import _audio_track_segments, _visual_segments
    audio = [t for t in ((project.get("audio") or {}).get("tracks") or [])
             if isinstance(t, dict) and t.get("type") not in NOT_SPEECH]
    segments = _visual_segments(project) + _audio_track_segments({"audio": {"tracks": audio}})
    words, cache = [], {}
    for seg in segments:
        src = seg["src"] if os.path.isabs(seg["src"]) else os.path.join(project_dir, seg["src"])
        sc = _sidecar(src)
        if sc is None:
            return None
        if sc not in cache:
            try:
                cache[sc] = load_words(sc)
            except (OSError, ValueError):
                return None
        speed = seg.get("speed", 1.0) or 1.0
        end = seg["start"] + (seg["out"] - seg["in"]) / speed
        for w in cache[sc]:
            if seg["in"] <= (w.start + w.end) / 2 < seg["out"]:
                t0 = seg["start"] + (w.start - seg["in"]) / speed
                t1 = min(seg["start"] + (w.end - seg["in"]) / speed, end)
                words.append({"text": w.text.strip(), "start": max(t0, seg["start"]), "end": max(t1, t0)})
    words.sort(key=lambda w: w["start"])
    return words


def write_transcript(words, path):
    """`words` as a whisper.cpp JSON transcript (offsets in ms) at `path`, the shape caption.py and the script spelling
    read; marked as made from the sources."""
    doc = {"transcription": [{"text": f" {w['text']}", "offsets": {"from": int(round(w["start"] * 1000)),
                                                                 "to": int(round(w["end"] * 1000))}}
                             for w in words],
           "montaj": {"input": "timeline", "from": "source transcripts", "offsets": "timeline"}}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f)
