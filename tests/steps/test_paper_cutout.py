"""steps/media/paper_cutout.py: an image turned into a torn-paper cutout.

The cutout is a PNG with alpha: the shape (picked by `mask`) printed on paper,
torn along the edge with a white fibrous core and stray fibres, crumpled and
creased in relief lit from the top left, with a soft offset shadow. Every
image here is drawn in the test, at `width` equal to its own width so a source
pixel is an output pixel. The output is cropped to the paper and its shadow,
so positions are found from the output itself (the paper's centroid, its
bounding box).

Distances inside the step are chessboard distances (3x3 max and min filters),
so the paper reaches up to sqrt(2) further along a diagonal than along an
axis; the bounds below allow for it.
"""
import json
import subprocess
import sys

import pytest

from tests.conftest import REPO_ROOT, assert_error
from tests.test_step_schema_conformance import _divergences, _introspect

np = pytest.importorskip("numpy")
from PIL import Image, ImageFilter  # noqa: E402

STEP = REPO_ROOT / "steps" / "media" / "paper_cutout.py"
SCHEMA = REPO_ROOT / "steps" / "media" / "paper_cutout.json"

CORE = np.array([0xfa, 0xf7, 0xef], float)
CREAM = np.array([0xf1, 0xea, 0xd6], float)
FIBRE_ALPHA = 165              # int(0.65 * 255): a stray fibre past the paper
R = 50                         # disc radius, px


def _lum(rgb):
    return rgb @ np.array([0.299, 0.587, 0.114])


def _disc(size=200, r=R, grey=70, bg=None):
    """A grey disc: on a transparent background (bg None, RGBA), else opaque
    on a background of grey level `bg` (RGB)."""
    y, x = np.mgrid[0:size, 0:size]
    inside = (x - size / 2 + 0.5) ** 2 + (y - size / 2 + 0.5) ** 2 < r * r
    if bg is None:
        a = np.zeros((size, size, 4), np.uint8)
        a[inside] = (grey, grey, grey, 255)
        return Image.fromarray(a, "RGBA")
    a = np.full((size, size, 3), bg, np.uint8)
    a[inside] = grey
    return Image.fromarray(a, "RGB")


def _flat(w, h, grey=150):
    return Image.fromarray(np.full((h, w, 3), grey, np.uint8), "RGB")


def _run(*args, step=STEP):
    return subprocess.run([sys.executable, str(step), *map(str, args)],
                          capture_output=True, text=True, timeout=120)


_n = [0]


def _cut(tmp_path, img, *args):
    """Run the step on `img`; return (json result, RGBA array of the PNG)."""
    _n[0] += 1
    src = tmp_path / f"in{_n[0]}.png"
    out = tmp_path / f"out{_n[0]}.png"
    img.save(src)
    proc = _run("--input", src, "--out", out, *args)
    assert proc.returncode == 0, proc.stderr
    res = json.loads(proc.stdout)
    with Image.open(res["path"]) as im:
        assert im.mode == "RGBA"
        arr = np.asarray(im).copy()
    return res, arr


def _erode(mask, px):
    """`mask` shrunk by `px` (chessboard), as the step measures distance. It is
    padded first: MinFilter repeats the border, so paper flush with the
    output's edge would not shrink there."""
    padded = np.pad(mask, px + 1).astype(np.uint8) * 255
    im = Image.fromarray(padded).filter(ImageFilter.MinFilter(2 * px + 1))
    return (np.asarray(im) == 255)[px + 1:-(px + 1), px + 1:-(px + 1)]


def _radii(alpha):
    """Distance of every pixel from the centroid of the solid paper."""
    ys, xs = np.nonzero(alpha == 255)
    y, x = np.mgrid[0:alpha.shape[0], 0:alpha.shape[1]]
    return np.hypot(x - xs.mean(), y - ys.mean())


def _bbox(alpha):
    ys, xs = np.nonzero(alpha == 255)
    return xs.min(), ys.min(), xs.max() + 1, ys.max() + 1


# -- the paper's extent -----------------------------------------------------

