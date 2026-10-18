"""Tests for animate_model on Tripo (§246 U3): a rigged model only, preset ids checked
per rig model and rig type before any call, the 1 to 5 bound, `animation` for one id
and `animations` for several, the exact retarget body, the resume record, and the
step's argument checks and fail codes. No network: the connector's HTTP functions are
monkeypatched (the requests-layer flow is in tests/test_connectors_tripo.py).

Tripo payloads are Tripo's own, captured in one paid run on 2026-10-18 and loaded from
tests/fixtures/tripo/captures (README there): the finished retarget task (two presets,
in place, 20.0 credits). The ids in the stubs (task_anim, task_rig, task_gen, ...) are
placeholders for the values the monkeypatched functions return, not responses; the
requests-layer tests in tests/test_connectors_tripo.py use the captured ids.
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

_STEP_PATH = REPO_ROOT / "steps" / "generate" / "animate_model.py"
_SCHEMA_PATH = REPO_ROOT / "steps" / "generate" / "animate_model.json"

# captured 2026-10-18: GET /tasks/{id} for a finished retarget (walk and wave_goodbye_01, in place)
TASK = captured("task-retarget-success")["data"]

REPORT = {"reencoded": 0, "formats": {}}

V1, V25 = "v1.0-20240301", "v2.5-20260210"


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(tripo.time, "sleep", lambda s: None)


@pytest.fixture
def vendor(monkeypatch):
    """tripo's HTTP functions replaced by recorders. `events` is the order of calls."""
    state = {"events": [], "creates": [], "task": dict(TASK), "wait_error": None, "download_error": None,
             "guard_error": None, "sidecar_at_wait": None, "sidecar_reader": lambda: None, "hints": []}

    def upload(path):
        state["events"].append("upload")
        return "file_x"

    def create(endpoint, body):
        state["events"].append(f"create:{endpoint}")
        state["creates"].append((endpoint, body))
        return "task_anim"

    def wait(task_id, *, resumable=True, deadline=None, resume_hint=None):
        state["events"].append(f"wait:{task_id}")
        state["hints"].append(resume_hint)
        state["sidecar_at_wait"] = state["sidecar_reader"]()
        if state["wait_error"]:
            raise state["wait_error"]
        return dict(state["task"], task_id=task_id)

    def download(url, out_path, *, deadline=None):
        state["events"].append("download")
        if state["download_error"]:
            raise state["download_error"]
        Path(out_path).write_bytes(b"glTF-animated")
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


def _rigged(tmp_path, name="rigged.glb", rig_type="biped", rig_model=V1, **overrides):
    """A model as rig_model leaves it: the .glb and its finished rig record."""
    glb = tmp_path / name
    glb.write_bytes(b"glTF-rigged")
    record = {"task_id": "task_rig", "kind": "rig", "rig_model": rig_model, "rig_type": rig_type,
              "spec": "mixamo" if rig_type == "biped" else "tripo", "source_task_id": "task_gen",
              "created": "2026-10-13T10:00:00+00:00", "credits_consumed": 25.0}
    record.update(overrides)
    _sidecar(glb).write_text(json.dumps(record))
    return glb


# ---------------------------------------------------------------------------
# animate_model: the request
# ---------------------------------------------------------------------------

def test_one_animation_is_sent_as_animation_with_the_baked_in_place_options(vendor, tmp_path):
    src, out = _rigged(tmp_path), tmp_path / "walk.glb"
    vendor["sidecar_reader"] = lambda: json.loads(_sidecar(out).read_text()) if _sidecar(out).exists() else None

    result = tripo.animate_model(model_path=str(src), out_path=str(out), animations=["preset:biped:walk"])

    assert vendor["events"] == ["create:/animations/retarget", "wait:task_anim", "download", "guard:walk.glb.download"]
    assert vendor["creates"] == [("/animations/retarget", {
        "input": "task_rig", "animation": "preset:biped:walk", "out_format": "glb",
        "bake_animation": True, "export_with_geometry": True, "animate_in_place": True})]
    at_wait = vendor["sidecar_at_wait"]
    assert at_wait is not None, "the task must be recorded before polling"
    assert {k: at_wait[k] for k in ("task_id", "kind", "animations", "in_place", "rig_task_id",
                                    "rig_model", "rig_type")} == {
        "task_id": "task_anim", "kind": "animation", "animations": ["preset:biped:walk"], "in_place": True,
        "rig_task_id": "task_rig", "rig_model": V1, "rig_type": "biped"}
    datetime.fromisoformat(at_wait["created"])
    assert "credits_consumed" not in at_wait
    assert result == {"path": str(out), "taskId": "task_anim", "animations": ["preset:biped:walk"],
                      "inPlace": True, "creditsUsed": 20.0, "textures": REPORT}
    assert json.loads(_sidecar(out).read_text())["credits_consumed"] == 20.0
    assert out.read_bytes() == b"glTF-animated"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["rigged.glb", "rigged.glb.tripo.json",
                                                          "walk.glb", "walk.glb.tripo.json"]


