"""steps/media/track_pose.py: hand landmarks through a video.

Synthetic: the schema against the step's argparse, the refusals, how ids get
their handedness, the per-id smoothing, the output's shape, and the model
files (the mirror, and a converted file checked against its pin).

Real file (skips unless MONTAJ_TEST_S255_DIR names the kit folder holding
clip-sdr.mp4, a 540x960 phone clip of a hand entering from the frame's edge
and gripping an object, 7.5 s): the step at 10 fps finds the hand in at least
60 of 75 frames. The first run downloads the hand models (about 8 MB) into
~/.local/share/montaj/models/pose, so run it with HOME pointing at a scratch
home.

Parity (skips unless MONTAJ_TEST_HAND_REF also names a reference JSON): the
reference is MediaPipe 1.1.1's HandLandmarker in VIDEO mode, num_hands 1, the
three confidences at the same threshold, on the exact RGB frames this step
decodes (ffmpeg, fps=10, rgb24), each padded with a black border of 320 px.
Its JSON: {"threshold": t, "frames": [{"hands": [{"handedness": "Left" |
"Right", "landmarks": [[x, y, z] x 21] in source px, "world": [...]}]}]}.
Never commit one: it is derived from the kit.

Measured 2026-10-16 (Apple silicon, onnxruntime 1.31.0), threshold 0.2:
  - the same 62 of 75 frames found;
  - the first detection's landmarks 0.0 px from the reference's;
  - one step of the loop from the reference's own previous landmarks: 0.014 px
    mean, 0.23 max;
  - the whole run: 6.8 px mean, p95 21. The loop is chaotic on this clip: the
    same run with the first region moved by 0.001 px ends 5.3 px mean from
    itself, so whole-run agreement within 2 px would need bit-identical
    arithmetic. The test asserts the first three and prints the fourth.
"""
import importlib.util
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from tests.conftest import FFMPEG_BIN, HAS_FFMPEG, REPO_ROOT, assert_error, skip_or_fail

np = pytest.importorskip("numpy")

STEP = REPO_ROOT / "steps" / "media" / "track_pose.py"
SCHEMA = REPO_ROOT / "steps" / "media" / "track_pose.json"
KIT = os.environ.get("MONTAJ_TEST_S255_DIR")
REF = os.environ.get("MONTAJ_TEST_HAND_REF")


def _load_step():
    spec = importlib.util.spec_from_file_location("track_pose_step", STEP)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _run(*args, env=None):
    return subprocess.run([sys.executable, str(STEP), *args], capture_output=True, text=True,
                          env={**os.environ, **(env or {})})


# --- schema and refusals ----------------------------------------------------

def test_schema_matches_the_step_argparse():
    from tests.test_step_schema_conformance import _divergences, _introspect
    assert _divergences(json.loads(SCHEMA.read_text()), _introspect(STEP)) == []


