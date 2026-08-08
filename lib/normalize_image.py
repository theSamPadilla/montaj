#!/usr/bin/env python3
"""Convert an sRGB image to an HDR-encoded PNG (HLG or PQ) under a tone mode.

Every source is first normalised to rgba (full-resolution RGB + alpha) so one
filter graph handles all decoder pixel formats — including odd-dimension 4:2:0
JPEGs and palette PNGs, which break zscale when fed to it directly — with an
alphaextract/alphamerge split around the colour chain because neither zscale
nor the geq math path should touch the alpha plane.

Tone modes (--tone) control the brightness mapping of the converted image.
Background: overlay rasters are reinterpreted as HDR signal at composite time,
which lands CSS graphics white at full signal (~1000 nits on an HLG display).
The mode decides how image content relates to that:

  vivid     (default) Colorimetric sRGB decode, BT.709→BT.2020 gamut, HLG OETF
            scaled so sRGB white lands at signal 1.0 — image whites match the
            surrounding cards/captions. True colours at full brightness.
  broadcast BT.2408 convention: graphics white at ~203 nits (2× linear boost
            over 100-nit SDR). Correct for TV delivery, but images read dimmer
            than the raster graphics around them.
  punchy    Legacy tone + gamut fix: bytes are decoded as HLG signal (exactly
            the tone the pre-3.9.3 reinterpretation produced — neutrals are
            byte-identical), and only the primaries are corrected 709→2020 in
            that pseudo-linear light. Old contrast, without the oversaturation.
  raw       No colour conversion — the image is repackaged and reinterpreted
            downstream, reproducing the pre-3.9.3 look (oversaturated hues).

vivid/punchy use exact per-pixel math via geq in float (zscale's HLG npl/OOTF
semantics are not the plain OETF/inverse-OETF these mappings need); broadcast
keeps the original zscale chain byte-for-byte.

Output is 8-bit RGBA PNG with NO colour metadata. This is load-bearing: the
stream's colour props are wiped (setparams … unknown) before the PNG encoder so
it writes no cICP/cHRM/gAMA chunks. A cICP chunk tagging the file BT.2020/HLG
makes Chromium colour-manage the image into the sRGB page raster, destroying
the pre-encoded HDR values the renderer's interceptor relies on passing through
untouched. 8-bit is intentional: the Puppeteer interceptor path screenshots
through Chromium's 8-bit framebuffer, so a 16-bit cached PNG would be truncated
to 8-bit before encode-segment ever sees it.

Idempotency: if out_path already exists and its mtime >= src's mtime the file
is returned immediately without spawning ffmpeg. Callers encode the tone mode
into out_path (renderer.js uses <stem>_<colorspace>_<tone>.png) so modes never
collide in the cache.

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

# Tone modes, user-facing. Order = documentation order, first is NOT the
# default; DEFAULT_TONE is. Keep in sync with:
#   montaj_assets/render/render.js (--image-tone validation)
#   montaj_assets/editor/src/imageTone.ts (UI picker)
TONE_MODES = ("vivid", "broadcast", "punchy", "raw")
DEFAULT_TONE = "vivid"

# BT.709 -> BT.2020 primaries conversion in linear light (rows sum to 1, so
# neutrals are preserved exactly). Same constants as colour-science references.
_M_709_2020 = (
    (0.627404, 0.329283, 0.043313),
    (0.069097, 0.919540, 0.011362),
    (0.016391, 0.088013, 0.895595),
)

# ── exact per-channel transfer expressions (ffmpeg expression syntax) ─────────
# geq evaluates these per pixel on planar float (gbrpf32le), so there is no
# precision loss and no dependence on zscale's npl/OOTF interpretation.

def _expr_srgb_eotf(v: str) -> str:
    """sRGB electro-optical transfer: encoded [0,1] -> linear [0,1]."""
    return f"if(lte({v},0.04045),{v}/12.92,pow(({v}+0.055)/1.055,2.4))"


def _expr_hlg_oetf(v: str) -> str:
    """HLG OETF (scene-referred): linear [0,1] -> signal [0,1]. Clips input."""
    a, b, c = 0.17883277, 0.28466892, 0.55991073
    e = f"clip({v},0,1)"
    return f"if(lte({e},1/12),sqrt(3*{e}),{a}*log(12*{e}-{b})+{c})"


def _expr_hlg_inv_oetf(v: str) -> str:
    """Inverse HLG OETF: signal [0,1] -> linear [0,1]. Clips input."""
    a, b, c = 0.17883277, 0.28466892, 0.55991073
    s = f"clip({v},0,1)"
    return f"if(lte({s},0.5),{s}*{s}/3,(exp(({s}-{c})/{a})+{b})/12)"


def _geq_rgb(expr_fn) -> str:
    """A geq filter applying expr_fn to each of r/g/b (alpha not present —
    the graph splits alpha off before this runs)."""
    return (
        "geq="
        f"r='{expr_fn('r(X,Y)')}':"
        f"g='{expr_fn('g(X,Y)')}':"
        f"b='{expr_fn('b(X,Y)')}'"
    )


def _mixer_709_2020() -> str:
    m = _M_709_2020
    return (
        "colorchannelmixer="
        f"rr={m[0][0]}:rg={m[0][1]}:rb={m[0][2]}:"
        f"gr={m[1][0]}:gg={m[1][1]}:gb={m[1][2]}:"
        f"br={m[2][0]}:bg={m[2][1]}:bb={m[2][2]}"
    )


def _build_core_chain(dst_color_space: str, tone: str) -> str:
    """The colour chain applied to the alpha-stripped [rgb] branch.

    NOTE on HLG vs PQ: the vivid/punchy math paths encode with the HLG OETF.
    For hdr_pq targets only the 'broadcast' zscale path produces a true PQ
    signal; vivid/punchy fall back to broadcast for PQ (documented limitation —
    every current project is HLG).
    """
    if tone in ("vivid", "punchy") and dst_color_space == "hdr_hlg":
        decode = _geq_rgb(_expr_srgb_eotf if tone == "vivid" else _expr_hlg_inv_oetf)
        return (
            "format=gbrpf32le,"
            f"{decode},"
            f"{_mixer_709_2020()},"
            f"{_geq_rgb(_expr_hlg_oetf)}"
        )
    # broadcast (and vivid/punchy on PQ targets): the original zscale chain —
    # linearise sRGB at npl=100, 2× linear boost (≈203-nit graphics white),
    # BT.2020 primaries + HDR transfer.
    dst_transfer = "arib-std-b67" if dst_color_space == "hdr_hlg" else "smpte2084"
    return (
        "zscale=t=linear:npl=100,"
        "format=gbrpf32le,"
        "colorchannelmixer=rr=2:gg=2:bb=2,"
        f"zscale=pin=bt709:t={dst_transfer}:p=bt2020:m=bt2020nc:r=tv"
    )


def _probe_image_stream(path: str) -> dict:
    """Return stream metadata for the first video stream of an image via ffprobe.

    Keys include 'color_transfer' (str|None).
    Returns an empty dict on ffprobe failure.
    """
    cmd = [
        ffprobe_bin(), "-v", "quiet",
        "-show_entries", "stream=color_transfer",
        "-of", "json", path,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    if r.returncode != 0:
        return {}
    streams = json.loads(r.stdout).get("streams", [])
    return streams[0] if streams else {}


def _build_filter_complex(dst_color_space: str, tone: str) -> str:
    """Return the -filter_complex graph used for every source image.

    The graph starts with format=rgba so the rest of the chain never sees the
    decoder's native pixel format. Downloaded images arrive in formats that
    break the colour filters when fed to them directly:
      - 4:2:0 JPEGs with an odd width or height — zimg rejects subsampled
        frames whose dimensions aren't divisible by the subsampling factor
      - palette PNGs (pal8) — crash ffmpeg inside the alpha handling
    rgba is full-resolution (no subsampling) and always carries a real alpha
    plane (opaque for sources without one), so one path handles all inputs.

    The colour chain must not touch the alpha plane (zscale rejects alpha pixel
    formats; the geq/mixer path would garble it), hence the detour:
      1. format=rgba: normalise to full-resolution RGB + alpha.
      2. setparams: declare sRGB input colorspace for the zscale-based chain.
      3. split / alphaextract: divert alpha around the colour chain.
      4. Core colour chain (per tone mode) on [rgb] only → [rgb_hdr].
      5. alphamerge: re-attach alpha → then wipe colour metadata (see module
         docstring — the PNG must carry no cICP/cHRM/gAMA chunks).

    The final output is mapped via -map "[vout]".
    """
    if tone == "raw":
        # No colour math — repackage only, stripped of colour metadata.
        return (
            "[0:v]format=rgba,"
            "setparams=color_trc=unknown:color_primaries=unknown:colorspace=unknown[vout]"
        )
    core = _build_core_chain(dst_color_space, tone)
    return (
        "[0:v]format=rgba,"
        "setparams=color_trc=iec61966-2-1:color_primaries=bt709:colorspace=bt709,"
        "split=2[rgb][a_src];"
        "[a_src]alphaextract[a];"
        f"[rgb]{core}[rgb_hdr];"
        "[rgb_hdr][a]alphamerge,"
        "setparams=color_trc=unknown:color_primaries=unknown:colorspace=unknown[vout]"
    )


def convert_image(src: str, dst_color_space: str, *, out_path: str, tone: str = DEFAULT_TONE) -> str:
    """Convert an sRGB image to an HDR-encoded PNG under the given tone mode.

    Returns the absolute path to the converted file. Idempotent — if out_path
    exists and is fresher than src, returns out_path immediately without
    spawning ffmpeg (callers must encode `tone` into out_path so modes never
    share a cache file). Atomic via tmp-write + rename so concurrent callers
    can't read a partial file.

    Raises ValueError for unknown or non-HDR dst_color_space values, or an
    unknown tone.
    """
    if dst_color_space not in _VALID_DST:
        raise ValueError(
            f"dst_color_space must be one of {_VALID_DST!r}, got {dst_color_space!r}. "
            f"Image HDR conversion only supports HDR targets."
        )
    if tone not in TONE_MODES:
        raise ValueError(f"tone must be one of {TONE_MODES!r}, got {tone!r}.")

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

    # ── FFmpeg conversion ──────────────────────────────────────────────────────
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    tmp_path = f"{out_path}.tmp.{os.getpid()}"

    cmd = [
        ffmpeg_bin(), "-y",
        "-i", src,
        "-filter_complex", _build_filter_complex(dst_color_space, tone),
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

    progress(
        f"normalize_image: converting {src} → {dst_color_space} PNG ({tone}) at {out_path}"
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
    p.add_argument(
        "--tone",
        default=DEFAULT_TONE,
        choices=list(TONE_MODES),
        help=f"Brightness/colour mapping (default: {DEFAULT_TONE})",
    )
    p.add_argument("--out", required=True, help="Destination PNG path")
    args = p.parse_args()

    require_file(args.input)
    # CLI mode: print the result path to stdout so subprocess callers
    # (e.g. renderer.js) can read it. Mirrors lib.normalize's CLI convention.
    result = convert_image(args.input, args.color_space, out_path=args.out, tone=args.tone)
    print(result)


if __name__ == "__main__":
    main()
