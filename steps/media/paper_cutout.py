#!/usr/bin/env python3
"""Turn an image into a torn-paper cutout: a PNG with alpha.

The shape (`--mask`) is printed on paper: two inks, ink on cream, as a
continuous tone or a halftone, or its own colour with `--keep-color`. Around
it go an optional cream border and red sticker outline, then a torn edge
(the paper's edge wanders by `--tear`) with a white fibrous core (`--core`)
where the paper's face stops short of the tear, and stray fibres just past
it. Crumple facets and a few creases are shaded as relief lit from the top
left (`--crumple`), grain and specks are added, and a soft shadow falls
`--shadow` px down and to the right with a contact line under the edge. The
result is cropped to the paper and its shadow.

Distances are chessboard distances (3x3 max and min filters), measured on
the image resized to `--width`, so every px parameter is in output px. Every
random draw comes from `--seed`: the same seed and parameters give the same
bytes.

numpy comes from the rvm extra (the app's runtime has it); it is imported
lazily and a missing one fails by name.
"""
import json
import math
import os
import sys

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib.common import fail, require_file

MASKS = ("alpha", "white", "black", "ellipse", "rect")

INK = (0x16, 0x15, 0x17)
PAPER = (0xec, 0xe4, 0xcf)
CREAM = (0xf1, 0xea, 0xd6)
CORE = (0xfa, 0xf7, 0xef)
RED = (0xd6, 0x34, 0x24)


def _ints(value, count, name, example):
    try:
        parts = [int(v) for v in value.split(",")]
    except ValueError:
        parts = []
    if len(parts) != count:
        fail("invalid_args", f"--{name} is {count} whole numbers separated by commas, e.g. {example}; got {value!r}")
    return parts


