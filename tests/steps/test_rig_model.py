"""Tests for rig_model on Tripo (§246 U3): where the model comes from (its generation
task or an upload), the free riggability check and not_riggable, which rig model and
bone naming each rig type gets, the exact request bodies, the resume record, and the
step's argument checks and fail codes. No network: the connector's HTTP functions are
monkeypatched (the requests-layer flow is in tests/test_connectors_tripo.py).

Tripo payloads are Tripo's own, captured in one paid run on 2026-10-18 and loaded from
tests/fixtures/tripo/captures (README there): the finished rig task (25.0 credits) and
the finished rig check (free, riggable biped). Every other check answer is built from
that captured output with another field ("built from the documented shape, not captured":
the run got only riggable: true). The ids in the stubs (task_check, task_rig, task_gen,
...) are placeholders for the values the monkeypatched functions return, not responses;
the requests-layer tests in tests/test_connectors_tripo.py use the captured ids.
"""
import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from connectors import (ConnectorError, CONTENT_REFUSED, INSUFFICIENT_CREDIT,  # noqa: E402
                        INVALID_API_KEY)
import connectors.tripo as tripo  # noqa: E402
from lib.glb_textures import GlbTextureError  # noqa: E402
from tests.tripo_captures import captured  # noqa: E402

_STEP_PATH = REPO_ROOT / "steps" / "generate" / "rig_model.py"
_SCHEMA_PATH = REPO_ROOT / "steps" / "generate" / "rig_model.json"

# captured 2026-10-18: GET /tasks/{id} for a finished biped rig (25.0 credits) and for the
# finished free rig check before it
RIG_TASK = captured("task-rig-success")["data"]
CHECK_TASK = captured("task-rig-check-success")["data"]
CHECK_BIPED = CHECK_TASK["output"]


def _check(**fields):
    """Built from the documented shape, not captured: the captured check output with other
    fields. The run got only {riggable: true, rig_type: biped}."""
    return {**CHECK_BIPED, **fields}


REPORT = {"reencoded": 0, "formats": {}}

BIPED = ("v1.0-20240301", "mixamo")
CREATURE = ("v2.5-20260210", "tripo")


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(tripo.time, "sleep", lambda s: None)


# ---------------------------------------------------------------------------
# The tables
# ---------------------------------------------------------------------------

def test_rig_models_follow_the_rig_type():
    assert tripo.RIG_TYPES == ("biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic")
    assert tripo.RIG_MODELS["biped"] == {"model": "v1.0-20240301", "spec": "mixamo"}
    for t in ("quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic"):
        assert tripo.RIG_MODELS[t] == {"model": "v2.5-20260210", "spec": "tripo"}
    assert set(tripo.RIG_MODELS) == set(tripo.RIG_TYPES)


def test_animation_presets_are_the_documented_lists():
    # animations-retarget.md, read 2026-10-13
    p = tripo.ANIMATION_PRESETS
    v1 = p["v1.0-20240301"]
    assert set(v1) == {"biped"} and len(v1["biped"]) == 101 == len(set(v1["biped"]))
    assert all(i.startswith("preset:biped:") for i in v1["biped"])
    assert {"preset:biped:walk", "preset:biped:idle", "preset:biped:dance_06", "preset:biped:press-up",
            "preset:biped:wave_goodbye_02"} <= set(v1["biped"])
    v2 = p["v2.5-20260210"]
    assert v2["biped"] == ("preset:idle", "preset:walk", "preset:run", "preset:dive", "preset:climb",
                           "preset:jump", "preset:slash", "preset:shoot", "preset:hurt", "preset:fall",
                           "preset:turn")
    assert v2["quadruped"] == ("preset:quadruped:walk",)
    assert v2["hexapod"] == ("preset:hexapod:walk",)
    assert v2["octopod"] == ("preset:octopod:walk",)
    assert v2["serpentine"] == ("preset:serpentine:march",)
    assert v2["aquatic"] == ("preset:aquatic:march",)
    assert "avian" not in v2, "the page lists no avian preset"


# ---------------------------------------------------------------------------
# rig_model: order of calls, source, check, rig model, the record
# ---------------------------------------------------------------------------

