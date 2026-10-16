"""steps/media/track_pose.py: hand and body landmarks through a video.

Synthetic: the schema against the step's argparse, the refusals, how ids get
their handedness, the per-id smoothing, the output's shape for both kinds, and
the model files (the mirror, and a converted file checked against its pin).

Real file (skips unless MONTAJ_TEST_S255_DIR names the kit folder holding
clip-sdr.mp4, a 540x960 phone clip of a hand entering from the frame's edge
and gripping an object, 7.5 s): the step at 10 fps finds the hand in at least
60 of 75 frames. The first run downloads the hand models (about 8 MB) into
~/.local/share/montaj/models/pose, so run it with HOME pointing at a scratch
home.

Parity (skips unless MONTAJ_TEST_HAND_REF also names a reference JSON): the
reference is MediaPipe 1.1.1's HandLandmarker in VIDEO mode, num_hands 1, the
three confidences at the same threshold, on the exact RGB frames this step
decodes (lib/frame_sampling's filter at 10 fps, rgb24), each padded with a
black border of 320 px.
Its JSON: {"threshold": t, "frames": [{"hands": [{"handedness": "Left" |
"Right", "landmarks": [[x, y, z] x 21] in source px, "world": [...]}]}]}.
Never commit one: it is derived from the kit.

Measured 2026-10-17 (Apple silicon, onnxruntime 1.31.0), threshold 0.2, with
lib/frame_sampling's filter:
  - the same 63 of 75 frames found;
  - both detections (frame 0, then 1.3 s on after the hand is lost) 0.0 px
    from the reference's;
  - one step of the loop from the reference's own previous landmarks: 0.008 px
    mean, 0.23 max;
  - the whole run: 6.8 px mean, p95 19. The loop is chaotic on this clip: the
    same run with the first region moved by 0.001 px ends 5.3 px mean from
    itself, so whole-run agreement within 2 px would need bit-identical
    arithmetic. The test asserts the first three and prints the fourth.

Body, real file (skips unless MONTAJ_TEST_BODY_CLIP names a clip of one
person filmed whole, e.g. a public-domain or CC0 one kept outside git): the
person is found in every frame under one id, and smoothing cuts the jitter.
The first run downloads the pose models (about 9 MB), so again a scratch HOME.

Body parity (skips unless MONTAJ_TEST_BODY_REF also names a reference JSON):
MediaPipe 1.1.1's PoseLandmarker in VIDEO mode, num_poses 1, the three
confidences at one threshold, on the exact RGB frames this step decodes
(ffmpeg, fps as the reference says, rgb24), with its timestamps 10^7 ms apart
from 10^7 so that its own landmark smoothing all but switches off and its raw
landmarks come out. Its JSON: {"threshold": t, "fps": f, "frames": [{"people":
[{"landmarks": [[x, y, z, visibility] x 33] in source px, "world": [...]}]}]},
the whole clip through one landmarker, and "pairs": [{"k", "first", "next"}],
for every few frames k a fresh landmarker given frames k and k + 1 only, so
"first" is a fresh detection and "next" one step of its loop (the body loop
tracks from two alignment landmarks the reference does not return, so a step
from its own previous output can only be taken this way). Never commit one.

Measured 2026-10-16 (Apple silicon, onnxruntime 1.31.0) on a 540x960, 30 fps,
7.5 s clip of a golfer's swing filmed whole, threshold 0.5:
  - the same 225 of 225 frames found;
  - 75 fresh detections: 0.014 px mean from the reference's (0.003 at frame 0);
  - one step of the loop from each: 0.072 px mean, 0.45 for the worst frame;
  - the whole run: 2.3 px mean, p95 4.8, the loop as chaotic as the hand's.
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
BODY_CLIP = os.environ.get("MONTAJ_TEST_BODY_CLIP")
BODY_REF = os.environ.get("MONTAJ_TEST_BODY_REF")


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


def test_more_than_one_person_is_refused(tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    assert_error(_run("--input", str(video), "--kind", "body", "--people", "2"), "invalid_param")


def test_the_border_defaults_by_kind():
    step = _load_step()
    for kind, pad in (("hand", 0.3333), ("body", 0.0)):
        args = step._parse(["--input", "v.mp4", "--kind", kind])
        step._check(args)
        assert args.pad == pad
    args = step._parse(["--input", "v.mp4", "--kind", "body", "--pad", "0.2"])
    step._check(args)
    assert args.pad == 0.2


@pytest.mark.parametrize("args", [["--hands", "3"], ["--max-frames", "0"], ["--fps", "0"], ["--pad", "1.5"], ["--min-presence", "1"],
                                  ["--min-cutoff", "0"], ["--beta", "-1"]])
def test_bad_numbers_are_refused(tmp_path, args):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"x")
    assert_error(_run("--input", str(video), "--kind", "hand", *args), "invalid_param")


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
    out = step.smooth(frames, 1.0, 5.0)
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
    flat_info, turned_info = video_info(str(flat)), video_info(str(turned))
    assert flat_info[:3] == (64, 48, 30.0) and turned_info[:3] == (48, 64, 30.0)
    assert flat_info.duration == pytest.approx(1.0, abs=0.05)
    a = list(frames(str(flat), 10.0, flat_info))
    b = list(frames(str(turned), 10.0, turned_info))
    assert len(a) == len(b) == 10
    assert a[0].shape == (48, 64, 3) and b[0].shape == (64, 48, 3)
    assert all(np.array_equal(np.rot90(x), y) for x, y in zip(a, b))


# --- model files ------------------------------------------------------------

def test_the_mirror_serves_the_same_file_names(monkeypatch):
    from lib.pose import weights
    monkeypatch.delenv(weights.MIRROR_ENV, raising=False)
    assert weights.url(weights.HAND_BUNDLE).startswith("https://storage.googleapis.com/mediapipe-models/")
    for base, want in [("https://assets.example/models/", "https://assets.example/models"),
                       ("http://localhost:8765", "http://localhost:8765"),
                       ("http://127.0.0.1:9/m", "http://127.0.0.1:9/m")]:
        monkeypatch.setenv(weights.MIRROR_ENV, base)
        assert weights.url(weights.HAND_BUNDLE) == f"{want}/pose/hand_landmarker.task"


@pytest.mark.parametrize("base", ["file:///tmp/models", "/tmp/models", "http://assets.example/models",
                                  "ftp://localhost/m", "https://", "localhost:8000"])
def test_any_other_mirror_is_refused(monkeypatch, base):
    from lib.pose import weights
    monkeypatch.setenv(weights.MIRROR_ENV, base)
    with pytest.raises(weights.MirrorError, match="https://"):
        weights.url(weights.HAND_BUNDLE)


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


def test_a_bad_bundle_raises_a_conversion_error(tmp_path, monkeypatch):
    from lib import models
    from lib.pose import weights
    from lib.pose.tflite import ConversionError
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    truncated = tmp_path / "truncated.task"
    with zipfile.ZipFile(truncated, "w") as z:
        z.writestr(weights.PALM.member, b"TFL3" + bytes(20))
    with pytest.raises(ConversionError, match="not a TFLite model"):
        weights.converted(str(truncated), weights.PALM, weights.convert)
    with pytest.raises(ConversionError, match="no readable"):
        weights.converted(str(truncated), weights.HAND_LANDMARKS, weights.convert)   # member missing
    not_zip = tmp_path / "not.task"
    not_zip.write_bytes(b"garbage")
    with pytest.raises(ConversionError, match="no readable"):
        weights.converted(str(not_zip), weights.PALM, weights.convert)
    assert not (tmp_path / "pose").exists() or not any((tmp_path / "pose").iterdir())


def test_a_failed_write_leaves_no_part_file(tmp_path, monkeypatch):
    import hashlib
    from lib import models
    from lib.pose import weights
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    bundle = tmp_path / "bundle.task"
    with zipfile.ZipFile(bundle, "w") as z:
        z.writestr("m.tflite", b"x")
    item = weights.Converted("m.tflite", "m.v1.onnx", hashlib.sha256(b"y").hexdigest())

    def no_room(src, dst):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(weights.os, "replace", no_room)
    with pytest.raises(OSError):
        weights.converted(str(bundle), item, lambda data: b"y")
    assert list((tmp_path / "pose").iterdir()) == []


@pytest.fixture
def step_main(tmp_path, monkeypatch):
    """The step's main() in this process, its video probe and models replaced."""
    pytest.importorskip("onnxruntime")
    from lib.pose import video, weights
    video_path = tmp_path / "v.mp4"
    video_path.write_bytes(b"x")
    monkeypatch.setattr(video, "video_info", lambda path: video.VideoInfo(64, 48, 30.0, 1.0, "bt709"))
    step = _load_step()

    def run(error):
        def hand_models():
            raise error
        monkeypatch.setattr(weights, "hand_models", hand_models)
        with pytest.raises(SystemExit):
            step.main(["--input", str(video_path), "--kind", "hand"])
    return run


