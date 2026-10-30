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


def test_auto_skips_footage_whose_sound_is_off(tmp_path):
    """PL90: a muted clip of someone else talking has more transcribed seconds than the narration, and is not it."""
    a = [{"id": "v1", "type": "voiceover", "lane": 0, "src": str(tmp_path / "vo.mp4"), "start": 0.0, "end": 2.0,
          "inPoint": 0.0, "outPoint": 2.0}]
    p = project(tmp_path, a)
    (tmp_path / "vo.json").write_text(json.dumps({"transcription": []}))
    clip = {"id": "c", "type": "video", "src": str(tmp_path / "vo.mp4"), "start": 0, "end": 3.0, "inPoint": 0.0,
            "outPoint": 3.0, "muted": True, "volume": 0}
    p["tracks"][0]["items"].append(clip)
    assert ss.choose(p, str(tmp_path)) == "audio:lane-0"
    clip["muted"] = False
    assert ss.choose(p, str(tmp_path)) == "audio:lane-0"           # volume 0 alone is silent too
    clip["volume"] = 1
    assert ss.choose(p, str(tmp_path)) == "trk-0"                  # heard, and longer: as before


def _talking_clip(tmp_path, **over):
    return {"id": "c", "type": "video", "src": str(tmp_path / "vo.mp4"), "start": 0, "end": 3.0, "inPoint": 0.0,
            "outPoint": 3.0, **over}


@pytest.mark.parametrize("silent", [{"muted": True}, {"volume": 0}, {"enabled": False}])
def test_auto_skips_a_video_track_that_is_silent_as_a_track(tmp_path, silent):
    """The track rail's mute switch, volume gear and skip toggle write on the TRACK; its clips stay as they were."""
    a = [{"id": "v1", "type": "voiceover", "lane": 0, "src": str(tmp_path / "vo.mp4"), "start": 0.0, "end": 2.0,
          "inPoint": 0.0, "outPoint": 2.0}]
    p = project(tmp_path, a)
    (tmp_path / "vo.json").write_text(json.dumps({"transcription": []}))
    p["tracks"][0]["items"].append(_talking_clip(tmp_path))
    assert ss.choose(p, str(tmp_path)) == "trk-0"
    p["tracks"][0].update(silent)
    assert ss.choose(p, str(tmp_path)) == "audio:lane-0"
    p["tracks"][0].update({k: ({"muted": False, "volume": 1, "enabled": True}[k]) for k in silent})
    assert ss.choose(p, str(tmp_path)) == "trk-0"                   # switched back on: heard again


def test_a_muted_audio_row_is_not_heard_either(tmp_path):
    a = [{"id": "v1", "type": "voiceover", "lane": 0, "src": str(tmp_path / "vo.mp4"), "start": 0.0, "end": 3.0,
          "inPoint": 0.0, "outPoint": 3.0, "muted": True}]
    p = project(tmp_path, a)
    (tmp_path / "vo.json").write_text(json.dumps({"transcription": []}))
    p["tracks"][0]["items"].append(_talking_clip(tmp_path, end=1.0, outPoint=1.0))
    assert ss.choose(p, str(tmp_path)) == "trk-0"


def test_a_heard_voiceover_not_yet_transcribed_outranks_a_silent_transcribed_clip(tmp_path):
    p = project(tmp_path, voiceover=True)
    (tmp_path / "clip.mp4").write_bytes((tmp_path / "vo.mp4").read_bytes())
    (tmp_path / "clip.json").write_text(json.dumps({"transcription": []}))   # only the clip is transcribed
    p["tracks"][0]["items"].append(_talking_clip(tmp_path, src=str(tmp_path / "clip.mp4"), muted=True))
    assert ss.choose(p, str(tmp_path)) == "voiceover"
    # the same with the voiceover laid on the timeline as an audio group
    a = [{"id": "v1", "type": "voiceover", "lane": 0, "src": str(tmp_path / "vo.mp4"), "start": 0.0, "end": 3.0,
          "inPoint": 0.0, "outPoint": 3.0}]
    p = project(tmp_path, a, voiceover=True)
    p["tracks"][0]["items"].append(_talking_clip(tmp_path, src=str(tmp_path / "clip.mp4"), muted=True))
    assert ss.choose(p, str(tmp_path)) == "audio:lane-0"


def test_auto_with_only_silent_sources_still_picks_by_transcribed_seconds(tmp_path):
    p = project(tmp_path)
    (tmp_path / "vo.json").write_text(json.dumps({"transcription": []}))
    p["tracks"][0]["items"].append({"id": "c", "type": "video", "src": str(tmp_path / "vo.mp4"), "start": 0,
                                    "end": 3.0, "inPoint": 0.0, "outPoint": 3.0, "muted": True})
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


def test_a_type_packed_onto_two_rows_is_still_one_source(tmp_path):
    """Takes that overlap by a crossfade pack onto two rows; once stamped, the type key still takes them all."""
    vo = str(tmp_path / "vo.mp4")
    a = [{"id": "v1", "type": "voiceover", "lane": 1, "src": vo, "start": 0.0, "end": 1.6, "inPoint": 0.0, "outPoint": 1.6},
         {"id": "v2", "type": "voiceover", "lane": 2, "src": vo, "start": 1.4, "end": 3.0, "inPoint": 1.4, "outPoint": 3.0}]
    lifted, _ = ss.lift(project(tmp_path, a), "audio:voiceover", str(tmp_path))
    assert [it["id"] for it in lifted["tracks"][-1]["items"]] == ["v1", "v2"]
    assert ss.has_source(project(tmp_path, a), str(tmp_path), "audio:voiceover")
    assert not ss.has_source(project(tmp_path, a), str(tmp_path), "audio:music")


def test_choose_accepts_a_type_key_whose_row_was_stamped(tmp_path):
    vo = str(tmp_path / "vo.mp4")
    a = [{"id": "v1", "type": "voiceover", "lane": 4, "src": vo, "start": 0.0, "end": 1.5}]
    assert ss.choose(project(tmp_path, a), str(tmp_path), "audio:voiceover") == "audio:voiceover"
    with pytest.raises(SystemExit):
        ss.choose(project(tmp_path, a), str(tmp_path), "audio:music")