def test_several_animations_are_sent_as_animations_in_the_order_given(vendor, tmp_path):
    ids = ["preset:biped:idle", "preset:biped:walk", "preset:biped:run"]
    result = tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(tmp_path / "a.glb"),
                                 animations=ids)
    _, body = vendor["creates"][0]
    assert body["animations"] == ids and "animation" not in body
    assert result["animations"] == ids


def test_a_single_string_counts_as_one_animation(vendor, tmp_path):
    tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(tmp_path / "a.glb"),
                        animations="preset:biped:walk")
    assert vendor["creates"][0][1]["animation"] == "preset:biped:walk"


@pytest.mark.parametrize("in_place", [True, False])
def test_in_place_is_always_sent_and_defaults_to_true(vendor, tmp_path, in_place):
    out = tmp_path / "a.glb"
    result = tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(out),
                                 animations=["preset:biped:walk"], in_place=in_place)
    assert vendor["creates"][0][1]["animate_in_place"] is in_place
    assert result["inPlace"] is in_place and json.loads(_sidecar(out).read_text())["in_place"] is in_place


def test_in_place_defaults_to_true_when_not_given(vendor, tmp_path):
    tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(tmp_path / "a.glb"),
                        animations=["preset:biped:walk"])
    assert vendor["creates"][0][1]["animate_in_place"] is True


@pytest.mark.parametrize("bad", ["yes", 1, None])
def test_in_place_must_be_a_real_boolean(vendor, tmp_path, bad):
    with pytest.raises(tripo.InvalidInput, match="in_place must be true or false"):
        tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(tmp_path / "a.glb"),
                            animations=["preset:biped:walk"], in_place=bad)
    assert vendor["events"] == []


# ---------------------------------------------------------------------------
# Presets are checked against the rig, before any call
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("rig_model,rig_type,preset,ok", [
    (V1, "biped", "preset:biped:walk", True),
    (V1, "biped", "preset:biped:press-up", True),
    (V1, "biped", "preset:walk", False),            # v2.5's spelling is not v1.0's
    (V1, "biped", "preset:biped:wlak", False),      # a typo
    (V1, "biped", "preset:quadruped:walk", False),
    (V25, "quadruped", "preset:quadruped:walk", True),
    (V25, "quadruped", "preset:walk", False),
    (V25, "quadruped", "preset:hexapod:walk", False),
    (V25, "hexapod", "preset:hexapod:walk", True),
    (V25, "octopod", "preset:octopod:walk", True),
    (V25, "serpentine", "preset:serpentine:march", True),
    (V25, "serpentine", "preset:serpentine:walk", False),
    (V25, "aquatic", "preset:aquatic:march", True),
    (V25, "biped", "preset:walk", True),            # a biped rigged on v2.5 uses the short names
    (V25, "biped", "preset:biped:walk", False),
])
def test_each_preset_is_checked_against_its_rig_model_and_type(vendor, tmp_path, rig_model, rig_type, preset, ok):
    src = _rigged(tmp_path, rig_type=rig_type, rig_model=rig_model)
    run = lambda: tripo.animate_model(model_path=str(src), out_path=str(tmp_path / "a.glb"),   # noqa: E731
                                      animations=[preset])
    if ok:
        run()
        assert vendor["creates"][0][1]["animation"] == preset
    else:
        with pytest.raises(tripo.InvalidInput, match="is not a preset animation") as e:
            run()
        assert preset in str(e.value) and rig_type in str(e.value) and rig_model in str(e.value)
        assert vendor["events"] == [], "a wrong id never costs a call"