@pytest.fixture
def vendor(monkeypatch):
    """tripo's HTTP functions replaced by recorders. `events` is the order of calls."""
    state = {"events": [], "creates": [], "uploads": [], "waits": [], "ids": ["task_check", "task_rig"],
             "check": dict(CHECK_BIPED), "task": dict(RIG_TASK), "wait_error": None,
             "download_error": None, "guard_error": None, "sidecar_at_wait": None,
             "sidecar_reader": lambda: None, "hints": [], "deadlines": [], "create_errors": {}}

    def upload(path):
        state["events"].append("upload")
        state["uploads"].append(path)
        return f"file_{Path(path).stem}"

    def create(endpoint, body, *, free=False):
        assert free == (endpoint == "/animations/rig-check"), "only the free check may be repeated"
        state["events"].append(f"create:{endpoint}")
        state["creates"].append((endpoint, body))
        error = state["create_errors"].get(body.get("input")) if endpoint == "/animations/rig-check" else None
        if error:
            raise error
        return state["ids"].pop(0)

    def wait(task_id, *, resumable=True, deadline=None, resume_hint=None):
        state["events"].append(f"wait:{task_id}")
        state["waits"].append((task_id, resumable))
        state["hints"].append(resume_hint)
        state["deadlines"].append(deadline)
        if task_id in state.get("check_errors", {}):
            raise state["check_errors"].pop(task_id)
        if task_id.startswith("task_check"):
            return dict(CHECK_TASK, task_id=task_id, output=state["check"])
        state["sidecar_at_wait"] = state["sidecar_reader"]()
        if state["wait_error"]:
            raise state["wait_error"]
        return dict(state["task"], task_id=task_id)

    def download(url, out_path, *, deadline=None):
        state["events"].append("download")
        state["deadlines"].append(deadline)
        if state["download_error"]:
            raise state["download_error"]
        Path(out_path).write_bytes(b"glTF-rigged")
        return out_path

    def guard(path):
        state["events"].append(f"guard:{Path(path).name}")
        if state["guard_error"]:
            raise state["guard_error"]
        return dict(REPORT)

    monkeypatch.setattr(tripo, "upload", upload)
    monkeypatch.setattr(tripo, "create", create)
    monkeypatch.setattr(tripo, "wait", wait)
    monkeypatch.setattr(tripo, "download", download)
    monkeypatch.setattr(tripo, "ensure_supported_textures", guard)
    return state


def _sidecar(out):
    return Path(str(out) + ".tripo.json")


def _model(tmp_path, name="robot.glb", sidecar=None):
    """A .glb, with the record generate_model leaves beside it unless `sidecar` says otherwise."""
    glb = tmp_path / name
    glb.write_bytes(b"glTF-source")
    if sidecar is None:
        sidecar = {"task_id": "task_gen", "kind": "model", "model": "v3.1-20260211",
                   "endpoint": "/generation/text-to-model", "created": "2026-10-13T10:00:00+00:00",
                   "credits_consumed": 20.0}
    if isinstance(sidecar, dict):
        _sidecar(glb).write_text(json.dumps(sidecar))
    elif isinstance(sidecar, str):
        _sidecar(glb).write_text(sidecar)
    return glb


def test_a_generated_model_is_rigged_from_its_task_and_the_check_comes_first(vendor, tmp_path):
    src, out = _model(tmp_path), tmp_path / "rigged.glb"
    vendor["sidecar_reader"] = lambda: json.loads(_sidecar(out).read_text()) if _sidecar(out).exists() else None

    result = tripo.rig_model(model_path=str(src), out_path=str(out))

    assert vendor["events"] == [
        "create:/animations/rig-check", "wait:task_check", "create:/animations/rig", "wait:task_rig",
        "download", "guard:rigged.glb.download"]
    assert vendor["uploads"] == []
    assert vendor["creates"][0] == ("/animations/rig-check", {"input": "task_gen"})
    assert vendor["waits"][0] == ("task_check", False), "a free check is never resumed with --task-id"
    assert vendor["waits"][1] == ("task_rig", True)
    assert vendor["creates"][1] == ("/animations/rig", {
        "input": "task_gen", "model": "v1.0-20240301", "rig_type": "biped", "spec": "mixamo", "out_format": "glb"})
    at_wait = vendor["sidecar_at_wait"]
    assert at_wait is not None, "the rig task must be recorded before polling"
    assert {k: at_wait[k] for k in ("task_id", "kind", "rig_model", "rig_type", "spec", "source_task_id")} == {
        "task_id": "task_rig", "kind": "rig", "rig_model": "v1.0-20240301", "rig_type": "biped",
        "spec": "mixamo", "source_task_id": "task_gen"}
    datetime.fromisoformat(at_wait["created"])
    assert "credits_consumed" not in at_wait
    assert result == {"path": str(out), "taskId": "task_rig", "rigType": "biped", "rigModel": "v1.0-20240301",
                      "spec": "mixamo", "creditsUsed": 25.0, "textures": REPORT}
    assert json.loads(_sidecar(out).read_text())["credits_consumed"] == 25.0
    assert out.read_bytes() == b"glTF-rigged"
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "rigged.glb", "rigged.glb.tripo.json", "robot.glb", "robot.glb.tripo.json"]


