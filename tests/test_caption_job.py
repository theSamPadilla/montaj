"""Unit tests for serve.caption_job (the audible-timeline mix spec).

The contract under test, in one line: the caption transcript must be taken from
what the timeline SOUNDS like — every unmuted video item on every enabled visual
track plus every unmuted audio track, each at its own timeline position — and
never from the primary video track alone.
"""
import pytest

from serve.caption_job import build_audio_mix_spec, effective_item_audio


def _clip(src, start, end, in_pt=0.0, **extra):
    c = {"type": "video", "src": src, "start": start, "end": end, "inPoint": in_pt}
    c.update(extra)
    return c


def _audio(src, start, end, **extra):
    t = {"id": src, "src": src, "start": start, "end": end}
    t.update(extra)
    return t


def _by_src(spec):
    return {s["src"]: s for s in spec["segments"]}


# ── effective_item_audio (mirror of the TS/JS fold) ──────────────────────────

def test_effective_volume_multiplies():
    assert effective_item_audio({"volume": 0.5}, {"volume": 0.4})[0] == pytest.approx(0.2)


def test_effective_volume_defaults_to_unity_on_both_sides():
    assert effective_item_audio({}, {})[0] == 1.0
    assert effective_item_audio(None, None)[0] == 1.0


def test_effective_mute_is_either_or():
    assert effective_item_audio({"muted": True}, {"muted": False})[1] is True
    assert effective_item_audio({"muted": False}, {"muted": True})[1] is True
    assert effective_item_audio({}, {})[1] is False


# ── the whole timeline, not just tracks[0] ───────────────────────────────────

def test_every_visual_track_contributes_audio():
    """The headline fix: an overlay-track video is audible in preview and in
    render, so it must be transcribed too."""
    project = {
        "tracks": [
            {"id": "trk-0", "items": [_clip("main.MOV", 0.0, 5.0)]},
            {"id": "trk-1", "items": [_clip("broll.MOV", 2.0, 3.5, in_pt=10.0)]},
        ]
    }
    spec = build_audio_mix_spec(project)
    assert sorted(s["src"] for s in spec["segments"]) == ["broll.MOV", "main.MOV"]
    assert _by_src(spec)["broll.MOV"] == {
        "src": "broll.MOV", "in": 10.0, "out": 11.5, "start": 2.0, "volume": 1.0,
    }


def test_audio_tracks_are_included():
    """A voiceover-driven cut's speech lives entirely in project.audio.tracks;
    the old primary-track cut never saw it."""
    project = {
        "tracks": [{"id": "trk-0", "items": [_clip("footage.MOV", 0.0, 8.0)]}],
        "audio": {"tracks": [_audio("vo.wav", 0.0, 6.0, inPoint=0.65)]},
    }
    spec = build_audio_mix_spec(project)
    assert _by_src(spec)["vo.wav"] == {
        "src": "vo.wav", "in": 0.65, "out": 6.65, "start": 0.0, "volume": 1.0,
    }


def test_muted_video_track_plus_voiceover_is_the_broll_shape():
    """The bug this whole change exists for: `broll` projects mute the footage
    track outright, so the OLD path transcribed silence-under-a-mute while the
    audible voiceover went untranscribed."""
    project = {
        "tracks": [{"id": "trk-0", "muted": True, "items": [_clip("footage.MOV", 0.0, 30.0)]}],
        "audio": {"tracks": [_audio("vo.wav", 0.0, 28.0)]},
    }
    spec = build_audio_mix_spec(project)
    assert [s["src"] for s in spec["segments"]] == ["vo.wav"]


# ── mute, at every level it can be set ───────────────────────────────────────

def test_muted_clip_is_dropped():
    project = {"tracks": [{"id": "trk-0", "items": [
        _clip("a.MOV", 0.0, 2.0),
        _clip("b.MOV", 2.0, 4.0, muted=True),
    ]}]}
    assert [s["src"] for s in build_audio_mix_spec(project)["segments"]] == ["a.MOV"]


def test_muted_track_drops_all_its_clips_even_unmuted_ones():
    project = {"tracks": [
        {"id": "trk-0", "muted": True, "items": [_clip("a.MOV", 0.0, 2.0, muted=False)]},
        {"id": "trk-1", "items": [_clip("b.MOV", 0.0, 2.0)]},
    ]}
    assert [s["src"] for s in build_audio_mix_spec(project)["segments"]] == ["b.MOV"]


