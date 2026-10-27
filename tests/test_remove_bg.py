"""Tests for steps/remove_bg.py"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

REPO_ROOT = Path(__file__).parent.parent
STEP = REPO_ROOT / "steps" / "transform" / "remove_bg.py"


def _import_step_module():
    """Import remove_bg.py as a module so we can unit-test pure helpers
    without invoking the CLI or loading the RVM model."""
    spec = importlib.util.spec_from_file_location("_remove_bg_under_test", STEP)
    mod = importlib.util.module_from_spec(spec)
    # The script does sys.path.insert at import time to find lib/common — we
    # need lib/ on sys.path before exec_module().
    sys.path.insert(0, str(REPO_ROOT / "lib"))
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# Pure helper tests — rotation → ffmpeg filter mapping
# ---------------------------------------------------------------------------

def test_rotation_to_transpose_filter_zero_returns_none():
    """No rotation → None signals the caller to use -c:v copy fast path."""
    mod = _import_step_module()
    assert mod._rotation_to_transpose_filter(0) is None


def test_rotation_to_transpose_filter_minus_90_is_transpose_1():
    """iPhone vertical default. -90° displaymatrix → transpose=1 (90° CW)."""
    mod = _import_step_module()
    assert mod._rotation_to_transpose_filter(-90) == "transpose=1"


def test_rotation_to_transpose_filter_plus_90_is_transpose_2():
    """+90° displaymatrix → transpose=2 (90° CCW)."""
    mod = _import_step_module()
    assert mod._rotation_to_transpose_filter(90) == "transpose=2"


def test_rotation_to_transpose_filter_180_chains_two_transposes():
    """180° → two CW quarter-turns (lossless; no interpolation)."""
    mod = _import_step_module()
    assert mod._rotation_to_transpose_filter(180) == "transpose=1,transpose=1"
    assert mod._rotation_to_transpose_filter(-180) == "transpose=1,transpose=1"


def test_rotation_to_transpose_filter_270_normalizes_to_minus_90():
    """+270° = -90° after normalization → transpose=1 (90° CW)."""
    mod = _import_step_module()
    assert mod._rotation_to_transpose_filter(270) == "transpose=1"


def test_rotation_to_transpose_filter_minus_270_normalizes_to_plus_90():
    """-270° = +90° after normalization → transpose=2 (90° CCW)."""
    mod = _import_step_module()
    assert mod._rotation_to_transpose_filter(-270) == "transpose=2"


def test_rotation_to_transpose_filter_unsupported_angle_returns_none():
    """Fractional / unsupported angles fall back to None (skipped silently —
    very rare in practice; iPhone/Android always emit multiples of 90)."""
    mod = _import_step_module()
    assert mod._rotation_to_transpose_filter(45) is None
    assert mod._rotation_to_transpose_filter(33) is None


# ---------------------------------------------------------------------------
# Error-path tests
# ---------------------------------------------------------------------------

def test_remove_bg_fails_without_input():
    """Running the step with no arguments should exit non-zero."""
    r = subprocess.run([sys.executable, str(STEP)], capture_output=True, text=True)
    assert r.returncode != 0


def test_remove_bg_fails_missing_file(tmp_path):
    """Running the step with a nonexistent file should exit non-zero with a
    JSON error on stderr (file_not_found, or missing_dependency when the
    runtime is incomplete)."""
    r = subprocess.run(
        [sys.executable, str(STEP), "--input", "/nonexistent/clip.mp4"],
        capture_output=True, text=True,
    )
    assert r.returncode != 0
    # stderr should still be a JSON error object
    # Find the first line of stderr that is valid JSON
    err = None
    for line in r.stderr.splitlines():
        line = line.strip()
        if line.startswith('{'):
            try:
                err = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
    assert err is not None, f"No JSON error found in stderr: {r.stderr!r}"
    assert "error" in err
    assert "message" in err


def test_remove_bg_mutual_exclusion(tmp_path):
    """--input and --inputs must be mutually exclusive."""
    r = subprocess.run(
        [
            sys.executable, str(STEP),
            "--input", "/nonexistent/a.mp4",
            "--inputs", "/nonexistent/b.mp4",
        ],
        capture_output=True, text=True,
    )
    assert r.returncode != 0


# ---------------------------------------------------------------------------
# Inference on onnxruntime: the session is stubbed at the leaf
# ---------------------------------------------------------------------------

SCHEMA = STEP.with_suffix(".json")
MISSING_MODEL_MSG = "The background removal model is missing. Montaj restores it the next time it starts."
_OUTPUT_NAMES = ["fgr", "pha", "r1o", "r2o", "r3o", "r4o"]


def _ff_bins():
    """The ffmpeg/ffprobe the code runs (PV52), resolved before any test
    repoints the models dir the managed-build lookup reads."""
    from tests.conftest import FFMPEG_BIN, HAS_FFMPEG, skip_or_fail
    if not HAS_FFMPEG:
        skip_or_fail("ffmpeg not available")
    from lib.common import ffprobe_bin
    return FFMPEG_BIN, ffprobe_bin()


def _make_clip(path, size, seconds):
    """testsrc2 video with a sine track, made by the managed ffmpeg."""
    ffmpeg, _ = _ff_bins()
    subprocess.run(
        [
            ffmpeg, "-v", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc2=s={size}:r=25",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-t", str(seconds),
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            str(path),
        ],
        check=True, capture_output=True,
    )
    return path


def _count_frames(path):
    _, ffprobe = _ff_bins()
    r = subprocess.run(
        [ffprobe, "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return int(r.stdout.strip())


def _video_stream(path):
    _, ffprobe = _ff_bins()
    r = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,pix_fmt", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(r.stdout)["streams"][0]


def _audio_md5(path):
    ffmpeg, _ = _ff_bins()
    r = subprocess.run(
        [ffmpeg, "-v", "error", "-i", str(path), "-map", "0:a", "-f", "md5", "-"],
        capture_output=True, text=True, check=True,
    )
    return r.stdout.strip()


class _Recorder:
    """A fake onnxruntime.InferenceSession: records how it was opened and every
    run() feed, returns fgr = src, pha = 0.5 and recurrent outputs tagged with
    the call index so a feed can be traced to the call that produced it."""

    def __init__(self):
        self.sessions = []
        self.calls = []
        # pha(h, w) -> [1,1,h,w]; fgr is src unless fgr_scale is set
        self.pha = None
        self.fgr_scale = None
        recorder = self

        class _FakeSession:
            def __init__(self, path, sess_options=None, providers=None, **_kw):
                self.path = path
                self.providers = providers
                recorder.sessions.append(self)

            def run(self, output_names, feed):
                n = len(recorder.calls)
                src = feed["src"]
                _, _, h, w = src.shape
                rec_out = [np.full((1, i + 1, 2, 2), n + 1, dtype=np.float32) for i in range(4)]
                recorder.calls.append({
                    "session": self,
                    "src_shape": src.shape,
                    "src_dtype": src.dtype,
                    "src_min": float(src.min()),
                    "src_max": float(src.max()),
                    "downsample_ratio": np.array(feed["downsample_ratio"], copy=True),
                    "rec_in": [np.array(feed[f"r{i}i"], copy=True) for i in range(1, 5)],
                    "rec_out": rec_out,
                })
                fgr = np.array(src, dtype=np.float32, copy=True)
                if recorder.fgr_scale is not None:
                    fgr *= recorder.fgr_scale
                out = dict(zip(_OUTPUT_NAMES, [
                    fgr,
                    recorder.pha(h, w) if recorder.pha else np.full((1, 1, h, w), 0.5, dtype=np.float32),
                    *rec_out,
                ]))
                return [out[name] for name in (output_names or _OUTPUT_NAMES)]

        self.cls = _FakeSession


@pytest.fixture
def stubbed(monkeypatch, tmp_path):
    """The step module with a placeholder model in a temp models dir and
    InferenceSession replaced by a recorder."""
    ffmpeg, ffprobe = _ff_bins()
    monkeypatch.setenv("MONTAJ_FFMPEG", ffmpeg)
    monkeypatch.setenv("MONTAJ_FFPROBE", ffprobe)
    mod = _import_step_module()
    models_dir = tmp_path / "models"
    (models_dir / "rvm").mkdir(parents=True)
    (models_dir / "rvm" / mod.rvm_model.FILENAME).write_bytes(b"placeholder")
    monkeypatch.setattr(mod.models, "MONTAJ_MODELS_DIR", str(models_dir))
    rec = _Recorder()
    monkeypatch.setattr(mod.onnxruntime, "InferenceSession", rec.cls)
    return mod, rec, models_dir


def _run_main(mod, monkeypatch, capsys, *argv):
    monkeypatch.setattr(sys, "argv", ["remove_bg.py", *argv])
    mod.main()
    return json.loads(capsys.readouterr().out)


def _assert_state_chained(calls):
    """Call n's r1i..r4i are exactly what call n-1 returned; call 0 gets zeros."""
    zeros = np.zeros((1, 1, 1, 1), dtype=np.float32)
    for k, call in enumerate(calls):
        for i in range(4):
            got = call["rec_in"][i]
            want = zeros if k == 0 else calls[k - 1]["rec_out"][i]
            assert got.dtype == np.float32, f"call {k} r{i + 1}i dtype {got.dtype}"
            assert got.shape == want.shape and np.array_equal(got, want), (
                f"call {k} r{i + 1}i is not the previous call's r{i + 1}o")


