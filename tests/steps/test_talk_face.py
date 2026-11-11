"""steps/audio/talk_face.py: a voice to a face move and a body move (.glb), run as a subprocess the way a caller runs it.

The ARCTIC fixture and its words JSON are tests/fixtures/talk (SOURCES.md). The written GLBs are read back and compared with
face.build's own clip for the same inputs. The no-words path runs the real local whisper and is skipped where it is not installed."""
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib.talk import face, glb as G  # noqa: E402
from tests.test_talk_glb import lerp, read  # noqa: E402

STEP = REPO_ROOT / "steps" / "audio" / "talk_face.py"
FIX = REPO_ROOT / "tests" / "fixtures" / "talk"
WAV, WORDS = str(FIX / "arctic_a0023.wav"), str(FIX / "arctic_a0023.words.json")
MOODS = [{"from": 0.1, "to": 5.2, "mood": "amused"}, {"at": 1.4, "beat": "wince", "strength": 0.8, "hold": 0.5}]
F32 = 1e-5


def step(tmp, *extra, out="talk", inp=WAV, words=WORDS, expect=0):
    cmd = [sys.executable, str(STEP), "--input", inp, "--out", str(tmp / out), *extra]
    if words:
        cmd += ["--words", words]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(REPO_ROOT))
    assert r.returncode == expect, r.stderr
    return json.loads(r.stdout) if expect == 0 else json.loads(r.stderr)


def moods_args(moods):
    return [a for m in moods for a in ("--moods", json.dumps(m))]


def check_matches_clip(res, clip, skeleton=None):
    """The written face and body GLBs carry face.build's clip: every shape key, head, neck and body bone."""
    assert len(res["face"]) == 1
    _, _, ix, ch = read(res["face"][0]["path"])
    (_, _, tw, w), = [c for c in ch if c[1] == "weights"]
    w = w.reshape(len(tw), -1)
    names = sorted(clip["morphs"])
    assert res["keys"] == names
    for i, k in enumerate(names):
        for t, v in clip["morphs"][k]:
            hit = np.nonzero(np.abs(tw - t) < 1e-5)[0]
            assert len(hit) == 1, (k, t)
            assert abs(float(w[hit[0], i]) - v) < F32, (k, t)
    rows = (skeleton or G.REFERENCE)["rows"]
    by = {r[0]: r for r in rows}

    def bone_check(path, wanted):
        _, _, ix, ch = read(path)
        for b in wanted:
            (_, _, tr, q), = [c for c in ch if c[0] == ix[b] and c[1] == "rotation"]
            rq = G._rest_quat(by[b])
            keys = clip["bones"][b]
            if path == res["body"]["path"]:  # additive play: the body's key at 0 is no turn (talk_face)
                keys = [[0, [0, 0, 0]]] + [k for k in keys if k[0] > 0]
            for t, v in keys:
                hit = np.nonzero(np.abs(tr - t) < 1e-5)[0]
                assert len(hit) == 1, (b, t)
                qq = q[hit[0]].astype(float)
                if rq is not None:
                    qq = G.qmul(qq, rq * [-1, -1, -1, 1])
                np.testing.assert_allclose(G.euler_zyx(qq), v, atol=2e-4, err_msg=f"{b} {t}")

    bone_check(res["face"][0]["path"], ("head", "neck"))
    body = [b for b in clip["bones"] if b not in ("head", "neck")]
    bone_check(res["body"]["path"], body)
    assert "firstValues" not in res["body"]


def test_output_shape_and_files_equal_the_clip(tmp_path):
    res = step(tmp_path, *moods_args(MOODS))
    clip, rep = face.build(WAV, WORDS, "en", [{"from": 0.1, "to": 5.2, "mood": "amused"}, {"at": 1.4, "beat": "wince@0.8", "hold": 0.5}])
    assert set(res) == {"face", "body", "words", "duration", "language", "keys", "missingKeys", "gestures", "beats", "phrases",
                        "known", "play", "notes"}
    assert res["duration"] == clip["duration"] and res["language"] == "en"
    assert set(res["face"][0]) == {"path", "name", "start", "duration"}
    assert res["face"][0]["name"] == "arctic_a0023_face" and res["body"]["name"] == "arctic_a0023_body"
    assert res["gestures"] == rep["gestures"] and res["phrases"] == rep["phrases"]
    assert [b["beat"] for b in res["beats"]] == ["wince@0.8"] and all("keys" not in b for b in res["beats"])
    assert "amused" in res["known"]["moods"] and "wince" in res["known"]["beats"]
    assert res["missingKeys"] == [] and res["notes"] == []
    assert res["play"]["face"] == [{"play": {"clip": res["face"][0]["path"], "start": 0.0, "over": "face"}}]
    assert res["play"]["body"] == {"play": {"clip": res["body"]["path"], "start": 0, "over": "add"}}
    assert res["words"] == WORDS and sorted(os.listdir(tmp_path)) == ["talk-body.glb", "talk-face.glb", "talk.json"]
    assert json.loads((tmp_path / "talk.json").read_text()) == res
    check_matches_clip(res, clip)