def test_alpha_is_solid_inside_the_shape_and_clear_outside_the_torn_edge(tmp_path):
    res, arr = _cut(tmp_path, _disc(), "--width", 200, "--shadow", "0,0")
    alpha = arr[..., 3]
    r = _radii(alpha)
    # The shape and its 10 px border are paper; the torn edge sits at the
    # border (10) +- tear (5) plus 0.6 of the core (<= 2.4), stray fibres 2.5
    # past it, each up to sqrt(2) further on a diagonal: 28 px at most.
    assert (alpha[r < R + 3] == 255).all()
    assert (alpha[r > R + 32] == 0).all()
    assert (alpha == 0).any()


def _edge_profiles(solid):
    """Where the solid paper starts along each straight side, per column (top,
    bottom) or row (left, right), 40 px clear of the corners."""
    ys, xs = np.nonzero(solid)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    cols = [solid[:, c] for c in range(x0 + 40, x1 - 40)]
    rows = [solid[r, :] for r in range(y0 + 40, y1 - 40)]
    first = lambda lines: np.array([np.argmax(v) for v in lines], float)
    last = lambda lines: np.array([len(v) - np.argmax(v[::-1]) for v in lines], float)
    return [first(cols), last(cols), first(rows), last(rows)]


def test_edge_is_torn_with_stray_fibres(tmp_path):
    # A straight edge (the whole image is the shape): torn, it wanders by the
    # tear; cut clean, it is a straight line. Measured at width 480, seeds 1-3:
    # torn, each side spans 3-5 px and the sides' mean spread is 0.85-1.08 px;
    # with the tear removed, 0-1 px and at most 0.05.
    res, arr = _cut(tmp_path, _flat(480, 320), "--mask", "rect", "--width", 480, "--shadow", "0,0")
    alpha = arr[..., 3]
    solid = alpha == 255
    profiles = _edge_profiles(solid)
    assert all(np.ptp(p) >= 2 for p in profiles), [np.ptp(p) for p in profiles]
    assert np.mean([p.std() for p in profiles]) > 0.5, [p.std() for p in profiles]
    # Stray fibres: semi-transparent specks of the core's white just past the
    # solid edge. They are sparse (a few px per cutout), so this seed is fixed.
    fibres = alpha == FIBRE_ALPHA
    assert fibres.sum() >= 1
    assert not (fibres & _erode(solid, 1)).any()
    assert np.abs(arr[..., :3][fibres].mean(0) - CORE).max() < 20


# -- the white core ---------------------------------------------------------

def _rim_and_deep(arr, deep_px=15):
    alpha = arr[..., 3]
    solid = alpha == 255
    rim = solid & ~_erode(solid, 1)                       # the solid paper's outermost pixels
    deep = _erode(solid, deep_px)
    rgb = arr[..., :3].astype(float)
    return rgb[rim].mean(0), rgb[deep].mean(0)


def test_torn_edge_has_a_white_core(tmp_path):
    # No border: the image itself is torn, and its dark face stops short of
    # the edge, leaving a white fibrous core.
    res, arr = _cut(tmp_path, _disc(grey=40), "--width", 200, "--border", 0,
                    "--crumple", 0, "--shadow", "0,0")
    rim, deep = _rim_and_deep(arr)
    assert np.abs(rim - CORE).max() < 10, rim
    assert _lum(rim) > _lum(deep) + 120, (rim, deep)


def test_white_core_is_whiter_than_the_cream_border(tmp_path):
    # With the default border the core is past the cream border: the rim is
    # the core's white, not the border's cream.
    res, arr = _cut(tmp_path, _disc(grey=40), "--width", 200, "--crumple", 0, "--shadow", "0,0")
    rim, deep = _rim_and_deep(arr, deep_px=25)
    assert np.abs(rim - CORE).max() < 10, rim
    assert abs(rim[2] - CORE[2]) < abs(rim[2] - CREAM[2]) - 10, rim


# -- crumple relief ---------------------------------------------------------

