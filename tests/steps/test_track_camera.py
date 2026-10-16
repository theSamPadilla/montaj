"""steps/media/track_camera.py: the camera of a clip, for a 3D scene.

The maths is lib/camera_track.py's (tests/test_camera_track.py). Here: the step's
refusals, its schema against its argparse, and one real clip.

The real clip is §328's kit (a handheld phone over a table, 540x960, 30 fps,
7.5 s, with hand-marked landmarks), outside git: the test skips unless
MONTAJ_TEST_S255_DIR names its folder. Every frame at 10 fps must track, and the
static landmarks, triangulated through the cameras the step emits and projected
back through them (the engine's projection, no distortion), must land within
5 px mean of the marks. §328 P0 measured 4.95 px with pycolmap's own camera, and
this step 3.92 to 3.98 px over six runs (all cores, before SIFT was capped at 4096
features a frame; not yet re-run since).
"""
import argparse
import importlib.util
import json
import os
import subprocess
import sys

import pytest

from tests.conftest import FFMPEG_BIN, HAS_FFMPEG, REPO_ROOT, assert_error

STEP = REPO_ROOT / "steps" / "media" / "track_camera.py"
SCHEMA = json.loads((REPO_ROOT / "steps" / "media" / "track_camera.json").read_text())
KIT = os.environ.get("MONTAJ_TEST_S255_DIR")
STATIC = ("tubeTop", "tubeBase", "blockTL")
MAX_MEAN_PX = 5.0


def _run(args, prelude=""):
    """The step in a fresh interpreter, after `prelude` (to stand in for a machine)."""
    code = (f"{prelude}\nimport runpy, sys\nsys.argv = {[str(STEP), *map(str, args)]!r}\n"
            f"runpy.run_path({str(STEP)!r}, run_name='__main__')")
    return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(REPO_ROOT))


@pytest.fixture
def clip(tmp_path):
    p = tmp_path / "clip.mp4"
    p.write_bytes(b"not read before the refusals")
    return p


def test_without_pycolmap_it_names_the_vision_extra(clip):
    proc = _run(["--input", clip], prelude="import sys; sys.modules['pycolmap'] = None")
    assert_error(proc, "missing_dependency")
    assert json.loads(proc.stderr)["message"] == "Camera tracking needs Montaj's vision extra (pycolmap)."


def test_an_intel_mac_is_refused(clip):
    proc = _run(["--input", clip],
                prelude="import platform, sys; sys.platform = 'darwin'; platform.machine = lambda: 'x86_64'")
    assert_error(proc, "unsupported_platform")
    assert json.loads(proc.stderr)["message"] == "Camera tracking isn't available on Intel Macs yet."


@pytest.mark.parametrize("args", [["--fps", "0.5"], ["--fps", "31"], ["--lens", "4"], ["--max-frames", "0"]])
def test_params_out_of_range_are_refused(clip, args):
    assert_error(_run(["--input", clip, *args]), "invalid_param")


def _load_step():
    spec = importlib.util.spec_from_file_location("track_camera_step", STEP)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_schema_matches_the_argparse(monkeypatch):
    mod = _load_step()
    seen = {}

    def grab(self, *a, **k):
        seen["parser"] = self
        raise SystemExit(0)

    monkeypatch.setattr(argparse.ArgumentParser, "parse_args", grab)
    with pytest.raises(SystemExit):
        mod.main()
    flags = {a.option_strings[0][2:]: a for a in seen["parser"]._actions if a.option_strings and a.dest != "help"}
    assert SCHEMA["input"]["type"] == "video" and flags.pop("input").required
    params = {p["name"]: p for p in SCHEMA["params"]}
    assert set(params) == set(flags)
    types = {"float": float, "int": int, "string": None, "path": None}
    for name, p in params.items():
        assert flags[name].default == p.get("default"), name
        assert flags[name].type is types[p["type"]], name
        assert flags[name].required is bool(p.get("required")), name
    assert (params["fps"]["min"], params["fps"]["max"]) == (mod.MIN_FPS, mod.MAX_FPS)
    assert (params["lens"]["min"], params["lens"]["max"]) == (mod.MIN_LENS, mod.MAX_LENS)