def test_a_model_that_will_not_convert_fails_cleanly(step_main, capsys):
    from lib.pose.tflite import ConversionError
    step_main(ConversionError("not a TFLite model this converter reads"))
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "model_conversion_failed"
    assert "Delete" in err["message"] and "pose" in err["message"]


def test_a_bad_mirror_fails_cleanly(step_main, capsys):
    from lib.pose import weights
    step_main(weights.MirrorError("MONTAJ_MODEL_MIRROR must be an https:// URL"))
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "invalid_model_mirror"


def test_a_converter_mismatch_asks_for_a_report_not_a_retry(step_main, capsys):
    from lib.pose import weights
    step_main(weights.ConversionMismatch("converting x gave a file that is not the pinned x.onnx"))
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "model_conversion_mismatch"
    assert "report" in err["message"] and "Delete" not in err["message"]


def test_a_mismatched_conversion_raises_the_mismatch(tmp_path, monkeypatch):
    from lib import models
    from lib.pose import weights
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    bundle = tmp_path / "bundle.task"
    with zipfile.ZipFile(bundle, "w") as z:
        z.writestr("m.tflite", b"x")
    with pytest.raises(weights.ConversionMismatch):
        weights.converted(str(bundle), weights.Converted("m.tflite", "m.onnx", "0" * 64), lambda data: b"y")