def test_a_misspelled_id_lists_the_closest_valid_ones(vendor, tmp_path):
    with pytest.raises(tripo.InvalidInput) as e:
        tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(tmp_path / "a.glb"),
                            animations=["preset:biped:wlak"])
    assert "Closest:" in str(e.value) and "preset:biped:walk" in str(e.value)
    assert "101 are valid for this rig" in str(e.value)


def test_an_id_with_no_near_match_lists_a_few_valid_ones(vendor, tmp_path):
    with pytest.raises(tripo.InvalidInput, match="Some valid ones: preset:quadruped:walk"):
        tripo.animate_model(model_path=str(_rigged(tmp_path, rig_type="quadruped", rig_model=V25)),
                            out_path=str(tmp_path / "a.glb"), animations=["zzz"])


def test_one_bad_id_among_good_ones_blocks_the_whole_call(vendor, tmp_path):
    with pytest.raises(tripo.InvalidInput, match="'preset:biped:nope'"):
        tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(tmp_path / "a.glb"),
                            animations=["preset:biped:walk", "preset:biped:nope", "preset:biped:run"])
    assert vendor["events"] == []


def test_an_avian_rig_has_no_preset_to_apply(vendor, tmp_path):
    src = _rigged(tmp_path, rig_type="avian", rig_model=V25)
    with pytest.raises(tripo.InvalidInput, match="lists no preset animations for a avian rig"):
        tripo.animate_model(model_path=str(src), out_path=str(tmp_path / "a.glb"), animations=["preset:fly"])
    assert vendor["events"] == []


@pytest.mark.parametrize("n,ok", [(0, False), (1, True), (5, True), (6, False)])
def test_one_to_five_animations(vendor, tmp_path, n, ok):
    ids = list(tripo.ANIMATION_PRESETS[V1]["biped"][:n])
    run = lambda: tripo.animate_model(model_path=str(_rigged(tmp_path)),   # noqa: E731
                                      out_path=str(tmp_path / "a.glb"), animations=ids)
    if ok:
        run()
        assert len(vendor["events"]) and ("animation" in vendor["creates"][0][1]) == (n == 1)
    else:
        with pytest.raises(tripo.InvalidInput, match=r"1 to 5 animations in one go"):
            run()
        assert vendor["events"] == []


def test_the_same_animation_twice_is_refused(vendor, tmp_path):
    with pytest.raises(tripo.InvalidInput, match="preset:biped:walk is listed twice"):
        tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(tmp_path / "a.glb"),
                            animations=["preset:biped:walk", "preset:biped:walk"])
    assert vendor["events"] == []


@pytest.mark.parametrize("bad", [None, 5, [1, 2], {"a": 1}])
def test_animations_must_be_text(vendor, tmp_path, bad):
    with pytest.raises(tripo.InvalidInput, match="list of preset ids"):
        tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(tmp_path / "a.glb"), animations=bad)
    assert vendor["events"] == []


# ---------------------------------------------------------------------------
# Only a rigged model is animated
# ---------------------------------------------------------------------------

def test_a_plain_glb_is_refused_with_the_way_forward(vendor, tmp_path):
    plain = tmp_path / "plain.glb"
    plain.write_bytes(b"glTF")
    with pytest.raises(tripo.InvalidInput, match=r"no Tripo record.*Rig it first with rig_model"):
        tripo.animate_model(model_path=str(plain), out_path=str(tmp_path / "a.glb"),
                            animations=["preset:biped:walk"])
    assert vendor["events"] == []


@pytest.mark.parametrize("record,found", [
    ({"task_id": "task_gen", "kind": "model", "credits_consumed": 20.0}, "model"),
    ({"task_id": "task_old", "kind": "animation", "credits_consumed": 20.0}, "animation"),
    ({"task_id": "task_old", "credits_consumed": 20.0}, "model"),     # an older record without a kind
])
def test_a_model_that_is_not_a_rig_is_refused(vendor, tmp_path, record, found):
    glb = tmp_path / "m.glb"
    glb.write_bytes(b"glTF")
    _sidecar(glb).write_text(json.dumps(record))
    with pytest.raises(tripo.InvalidInput, match=f"is a Tripo {found} model, not a rigged one"):
        tripo.animate_model(model_path=str(glb), out_path=str(tmp_path / "a.glb"), animations=["preset:biped:walk"])
    assert vendor["events"] == []