def cutout(np, src, *, mask, thresh, width, halftone, keep_color, border, outline,
           tear, core, crumple, vivid, shadow, seed):
    """The cutout of the PIL image `src` as an RGBA uint8 array, cropped to the
    paper and its shadow. Fails `empty_mask` when the mask holds no shape."""
    from PIL import Image, ImageFilter

    ink, paper, cream = np.array(INK, float), np.array(PAPER, float), np.array(CREAM, float)
    core_c, red = np.array(CORE, float), np.array(RED, float)
    rng = np.random.default_rng(seed)

    src = src.convert("RGBA")
    w0, h0 = src.size
    src = src.resize((width, max(1, round(h0 * width / w0))), Image.LANCZOS)
    rgba = np.asarray(src, float)
    rgb, alpha = rgba[..., :3], rgba[..., 3] / 255
    lum = rgb @ np.array([0.299, 0.587, 0.114])
    H, W = lum.shape

    # object mask
    if mask == "alpha" and alpha.min() < 0.99:
        m = (alpha > 0.5).astype(float)
    elif mask in ("alpha", "white"):
        m = (lum < (thresh or 235)).astype(float)
    elif mask == "black":
        m = (lum > (thresh or 25)).astype(float)
    elif mask == "ellipse":
        y, x = np.mgrid[0:H, 0:W]
        m = ((((x - W / 2) / (W / 2)) ** 2 + ((y - H / 2) / (H / 2)) ** 2) < 1).astype(float)
    else:
        m = np.ones((H, W))
    if mask in ("white", "black"):
        mi = (Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9))
              .filter(ImageFilter.MinFilter(7)).filter(ImageFilter.GaussianBlur(2)))
        m = (np.asarray(mi, float) / 255 > 0.5).astype(float)
    if not m.any():
        fail("empty_mask", f"The {mask} mask found no shape in the image"
             + (f" (threshold {thresh or (25 if mask == 'black' else 235)})" if mask in ("alpha", "white", "black") else "")
             + ". Try another mask, or a threshold for white or black.")

    # tone
    def halftone_cov(g, pitch, ang=45.0):
        r_ = math.radians(ang)
        y, x = np.mgrid[0:H, 0:W].astype(float)
        u = (x * math.cos(r_) + y * math.sin(r_)) / pitch
        v = (-x * math.sin(r_) + y * math.cos(r_)) / pitch
        d = np.hypot(u - np.round(u), v - np.round(v))
        dark = 1 - g
        rad = np.sqrt(np.clip(dark, 0, 1) / math.pi) * 1.05
        cov = np.clip((rad - d) / (0.6 / pitch) + 0.5, 0, 1)
        return np.where(dark > 0.92, 1.0, cov)

    if keep_color:
        mean = rgb.mean(2, keepdims=True)
        face = np.clip(mean + (rgb - mean) * vivid, 0, 255)
    else:
        g = np.clip((lum / 255 - 0.08) / 0.84, 0, 1) ** 1.1
        cov = halftone_cov(g, halftone) if halftone > 0 else 1 - g
        face = paper[None, None] * (1 - cov[..., None]) + ink[None, None] * cov[..., None]

    pad = int(border + outline + 3 * tear + 50)
    Wp, Hp = W + 2 * pad, H + 2 * pad
    M = np.zeros((Hp, Wp))
    M[pad:pad + H, pad:pad + W] = m
    F = np.zeros((Hp, Wp, 3))
    F[pad:pad + H, pad:pad + W] = face

    def signed_dist(mask_, reach_):
        inside = mask_ > 0.5
        im = Image.fromarray((inside * 255).astype(np.uint8))
        out_d = np.full(mask_.shape, float(reach_))
        out_d[inside] = 0
        for r in range(1, reach_ + 1):
            im = im.filter(ImageFilter.MaxFilter(3))
            gg = np.asarray(im) > 127
            out_d[(out_d == reach_) & gg & ~inside] = r
        im = Image.fromarray((inside * 255).astype(np.uint8))
        in_d = np.full(mask_.shape, float(reach_))
        in_d[~inside] = 0
        for r in range(1, reach_ + 1):
            im = im.filter(ImageFilter.MinFilter(3))
            gg = np.asarray(im) > 127
            in_d[(in_d == reach_) & ~gg & inside] = r
        return np.where(inside, -in_d, out_d)

    def noise2(seed_, scale):
        r_ = np.random.default_rng(seed_)
        small = r_.normal(0, 1, (Hp // scale + 2, Wp // scale + 2))
        big = Image.fromarray(((small - small.min()) / (np.ptp(small) + 1e-9) * 255).astype(np.uint8)).resize((Wp, Hp), Image.BICUBIC)
        return np.asarray(big, float) / 255 * 2 - 1

    reach = int(border + outline + 3 * tear + core + 6)
    sd = signed_dist(M, reach)
    wob = tear * (0.65 * noise2(seed, 36) + 0.35 * noise2(seed + 7, 7))
    core_w = core * (0.5 + 0.5 * np.abs(noise2(seed + 3, 22)))         # the white core's width varies along the edge
    edge = border + outline                                              # where the colour or border ends
    outer = sd <= edge + wob + core_w * 0.6                              # the paper's extent, white core included
    colour_edge = sd <= edge + wob - core_w * 0.4                        # the coloured face stops before the core
    inner = sd <= (wob * 0.35 if border == 0 and outline == 0 else 0)
    fib = ((np.abs(noise2(seed + 11, 2)) > 0.72) & (sd > edge + wob + core_w * 0.6)
           & (sd <= edge + wob + core_w * 0.6 + 2.5))

    if border == 0 and outline == 0:
        out = np.where(colour_edge[..., None], F, core_c[None, None])
    else:
        out = np.where(inner[..., None], F, cream[None, None])
        if outline:
            border_zone = sd <= border + wob * 0.5
            out = np.where((~border_zone & colour_edge)[..., None], red[None, None], out)
        out = np.where((~colour_edge & outer)[..., None], core_c[None, None], out)
    alpha = np.where(outer, 1.0, np.where(fib, 0.65, 0.0))
    out = np.where(fib[..., None], core_c[None, None], out)

    # crumple + crease shading (lit from the top left)
    if crumple > 0:
        hgt = np.zeros((Hp, Wp))
        for sc, amp in ((90, 1.0), (45, 0.5), (20, 0.22)):
            n = noise2(seed + sc, sc)
            hgt += amp * (1 - np.abs(n))                                 # ridged facets
        yy, xx = np.mgrid[0:Hp, 0:Wp].astype(float)
        diag = math.hypot(Wp, Hp)
        for _ in range(int(2 + 3 * crumple)):                            # a few crease segments
            th = rng.uniform(0, math.pi)
            cx, cy = rng.uniform(0.2, 0.8) * Wp, rng.uniform(0.2, 0.8) * Hp
            half = rng.uniform(0.15, 0.35) * diag
            wid = rng.uniform(2.5, 4.5)
            along = (xx - cx) * math.cos(th) + (yy - cy) * math.sin(th)
            dist = np.abs((xx - cx) * math.sin(th) - (yy - cy) * math.cos(th))
            fade = np.clip(1 - np.abs(along) / half, 0, 1) ** 0.7
            hgt += rng.choice([-1, 1]) * rng.uniform(0.35, 0.7) * np.clip(1 - dist / wid, 0, 1) * fade
        hgt = np.asarray(Image.fromarray(((hgt - hgt.min()) / (np.ptp(hgt) + 1e-9) * 255).astype(np.uint8))
                         .filter(ImageFilter.GaussianBlur(1.1)), float) / 255
        gy, gx = np.gradient(hgt * 40 * crumple)
        nz = 1 / np.sqrt(gx * gx + gy * gy + 1)
        lx, ly, lz = -0.55, -0.6, 0.58
        shade = (-gx * lx - gy * ly + lz) * nz
        shade = 1 + 0.55 * (shade - np.median(shade[outer]))
        grad = 1.05 - 0.1 * (xx / Wp + yy / Hp) / 2                     # soft light falloff
        out = np.clip(out * (shade * grad)[..., None], 0, 255)

    grain = rng.normal(0, 5.5, (Hp, Wp))
    fibre = np.asarray(Image.fromarray(((rng.random((Hp, Wp)) > 0.996) * 255).astype(np.uint8))
                       .filter(ImageFilter.GaussianBlur(0.8)), float) / 255
    out = np.clip(out + grain[..., None] - fibre[..., None] * 18, 0, 255)

    # soft offset shadow + contact line
    dx, dy = shadow
    if dx or dy:
        a_np = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)), float) / 255
        sh = np.zeros((Hp, Wp))
        sh[max(dy, 0):, max(dx, 0):] = a_np[:Hp - max(dy, 0), :Wp - max(dx, 0)]
        sh = np.asarray(Image.fromarray((sh * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(4)), float) / 255
        contact = np.zeros((Hp, Wp))
        contact[2:, 2:] = a_np[:-2, :-2]
        sh_alpha = np.clip(sh * 0.5 + contact * 0.35, 0, 0.75) * (1 - alpha)
        tot = alpha + sh_alpha
        out = np.where((alpha > 0)[..., None], out, np.array([8, 8, 10.0]))
        alpha = tot
    ys, xs = np.nonzero(alpha > 0.01)
    return np.dstack([out, alpha * 255]).astype(np.uint8)[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Turn an image into a torn-paper cutout (PNG with alpha)")
    parser.add_argument("--input", required=True, help="Source image")
    parser.add_argument("--out", help="Output .png (default: <input stem>_paper.png beside the input)")
    parser.add_argument("--mask", default="alpha", choices=list(MASKS),
                        help="Which part is the paper: alpha (default), white, black, ellipse or rect")
    parser.add_argument("--thresh", type=int, default=None,
                        help="Luminance 1-255 splitting shape from background (default 235 white, 25 black)")
    parser.add_argument("--width", type=int, default=900, help="Resize to this width in px first (default 900)")
    parser.add_argument("--halftone", type=float, default=0, help="Halftone dot pitch in px; 0 is a continuous tone")
    parser.add_argument("--mono", action="store_true", help="Ink on cream paper (already the face without --keep-color)")
    parser.add_argument("--keep-color", action="store_true", help="Keep the image's colour instead of two inks")
    parser.add_argument("--border", type=int, default=10, help="Cream border in px (default 10)")
    parser.add_argument("--outline", type=int, default=0, help="Red sticker outline in px (default 0)")
    parser.add_argument("--tear", type=float, default=5, help="How far the torn edge wanders, px (default 5)")
    parser.add_argument("--core", type=float, default=4, help="White fibrous core along the tear, px (default 4)")
    parser.add_argument("--crumple", type=float, default=0.6, help="Crumple and crease relief, 0 to 1 (default 0.6)")
    parser.add_argument("--vivid", type=float, default=1.2, help="Saturation with --keep-color (default 1.2)")
    parser.add_argument("--shadow", default="10,14", help="Shadow offset DX,DY in px; 0,0 for none (default 10,14)")
    parser.add_argument("--crop", default=None, help="Crop the source first: x0,y0,x1,y1 in source px")
    parser.add_argument("--seed", type=int, default=1, help="Random seed (default 1)")
    args = parser.parse_args()

    try:
        import numpy as np
    except ImportError:
        fail("missing_dependency",
             "paper_cutout needs numpy, which the rvm extra provides. "
             "Install it with: pip install 'montaj[rvm]' (or: montaj install rvm)")

    if args.width < 1:
        fail("invalid_args", f"--width must be at least 1, got {args.width}")
    if args.thresh is not None and not 1 <= args.thresh <= 255:
        fail("invalid_args", f"--thresh must be from 1 to 255, got {args.thresh}")
    for name in ("halftone", "border", "outline", "tear", "core", "crumple", "vivid", "seed"):
        if getattr(args, name) < 0:
            fail("invalid_args", f"--{name} must be 0 or more, got {getattr(args, name)}")
    shadow = _ints(args.shadow, 2, "shadow", "10,14")
    if min(shadow) < 0:
        fail("invalid_args", f"--shadow falls down and to the right: DX and DY are 0 or more, got {args.shadow!r}")
    crop = None
    if args.crop:
        crop = _ints(args.crop, 4, "crop", "0,0,800,600")
        if crop[2] <= crop[0] or crop[3] <= crop[1]:
            fail("invalid_args", f"--crop is x0,y0,x1,y1 with x1 > x0 and y1 > y0, got {args.crop!r}")

    in_path = os.path.abspath(os.path.expanduser(args.input))
    require_file(in_path)
    if args.out:
        out_path = os.path.abspath(os.path.expanduser(args.out))
    else:
        out_path = os.path.join(os.path.dirname(in_path), os.path.splitext(os.path.basename(in_path))[0] + "_paper.png")
    if os.path.splitext(out_path)[1].lower() != ".png":
        fail("invalid_out", f"The cutout has alpha, so it is a PNG: --out must end in .png, got {args.out!r}")

    from PIL import Image, UnidentifiedImageError
    try:
        with Image.open(in_path) as im:
            src = im.crop(tuple(crop)) if crop else im.copy()
    except (UnidentifiedImageError, OSError) as e:
        fail("invalid_image", f"Could not read {in_path} as an image: {e}")

    res = cutout(np, src, mask=args.mask, thresh=args.thresh, width=args.width,
                 halftone=args.halftone, keep_color=args.keep_color, border=args.border,
                 outline=args.outline, tear=args.tear, core=args.core, crumple=args.crumple,
                 vivid=args.vivid, shadow=shadow, seed=args.seed)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    Image.fromarray(res, "RGBA").save(out_path)
    print(json.dumps({"path": out_path, "width": int(res.shape[1]), "height": int(res.shape[0])}))


if __name__ == "__main__":
    main()