def test_skipped_track_is_dropped():
    """`enabled: false` is the timeline's skip toggle — a skipped track produces
    neither picture nor sound, so it produces no captions either."""
    project = {"tracks": [
        {"id": "trk-0", "enabled": False, "items": [_clip("a.MOV", 0.0, 2.0)]},
        {"id": "trk-1", "items": [_clip("b.MOV", 0.0, 2.0)]},
    ]}
    assert [s["src"] for s in build_audio_mix_spec(project)["segments"]] == ["b.MOV"]


def test_absent_enabled_means_enabled():
    project = {"tracks": [{"id": "trk-0", "items": [_clip("a.MOV", 0.0, 2.0)]}]}
    assert len(build_audio_mix_spec(project)["segments"]) == 1


def test_muted_audio_track_is_dropped():
    project = {
        "tracks": [{"id": "trk-0", "items": [_clip("a.MOV", 0.0, 2.0)]}],
        "audio": {"tracks": [
            _audio("music.wav", 0.0, 2.0, muted=True),
            _audio("vo.wav", 0.0, 2.0),
        ]},
    }
    assert sorted(s["src"] for s in build_audio_mix_spec(project)["segments"]) == ["a.MOV", "vo.wav"]


def test_zero_volume_is_treated_as_inaudible():
    project = {"tracks": [
        {"id": "trk-0", "volume": 0.0, "items": [_clip("a.MOV", 0.0, 2.0)]},
        {"id": "trk-1", "items": [_clip("b.MOV", 0.0, 2.0, volume=0)]},
        {"id": "trk-2", "items": [_clip("c.MOV", 0.0, 2.0)]},
    ]}
    assert [s["src"] for s in build_audio_mix_spec(project)["segments"]] == ["c.MOV"]


def test_track_and_clip_volume_multiply_into_the_segment():
    project = {"tracks": [
        {"id": "trk-0", "volume": 0.5, "items": [_clip("a.MOV", 0.0, 2.0, volume=0.4)]},
    ]}
    assert build_audio_mix_spec(project)["segments"][0]["volume"] == pytest.approx(0.2)


# ── timeline time is preserved ───────────────────────────────────────────────

def test_gaps_are_preserved_not_closed_up():
    """The old concat-based cut collapsed gaps, so every word after a gap
    landed early. Positions here are absolute timeline seconds."""
    project = {"tracks": [{"id": "trk-0", "items": [
        _clip("a.MOV", 0.0, 2.0),
        _clip("b.MOV", 7.0, 9.0),   # 5s hole between them
    ]}]}
    spec = build_audio_mix_spec(project)
    assert [s["start"] for s in spec["segments"]] == [0.0, 7.0]
    assert spec["duration"] == 9.0


def test_segments_are_ordered_by_start():
    project = {
        "tracks": [{"id": "trk-0", "items": [_clip("late.MOV", 5.0, 6.0)]},
                   {"id": "trk-1", "items": [_clip("early.MOV", 1.0, 2.0)]}],
        "audio": {"tracks": [_audio("mid.wav", 3.0, 4.0)]},
    }
    assert [s["src"] for s in build_audio_mix_spec(project)["segments"]] == [
        "early.MOV", "mid.wav", "late.MOV",
    ]


def test_duration_is_the_end_of_the_last_audible_thing():
    project = {
        "tracks": [{"id": "trk-0", "items": [_clip("a.MOV", 0.0, 4.0)]}],
        "audio": {"tracks": [_audio("music.wav", 0.0, 12.5)]},
    }
    assert build_audio_mix_spec(project)["duration"] == 12.5


def test_overlapping_segments_are_kept_both():
    """Simultaneity is the point — a voiceover over live footage is two
    segments occupying the same seconds, and amix sums them."""
    project = {
        "tracks": [{"id": "trk-0", "items": [_clip("a.MOV", 0.0, 10.0)]}],
        "audio": {"tracks": [_audio("vo.wav", 0.0, 10.0)]},
    }
    assert len(build_audio_mix_spec(project)["segments"]) == 2


# ── window derivation ────────────────────────────────────────────────────────

