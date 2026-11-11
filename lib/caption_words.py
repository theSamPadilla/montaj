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


def _fitting(sources, language, model, project_dir=None):
    """The sidecars of `sources` ({sidecar: the source media}) whose language does not fit the caption `language`,
    judged on base codes. An explicit language: the sidecar's heard language must be it. Auto: a sidecar made with
    auto is used as is; one that recorded a detect is judged on it (detected must equal heard); any other (made
    before the marker, or forced to a language) is judged by a language detect of the sources that need it
    (`_detect_need`). A detect decides only when its clip held 5 s of voice and p was 0.95 (speech_runs.sure); a
    weaker one reuses the sidecar. A sidecar that says nothing of its language, a source with no voiced run and a
    detect that could not run are trusted: a guard never stops captions for an edge case."""
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
        got = _detect_need(need, model, project_dir)
        bad += [sc for sc, (media, heard) in need.items()
                if speech_runs.sure(got.get(sc)) and base(got[sc][0]) != base(heard)]
    return bad


def _model_path(model):
    from lib.common import DEFAULT_WHISPER_MODEL, require_whisper_model
    return require_whisper_model(model or DEFAULT_WHISPER_MODEL, "auto")[1]


def transcript_runs(sidecar):
    """[(start, end)] seconds of speech in the transcript at `sidecar`: its montaj.runs when it was made by voiced
    runs, else its words grouped where the pause between two is under speech_energy's default (an older transcript).
    [] when it holds no word."""
    from lib import speech_energy, speech_runs
    runs = speech_runs.runs_of(sidecar)
    if runs:
        return runs
    try:
        words = load_words(sidecar)
    except (OSError, ValueError):
        return []
    out = []
    for w in words:
        if out and w.start - out[-1][1] < speech_energy.DEFAULT_MAX_PAUSE_S:
            out[-1] = (out[-1][0], max(out[-1][1], w.end))
        else:
            out.append((w.start, w.end))
    return out


_DETECT_CACHE = "language-detect.json"
_DETECT_CACHE_VERSION = "v2"


class _DetectCache:
    """The detects already made, in `<project>/.cache/language-detect.json` (the project's own hidden `.cache`, which
    its version history never adds: it commits project.json only). A source's key is its transcript's (path, mtime_ns,
    size) and the model, so a changed transcript or another model asks again; a pool's is its members' keys. Every
    read and write is best effort: a cache that cannot be had is no cache."""

    def __init__(self, project_dir):
        self.path = os.path.join(project_dir, ".cache", _DETECT_CACHE) if project_dir else None
        self.items, self.dirty = {}, False
        try:
            with open(self.path, encoding="utf-8") as f:
                doc = json.load(f)
            if doc.get("version") == _DETECT_CACHE_VERSION and isinstance(doc.get("items"), dict):
                self.items = doc["items"]
        except (OSError, ValueError, TypeError, AttributeError):
            pass

    @staticmethod
    def key(*parts):
        import hashlib
        return hashlib.sha1("\0".join(str(p) for p in (_DETECT_CACHE_VERSION, *parts)).encode()).hexdigest()

    def source_key(self, sidecar, model):
        try:
            st = os.stat(sidecar)
        except OSError:
            return None
        return self.key(os.path.abspath(sidecar), st.st_mtime_ns, st.st_size, os.path.basename(model or ""))

    def get(self, key):
        return self.items.get(key) if key else None

    def put(self, key, value):
        if key and value is not None:
            self.items[key] = value
            self.dirty = True

    def save(self):
        if not (self.path and self.dirty):
            return
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = f"{self.path}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"version": _DETECT_CACHE_VERSION, "items": self.items}, f)
            os.replace(tmp, self.path)
        except OSError:
            pass


