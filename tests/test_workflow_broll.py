import json, sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))
sys.path.insert(0, str(REPO_ROOT / "engine"))


def test_broll_workflow_resolves():
    import resolve_workflow as rw
    wf = json.loads((REPO_ROOT / "workflows" / "broll.json").read_text())
    assert wf["name"] == "broll"
    assert wf["project_type"] == "broll"
    assert wf["requires_clips"] is True
    for step in wf["steps"]:
        resolved = rw.resolve_step(step["uses"], str(REPO_ROOT))
        assert resolved["kind"] in ("step", "skill")


def test_broll_skill_resolves_as_a_skill():
    import resolve_workflow as rw
    resolved = rw.resolve_step("montaj/broll", str(REPO_ROOT))
    assert resolved["kind"] == "skill"
    assert resolved["skill_path"].endswith("skills/broll/SKILL.md")


def test_broll_project_type_survives_normalization():
    # normalize_project_type() falls back to "editing" for any value not in the
    # enum, and read_workflow() returns None on any failure — both silently. A
    # raw-string assertion on project_type would still pass if "broll" were
    # dropped from schema/enums.yaml, while the workflow quietly produced
    # editing projects. Pin the round-trip, not just the string.
    from lib.types.project import normalize_project_type
    wf = json.loads((REPO_ROOT / "workflows" / "broll.json").read_text())
    assert normalize_project_type(wf["project_type"]) == "broll"


def test_select_takes_is_preceded_by_a_transcribe():
    """select-takes reads SRTs; it is useless without a transcribe upstream.

    skills/select-takes/SKILL.md step 1 is "read the SRT file for every clip
    from the preceding transcribe step". Every other workflow that uses it
    (clean_cut, overlays, floating_head) orders transcribe -> select-takes.
    Pin the edge so a future reshuffle of the vo_* chain can't strand it.
    """
    wf = json.loads((REPO_ROOT / "workflows" / "broll.json").read_text())
    by_id = {s["id"]: s for s in wf["steps"]}
    takes = next(s for s in wf["steps"] if s["uses"] == "montaj/select-takes")
    upstream = [by_id[n]["uses"] for n in takes.get("needs", [])]
    assert "montaj/transcribe" in upstream, (
        f"select-takes needs {upstream}, none of which is a transcribe")


def test_voiceover_chain_does_not_re_extract_audio():
    """The vo_* chain must run on project.voiceover.src directly.

    extract_audio's wav preset is -ar 16000 -ac 1 (sized for whisper), and its
    default out path is {stem}.wav — which collides with the input for a .wav
    voiceover and makes ffmpeg exit ("cannot edit existing files in-place").
    Every step in the chain already accepts the source file or a trim spec, so
    the extraction is both lossy and unnecessary.
    """
    wf = json.loads((REPO_ROOT / "workflows" / "broll.json").read_text())
    assert "montaj/extract_audio" not in [s["uses"] for s in wf["steps"]]


def test_broll_skill_frontmatter():
    text = (REPO_ROOT / "skills" / "broll" / "SKILL.md").read_text()
    assert text.startswith("---")
    fm = text.split("---")[1]
    assert "name: broll" in fm
    assert "step: true" in fm