def test_body_is_refused_for_now(tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    assert_error(_run("--input", str(video), "--kind", "body"), "unsupported_kind")


@pytest.mark.parametrize("args", [["--hands", "3"], ["--fps", "0"], ["--pad", "1.5"], ["--min-presence", "1"],
                                  ["--min-cutoff", "0"], ["--beta", "-1"]])
def test_bad_numbers_are_refused(tmp_path, args):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    assert_error(_run("--input", str(video), "--kind", "hand", *args), "invalid_args")


def test_a_missing_video_is_refused(tmp_path):
    assert_error(_run("--input", str(tmp_path / "none.mp4"), "--kind", "hand"), "file_not_found")


# --- handedness, smoothing, output ------------------------------------------

def _hand(hid, right, x):
    from lib.pose.hands import Hand
    lm = np.zeros((21, 3))
    lm[:, 0] = x + np.arange(21)
    lm[:, 1] = np.arange(21) * 2.0
    return Hand(hid, 0.9, right, lm, lm / 1000)


def test_each_id_is_labelled_by_its_mean_right_hand_score():
    step = _load_step()
    frames = [(0.0, [_hand(0, 0.9, 0), _hand(1, 0.2, 300)]),
              (0.1, [_hand(0, 0.3, 0), _hand(1, 0.7, 300)]),   # one-frame flips
              (0.2, [_hand(0, 0.8, 0)])]
    assert step.label_hands(frames) == {0: "right", 1: "left"}


def test_smoothing_is_per_id_and_starts_fresh_for_a_new_id():
    step = _load_step()
    frames = [(0.0, [_hand(0, 0.5, 0)]), (0.1, [_hand(0, 0.5, 40)]), (0.2, [_hand(1, 0.5, 40)])]
    out = step.smooth_hands(frames, 1.0, 5.0)
    assert out[0][1][0].landmarks[0, 0] == pytest.approx(0)           # the first value passes
    assert 0 < out[1][1][0].landmarks[0, 0] < 40                       # smoothed toward 40
    assert out[2][1][0].landmarks[0, 0] == pytest.approx(40)          # id 1 starts fresh
    assert out[1][1][0].world[0, 0] == pytest.approx(out[1][1][0].landmarks[0, 0] / 1000, rel=0.2)


def test_the_output_shape():
    step = _load_step()
    frames = [(0.0, []), (1 / 30, [_hand(3, 0.1, 5.123)])]
    out = step.result(frames, {3: "left"}, 30.0, (540, 960), {"palm": "p"})
    assert (out["kind"], out["fps"], out["frameCount"], out["size"], out["found"]) == ("hand", 30.0, 2, [540, 960], 1)
    h = out["frames"][1]["hands"][0]
    assert out["frames"][1]["t"] == 0.0333
    assert (h["id"], h["handedness"], h["score"]) == (3, "left", 0.9)
    assert len(h["landmarks"]) == len(h["world"]) == 21 and len(h["landmarks"][0]) == 3
    assert h["landmarks"][0] == [5.12, 0.0, 0.0]
    assert out["notes"] and out["model"] == {"palm": "p"}


# --- decoding ---------------------------------------------------------------

def test_frames_come_upright_at_the_asked_rate(tmp_path):
    if not HAS_FFMPEG:
        skip_or_fail("ffmpeg is required to make the clips")
    from lib.pose.video import frames, video_info
    flat, turned = tmp_path / "flat.mp4", tmp_path / "turned.mp4"
    subprocess.run([FFMPEG_BIN, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=30", "-t", "1",
                    "-pix_fmt", "yuv420p", str(flat)], check=True)
    # The same stream with a 90 degree rotation tag, as a phone writes one.
    subprocess.run([FFMPEG_BIN, "-v", "error", "-y", "-display_rotation", "90", "-i", str(flat), "-c", "copy",
                    str(turned)], check=True)
    assert video_info(str(flat)) == (64, 48, 30.0)
    assert video_info(str(turned)) == (48, 64, 30.0)
    a = list(frames(str(flat), 10.0, 64, 48))
    b = list(frames(str(turned), 10.0, 48, 64))
    assert len(a) == len(b) == 10
    assert a[0].shape == (48, 64, 3) and b[0].shape == (64, 48, 3)
    assert all(np.array_equal(np.rot90(x), y) for x, y in zip(a, b))


# --- model files ------------------------------------------------------------

def test_the_mirror_serves_the_same_file_names(monkeypatch):
    from lib.pose import weights
    monkeypatch.delenv(weights.MIRROR_ENV, raising=False)
    assert weights.url(weights.HAND_BUNDLE).startswith("https://storage.googleapis.com/mediapipe-models/")
    monkeypatch.setenv(weights.MIRROR_ENV, "https://assets.example/models/")
    assert weights.url(weights.HAND_BUNDLE) == "https://assets.example/models/pose/hand_landmarker.task"


def test_a_converted_model_is_written_once_and_checked_against_its_pin(tmp_path, monkeypatch):
    import hashlib
    from lib import models
    from lib.pose import weights
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    bundle = tmp_path / "bundle.task"
    with zipfile.ZipFile(bundle, "w") as z:
        z.writestr("m.tflite", b"tflite bytes")
    calls = []

    def convert(data):
        calls.append(data)
        return b"onnx:" + data

    item = weights.Converted("m.tflite", "m.v1.onnx", hashlib.sha256(b"onnx:tflite bytes").hexdigest())
    path = weights.converted(str(bundle), item, convert)
    assert Path(path).read_bytes() == b"onnx:tflite bytes"
    assert weights.converted(str(bundle), item, convert) == path
    assert len(calls) == 1                                        # cached
    Path(path).write_bytes(b"damaged")
    weights.converted(str(bundle), item, convert)
    assert len(calls) == 2 and Path(path).read_bytes() == b"onnx:tflite bytes"
    with pytest.raises(ValueError, match="pinned"):
        weights.converted(str(bundle), item._replace(filename="n.onnx", sha256="0" * 64), convert)
    assert not (tmp_path / "pose" / "n.onnx").exists()


# --- the real clip ----------------------------------------------------------

needs_kit = pytest.mark.skipif(not KIT, reason="MONTAJ_TEST_S255_DIR is not set")


@pytest.fixture(scope="module")
def clip():
    return str(Path(KIT) / "clip-sdr.mp4")


@needs_kit
def test_the_hand_is_found_in_60_of_75_frames(clip, tmp_path):
    out = tmp_path / "hands.json"
    proc = _run("--input", clip, "--kind", "hand", "--fps", "10", "--out", str(out),
                env={"OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS", "1")})
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert proc.stdout.strip() == str(out)
    data = json.loads(out.read_text())
    assert (data["frameCount"], data["size"], data["fps"]) == (75, [540, 960], 10.0)
    print(f"\nfound {data['found']} of 75")
    assert data["found"] >= 60
    ids = {h["id"] for f in data["frames"] for h in f["hands"]}
    labels = {h["handedness"] for f in data["frames"] for h in f["hands"]}
    assert len(ids) == 1 and labels == {"left"}


