"""Caption translations: a second (third, ...) caption row in another language.

A translation is a row of segments marked as one: each carries `lang` (e.g.
"es") and `translationOf` (the ids of the source segments it translates) and
no `words`. Both rows are cut at the same phrase boundaries, so a translated
line is on screen exactly while its source phrase is, and the caption
templates draw it as a plain line stacked under its source (`captionGroups`,
duplicated in each of montaj_assets/render/templates/captions/*.jsx).

The source row is every segment that is not a translation and sits in row 0
(`lane` absent or 0). Its words keep their real timings: translating only
re-cuts the source row at the phrase boundaries the translation asks for.

Pure functions over plain dicts: nothing here reads or writes a project file.
The SSE caption route and the generate_captions step both finish a fresh
track through `finish_regenerated_track`; the translation route calls
`apply_translation`.
"""
import difflib
import json
import math
import re
import unicodedata

PHRASE_MAX_WORDS = 14
# Regeneration finds a kept phrase again in the new transcript when at least
# this share of its words is there, in order.
MATCH_SHARE = 0.6
TRANSLATION_MAX_CHARS = 90
_LANG_RE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$")
_TOKEN_STRIP_RE = re.compile(r"[\W_]+", re.UNICODE)


class TranslationError(ValueError):
    """A request this module refuses. `code` is stable; `message` is for people."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def is_translation(seg) -> bool:
    return isinstance(seg, dict) and isinstance(seg.get("lang"), str) and isinstance(seg.get("translationOf"), list)


def _lane(seg) -> int:
    lane = seg.get("lane")
    return lane if isinstance(lane, int) and not isinstance(lane, bool) and lane > 0 else 0


def merge_caption_theme(prev, track: dict) -> dict:
    """Carry forward every prior caption-track key the pipeline didn't just
    regenerate. `style` is resolved by the caller and `segments` are the
    regeneration itself; a value already on `track` wins. Mutates and returns
    `track`. (Moved here from serve/routes/projects.py so the
    generate_captions step merges exactly like the SSE route.)
    """
    for k, v in (prev or {}).items():
        if k not in ("style", "segments") and k not in track:
            track[k] = v
    return track


def mint_ids(segments: list, taken=()) -> list:
    """Give every segment without an id a `cap-<n>` id, minted against the ids
    already in use in `segments` and in `taken`: the editor's backfill scheme
    (backfillCaptionIds in montaj_assets/editor/src/video/VideoEditor.tsx).
    Returns a new list; a segment that already has an id is returned as is.
    """
    used = set(taken) | {s["id"] for s in segments if isinstance(s.get("id"), str) and s["id"]}
    counter = 0
    out = []
    for seg in segments:
        if isinstance(seg.get("id"), str) and seg["id"]:
            out.append(seg)
            continue
        while f"cap-{counter}" in used:
            counter += 1
        new_id = f"cap-{counter}"
        used.add(new_id)
        out.append({**seg, "id": new_id})
    return out


def _ids(segments: list) -> set:
    return {s["id"] for s in segments if isinstance(s.get("id"), str) and s["id"]}


def _token(word: str) -> str:
    # NFKC first, so an AI's decomposed "café" matches the transcript's composed one.
    return _TOKEN_STRIP_RE.sub("", unicodedata.normalize("NFKC", word).casefold())


def _split_rows(segments: list):
    """(source, translations, others): row 0's own segments, every translation,
    and every other hand-made row (kept as is)."""
    source, translations, others = [], [], []
    for seg in segments:
        if is_translation(seg):
            translations.append(seg)
        elif _lane(seg) == 0:
            source.append(seg)
        else:
            others.append(seg)
    source.sort(key=lambda s: s.get("start", 0))
    return source, translations, others


def _source_words(source: list) -> list:
    """Every word of the source row in time order, each tagged with the index
    of the segment it came from."""
    words = []
    for i, seg in enumerate(source):
        ws = seg.get("words")
        if not isinstance(ws, list) or not ws:
            raise TranslationError(
                "no_word_timings",
                "The captions have a line without word timings. Generate the captions again, then translate.",
            )
        for w in ws:
            words.append({**w, "_seg": i})
    return words


def _carried_fields(seg: dict) -> dict:
    """A source segment's own styling and position, carried onto the segment
    re-cut from it."""
    return {k: v for k, v in seg.items() if k not in ("id", "text", "start", "end", "words", "lane")}


def _segment_from_words(words: list, base: dict, seg_id) -> dict:
    out = {**base}
    if seg_id:
        out["id"] = seg_id
    out["text"] = " ".join(w["word"] for w in words)
    out["start"] = words[0]["start"]
    out["end"] = words[-1]["end"]
    out["words"] = [{k: v for k, v in w.items() if k != "_seg"} for w in words]
    return out


def _compact_lanes(segments: list) -> list:
    """Rows stay dense from 0, as the editor keeps them (normalizeCaptionLanes)."""
    lanes = sorted({_lane(s) for s in segments})
    remap = {lane: i for i, lane in enumerate(lanes)}
    out = []
    for seg in segments:
        lane = remap[_lane(seg)]
        seg = {k: v for k, v in seg.items() if k != "lane"}
        if lane:
            seg["lane"] = lane
        out.append(seg)
    return out


def _match_phrases(words: list, phrases: list) -> list:
    """Split `words` into one run per phrase, in order, by matching each
    phrase's source text word for word. Every word must be covered."""
    tokens = [(_token(w["word"]), w) for w in words]
    pos = 0
    runs = []
    for n, phrase in enumerate(phrases, start=1):
        wanted = [t for t in (_token(x) for x in phrase["source"].split()) if t]
        if not wanted:
            raise TranslationError("bad_phrases", f"Phrase {n} has no source words.")
        run = []
        for want in wanted:
            while pos < len(tokens) and not tokens[pos][0]:
                run.append(tokens[pos][1])
                pos += 1
            if pos >= len(tokens) or tokens[pos][0] != want:
                got = " ".join(w["word"] for _, w in tokens[pos:pos + len(wanted)]) or "the end of the captions"
                raise TranslationError(
                    "phrase_mismatch",
                    f'Phrase {n} ("{phrase["source"]}") does not match the captions here: "{got}". '
                    "Copy the source words from get_project, in order.",
                )
            run.append(tokens[pos][1])
            pos += 1
        # A punctuation-only word right after the phrase ("—", "…") ends it,
        # rather than opening the next line.
        while pos < len(tokens) and not tokens[pos][0]:
            run.append(tokens[pos][1])
            pos += 1
        if len([w for w in run if _token(w["word"])]) > PHRASE_MAX_WORDS:
            raise TranslationError(
                "phrase_too_long",
                f"Phrase {n} has more than {PHRASE_MAX_WORDS} words. Split it.",
            )
        runs.append(run)
    while pos < len(tokens) and not tokens[pos][0]:
        runs[-1].append(tokens[pos][1])
        pos += 1
    if pos < len(tokens):
        rest = " ".join(w["word"] for _, w in tokens[pos:pos + 8])
        raise TranslationError(
            "incomplete",
            f'The phrases stop before the captions do. Next words: "{rest}". Translate every line.',
        )
    return runs


