import json, sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))
import validate as v

def test_clips_workflow_shape():
    wf = json.loads((REPO_ROOT / "workflows" / "clips.json").read_text())
    assert wf["name"] == "clips"
    assert wf.get("requires_clips", True) is True
    assert [s["id"] for s in wf["steps"]][-1] == "find_clips"

def test_clips_workflow_validates():
    assert v.validate_workflow(str(REPO_ROOT / "workflows" / "clips.json"))["valid"] is True

def test_find_clips_skill_is_step():
    body = (REPO_ROOT / "skills" / "find_clips" / "SKILL.md").read_text()
    assert "step: true" in body
    assert "name: find_clips" in body
