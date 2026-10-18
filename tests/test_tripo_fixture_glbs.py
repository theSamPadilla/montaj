"""The two real Tripo models in tests/fixtures/tripo (captured 2026-10-18, textures
downscaled; see the README there), against the texture guard and the skeleton and
clips Tripo's rig and animate steps are said to leave in them.

These are Tripo's own files, not the synthetic GLBs of test_glb_textures.py: they
show what the guard meets in a real output (JPEG and PNG, nothing to re-encode).
"""
import json
import shutil
import struct

import pytest

from lib.glb_textures import ensure_supported_textures
from tests.tripo_captures import CHARACTER_GLB, PROP_GLB

JSON_CHUNK = 0x4E4F534A


def _gltf(path) -> dict:
    """The JSON chunk of the GLB at `path`, read straight from the container."""
    raw = path.read_bytes()
    assert raw[:4] == b"glTF"
    version, length = struct.unpack_from("<II", raw, 4)
    assert version == 2 and length == len(raw)
    js_len, js_type = struct.unpack_from("<II", raw, 12)
    assert js_type == JSON_CHUNK
    return json.loads(raw[20:20 + js_len])


@pytest.mark.parametrize("glb", [PROP_GLB, CHARACTER_GLB], ids=lambda p: p.name)
def test_the_guard_leaves_a_real_tripo_model_byte_for_byte(glb, tmp_path):
    copy = tmp_path / glb.name
    shutil.copyfile(glb, copy)
    before = copy.read_bytes()

    report = ensure_supported_textures(str(copy))

    # Three textures: base colour and ORM as JPEG, the normal map as PNG. Nothing to re-encode.
    assert report == {"reencoded": 0, "ktx2": 0, "formats": {"image/jpeg": 2, "image/png": 1}}
    assert copy.read_bytes() == before
    assert glb.read_bytes() == before, "the fixture itself is untouched"
    assert [p.name for p in tmp_path.iterdir()] == [glb.name], "no temporary file left behind"
    assert sorted(i["mimeType"] for i in _gltf(copy)["images"]) == ["image/jpeg", "image/jpeg", "image/png"]


def test_the_prop_has_no_skeleton_and_no_clips():
    gltf = _gltf(PROP_GLB)
    assert not gltf.get("skins") and not gltf.get("animations")


def test_the_character_has_one_skin_of_23_joints_and_the_two_clips_asked_for():
    gltf = _gltf(CHARACTER_GLB)
    assert len(gltf["skins"]) == 1
    joints = gltf["skins"][0]["joints"]
    names = [gltf["nodes"][j]["name"] for j in joints]
    assert len(joints) == 23 and len(set(names)) == 23
    assert "mixamorig:Hips" in names, "the biped rig carries Mixamo bone names"
    assert sorted(a["name"] for a in gltf["animations"]) == ["walk", "wave_goodbye_01"]
