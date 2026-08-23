"""Tests for lib/voiceover.py — the multi-take narration concat primitive."""
import json
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib.voiceover import concat_takes


def _tone(path, seconds, freq=440):
    """Write a `seconds`-long mono tone to `path` (real audio, real ffmpeg)."""
    subprocess.run([
        "ffmpeg", "-v", "error", "-y",
        "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}:sample_rate=48000",
        "-ac", "1", path,
    ], check=True)


def _duration(path):
    out = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "csv=p=0", path,
    ], capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def test_concat_takes_sums_durations(tmp_path):
    a, b, c = (str(tmp_path / f"{n}.wav") for n in "abc")
    _tone(a, 1.0, 440)
    _tone(b, 2.0, 550)
    _tone(c, 0.5, 660)
    out = concat_takes([a, b, c], str(tmp_path / "narration.wav"))
    assert os.path.isfile(out)
    assert _duration(out) == pytest.approx(3.5, abs=0.10)


def test_concat_takes_output_is_48k_stereo_pcm(tmp_path):
    a, b = (str(tmp_path / f"{n}.wav") for n in "ab")
    _tone(a, 0.5)
    _tone(b, 0.5)
    out = concat_takes([a, b], str(tmp_path / "narration.wav"))
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,sample_rate,channels",
        "-of", "csv=p=0", out,
    ], capture_output=True, text=True, check=True).stdout.strip()
    assert probe == "pcm_s16le,48000,2"


def test_concat_takes_accepts_video_sources(tmp_path):
    """Takes are usually .MOV — only the audio track is read."""
    mov = str(tmp_path / "take.mov")
    subprocess.run([
        "ffmpeg", "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000",
        "-shortest", mov,
    ], check=True)
    wav = str(tmp_path / "take.wav")
    _tone(wav, 1.0)
    out = concat_takes([mov, wav], str(tmp_path / "narration.wav"))
    assert _duration(out) == pytest.approx(2.0, abs=0.10)


def test_concat_takes_single_input_still_produces_output(tmp_path):
    a = str(tmp_path / "a.wav")
    _tone(a, 1.0)
    out = concat_takes([a], str(tmp_path / "narration.wav"))
    assert _duration(out) == pytest.approx(1.0, abs=0.10)


def test_concat_takes_rejects_empty_list(tmp_path):
    with pytest.raises(ValueError):
        concat_takes([], str(tmp_path / "narration.wav"))


def test_concat_takes_names_the_take_that_has_no_audio(tmp_path, capsys):
    """A silent take fails by name, not with a raw ffmpeg filtergraph dump."""
    good = str(tmp_path / "good.wav")
    _tone(good, 1.0)
    silent = str(tmp_path / "silent.mov")
    subprocess.run([
        "ffmpeg", "-v", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
        "-an", silent,
    ], check=True)

    with pytest.raises(SystemExit):
        concat_takes([good, silent], str(tmp_path / "narration.wav"))
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "no_audio_stream"
    assert "silent.mov" in err["message"]
    assert "good.wav" not in err["message"]


def test_concat_takes_treats_an_unreadable_file_as_no_audio(tmp_path, capsys):
    """Script notes dropped in by mistake get the same message as a silent take."""
    good = str(tmp_path / "good.wav")
    _tone(good, 1.0)
    notes = tmp_path / "notes.txt"
    notes.write_text("these are my script notes, not audio")

    with pytest.raises(SystemExit):
        concat_takes([good, str(notes)], str(tmp_path / "narration.wav"))
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "no_audio_stream"
    assert "notes.txt" in err["message"]


def test_concat_takes_refuses_to_overwrite_one_of_its_own_takes(tmp_path, capsys):
    """ffmpeg cannot read and write one path; say so before it tries."""
    a = str(tmp_path / "a.wav")
    out = str(tmp_path / "narration.wav")
    _tone(a, 1.0)
    _tone(out, 1.0)

    with pytest.raises(SystemExit):
        concat_takes([a, out], out)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "invalid_argument"
    assert "narration.wav" in err["message"]