@pytest.mark.slow
def test_one_cpu_session_one_run_per_frame_state_chained(stubbed, monkeypatch, capsys, tmp_path):
    mod, rec, models_dir = stubbed
    a = _make_clip(tmp_path / "a.mp4", "320x568", 2)
    b = tmp_path / "b.mp4"
    shutil.copyfile(a, b)
    n = _count_frames(a)
    assert n > 1

    results = _run_main(mod, monkeypatch, capsys, "--inputs", str(a), str(b))

    # 1. one CPU session serves both inputs
    assert len(rec.sessions) == 1
    session = rec.sessions[0]
    assert session.providers == ["CPUExecutionProvider"]
    assert str(session.path) == str(models_dir / "rvm" / mod.rvm_model.FILENAME)
    assert all(c["session"] is session for c in rec.calls)

    # 2. one run() per frame
    assert len(rec.calls) == 2 * n

    # 3. recurrent state chains within an input and restarts at zeros for the next
    _assert_state_chained(rec.calls[:n])
    _assert_state_chained(rec.calls[n:])

    # 4. downsample 0.5 as float32 [1]; src float32 [1,3,H,W] in [0,1]
    for c in rec.calls:
        assert c["downsample_ratio"].dtype == np.float32
        assert c["downsample_ratio"].shape == (1,)
        assert c["downsample_ratio"][0] == np.float32(0.5)
        assert c["src_dtype"] == np.float32
        assert c["src_shape"] == (1, 3, 568, 320)
        assert 0.0 <= c["src_min"] and c["src_max"] <= 1.0
        assert c["src_max"] > 0.0

    # 5 (no flag) and 6. full size, alpha, audio kept, preview written
    assert isinstance(results, list) and len(results) == 2
    for src, res in zip((a, b), results):
        out = Path(res["nobg_src"])
        assert out == src.with_name(src.stem + "_nobg.mov")
        v = _video_stream(out)
        assert (v["width"], v["height"]) == (320, 568)
        assert v["pix_fmt"].startswith("yuva"), v["pix_fmt"]
        assert _count_frames(out) == n
        assert _audio_md5(out) == _audio_md5(src)
        assert Path(res["nobg_preview_src"]).is_file()


