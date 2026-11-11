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


def _heard(sidecar):
    """(the transcript's montaj.language marker or None, the language whisper heard or None)."""
    try:
        with open(sidecar, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return None, None
    block = doc.get("montaj") if isinstance(doc, dict) else None
    marker = block.get("language") if isinstance(block, dict) else None
    marker = marker if isinstance(marker, dict) else None
    heard = (marker or {}).get("heard") or ((doc.get("result") or {}).get("language") if isinstance(doc, dict) else None)
    return marker, (str(heard).strip() or None) if heard else None


def _fitting(sources, language, model):
    """The sidecars of `sources` ({sidecar: the source media}) whose language does not fit the caption `language`,
    judged on base codes. An explicit language: the sidecar's heard language must be it. Auto: a sidecar made with
    auto is used as is; one that recorded a detect is judged on it (detected must equal heard); any other (made
    before the marker, or forced to a language) is judged by ONE language detect of the sources that need it. A detect decides only when its clip held 5 s of voice and p was 0.9 (speech_runs.sure); a weaker one reuses the sidecar. A
    sidecar that says nothing of its language, a source with no voiced run and a detect that could not run are
    trusted: a guard never stops captions for an edge case."""
    from lib import speech_runs
    from lib.common import whisper_language
    want = (language or "auto").strip()
    base = lambda c: whisper_language(c) if c else None      # noqa: E731
    bad, need = [], {}
    for sc, media in sources.items():
        marker, heard = _heard(sc)
        if heard is None:
            continue
        if want.lower() != "auto":
            if base(heard) != base(want):
                bad.append(sc)
        elif marker and str(marker.get("asked") or "").lower() == "auto":
            continue
        elif marker and marker.get("detected"):
            if base(marker["detected"]) != base(heard) and speech_runs.sure(
                    (marker["detected"], float(marker.get("p") or 0), float(marker.get("voice_s") or 0))):
                bad.append(sc)
        else:
            need[sc] = (media, heard)
    if need:
        got = _detect([m for m, _ in need.values()], model)
        bad += [sc for sc, (media, heard) in need.items()
                if speech_runs.sure(got.get(media)) and base(got[media][0]) != base(heard)]
    return bad


def _model_path(model):
    from lib.common import DEFAULT_WHISPER_MODEL, require_whisper_model
    return require_whisper_model(model or DEFAULT_WHISPER_MODEL, "auto")[1]


def _detect(medias, model):
    from lib import speech_runs
    try:
        path = _model_path(model)
        return speech_runs.detect_languages_p(list(dict.fromkeys(medias)), path)
    except (Exception, SystemExit):
        return {}


def timeline_words(project, project_dir, keep_all=False, language="auto", model=None):
    """[{"text", "start", "end"}] in timeline seconds, in time order, from each audible speech source's own transcript
    (a word belongs to a segment when its middle is in the part it plays), or None when one has no transcript, or one
    is in another language than `language` (the caption language, "auto" to detect) and so counts as none: see
    `_fitting`. `model` is the whisper model a language detect uses."""
    from serve.caption_job import _audio_track_segments, _visual_segments
    audio = [t for t in ((project.get("audio") or {}).get("tracks") or [])
             if isinstance(t, dict) and (keep_all or t.get("type") not in NOT_SPEECH)]
    segments = _visual_segments(project) + _audio_track_segments({"audio": {"tracks": audio}})
    words, cache, sources, found = [], {}, {}, []
    for seg in segments:
        src = seg["src"] if os.path.isabs(seg["src"]) else os.path.join(project_dir, seg["src"])
        sc = _sidecar(src)
        if sc is None:
            return None
        found.append((seg, sc))
        sources.setdefault(sc, src)
    if _fitting(sources, language, model):
        return None
    for seg, sc in found:
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
