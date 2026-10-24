"""§568: a HEIC, HEIF or TIFF upload is stored as a JPEG (a PNG when not fully opaque) with its colour profile.

The fixtures (tests/fixtures/web_image, made by make-fixtures.swift there) are Display P3 patterns of four known
quadrants. What is checked of an output is what Chromium will be given: the pixel values as stored, the ICC profile
bytes (the source's own, byte for byte), which quadrant lands where once the rotation is applied, and the alpha. The
colour as a colour-managed viewer shows it is checked against macOS ColorSync on real files in the QA run, not here
(this suite has no ColorSync)."""
import json
import uuid
from pathlib import Path

import pytest
from PIL import Image
from starlette.testclient import TestClient

from lib import web_image
from lib.common import ffmpeg_bin
from serve.server import app

FIX = Path(__file__).parent / "fixtures" / "web_image"
client = TestClient(app)

# The pattern's stored colours (make-fixtures.swift), in the source's own space: no conversion is made.
BLUE, RED, GREEN, GREY = (64, 128, 192), (230, 30, 40), (30, 200, 60), (128, 128, 128)
# Lossy sources (HEVC) and a JPEG output: a quadrant's centre is this close to the colour it was filled with.
TOL_LOSSY, TOL_JPEG = 6, 3


def _ffmpeg_reads_heic() -> bool:
    import subprocess
    try:
        r = subprocess.run([ffmpeg_bin(), "-v", "error", "-i", str(FIX / "p3.heic"), "-frames:v", "1", "-f", "null", "-"],
                           capture_output=True, timeout=60)
        return r.returncode == 0
    except OSError:
        return False


needs_heic = pytest.mark.skipif(not _ffmpeg_reads_heic(), reason="this ffmpeg has no HEIF demuxer (the app bundles 8.1.2, which has)")


