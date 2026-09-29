import json, sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))

def test_clips_workflow_is_not_built_in():
    # The clips workflow moved to the Montaj app (P-19).
    assert not (REPO_ROOT / "workflows" / "clips.json").exists()


def test_find_clips_skill_is_not_in_the_wheel():
    # PV46: the skill moved to the app with its workflow; montaj-app's
    # library/test/moved-skills.test.mjs guards its behaviour now.
    assert not (REPO_ROOT / "skills" / "find_clips").exists()
