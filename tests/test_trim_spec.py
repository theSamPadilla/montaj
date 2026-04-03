import json, pytest, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from trim_spec import load, is_trim_spec, merge, remap_timestamp, audio_extract_cmd

def test_load_from_dict():
    spec = load({"input": "/a.mov", "keeps": [[0, 5], [10, 15]]})
    assert spec["input"] == "/a.mov"
    assert spec["keeps"] == [[0, 5], [10, 15]]

def test_load_from_file(tmp_path):
    p = tmp_path / "spec.json"
    p.write_text(json.dumps({"input": "/a.mov", "keeps": [[0, 5]]}))
    spec = load(str(p))
    assert spec["keeps"] == [[0, 5]]

def test_merge_trims_within_keeps():
    keeps = [[2.0, 8.0], [10.0, 15.0]]
    cuts  = [[3.0, 4.0], [12.0, 13.0]]
    result = merge(keeps, cuts)
    assert result == [[2.0, 3.0], [4.0, 8.0], [10.0, 12.0], [13.0, 15.0]]

def test_remap_timestamp_maps_to_original():
    keeps = [[2.0, 8.0], [10.0, 15.0]]
    assert remap_timestamp(0.0, keeps) == pytest.approx(2.0)
    assert remap_timestamp(3.0, keeps) == pytest.approx(5.0)
    assert remap_timestamp(6.0, keeps) == pytest.approx(10.0)
    assert remap_timestamp(8.0, keeps) == pytest.approx(12.0)

def test_audio_extract_cmd_builds_correct_filter():
    keeps = [[2.0, 5.0], [10.0, 12.0]]
    cmd = audio_extract_cmd("/a.mov", keeps, "/out.wav")
    cmd_str = " ".join(cmd)
    assert "atrim=start=2.000:end=5.000" in cmd_str
    assert "atrim=start=10.000:end=12.000" in cmd_str
    assert "/out.wav" in cmd_str

def test_audio_extract_cmd_single_segment():
    keeps = [[1.0, 3.0]]
    cmd = audio_extract_cmd("/a.mov", keeps, "/out.wav")
    cmd_str = " ".join(cmd)
    assert "anull" in cmd_str
    assert "concat" not in cmd_str