def _relief(arr):
    """Spread of the paper's luminance over 8 px blocks, inside the paper: the
    blocks average the per-pixel grain away and keep the relief's shading."""
    solid = arr[..., 3] == 255
    inner = _erode(solid, 20)
    lum = _lum(arr[..., :3].astype(float))
    h, w = lum.shape
    blocks = []
    for y in range(0, h - 7, 8):
        for x in range(0, w - 7, 8):
            if inner[y:y + 8, x:x + 8].all():
                blocks.append(lum[y:y + 8, x:x + 8].mean())
    assert len(blocks) > 50
    return float(np.std(blocks))


def test_crumple_adds_relief(tmp_path):
    common = ("--mask", "rect", "--width", 240, "--border", 0, "--shadow", "0,0")
    flat = _relief(_cut(tmp_path, _flat(240, 240), *common, "--crumple", 0)[1])
    crumpled = _relief(_cut(tmp_path, _flat(240, 240), *common, "--crumple", 0.7)[1])
    assert crumpled > 4 * flat and crumpled > 4, (flat, crumpled)


# -- shadow -----------------------------------------------------------------

def _shade(arr):
    """The shadow: partly transparent, near-black pixels."""
    alpha = arr[..., 3]
    return (alpha > 0) & (alpha < 255) & (arr[..., :3] < 20).all(-1)


def test_shadow_falls_down_and_to_the_right(tmp_path):
    res, arr = _cut(tmp_path, _disc(), "--width", 200, "--crumple", 0)
    shade = _shade(arr)
    ys, xs = np.nonzero(shade)
    sy, sx = np.nonzero(arr[..., 3] == 255)
    assert shade.sum() > 500
    assert xs.mean() > sx.mean() + 5 and ys.mean() > sy.mean() + 5
    res, arr = _cut(tmp_path, _disc(), "--width", 200, "--crumple", 0, "--shadow", "0,0")
    assert not _shade(arr).any()


# -- determinism, size, width -----------------------------------------------

def test_same_seed_is_byte_identical_and_another_seed_differs(tmp_path):
    img = _disc(160, r=45)
    paths = []
    for seed in (7, 7, 8):
        res, _ = _cut(tmp_path, img, "--width", 160, "--halftone", 4, "--outline", 6, "--seed", seed)
        paths.append(res["path"])
    a, b, c = (open(p, "rb").read() for p in paths)
    assert a == b
    assert a != c


def test_json_size_matches_the_png_and_width_resizes(tmp_path):
    img = _flat(300, 200)
    common = ("--mask", "rect", "--shadow", "0,0")
    small, _ = _cut(tmp_path, img, "--width", 150, *common)
    large, _ = _cut(tmp_path, img, "--width", 300, *common)
    for res in (small, large):
        assert set(res) == {"path", "width", "height"}
        with Image.open(res["path"]) as im:
            assert im.size == (res["width"], res["height"])
    # The paper is the resized image plus the same torn margin at both widths.
    assert abs((large["width"] - small["width"]) - 150) <= 12
    assert abs((large["height"] - small["height"]) - 100) <= 12


# -- masks ------------------------------------------------------------------

def _corners_clear(alpha, x0, y0, x1, y1, k=6):
    return all((alpha[y:y + k, x:x + k] == 0).all()
               for x, y in ((x0, y0), (x1 - k, y0), (x0, y1 - k), (x1 - k, y1 - k)))


@pytest.mark.parametrize("mask, img, size, round_", [
    ("alpha", _disc(), (200, 200), True),                  # transparent background
    ("alpha", _disc(bg=255), (200, 200), True),            # opaque: falls back to white
    ("white", _disc(bg=255), (200, 200), True),
    ("black", _disc(grey=200, bg=0), (200, 200), True),
    ("ellipse", _flat(200, 120), (200, 120), True),
    ("rect", _flat(200, 120), (200, 120), False),
], ids=["alpha", "alpha-opaque", "white", "black", "ellipse", "rect"])
def test_mask_modes(tmp_path, mask, img, size, round_):
    res, arr = _cut(tmp_path, img, "--mask", mask, "--width", size[0], "--shadow", "0,0")
    alpha = arr[..., 3]
    x0, y0, x1, y1 = _bbox(alpha)
    if mask in ("ellipse", "rect"):
        want = size                                         # the whole image's extent
    else:
        want = (2 * R, 2 * R)                               # the disc's
    # Plus the border and torn edge on each side (10 +- 5, more on a diagonal).
    assert 2 * 5 <= (x1 - x0) - want[0] <= 2 * 22, (x1 - x0, want)
    assert 2 * 5 <= (y1 - y0) - want[1] <= 2 * 22, (y1 - y0, want)
    assert _corners_clear(alpha, x0, y0, x1, y1) == round_