def test_reconstruct_caps_sift_and_seeds_the_mapper(tmp_path):
    """pycolmap stood in for, so the options the step sets are checked without a
    reconstruction."""
    from types import SimpleNamespace as NS
    seen = {}
    fake = NS(
        logging=NS(minloglevel=0),
        ImageReaderOptions=lambda: NS(camera_model="SIMPLE_PINHOLE", default_focal_length_factor=1.2),
        FeatureExtractionOptions=lambda: NS(num_threads=-1, sift=NS(max_num_features=8192)),
        SequentialPairingOptions=lambda: NS(overlap=10),
        GlobalPipelineOptions=lambda: NS(random_seed=-1, mapper=NS(random_seed=-1)),
        CameraMode=NS(SINGLE="single"), Device=NS(cpu="cpu"),
        extract_features=lambda db, frames, **k: seen.update(extract=k),
        match_sequential=lambda db, **k: seen.update(match=k),
        global_mapping=lambda db, frames, out, options: seen.update(mapping=options) or {},
    )
    mod = _load_step()
    assert mod._reconstruct(fake, str(tmp_path), str(tmp_path / "work"), 0.85) is None
    ext = seen["extract"]
    assert (ext["camera_mode"], ext["device"], ext["reader_options"].camera_model) == ("single", "cpu", "SIMPLE_RADIAL")
    assert ext["reader_options"].default_focal_length_factor == 0.85
    assert ext["extraction_options"].num_threads == min(4, os.cpu_count() or 1)
    assert ext["extraction_options"].sift.max_num_features == 4096
    assert seen["match"]["pairing_options"].overlap == 15
    assert (seen["mapping"].random_seed, seen["mapping"].mapper.random_seed) == (0, 0)


def test_work_folders_left_by_killed_runs_are_swept(tmp_path):
    mod = _load_step()
    now = 1_000_000.0
    old, fresh, other = tmp_path / "montaj-track-camera-old", tmp_path / "montaj-track-camera-new", tmp_path / "other-old"
    for d in (old, fresh, other):
        (d / "frames").mkdir(parents=True)
    for d in (old, other):
        for p in (d, d / "frames"):
            os.utime(p, (now - 7200, now - 7200))
    for p in (fresh, fresh / "frames"):
        os.utime(p, (now - 7200, now - 7200))
    os.utime(fresh / "frames", (now - 60, now - 60))         # a run still writing into it
    mod._sweep_stale(str(tmp_path), now=now)
    assert (not old.exists(), fresh.exists(), other.exists()) == (True, True, True)


def test_a_track_that_is_not_finite_fails_as_tracking_failed(capsys):
    mod = _load_step()
    with pytest.raises(SystemExit) as e:
        mod._emit({"frames": [{"location": [0.0, float("nan"), 0.3]}]}, None)
    assert e.value.code == 1
    out = capsys.readouterr()
    assert out.out == "" and json.loads(out.err)["error"] == "tracking_failed"


def test_too_few_tracked_frames_point_a_locked_off_shot_at_fit_camera():
    assert "The camera must move; for a locked-off shot use fit_camera." in _load_step()._too_few(10, 75)


def test_solve_errors_map_to_their_fail_codes():
    pytest.importorskip("numpy")
    from lib import camera_track as ct
    mod = _load_step()
    assert mod._solve_error_code(ct, ct.NoPlane(), None) == "no_plane"
    assert mod._solve_error_code(ct, ct.NoPlane(), {"height": 0.3}) == "no_plane"
    assert mod._solve_error_code(ct, ValueError("x"), {"height": 0.3}) == "invalid_known"
    assert mod._solve_error_code(ct, ValueError("x"), None) == "tracking_failed"