@pytest.mark.parametrize("sidecar,why", [
    (False, "no record"),
    ({"task_id": "task_gen", "kind": "model", "model": "v3.1-20260211"}, "a generation still unfinished"),
    ({"task_id": "task_rig0", "kind": "rig", "rig_type": "biped", "credits_consumed": 25.0}, "a rig is not a generation"),
    ({"task_id": "task_anim0", "kind": "animation", "credits_consumed": 20.0}, "an animation is not a generation"),
    ("{not json", "an unreadable record"),
])
def test_any_other_glb_is_uploaded_and_its_file_token_is_the_input(vendor, tmp_path, sidecar, why):
    src, out = _model(tmp_path, "hero.glb", sidecar=sidecar), tmp_path / "rigged.glb"
    tripo.rig_model(model_path=str(src), out_path=str(out))
    assert vendor["uploads"] == [str(src)], why
    assert vendor["creates"][0] == ("/animations/rig-check", {"input": "file_hero"})
    assert vendor["creates"][1][1]["input"] == "file_hero"
    assert json.loads(_sidecar(out).read_text())["source_task_id"] is None


def test_an_unreadable_record_beside_the_source_warns_and_uploads(vendor, tmp_path, capsys):
    src = _model(tmp_path, "hero.glb", sidecar="{not json")
    tripo.rig_model(model_path=str(src), out_path=str(tmp_path / "rigged.glb"))
    assert "unreadable" in capsys.readouterr().err and vendor["uploads"] == [str(src)]


@pytest.mark.parametrize("rig_type,model,spec", [
    ("biped", *BIPED), ("quadruped", *CREATURE), ("hexapod", *CREATURE), ("octopod", *CREATURE),
    ("avian", *CREATURE), ("serpentine", *CREATURE), ("aquatic", *CREATURE)])
def test_the_rig_model_and_bone_naming_follow_the_checked_type(vendor, tmp_path, rig_type, model, spec):
    vendor["check"] = _check(rig_type=rig_type)
    out = tmp_path / "rigged.glb"
    asked = "avian" if rig_type == "avian" else None    # avian only when asked for by name
    result = tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(out), rig_type=asked)
    _, body = vendor["creates"][1]
    assert body == {"input": "task_gen", "model": model, "rig_type": rig_type, "spec": spec, "out_format": "glb"}
    assert (result["rigType"], result["rigModel"], result["spec"]) == (rig_type, model, spec)
    record = json.loads(_sidecar(out).read_text())
    assert (record["rig_type"], record["rig_model"], record["spec"]) == (rig_type, model, spec)


def test_a_recommended_avian_rig_is_refused_before_any_rig_task(vendor, tmp_path):
    # animations-retarget.md (read 2026-10-13) lists no avian preset: such a rig could never be animated.
    vendor["check"] = _check(rig_type="avian")
    out = tmp_path / "rigged.glb"
    with pytest.raises(tripo.InvalidInput) as e:
        tripo.rig_model(model_path=str(_model(tmp_path, "bird.glb")), out_path=str(out))
    message = str(e.value)
    assert "recommends an avian rig for bird.glb" in message and "no preset animations" in message
    assert "Nothing was spent" in message and "pass rig type avian" in message
    assert vendor["events"] == ["create:/animations/rig-check", "wait:task_check"]
    assert not out.exists() and not _sidecar(out).exists()


