#!/usr/bin/env python3
"""Analyze a set of videos and produce an aggregate style analysis JSON.

Usage:
    python profiles/analyze.py \\
        --videos /path/v1.mp4 /path/v2.mp4 \\
        --source current \\
        --out ~/.montaj/profiles/theSamPadilla/
"""
import json, os, re, shutil, subprocess, sys, tempfile, argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STEPS_DIR   = os.path.join(MONTAJ_ROOT, "steps")
PYTHON      = sys.executable


# ---------------------------------------------------------------------------
# Per-video analysis helpers
# ---------------------------------------------------------------------------

def probe_video(video_path: str) -> dict:
    """Run probe step and return parsed JSON."""
    r = subprocess.run(
        [PYTHON, os.path.join(STEPS_DIR, "probe.py"), "--input", video_path],
        capture_output=True, text=True, timeout=30,
    )
    if r.returncode != 0:
        return {}
    try:
        return json.loads(r.stdout)
    except Exception:
        return {}


def transcribe_and_stats(video_path: str, transcripts_dir: str) -> dict:
    """Transcribe video once, save word JSON to transcripts_dir, return pacing stats.

    Replaces the separate speech_stats() + pacing.py call — whisper runs once per video.
    Returns {wpm_avg, speech_ratio, transcript_path}.
    """
    video_id = os.path.splitext(os.path.basename(video_path))[0]
    transcript_prefix = os.path.join(transcripts_dir, video_id)

    r = subprocess.run(
        [PYTHON, os.path.join(STEPS_DIR, "transcribe.py"),
         "--input", video_path, "--out", transcript_prefix, "--model", "base.en"],
        capture_output=True, text=True, timeout=300,
    )
    if r.returncode != 0:
        return {"wpm_avg": 0, "speech_ratio": 0, "transcript_path": None}

    try:
        paths = json.loads(r.stdout)
        words_path = paths.get("words")
        if not words_path or not os.path.isfile(words_path):
            return {"wpm_avg": 0, "speech_ratio": 0, "transcript_path": None}

        data = json.loads(open(words_path).read())
        words = data.get("transcription", [])

        # Compute pacing stats from word timestamps
        total_words = len(words)
        if total_words == 0 or not words:
            return {"wpm_avg": 0, "speech_ratio": 0, "transcript_path": words_path}

        first_start = words[0].get("offsets", {}).get("from", 0) / 1000.0
        last_end    = words[-1].get("offsets", {}).get("to", 0) / 1000.0
        spoken_duration = last_end - first_start
        total_duration  = spoken_duration or 1

        wpm   = round(total_words / (spoken_duration / 60), 1) if spoken_duration > 0 else 0
        ratio = round(spoken_duration / total_duration, 3)

        return {"wpm_avg": wpm, "speech_ratio": ratio, "transcript_path": words_path}
    except Exception:
        return {"wpm_avg": 0, "speech_ratio": 0, "transcript_path": None}


def count_cuts(video_path: str) -> int:
    """Estimate cut count using ffmpeg scene detection."""
    tmp_stats = tempfile.NamedTemporaryFile(suffix=".txt", delete=False)
    tmp_stats.close()
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", video_path,
             "-vf", f"select=gt(scene\\,0.3),metadata=mode=print:file={tmp_stats.name}",
             "-vsync", "vfr", "-f", "null", "-"],
            capture_output=True, timeout=120,
        )
        if not os.path.isfile(tmp_stats.name):
            return 0
        with open(tmp_stats.name) as f:
            return sum(1 for line in f if "lavfi.scene_score" in line)
    except Exception:
        return 0
    finally:
        try:
            os.unlink(tmp_stats.name)
        except Exception:
            pass