@pytest.mark.slow
def test_max_height_scales_the_decode(stubbed, monkeypatch, capsys, tmp_path):
    mod, rec, _ = stubbed
    a = _make_clip(tmp_path / "a.mp4", "320x568", 2)
    out = tmp_path / "small.mov"

    res = _run_main(mod, monkeypatch, capsys,
                    "--input", str(a), "--out", str(out), "--max-height", "284")

    assert res["nobg_src"] == str(out)
    assert len(rec.calls) == _count_frames(a)
    assert {c["src_shape"] for c in rec.calls} == {(1, 3, 284, 160)}
    v = _video_stream(out)
    assert (v["width"], v["height"]) == (160, 284)
    assert v["pix_fmt"].startswith("yuva"), v["pix_fmt"]
    assert _audio_md5(out) == _audio_md5(a)


# ---------------------------------------------------------------------------
# --max-height sizing
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("w, h, rotation, max_height, expected", [
    (2160, 3840, 0, 1920, (1080, 1920)),
    (3840, 2160, 0, 1920, (3414, 1920)),
    (3840, 2160, -90, 1920, (1920, 1080)),
    (576, 1024, 0, 1920, (576, 1024)),
    (3840, 2160, 0, None, (3840, 2160)),
])
def test_target_size(w, h, rotation, max_height, expected):
    mod = _import_step_module()
    assert mod._target_size(w, h, rotation, max_height) == expected


