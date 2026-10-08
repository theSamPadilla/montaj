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


import argparse
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone

from common import DEFAULT_WHISPER_MODEL, ffmpeg_bin, get_duration, progress, require_whisper_model, transcribe_words  # noqa: E402


class SkipVideo(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def _last_json(text):
    for line in reversed((text or "").strip().splitlines()):
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            continue
    return {}


def fetch_one(url, media_dir):
    """Download one post with the fetch step (yt-dlp). Returns (path, meta)."""
    cmd = [sys.executable, str(HERE / "fetch.py"), "--url", url, "--out", str(media_dir), "--meta", "--limit", "1"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        raise SkipVideo("timeout", "the download took over 15 minutes")
    if proc.returncode != 0:
        err = _last_json(proc.stderr)
        raise SkipVideo(err.get("error", "fetch_failed"), err.get("message", "the download failed"))
    data = _last_json(proc.stdout)
    paths = data.get("paths") or []
    if not paths:
        raise SkipVideo("fetch_failed", "nothing was downloaded")
    return paths[0], (data.get("videos") or [{}])[0]


def merge_meta(it, meta):
    d = meta.get("upload_date")
    return {**it,
            "views": it["views"] if it["views"] is not None else _count(meta.get("view_count")),
            "likes": it["likes"] if it["likes"] is not None else _count(meta.get("like_count")),
            "posted_at": it["posted_at"] or (f"{d[:4]}-{d[4:6]}-{d[6:8]}" if isinstance(d, str) and len(d) == 8 else None),
            "caption": it["caption"] or ((meta.get("description") or "")[:300] or None)}


def _frame(path, at, dest):
    # -ss before -i on a non-zero time (never -ss 0: it still seeks)
    subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-ss", str(at), "-i", str(path), "-frames:v", "1",
                    "-vf", "scale=720:-2", "-q:v", "3", str(dest)], check=True, timeout=120)


def _size(path):
    # load lib/normalize.py by path: a test process may have steps/media first on sys.path
    import importlib.util
    spec = importlib.util.spec_from_file_location("montaj_lib_normalize", ROOT / "lib" / "normalize.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    info = mod.probe_video(str(path)) or {}
    return info.get("display_width"), info.get("display_height")


def _music(path, cuts):
    import detect_beats
    try:
        b = detect_beats.analyze(str(path))
    except SystemExit:  # no_audio / too_short: no music to report
        return {"bpm": None, "confidence": None, "likely": False}, None
    conf = float(b.get("bpm_confidence") or 0)
    likely = conf >= MUSIC_CONFIDENCE and bool(b.get("bpm"))
    music = {"bpm": round(float(b["bpm"]), 1) if likely else None, "confidence": round(conf, 3), "likely": likely}
    return music, (on_beat_share(cuts, b.get("beats") or []) if likely else None)


def _palette(path):
    try:
        from profiles.analyze import extract_colors
        return extract_colors(str(path), n=6)
    except Exception:
        return []


def measure_video(path, stills, n, model, language):
    import detect_shots
    import shot_sheet
    det = detect_shots.detect(str(path), 0.25, 0.4, 1800)
    duration = det.get("duration") or get_duration(str(path))
    w, h = _size(path)
    shots_m, cuts = shot_metrics(det["shots"], duration)
    speech = speech_metrics(transcribe_words(str(path), model=model, language=language), duration)
    music, beat_share = _music(path, cuts)
    sheet_dir = stills / f"v{n:02d}"
    # width is per tile: four 320 px tiles make a sheet about 1280 px wide
    sheets = shot_sheet.build(str(path), det["shots"], str(sheet_dir), 1, 4, 320, 12, 600)["sheets"]
    sheet = stills / f"sheet-{n:02d}.jpg"
    shutil.move(sheets[0]["path"], sheet)
    shutil.rmtree(sheet_dir, ignore_errors=True)
    opening = stills / f"open-{n:02d}.jpg"
    _frame(path, min(0.5, max(duration - 0.1, 0.05)), opening)
    return {"duration_s": round(duration, 2), "width": w, "height": h, "aspect": aspect_label(w, h),
            "shots": len(det["shots"]), **shots_m, **speech, "music": music, "on_beat_share": beat_share,
            "palette": _palette(path), "sheet": f"stills/{sheet.name}", "opening_still": f"stills/{opening.name}"}


def main():
    ap = argparse.ArgumentParser(description="Measure a creator's editing style from their posts")
    ap.add_argument("--items", required=True)
    ap.add_argument("--out")
    ap.add_argument("--inbox")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--whisper-model", default=DEFAULT_WHISPER_MODEL)
    ap.add_argument("--language", default="auto")
    a = ap.parse_args()
    items = parse_items(a.items)
    if not 1 <= a.top <= MAX_ITEMS:
        fail("invalid_argument", f"--top must be 1 to {MAX_ITEMS}")
    require_whisper_model(a.whisper_model, a.language)  # exits whisper_model_missing before any download
    chosen, by = select_items(items, a.top)
    out = Path(a.out) if a.out else Path(tempfile.mkdtemp(prefix="montaj-creator-"))
    stills, media_dir = out / "stills", out / "_media"
    stills.mkdir(parents=True, exist_ok=True)
    videos, failed = [], []
    try:
        for n, it in enumerate(chosen, 1):
            source = it["url"] or Path(it["path"]).name
            progress(f"video {n} of {len(chosen)}: {source}")
            path = None
            try:
                if it["url"]:
                    media_dir.mkdir(exist_ok=True)
                    path, meta = fetch_one(it["url"], media_dir)
                    it = merge_meta(it, meta)
                else:
                    path = it["path"]
                    if not Path(path).is_file():
                        raise SkipVideo("not_found", f"no file at {path}")
                v = measure_video(Path(path), stills, n, a.whisper_model, a.language)
                videos.append({"source": it["url"] or source, "views": it["views"], "likes": it["likes"],
                               "posted_at": it["posted_at"], "caption": it["caption"], **v})
            except SkipVideo as e:
                failed.append({"source": source, "code": e.code, "message": e.message})
            except SystemExit:  # a helper called fail(); its JSON is already on stderr
                failed.append({"source": source, "code": "measure_failed", "message": "a measuring step failed (see the progress log)"})
            except (subprocess.SubprocessError, OSError, KeyError, IndexError, ValueError) as e:
                failed.append({"source": source, "code": "measure_failed", "message": str(e)[:200] or type(e).__name__})
            finally:
                if path and deletable(path, media_dir, a.inbox):
                    Path(path).unlink(missing_ok=True)
    finally:
        shutil.rmtree(media_dir, ignore_errors=True)
    if not videos:
        fail("no_videos_measured", f"none of {len(chosen)} posts could be measured: "
             + "; ".join(f"{f['source']} ({f['code']})" for f in failed)[:600])
    doc = {"schema": 1, "mode": "single" if by == "single" else "creator",
           "measured_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "selection": {"given": len(items), "measured": len(videos), "by": by},
           "summary": summarize(videos), "videos": videos, "failed": failed}
    (out / "diagnostic.json").write_text(json.dumps(doc, indent=2))
    print(json.dumps({"out": str(out), "diagnostic": str(out / "diagnostic.json"),
                      "measured": len(videos), "failed": len(failed)}))


if __name__ == "__main__":
    main()