def test_an_avian_rig_asked_for_by_name_is_made_and_says_it_has_no_presets(vendor, tmp_path, capsys):
    vendor["check"] = _check(rig_type="avian")
    result = tripo.rig_model(model_path=str(_model(tmp_path, "bird.glb")), out_path=str(tmp_path / "r.glb"),
                             rig_type="avian")
    assert vendor["creates"][1][1]["rig_type"] == "avian"
    assert result["rigType"] == "avian" and "no preset animations" in result["note"]
    assert "no preset animations" in capsys.readouterr().err


def test_a_rig_with_presets_has_no_note(vendor, tmp_path):
    assert "note" not in tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(tmp_path / "r.glb"))


def test_waits_carry_the_rig_hint_and_share_one_deadline(vendor, tmp_path):
    tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(tmp_path / "r.glb"))
    assert vendor["waits"] == [("task_check", False), ("task_rig", True)]
    assert vendor["hints"] == [None, "--task-id task_rig --rig-type biped"], "the free check has nothing to collect"
    check_deadline, rig_deadline, download_deadline = vendor["deadlines"]
    assert check_deadline == rig_deadline == download_deadline is not None


def test_a_resumed_rig_hint_names_its_rig_type_when_known(vendor, tmp_path):
    tripo.resume_rig("task_given", str(tmp_path / "a.glb"), rig_type="hexapod")
    tripo.resume_rig("task_other", str(tmp_path / "b.glb"))
    assert vendor["hints"] == ["--task-id task_given --rig-type hexapod", "--task-id task_other"]


def test_a_source_task_the_check_refuses_is_uploaded_and_checked_again(vendor, tmp_path, capsys):
    vendor["create_errors"] = {"task_gen": ConnectorError("Tripo submit failed (HTTP 400, code 2002): expired")}
    vendor["ids"] = ["task_check2", "task_rig"]
    src, out = _model(tmp_path), tmp_path / "rigged.glb"
    tripo.rig_model(model_path=str(src), out_path=str(out))
    assert vendor["events"] == [
        "create:/animations/rig-check", "upload", "create:/animations/rig-check", "wait:task_check2",
        "create:/animations/rig", "wait:task_rig", "download", "guard:rigged.glb.download"]
    assert vendor["creates"][-1][1]["input"] == "file_robot"
    assert json.loads(_sidecar(out).read_text())["source_task_id"] is None
    assert "could not use task task_gen" in capsys.readouterr().err


def test_an_uploaded_source_the_check_refuses_is_not_uploaded_twice(vendor, tmp_path):
    src = _model(tmp_path, "hero.glb", sidecar=False)
    vendor["create_errors"] = {"file_hero": ConnectorError("Tripo submit failed (HTTP 400, code 2002): bad file")}
    with pytest.raises(ConnectorError, match="bad file"):
        tripo.rig_model(model_path=str(src), out_path=str(tmp_path / "r.glb"))
    assert vendor["events"] == ["upload", "create:/animations/rig-check"]


def test_an_explicit_rig_type_overrides_the_checks_recommendation(vendor, tmp_path, capsys):
    vendor["check"] = _check()
    tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(tmp_path / "r.glb"), rig_type="Quadruped")
    assert vendor["creates"][1][1]["rig_type"] == "quadruped"
    assert vendor["creates"][1][1]["model"] == "v2.5-20260210" and vendor["creates"][1][1]["spec"] == "tripo"
    assert "recommends a biped rig" in capsys.readouterr().err


def test_an_explicit_rig_type_that_agrees_says_nothing(vendor, tmp_path, capsys):
    tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(tmp_path / "r.glb"), rig_type="biped")
    assert capsys.readouterr().err == ""


def test_a_rig_type_is_needed_only_when_the_check_names_none(vendor, tmp_path):
    vendor["check"] = {"riggable": True}    # built: the captured output without its rig_type
    with pytest.raises(ConnectorError, match="named no rig type"):
        tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(tmp_path / "r.glb"))
    assert vendor["events"] == ["create:/animations/rig-check", "wait:task_check"]
    vendor["ids"] = ["task_check", "task_rig"]
    result = tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(tmp_path / "r.glb"), rig_type="avian")
    assert result["rigType"] == "avian"


