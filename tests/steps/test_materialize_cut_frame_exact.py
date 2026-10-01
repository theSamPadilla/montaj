"""materialize_cut lands on the exact source frame at frame-boundary inpoints.

Mechanism (FQ54, measured on ffmpeg 8.1): build_ffmpeg_args seeks the input to
near = s - SEEK_PREROLL_S, then trims `fine = s - near` off the decoded head.
The `-ss near` value was formatted to 4 decimals. ffmpeg offsets every frame by
-round(ss / timebase), so a near that rounds UP (149/30 - 2 = 2.966666... ->
"2.9667", 0.512 ticks at 1/15360) shifts the origin one tick past the true near:
frame 149 reaches `trim=start=2.000000` at 30719 ticks against a start of 30720
and is dropped, so the cut starts on frame 150. Every k/fps whose near rounds up
by more than half a tick is hit (k = 2 mod 3 at 30 fps, k = 1 mod 3 at 29.97
and 60), on all-intra and long-GOP sources alike. The same 4-decimal `-t` is
the exact end bound when the inpoint is 0 and admits one extra frame there.

The clips carry their frame index as a binary strip of black/white blocks,
read back by sampling pixels (tests/counter_strip.py), so the assertions are on
exact source indices.
"""
import sys
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "steps" / "transform"))
import materialize_cut  # noqa: E402

from tests.conftest import HAS_FFMPEG, run_step, skip_or_fail  # noqa: E402
from tests.counter_strip import indices as _indices, make_counter_clip  # noqa: E402

N_FRAMES = 170                # covers k = 140..158 plus a 6-frame window
WINDOW = 6
SWEEP = range(140, 159)       # 149 and its neighbours, every residue mod 3


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    if not HAS_FFMPEG:
        skip_or_fail("ffmpeg not available")
    d = tmp_path_factory.mktemp("fq54_counter")
    made = {}
    for name, rate in (("30", "30"), ("29.97", "30000/1001")):
        p = d / f"counter_{name.replace('.', '')}.mp4"
        make_counter_clip(p, rate, N_FRAMES)
        assert _indices(p) == list(range(N_FRAMES)), f"{p.name}: counter strip does not round-trip"
        made[name] = p
    return made


def _cut(src: Path, s: float, e: float, out: Path) -> list:
    materialize_cut._encode_one({"input": str(src), "keeps": [[s, e]]}, str(out))
    return _indices(out)


def _sweep(src: Path, fps: Fraction, out_dir: Path) -> list:
    """[(k, frames)] for inpoint k/fps over SWEEP, each a WINDOW-frame cut."""
    def one(k):
        s, e = float(k / fps), float((k + WINDOW) / fps)
        return k, _cut(src, s, e, out_dir / f"k{k}.mp4")
    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(one, SWEEP))


def test_inpoint_149_over_30_starts_on_frame_149(clips, tmp_path):
    """The reported case, end to end through the step CLI."""
    out = tmp_path / "cut.mp4"
    proc = run_step("materialize_cut.py", "--input", str(clips["30"]),
                    "--inpoint", repr(149 / 30), "--outpoint", repr(155 / 30),
                    "--out", str(out))
    assert proc.returncode == 0, proc.stderr
    assert _indices(out) == list(range(149, 155))


@pytest.mark.parametrize("rate,fps", [("30", Fraction(30)), ("29.97", Fraction(30000, 1001))])
def test_frame_boundary_inpoints_start_on_their_frame(clips, tmp_path, rate, fps):
    wrong = [(k, got) for k, got in _sweep(clips[rate], fps, tmp_path)
             if got != list(range(k, k + WINDOW))]
    assert not wrong, (
        f"{rate} fps: inpoint k/fps must give source frames k..k+{WINDOW - 1}; wrong at "
        + "; ".join(f"k={k} got {got}" for k, got in wrong)
    )


def test_frame_boundary_outpoints_from_zero_end_on_their_frame(clips, tmp_path):
    """Inpoint 0 has no trim filter, so `-t` alone is the end bound."""
    wrong = []
    for j in range(1, 10):
        got = _cut(clips["30"], 0.0, j / 30, tmp_path / f"j{j}.mp4")
        if got != list(range(j)):
            wrong.append((j, got))
    assert not wrong, "outpoint j/30 from 0 must give frames 0..j-1; wrong at " + "; ".join(
        f"j={j} got {got}" for j, got in wrong)
