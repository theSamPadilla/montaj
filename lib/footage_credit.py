"""PL89e: whose footage a clip is, and the credit line a footage card (frame_broll's) owes it.

Shared by steps/edit/frame_broll.py (which writes the card's credit) and lib/look_check.py (which says a third-party
card with none). Third-party footage is what default_credit finds a credit for: a source with a title or URL (its
record, or its provenance: where it was downloaded from), or a downloaded file by its own name. The person's own
footage has none, and a profile whose Titles & overlays notes say no credits opts out.
"""
import os
import re

PLATFORMS = {"youtube": "YouTube", "vimeo": "Vimeo", "tiktok": "TikTok", "instagram": "Instagram"}
FOOTAGE_CARD_STEM = "footage-card"   # place.COPIED_PRESETS["footage_card"]'s file name, wherever it was copied


def titles_notes(project):
    """The lines of the profile's "Titles & overlays" notes (profileSnapshot's styleProfilePath), or []."""
    path = ((project or {}).get("profileSnapshot") or {}).get("styleProfilePath")
    if not isinstance(path, str) or not os.path.isfile(path):
        return []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read(200_000)
    except OSError:
        return []
    section, inside = [], False
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            if inside:
                break
            inside = bool(re.search(r"titles?\b.*overlays?", line, re.I))
            continue
        if inside:
            section.append(line)
    return section


def profile_wants_no_credits(project):
    """The profile's Titles & overlays notes ask for no source credits on screen."""
    return any(re.search(r"\b(?:no|without|never (?:show|add|use))\b[^.]*\bcredits?\b", l, re.I) for l in titles_notes(project))


def provenance_of(project_dir, path):
    """The file's entry in the project's provenance record (assets/.provenance.json, serve/provenance.py), or {}."""
    if not project_dir or not path:
        return {}
    try:
        from serve import provenance
        return provenance.merged(project_dir).get(provenance.key_for(project_dir, path)) or {}
    except Exception:  # noqa: BLE001  (no record, a path outside the project: no entry)
        return {}


def default_credit(source, project_dir=None):
    """The card's credit for a clip's source when none is passed: the title of its source record or of its provenance
    (where it was downloaded from), else the site of its URL, else a downloaded file's own name ("youtube-<slug>-<id>"
    gives "Footage: <Slug> · YouTube"); '' for the person's own footage."""
    source = source or {}
    prov = provenance_of(project_dir, source.get("src"))
    for v in (source.get("title"), source.get("name"), source.get("sourceTitle"), prov.get("title")):
        if isinstance(v, str) and v.strip():
            return f"Footage: {v.strip()}"
    url = source.get("url") or source.get("sourceUrl") or prov.get("sourceUrl")
    if isinstance(url, str) and url.strip():
        from urllib.parse import urlparse
        host = urlparse(url.strip()).netloc.lower()
        host = host[4:] if host.startswith("www.") else host
        if host:
            return f"Footage: {host}"
    stem = os.path.splitext(os.path.basename(str(source.get("src") or "")))[0]
    m = re.match(r"^youtube-(?:(.+)-)?([A-Za-z0-9_-]{11})$", stem)
    if m:
        slug = (m.group(1) or "").replace("-", " ").replace("_", " ").strip()
        return f"Footage: {slug.title()} · YouTube" if slug else "Footage: YouTube"
    for prefix, label in PLATFORMS.items():
        if stem.startswith(prefix + "-"):
            return f"Footage: {label}"
    return ""


def source_of(project, item):
    """The project's source record for a timeline item: the one with the same file (by real path)."""
    real = os.path.realpath(str(item.get("src") or ""))
    return next((s for s in (project.get("sources") or []) if isinstance(s, dict) and s.get("src")
                 and os.path.realpath(str(s["src"])) == real), {"src": item.get("src")})


def is_footage_card(item):
    """An overlay made from the footage-card preset."""
    return item.get("type") == "overlay" and os.path.basename(str(item.get("src") or "")).startswith(FOOTAGE_CARD_STEM)


def owed_credit(project, project_dir, card):
    """The credit a footage card with an empty one owes its clip (props.for), or '' when it owes none (a credit is
    set, own footage, or a profile that wants none)."""
    props = card.get("props") or {}
    if str(props.get("credit") or "").strip() or profile_wants_no_credits(project):
        return ""
    clip_id = props.get("for")
    clip = next((it for t in project.get("tracks") or [] for it in (t.get("items") if isinstance(t, dict) else t) or []
                 if isinstance(it, dict) and it.get("id") == clip_id and it.get("type") == "video"), None)
    return default_credit(source_of(project, clip), project_dir) if clip else ""