def test_a_type_montaj_does_not_know_is_not_guessed(vendor, tmp_path):
    vendor["check"] = _check(rig_type="centaur")
    with pytest.raises(ConnectorError, match="'centaur'.*Pass the rig type yourself"):
        tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(tmp_path / "r.glb"))
    assert not any(e.startswith("create:/animations/rig") and e != "create:/animations/rig-check"
                   for e in vendor["events"])


@pytest.mark.parametrize("rig_type", [None, "biped", "avian"])
def test_a_not_riggable_model_makes_no_rig_task_whatever_type_was_asked(vendor, tmp_path, rig_type):
    # Built from the documented shape, not captured: the captured check with riggable false.
    vendor["check"] = _check(riggable=False, rig_type="quadruped")
    out = tmp_path / "rigged.glb"
    with pytest.raises(tripo.NotRiggable) as e:
        tripo.rig_model(model_path=str(_model(tmp_path, "rock.glb")), out_path=str(out), rig_type=rig_type)
    assert "rock.glb" in str(e.value) and "riggable: false" in str(e.value)
    assert "recommended rig type: quadruped" in str(e.value) and "Nothing was spent" in str(e.value)
    assert e.value.rig_type == "quadruped"
    assert vendor["events"] == ["create:/animations/rig-check", "wait:task_check"]
    assert not out.exists() and not _sidecar(out).exists()


def test_a_check_with_no_answer_is_not_taken_for_a_yes(vendor, tmp_path):
    vendor["check"] = {}    # built: an output with neither field
    with pytest.raises(ConnectorError, match="returned no answer") as e:
        tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(tmp_path / "r.glb"))
    assert not isinstance(e.value, tripo.NotRiggable)
    assert vendor["events"] == ["create:/animations/rig-check", "wait:task_check"]


def test_a_retry_with_the_same_out_reattaches_without_a_new_check_or_task(vendor, tmp_path, capsys):
    out = tmp_path / "rigged.glb"
    record = {"task_id": "task_earlier", "kind": "rig", "rig_model": "v1.0-20240301", "rig_type": "biped",
              "spec": "mixamo", "source_task_id": "task_gen", "created": "2026-10-13T10:00:00+00:00"}
    _sidecar(out).write_text(json.dumps(record))

    result = tripo.rig_model(model_path=str(tmp_path / "gone.glb"), out_path=str(out), rig_type="quadruped")

    assert vendor["events"] == ["wait:task_earlier", "download", "guard:rigged.glb.download"]
    assert result["taskId"] == "task_earlier" and result["rigType"] == "biped" and result["spec"] == "mixamo"
    assert json.loads(_sidecar(out).read_text()) == {**record, "credits_consumed": 25.0}
    assert "Re-attaching to Tripo task task_earlier" in capsys.readouterr().err


def test_task_id_collects_a_rig_with_no_new_task(vendor, tmp_path):
    out = tmp_path / "rigged.glb"
    vendor["sidecar_reader"] = lambda: json.loads(_sidecar(out).read_text())
    result = tripo.resume_rig("task_given", str(out), rig_type="quadruped")
    assert vendor["events"] == ["wait:task_given", "download", "guard:rigged.glb.download"]
    record = vendor["sidecar_at_wait"]
    assert (record["task_id"], record["kind"], record["rig_type"], record["rig_model"], record["spec"]) == (
        "task_given", "rig", "quadruped", "v2.5-20260210", "tripo")
    assert result["rigType"] == "quadruped" and result["spec"] == "tripo"


def test_task_id_without_a_rig_type_leaves_the_record_not_knowing_the_rig(vendor, tmp_path):
    out = tmp_path / "rigged.glb"
    result = tripo.resume_rig("task_given", str(out))
    assert (result["rigType"], result["rigModel"], result["spec"]) == (None, None, None)
    record = json.loads(_sidecar(out).read_text())
    assert record["kind"] == "rig" and record["rig_type"] is None


