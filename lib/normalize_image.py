#!/usr/bin/env python3
"""Convert an sRGB image to an HDR-encoded PNG (HLG or PQ).

Applies the same zscale colorspace conversion chain that the render pipeline
uses for video — extended with an alphaextract/alphamerge split so PNG sources
with transparency are handled correctly (zscale rejects alpha pixel formats).
A 2x linear brightness boost (colorchannelmixer rr=2:gg=2:bb=2) is baked in so
composited images visually match the brightness of text/shape overlays, which
land at ~203 nits when reinterpreted as HLG.

Output is 8-bit RGBA PNG with no embedded ICC profile. 8-bit is intentional:
the Puppeteer interceptor path screenshots through Chromium's 8-bit framebuffer,
so a 16-bit cached PNG would be truncated to 8-bit before encode-segment ever
sees it.

Idempotency: if out_path already exists and its mtime >= src's mtime the file
is returned immediately without spawning ffmpeg.

Atomic write: output is written to <out_path>.tmp.<pid> then os.replace'd so
concurrent callers can't read a partial file.

Invocation modes:
  - Direct import: renderer.js subprocess spawn
  - Module: python3 -m lib.normalize_image (same API as lib.normalize)
The sys.path.insert below adds lib/ itself so `from common import ...` works in
both invocation modes.
"""
import sys, os, json, subprocess, argparse

sys.path.insert(0, os.path.dirname(__file__))  # add lib/ so `from common` works in all invocation modes
from common import fail, require_file, progress, ffmpeg_bin, ffprobe_bin

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))  # add repo root so `from lib.types.colorspace` works
from lib.types.colorspace import SPECS, is_hdr

# Only hdr_hlg and hdr_pq are valid targets for image conversion.
_VALID_DST = ("hdr_hlg", "hdr_pq")


