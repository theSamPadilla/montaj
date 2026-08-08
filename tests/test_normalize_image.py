"""Tests for lib/normalize_image.py — sRGB→HDR image conversion.

Tests cover:
  1. Happy path HLG/PQ: sRGB PNG → HDR PNG that is deliberately UNTAGGED (no
     color_transfer), with pixel values different from the sRGB source (confirms
     the conversion ran) and different between HLG and PQ (confirms the requested
     transfer curve actually took effect). The output must stay untagged so
     Chromium does not color-manage it back into the sRGB page raster.
  2. Idempotency: second call with fresh cache returns instantly (mtime unchanged).
  3. Atomic rename: successful conversion leaves only the final file (no .tmp.*
     siblings). A failed conversion (bad input) must not create the out_path.
  4. Invalid color space: ValueError on non-HDR keys.
  5. Already-HDR short-circuit: HLG-tagged source passed to hdr_hlg target copies
     the file instead of re-converting.
  6. CLI: python3 -m lib.normalize_image exits 0, stdout == out path, file exists.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

import shutil

from lib.normalize_image import convert_image

HAS_FFMPEG = shutil.which("ffmpeg") is not None
HAS_ZSCALE = False
if HAS_FFMPEG:
    _r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-filters"],
        capture_output=True, text=True, timeout=5,
    )
    HAS_ZSCALE = _r.returncode == 0 and "zscale" in (_r.stdout or "")

pytestmark = pytest.mark.skipif(
    not (HAS_FFMPEG and HAS_ZSCALE),
    reason="ffmpeg + zscale required",
)


# ── helpers ────────────────────────────────────────────────────────────────────

def _make_srgb_png(path: Path, width: int = 64, height: int = 64,
                   color: str = "0x804040") -> None:
    """Create a small sRGB PNG via ffmpeg lavfi with no ICC profile."""
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=c={color}:size={width}x{height}:rate=1:duration=1",
        "-frames:v", "1",
        "-pix_fmt", "rgba",
        "-update", "1",
        str(path),
    ], check=True, capture_output=True, timeout=30)


def _make_hlg_png(path: Path, width: int = 64, height: int = 64) -> None:
    """Create a small PNG tagged with HLG (arib-std-b67) transfer via ffmpeg.

    Uses setparams to declare bt709/sRGB input then zscale to convert to HLG.
    setparams is required because lavfi sources carry no color metadata and
    zscale needs declared input colorspace to find the conversion path.
    """
    subprocess.run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=c=0x804040:size={width}x{height}:rate=1:duration=1",
        "-frames:v", "1",
        "-vf", (
            "setparams=color_trc=iec61966-2-1:color_primaries=bt709:colorspace=bt709,"
            "zscale=t=linear:npl=100,"
            "format=gbrpf32le,"
            "zscale=pin=bt709:t=arib-std-b67:p=bt2020:m=bt2020nc:r=tv"
        ),
        "-pix_fmt", "rgb24",
        "-update", "1",
        str(path),
    ], check=True, capture_output=True, timeout=30)


def _probe_transfer(path: Path) -> str | None:
    """Return color_transfer of the first stream via ffprobe, or None."""
    r = subprocess.run([
        "ffprobe", "-v", "quiet",
        "-show_entries", "stream=color_transfer",
        "-of", "json", str(path),
    ], capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        return None
    streams = json.loads(r.stdout).get("streams", [])
    return streams[0].get("color_transfer") if streams else None


def _read_center_pixel(path: Path) -> tuple[int, int, int]:
    """Return (R, G, B) of the center pixel via ffprobe/rawvideo decode."""
    r = subprocess.run([
        "ffprobe", "-v", "quiet",
        "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
        "-f", "lavfi",
        "-i", f"movie={path},signalstats",
        "-of", "json",
    ], capture_output=True, text=True, timeout=10)
    # Fall back to a simpler approach: decode one frame to PNG and read with ffprobe
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_name = tmp.name
    try:
        subprocess.run([
            "ffmpeg", "-y", "-i", str(path),
            "-frames:v", "1",
            "-update", "1",
            tmp_name,
        ], check=True, capture_output=True, timeout=10)
        # Use ffprobe to get pixel format info and rawvideo for actual pixels
        r2 = subprocess.run([
            "ffmpeg", "-y", "-i", tmp_name,
            "-vf", "crop=1:1:iw/2:ih/2",
            "-frames:v", "1",
            "-pix_fmt", "rgb24",
            "-f", "rawvideo",
            "pipe:1",
        ], capture_output=True, timeout=10)
        if r2.returncode == 0 and len(r2.stdout) >= 3:
            data = r2.stdout[:3]
            return (data[0], data[1], data[2])
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
    return (0, 0, 0)


# ── test 1: happy path HLG ─────────────────────────────────────────────────────

def test_convert_image_hlg_produces_untagged_output(tmp_path):
    """sRGB PNG input → convert_image hdr_hlg → HDR-encoded but *untagged* PNG.

    The output deliberately carries NO color metadata: the filter graph's final
    `setparams=color_trc=unknown:...` strips it. This is load-bearing rather than
    incidental — a cICP chunk tagging the file BT.2020/HLG makes Chromium
    color-manage the image into the sRGB page raster, destroying the pre-encoded
    HDR values the renderer's interceptor relies on passing through untouched.
    So the correct assertion is the *absence* of a transfer tag, not its presence.

    Because the tag is gone, it can no longer serve as evidence the conversion
    ran — the pixel check below carries that weight instead, and
    `test_hlg_and_pq_produce_different_pixels` carries the "the requested
    transfer actually took effect" half that the tag used to prove.
    """
    src = tmp_path / "srgb.png"
    out = tmp_path / "out_hlg.png"
    _make_srgb_png(src, color="0x800010")

    result = convert_image(str(src), "hdr_hlg", out_path=str(out))

    assert result == str(out)
    assert out.exists()
    transfer = _probe_transfer(out)
    assert transfer is None, (
        f"HLG output must be untagged so Chromium does not color-manage it, "
        f"got color_transfer={transfer!r}"
    )
    # The conversion must still have actually run.
    src_px = _read_center_pixel(src)
    out_px = _read_center_pixel(out)
    assert any(abs(o - s) > 5 for o, s in zip(out_px, src_px)), (
        f"Pixel values unchanged after HLG conversion: src={src_px} out={out_px} "
        "— conversion may be a no-op"
    )


def test_convert_image_hlg_pixel_values_differ_from_source(tmp_path):
    """HLG conversion must produce pixel values different from the sRGB source.

    A known sRGB swatch (R≈128/255) should produce a different R value in the
    HLG-encoded output — confirming the zscale chain ran rather than being a
    passthrough copy.
    """
    src = tmp_path / "srgb.png"
    out = tmp_path / "out_hlg.png"
    # R=128 = 0x80 in decimal, green/blue low so channel difference is clear
    _make_srgb_png(src, color="0x800010")

    convert_image(str(src), "hdr_hlg", out_path=str(out))

    src_r, src_g, src_b = _read_center_pixel(src)
    out_r, out_g, out_b = _read_center_pixel(out)

    # The conversion (linear boost + transfer curve change) must produce a
    # meaningfully different value — tolerance ±2 to account for 8-bit rounding,
    # but we expect a large shift, not equality.
    assert abs(out_r - src_r) > 5 or abs(out_g - src_g) > 5 or abs(out_b - src_b) > 5, (
        f"Pixel values unchanged after HLG conversion: "
        f"src={src_r,src_g,src_b} out={out_r,out_g,out_b} — "
        "conversion may be a no-op"
    )


def test_convert_image_pq_produces_untagged_output(tmp_path):
    """sRGB PNG input → convert_image hdr_pq → HDR-encoded but *untagged* PNG.

    Same contract as the HLG case above — see that docstring for why untagged
    output is the requirement rather than a smpte2084 tag.
    """
    src = tmp_path / "srgb.png"
    out = tmp_path / "out_pq.png"
    _make_srgb_png(src, color="0x800010")

    result = convert_image(str(src), "hdr_pq", out_path=str(out))

    assert result == str(out)
    assert out.exists()
    transfer = _probe_transfer(out)
    assert transfer is None, (
        f"PQ output must be untagged so Chromium does not color-manage it, "
        f"got color_transfer={transfer!r}"
    )
    src_px = _read_center_pixel(src)
    out_px = _read_center_pixel(out)
    assert any(abs(o - s) > 5 for o, s in zip(out_px, src_px)), (
        f"Pixel values unchanged after PQ conversion: src={src_px} out={out_px} "
        "— conversion may be a no-op"
    )


def test_hlg_and_pq_produce_different_pixels(tmp_path):
    """hdr_hlg and hdr_pq must encode the same source to different pixel values.

    This replaces the discriminating power the old color_transfer assertions
    provided. Now that both outputs are deliberately untagged, "is it untagged?"
    and "did pixels change?" would BOTH still pass if `hdr_pq` silently ran the
    HLG chain (or vice versa) — the transfer curve is the only thing that
    differs between them, and nothing else in the suite would notice. Comparing
    the two encodings against each other is what keeps `dst_transfer` honest.
    """
    src = tmp_path / "srgb.png"
    hlg = tmp_path / "out_hlg.png"
    pq  = tmp_path / "out_pq.png"
    _make_srgb_png(src, color="0x800010")

    convert_image(str(src), "hdr_hlg", out_path=str(hlg))
    convert_image(str(src), "hdr_pq",  out_path=str(pq))

    hlg_px = _read_center_pixel(hlg)
    pq_px  = _read_center_pixel(pq)
    assert hlg_px != pq_px, (
        f"HLG and PQ produced identical pixels ({hlg_px}) — the requested "
        "transfer curve is not reaching the zscale chain"
    )


# ── test 2: idempotency ────────────────────────────────────────────────────────

def test_convert_image_idempotent(tmp_path):
    """Second call with a fresh cache returns instantly and leaves mtime unchanged."""
    src = tmp_path / "srgb.png"
    out = tmp_path / "out_hlg.png"
    _make_srgb_png(src)

    # First call — converts
    convert_image(str(src), "hdr_hlg", out_path=str(out))
    assert out.exists()
    mtime_after_first = os.path.getmtime(str(out))

    # Ensure at least 1ms passes so a new write would have a different mtime
    time.sleep(0.01)

    # Second call — must hit the idempotency cache
    t0 = time.monotonic()
    result = convert_image(str(src), "hdr_hlg", out_path=str(out))
    elapsed_ms = (time.monotonic() - t0) * 1000

    assert result == str(out)
    assert elapsed_ms < 500, (
        f"Second call took {elapsed_ms:.0f}ms — expected < 500ms (cache hit)"
    )
    mtime_after_second = os.path.getmtime(str(out))
    assert mtime_after_second == mtime_after_first, (
        "mtime changed on second call — ffmpeg was re-run when it shouldn't have been"
    )


# ── test 3: atomic rename / no partial-write artifacts ────────────────────────

def test_convert_image_no_tmp_file_on_success(tmp_path):
    """After a successful conversion the .tmp.<pid> file must not exist."""
    src = tmp_path / "srgb.png"
    out = tmp_path / "out_hlg.png"
    _make_srgb_png(src)

    convert_image(str(src), "hdr_hlg", out_path=str(out))

    # No .tmp.* siblings should remain
    siblings = list(tmp_path.glob("out_hlg.png.tmp.*"))
    assert siblings == [], f"Leftover tmp files: {siblings}"
    assert out.exists()


def test_convert_image_no_output_on_failure(tmp_path):
    """If ffmpeg fails (non-existent input), out_path must NOT be created."""
    out = tmp_path / "out_hlg.png"
    bad_src = str(tmp_path / "does_not_exist.png")

    # convert_image calls fail() which calls sys.exit(1) — catch SystemExit
    with pytest.raises(SystemExit):
        convert_image(bad_src, "hdr_hlg", out_path=str(out))

    assert not out.exists(), "out_path was created despite ffmpeg failure"
    siblings = list(tmp_path.glob("out_hlg.png.tmp.*"))
    assert siblings == [], f"Leftover tmp files after failure: {siblings}"


# ── test 4: invalid color space ────────────────────────────────────────────────

def test_convert_image_raises_for_sdr_key(tmp_path):
    """convert_image with sdr_bt709 must raise ValueError."""
    src = tmp_path / "srgb.png"
    out = tmp_path / "out.png"
    _make_srgb_png(src)

    with pytest.raises(ValueError, match="hdr_hlg|hdr_pq"):
        convert_image(str(src), "sdr_bt709", out_path=str(out))


def test_convert_image_raises_for_unknown_key(tmp_path):
    """convert_image with an unknown key must raise ValueError."""
    src = tmp_path / "srgb.png"
    out = tmp_path / "out.png"
    _make_srgb_png(src)

    with pytest.raises(ValueError):
        convert_image(str(src), "hdr_xyz", out_path=str(out))


# ── test 5: already-HDR short-circuit ─────────────────────────────────────────

def test_convert_image_short_circuits_for_hlg_tagged_source(tmp_path):
    """HLG-tagged source passed to hdr_hlg target: copy, not re-convert."""
    src = tmp_path / "already_hlg.png"
    out = tmp_path / "out_hlg.png"
    _make_hlg_png(src)

    # Confirm the input is actually tagged HLG
    src_transfer = _probe_transfer(src)
    if src_transfer != "arib-std-b67":
        pytest.skip(
            f"ffmpeg did not tag the HLG source with arib-std-b67 (got {src_transfer!r}); "
            "short-circuit test requires a properly tagged source"
        )

    result = convert_image(str(src), "hdr_hlg", out_path=str(out))

    assert result == str(out)
    assert out.exists()
    # The copy must be pixel-perfect: same file size as source
    assert out.stat().st_size == src.stat().st_size, (
        f"Copied file size {out.stat().st_size} != source size {src.stat().st_size} — "
        "file was re-encoded instead of copied"
    )
    # Verify output is also tagged HLG
    out_transfer = _probe_transfer(out)
    assert out_transfer == "arib-std-b67"


# ── test 6: CLI ────────────────────────────────────────────────────────────────

def test_cli_exits_zero_and_prints_path(tmp_path):
    """python3 -m lib.normalize_image exits 0, stdout == out path, file exists."""
    src = tmp_path / "srgb.png"
    out = tmp_path / "cli_out.png"
    _make_srgb_png(src)

    r = subprocess.run([
        sys.executable, "-m", "lib.normalize_image",
        "--input", str(src),
        "--color-space", "hdr_hlg",
        "--out", str(out),
    ], capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=60)

    assert r.returncode == 0, f"CLI exited {r.returncode}\nstderr: {r.stderr}"
    stdout_path = r.stdout.strip()
    assert stdout_path == str(out), (
        f"CLI stdout {stdout_path!r} != expected out path {str(out)!r}"
    )
    assert out.exists(), "CLI reported success but output file does not exist"


def test_cli_fails_for_bad_input(tmp_path):
    """CLI exits non-zero when the input file does not exist."""
    out = tmp_path / "out.png"
    r = subprocess.run([
        sys.executable, "-m", "lib.normalize_image",
        "--input", str(tmp_path / "no_such_file.png"),
        "--color-space", "hdr_hlg",
        "--out", str(out),
    ], capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=30)

    assert r.returncode != 0, "CLI should exit non-zero for missing input"


# ── test for is_hdr helper ─────────────────────────────────────────────────────

def test_is_hdr_helper():
    """is_hdr returns True for HDR keys and False for SDR or unknown."""
    from lib.types.colorspace import is_hdr
    assert is_hdr("hdr_hlg") is True
    assert is_hdr("hdr_pq") is True
    assert is_hdr("sdr_bt709") is False
    assert is_hdr("unknown") is False
    assert is_hdr("") is False
