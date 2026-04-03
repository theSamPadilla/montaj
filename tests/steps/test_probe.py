"""Tests for steps/probe.py"""
import json
import pytest
from tests.conftest import run_step, assert_json_output, assert_error


def test_probe_returns_metadata(test_video):
    proc = run_step("probe.py", "--input", str(test_video))
    data = assert_json_output(proc)
    assert "duration" in data
    assert "streams" in data
    assert "format" in data
    assert abs(data["duration"] - 3.0) < 0.2


def test_probe_video_stream(test_video):
    proc = run_step("probe.py", "--input", str(test_video))
    data = assert_json_output(proc)
    video_streams = [s for s in data["streams"] if s["type"] == "video"]
    assert len(video_streams) == 1
    vs = video_streams[0]
    assert vs["width"] == 640
    assert vs["height"] == 480
    assert vs["codec"] == "h264"


def test_probe_audio_stream(test_video):
    proc = run_step("probe.py", "--input", str(test_video))
    data = assert_json_output(proc)
    audio_streams = [s for s in data["streams"] if s["type"] == "audio"]
    assert len(audio_streams) == 1


def test_probe_missing_file():
    proc = run_step("probe.py", "--input", "/nonexistent/file.mp4")
    assert_error(proc, "file_not_found")


def test_probe_missing_arg():
    proc = run_step("probe.py")
    assert proc.returncode != 0