def test_unknown_mood_and_beat_are_notes_and_clips_still_written(tmp_path):
    res = step(tmp_path, *moods_args([{"from": 0, "to": 3, "mood": "elated"}, {"at": 1, "beat": "yawn"},
                                      {"from": 3, "to": 5, "mood": "warm"}]))
    assert len(res["notes"]) == 2
    assert "elated" in res["notes"][0] and "known:" in res["notes"][0] and "amused" in res["notes"][0]
    assert "yawn" in res["notes"][1] and "wince" in res["notes"][1]
    assert os.path.isfile(res["face"][0]["path"]) and os.path.isfile(res["body"]["path"])
    clip, _ = face.build(WAV, WORDS, "en", [{"from": 3, "to": 5, "mood": "warm"}])
    check_matches_clip(res, clip)


def test_moods_as_one_json_list(tmp_path):
    res = step(tmp_path, "--moods", json.dumps(MOODS))
    assert res["notes"] == [] and [b["beat"] for b in res["beats"]] == ["wince@0.8"]


def test_model_json_fixture(tmp_path):
    model = str(FIX / "tiny-head" / "model.json")
    res = step(tmp_path, "--model", model, *moods_args(MOODS))
    clip, _ = face.build(WAV, WORDS, "en", [{"from": 0.1, "to": 5.2, "mood": "amused"}, {"at": 1.4, "beat": "wince@0.8", "hold": 0.5}], head=model)
    # The tiny head has two morph targets: the keys it lacks are reported, and the rest of the voice still plays.
    assert "jawOpen" in res["keys"] and "viseme_aa" in res["keys"]
    assert "viseme_aa" in res["missingKeys"] and "jawOpen" not in res["missingKeys"]
    assert any("lacks" in n for n in res["notes"])
    assert any("reference skeleton" in n for n in res["notes"])  # its rig is one bone: clips need a rigged model
    assert res["keys"] == sorted(clip["morphs"])
    check_matches_clip(res, clip)
    res2 = step(tmp_path, "--model", str(FIX / "tiny-head"), out="folder")
    assert res2["keys"] == sorted(face.build(WAV, WORDS, "en", [], head=model)[0]["morphs"])


def test_bad_inputs_fail_with_a_code(tmp_path):
    assert step(tmp_path, inp=str(tmp_path / "nope.wav"), expect=1)["error"] == "file_not_found"
    bad = tmp_path / "bad.json"
    bad.write_text("{}")
    assert step(tmp_path, words=str(bad), expect=1)["error"] == "invalid_args"
    assert step(tmp_path, "--moods", "{nope", expect=1)["error"] == "invalid_args"
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"not audio")
    assert step(tmp_path, inp=str(junk), expect=1)["error"] == "decode_failed"
    step(tmp_path, out="again")
    assert step(tmp_path, out="again", expect=1)["error"] == "invalid_out"


def _whisper_here():
    try:
        sys.path.insert(0, str(REPO_ROOT / "lib"))
        import common
        if common.whisper_model_missing(common.DEFAULT_WHISPER_MODEL):
            return False
        common.find_whisper_bin()
        return True
    except BaseException:
        return False


@pytest.mark.skipif(not _whisper_here(), reason="needs the whisper binary and a model")
def test_no_words_the_step_transcribes(tmp_path):
    res = step(tmp_path, words=None, out="heard")
    assert res["language"] == "en" and res["duration"] > 4 and res["phrases"]
    assert os.path.isfile(res["face"][0]["path"])


def test_model_with_a_rig_placement_is_written_for_identity_placement(tmp_path):
    """Direct play gets no rig.json, so a model whose rig.json turns it (yaw pi) must not turn the written nodes."""
    import shutil
    d = tmp_path / "m"
    shutil.copytree(FIX / "tiny-head", d)
    m = json.loads((d / "model.json").read_text())
    m["skeleton"] = G.REFERENCE["rows"]
    (d / "model.json").write_text(json.dumps(m))
    (d / "rig.json").write_text(json.dumps({"format": 1, "skeleton": G.skeleton_key(G.REFERENCE["rows"]),
                                            "frames": {"hips": [0, 0, 0, 1]},
                                            "place": {"scale": 2.0, "centre": [0, 1, 0], "yaw": np.pi}}))
    assert G.skeleton_of(str(d / "model.json"))["place"]["yaw"] == np.pi  # the file is read as add_clips would
    res = step(tmp_path, "--model", str(d / "model.json"))
    t, q, s = G.root_trs(None)
    for path in [res["face"][0]["path"], res["body"]["path"]]:
        root = read(path)[0]["nodes"][0]
        assert root["name"] == "talk_root"
        np.testing.assert_allclose(root["translation"], t, atol=1e-6)
        np.testing.assert_allclose(root["rotation"], q, atol=1e-6)
        assert root["scale"] == [s] * 3 == [1.0] * 3