def apply_translation(captions, lang, phrases) -> dict:
    """Write (or replace, or with no phrases remove) the `lang` row.

    `phrases` is a list of {"source": the source words of the phrase, in
    order, "text": the translated line}. The phrases must cover the source
    row's words in order. Returns new captions; never mutates the input.
    """
    if not isinstance(lang, str) or len(lang) > 35 or not _LANG_RE.match(lang):
        raise TranslationError("bad_lang", 'lang must be a language code such as "es" or "pt-BR".')
    if not isinstance(phrases, list):
        raise TranslationError("bad_phrases", "phrases must be a list.")
    if not isinstance(captions, dict) or not isinstance(captions.get("segments"), list) or not captions["segments"]:
        raise TranslationError("no_captions", "The project has no captions yet. Generate them first.")

    segments = [s for s in captions["segments"] if isinstance(s, dict)]
    source, translations, others = _split_rows(segments)
    other_langs = [t for t in translations if t.get("lang") != lang]
    replaced = [t for t in translations if t.get("lang") == lang]

    if not phrases:
        return {**captions, "segments": _compact_lanes(mint_ids(source, _ids(others + other_langs)) + others + other_langs)}

    for n, p in enumerate(phrases, start=1):
        if not isinstance(p, dict) or not isinstance(p.get("source"), str) or not isinstance(p.get("text"), str):
            raise TranslationError("bad_phrases", f"Phrase {n} needs source and text, both text.")
        text = " ".join(p["text"].split())
        if not text:
            raise TranslationError("bad_phrases", f"Phrase {n} has an empty translation.")
        if len(text) > TRANSLATION_MAX_CHARS:
            raise TranslationError(
                "text_too_long",
                f"Phrase {n}'s translation is over {TRANSLATION_MAX_CHARS} characters. Split the phrase.",
            )
    if not source:
        raise TranslationError("no_captions", "The project has no captions yet. Generate them first.")

    kept = others + other_langs
    source = mint_ids(source, _ids(kept))
    words = _source_words(source)
    runs = _match_phrases(words, phrases)

    # Another language already cut the source row: this one must use the
    # same lines, or that row would no longer line up.
    if other_langs:
        for n, run in enumerate(runs, start=1):
            seg = run[0]["_seg"]
            whole = [w for w in words if w["_seg"] == seg]
            if run[-1]["_seg"] != seg or run[0] is not whole[0] or run[-1] is not whole[-1]:
                raise TranslationError(
                    "phrases_differ",
                    f'The captions are already cut into lines for "{other_langs[0]["lang"]}". '
                    f"Translate those same lines, one phrase per caption line (phrase {n} differs).",
                )

    # Re-cut the source row: one segment per phrase, keeping the id and the
    # styling of the source segment each phrase starts in (a later phrase
    # starting in the same segment gets a new id).
    recut = []
    claimed = set()
    for run in runs:
        first = source[run[0]["_seg"]]
        seg_id = first["id"] if first["id"] not in claimed else None
        if seg_id:
            claimed.add(seg_id)
        recut.append(_segment_from_words(run, _carried_fields(first), seg_id))
    # A phrase that starts inside an already-claimed segment gets a new id that
    # no caption had before, so an old id never comes to name different text.
    recut = mint_ids(recut, _ids(kept) | _ids(source))

    # Replacing a language keeps its row where it was in the stack.
    old_lane = _lane(replaced[0]) if replaced else 0
    if old_lane and all(_lane(s) != old_lane for s in kept):
        lane = old_lane
    else:
        lane = max([_lane(s) for s in kept] + [0]) + 1
    row = [
        {
            "text": " ".join(p["text"].split()),
            "start": seg["start"],
            "end": seg["end"],
            "lane": lane,
            "lang": lang,
            "translationOf": [seg["id"]],
        }
        for seg, p in zip(recut, phrases)
    ]
    row = mint_ids(row, _ids(recut) | _ids(kept) | _ids(source) | _ids(replaced))
    return {**captions, "segments": _compact_lanes(recut + kept + row)}