def test_a_converted_file_goes_through_a_temporary_file_of_its_own(tmp_path, monkeypatch):
    import hashlib
    from lib import models
    from lib.pose import weights
    monkeypatch.setattr(models, "MONTAJ_MODELS_DIR", str(tmp_path))
    bundle = tmp_path / "bundle.task"
    with zipfile.ZipFile(bundle, "w") as z:
        z.writestr("m.tflite", b"x")
    item = weights.Converted("m.tflite", "m.v1.onnx", hashlib.sha256(b"y").hexdigest())
    seen = []
    real_replace = os.replace

    def replace(src, dst):
        seen.append(src)
        real_replace(src, dst)

    monkeypatch.setattr(weights.os, "replace", replace)
    dest = weights.converted(str(bundle), item, lambda data: b"y")
    os.remove(dest)
    weights.converted(str(bundle), item, lambda data: b"y")
    assert len(seen) == 2 and seen[0] != seen[1]
    assert all(Path(p).parent == Path(dest).parent and p != dest + ".part" for p in seen)
    assert oct(os.stat(dest).st_mode & 0o777) == oct(0o644)


# --- sampling, the frame cap and writing --------------------------------------

def _args(**kw):
    step = _load_step()
    args = step._parse(["--input", "x", "--kind", "hand", *sum(([f"--{k.replace('_', '-')}", str(v)]
                                                               for k, v in kw.items()), [])])
    step._check(args)
    return step, args


def test_the_fps_defaults_to_the_clip_capped_at_30_and_never_above_the_clip():
    from lib.pose.video import VideoInfo
    step, args = _args()
    assert step.sampling(args, VideoInfo(64, 48, 60.0, 2.0, "bt709")) == (30.0, [])
    assert step.sampling(args, VideoInfo(64, 48, 24.0, 2.0, "bt709")) == (24.0, [])
    step, args = _args(fps=60)
    fps, notes = step.sampling(args, VideoInfo(64, 48, 24.0, 2.0, None))
    assert fps == 24.0 and notes == ["Sampled at the clip's own 24 fps, not 60."]


def test_a_clip_over_max_frames_is_refused_before_decoding(capsys):
    from lib.pose.video import VideoInfo
    step, args = _args(fps=10)
    assert step.sampling(args, VideoInfo(64, 48, 30.0, 30.0, None))[0] == 10     # 300 frames: the cap
    with pytest.raises(SystemExit):
        step.sampling(args, VideoInfo(64, 48, 30.0, 30.05, None))               # 301
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "too_many_frames" and "301 frames" in err["message"]
    step, args = _args(fps=10, max_frames=1000)
    assert step.sampling(args, VideoInfo(64, 48, 30.0, 30.05, None))[0] == 10