def test_an_unreadable_rig_record_is_refused_not_guessed(vendor, tmp_path):
    glb = _rigged(tmp_path)
    _sidecar(glb).write_text("{not json")
    with pytest.raises(tripo.InvalidInput, match="unreadable"):
        tripo.animate_model(model_path=str(glb), out_path=str(tmp_path / "a.glb"), animations=["preset:biped:walk"])
    assert vendor["events"] == []


def test_a_rig_collected_by_task_id_alone_cannot_be_checked_so_is_refused(vendor, tmp_path):
    glb = _rigged(tmp_path, rig_model=None, rig_type=None, spec=None)
    with pytest.raises(tripo.InvalidInput, match=r"does not say which rig it is.*--task-id task_rig.*--rig-type"):
        tripo.animate_model(model_path=str(glb), out_path=str(tmp_path / "a.glb"), animations=["preset:biped:walk"])
    assert vendor["events"] == []


def test_a_missing_or_non_glb_model_is_refused(vendor, tmp_path):
    with pytest.raises(tripo.InvalidInput, match="Model not found"):
        tripo.animate_model(model_path=str(tmp_path / "nope.glb"), out_path=str(tmp_path / "a.glb"),
                            animations=["preset:biped:walk"])
    assert vendor["events"] == []


# ---------------------------------------------------------------------------
# Out, the record, resume, the guard
# ---------------------------------------------------------------------------

def test_a_retry_with_the_same_out_reattaches_to_the_recorded_task(vendor, tmp_path, capsys):
    out = tmp_path / "walk.glb"
    record = {"task_id": "task_earlier", "kind": "animation", "animations": ["preset:biped:walk"],
              "in_place": False, "rig_task_id": "task_rig", "rig_model": V1, "rig_type": "biped",
              "created": "2026-10-13T10:00:00+00:00"}
    _sidecar(out).write_text(json.dumps(record))

    result = tripo.animate_model(model_path=str(tmp_path / "gone.glb"), out_path=str(out),
                                 animations=["preset:biped:run"])

    assert vendor["events"] == ["wait:task_earlier", "download", "guard:walk.glb.download"]
    assert result["taskId"] == "task_earlier" and result["animations"] == ["preset:biped:walk"]
    assert result["inPlace"] is False, "the recorded task's own settings, not this run's"
    assert json.loads(_sidecar(out).read_text()) == {**record, "credits_consumed": 20.0}
    assert "Re-attaching to Tripo task task_earlier" in capsys.readouterr().err


def test_task_id_collects_an_animation_with_no_new_task(vendor, tmp_path):
    out = tmp_path / "walk.glb"
    vendor["sidecar_reader"] = lambda: json.loads(_sidecar(out).read_text())
    result = tripo.resume_animation("task_given", str(out))
    assert vendor["events"] == ["wait:task_given", "download", "guard:walk.glb.download"]
    assert vendor["sidecar_at_wait"]["kind"] == "animation" and vendor["sidecar_at_wait"]["task_id"] == "task_given"
    assert result["taskId"] == "task_given" and result["animations"] is None and result["inPlace"] is None


def test_task_id_keeps_what_the_record_for_the_same_task_says(vendor, tmp_path):
    out = tmp_path / "walk.glb"
    _sidecar(out).write_text(json.dumps({"task_id": "task_given", "kind": "animation",
                                         "animations": ["preset:biped:run"], "in_place": True}))
    assert tripo.resume_animation("task_given", str(out))["animations"] == ["preset:biped:run"]


@pytest.mark.parametrize("call", ["animate", "resume"])
def test_an_existing_out_is_never_overwritten(vendor, tmp_path, call):
    out = tmp_path / "walk.glb"
    out.write_bytes(b"MINE")
    with pytest.raises(ConnectorError, match="already exists"):
        if call == "animate":
            tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(out),
                                animations=["preset:biped:walk"])
        else:
            tripo.resume_animation("task_x", str(out))
    assert vendor["events"] == [] and out.read_bytes() == b"MINE"