@pytest.mark.parametrize("bad", [1919, 0, -2])
def test_target_size_rejects_odd_or_non_positive(bad, capsys):
    mod = _import_step_module()
    with pytest.raises(SystemExit) as exc:
        mod._target_size(2160, 3840, 0, bad)
    assert exc.value.code != 0
    assert json.loads(capsys.readouterr().err)["error"] == "invalid_args"


@pytest.mark.parametrize("bad", ["1919", "0", "-2"])
def test_main_rejects_odd_or_non_positive_max_height(bad):
    r = subprocess.run(
        [sys.executable, str(STEP), "--input", "/nonexistent/clip.mp4", "--max-height", bad],
        capture_output=True, text=True,
    )
    assert r.returncode != 0
    assert _last_json(r.stderr)["error"] == "invalid_args"


# ---------------------------------------------------------------------------
# Errors: a user of the app has no terminal, so no message names a command
# ---------------------------------------------------------------------------

def _last_json(stderr):
    for line in reversed(stderr.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    raise AssertionError(f"No JSON error found in stderr: {stderr!r}")


def _step_env(home):
    """Run the step with `home` as HOME, so the models dir is home's own."""
    ffmpeg, ffprobe = _ff_bins()
    env = dict(os.environ)
    env.update(HOME=str(home), MONTAJ_FFMPEG=ffmpeg, MONTAJ_FFPROBE=ffprobe)
    return env


def test_missing_model_fails_with_the_message(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"not decoded: the model check comes first")
    r = subprocess.run(
        [sys.executable, str(STEP), "--input", str(clip)],
        capture_output=True, text=True, env=_step_env(home),
    )
    assert r.returncode != 0
    err = _last_json(r.stderr)
    assert err["error"] == "missing_model"
    assert err["message"] == MISSING_MODEL_MSG


def test_missing_package_fails_with_the_message():
    # sys.modules[name] = None makes `import name` raise ImportError.
    code = (
        "import runpy, sys; sys.modules['onnxruntime'] = None; "
        f"sys.argv = [{str(STEP)!r}, '--input', 'x.mp4']; "
        f"runpy.run_path({str(STEP)!r}, run_name='__main__')"
    )
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert r.returncode != 0
    err = _last_json(r.stderr)
    assert err["error"] == "missing_dependency"
    assert err["message"] == (
        "Background removal is missing part of its runtime (onnxruntime). Reinstall Montaj.")


def test_source_names_no_command():
    text = STEP.read_text(encoding="utf-8")
    assert "montaj install" not in text
    assert "pip install" not in text
    assert "`" not in text


def test_no_string_the_step_can_print_has_an_em_dash():
    """Every string literal outside docstrings: error messages, help text."""
    import ast
    tree = ast.parse(STEP.read_text(encoding="utf-8"))
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                docstrings.add(id(first.value))
    bad = [
        node.value for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
        and id(node) not in docstrings and "—" in node.value
    ]
    assert not bad, bad


# ---------------------------------------------------------------------------
# Schema parity
# ---------------------------------------------------------------------------

def test_schema_params_match_argparse():
    from tests.test_step_schema_conformance import _introspect
    step = _introspect(STEP)
    schema = json.loads(SCHEMA.read_text())
    params = {p["name"].replace("-", "_"): p for p in schema["params"]}
    io = {"input", "inputs", "out"}
    assert set(params) - io == set(step) - io
    for dest, action in step.items():
        if dest in io:
            continue
        p = params[dest]
        if action["kind"] == "store_true":
            assert p["type"] in ("bool", "boolean"), dest
            assert bool(p.get("default", False)) is False, dest
        else:
            assert p["type"] == action["type"], dest
            assert p.get("default") == action["default"], dest


# ---------------------------------------------------------------------------
# The real model (MONTAJ_TEST_RVM_MODEL names the pinned file)
# ---------------------------------------------------------------------------

def _rvm_model_constants():
    sys.path.insert(0, str(REPO_ROOT / "lib"))
    import rvm_model
    return rvm_model


@pytest.mark.slow
def test_real_model_mattes_a_clip(tmp_path):
    from tests.conftest import skip_or_fail
    model_src = os.environ.get("MONTAJ_TEST_RVM_MODEL")
    if not model_src:
        skip_or_fail("MONTAJ_TEST_RVM_MODEL is unset; point it at the pinned RVM ONNX model")
    pinned = _rvm_model_constants()
    data = Path(model_src).read_bytes()
    assert len(data) == pinned.SIZE
    assert hashlib.sha256(data).hexdigest() == pinned.SHA256

    home = tmp_path / "home"
    model_dir = home / ".local" / "share" / "montaj" / "models" / "rvm"
    model_dir.mkdir(parents=True)
    shutil.copyfile(model_src, model_dir / pinned.FILENAME)
    clip = _make_clip(tmp_path / "clip.mp4", "256x256", 1)
    out = tmp_path / "clip_nobg.mov"

    r = subprocess.run(
        [sys.executable, str(STEP), "--input", str(clip), "--out", str(out)],
        capture_output=True, text=True, env=_step_env(home),
    )
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout)
    v = _video_stream(out)
    assert (v["width"], v["height"]) == (256, 256)
    assert v["pix_fmt"].startswith("yuva"), v["pix_fmt"]
    assert Path(res["nobg_preview_src"]).is_file()