# -- errors -----------------------------------------------------------------

def test_missing_input_fails_by_name(tmp_path):
    proc = _run("--input", tmp_path / "nope.png", "--out", tmp_path / "out.png")
    assert_error(proc, "file_not_found")
    assert not (tmp_path / "out.png").exists()


def test_input_that_is_not_an_image_fails_by_name(tmp_path):
    bad = tmp_path / "not-an-image.png"
    bad.write_text("hello")
    proc = _run("--input", bad, "--out", tmp_path / "out.png")
    assert_error(proc, "invalid_image")


def test_an_empty_mask_fails_by_name(tmp_path):
    src = tmp_path / "white.png"
    _flat(80, 80, grey=255).save(src)
    proc = _run("--input", src, "--out", tmp_path / "out.png", "--mask", "white")
    assert_error(proc, "empty_mask")
    assert not (tmp_path / "out.png").exists()


@pytest.mark.parametrize("args, code", [
    (("--out", "OUT.jpg"), "invalid_out"),
    (("--shadow", "10"), "invalid_args"),
    (("--shadow=-4,6",), "invalid_args"),                  # "=": argparse reads -4,6 as a flag
    (("--crop", "0,0,10"), "invalid_args"),
    (("--crop", "40,0,10,10"), "invalid_args"),
    (("--width", "0"), "invalid_args"),
    (("--tear", "-1"), "invalid_args"),
    (("--thresh", "0"), "invalid_args"),
    (("--seed", "-1"), "invalid_args"),
])
def test_bad_params_fail_by_name(tmp_path, args, code):
    src = tmp_path / "in.png"
    _disc(80, r=20).save(src)
    args = tuple(str(tmp_path / a) if a.startswith("OUT") else a for a in args)
    if "--out" not in args:
        args = args + ("--out", str(tmp_path / "out.png"))
    proc = _run("--input", src, *args)
    assert_error(proc, code)


def test_default_out_is_beside_the_input(tmp_path):
    src = tmp_path / "stamp.jpg"
    _disc(80, r=20, bg=255).convert("RGB").save(src)
    proc = _run("--input", src, "--width", 80)
    assert proc.returncode == 0, proc.stderr
    res = json.loads(proc.stdout)
    assert res["path"] == str(tmp_path / "stamp_paper.png")
    assert (tmp_path / "stamp_paper.png").is_file()


# numpy is blocked before the step runs: it must fail by name, before writing.
BLOCK_NUMPY = """
import runpy, sys
class _NoNumpy:
    def find_spec(self, name, path=None, target=None):
        if name == "numpy" or name.startswith("numpy."):
            raise ImportError("No module named 'numpy'", name="numpy")
sys.meta_path.insert(0, _NoNumpy())
sys.argv = [sys.argv[1]] + sys.argv[2:]
runpy.run_path(sys.argv[0], run_name="__main__")
"""


def test_missing_numpy_fails_with_the_extra_to_install(tmp_path):
    src = tmp_path / "in.png"
    _disc(80, r=20).save(src)
    out = tmp_path / "out.png"
    proc = subprocess.run([sys.executable, "-c", BLOCK_NUMPY, str(STEP), "--input", str(src), "--out", str(out)],
                          capture_output=True, text=True, timeout=120)
    assert_error(proc, "missing_dependency")
    msg = json.loads(proc.stderr)["message"]
    assert "numpy" in msg and "montaj[rvm]" in msg
    assert not out.exists()


# -- schema -----------------------------------------------------------------

def test_schema_matches_the_step_arguments():
    schema = json.loads(SCHEMA.read_text())
    assert schema["name"] == "paper_cutout"
    assert schema["input"]["type"] == "image"
    assert schema["output"]["type"] == "image"            # serve's _project names it .png
    div = _divergences(schema, _introspect(STEP))
    assert not div, "\n".join(div)