def test_task_id_keeps_what_the_record_for_the_same_task_says(vendor, tmp_path):
    out = tmp_path / "rigged.glb"
    record = {"task_id": "task_given", "kind": "rig", "rig_model": "v1.0-20240301", "rig_type": "biped",
              "spec": "mixamo", "source_task_id": "task_gen", "created": "2026-10-13T10:00:00+00:00"}
    _sidecar(out).write_text(json.dumps(record))
    assert tripo.resume_rig("task_given", str(out))["rigType"] == "biped"


@pytest.mark.parametrize("call", ["rig", "resume"])
def test_an_existing_out_is_never_overwritten(vendor, tmp_path, call):
    out = tmp_path / "rigged.glb"
    out.write_bytes(b"MINE")
    with pytest.raises(ConnectorError, match="already exists"):
        if call == "rig":
            tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(out))
        else:
            tripo.resume_rig("task_x", str(out))
    assert vendor["events"] == [] and out.read_bytes() == b"MINE"


@pytest.mark.parametrize("kwargs,message", [
    ({"rig_type": "centaur"}, "rig types are biped, quadruped"),
    ({"out_path": "rigged.fbx"}, "must end in .glb"),
])
def test_bad_input_costs_no_upload_and_no_call(vendor, tmp_path, kwargs, message):
    kwargs = dict(kwargs)
    if "out_path" in kwargs:
        kwargs["out_path"] = str(tmp_path / kwargs["out_path"])
    args = {"model_path": str(_model(tmp_path)), "out_path": str(tmp_path / "r.glb"), **kwargs}
    with pytest.raises(ConnectorError, match=message):
        tripo.rig_model(**args)
    assert vendor["events"] == []


def test_the_model_must_exist_and_be_a_glb(vendor, tmp_path):
    with pytest.raises(tripo.InvalidInput, match="Model not found"):
        tripo.rig_model(model_path=str(tmp_path / "nope.glb"), out_path=str(tmp_path / "r.glb"))
    fbx = tmp_path / "hero.fbx"
    fbx.write_bytes(b"x")
    with pytest.raises(tripo.InvalidInput, match="must be a .glb"):
        tripo.rig_model(model_path=str(fbx), out_path=str(tmp_path / "r.glb"))
    assert vendor["events"] == []


def test_a_record_of_another_kind_at_out_is_refused(vendor, tmp_path):
    out = tmp_path / "rigged.glb"
    _sidecar(out).write_text(json.dumps({"task_id": "task_gen", "kind": "model"}))
    with pytest.raises(ConnectorError, match="records a Tripo model task, not a rig"):
        tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(out))
    assert vendor["events"] == []


def test_a_rig_that_ended_drops_its_record_so_a_retry_submits_again(vendor, tmp_path):
    out = tmp_path / "rigged.glb"
    src = _model(tmp_path)
    vendor["wait_error"] = tripo._TaskEnded("Tripo task task_rig failed (2018: Model too complex).")
    with pytest.raises(ConnectorError, match="Model too complex"):
        tripo.rig_model(model_path=str(src), out_path=str(out))
    assert not _sidecar(out).exists() and not out.exists()

    vendor["wait_error"], vendor["ids"] = None, ["task_check", "task_rig"]
    vendor["check"] = dict(CHECK_BIPED)
    tripo.rig_model(model_path=str(src), out_path=str(out))
    assert [e for e in vendor["events"] if e.startswith("create:")].count("create:/animations/rig") == 2


def test_a_run_that_stops_waiting_keeps_its_record(vendor, tmp_path):
    out = tmp_path / "rigged.glb"
    vendor["wait_error"] = ConnectorError("Tripo task task_rig is still running after 840 s.")
    with pytest.raises(ConnectorError, match="still running"):
        tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(out))
    assert json.loads(_sidecar(out).read_text())["task_id"] == "task_rig" and not out.exists()


def test_a_failed_download_names_the_task_to_collect(vendor, tmp_path):
    out = tmp_path / "rigged.glb"
    vendor["download_error"] = ConnectorError("Tripo download failed (HTTP 404): https://cdn.tripo3d.ai/x.glb")
    with pytest.raises(ConnectorError, match="--task-id task_rig --rig-type biped \\(no new charge\\)") as e:
        tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(out))
    assert "generat" not in str(e.value)
    assert not out.exists() and _sidecar(out).exists()


