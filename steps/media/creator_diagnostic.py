#!/usr/bin/env python3
"""creator_diagnostic: measure how a creator cuts, speaks and scores their videos.

Takes up to 30 posts (links or local files), measures the most-viewed `top`
of them on this machine, and writes one diagnostic JSON plus a shot sheet and
an opening frame per video. Videos it downloaded, and videos in --inbox, are
deleted once measured; nothing else is touched.
"""
import json
import statistics
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
# lib first; the step dirs and the repo root are appended, never inserted:
# steps/media/normalize.py (loudnorm) must not shadow lib/normalize.py.
sys.path.insert(0, str(ROOT / "lib"))
sys.path.append(str(ROOT))
for _sub in ("media", "audio", "speech"):
    sys.path.append(str(ROOT / "steps" / _sub))

from common import fail  # noqa: E402

MAX_ITEMS = 30
ON_BEAT_S = 0.08
MUSIC_CONFIDENCE = 0.5
OPENING_S = 3.0
_ASPECTS = (("9:16", 9 / 16), ("4:5", 4 / 5), ("1:1", 1.0), ("16:9", 16 / 9))


def _count(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def parse_items(raw):
    try:
        items = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as e:
        fail("invalid_items", f"--items is not JSON: {e}")
    if not isinstance(items, list) or not items:
        fail("invalid_items", "--items must be a non-empty JSON array")
    if len(items) > MAX_ITEMS:
        fail("invalid_items", f"--items takes at most {MAX_ITEMS} posts")
    out = []
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            fail("invalid_items", f"item {i} is not an object")
        url, path = it.get("url"), it.get("path")
        if bool(url) == bool(path):
            fail("invalid_items", f"item {i}: give exactly one of url or path")
        caption = it.get("caption")
        out.append({"url": url or None, "path": path or None, "views": _count(it.get("views")),
                    "likes": _count(it.get("likes")), "posted_at": it.get("posted_at") or None,
                    "caption": caption[:300] if isinstance(caption, str) and caption else None})
    return out


def select_items(items, top):
    """The most-viewed `top` (input order breaks ties), else the first `top` (newest first)."""
    if len(items) == 1:
        return items, "single"
    if any(it["views"] is not None for it in items):
        ranked = sorted(enumerate(items), key=lambda p: (p[1]["views"] is None, -(p[1]["views"] or 0), p[0]))
        return [it for _, it in ranked[:top]], "views"
    return items[:top], "latest"


def median(values):
    vals = [v for v in values if v is not None]
    return round(statistics.median(vals), 3) if vals else None


def aspect_label(w, h):
    if not w or not h:
        return None
    r = w / h
    for label, target in _ASPECTS:
        if abs(r - target) / target < 0.04:
            return label
    return f"{w}:{h}"


def on_beat_share(cut_times, beats, window=ON_BEAT_S):
    if not cut_times or not beats:
        return None
    hits = sum(1 for t in cut_times if min(abs(t - b) for b in beats) <= window)
    return round(hits / len(cut_times), 3)


def deletable(path, media_dir, inbox):
    p = Path(path).resolve()
    return any(root and p.is_relative_to(Path(root).resolve()) for root in (media_dir, inbox))


def shot_metrics(shots, duration):
    lengths = [s["duration"] for s in shots]
    cuts = [round(s["start"], 3) for s in shots[1:]]
    q = statistics.quantiles(lengths, n=4) if len(lengths) >= 2 else [None, None, None]
    return {
        "cuts_per_min": round(len(cuts) / (duration / 60), 2) if duration else None,
        "shot_median_s": median(lengths),
        "shot_p25_s": round(q[0], 3) if q[0] is not None else None,
        "shot_p75_s": round(q[2], 3) if q[2] is not None else None,
        "first_cut_s": round(cuts[0], 2) if cuts else None,
    }, cuts


def speech_metrics(words, duration):
    if not words:
        return {"wpm": None, "speech_share": 0.0 if duration else None, "first_word_s": None, "opening_line": None}
    # whisper words are gapless (a pause sits in the next word's start), so this
    # share runs high when speech is continuous; it reads as "talking video or not".
    spoken = sum(max(0.0, w["end"] - w["start"]) for w in words)
    span = words[-1]["end"] - words[0]["start"]
    opening = " ".join(w["text"].strip() for w in words if w["start"] < OPENING_S).strip()
    return {
        "wpm": round(len(words) / (span / 60), 1) if span > 0 else None,
        "speech_share": round(min(1.0, spoken / duration), 3) if duration else None,
        "first_word_s": round(words[0]["start"], 2),
        "opening_line": opening or None,
    }


def top_colors(per_video, n=6):
    try:
        from profiles.analyze import aggregate_colors
        return aggregate_colors([p for p in per_video if p], top_n=n)
    except Exception:
        counts = Counter(c for p in per_video for c in (p or []))
        return [c for c, _ in counts.most_common(n)]


def summarize(videos):
    def col(k):
        return [v.get(k) for v in videos]
    aspects = [v["aspect"] for v in videos if v.get("aspect")]
    music = [bool(v["music"]["likely"]) for v in videos]
    return {
        "videos": len(videos),
        "duration_s": median(col("duration_s")),
        "aspect": Counter(aspects).most_common(1)[0][0] if aspects else None,
        "cuts_per_min": median(col("cuts_per_min")),
        "shot_median_s": median(col("shot_median_s")),
        "first_cut_s": median(col("first_cut_s")),
        "wpm": median(col("wpm")),
        "speech_share": median(col("speech_share")),
        "first_word_s": median(col("first_word_s")),
        "music_share": round(sum(music) / len(music), 3) if music else None,
        "bpm": median([v["music"]["bpm"] for v in videos]),
        "on_beat_share": median(col("on_beat_share")),
        "palette": top_colors([v.get("palette") for v in videos]),
    }