def test_an_hdr_clip_says_it_was_tone_mapped():
    from lib.pose.video import VideoInfo
    step, args = _args()
    assert step.sampling(args, VideoInfo(64, 48, 30.0, 1.0, "arib-std-b67"))[1] == [
        "The clip is HDR; its frames were tone-mapped to SDR for the models."]


def test_an_unwritable_out_fails_as_write_error(tmp_path, capsys):
    step = _load_step()
    blocker = tmp_path / "file"
    blocker.write_text("x")
    with pytest.raises(SystemExit):
        step.emit("{}", str(blocker / "sub" / "out.json"))
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "write_error"
    step.emit("{}", str(tmp_path / "ok" / "out.json"))
    assert (tmp_path / "ok" / "out.json").read_text() == "{}"


def test_the_world_notes_name_the_axes():
    step = _load_step()
    for notes in (step.HAND_NOTES, step.BODY_NOTES):
        assert any("x right, y down, z away from the camera" in n for n in notes)


@pytest.mark.skipif(sys.platform == "win32", reason="the stand-in ffmpeg is a script with a #! line")
@pytest.mark.timeout(60)
def test_a_flood_of_ffmpeg_errors_cannot_stall_decoding(tmp_path, monkeypatch, capsys):
    """An ffmpeg that writes 1 MB of errors before its first frame: with stderr
    on an unread pipe it would block, and so would the reader."""
    from lib.pose import video
    fake = tmp_path / "ffmpeg"
    fake.write_text(f"#!{sys.executable}\n"
                    "import sys\n"
                    "sys.stderr.write('e' * (1 << 20) + '\\nlast line\\n'); sys.stderr.flush()\n"
                    "sys.stdout.buffer.write(bytes(4 * 2 * 3)); sys.stdout.flush()\n"
                    "sys.exit(1)\n")
    fake.chmod(0o755)
    monkeypatch.setattr(video, "ffmpeg_bin", lambda: str(fake))
    info = video.VideoInfo(4, 2, 30.0, 1.0, None)
    got = []
    with pytest.raises(SystemExit):
        for f in video.frames("clip.mp4", 10.0, info):
            got.append(f)
    assert len(got) == 1
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "decode_failed" and "last line" in err["message"]


def test_more_frames_than_the_limit_stop_the_decoder(tmp_path, monkeypatch, capsys):
    if not HAS_FFMPEG:
        skip_or_fail("ffmpeg is required to make the clip")
    from lib.pose import video
    clip = tmp_path / "c.mp4"
    subprocess.run([FFMPEG_BIN, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=32x32:rate=30", "-t", "1",
                    "-pix_fmt", "yuv420p", str(clip)], check=True)
    info = video.video_info(str(clip))
    assert len(list(video.frames(str(clip), 10.0, info, limit=10))) == 10
    with pytest.raises(SystemExit):
        list(video.frames(str(clip), 10.0, info, limit=9))
    assert json.loads(capsys.readouterr().err.strip().splitlines()[-1])["error"] == "too_many_frames"


def test_non_finite_hands_are_dropped_and_listed():
    step = _load_step()
    bad = _hand(1, 0.5, 0)
    bad.landmarks[3, 0] = np.nan
    worse = _hand(2, 0.5, 0)._replace(score=float("inf"))
    frames = [(0.0, [_hand(0, 0.5, 0), bad]), (0.1, [worse])]
    kept, dropped = step.drop_nonfinite(frames)
    assert [[h.id for h in hs] for _, hs in kept] == [[0], []]
    assert dropped == [{"t": 0.0, "id": 1}, {"t": 0.1, "id": 2}]
    out = step.result(kept, {0: "left"}, 10.0, (540, 960), {}, dropped)
    assert out["dropped"] == dropped and out["found"] == 1
    assert "dropped" in out["notes"][-1]
    json.dumps(out, allow_nan=False)
    assert "dropped" not in step.result(kept, {0: "left"}, 10.0, (540, 960), {})


