"""Which words play in a timeline range, mapped through the project's CURRENT tracks.

Word timings live per source in source time (lib/speech_lines.load_words). Nothing here is cached:
every call reads the tracks and the sidecars, so the answer always follows the current cut.
Mapping is speech_text.derive's: a word belongs to an item when its midpoint lies in
[inPoint, outPoint); its timeline time is the item's start plus (source time - inPoint) / speed
(speech_build's timing), clamped to the item's span.
"""
from lib.project_tracks import normalize_tracks
from lib.speech_lines import load_words, sidecar_for
from lib.speech_build import _speed
from lib.speech_text import _NON_SPEECH_TYPES, _sorted_items


def words_at(project: dict, project_dir: str, start: float, end: float, track: str | None = None) -> list:
    point = end <= start
    out, cache = [], {}
    for tr in normalize_tracks(project).get("tracks", []):
        if track is not None and tr["id"] != track:
            continue
        for it in _sorted_items(tr, project_dir):
            if it.get("type") in _NON_SPEECH_TYPES or it.get("loop") or not it.get("src"):
                continue
            it_start, it_end = float(it.get("start", 0)), float(it.get("end", 0))
            if it_end < start or it_start > end:
                continue
            sc = sidecar_for(it)
            if sc is None:
                continue
            if sc not in cache:
                cache[sc] = load_words(sc)
            a, b = float(it.get("inPoint", 0)), float(it.get("outPoint", 0))
            speed = _speed(it)
            for w in cache[sc]:
                if not (a <= (w.start + w.end) / 2 < b):
                    continue
                t0 = min(max(it_start + (w.start - a) / speed, it_start), it_end)
                t1 = min(max(it_start + (w.end - a) / speed, it_start), it_end)
                hit = (t1 >= start and t0 <= end) if point else (t1 > start and t0 < end)
                if hit:
                    out.append({
                        "text": w.text, "start": round(t0, 3), "end": round(t1, 3),
                        "source": it.get("src"), "sourceStart": round(w.start, 3), "sourceEnd": round(w.end, 3),
                        "item": it.get("id"), "track": tr["id"],
                    })
    out.sort(key=lambda r: (r["start"], r["end"]))
    return out
