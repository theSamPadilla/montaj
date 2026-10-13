"""Caption translations: a second (third, ...) caption row in another language.

A translation is a row of segments marked as one: each carries `lang` (e.g.
"es") and `translationOf` (the ids of the source segments it translates) and
no `words`. Both rows are cut at the same phrase boundaries, so a translated
line is on screen exactly while its source phrase is, and the caption
templates draw it as a plain line stacked under its source (see
`captionGroups` in montaj_assets/overlay-runtime/position.js).

The source row is every segment that is not a translation and sits in row 0
(`lane` absent or 0). Its words keep their real timings: translating only
re-cuts the source row at the phrase boundaries the translation asks for.

Pure functions over plain dicts: nothing here reads or writes a project file.
The SSE caption route and the generate_captions step both finish a fresh
track through `finish_regenerated_track`; the translation route calls
`apply_translation`.
"""
import re

PHRASE_MAX_WORDS = 14
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
    return _TOKEN_STRIP_RE.sub("", word.casefold())


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
    recut = mint_ids(recut, _ids(kept))

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
    row = mint_ids(row, _ids(recut) | _ids(kept))
    return {**captions, "segments": _compact_lanes(recut + kept + row)}


def finish_regenerated_track(prev, track: dict) -> dict:
    """Finish a freshly generated caption track before it replaces the old one.

    Carries the prior theme forward (`merge_caption_theme`), mints segment ids,
    and keeps every translated row of the old track: the new source row is
    re-cut at the translations' phrase boundaries, and each translated segment
    is re-timed to and re-linked with the source segment it now pairs with.
    Hand-made rows that are not translations are still dropped (a fresh
    transcript is one row). Mutates and returns `track`.
    """
    prev = prev if isinstance(prev, dict) else {}
    merge_caption_theme(prev, track)
    fresh = [s for s in (track.get("segments") or []) if isinstance(s, dict)]
    kept = [s for s in (prev.get("segments") or []) if is_translation(s)]
    if not kept or not fresh or not all(isinstance(s.get("words"), list) and s["words"] for s in fresh):
        track["segments"] = mint_ids(fresh)
        return track

    words = sorted((w for s in fresh for w in s["words"]), key=lambda w: w["start"])
    # One language's starts are the phrase boundaries (every language shares them).
    first_lang = sorted(kept, key=lambda s: s.get("start", 0))[0]["lang"]
    starts = sorted({s["start"] for s in kept if s["lang"] == first_lang})
    groups = [[] for _ in starts]
    lead = []
    for w in words:
        mid = (w["start"] + w["end"]) / 2
        i = max((k for k, s in enumerate(starts) if s <= mid), default=None)
        (lead if i is None else groups[i]).append(w)
    base = {k: v for k, v in fresh[0].items() if k not in ("id", "text", "start", "end", "words", "lane")}
    runs = ([lead] if lead else []) + [g for g in groups if g]
    source = mint_ids([_segment_from_words(g, base, None) for g in runs], _ids(kept))

    def pair(seg):
        best, overlap = None, 0.0
        for src in source:
            o = min(seg["end"], src["end"]) - max(seg["start"], src["start"])
            if o > overlap:
                best, overlap = src, o
        return best

    rows = []
    for seg in kept:
        src = pair(seg)
        if src is not None:
            rows.append({**seg, "start": src["start"], "end": src["end"], "translationOf": [src["id"]]})
    track["segments"] = _compact_lanes(source + rows)
    return track