def _person(pid, x):
    from lib.pose.body import Person
    lm = np.zeros((33, 3))
    lm[:, 0] = x + np.arange(33)
    lm[:, 1] = np.arange(33) * 3.0
    lm[:, 2] = -np.arange(33) * 0.5
    return Person(pid, 0.98, lm, np.linspace(0, 1, 33), lm / 1000)


def test_the_body_output_shape():
    step = _load_step()
    frames = [(0.0, []), (1 / 30, [_person(0, 5.123)])]
    out = step.result(frames, {}, 30.0, (540, 960), {"detector": "d"}, kind="body")
    assert (out["kind"], out["fps"], out["frameCount"], out["size"], out["found"]) == ("body", 30.0, 2, [540, 960], 1)
    assert out["frames"][0] == {"t": 0.0, "people": []}
    p = out["frames"][1]["people"][0]
    assert set(p) == {"id", "score", "landmarks", "world"}
    assert (p["id"], p["score"]) == (0, 0.98)
    assert len(p["landmarks"]) == len(p["world"]) == 33
    assert p["landmarks"][0] == [5.12, 0.0, -0.0, 0.0]
    assert p["landmarks"][32] == [37.12, 96.0, -16.0, 1.0]
    assert len(p["world"][0]) == 3
    assert out["notes"] == step.BODY_NOTES and out["model"] == {"detector": "d"}


def test_body_smoothing_leaves_visibility_raw():
    step = _load_step()
    a, b = _person(0, 0), _person(0, 40)
    b = b._replace(visibility=np.full(33, 0.2))
    out = step.smooth([(0.0, [a]), (0.1, [b])], 1.0, 5.0)
    assert 0 < out[1][1][0].landmarks[0, 0] < 40
    assert np.array_equal(out[1][1][0].visibility, np.full(33, 0.2))


def test_non_finite_people_are_dropped_and_listed():
    step = _load_step()
    bad = _person(1, 0)
    bad.visibility[4] = np.nan
    kept, dropped = step.drop_nonfinite([(0.0, [_person(0, 0)]), (0.1, [bad])])
    assert [[p.id for p in ps] for _, ps in kept] == [[0], []]
    assert dropped == [{"t": 0.1, "id": 1}]
    out = step.result(kept, {}, 10.0, (540, 960), {}, dropped, kind="body")
    assert "people had non-finite values" in out["notes"][-1]
    json.dumps(out, allow_nan=False)


def test_a_body_model_that_will_not_convert_fails_cleanly(tmp_path, monkeypatch, capsys):
    pytest.importorskip("onnxruntime")
    from lib.pose import video, weights
    from lib.pose.tflite import ConversionError
    video_path = tmp_path / "v.mp4"
    video_path.write_bytes(b"x")
    monkeypatch.setattr(video, "video_info", lambda path: video.VideoInfo(64, 48, 30.0, 1.0, "bt709"))

    def body_models():
        raise ConversionError("not a TFLite model this converter reads")

    monkeypatch.setattr(weights, "body_models", body_models)
    with pytest.raises(SystemExit):
        _load_step().main(["--input", str(video_path), "--kind", "body"])
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err["error"] == "model_conversion_failed"
    assert "body models" in err["message"]


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
    # The hand shows in frame 0, is lost for 1.2 s and found again (as the
    # reference also does): the long track is the one that counts.
    tracks = {}
    for f in data["frames"]:
        for h in f["hands"]:
            tracks.setdefault(h["id"], []).append(h["handedness"])
    longest = max(tracks.values(), key=len)
    assert len(longest) >= 60 and set(longest) == {"left"}


@needs_kit
@pytest.mark.skipif(not REF, reason="MONTAJ_TEST_HAND_REF is not set")
def test_parity_with_the_reference(clip, tmp_path):
    from lib.pose import hands as H, weights
    from lib.pose.video import frames, video_info
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
    images = list(frames(clip, 10.0, video_info(clip)))
    steps = []
    for i in range(1, len(theirs)):
        if theirs[i]["hands"] and theirs[i - 1]["hands"]:
            got, *_ = H.hand_landmarks(hand_model, images[i], H.landmarks_rect(lm(theirs[i - 1])))
            steps.append(np.linalg.norm(got[:, :2] - lm(theirs[i])[:, :2], axis=1))
    steps = np.array(steps)
    print(f"one step, {len(steps)} frames: mean {steps.mean():.3f} px, max {steps.max():.3f}")
    assert steps.mean() < 0.5 and steps.max() < 2.0


