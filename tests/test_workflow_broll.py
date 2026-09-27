import json, sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))


def test_broll_workflow_is_not_built_in():
    """The broll workflow moved to the Montaj app (P-19). The montaj/broll skill
    stays so the app's workflow can still resolve it from the wheel."""
    assert not (REPO_ROOT / "workflows" / "broll.json").exists()


def test_broll_skill_resolves_as_a_skill():
    import resolve_workflow as rw
    resolved = rw.resolve_step("montaj/broll", str(REPO_ROOT))
    assert resolved["kind"] == "skill"
    assert resolved["skill_path"].endswith("skills/broll/SKILL.md")


def test_broll_project_type_survives_normalization():
    # normalize_project_type() falls back to "editing" for any value not in the
    # enum. The broll workflow now lives app-side, but the engine still owns the
    # project type, so pin the round-trip here.
    from lib.types.project import normalize_project_type
    assert normalize_project_type("broll") == "broll"


def test_broll_skill_frontmatter():
    text = (REPO_ROOT / "skills" / "broll" / "SKILL.md").read_text()
    assert text.startswith("---")
    fm = text.split("---")[1]
    assert "name: broll" in fm
    assert "step: true" in fm