def apply_show(captions, show) -> dict:
    """Set which languages the captions draw (`captions.showLangs`). Returns new captions; never mutates the input.

    `show` is a list of language codes: the source's own code (`captions.lang`, or "source" when the track has none)
    and/or the `lang` of a translated row. Every one must be a language the track has, at least one must be named, and
    naming all of them clears the field (everything draws, the default). The list is stored in drawing order, the
    source first, with the source under its own code when the track records one.
    """
    if not isinstance(captions, dict) or not isinstance(captions.get("segments"), list) or not captions["segments"]:
        raise TranslationError("no_captions", "The project has no captions yet. Generate them first.")
    if not isinstance(show, list) or not show or not all(isinstance(x, str) for x in show):
        raise TranslationError("bad_show", 'show must be a list of language codes, e.g. ["en", "es"], or ["source"].')
    source_key = captions.get("lang") if isinstance(captions.get("lang"), str) and captions.get("lang") else "source"
    langs = []
    for seg in captions["segments"]:
        if is_translation(seg) and seg["lang"] not in langs:
            langs.append(seg["lang"])
    available = [source_key] + langs
    wanted = {source_key if x == "source" else x for x in show}
    unknown = sorted(wanted - set(available))
    if unknown:
        raise TranslationError("unknown_language", f"The captions have no {', '.join(unknown)} row. They have: {', '.join(available)}.")
    out = {k: v for k, v in captions.items() if k != "showLangs"}
    if wanted != set(available):
        out["showLangs"] = [k for k in available if k in wanted]
    return out


def show_new_language(captions: dict, lang: str) -> dict:
    """A language just added joins the ones shown, when a choice of languages is active (`showLangs`), so
    the row an AI writes is not silently hidden. With no choice active nothing changes (everything draws).
    Entries for languages that no longer exist are dropped. Returns new captions; never mutates the input."""
    chosen = captions.get("showLangs")
    if not isinstance(chosen, list):
        return captions
    source_key = captions.get("lang") if isinstance(captions.get("lang"), str) and captions.get("lang") else "source"
    langs = []
    for seg in captions.get("segments") or []:
        if is_translation(seg) and seg["lang"] not in langs:
            langs.append(seg["lang"])
    available = [source_key] + langs
    keep = [k for k in available if k in chosen or k == lang or (k == source_key and "source" in chosen)]
    out = {k: v for k, v in captions.items() if k != "showLangs"}
    if keep and set(keep) != set(available):
        out["showLangs"] = keep
    return out


def record_source_language(track: dict, requested, words_path=None) -> dict:
    """Record the language the source captions are in (`track["lang"]`), so the editor can name it.

    The language the caller asked for when it is a code (not "auto"); with "auto", the language whisper
    detected (`result.language` in its words JSON) when that file has one. Unknown: the key is dropped,
    not carried over from the previous track, which may have been another language. Mutates and returns `track`.
    """
    lang = requested.strip() if isinstance(requested, str) else ""
    if not lang or lang.lower() == "auto":
        lang = ""
        try:
            with open(words_path, encoding="utf-8") as f:
                detected = (json.load(f).get("result") or {}).get("language")
            lang = detected.strip() if isinstance(detected, str) else ""
        except (OSError, ValueError, TypeError, AttributeError):
            lang = ""
    if lang and _LANG_RE.match(lang) and len(lang) <= 35:
        track["lang"] = lang
    else:
        track.pop("lang", None)
    return track