def test_out_must_be_a_glb(vendor, tmp_path):
    with pytest.raises(ConnectorError, match="must end in .glb"):
        tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(tmp_path / "a.fbx"),
                            animations=["preset:biped:walk"])
    assert vendor["events"] == []


def test_a_record_of_another_kind_at_out_is_refused(vendor, tmp_path):
    out = tmp_path / "walk.glb"
    _sidecar(out).write_text(json.dumps({"task_id": "task_rig", "kind": "rig"}))
    with pytest.raises(ConnectorError, match="records a Tripo rig task, not an animation"):
        tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(out), animations=["preset:biped:walk"])
    assert vendor["events"] == []


def test_the_rig_record_is_left_untouched(vendor, tmp_path):
    src = _rigged(tmp_path)
    before = _sidecar(src).read_text()
    tripo.animate_model(model_path=str(src), out_path=str(tmp_path / "a.glb"), animations=["preset:biped:walk"])
    assert _sidecar(src).read_text() == before and src.read_bytes() == b"glTF-rigged"


def test_one_rig_can_be_animated_again_into_another_file(vendor, tmp_path):
    src = _rigged(tmp_path)
    tripo.animate_model(model_path=str(src), out_path=str(tmp_path / "walk.glb"), animations=["preset:biped:walk"])
    tripo.animate_model(model_path=str(src), out_path=str(tmp_path / "run.glb"), animations=["preset:biped:run"])
    assert [b["input"] for _, b in vendor["creates"]] == ["task_rig", "task_rig"]


def test_a_task_that_ended_drops_its_record_so_a_retry_submits_again(vendor, tmp_path):
    out = tmp_path / "walk.glb"
    src = _rigged(tmp_path)
    vendor["wait_error"] = tripo._TaskEnded("Tripo task task_anim failed (2018: Model too complex).")
    with pytest.raises(ConnectorError, match="Model too complex"):
        tripo.animate_model(model_path=str(src), out_path=str(out), animations=["preset:biped:walk"])
    assert not _sidecar(out).exists() and not out.exists()
    vendor["wait_error"] = None
    tripo.animate_model(model_path=str(src), out_path=str(out), animations=["preset:biped:walk"])
    assert vendor["events"].count("create:/animations/retarget") == 2


def test_a_run_that_stops_waiting_keeps_its_record(vendor, tmp_path):
    out = tmp_path / "walk.glb"
    vendor["wait_error"] = ConnectorError("Tripo task task_anim is still running after 840 s.")
    with pytest.raises(ConnectorError, match="still running"):
        tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(out), animations=["preset:biped:walk"])
    assert json.loads(_sidecar(out).read_text())["task_id"] == "task_anim" and not out.exists()


def test_a_failed_download_names_the_task_to_collect(vendor, tmp_path):
    out = tmp_path / "walk.glb"
    vendor["download_error"] = ConnectorError("Tripo download failed (HTTP 404): https://cdn.tripo3d.ai/x.glb")
    with pytest.raises(ConnectorError, match="--task-id task_anim \\(no new charge\\)") as e:
        tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(out), animations=["preset:biped:walk"])
    assert "generat" not in str(e.value) and "--rig-type" not in str(e.value)
    assert not out.exists() and _sidecar(out).exists()


def test_the_animation_wait_is_told_how_to_collect_it(vendor, tmp_path):
    tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(tmp_path / "walk.glb"),
                        animations=["preset:biped:walk"])
    tripo.resume_animation("task_given", str(tmp_path / "run.glb"))
    assert vendor["hints"] == ["--task-id task_anim", "--task-id task_given"]


def test_an_animated_model_the_guard_refuses_never_lands_at_out(vendor, tmp_path):
    out = tmp_path / "walk.glb"
    vendor["guard_error"] = GlbTextureError("compressed geometry (EXT_meshopt_compression)", "compressed")
    with pytest.raises(tripo.UnsupportedModel) as e:
        tripo.animate_model(model_path=str(_rigged(tmp_path)), out_path=str(out), animations=["preset:biped:walk"])
    assert e.value.task_id == "task_anim" and not out.exists()


# ---------------------------------------------------------------------------
# The step
# ---------------------------------------------------------------------------

