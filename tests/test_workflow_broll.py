import json, sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))


def test_broll_workflow_is_not_built_in():
    """The broll workflow moved to the Montaj app (P-19), and its skill with it
    (PV46): the app serves it as app/broll."""
    assert not (REPO_ROOT / "workflows" / "broll.json").exists()


def test_broll_skill_is_not_in_the_wheel():
    assert not (REPO_ROOT / "skills" / "broll").exists()


def test_broll_project_type_survives_normalization():
    # normalize_project_type() falls back to "editing" for any value not in the
    # enum. The broll workflow now lives app-side, but the engine still owns the
    # project type, so pin the round-trip here.
    from lib.types.project import normalize_project_type
    assert normalize_project_type("broll") == "broll"