def finish_regenerated_track(prev, track: dict) -> dict:
    """Finish a freshly generated caption track before it replaces the old one.

    Carries the prior theme forward (`merge_caption_theme`), mints segment ids,
    and keeps the old track's translated rows. Each kept phrase is found again
    in the new transcript BY ITS WORDS (in order, at least MATCH_SHARE of them),
    not by its old times, so footage added, removed or moved around it does
    not shift it. A phrase found again becomes one source segment (its old id
    kept) and its translations are re-timed to it; words outside every phrase
    keep the fresh grouping, untranslated; a phrase not found again drops its
    translations rather than pairing them with the wrong words. Hand-made rows
    that are not translations are still dropped (a fresh transcript is one
    row). Mutates and returns `track`.
    """
    prev = prev if isinstance(prev, dict) else {}
    merge_caption_theme(prev, track)
    fresh = [s for s in (track.get("segments") or []) if isinstance(s, dict)]
    old = [s for s in (prev.get("segments") or []) if isinstance(s, dict)]
    kept = [s for s in old if is_translation(s)]
    if not kept or not fresh or not all(isinstance(s.get("words"), list) and s["words"] for s in fresh):
        track["segments"] = mint_ids(fresh)
        return track

    # The kept phrases in order: the old source segments each translation
    # names (every language names the same ones), as word tokens.
    old_by_id = {s["id"]: s for s in old if not is_translation(s) and isinstance(s.get("id"), str)}
    phrases, seen = [], set()
    for tr in sorted(kept, key=lambda s: s.get("start", 0)):
        key = tuple(tr["translationOf"])
        if key in seen:
            continue
        seen.add(key)
        toks = [t for sid in key if sid in old_by_id
                for t in (_token(w) for w in str(old_by_id[sid].get("text", "")).split()) if t]
        if toks:
            phrases.append((key, toks))

    # Align the phrases' words with the new transcript's, in order.
    words = [{**w, "_seg": i} for i, seg in enumerate(fresh) for w in seg["words"]]
    real = [k for k, w in enumerate(words) if _token(w["word"])]
    a, owner = [], []
    for p, (_, toks) in enumerate(phrases):
        a += toks
        owner += [p] * len(toks)
    b = [_token(words[k]["word"]) for k in real]
    found = {}
    for i, j, n in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        for d in range(n):
            found.setdefault(owner[i + d], []).append(real[j + d])
    ranges, phrase_of = {}, {}
    for p, (_, toks) in enumerate(phrases):
        hits = found.get(p, [])
        if len(hits) < max(1, math.ceil(MATCH_SHARE * len(toks))):
            continue
        lo, hi = min(hits), max(hits)
        while hi + 1 < len(words) and not _token(words[hi + 1]["word"]):
            hi += 1
        ranges[p] = (lo, hi)
        for k in range(lo, hi + 1):
            phrase_of[k] = p

    # The new source row: one segment per phrase found again, and the fresh
    # grouping for every run of words outside them.
    def fields(k):
        base = fresh[words[k]["_seg"]]
        return {f: v for f, v in base.items() if f not in ("id", "text", "start", "end", "words", "lane")}

    source, seg_of_phrase = [], {}
    k = 0
    while k < len(words):
        p = phrase_of.get(k)
        if p is not None:
            lo, hi = ranges[p]
            seg_of_phrase[p] = len(source)
            source.append(_segment_from_words(words[lo:hi + 1], fields(lo), phrases[p][0][0]))
            k = hi + 1
            continue
        start, i = k, words[k]["_seg"]
        while k < len(words) and k not in phrase_of and words[k]["_seg"] == i:
            k += 1
        run = words[start:k]
        if source and not any(_token(w["word"]) for w in run):
            # Punctuation alone: it ends the line before it.
            prior = source[-1]
            source[-1] = _segment_from_words(
                [*prior["words"], *run], {f: v for f, v in prior.items() if f not in ("text", "start", "end", "words")}, prior.get("id"))
        else:
            source.append(_segment_from_words(run, fields(start), None))
    source = mint_ids(source, _ids(old))

    rows = []
    for tr in kept:
        p = next((q for q, (key, _) in enumerate(phrases) if key == tuple(tr["translationOf"])), None)
        if p is None or p not in seg_of_phrase:
            continue
        src = source[seg_of_phrase[p]]
        rows.append({**tr, "start": src["start"], "end": src["end"], "translationOf": [src["id"]]})
    track["segments"] = _compact_lanes(source + rows)
    return track