def _detect_need(need, model, project_dir):
    """{sidecar: (code, p, voice_s) or None} for each of `need` ({sidecar: (media, heard)}): the language heard in the
    seconds of speech its own transcript names (`transcript_runs`; only those seconds are decoded), cached per
    transcript. Sources with 5 s of voice or more are each detected, in ONE whisper call. The rest are too short to
    decide alone (per-line voiceovers of 2 to 4 s): those whose transcripts agree on a language are pooled into ONE
    clip and ONE detect, whose answer is each one's. Pooling mixes sources, so a pool that disagrees with a source
    that is really in another language would send it to the mix: sources transcribed in different languages are
    never pooled together. Never fails: what cannot be detected is None, and trusted."""
    from lib import speech_runs
    from lib.common import whisper_language
    out = {sc: None for sc in need}
    try:
        cache = _DetectCache(project_dir)
        singles, groups, voices = {}, {}, {}
        for sc, (media, heard) in need.items():
            runs = transcript_runs(sc)
            if not runs:
                continue
            key = cache.source_key(sc, model)
            hit = cache.get(key)
            if isinstance(hit, list) and len(hit) == 3:
                out[sc] = tuple(hit)
            elif speech_runs._detect_spans(runs)[1] >= speech_runs.DETECT_MIN_VOICE_S:
                singles[sc] = (media, runs, key)
            else:
                groups.setdefault(whisper_language(heard), {})[sc] = (media, runs, key)
                voices[sc] = speech_runs._detect_spans(runs)[1]
        for lang, g in list(groups.items()):
            if sum(voices[sc] for sc in g) < speech_runs.DETECT_MIN_VOICE_S:
                del groups[lang]                 # even together they are too short to decide: no detect
                continue
            gkey = cache.key("pool", *sorted(k or "" for _, _, k in g.values())) if len(g) > 1 else None
            hit = cache.get(gkey)
            if isinstance(hit, dict):
                for sc, (_, _, k) in g.items():
                    if isinstance(hit.get(k), list) and len(hit[k]) == 3:
                        out[sc] = tuple(hit[k])
                del groups[lang]
        if singles or any(len(g) > 1 for g in groups.values()):
            path = _model_path(model)
            if singles:
                got = speech_runs.detect_languages_p(
                    list(dict.fromkeys(m for m, _, _ in singles.values())), path,
                    runs_for={m: r for m, r, _ in singles.values()})
                for sc, (media, _, key) in singles.items():
                    out[sc] = got.get(media)
                    cache.put(key, list(out[sc]) if out[sc] else None)
            for g in groups.values():
                if len(g) < 2:
                    continue
                got = speech_runs.detect_languages_p(
                    [m for m, _, _ in g.values()], path, runs_for={m: r for m, r, _ in g.values()}, pool=True)
                members = {}
                for sc, (media, _, key) in g.items():
                    out[sc] = got.get(media)
                    if out[sc]:
                        members[key] = list(out[sc])
                cache.put(cache.key("pool", *sorted(k or "" for _, _, k in g.values())), members or None)
        cache.save()
    except (Exception, SystemExit):
        pass
    return out


class Words(list):
    """timeline_words' answer: the words, and `language` the base language every transcript it came from is in (None
    when they differ or one does not say)."""
    language = None


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
    if _fitting(sources, language, model, project_dir):
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
    out = Words(words)
    from lib.common import whisper_language
    heards = [_heard(sc)[1] for sc in sources]
    langs = {whisper_language(h) for h in heards if h}
    if heards and all(heards) and len(langs) == 1:
        out.language = langs.pop()
    return out


def write_transcript(words, path):
    """`words` as a whisper.cpp JSON transcript (offsets in ms) at `path`, the shape caption.py and the script spelling
    read; marked as made from the sources. When `words` (timeline_words') say the language every source is in, it is
    `result.language`, where the caption track's language is read from."""
    doc = {"transcription": [{"text": f" {w['text']}", "offsets": {"from": int(round(w["start"] * 1000)),
                                                                 "to": int(round(w["end"] * 1000))}}
                             for w in words],
           "montaj": {"input": "timeline", "from": "source transcripts", "offsets": "timeline"}}
    if getattr(words, "language", None):
        doc["result"] = {"language": words.language}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f)