@pytest.fixture
def step_module():
    spec = importlib.util.spec_from_file_location("animate_model_step", _STEP_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _result(path, task="task_anim", animations=("preset:biped:walk",), in_place=True):
    return {"path": path, "taskId": task, "animations": list(animations), "inPlace": in_place,
            "creditsUsed": 20.0, "textures": REPORT}


def _run(step_module, monkeypatch, argv):
    monkeypatch.setattr(sys, "argv", ["animate_model.py", *argv])
    step_module.main()


@pytest.fixture
def calls(monkeypatch):
    seen = {"animate": [], "resume": []}

    def animate(**kw):
        seen["animate"].append(kw)
        return _result(kw["out_path"], animations=kw["animations"], in_place=kw["in_place"])

    def resume(task_id, out):
        seen["resume"].append((task_id, out))
        return _result(out, task_id)

    monkeypatch.setattr(tripo, "animate_model", animate)
    monkeypatch.setattr(tripo, "resume_animation", resume)
    return seen


@pytest.fixture
def model(tmp_path):
    glb = tmp_path / "rigged.glb"
    glb.write_bytes(b"x")
    return str(glb)


def test_step_one_animation_plays_in_place_by_default(step_module, monkeypatch, capsys, calls, model, tmp_path):
    out = str(tmp_path / "walk.glb")
    _run(step_module, monkeypatch, ["--model", model, "--animation", "preset:biped:walk", "--out", out, "--json"])
    assert json.loads(capsys.readouterr().out) == _result(out)
    assert calls["animate"] == [{"model_path": model, "out_path": out, "animations": ["preset:biped:walk"],
                                 "in_place": True}]


def test_step_repeated_animation_flags_and_root_motion(step_module, monkeypatch, capsys, calls, model, tmp_path):
    out = str(tmp_path / "moves.glb")
    _run(step_module, monkeypatch, ["--model", model, "--animation", "preset:biped:idle",
                                    "--animation", "preset:biped:walk", "--root-motion", "--out", out])
    assert capsys.readouterr().out.strip() == out
    kw = calls["animate"][0]
    assert kw["animations"] == ["preset:biped:idle", "preset:biped:walk"] and kw["in_place"] is False


def test_step_task_id_resumes_without_a_new_task_and_needs_no_animation(step_module, monkeypatch, capsys, calls,
                                                                        tmp_path):
    out = str(tmp_path / "walk.glb")
    _run(step_module, monkeypatch, ["--model", str(tmp_path / "moved.glb"), "--out", out, "--task-id", "task_9"])
    assert calls["resume"] == [("task_9", out)] and calls["animate"] == []
    assert capsys.readouterr().out.strip() == out


def test_step_task_id_needs_no_model_at_all(step_module, monkeypatch, capsys, calls, tmp_path):
    out = str(tmp_path / "walk.glb")
    _run(step_module, monkeypatch, ["--out", out, "--task-id", "task_9"])
    assert calls["resume"] == [("task_9", out)]


def test_step_without_task_id_needs_a_model(step_module, monkeypatch, capsys, calls, tmp_path):
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--animation", "preset:biped:walk", "--out", str(tmp_path / "a.glb")])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "invalid_args" and "--model is required" in err["message"]
    assert calls["animate"] == [] and calls["resume"] == []


@pytest.mark.parametrize("n", [0, 6])
def test_step_wants_one_to_five_animations(step_module, monkeypatch, capsys, calls, model, tmp_path, n):
    argv = ["--model", model, "--out", str(tmp_path / "a.glb")]
    for _ in range(n):
        argv += ["--animation", "preset:biped:walk"]
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, argv)
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "invalid_args" and "1 to 5 --animation" in err["message"]
    assert calls["animate"] == []


def test_step_a_missing_model(step_module, monkeypatch, capsys, calls, tmp_path):
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", str(tmp_path / "nope.glb"), "--animation", "preset:biped:walk",
                                        "--out", str(tmp_path / "a.glb")])
    assert json.loads(capsys.readouterr().err)["error"] == "file_not_found" and calls["animate"] == []


@pytest.mark.parametrize("extra", [[], ["--task-id", "task_9"]])
def test_step_refuses_to_overwrite_an_existing_out(step_module, monkeypatch, capsys, calls, model, tmp_path, extra):
    out = tmp_path / "a.glb"
    out.write_bytes(b"MINE")
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", model, "--animation", "preset:biped:walk", "--out", str(out), *extra])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "invalid_out" and "already exists" in err["message"]
    assert out.read_bytes() == b"MINE" and calls["animate"] == [] and calls["resume"] == []


