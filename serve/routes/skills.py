"""Skills + /info endpoints."""
import re
import shutil
from importlib.metadata import PackageNotFoundError, version as pkg_version
from pathlib import Path

from fastapi import APIRouter

from serve.common import MONTAJ_ROOT, resolve_workspace

router = APIRouter(prefix="/api")


def _montaj_version() -> str:
    """Resolve the installed Montaj package version. Mirrors cli/main.py's
    fallback: returns 'dev' when running from source (package not installed)."""
    try:
        return pkg_version("montaj")
    except PackageNotFoundError:
        return "dev"


@router.get("/info")
async def get_info():
    info = {
        "version": _montaj_version(),
        "skill_path": str(MONTAJ_ROOT / "skills/onboarding/SKILL.md"),
        "root_skill_path": str(MONTAJ_ROOT / "skills" / "SKILL.md"),
        "style_profile_skill_path": str(MONTAJ_ROOT / "skills/style-profile/SKILL.md"),
    }

    # Filesystem-level only, deliberately not a du walk: /api/info is called
    # casually and a recursive size walk over a 100GB volume of video would make
    # it a heavy call. A threshold only needs the filesystem numbers.
    #
    # Omitted entirely on failure rather than reported as zero. A caller that
    # cannot read this must treat it as unknown, not as an empty disk.
    try:
        usage = shutil.disk_usage(resolve_workspace())
        # A non-positive total means we cannot characterise the filesystem at
        # all. Omit `disk` exactly as on OSError rather than reporting zeros:
        # a caller must be able to tell "cannot tell" from "empty", and an
        # all-zero object reads as a completely free disk.
        if usage.total > 0:
            info["disk"] = {
                "totalBytes": usage.total,
                "freeBytes": usage.free,
                "usedBytes": usage.total - usage.free,
                "usedPercent": round((usage.total - usage.free) / usage.total * 100, 2),
            }
    except OSError:
        pass

    return info


def scan_skills() -> list[dict]:
    """Scan native (built-in) then custom (~/.montaj/skills) skills. Later scope overwrites earlier.
    Reads YAML frontmatter from each skills/<name>/SKILL.md. Returns list of {name, description, scope}."""
    scopes = [
        (MONTAJ_ROOT / "skills",           "native"),
        (Path.home() / ".montaj" / "skills", "custom"),
    ]
    skills: dict[str, dict] = {}
    for scope_dir, scope_label in scopes:
        if not scope_dir.exists():
            continue
        for skill_dir in sorted(scope_dir.iterdir()):
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.exists():
                continue
            text = skill_md.read_text()
            # Parse YAML frontmatter between --- delimiters
            m = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
            if not m:
                continue
            fm: dict = {}
            for line in m.group(1).splitlines():
                if ":" in line:
                    k, _, v = line.partition(":")
                    fm[k.strip()] = v.strip().strip('"')
            name = fm.get("name")
            if not name:
                continue
            is_step = fm.get("step", "").lower() in ("true", "1", "yes")
            raw_subs = fm.get("subskills", "")
            subskills = [s.strip() for s in raw_subs.split(",") if s.strip()] if raw_subs else []
            skills[name] = {
                "name": f"montaj/{name}",
                "description": fm.get("description", ""),
                "scope": scope_label,
                "step": is_step,
                "subskills": [f"montaj/{s}" for s in subskills],
            }
    return list(skills.values())


@router.get("/skills")
async def list_skills():
    return scan_skills()
