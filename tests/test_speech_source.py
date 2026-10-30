"""lib/speech_source (§558): a cut's speech on a video track, an audio lane or the voiceover; lift and lower."""
import json
import shutil
from pathlib import Path

import pytest

from lib import speech_source as ss

FIX = Path(__file__).resolve().parent / "fixtures" / "speech_text"


def project(tmp_path, audio=None, voiceover=None):
    shutil.copy(FIX / "speech.mp4", tmp_path / "vo.mp4")
    p = {"id": "p", "tracks": [{"id": "trk-0", "items": []}], "audio": {"tracks": audio or []}}
    if voiceover:
        p["voiceover"] = {"src": str(tmp_path / "vo.mp4")}
    return p


def test_lift_then_lower_with_no_cut_gives_the_project_back(tmp_path):
    a = [{"id": "m", "type": "music", "src": str(tmp_path / "vo.mp4"), "start": 0, "end": 2, "volume": 0.2},
         {"id": "v1", "type": "voiceover", "lane": 1, "src": str(tmp_path / "vo.mp4"), "start": 0.0, "end": 3.0,
          "inPoint": 0.0, "outPoint": 3.0, "fadeIn": 0.05}]
    p = project(tmp_path, a)
    lifted, lift = ss.lift(p, "audio:lane-1", str(tmp_path))
    assert [t["id"] for t in lifted["tracks"]] == ["trk-0", "speech:audio:lane-1"]
    assert [e["id"] for e in lifted["audio"]["tracks"]] == ["m"]
    assert lift.lower(lifted)["audio"]["tracks"] == p["audio"]["tracks"]
    assert [t["id"] for t in lift.lower(lifted)["tracks"]] == ["trk-0"]


def test_auto_picks_the_transcribed_source_and_a_video_track_wins_a_tie(tmp_path):
    a = [{"id": "v1", "type": "voiceover", "src": str(tmp_path / "vo.mp4"), "start": 0.0, "end": 3.0,
          "inPoint": 0.0, "outPoint": 3.0}]
    p = project(tmp_path, a)
    assert ss.choose(p, str(tmp_path)) == "audio:voiceover"        # nothing transcribed: the voiceover group
    (tmp_path / "vo.json").write_text(json.dumps({"transcription": []}))
    assert ss.choose(p, str(tmp_path)) == "audio:voiceover"
    p["tracks"][0]["items"].append({"id": "c", "type": "video", "src": str(tmp_path / "vo.mp4"), "start": 0,
                                    "end": 3.0, "inPoint": 0.0, "outPoint": 3.0})
    assert ss.choose(p, str(tmp_path)) == "trk-0"


def test_a_pending_projects_placeholder_clips_count_their_whole_file(tmp_path):
    """A placeholder (end at its start) plays its whole file: a 5 s music item on the same file never outweighs it."""
    a = [{"id": "music", "src": str(tmp_path / "vo.mp4"), "start": 0.0, "end": 5.0, "inPoint": 0.0, "outPoint": 5.0}]
    p = project(tmp_path, a)
    (tmp_path / "vo.json").write_text(json.dumps({"transcription": []}))
    p["tracks"][0]["items"].append({"id": "c", "type": "video", "src": str(tmp_path / "vo.mp4"), "start": 0.0,
                                    "end": 0.0, "sourceDuration": 8.8})
    assert ss.choose(p, str(tmp_path)) == "trk-0"


def test_the_voiceover_is_a_source_only_while_nothing_plays_it(tmp_path):
    p = project(tmp_path, voiceover=True)
    assert ss.choose(p, str(tmp_path)) == "voiceover"
    p["audio"]["tracks"].append({"id": "v1", "type": "voiceover", "src": str(tmp_path / "vo.mp4"), "start": 0.0,
                                 "end": 3.0})
    assert "voiceover" not in [k for k, _, _ in ss.candidates(p, str(tmp_path))]
    assert ss.choose(p, str(tmp_path), "voiceover") == "audio:voiceover"


def test_an_unknown_source_fails(tmp_path):
    with pytest.raises(SystemExit):
        ss.choose(project(tmp_path), str(tmp_path), "audio:lane-3")


def test_null_out_and_end_are_read_as_absent(tmp_path):
    a = [{"id": "v1", "type": "voiceover", "src": str(tmp_path / "vo.mp4"), "start": 0.0, "end": None,
          "inPoint": 0.0, "outPoint": None}]
    p = project(tmp_path, a)
    (tmp_path / "vo.json").write_text(json.dumps({"transcription": []}))
    assert ss.choose(p, str(tmp_path)) == "audio:voiceover"
    lifted, lift = ss.lift(p, "audio:voiceover", str(tmp_path))
    (it,) = lifted["tracks"][-1]["items"]
    assert it["outPoint"] > 0 and it["end"] == pytest.approx(it["outPoint"])


def test_a_type_key_still_finds_its_items_after_the_editor_stamps_their_row_as_a_lane(tmp_path):
    """A cut planned on lane-less voiceover ("audio:voiceover") applies after the person's next edit wrote the
    packed row down as `lane`, and lowering keeps that lane. A sound of another type on that row is not taken."""
    vo = str(tmp_path / "vo.mp4")
    a = [{"id": "v1", "type": "voiceover", "lane": 2, "src": vo, "start": 0.0, "end": 1.5, "inPoint": 0.0, "outPoint": 1.5},
         {"id": "v2", "type": "voiceover", "lane": 2, "src": vo, "start": 1.5, "end": 3.0, "inPoint": 1.5, "outPoint": 3.0},
         {"id": "s", "type": "sfx", "lane": 2, "src": vo, "start": 3.0, "end": 4.0}]
    p = project(tmp_path, a)
    lifted, lift = ss.lift(p, "audio:voiceover", str(tmp_path))
    assert [it["id"] for it in lifted["tracks"][-1]["items"]] == ["v1", "v2"]
    assert [e["id"] for e in lifted["audio"]["tracks"]] == ["s"]
    assert lift.lower(lifted)["audio"]["tracks"] == p["audio"]["tracks"]


def test_a_type_spread_over_two_lanes_is_not_guessed(tmp_path):
    vo = str(tmp_path / "vo.mp4")
    a = [{"id": "v1", "type": "voiceover", "lane": 1, "src": vo, "start": 0.0, "end": 1.5},
         {"id": "v2", "type": "voiceover", "lane": 2, "src": vo, "start": 1.5, "end": 3.0}]
    with pytest.raises(SystemExit):
        ss.lift(project(tmp_path, a), "audio:voiceover", str(tmp_path))


def test_choose_accepts_a_type_key_whose_row_was_stamped(tmp_path):
    vo = str(tmp_path / "vo.mp4")
    a = [{"id": "v1", "type": "voiceover", "lane": 4, "src": vo, "start": 0.0, "end": 1.5}]
    assert ss.choose(project(tmp_path, a), str(tmp_path), "audio:voiceover") == "audio:voiceover"
    with pytest.raises(SystemExit):
        ss.choose(project(tmp_path, a), str(tmp_path), "audio:music")