def test_frame_k_is_the_frame_on_screen_at_k_over_fps(tmp_path, monkeypatch):
    """A 30 fps clip whose frame i has luma 16 + 6 i, sampled at 10 fps through
    lib/frame_sampling: frame k is source frame 3k (ffmpeg's fps filter rounding to
    the nearest keeps 3k + 1, a frame late), the source's transfer reaches the
    sampler, and a frame over WORK_LONG_EDGE is scaled down whole, after it."""
    np = pytest.importorskip("numpy")
    Image = pytest.importorskip("PIL.Image")
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg is not available")
    clip = tmp_path / "ramp.mkv"
    subprocess.run([FFMPEG_BIN, "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x48:r=30:d=1",
                    "-vf", "geq=lum='16+6*N':cb=128:cr=128", "-c:v", "ffv1", "-pix_fmt", "yuv444p", str(clip)],
                   check=True)
    mod = _load_step()
    monkeypatch.setattr(mod, "WORK_LONG_EDGE", 32)
    asked = []
    real = mod.frame_sampling.input_args
    monkeypatch.setattr(mod.frame_sampling, "input_args", lambda *a, **k: asked.append((a, k)) or real(*a, **k))
    out = tmp_path / "frames"
    out.mkdir()
    assert mod._extract(str(clip), 10, (64, 48), str(out), 30.0, "bt709") == (32, 24, False)
    assert asked == [((str(clip), 10, 30.0, "bt709"), {"after": "scale=32:24:flags=area"})]
    names = sorted(os.listdir(out))
    assert names == [f"f{k:05d}.jpg" for k in range(10)]
    for k, name in enumerate(names):
        img = Image.open(out / name).convert("L")
        assert img.size == (32, 24)
        grey = float(np.asarray(img).mean())
        assert abs(grey - 6 * 3 * k * 255 / 219) < 2.5, (k, grey)    # limited range read as full


def test_a_clip_over_max_frames_is_refused_before_tracking(tmp_path):
    pytest.importorskip("pycolmap")
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg is not available")
    clip = tmp_path / "c.mp4"
    subprocess.run([FFMPEG_BIN, "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=30:d=3",
                    "-pix_fmt", "yuv420p", str(clip)], check=True)
    proc = _run(["--input", clip, "--max-frames", "20"])
    assert_error(proc, "too_many_frames")
    assert "30 frames" in json.loads(proc.stderr)["message"]


def test_a_bad_known_is_refused(clip):
    pytest.importorskip("pycolmap")
    assert_error(_run(["--input", clip, "--known", '{"height": -1}']), "invalid_known")


# ---- the real clip ----

def _triangulate(np, ct, cams, pixels, size):
    """The point nearest every ray (least squares)."""
    M, b = np.zeros((3, 3)), np.zeros(3)
    for cam, px in zip(cams, pixels):
        d = ct.pixel_rays(cam, [px], size)[0]
        P = np.eye(3) - np.outer(d, d)
        M += P
        b += P @ np.asarray(cam["location"], float)
    return np.linalg.solve(M, b)


@pytest.mark.skipif(not KIT, reason="MONTAJ_TEST_S255_DIR is not set (the §328 test kit, outside git)")
def test_real_clip_tracks_every_frame_and_holds_the_static_landmarks(tmp_path):
    np = pytest.importorskip("numpy")
    pytest.importorskip("pycolmap")
    from lib import camera_track as ct

    out = tmp_path / "track.json"
    proc = _run(["--input", os.path.join(KIT, "clip-sdr.mp4"), "--out", out])
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == str(out)
    track = json.loads(out.read_text())
    assert (track["frameCount"], track["registered"], track["size"]) == (75, 75, [540, 960])

    marks = json.loads(open(os.path.join(KIT, "landmarks.json")).read())["t"]
    size = tuple(track["size"])

    def cam(t):
        f = track["frames"][round(t * track["fps"])]
        assert f["t"] == pytest.approx(t)
        return {"location": f["location"], "target": f["target"], "roll": f["roll"], "lens": track["lens"]}

    misses = {}
    for name in STATIC:
        seen = [(float(t), row[name]) for t, row in marks.items() if name in row]
        X = _triangulate(np, ct, [cam(t) for t, _ in seen], [px for _, px in seen], size)
        misses[name] = [float(np.hypot(*np.subtract(ct.project_points(cam(t), [X], size)[0], px))) for t, px in seen]
    every = [m for v in misses.values() for m in v]
    mean = sum(every) / len(every)
    print(f"\ntrack_camera on the kit: {track['registered']}/{track['frameCount']} frames, lens {track['lens']}, "
          f"k1 {track['distortion']['k1']}, reprojection {track['reprojectionPx']} px; static landmarks "
          f"{mean:.2f} px mean, {max(every):.2f} max over {len(every)}: "
          + ", ".join(f"{k} {sum(v) / len(v):.2f}" for k, v in misses.items()))
    assert mean < MAX_MEAN_PX, misses