# ---------------------------------------------------------------------------
# ffmpeg time limits
# ---------------------------------------------------------------------------

def test_ffmpeg_timeout_scales_with_the_clip(monkeypatch):
    mod = _import_step_module()
    monkeypatch.setattr(mod, "get_duration", lambda p: 10.0)
    assert mod._ffmpeg_timeout("a.mp4") == 300
    monkeypatch.setattr(mod, "get_duration", lambda p: 60.0)
    assert mod._ffmpeg_timeout("a.mp4") == 600


def test_ffmpeg_timeout_floors_when_the_clip_cannot_be_probed(monkeypatch):
    mod = _import_step_module()

    def boom(p):
        raise SystemExit(1)
    monkeypatch.setattr(mod, "get_duration", boom)
    assert mod._ffmpeg_timeout("a.mp4") == 300


def test_ffmpeg_pass_gets_the_scaled_limit(monkeypatch):
    mod = _import_step_module()
    seen = {}
    monkeypatch.setattr(mod, "get_duration", lambda p: 90.0)
    monkeypatch.setattr(mod, "run", lambda cmd, **kw: seen.update(kw))
    mod._run_ffmpeg(["ffmpeg"], "a.mov")
    assert seen["timeout"] == 900


def test_ffmpeg_timeout_becomes_error_json(monkeypatch, capsys):
    mod = _import_step_module()
    monkeypatch.setattr(mod, "get_duration", lambda p: 1.0)

    def slow(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, kw["timeout"])
    monkeypatch.setattr(mod, "run", slow)
    with pytest.raises(SystemExit) as exc:
        mod._run_ffmpeg(["ffmpeg", "-i", "a.mov"], "a.mov")
    assert exc.value.code == 1
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "unexpected_error"
    assert "ffmpeg" not in err["message"] and "—" not in err["message"]


# ---------------------------------------------------------------------------
# A still image: one frame through RVM, a PNG with alpha out (§587)
# ---------------------------------------------------------------------------

PERSON = REPO_ROOT / "tests" / "fixtures" / "remove_bg" / "person.jpg"


