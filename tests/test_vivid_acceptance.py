"""SP6b whole-SP acceptance: preview vs render traverse the SAME default LUT.

MASTER SP6's gate: a golden-frame preview-vs-render comparison within a defined
tolerance. The editor preview of an HDR project plays the SDR proxy, graded
through the default look; the SDR export is composed per layer, and an HDR
clip's grade is encode-segment.js's buildColorConversionFilter('hdr_hlg',
'sdr_bt709') through the same LUT. Since PL24 that LUT is montaj-natural-v1.cube
(natural1, Apple's own HLG-to-SDR conversion); it was montaj-vivid-v1.cube
before. Both sides tone-map through it, one in Python's proxy encode and one in
the JS export filter, so a frame sampled from each at the same timestamp must
agree to SSIM >= 0.93 at matched resolution. The tolerance absorbs
scaler/encoder drift (H.264 proxy vs x264 export), nothing else, and a negative
control below proves it still fails when the two sides use different looks.

The fixture is deliberately saturated, structured content (smptehdbars): a flat
gray fixture would make the SSIM gate trivially weak.
"""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

from lib.normalize import (
    _build_tonemap_vf_to_sdr,
    _has_lut3d,
    _has_zscale,
    probe_video,
)
from lib.proxy import _build_proxy_cmd

from tests.conftest import HAS_FFMPEG, FFMPEG_BIN  # the ffmpeg the code runs (PV52)
HAS_NODE = shutil.which("node") is not None

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")

REPO = Path(__file__).resolve().parent.parent
ENCODE_SEGMENT_JS = REPO / "montaj_assets" / "render" / "encode-segment.js"


def _make_hlg_bars(path: Path, *, duration=2):
    """Static, saturated, structured HLG source (see module docstring).

    Same x265-params trick as tests/test_normalize.py's _make_hdr_like_video:
    stream-level -color_trc alone doesn't stick for lavfi sources, but libx265
    writes transfer= into the bitstream and ffprobe reads it back.
    """
    subprocess.run([
        FFMPEG_BIN, "-y", "-v", "error",
        "-f", "lavfi", "-i", f"smptehdbars=size=1280x720:rate=30:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}",
        "-c:v", "libx265", "-preset", "ultrafast", "-crf", "22",
        "-pix_fmt", "yuv420p10le",
        "-x265-params", "transfer=arib-std-b67:colorprim=bt2020:colormatrix=bt2020nc",
        "-color_trc", "arib-std-b67",
        "-color_primaries", "bt2020",
        "-colorspace", "bt2020nc",
        "-g", "30", "-keyint_min", "30",
        "-c:a", "aac", "-ar", "48000",
        str(path),
    ], check=True, capture_output=True, timeout=120)


def _extract_frame(video: Path, png: Path, *, at=1.0):
    subprocess.run([
        FFMPEG_BIN, "-y", "-v", "error",
        "-i", str(video), "-ss", str(at),
        "-frames:v", "1", "-update", "1",
        "-vf", "scale=1280:720",
        str(png),
    ], check=True, capture_output=True, timeout=60)


def _ssim(a: Path, b: Path) -> float:
    out = subprocess.run([
        FFMPEG_BIN, "-v", "info",
        "-i", str(a), "-i", str(b),
        "-filter_complex", "[0:v][1:v]ssim",
        "-f", "null", "-",
    ], check=True, capture_output=True, text=True, timeout=60)
    m = re.search(r"All:([0-9.]+)", out.stderr)
    assert m, f"no SSIM in ffmpeg output:\n{out.stderr}"
    return float(m.group(1))


NATURAL_CUBE = "montaj-natural-v1.cube"
VIVID_CUBE = "montaj-vivid-v1.cube"
PARITY_SSIM = 0.93


