"""Skills + /info endpoints."""
import re
from importlib.metadata import PackageNotFoundError, version as pkg_version
from pathlib import Path

from fastapi import APIRouter

from serve.common import MONTAJ_ROOT

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
    return {
        "version": _montaj_version(),
        "skill_path": str(MONTAJ_ROOT / "skills/onboarding/SKILL.md"),
        "root_skill_path": str(MONTAJ_ROOT / "skills" / "SKILL.md"),
        "style_profile_skill_path": str(MONTAJ_ROOT / "skills/style-profile/SKILL.md"),
    }


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
