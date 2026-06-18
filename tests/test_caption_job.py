"""Unit tests for serve.caption_job.extract_keeps."""
import pytest

from serve.caption_job import extract_keeps


def _clip(src, start, end, in_pt, out_pt, ctype="video"):
    return {
        "type": ctype,
        "src": src,
        "start": start,
        "end": end,
        "inPoint": in_pt,
        "outPoint": out_pt,
    }


def test_two_clip_single_source():
    project = {
        "tracks": [
            [
                _clip("IMG.mov", 0.0, 3.424, 0.0, 3.424),
                _clip("IMG.mov", 3.424, 8.897, 5.84, 11.313),
            ]
        ]
    }
    source, keeps = extract_keeps(project)
    assert source == "IMG.mov"
    assert keeps == [[0.0, 3.424], [5.84, 11.313]]


def test_orders_by_start():
    project = {
        "tracks": [
            [
                _clip("IMG.mov", 3.424, 8.897, 5.84, 11.313),
                _clip("IMG.mov", 0.0, 3.424, 0.0, 3.424),
            ]
        ]
    }
    source, keeps = extract_keeps(project)
    assert keeps == [[0.0, 3.424], [5.84, 11.313]]


def test_multi_source_raises():
    project = {
        "tracks": [
            [
                _clip("A.mov", 0.0, 3.0, 0.0, 3.0),
                _clip("B.mov", 3.0, 6.0, 0.0, 3.0),
            ]
        ]
    }
    with pytest.raises(ValueError) as exc:
        extract_keeps(project)
    assert str(exc.value).startswith("multi_source")


def test_no_clips_raises():
    project = {"tracks": [[]]}
    with pytest.raises(ValueError) as exc:
        extract_keeps(project)
    assert str(exc.value).startswith("no_clips")


def test_no_clips_raises_empty_project():
    with pytest.raises(ValueError) as exc:
        extract_keeps({})
    assert str(exc.value).startswith("no_clips")


def test_skips_zero_length_clips():
    project = {
        "tracks": [
            [
                _clip("IMG.mov", 0.0, 3.0, 0.0, 3.0),
                _clip("IMG.mov", 3.0, 3.0, 5.0, 5.0),  # zero-length keep
                _clip("IMG.mov", 3.0, 6.0, 8.0, 11.0),
            ]
        ]
    }
    source, keeps = extract_keeps(project)
    assert keeps == [[0.0, 3.0], [8.0, 11.0]]


def test_ignores_non_video_clips():
    project = {
        "tracks": [
            [
                _clip("IMG.mov", 0.0, 3.0, 0.0, 3.0),
                _clip("song.mp3", 0.0, 3.0, 0.0, 3.0, ctype="audio"),
            ]
        ]
    }
    source, keeps = extract_keeps(project)
    assert source == "IMG.mov"
    assert keeps == [[0.0, 3.0]]


def test_all_zero_length_raises_empty_keeps():
    project = {
        "tracks": [
            [
                _clip("IMG.mov", 0.0, 0.0, 5.0, 5.0),
            ]
        ]
    }
    with pytest.raises(ValueError) as exc:
        extract_keeps(project)
    assert str(exc.value).startswith("empty_keeps")