def extract_colors(video_path: str, n: int = 8) -> list[str]:
    """Extract dominant colors using ffmpeg palettegen + PIL. Returns hex strings."""
    try:
        from PIL import Image
    except ImportError:
        return []

    tmp_dir = tempfile.mkdtemp(prefix="montaj_palette_")
    try:
        palette_path = os.path.join(tmp_dir, "palette.png")
        subprocess.run(
            ["ffmpeg", "-y", "-i", video_path,
             "-vf", f"palettegen=max_colors={n}:reserve_transparent=0:stats_mode=diff",
             palette_path],
            capture_output=True, timeout=60,
        )
        if not os.path.isfile(palette_path):
            return []
        img = Image.open(palette_path).convert("RGB")
        seen: dict[tuple, bool] = {}
        for px in img.getdata():
            if px not in seen:
                seen[px] = True
        colors = list(seen.keys())[:n]
        return [f"#{r:02x}{g:02x}{b:02x}" for r, g, b in colors]
    except Exception:
        return []
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def capture_frames(video_path: str, out_dir: str, count: int = 3) -> list[str]:
    """Extract evenly-spaced sample frames. Returns saved image paths."""
    r = subprocess.run(
        [PYTHON, os.path.join(STEPS_DIR, "snapshot.py"),
         "--input", video_path,
         "--cols", str(count), "--rows", "1",
         "--out", os.path.join(out_dir, os.path.splitext(os.path.basename(video_path))[0] + "_snap.jpg")],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode == 0:
        path = r.stdout.strip()
        if os.path.isfile(path):
            return [path]
    return []


# ---------------------------------------------------------------------------
# Aggregate helpers
# ---------------------------------------------------------------------------

def _median(vals: list[float]) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def _most_common(vals: list) -> object:
    if not vals:
        return None
    return max(set(vals), key=vals.count)


def aggregate_colors(per_video_colors: list[list[str]], top_n: int = 8) -> list[str]:
    """Merge per-video color lists, returning the most frequently appearing colors."""
    freq: dict[str, int] = {}
    for colors in per_video_colors:
        for c in colors:
            freq[c] = freq.get(c, 0) + 1
    return [c for c, _ in sorted(freq.items(), key=lambda x: -x[1])][:top_n]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def analyze(videos: list[str], source: str, out_dir: str, name: str) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    frames_dir      = os.path.join(out_dir, "frames")
    transcripts_dir = os.path.join(out_dir, "transcripts")
    os.makedirs(frames_dir, exist_ok=True)
    os.makedirs(transcripts_dir, exist_ok=True)

    def analyze_one(v: str) -> dict | None:
        if not os.path.isfile(v):
            print(f"[analyze] skipping missing file: {v}", file=sys.stderr)
            return None

        print(f"[analyze] {os.path.basename(v)} …", file=sys.stderr)

        probe = probe_video(v)
        duration = probe.get("duration", 0)
        resolution = ""
        fps = 0
        for stream in probe.get("streams", []):
            if stream.get("type") == "video":
                w, h = stream.get("width"), stream.get("height")
                if w and h:
                    resolution = f"{w}x{h}"
                fps = stream.get("fps", 0)
                break

        cuts      = count_cuts(v)
        cuts_pm   = round(cuts / (duration / 60), 1) if duration > 0 else 0
        speech    = transcribe_and_stats(v, transcripts_dir)
        colors    = extract_colors(v)
        frames    = capture_frames(v, frames_dir)

        return {
            "path":            v,
            "source":          source,
            "duration":        round(duration, 2),
            "resolution":      resolution,
            "fps":             fps,
            "cuts":            cuts,
            "cuts_per_min":    cuts_pm,
            "wpm_avg":         speech["wpm_avg"],
            "speech_ratio":    speech["speech_ratio"],
            "transcript_path": speech["transcript_path"],
            "dominant_colors": colors,
            "sample_frames":   frames,
        }

    with ThreadPoolExecutor() as executor:
        results = [r for r in executor.map(analyze_one, videos) if r is not None]

    # Aggregate
    durations    = [v["duration"]     for v in results if v["duration"]]
    cuts_pm_list = [v["cuts_per_min"] for v in results if v["cuts_per_min"]]
    wpms         = [v["wpm_avg"]      for v in results if v["wpm_avg"]]
    ratios       = [v["speech_ratio"] for v in results if v["speech_ratio"]]
    all_colors   = [v["dominant_colors"] for v in results]
    resolutions  = [v["resolution"]   for v in results if v["resolution"]]
    fpss         = [v["fps"]          for v in results if v["fps"]]

    aggregate = {
        "avg_duration":      round(_median(durations), 2),
        "avg_cuts_per_min":  round(_median(cuts_pm_list), 1),
        "avg_wpm":           round(_median(wpms), 1),
        "avg_speech_ratio":  round(_median(ratios), 3),
        "dominant_colors":   aggregate_colors(all_colors),
        "common_resolution": _most_common(resolutions),
        "common_fps":        _most_common(fpss),
    }

    analysis = {
        "name":         name,
        "source":       source,
        "analyzed_at":  datetime.now(timezone.utc).isoformat(),
        "video_count":  len(results),
        "videos":       results,
        "aggregate":    aggregate,
    }

    out_path = os.path.join(out_dir, f"analysis_{source}.json")
    with open(out_path, "w") as f:
        json.dump(analysis, f, indent=2)

    now = datetime.now(timezone.utc).isoformat()

    # Write bookkeeping fields into style_profile.md frontmatter
    style_path = os.path.join(out_dir, "style_profile.md")
    _update_style_frontmatter(style_path, {
        "created": now,   # preserved if already set
        "updated": now,
        f"videos_{source}": len(results),
    })

    # Clean up source videos — frames are kept, raw videos are ephemeral
    videos_dir = os.path.join(out_dir, "videos", source)
    if os.path.isdir(videos_dir):
        shutil.rmtree(videos_dir, ignore_errors=True)
        print(f"[analyze] cleaned up {videos_dir}", file=sys.stderr)

    print(out_path)
    return analysis


def _update_style_frontmatter(path: str, updates: dict) -> None:
    """Create or update bookkeeping fields in style_profile.md frontmatter.

    Preserves existing fields (including agent-written ones). Only overwrites
    keys present in `updates`, except `created` which is never overwritten.
    """
    if not os.path.isfile(path):
        lines = ["---"]
        for k, v in updates.items():
            lines.append(f"{k}: {v}")
        lines += ["---", ""]
        with open(path, "w") as f:
            f.write("\n".join(lines))
        return

    text = open(path).read()
    if not text.startswith("---"):
        fm = ["---"] + [f"{k}: {v}" for k, v in updates.items()] + ["---", ""]
        with open(path, "w") as f:
            f.write("\n".join(fm) + "\n" + text)
        return

    try:
        end = text.index("---", 3)
    except ValueError:
        return

    body = text[end + 3:]
    fields: dict = {}
    for line in text[3:end].strip().splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            fields[k.strip()] = v.strip()

    for k, v in updates.items():
        if k == "created" and "created" in fields:
            continue  # never overwrite created date
        fields[k] = v

    fm_lines = ["---"] + [f"{k}: {v}" for k, v in fields.items()] + ["---"]
    with open(path, "w") as f:
        f.write("\n".join(fm_lines) + body)


def main():
    parser = argparse.ArgumentParser(description="Analyze videos and produce a style analysis JSON")
    parser.add_argument("--videos", nargs="+", required=True, help="Video file paths to analyze")
    parser.add_argument("--source", choices=["current", "inspired"], default="current",
                        help="Source type: your own content (current) or reference accounts (inspired)")
    parser.add_argument("--name",   required=True, help="Profile name (e.g. theSamPadilla)")
    parser.add_argument("--out",    required=True, help="Output directory for analysis files")
    args = parser.parse_args()

    analyze(args.videos, args.source, args.out, args.name)


if __name__ == "__main__":
    main()
