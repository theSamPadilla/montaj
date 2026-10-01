"""normalize_window lands on the exact source frame at frame-boundary inpoints.

Mechanism (FQ54, measured on ffmpeg 8.1): normalize_window seeks the input to
near = in - SEEK_PREROLL_S, trims `fine = in - near` with
`trim=start=fine`, and rebases with an output-side `-ss fine`. Both `-ss`
values were formatted to 4 decimals, and either one rounding UP past a frame
time drops the frame at the inpoint:
  * in >= 2 s: the input `-ss near` ("2.9667" for 149/30) shifts every frame by
    one extra tick, so frame 149 reaches the trim just before its start;
  * in < 2 s: near is 0 and the output `-ss fine` ("0.0667" for 2/30) drops the
    frame the trim kept.
The video then starts one frame late at 0.033 s while the audio starts at 0,
which reads back at constant rate as frame k+1 shown twice (k = 2 mod 3 at
30 fps, k = 1 mod 3 at 29.97 and 60). With inpoint 0 the 4-decimal `-t` is the
exact end bound and admitted one extra frame the same way.
"""
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction

import pytest

from lib.normalize import normalize_window
from tests.conftest import HAS_FFMPEG, run_step, skip_or_fail
from tests.counter_strip import indices, make_counter_clip

N_FRAMES = 170                # covers k = 140..158 plus a 6-frame window
WINDOW = 6
RATES = {"30": Fraction(30), "29.97": Fraction(30000, 1001)}
SWEEP = list(range(1, 9)) + list(range(140, 159))  # below 2 s (output -ss) and around 149


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    if not HAS_FFMPEG:
        skip_or_fail("ffmpeg not available")
    d = tmp_path_factory.mktemp("fq54_nw_counter")
    made = {}
    for name, rate in (("30", "30"), ("29.97", "30000/1001")):
        p = d / f"counter_{name.replace('.', '')}.mp4"
        make_counter_clip(p, rate, N_FRAMES)
        assert indices(p) == list(range(N_FRAMES)), f"{p.name}: counter strip does not round-trip"
        made[name] = p
    return made


def _window(src, s, e, out):
    normalize_window(str(src), str(out), "sdr_bt709", s, e)
    return indices(out)


def test_inpoint_149_over_30_starts_on_frame_149(clips, tmp_path):
    """The reported case, end to end through the step CLI."""
    out = tmp_path / "nw.mp4"
    proc = run_step("normalize_window.py", "--input", str(clips["30"]),
                    "--inpoint", repr(149 / 30), "--outpoint", repr(155 / 30),
                    "--color-space", "sdr_bt709", "--out", str(out))
    assert proc.returncode == 0, proc.stderr
    assert indices(out) == list(range(149, 155))


@pytest.mark.parametrize("rate", list(RATES))
def test_frame_boundary_inpoints_start_on_their_frame(clips, tmp_path, rate):
    fps = RATES[rate]

    def one(k):
        s, e = float(k / fps), float((k + WINDOW) / fps)
        return k, _window(clips[rate], s, e, tmp_path / f"k{k}.mp4")

    with ThreadPoolExecutor(max_workers=4) as pool:
        got = list(pool.map(one, SWEEP))
    wrong = [(k, idx) for k, idx in got if idx != list(range(k, k + WINDOW))]
    assert not wrong, (
        f"{rate} fps: inpoint k/fps must give source frames k..k+{WINDOW - 1}; wrong at "
        + "; ".join(f"k={k} got {idx}" for k, idx in wrong)
    )


def test_frame_boundary_outpoints_from_zero_end_on_their_frame(clips, tmp_path):
    """Inpoint 0 has no trim filter, so `-t` alone is the end bound."""
    wrong = []
    for j in range(1, 10):
        got = _window(clips["30"], 0.0, j / 30, tmp_path / f"j{j}.mp4")
        if got != list(range(j)):
            wrong.append((j, got))
    assert not wrong, "outpoint j/30 from 0 must give frames 0..j-1; wrong at " + "; ".join(
        f"j={j} got {got}" for j, got in wrong)