# --- the body clip -----------------------------------------------------------

needs_body_clip = pytest.mark.skipif(not BODY_CLIP, reason="MONTAJ_TEST_BODY_CLIP is not set")


def _body_run(tmp_path, name, *args):
    out = tmp_path / f"{name}.json"
    proc = _run("--input", BODY_CLIP, "--kind", "body", *args, "--out", str(out),
                env={"OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS", "1")})
    assert proc.returncode == 0, proc.stderr[-2000:]
    return json.loads(out.read_text())


def _jitter(data):
    """Mean |second difference| of the landmarks, px."""
    lm = np.array([f["people"][0]["landmarks"] for f in data["frames"]])[:, :, :2]
    return float(np.linalg.norm(lm[2:] - 2 * lm[1:-1] + lm[:-2], axis=2).mean())


@needs_body_clip
def test_the_person_is_found_in_every_frame(tmp_path):
    data = _body_run(tmp_path, "smooth")
    raw = _body_run(tmp_path, "raw", "--smooth", "none")
    assert data["kind"] == "body" and data["found"] == data["frameCount"] > 0
    assert {p["id"] for f in data["frames"] for p in f["people"]} == {0}
    vis = np.array([f["people"][0]["landmarks"] for f in data["frames"]])[:, :, 3]
    assert ((0 <= vis) & (vis <= 1)).all()
    print(f"\nfound {data['found']} of {data['frameCount']}; jitter {_jitter(raw):.2f} px raw, "
          f"{_jitter(data):.2f} smoothed")
    assert _jitter(data) < _jitter(raw) / 2


@needs_body_clip
@pytest.mark.skipif(not BODY_REF, reason="MONTAJ_TEST_BODY_REF is not set")
def test_body_parity_with_the_reference(tmp_path):
    from lib.pose import body as B, weights
    from lib.pose.video import frames, video_info
    ref = json.loads(Path(BODY_REF).read_text())
    thr, fps = ref["threshold"], ref["fps"]
    ours = _body_run(tmp_path, "raw", "--fps", str(fps), "--pad", "0", "--min-presence", str(thr),
                     "--smooth", "none")["frames"]
    theirs = ref["frames"]
    found_o = {i for i, f in enumerate(ours) if f["people"]}
    found_r = {i for i, f in enumerate(theirs) if f["people"]}
    assert len(found_o ^ found_r) <= 2, (sorted(found_o - found_r), sorted(found_r - found_o))

    def lm(people):
        return np.array(people[0]["landmarks"])[:, :2]

    both = sorted(found_o & found_r)
    d = np.array([np.linalg.norm(lm(ours[i]["people"]) - lm(theirs[i]["people"]), axis=1) for i in both])
    print(f"\nwhole run, {len(both)} frames both found: mean {d.mean():.2f} px, p95 {np.percentile(d, 95):.2f}, "
          f"max {d.max():.2f}")
    first = min(found_r)
    assert first in found_o
    assert np.linalg.norm(lm(ours[first]["people"]) - lm(theirs[first]["people"]), axis=1).mean() < 1.0

    # Fresh detections, and one step of the loop from each.
    detector_path, landmark_path = weights.body_models()
    detector, landmark_model = B.onnx_models(detector_path, landmark_path, threads=1)
    images = list(frames(BODY_CLIP, fps, video_info(BODY_CLIP)))
    firsts, steps = [], []
    for pair in ref["pairs"]:
        if not (pair["first"] and pair["next"]):
            continue
        tracker = B.PoseTracker(detector, landmark_model, min_presence=thr)
        a, b = tracker(images[pair["k"]]), tracker(images[pair["k"] + 1])
        assert a and b, pair["k"]
        firsts.append(np.linalg.norm(a[0].landmarks[:, :2] - lm(pair["first"]), axis=1).mean())
        steps.append(np.linalg.norm(b[0].landmarks[:, :2] - lm(pair["next"]), axis=1).mean())
    print(f"{len(firsts)} fresh detections: mean {np.mean(firsts):.3f} px, worst {np.max(firsts):.3f}; "
          f"one step: mean {np.mean(steps):.3f} px, worst {np.max(steps):.3f}")
    assert np.mean(firsts) < 0.1 and np.max(firsts) < 1.0
    assert np.mean(steps) < 0.5