def _srgb_icc():
    from PIL import ImageCms
    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def _photo(path, size=(64, 48), *, orientation=None, icc=None, mode="RGB"):
    """A noisy photo (so a pixel copied from it is told from one that is not)."""
    from PIL import Image
    w, h = size
    rng = np.random.default_rng(7)
    arr = rng.integers(40, 216, size=(h, w, 4 if mode == "RGBA" else 3), dtype=np.uint8)
    if mode == "RGBA":
        arr[..., 3] = 255
        arr[: h // 2, :, 3] = 0  # the top half is already transparent
    im = Image.fromarray(arr, mode)
    kw = {}
    if icc:
        kw["icc_profile"] = icc
    if orientation:
        exif = Image.Exif()
        exif[0x0112] = orientation
        kw["exif"] = exif.tobytes()
    im.save(path, **kw)
    return path


def _left_half(h, w):
    pha = np.zeros((1, 1, h, w), dtype=np.float32)
    pha[..., : w // 2] = 1.0
    return pha


def test_image_input_writes_a_png_cutout_beside_it(stubbed, monkeypatch, capsys, tmp_path):
    from PIL import Image
    mod, rec, _ = stubbed
    rec.pha, rec.fgr_scale = _left_half, 0.5
    icc = _srgb_icc()
    src = _photo(tmp_path / "photo.png", icc=icc)

    res = _run_main(mod, monkeypatch, capsys, "--input", str(src))

    out = tmp_path / "photo-cutout.png"
    assert res == {"out": str(out), "width": 64, "height": 48}
    # one frame, the recurrent state at its start
    assert len(rec.sessions) == 1 and len(rec.calls) == 1
    call = rec.calls[0]
    assert call["src_shape"] == (1, 3, 48, 64)
    assert all(np.array_equal(r, np.zeros((1, 1, 1, 1), np.float32)) for r in call["rec_in"])
    with Image.open(out) as im:
        assert im.format == "PNG" and im.mode == "RGBA" and im.size == (64, 48)
        assert im.info.get("icc_profile") == icc
        got = np.asarray(im)
    want = np.asarray(Image.open(src).convert("RGB"))
    # the person (pha 1) is opaque and keeps the photo's own pixels
    assert (got[:, :32, 3] == 255).all()
    assert np.array_equal(got[:, :32, :3], want[:, :32])
    # the background (pha 0) is transparent
    assert (got[:, 32:, 3] == 0).all()
    # no video files
    assert sorted(p.name for p in tmp_path.iterdir() if p.is_file()) == ["photo-cutout.png", "photo.png"]


def test_image_edges_take_the_matted_foreground(stubbed, monkeypatch, capsys, tmp_path):
    from PIL import Image
    mod, rec, _ = stubbed
    rec.fgr_scale = 0.5  # pha 0.5 everywhere: every pixel is an edge
    src = _photo(tmp_path / "photo.png")
    res = _run_main(mod, monkeypatch, capsys, "--input", str(src))
    got = np.asarray(Image.open(res["out"]))
    want = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
    assert (got[..., 3] == 128).all()
    assert np.abs(got[..., :3].astype(np.float32) - want * 0.5).max() <= 1


def test_image_exif_orientation_is_applied(stubbed, monkeypatch, capsys, tmp_path):
    from PIL import Image
    mod, rec, _ = stubbed
    src = _photo(tmp_path / "photo.jpg", orientation=6)  # stored 64x48, shown 48x64

    res = _run_main(mod, monkeypatch, capsys, "--input", str(src))

    assert (res["width"], res["height"]) == (48, 64)
    assert rec.calls[0]["src_shape"] == (1, 3, 64, 48)
    with Image.open(res["out"]) as im:
        assert im.size == (48, 64)
        assert im.getexif().get(0x0112) in (None, 1)


def test_image_source_alpha_stays_transparent(stubbed, monkeypatch, capsys, tmp_path):
    from PIL import Image
    mod, rec, _ = stubbed
    rec.pha = lambda h, w: np.ones((1, 1, h, w), dtype=np.float32)
    src = _photo(tmp_path / "photo.png", mode="RGBA")
    res = _run_main(mod, monkeypatch, capsys, "--input", str(src))
    a = np.asarray(Image.open(res["out"]))[..., 3]
    assert (a[:24] == 0).all() and (a[24:] == 255).all()


def test_image_out_is_always_a_png(stubbed, monkeypatch, capsys, tmp_path):
    """serve's `_project` names a .mov (the step's `out` ext) when out is left off."""
    mod, rec, _ = stubbed
    src = _photo(tmp_path / "photo.jpg")
    res = _run_main(mod, monkeypatch, capsys, "--input", str(src), "--out", str(tmp_path / "x.mov"))
    assert res["out"] == str(tmp_path / "x.png")
    assert (tmp_path / "x.png").is_file() and not (tmp_path / "x.mov").exists()


def test_image_batch(stubbed, monkeypatch, capsys, tmp_path):
    mod, rec, _ = stubbed
    a, b = _photo(tmp_path / "a.png"), _photo(tmp_path / "b.jpg", (40, 30))
    res = _run_main(mod, monkeypatch, capsys, "--inputs", str(a), str(b))
    assert res == [
        {"out": str(tmp_path / "a-cutout.png"), "width": 64, "height": 48},
        {"out": str(tmp_path / "b-cutout.png"), "width": 40, "height": 30},
    ]
    assert len(rec.sessions) == 1 and len(rec.calls) == 2


def test_image_that_does_not_decode_fails_with_json(stubbed, monkeypatch, capsys, tmp_path):
    mod, _, _ = stubbed
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"not an image")
    monkeypatch.setattr(sys, "argv", ["remove_bg.py", "--input", str(bad)])
    with pytest.raises(SystemExit):
        mod.main()
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["error"] == "invalid_image"


@pytest.mark.parametrize("w, h, want", [(409, 512, 1.0), (300, 200, 1.0), (4000, 3000, 0.128), (1080, 1920, 0.2667)])
def test_image_ratio_mattes_near_512(w, h, want):
    """A still mattes best with RVM's own pass near 512 px on the long side
    (measured on the fixture portrait: 0.5 on a 1536 px image left holes in the helmet)."""
    mod = _import_step_module()
    assert mod._image_ratio(w, h) == pytest.approx(want, abs=1e-4)


@pytest.mark.slow
def test_real_model_cuts_out_a_person(tmp_path):
    from PIL import Image
    from tests.conftest import skip_or_fail
    model_src = os.environ.get("MONTAJ_TEST_RVM_MODEL")
    if not model_src:
        skip_or_fail("MONTAJ_TEST_RVM_MODEL is unset; point it at the pinned RVM ONNX model")
    pinned = _rvm_model_constants()
    home = tmp_path / "home"
    model_dir = home / ".local" / "share" / "montaj" / "models" / "rvm"
    model_dir.mkdir(parents=True)
    shutil.copyfile(model_src, model_dir / pinned.FILENAME)
    src = tmp_path / "person.jpg"
    shutil.copyfile(PERSON, src)

    r = subprocess.run(
        [sys.executable, str(STEP), "--input", str(src)],
        capture_output=True, text=True, env=_step_env(home),
    )
    assert r.returncode == 0, r.stderr
    res = json.loads(r.stdout)
    assert res == {"out": str(tmp_path / "person-cutout.png"), "width": 409, "height": 512}
    with Image.open(res["out"]) as im:
        assert im.mode == "RGBA" and im.size == (409, 512)
        a = np.asarray(im)[..., 3]
    # the backdrop's top corners are transparent, the face and the suit opaque
    assert a[:60, :60].max() == 0 and a[:60, -60:].max() == 0
    assert a[100:140, 220:260].min() == 255   # face
    assert a[330:370, 150:200].min() == 255   # suit


@pytest.mark.slow
@pytest.mark.parametrize("out", ["person-cutout.png", None])
def test_real_model_through_serve_with_project(out, tmp_path, monkeypatch):
    """The app's call (a plain out name) and an AI's run_step (out left off): either
    way a PNG in the project's assets, recorded as made from the photo."""
    import uuid
    from PIL import Image
    from starlette.testclient import TestClient
    import serve.routes.steps as steps_mod
    from serve.server import app
    from tests.conftest import skip_or_fail
    model_src = os.environ.get("MONTAJ_TEST_RVM_MODEL")
    if not model_src:
        skip_or_fail("MONTAJ_TEST_RVM_MODEL is unset; point it at the pinned RVM ONNX model")
    pinned = _rvm_model_constants()
    home = tmp_path / "home"
    model_dir = home / ".local" / "share" / "montaj" / "models" / "rvm"
    model_dir.mkdir(parents=True)
    shutil.copyfile(model_src, model_dir / pinned.FILENAME)
    for k, v in _step_env(home).items():
        monkeypatch.setenv(k, v)
    ws = tmp_path / "Montaj"
    pdir = ws / "2026-10-26-photo"
    (pdir / "assets").mkdir(parents=True)
    pid = str(uuid.uuid4())
    (pdir / "project.json").write_text(json.dumps({"id": pid, "projectType": "carousel", "slides": []}))
    photo = pdir / "assets" / "person.jpg"
    shutil.copyfile(PERSON, photo)
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    steps_mod._RESERVED_OUTS.clear()

    body = {"input": str(photo), "_project": pid, **({"out": out} if out else {})}
    r = TestClient(app).post("/api/steps/remove_bg", json=body)

    assert r.status_code == 200, r.text
    res = r.json()
    made = Path(res["out"])
    assert made.parent == pdir / "assets" and made.suffix == ".png"
    if out:
        assert made.name == "person-cutout.png"
    with Image.open(made) as im:
        assert im.mode == "RGBA" and im.size == (409, 512)
    assert not list((pdir / "assets").glob("*.mov"))
    record = json.loads((pdir / "assets" / ".provenance.json").read_text())
    entry = next(v for k, v in record.items() if k.endswith(made.name))
    assert entry["kind"] == "derived" and entry["step"] == "remove_bg"
    assert [f.split("/")[-1] for f in entry["from"]] == ["person.jpg"]