def test_step_out_must_be_a_glb(step_module, monkeypatch, capsys, calls, model, tmp_path):
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", model, "--animation", "preset:biped:walk",
                                        "--out", str(tmp_path / "a.fbx")])
    assert json.loads(capsys.readouterr().err)["error"] == "invalid_out"


@pytest.mark.parametrize("reason,code", [(INVALID_API_KEY, "invalid_api_key"),
                                         (INSUFFICIENT_CREDIT, "insufficient_credit"),
                                         (CONTENT_REFUSED, "content_refused"),
                                         (None, "api_error")])
def test_step_failures_map_to_their_codes(step_module, monkeypatch, capsys, model, tmp_path, reason, code):
    def boom(**kw):
        raise ConnectorError("Tripo refused it", reason=reason)
    monkeypatch.setattr(tripo, "animate_model", boom)
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", model, "--animation", "preset:biped:walk",
                                        "--out", str(tmp_path / "a.glb")])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == code and "Tripo" in err["message"]


@pytest.mark.parametrize("exc,code", [
    (tripo.InvalidInput("'preset:walk' is not a preset animation for a biped rig on rig model v1.0-20240301."),
     "invalid_args"),
    (tripo.UnsupportedModel("Tripo returned a compressed model; Montaj needs it uncompressed (task t).",
                            "compressed", "task_anim"), "unsupported_model"),
])
def test_step_maps_its_own_failures(step_module, monkeypatch, capsys, model, tmp_path, exc, code):
    def boom(**kw):
        raise exc
    monkeypatch.setattr(tripo, "animate_model", boom)
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", model, "--animation", "preset:walk", "--out", str(tmp_path / "a.glb")])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == code and err["message"] == str(exc)


def test_step_end_to_end_refuses_a_plain_glb_before_any_call(step_module, monkeypatch, capsys, model, tmp_path):
    """The real connector, no HTTP stubbed: nothing may reach Tripo for a model with no rig record."""
    def no_http(*a, **k):
        raise AssertionError("a call reached Tripo")
    monkeypatch.setattr(tripo, "create", no_http)
    monkeypatch.setattr(tripo, "upload", no_http)
    with pytest.raises(SystemExit):
        _run(step_module, monkeypatch, ["--model", model, "--animation", "preset:biped:walk",
                                        "--out", str(tmp_path / "a.glb")])
    err = json.loads(capsys.readouterr().err)
    assert err["error"] == "invalid_args" and "Rig it first with rig_model" in err["message"]


def test_step_schema():
    schema = json.loads(_SCHEMA_PATH.read_text())
    assert schema["name"] == "animate_model" and schema["output"]["type"] == "model"
    by_name = {p["name"]: p for p in schema["params"]}
    assert set(by_name) == {"model", "animation", "out", "root-motion", "task-id"}
    assert by_name["model"]["required"] is False, "task-id collects an animation with no model"
    assert by_name["out"]["required"] and not by_name["animation"]["required"]
    assert schema["description"].index("task-id") < schema["description"].index("must come from rig_model")
    assert "same --out" not in schema["description"]
    assert by_name["animation"]["repeatable"] is True and by_name["animation"]["type"] == "string"
    assert by_name["root-motion"]["type"] == "bool" and by_name["root-motion"]["default"] is False


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
    body = {"model": "/x/rigged.glb", "animation": ["preset:biped:walk", "preset:biped:run"],
            "root-motion": False, "_project": str(pdir)}
    out = steps_mod.resolve_project_out("animate_model", schema, body)
    assert re.fullmatch(re.escape(str(pdir.resolve() / "assets")) + r"/animate_model-\d{8}-\d{6}\.glb", out)

    # the serve route turns the list into repeated flags and leaves root-motion out when false
    flags = steps_mod.build_cli_args(schema, body)
    assert flags[:6] == ["--model", "/x/rigged.glb", "--animation", "preset:biped:walk",
                         "--animation", "preset:biped:run"]
    assert "--root-motion" not in flags and flags[-2:] == ["--out", out]
    assert "--root-motion" in steps_mod.build_cli_args(schema, {**body, "root-motion": True})