def _quads(path):
    """(top-left, top-right, bottom-left, bottom-right) centre colours, RGB, as stored once shown."""
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    return [im.getpixel((x, y))[:3] for (x, y) in [(w // 4, h // 4), (3 * w // 4, h // 4), (w // 4, 3 * h // 4), (3 * w // 4, 3 * h // 4)]]


def _close(got, want, tol):
    return all(abs(a - b) <= tol for a, b in zip(got, want))


def _icc_of_tiff(name):
    with Image.open(FIX / name) as im:
        return im.info["icc_profile"]


@pytest.fixture
def work(tmp_path):
    def copy(name):
        dest = tmp_path / name
        dest.write_bytes((FIX / name).read_bytes())
        return dest
    return copy


# ── the HEIF profile ──────────────────────────────────────────────────────────────────────────────────────────────

def test_a_p3_heics_profile_is_its_primary_items_colr_prof():
    icc = web_image.heif_icc((FIX / "p3.heic").read_bytes())
    assert icc is not None and icc[36:40] == b"acsp"  # an ICC profile's signature
    # the same Display P3 profile ImageIO wrote into the P3 TIFF
    assert icc == _icc_of_tiff("p3.tiff")


def test_a_heic_whose_colour_is_only_nclx_has_no_profile():
    assert web_image.heif_icc((FIX / "srgb.heic").read_bytes()) is None


@pytest.mark.parametrize("cut", [0, 8, 40, 200, 600, 1000])
def test_a_cut_short_or_damaged_heic_has_no_profile_and_never_raises(cut):
    data = (FIX / "p3.heic").read_bytes()
    assert web_image.heif_icc(data[:cut]) in (None, web_image.heif_icc(data))
    assert web_image.heif_icc(b"\x00\x00\x00\x01meta" + b"\xff" * 64) is None
    assert web_image.heif_icc(bytes(64)) is None


# ── HEIC ──────────────────────────────────────────────────────────────────────────────────────────────────────────

@needs_heic
def test_a_p3_heic_becomes_a_jpeg_with_the_same_profile_and_the_stored_colours(work):
    src = work("p3.heic")
    out = web_image.to_web_image(src, ffmpeg_bin())
    assert out == src.with_suffix(".jpg") and src.exists(), "written beside it; the source is the caller's to remove"
    with Image.open(out) as im:
        assert im.format == "JPEG" and im.size == (240, 180)
        assert im.info["icc_profile"] == web_image.heif_icc(src.read_bytes())
        assert not im.getexif(), "no EXIF is carried over"
    for got, want in zip(_quads(out), [BLUE, RED, GREEN, GREY]):
        assert _close(got, want, TOL_LOSSY), (got, want)


@needs_heic
def test_a_rotated_heic_is_written_as_shown(work):
    out = web_image.to_web_image(work("p3-rot6.heic"), ffmpeg_bin())
    with Image.open(out) as im:
        assert im.size == (220, 300), "orientation 6: stored 300x220 shows as 220x300"
    # shown top-left is the stored bottom-left, and so round
    for got, want in zip(_quads(out), [GREEN, BLUE, GREY, RED]):
        assert _close(got, want, TOL_LOSSY), (got, want)


@needs_heic
def test_a_heic_with_no_profile_is_written_untagged(work):
    out = web_image.to_web_image(work("srgb.heic"), ffmpeg_bin())
    with Image.open(out) as im:
        assert "icc_profile" not in im.info


def test_a_file_named_heic_that_is_not_one_is_unreadable(work, tmp_path):
    bad = tmp_path / "x.heic"
    bad.write_bytes(b"not an image at all")
    with pytest.raises(web_image.WebImageError) as e:
        web_image.to_web_image(bad, ffmpeg_bin())
    assert e.value.code == "unreadable"
    assert not (tmp_path / "x.jpg").exists()


# ── TIFF ──────────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", ["p3.tiff", "p3-16bit.tiff"])
def test_a_p3_tiff_8_or_16_bit_becomes_a_jpeg_with_its_profile(work, name):
    out = web_image.to_web_image(work(name), ffmpeg_bin())
    with Image.open(out) as im:
        assert im.format == "JPEG" and im.size == (240, 180)
        assert im.info["icc_profile"] == _icc_of_tiff(name)
    for got, want in zip(_quads(out), [BLUE, RED, GREEN, GREY]):
        assert _close(got, want, TOL_JPEG), (got, want)


def test_a_rotated_tiff_is_written_as_shown(work):
    out = web_image.to_web_image(work("p3-rot6.tiff"), ffmpeg_bin())
    with Image.open(out) as im:
        assert im.size == (180, 240)
    for got, want in zip(_quads(out), [GREEN, BLUE, GREY, RED]):
        assert _close(got, want, TOL_JPEG), (got, want)


def test_a_tiff_with_transparency_becomes_a_png_keeping_its_alpha_and_profile(work):
    out = web_image.to_web_image(work("p3-alpha.tiff"), ffmpeg_bin())
    assert out.suffix == ".png"
    with Image.open(out) as im:
        assert im.mode == "RGBA" and im.info["icc_profile"] == _icc_of_tiff("p3-alpha.tiff")
        w, h = im.size
        # bottom-right quadrant filled at alpha 0.5: unpremultiplied, it is still grey (not darkened to 64)
        r, g, b, a = im.getpixel((7 * w // 8, 7 * h // 8))
        assert abs(a - 128) <= 2 and _close((r, g, b), GREY, 2), (r, g, b, a)
        # the cleared patch at its top-left corner is fully transparent
        assert im.getpixel((w // 2 + 4, h - 4))[3] == 0
        # an opaque quadrant stays opaque, its colour exact
        assert im.getpixel((w // 4, h // 4)) == (*BLUE, 255)


def test_a_converted_name_never_replaces_a_file_that_is_there(work, tmp_path):
    src = work("p3.tiff")
    (tmp_path / "p3.jpg").write_bytes(b"theirs")
    out = web_image.to_web_image(src, ffmpeg_bin())
    assert out.name == "p3_1.jpg" and (tmp_path / "p3.jpg").read_bytes() == b"theirs"


# ── the upload routes ─────────────────────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def env(tmp_path, monkeypatch):
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-24-slides"
    (pdir / "assets").mkdir(parents=True)
    pid = str(uuid.uuid4())
    (pdir / "project.json").write_text(json.dumps({"id": pid, "projectType": "carousel", "slides": [], "settings": {}}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    return pid, pdir, ws


def _post(url, name):
    return client.post(url, files={"file": (name, (FIX / name).read_bytes())})


@pytest.mark.parametrize("name,suffix", [("p3.tiff", ".jpg"), ("p3-alpha.tiff", ".png"),
                                         pytest.param("p3.heic", ".jpg", marks=needs_heic)])
def test_upload_asset_stores_only_the_converted_image_and_answers_its_path(env, name, suffix):
    pid, pdir, _ = env
    before = set(p.name for p in pdir.iterdir())
    r = _post(f"/api/projects/{pid}/upload-asset", name)
    assert r.status_code == 200, r.text
    out = Path(r.json()["path"])
    assert out.suffix == suffix and out.parent.resolve() == pdir.resolve() and out.is_file()
    assert set(p.name for p in pdir.iterdir()) - before == {out.name}, "the original is not kept"


def test_the_workspace_upload_converts_too(env):
    _, _, ws = env
    r = _post("/api/upload", "p3.tiff")
    assert r.status_code == 200, r.text
    out = Path(r.json()["path"])
    assert out.suffix == ".jpg" and out.parent.name == "_uploads"
    assert [p.name for p in out.parent.iterdir()] == [out.name]


def test_an_upload_that_cannot_be_converted_is_a_422_and_stores_nothing(env):
    pid, pdir, _ = env
    before = set(p.name for p in pdir.iterdir())
    r = client.post(f"/api/projects/{pid}/upload-asset", files={"file": ("broken.heic", b"nope")})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["error"] == "image_unconvertible"
    assert set(p.name for p in pdir.iterdir()) == before


@pytest.mark.parametrize("name,data", [("photo.png", b"\x89PNG"), ("clip.mov", b"mov"), ("photo.jpg", b"jpg")])
def test_any_other_upload_is_stored_as_it_was(env, name, data):
    pid, pdir, _ = env
    r = client.post(f"/api/projects/{pid}/upload-asset", files={"file": (name, data)})
    assert r.status_code == 200, r.text
    out = Path(r.json()["path"])
    assert out.name == name and out.read_bytes() == data