def _preview_proxy(master: Path, tmp_path: Path) -> tuple[Path, str]:
    """The SDR proxy exactly as the editor gets it (the graded proxy arm, at
    proxy quality). Returns the file and the command line that built it."""
    info = probe_video(str(master))
    assert info is not None
    proxy = tmp_path / "bars_proxy.mp4"
    proxy_cmd, used_fallback = _build_proxy_cmd(
        str(master), str(proxy), tonemap=True, info=info
    )
    assert not used_fallback
    subprocess.run(proxy_cmd, check=True, capture_output=True, timeout=300)
    return proxy, " ".join(proxy_cmd)


def _derived_sdr(master: Path, tmp_path: Path, sdr_curve: str | None = None) -> tuple[Path, str]:
    """The grade the per-layer SDR compose applies to an HDR clip, from the
    real JS filter builder (`sdr_curve` None is `--export sdr` without
    `--sdr-curve`), then the compose's yuv420p output format."""
    curve = "null" if sdr_curve is None else repr(sdr_curve)
    chain = subprocess.run(
        ["node", "-e",
         "import(process.argv[1]).then(m => console.log("
         "m.buildColorConversionFilter('hdr_hlg', 'sdr_bt709', true, "
         f"{{hasLut3d: true, sdrCurve: {curve}}})))",
         str(ENCODE_SEGMENT_JS)],
        check=True, capture_output=True, text=True, timeout=60,
    ).stdout.strip()
    assert chain
    derived = tmp_path / f"bars-sdr-{sdr_curve or 'default'}.mp4"
    subprocess.run([FFMPEG_BIN, "-y", "-i", str(master), "-vf", f"{chain},format=yuv420p",
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", str(derived)],
                   check=True, capture_output=True, timeout=300)
    return derived, chain


def _frame_ssim(a: Path, b: Path, tmp_path: Path) -> float:
    a_png = tmp_path / f"{a.stem}.png"
    b_png = tmp_path / f"{b.stem}.png"
    _extract_frame(a, a_png)
    _extract_frame(b, b_png)
    return _ssim(a_png, b_png)


def _needs_lut_chain():
    if not (_has_zscale() and _has_lut3d()):
        pytest.skip("ffmpeg lacks zscale/lut3d")
    if not HAS_NODE:
        pytest.skip("node not available")


@pytest.mark.slow
def test_vivid_preview_matches_derived_sdr_render(tmp_path):
    """Proxy frame (preview) vs the default SDR export frame: both run the
    natural1 cube, and SSIM >= 0.93."""
    _needs_lut_chain()

    master = tmp_path / "bars.mp4"
    _make_hlg_bars(master)

    proxy, proxy_cmd = _preview_proxy(master, tmp_path)
    derived, chain = _derived_sdr(master, tmp_path)

    # Same LUT on both sides, and it is the natural1 cube. A preview on one
    # look and an export on another is exactly what this gate exists to stop.
    assert f"/{NATURAL_CUBE}:" in proxy_cmd, proxy_cmd
    assert f"/{NATURAL_CUBE}:" in chain, chain
    assert VIVID_CUBE not in proxy_cmd and VIVID_CUBE not in chain

    probe = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=color_transfer", "-of", "csv=p=0",
        str(derived),
    ], check=True, capture_output=True, text=True, timeout=30)
    assert probe.stdout.strip() == "bt709"

    score = _frame_ssim(proxy, derived, tmp_path)
    print(f"parity SSIM (natural1 proxy vs default derived SDR): {score:.4f}")
    assert score >= PARITY_SSIM


@pytest.mark.slow
def test_parity_gate_fails_when_preview_and_export_looks_diverge(tmp_path):
    """Negative control: the same proxy against an export graded through
    vivid1 must FAIL the parity tolerance, or the gate above could not tell the
    two looks apart and would pass a divergence."""
    _needs_lut_chain()

    master = tmp_path / "bars.mp4"
    _make_hlg_bars(master)

    proxy, _ = _preview_proxy(master, tmp_path)
    vivid, chain = _derived_sdr(master, tmp_path, "vivid1")
    assert f"/{VIVID_CUBE}:" in chain, chain

    score = _frame_ssim(proxy, vivid, tmp_path)
    print(f"divergent SSIM (natural1 proxy vs vivid1 derived SDR): {score:.4f}")
    assert score < PARITY_SSIM


