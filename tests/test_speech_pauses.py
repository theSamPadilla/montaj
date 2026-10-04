"""Pause map (PL44 T3): silences measured from the audio, threshold per source."""
import json
import re
import subprocess
from pathlib import Path

import pytest

from lib.common import ffmpeg_bin
from lib import speech_pauses
from lib.speech_pauses import noise_floor_db, silences

FIXTURE = Path(__file__).parent / "fixtures" / "speech_text"
README = FIXTURE / "README.md"
SPEECH = str(FIXTURE / "speech.mp4")
EDGE_TOL = 0.03


def _measured_section():
    return README.read_text().split("## Measured silences", 1)[1].split("\n## ", 1)[0]


def readme_raw_pauses():
    rows = re.findall(r"^\| (\d+\.\d+) \| (\d+\.\d+) \| \d+\.\d+ \|$", _measured_section(), re.M)
    return [(float(a), float(b)) for a, b in rows]


def readme_pauses():
    """The measured silence table in the fixture README, as (start, end).

    The README lists silencedetect's raw output; silences() merges those closer
    than 0.02 s, so compare against the same merge."""
    merged = []
    for a, b in readme_raw_pauses():
        if merged and a - merged[-1][1] < 0.02:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    return merged


def readme_floor_db():
    return float(re.search(r"Noise floor (-?\d+\.\d+) dB", _measured_section()).group(1))


def edge_hits(found, expected):
    """Expected pauses with a found silence matching both edges within EDGE_TOL."""
    return [p for p in expected
            if any(abs(f[0] - p[0]) <= EDGE_TOL and abs(f[1] - p[1]) <= EDGE_TOL for f in found)]


def cover_hits(found, expected):
    """Expected pauses whose midpoint lies inside a found silence (noise moves
    the edges, so edges are not asked of a noisy map)."""
    return [p for p in expected
            if any(f[0] <= (p[0] + p[1]) / 2 <= f[1] for f in found)]


def fixed_silences(path, db=-35):
    r = subprocess.run([ffmpeg_bin(), "-i", path, "-af",
                        f"silencedetect=noise={db}dB:d={speech_pauses.MIN_SILENCE_S}",
                        "-f", "null", "-"], capture_output=True, text=True)
    out, start = [], None
    for line in r.stderr.splitlines():
        s = re.search(r"silence_start: (-?[\d.]+)", line)
        e = re.search(r"silence_end: ([\d.]+)", line)
        if s:
            start = max(0.0, float(s.group(1)))
        if e and start is not None:
            out.append((start, float(e.group(1))))
            start = None
    return out


def test_readme_table_parses():
    stated = int(re.search(r"(\d+) silences;", _measured_section()).group(1))
    assert len(readme_raw_pauses()) == stated


def test_fixture_pauses_found():
    expected = readme_pauses()
    found = silences(SPEECH)
    missed = [p for p in expected if p not in edge_hits(found, expected)]
    assert not missed, f"missed {len(missed)} of {len(expected)}: {missed}"


def test_noise_floor_of_fixture():
    assert noise_floor_db(SPEECH) == pytest.approx(readme_floor_db(), abs=0.5)


def test_window_offsets_to_source_time():
    # a window around the longest README pause: results are in source seconds
    # (not window-relative), clipped to the window, and the pause is found
    pause = max(readme_pauses(), key=lambda p: p[1] - p[0])
    lo, hi = max(0.0, pause[0] - 1.0), pause[1] + 1.0
    found = silences(SPEECH, lo, hi)
    assert found and all(lo <= a and b <= hi + 1e-6 for a, b in found)
    assert edge_hits(found, [pause])


def test_noise_defeats_fixed_threshold_not_adaptive(tmp_path):
    """Noise raises the floor. A fixed -35 dB threshold loses the pauses; the
    per-source threshold keeps them. If no amplitude defeats the fixed
    threshold, this test fails: the fixture cannot show the difference."""
    # pauses of 0.15 s or more: the ones the app shows
    expected = [p for p in readme_pauses() if p[1] - p[0] >= 0.15]
    assert len(expected) >= 8
    results = []
    for a in (0.005, 0.01, 0.02, 0.04):
        noisy = str(tmp_path / f"noisy_{a}.mp4")
        subprocess.run([ffmpeg_bin(), "-y", "-i", SPEECH,
                        "-f", "lavfi", "-i", f"anoisesrc=color=pink:amplitude={a}:sample_rate=16000:duration=31:seed=7",
                        "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]",
                        "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", noisy],
                       check=True, capture_output=True)
        fixed = len(cover_hits(fixed_silences(noisy), expected)) / len(expected)
        adaptive = len(cover_hits(silences(noisy), expected)) / len(expected)
        results.append((a, fixed, adaptive))
        if fixed < 0.5:
            assert adaptive >= 0.8, f"amplitude {a}: fixed {fixed:.2f}, adaptive {adaptive:.2f}"
            return
    pytest.fail(f"no amplitude defeated the fixed -35 dB threshold: {results}")


def test_no_audio_stream_fails(tmp_path, capsys):
    silent = str(tmp_path / "video_only.mp4")
    subprocess.run([ffmpeg_bin(), "-y", "-f", "lavfi", "-i", "color=black:s=64x64:r=30:d=1",
                    "-c:v", "libx264", silent], check=True, capture_output=True)
    with pytest.raises(SystemExit):
        silences(silent)
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["error"] == "no_audio"
    with pytest.raises(SystemExit):
        noise_floor_db(silent)