@needs_kit
@pytest.mark.skipif(not REF, reason="MONTAJ_TEST_HAND_REF is not set")
def test_parity_with_the_reference(clip, tmp_path):
    from lib.pose import hands as H, weights
    from lib.pose.video import frames
    ref = json.loads(Path(REF).read_text())
    thr = ref["threshold"]
    out = tmp_path / "raw.json"
    proc = _run("--input", clip, "--kind", "hand", "--fps", "10", "--pad", "0.3333", "--min-presence", str(thr),
                "--smooth", "none", "--out", str(out),
                env={"OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS", "1")})
    assert proc.returncode == 0, proc.stderr[-2000:]
    ours = json.loads(out.read_text())["frames"]
    theirs = ref["frames"]
    found_o = {i for i, f in enumerate(ours) if f["hands"]}
    found_r = {i for i, f in enumerate(theirs) if f["hands"]}
    assert len(found_o ^ found_r) <= 2, (sorted(found_o - found_r), sorted(found_r - found_o))

    def lm(f):
        return np.array(f["hands"][0]["landmarks"])

    both = sorted(found_o & found_r)
    d = np.array([np.linalg.norm(lm(ours[i])[:, :2] - lm(theirs[i])[:, :2], axis=1) for i in both])
    print(f"\nwhole run, {len(both)} frames both found: mean {d.mean():.2f} px, p95 {np.percentile(d, 95):.2f}, "
          f"max {d.max():.2f}")
    # The first detection: the palm detector, the palm's region and one crop.
    first = min(found_r)
    assert first in found_o
    assert np.linalg.norm(lm(ours[first])[:, :2] - lm(theirs[first])[:, :2], axis=1).mean() < 1.0

    # One step of the loop from the reference's own previous landmarks.
    palm_path, hand_path = weights.hand_models()
    _, hand_model = H.onnx_models(palm_path, hand_path, threads=1)
    images = list(frames(clip, 10.0, 540, 960))
    steps = []
    for i in range(1, len(theirs)):
        if theirs[i]["hands"] and theirs[i - 1]["hands"]:
            got, *_ = H.hand_landmarks(hand_model, images[i], H.landmarks_rect(lm(theirs[i - 1])))
            steps.append(np.linalg.norm(got[:, :2] - lm(theirs[i])[:, :2], axis=1))
    steps = np.array(steps)
    print(f"one step, {len(steps)} frames: mean {steps.mean():.3f} px, max {steps.max():.3f}")
    assert steps.mean() < 0.5 and steps.max() < 2.0