def make_model(tmp_path, name="m", **patch):
    import shutil
    d = tmp_path / name
    shutil.copytree(FIX / "tiny-head", d)
    m = json.loads((d / "model.json").read_text())
    m["skeleton"] = G.REFERENCE["rows"]
    m.update(patch)
    (d / "model.json").write_text(json.dumps(m))
    return d


def test_body_key_at_zero_is_no_turn_so_additive_play_keeps_the_posture(tmp_path):
    res = step(tmp_path)
    j, _, ix, ch = read(res["body"]["path"])
    clip, _ = face.build(WAV, WORDS, "en", [])
    moved = [b for b in clip["bones"] if b not in ("head", "neck") and any(abs(x) > 1e-3 for _, v in clip["bones"][b] for x in v)]
    assert moved
    for b in moved:
        (_, _, tr, q), = [c for c in ch if c[0] == ix[b] and c[1] == "rotation"]
        assert tr[0] == 0
        np.testing.assert_allclose(G.euler_zyx(G.qmul(q[0].astype(float), G._rest_quat(next(r for r in G.REFERENCE["rows"] if r[0] == b)) * [-1, -1, -1, 1])
                                               if G._rest_quat(next(r for r in G.REFERENCE["rows"] if r[0] == b)) is not None else q[0].astype(float)), [0, 0, 0], atol=2e-4)
        assert len(tr) > 2  # the rest of the keys stay


def test_no_body_move_when_the_skeleton_has_no_body_bone(tmp_path):
    d = make_model(tmp_path)
    m = json.loads((d / "model.json").read_text())
    m["skeleton"] = [r for r in G.REFERENCE["rows"] if r[0] in ("hips", "neck", "head")]
    m["skeleton"][1][1] = "hips"  # neck hangs from hips
    (d / "model.json").write_text(json.dumps(m))
    res = step(tmp_path, "--model", str(d / "model.json"))
    assert res["body"] is None and "body" not in res["play"]
    assert any("no body move" in n for n in res["notes"])
    assert not (tmp_path / "talk-body.glb").exists()


def test_a_failure_leaves_nothing_and_the_same_out_can_be_run_again(tmp_path):
    bad = tmp_path / "m"
    bad.mkdir()
    (bad / "model.json").write_text("{}")  # no skeleton, no face: both fall back
    res = step(tmp_path, "--model", str(bad / "model.json"), out="o/x")
    assert sorted(os.listdir(tmp_path / "o")) == ["x-body.glb", "x-face.glb", "x.json"]
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"not audio")
    assert step(tmp_path, inp=str(junk), out="o/y", expect=1)["error"] == "decode_failed"
    assert sorted(os.listdir(tmp_path / "o")) == ["x-body.glb", "x-face.glb", "x.json"]  # no staging folder, no y files
    step(tmp_path, out="o/y")


def test_reach_never_kills_the_step_and_a_variant_reads_its_base(tmp_path):
    res = step(tmp_path, "--model", str(make_model(tmp_path, "nofaces", parts=[]) / "model.json"), out="a")
    assert any("no face keys Montaj can read" in n for n in res["notes"]) and res["missingKeys"] == []
    base = make_model(tmp_path, "base")
    (base / "meshes").mkdir(exist_ok=True)
    var = tmp_path / "var"
    var.mkdir()
    bm = json.loads((base / "model.json").read_text())
    (var / "model.json").write_text(json.dumps({"variantOf": "base", "parts": bm["parts"]}))
    mdir = base / "meshes"
    inline = bm.get("meshes")
    if isinstance(inline, dict):  # the fixture holds its meshes inline: move them to the base's folder, as the app stores them
        mdir.mkdir(exist_ok=True)
        for k, v in inline.items():
            (mdir / (k + ".json")).write_text(json.dumps(v))
        bm.pop("meshes")
        (base / "model.json").write_text(json.dumps(bm))
    res = step(tmp_path, "--model", str(var / "model.json"), out="b")
    assert not any("reference" in n for n in res["notes"]), res["notes"]
    assert "jawOpen" in res["keys"]


def test_expressive_outside_range_is_clamped_with_a_note(tmp_path):
    res = step(tmp_path, "--expressive", "5")
    assert any("--expressive" in n for n in res["notes"])
    clip, _ = face.build(WAV, WORDS, "en", [], expressive=2)
    check_matches_clip(res, clip)


def test_language_auto_uses_the_transcripts(tmp_path):
    assert step(tmp_path, "--language", "auto")["language"] == "en"


def test_without_numpy_the_step_fails_cleanly(tmp_path):
    (tmp_path / "fake").mkdir()
    (tmp_path / "fake" / "numpy.py").write_text("raise ImportError('No module named numpy')\n")
    cmd = [sys.executable, str(STEP), "--input", WAV, "--words", WORDS, "--out", str(tmp_path / "n")]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=str(REPO_ROOT), env={**os.environ, "PYTHONPATH": str(tmp_path / "fake")})
    assert r.returncode == 1 and json.loads(r.stderr)["error"] == "missing_dependency"
    assert not list(tmp_path.glob("n*")) and not list(tmp_path.glob(".talk_face_*"))