def test_a_rigged_model_the_guard_refuses_never_lands_at_out(vendor, tmp_path):
    out = tmp_path / "rigged.glb"
    vendor["guard_error"] = GlbTextureError("image 0 is stored outside the file (a.png)", "external")
    with pytest.raises(tripo.UnsupportedModel, match="can't use: image 0 is stored outside") as e:
        tripo.rig_model(model_path=str(_model(tmp_path)), out_path=str(out))
    assert e.value.task_id == "task_rig" and not out.exists()
    assert e.value.kept == str(tmp_path / "rigged.unsupported.glb")


# ---------------------------------------------------------------------------
# The step
# ---------------------------------------------------------------------------

@pytest.fixture
def step_module():
    spec = importlib.util.spec_from_file_location("rig_model_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _result(path, task="task_rig", rig_type="biped"):
    rig = tripo.RIG_MODELS[rig_type]
    return {"path": path, "taskId": task, "rigType": rig_type, "rigModel": rig["model"], "spec": rig["spec"],
            "creditsUsed": 25.0, "textures": REPORT}


def _run(step_module, monkeypatch, argv):
    monkeypatch.setattr(sys, "argv", ["rig_model.py", *argv])
    step_module.main()


@pytest.fixture
def calls(monkeypatch):
    seen = {"rig": [], "resume": []}

    def rig(**kw):
        seen["rig"].append(kw)
        return _result(kw["out_path"], rig_type=kw["rig_type"] or "biped")

    def resume(task_id, out, rig_type=None):
        seen["resume"].append((task_id, out, rig_type))
        return _result(out, task_id, rig_type or "biped")

    monkeypatch.setattr(tripo, "rig_model", rig)
    monkeypatch.setattr(tripo, "resume_rig", resume)
    return seen


def test_step_rigs_with_the_checks_type_by_default(step_module, monkeypatch, capsys, calls, tmp_path):
    src, out = tmp_path / "robot.glb", str(tmp_path / "rigged.glb")
    src.write_bytes(b"x")
    _run(step_module, monkeypatch, ["--model", str(src), "--out", out, "--json"])
    assert json.loads(capsys.readouterr().out) == _result(out)
    assert calls["rig"] == [{"model_path": str(src), "out_path": out, "rig_type": None}]


def test_step_without_json_prints_the_path_and_passes_the_rig_type(step_module, monkeypatch, capsys, calls, tmp_path):
    src, out = tmp_path / "robot.glb", str(tmp_path / "rigged.glb")
    src.write_bytes(b"x")
    _run(step_module, monkeypatch, ["--model", str(src), "--out", out, "--rig-type", "quadruped"])
    assert capsys.readouterr().out.strip() == out
    assert calls["rig"][0]["rig_type"] == "quadruped"


def test_step_task_id_resumes_without_a_new_task_and_needs_no_local_model(step_module, monkeypatch, capsys, calls, tmp_path):
    out = str(tmp_path / "rigged.glb")
    _run(step_module, monkeypatch, ["--model", str(tmp_path / "moved.glb"), "--out", out, "--task-id", "task_9",
                                    "--rig-type", "hexapod"])
    assert calls["resume"] == [("task_9", out, "hexapod")] and calls["rig"] == []
    assert capsys.readouterr().out.strip() == out


def test_step_task_id_needs_no_model_at_all(step_module, monkeypatch, capsys, calls, tmp_path):
    out = str(tmp_path / "rigged.glb")
    _run(step_module, monkeypatch, ["--out", out, "--task-id", "task_9", "--rig-type", "biped"])
    assert calls["resume"] == [("task_9", out, "biped")]


def test_step_without_task_id_needs_a_model(step_module, monkeypatch, capsys, calls, tmp_path):
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--out", str(tmp_path / "r.glb")])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "invalid_args" and "--model is required" in err["message"]
    assert calls["rig"] == [] and calls["resume"] == []


def test_step_missing_or_non_glb_model(step_module, monkeypatch, capsys, calls, tmp_path):
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", str(tmp_path / "nope.glb"), "--out", str(tmp_path / "r.glb")])
    assert json.loads(capsys.readouterr().err)["error"] == "file_not_found"
    fbx = tmp_path / "hero.fbx"
    fbx.write_bytes(b"x")
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", str(fbx), "--out", str(tmp_path / "r.glb")])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "invalid_args" and ".glb" in err["message"]
    assert calls["rig"] == []


def test_step_rig_type_is_one_of_the_seven(step_module, monkeypatch, capsys, calls, tmp_path):
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", "m.glb", "--out", str(tmp_path / "r.glb"), "--rig-type", "centaur"])
    assert "invalid choice" in capsys.readouterr().err and calls["rig"] == []


@pytest.mark.parametrize("extra", [[], ["--task-id", "task_9"]])
def test_step_refuses_to_overwrite_an_existing_out(step_module, monkeypatch, capsys, calls, tmp_path, extra):
    out = tmp_path / "r.glb"
    out.write_bytes(b"MINE")
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", "m.glb", "--out", str(out), *extra])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "invalid_out" and "already exists" in err["message"]
    assert out.read_bytes() == b"MINE" and calls["rig"] == [] and calls["resume"] == []


def test_step_out_must_be_a_glb(step_module, monkeypatch, capsys, calls, tmp_path):
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", "m.glb", "--out", str(tmp_path / "r.fbx")])
    assert json.loads(capsys.readouterr().err)["error"] == "invalid_out"


@pytest.mark.parametrize("reason,code", [(INVALID_API_KEY, "invalid_api_key"),
                                         (INSUFFICIENT_CREDIT, "insufficient_credit"),
                                         (CONTENT_REFUSED, "content_refused"),
                                         (None, "api_error")])
def test_step_failures_map_to_their_codes(step_module, monkeypatch, capsys, tmp_path, reason, code):
    src = tmp_path / "m.glb"
    src.write_bytes(b"x")

    def boom(**kw):
        raise ConnectorError("Tripo refused it", reason=reason)
    monkeypatch.setattr(tripo, "rig_model", boom)
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", str(src), "--out", str(tmp_path / "r.glb")])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == code and "Tripo" in err["message"]


@pytest.mark.parametrize("exc,code", [
    (tripo.NotRiggable("Tripo's riggability check says rock.glb can't be rigged (riggable: false)."), "not_riggable"),
    (tripo.InvalidInput("Tripo rig types are biped, quadruped; got 'x'"), "invalid_args"),
    (tripo.UnsupportedModel("Tripo returned a compressed model; Montaj needs it uncompressed (task t).",
                            "compressed", "task_rig"), "unsupported_model"),
])
def test_step_maps_its_own_failures(step_module, monkeypatch, capsys, tmp_path, exc, code):
    src = tmp_path / "m.glb"
    src.write_bytes(b"x")

    def boom(**kw):
        raise exc
    monkeypatch.setattr(tripo, "rig_model", boom)
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", str(src), "--out", str(tmp_path / "r.glb")])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == code and err["message"] == str(exc)


def test_step_schema():
    schema = json.loads(_SCHEMA_PATH.read_text())
    assert schema["name"] == "rig_model" and schema["output"]["type"] == "model"
    by_name = {p["name"]: p for p in schema["params"]}
    assert set(by_name) == {"model", "out", "rig-type", "task-id"}
    assert by_name["model"]["required"] is False, "task-id collects a rig with no model"
    assert by_name["out"]["required"]
    assert by_name["rig-type"]["options"] == list(tripo.RIG_TYPES)
    assert "task-id" in schema["description"] and "no new charge" in schema["description"]
    assert "same --out" not in schema["description"]


def test_project_out_is_a_glb_in_the_assets_folder(tmp_path, monkeypatch):
    import re
    import serve.routes.steps as steps_mod
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-13-robots"
    pdir.mkdir(parents=True)
    (pdir / "project.json").write_text(json.dumps({"id": "p-1", "tracks": []}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    monkeypatch.setattr(steps_mod, "_RESERVED_OUTS", set())
    schema = json.loads(_SCHEMA_PATH.read_text())
    body = {"model": "/x/robot.glb", "_project": str(pdir)}
    out = steps_mod.resolve_project_out("rig_model", schema, body)
    assert re.fullmatch(re.escape(str(pdir.resolve() / "assets")) + r"/rig_model-\d{8}-\d{6}\.glb", out)
