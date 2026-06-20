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

def test_clips_workflow_declares_lazy_normalize():
    wf = json.loads((REPO_ROOT / "workflows" / "clips.json").read_text())
    assert wf.get("normalize") == "lazy"

def test_find_clips_skill_removes_source_project():
    body = (REPO_ROOT / "skills" / "find_clips" / "SKILL.md").read_text()
    # Finalize step: relocate source to shared store + delete the source project
    assert ".sources/" in body
    assert "DELETE http://localhost:3000/api/projects/<source_project_id>" in body

def test_find_clips_skill_asks_before_finishing_clips():
    body = (REPO_ROOT / "skills" / "find_clips" / "SKILL.md").read_text()
    # The agent must ASK before running the overlays pass, and offer a paste-prompt hand-off.
    assert "do not auto-run the `overlays` pass without asking" in body.lower() or \
           "Never run the overlays pass without an explicit yes" in body
    # Hand-off prompt is modeled on Montaj's pending-project UI prompt, verbatim shape.
    assert 'There is a new project pending: "<clip_name>".' in body
    assert "@<montaj_root>/skills/SKILL.md and start" in body