def test_window_length_comes_from_the_timeline_span_not_a_stale_outpoint():
    """A trim moves start/end; a stale stored outPoint would silence the clip
    early. Preview's audioWindow derives the same way ("derived, not stored")."""
    clip = _clip("a.MOV", 0.0, 3.0, in_pt=5.0, outPoint=5.5)  # stale: says 0.5s
    spec = build_audio_mix_spec({"tracks": [{"id": "trk-0", "items": [clip]}]})
    assert spec["segments"][0]["out"] == 8.0  # 5.0 + (3.0 - 0.0)


def test_speed_widens_the_source_window_and_is_carried_through():
    """A 2x clip occupying 3 timeline seconds reads 6 source seconds; the step
    time-compresses them back with atempo."""
    clip = _clip("a.MOV", 0.0, 3.0, in_pt=1.0, speed=2)
    seg = build_audio_mix_spec({"tracks": [{"id": "trk-0", "items": [clip]}]})["segments"][0]
    assert (seg["in"], seg["out"], seg["speed"]) == (1.0, 7.0, 2.0)


def test_speed_of_one_is_omitted_from_the_segment():
    clip = _clip("a.MOV", 0.0, 3.0, speed=1)
    assert "speed" not in build_audio_mix_spec({"tracks": [{"id": "trk-0", "items": [clip]}]})["segments"][0]


def test_negative_start_is_clipped_to_the_origin_not_dropped():
    clip = _clip("a.MOV", -2.0, 3.0, in_pt=4.0)
    seg = build_audio_mix_spec({"tracks": [{"id": "trk-0", "items": [clip]}]})["segments"][0]
    assert seg["start"] == 0.0
    assert seg["in"] == 6.0     # the 2s that fell off the front is skipped in source
    assert seg["out"] == 9.0    # 3s of timeline remain


def test_original_src_is_used_even_when_caches_exist():
    """normalizedSrc (SDR colour cache) and proxySrc (720p/96k-Opus editing
    copy) both exist for PICTURE. Audio reads the master, and inPoint stays in
    the master's coordinates — un-rebased."""
    clip = _clip("a.MOV", 0.0, 2.0, in_pt=6.0,
                 normalizedSrc="a_norm.mp4", normalizedInPoint=4.0,
                 proxySrc="a_proxy.mp4")
    seg = build_audio_mix_spec({"tracks": [{"id": "trk-0", "items": [clip]}]})["segments"][0]
    assert seg["src"] == "a.MOV"
    assert seg["in"] == 6.0


# ── shape tolerance and rejection ────────────────────────────────────────────

def test_legacy_bare_array_track_shape_is_accepted():
    project = {"tracks": [[_clip("a.MOV", 0.0, 2.0)]]}
    assert [s["src"] for s in build_audio_mix_spec(project)["segments"]] == ["a.MOV"]


def test_non_video_items_are_ignored():
    project = {"tracks": [{"id": "trk-0", "items": [
        {"type": "image", "src": "still.png", "start": 0.0, "end": 2.0},
        {"type": "overlay", "src": "card.jsx", "start": 0.0, "end": 2.0},
        _clip("a.MOV", 0.0, 2.0),
    ]}]}
    assert [s["src"] for s in build_audio_mix_spec(project)["segments"]] == ["a.MOV"]


def test_zero_length_and_srcless_items_are_dropped():
    project = {"tracks": [{"id": "trk-0", "items": [
        _clip("a.MOV", 2.0, 2.0),          # zero length
        {"type": "video", "start": 0.0, "end": 2.0},   # no src
        _clip("b.MOV", 0.0, 2.0),
    ]}]}
    assert [s["src"] for s in build_audio_mix_spec(project)["segments"]] == ["b.MOV"]


def test_sample_rate_is_carried_on_the_spec():
    project = {"tracks": [{"id": "trk-0", "items": [_clip("a.MOV", 0.0, 2.0)]}]}
    assert build_audio_mix_spec(project)["sampleRate"] == 16000
    assert build_audio_mix_spec(project, sample_rate=48000)["sampleRate"] == 48000


def test_nothing_audible_raises_no_audio():
    project = {
        "tracks": [{"id": "trk-0", "muted": True, "items": [_clip("a.MOV", 0.0, 2.0)]}],
        "audio": {"tracks": [_audio("vo.wav", 0.0, 2.0, muted=True)]},
    }
    with pytest.raises(ValueError, match="no_audio"):
        build_audio_mix_spec(project)


def test_empty_project_raises_no_audio():
    with pytest.raises(ValueError, match="no_audio"):
        build_audio_mix_spec({})
