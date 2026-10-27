"""The speech track as the agent places things against it (run 5, from kung fu run 4): each item on the first track with
its timeline start and end, its file and the words it plays, read from the item's own transcript. After a cut the agent
read the tracks four times to learn this before placing b-roll; an answer that carries it needs no read. Read-only."""
import copy
import os

from lib.project_tracks import normalize_tracks
from lib.speech_lines import load_words, sidecar_for
from lib.speech_units import media_items, resolved_item


def _r2(x):
    return round(float(x), 2) + 0.0


def spine(project, project_dir):
    """[{id, start, end, src (file name), said}] for each media item of the first track, in timeline order. `said` is the
    transcript's words whose middle falls in the part of the source the item plays (inPoint to outPoint, cut short by
    the item's length); "" for an item with no transcript or no words there (b-roll)."""
    tracks = normalize_tracks(copy.deepcopy(project)).get("tracks", [])
    if not tracks:
        return []
    words_of = {}
    out = []
    for it in sorted(media_items(tracks[0]), key=lambda x: float(x.get("start", 0))):
        r = resolved_item(it, project_dir)
        sc = sidecar_for(r)
        if sc not in words_of:
            try:
                words_of[sc] = load_words(sc) if sc else []
            except (OSError, ValueError):
                words_of[sc] = []
        start, end = float(it.get("start", 0)), float(it.get("end", 0))
        a = float(it.get("inPoint", 0))
        b = min(float(it.get("outPoint", a + end - start)), a + max(end - start, 0.0))
        said = " ".join(w.text.strip() for w in words_of[sc] if a <= (w.start + w.end) / 2 < b)
        out.append({"id": it.get("id"), "start": _r2(start), "end": _r2(end),
                    "src": os.path.basename(str(it.get("src") or "")), "said": said})
    return out
