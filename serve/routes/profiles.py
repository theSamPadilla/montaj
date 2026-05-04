"""Profile listing + detail endpoints."""
import json
from pathlib import Path

from fastapi import APIRouter

from serve.common import not_found

router = APIRouter(prefix="/api")


def parse_style_frontmatter(style_path: Path) -> dict:
    """Parse YAML frontmatter from style_profile.md. Returns {} if absent or malformed."""
    if not style_path.exists():
        return {}
    try:
        text = style_path.read_text()
        if not text.startswith("---"):
            return {}
        end = text.index("---", 3)
        block = text[3:end].strip()
        result: dict = {}
        for line in block.splitlines():
            if ":" not in line:
                continue
            key, _, val = line.partition(":")
            result[key.strip()] = val.strip()
        return result
    except Exception:
        return {}


def _load_analysis(profile_dir: Path, source: str) -> dict:
    path = profile_dir / f"analysis_{source}.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _build_profile_response(name: str, profile_dir: Path) -> dict:
    """Build a profile response dict from style_profile.md frontmatter + analysis JSON."""
    fm = parse_style_frontmatter(profile_dir / "style_profile.md")
    current  = _load_analysis(profile_dir, "current")
    inspired = _load_analysis(profile_dir, "inspired")
    ca = current.get("aggregate", {})
    ia = inspired.get("aggregate", {})

    current_colors  = ca.get("dominant_colors", [])
    inspired_colors = ia.get("dominant_colors", [])
    merged = []
    seen: set = set()
    for pair in zip(current_colors, inspired_colors):
        for c in pair:
            if c not in seen:
                seen.add(c); merged.append(c)
    for c in current_colors + inspired_colors:
        if c not in seen:
            seen.add(c); merged.append(c)

    sources = []
    if current.get("video_count"):
        sources.append({"type": "current", "video_count": current["video_count"]})
    if inspired.get("video_count"):
        sources.append({"type": "inspired", "video_count": inspired["video_count"]})

    data: dict = {
        "name":    name,
        "created": fm.get("created", ""),
        "updated": fm.get("updated", ""),
        "style_profile_path": str(profile_dir / "style_profile.md"),
        "sources": sources,
        "style_meta": fm,
        "stats": {
            "videos_analyzed":   sum(s["video_count"] for s in sources),
            "avg_duration":      ca.get("avg_duration"),
            "avg_cuts_per_min":  ca.get("avg_cuts_per_min"),
            "avg_wpm":           ca.get("avg_wpm"),
            "avg_speech_ratio":  ca.get("avg_speech_ratio"),
            "dominant_colors":   current_colors[:6],
            "common_resolution": ca.get("common_resolution") or ia.get("common_resolution"),
            "common_fps":        ca.get("common_fps") or ia.get("common_fps"),
        },
        "color_palette": {
            "current":  current_colors,
            "inspired": inspired_colors,
            "merged":   merged[:10],
        },
    }
    return data


@router.get("/profiles")
async def list_profiles():
    """List all creator profiles from ~/.montaj/profiles/."""
    profiles_dir = Path.home() / ".montaj" / "profiles"
    if not profiles_dir.exists():
        return []
    results = []
    for entry in sorted(profiles_dir.iterdir()):
        if not entry.is_dir():
            continue
        if not (entry / "analysis_current.json").exists():
            continue
        try:
            results.append(_build_profile_response(entry.name, entry))
        except Exception:
            continue
    return results


@router.get("/profiles/{name}")
async def get_profile(name: str):
    """Return profile metadata + style document content."""
    profile_dir = Path.home() / ".montaj" / "profiles" / name
    if not (profile_dir / "analysis_current.json").exists():
        raise not_found("not_found", f"Profile '{name}' not found")

    data = _build_profile_response(name, profile_dir)

    style_path = profile_dir / "style_profile.md"
    if style_path.exists():
        data["style_doc"] = style_path.read_text()

    # Attach sample frame paths
    frames_dir = profile_dir / "frames"
    if frames_dir.exists():
        data["sample_frames"] = [str(f) for f in sorted(frames_dir.glob("*.jpg"))]

    return data