def _probe_image_stream(path: str) -> dict:
    """Return stream metadata for the first video stream of an image via ffprobe.

    Keys include 'color_transfer' (str|None) and 'pix_fmt' (str|None).
    Returns an empty dict on ffprobe failure.
    """
    cmd = [
        ffprobe_bin(), "-v", "quiet",
        "-show_entries", "stream=color_transfer,pix_fmt",
        "-of", "json", path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        return {}
    streams = json.loads(r.stdout).get("streams", [])
    return streams[0] if streams else {}


def _has_alpha_pix_fmt(pix_fmt: str | None) -> bool:
    """Return True if the pixel format includes an alpha channel."""
    if not pix_fmt:
        return False
    # Common alpha-capable formats: rgba, argb, bgra, yuva*, gbrap*
    return "a" in pix_fmt.lower() and pix_fmt.lower() not in ("ya8",)


def _build_core_hdr_chain(dst_color_space: str) -> str:
    """Core zscale HDR conversion chain (no alpha handling, no setparams prefix).

    Input MUST already have sRGB color metadata declared (via setparams or the
    source itself). This chain assumes bt709/iec61966-2-1 input and converts to
    bt2020 + HLG or PQ transfer with a 2× linear brightness boost.

    Chain:
      1. zscale t=linear:npl=100 — linearise from the declared sRGB transfer.
      2. format=gbrpf32le — planar float for the brightness multiply.
      3. colorchannelmixer rr=2:gg=2:bb=2 — 2× linear boost.
      4. zscale — apply bt2020 primaries + HDR transfer + bt2020nc matrix.
    """
    dst_transfer = "arib-std-b67" if dst_color_space == "hdr_hlg" else "smpte2084"
    return (
        f"zscale=t=linear:npl=100,"
        f"format=gbrpf32le,"
        f"colorchannelmixer=rr=2:gg=2:bb=2,"
        f"zscale=pin=bt709:t={dst_transfer}:p=bt2020:m=bt2020nc:r=tv"
    )


def _build_vf_no_alpha(dst_color_space: str) -> str:
    """Return -vf filter chain for sources with no alpha channel.

    Uses setparams to declare sRGB/bt709 input before handing to zscale, so
    zscale can find the colorspace conversion path regardless of whether the
    source PNG carries embedded color metadata.
    """
    core = _build_core_hdr_chain(dst_color_space)
    return (
        f"setparams=color_trc=iec61966-2-1:color_primaries=bt709:colorspace=bt709,"
        f"{core}"
    )


def _build_filter_complex_with_alpha(dst_color_space: str) -> str:
    """Return -filter_complex graph for sources that contain an alpha channel.

    zscale cannot process pixel formats that contain an alpha plane (it errors
    with "Generic error in an external library"). The workaround:
      1. setparams: declare sRGB input colorspace so zscale can find the path.
      2. split: fork the stream into [rgb] and [a_src].
      3. alphaextract: pull the alpha plane out of [a_src] into [a].
      4. Run the HDR conversion chain on [rgb] only → [rgb_hdr].
      5. alphamerge: re-combine [rgb_hdr] + [a] → [vout].

    The final output is mapped via -map "[vout]".
    """
    core = _build_core_hdr_chain(dst_color_space)
    return (
        f"[0:v]setparams=color_trc=iec61966-2-1:color_primaries=bt709:colorspace=bt709,"
        f"split=2[rgb][a_src];"
        f"[a_src]alphaextract[a];"
        f"[rgb]{core}[rgb_hdr];"
        f"[rgb_hdr][a]alphamerge[vout]"
    )


def convert_image(src: str, dst_color_space: str, *, out_path: str) -> str:
    """Convert an sRGB image to an HDR-encoded PNG.

    Returns the absolute path to the converted file. Idempotent — if out_path
    exists and is fresher than src, returns out_path immediately without
    spawning ffmpeg. Atomic via tmp-write + rename so concurrent callers can't
    read a partial file.

    Raises ValueError for unknown or non-HDR dst_color_space values.
    """
    if dst_color_space not in _VALID_DST:
        raise ValueError(
            f"dst_color_space must be one of {_VALID_DST!r}, got {dst_color_space!r}. "
            f"Image HDR conversion only supports HDR targets."
        )

    src = os.path.abspath(src)
    out_path = os.path.abspath(out_path)

    # ── Idempotency: cached file is at least as fresh as the source ────────────
    try:
        if os.stat(out_path).st_mtime >= os.stat(src).st_mtime:
            progress(f"normalize_image: cached file is fresh, skipping: {out_path}")
            return out_path
    except FileNotFoundError:
        pass  # out_path doesn't exist yet — proceed with conversion

    # ── Short-circuit: source is already tagged with the target transfer curve ──
    spec = SPECS[dst_color_space]
    stream_info = _probe_image_stream(src)
    src_transfer = stream_info.get("color_transfer") or None
    if src_transfer and src_transfer in spec["transfer_values"]:
        progress(
            f"normalize_image: source already has {src_transfer!r} transfer, "
            f"copying to {out_path}"
        )
        _atomic_copy(src, out_path)
        return out_path

    # ── Choose filter strategy based on whether source has alpha ──────────────
    # alphaextract fails if the source has no alpha plane, so we must branch.
    has_alpha = _has_alpha_pix_fmt(stream_info.get("pix_fmt"))

    # ── FFmpeg conversion ──────────────────────────────────────────────────────
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    tmp_path = f"{out_path}.tmp.{os.getpid()}"

    if has_alpha:
        filter_graph = _build_filter_complex_with_alpha(dst_color_space)
        cmd = [
            ffmpeg_bin(), "-y",
            "-i", src,
            "-filter_complex", filter_graph,
            "-map", "[vout]",
            "-pix_fmt", "rgba",
            # Force PNG encoder. Without -c:v png the image2 muxer infers the
            # codec from the output filename extension; the tmp file has no
            # .png extension, so ffmpeg falls back to MJPEG (yuvj444p) and
            # silently ignores -pix_fmt rgba.
            "-c:v", "png",
            "-update", "1",
            # Explicitly declare output format so ffmpeg doesn't try to infer
            # it from the .tmp.<pid> filename (no recognisable extension).
            "-f", "image2",
            tmp_path,
        ]
    else:
        vf_chain = _build_vf_no_alpha(dst_color_space)
        cmd = [
            ffmpeg_bin(), "-y",
            "-i", src,
            "-vf", vf_chain,
            "-pix_fmt", "rgba",
            "-c:v", "png",
            "-update", "1",
            "-f", "image2",
            tmp_path,
        ]

    progress(
        f"normalize_image: converting {src} → {dst_color_space} PNG at {out_path}"
    )
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        # Clean up any partial tmp file before raising.
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass
        fail(
            "encode_error",
            f"normalize_image: ffmpeg failed for {src}:\n{(r.stderr or '')[-500:]}",
        )

    os.replace(tmp_path, out_path)
    progress(f"normalize_image: wrote {out_path}")
    return out_path


def _atomic_copy(src: str, dst: str) -> None:
    """Copy src → dst atomically via a tmp file + rename."""
    import shutil
    tmp = f"{dst}.tmp.{os.getpid()}"
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    shutil.copy2(src, tmp)
    os.replace(tmp, dst)


def main():
    p = argparse.ArgumentParser(
        description="Convert an sRGB image to an HDR-encoded PNG"
    )
    p.add_argument("--input", required=True, help="Source image path")
    p.add_argument(
        "--color-space",
        required=True,
        choices=list(_VALID_DST),
        help="Target HDR color space (hdr_hlg or hdr_pq)",
    )
    p.add_argument("--out", required=True, help="Destination PNG path")
    args = p.parse_args()

    require_file(args.input)
    # CLI mode: print the result path to stdout so subprocess callers
    # (e.g. renderer.js) can read it. Mirrors lib.normalize's CLI convention.
    result = convert_image(args.input, args.color_space, out_path=args.out)
    print(result)


if __name__ == "__main__":
    main()