@pytest.mark.slow
def test_tonemap_chain_output_matches_the_lut_grade(tmp_path):
    """The chain's tail must not re-grade what the LUT already graded.

    The test above compares the proxy against the derived SDR export — both
    run this same chain, so it measures self-consistency and is structurally
    blind to any defect the two sides share. This one is absolute: it pins the
    chain's *output* against the LUT's own output, which is the grade Sam
    signed off on.

    The bug this exists for: the trailing zscale was given `t=bt709:p=bt709`
    without `tin=`/`pin=`, so it converted rather than retagged — re-running
    HLG→709 and BT.2020→709 over already-tone-mapped pixels. Highlights
    clipped per channel and hue shifted; a warm white wall rendered pure
    yellow and a window cyan, in every vivid1 proxy and every derived SDR
    export of the time.

    Threshold note: on this saturated-bars fixture the broken chain still
    scored 0.938 — it sits above the sibling test's 0.93 tolerance, so that
    gate could not have caught this even had it been absolute. Real footage
    separates far harder (0.785 broken vs 0.990 fixed); bars understate the
    damage because their primaries already sit near the gamut corners. The
    fixed chain is a bit-exact 1.000 here, since a correct tail is a pure
    retag, so 0.99 is a wide margin rather than a tight fit.
    """
    if not (_has_zscale() and _has_lut3d()):
        pytest.skip("ffmpeg lacks zscale/lut3d")

    master = tmp_path / "bars.mp4"
    _make_hlg_bars(master, duration=1)

    vf, used_fallback = _build_tonemap_vf_to_sdr("hdr_hlg")
    assert not used_fallback

    # Reference = the chain truncated just before its trailing retag, i.e. the
    # LUT's own output. Derived from the production builder rather than a
    # copy, so the two sides cannot drift apart.
    graded, _, tail = vf.rpartition(",")
    assert tail.startswith("zscale="), f"chain must end with the retag, got: {tail}"

    ref_png = tmp_path / "ref.png"
    out_png = tmp_path / "out.png"
    for png, chain in ((ref_png, graded), (out_png, vf)):
        subprocess.run([
            FFMPEG_BIN, "-y", "-v", "error", "-i", str(master),
            "-frames:v", "1", "-update", "1",
            "-vf", f"{chain},format=rgb24", str(png),
        ], check=True, capture_output=True, timeout=120)

    score = _ssim(ref_png, out_png)
    print(f"vivid chain fidelity SSIM (chain output vs LUT grade): {score:.4f}")
    assert score >= 0.99, (
        f"the chain's tail altered the LUT grade (SSIM {score:.4f}) — it must "
        f"retag, not re-convert. Check tin=/pin= on: {tail}"
    )


def test_zscale_absent_path_still_falls_back_loudly(monkeypatch):
    """The degraded-capability arm survives SP6b: hable chain + loud warning.

    The chain fallback itself is pinned in tests/test_normalize.py; this guards
    the acceptance criterion that the warning stays LOUD — both normalize entry
    points must still emit the all-caps zscale warning on the fallback path.
    """
    import inspect

    import lib.normalize as nm

    monkeypatch.setattr(nm, "_has_zscale", lambda: False)
    monkeypatch.setattr(nm, "_has_lut3d", lambda: False)
    vf, used_fallback = nm._build_color_conversion_vf("hdr_hlg", "sdr_bt709")
    assert used_fallback
    assert "tonemap=hable:desat=0" in vf
    assert "lut3d" not in vf

    warning = "WARNING: zscale filter NOT AVAILABLE"
    assert inspect.getsource(nm.normalize).count(warning) == 1
    assert inspect.getsource(nm.normalize_window).count(warning) == 1
