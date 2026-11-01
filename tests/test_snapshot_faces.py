"""snapshot's `faces`: the head box rule, the scaling to source pixels, the per-clip summary, the answer shape."""
import importlib.util, json, os, subprocess, sys

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from lib.pose import head  # noqa: E402
from lib.common import ffmpeg_bin  # noqa: E402


def _lm(**pts):
    """33 landmarks and visibilities; pts maps an index to (x, y), the rest are unseen."""
    lm, vis = np.zeros((33, 3)), np.zeros(33)
    for i, (x, y) in pts.items():
        lm[int(i[1:])] = (x, y, 0)
        vis[int(i[1:])] = 0.9
    return lm, vis


# a frontal face: eyes y=100 at x 90 / 110, ears x 80 / 120, mouth y=130
FRONT = dict(l1=(95, 100), l2=(90, 100), l3=(85, 100), l4=(105, 100), l5=(110, 100), l6=(115, 100),
             l7=(80, 105), l8=(120, 105), l9=(95, 130), l10=(105, 130))


def test_head_box_with_both_ears():
    lm, vis = _lm(**{k.replace("l", "p"): v for k, v in FRONT.items()})
    x, y, w, h = head.head_box(lm, vis, 400, 400)
    # across: ears 80..120 (width 40) and a tenth of it each side; top: eyes 100 - 40; bottom: mouth 130 + 20
    assert (x, y, w, h) == (76, 60, 48, 90)


def test_head_box_profile_uses_twice_the_eye_span():
    lm, vis = _lm(p1=(100, 100), p2=(96, 100), p3=(92, 100), p7=(70, 104), p9=(98, 130))
    x, y, w, h = head.head_box(lm, vis, 400, 400)
    # eye span 8, width 16; landmarks span 70..100 already wider, so across is that plus 1.6 each side; vertical uses 16
    assert (x, w) == pytest.approx((68.4, 33.2)) and y == 100 - 16 and y + h == 130 + 8


def test_head_box_profile_widens_to_twice_the_eye_span():
    lm, vis = _lm(p1=(100, 100), p3=(110, 100), p9=(105, 130))
    x, y, w, h = head.head_box(lm, vis, 400, 400)
    assert w == 24 and x == 93 and y == 80


def test_head_box_nothing_visible_or_unsizable():
    lm, vis = _lm()
    assert head.head_box(lm, vis, 400, 400) is None
    lm, vis = _lm(p2=(100, 100))          # one eye, no ears: no width
    assert head.head_box(lm, vis, 400, 400) is None


def test_head_box_ignores_low_visibility_and_clamps():
    lm, vis = _lm(**{k.replace("l", "p"): v for k, v in FRONT.items()})
    vis[7] = 0.2                           # one ear lost: a profile now, width 2 * eye span (30)
    x, y, w, h = head.head_box(lm, vis, 400, 400)
    assert w == 72     # eyes span 85..115, so twice that (60), plus a tenth each side
    lm, vis = _lm(**{k.replace("l", "p"): (v[0], v[1] - 90) for k, v in FRONT.items()})
    assert head.head_box(lm, vis, 400, 400)[1] == 0     # the hair above the frame is clamped


def test_scale_box_to_source_pixels():
    assert head.scale_box((80, 60.4, 40, 90), 3) == (240, 181, 120, 270)


def test_summarize_median_range_seen():
    s = head.summarize([(1.0, (10, 20, 30, 40)), (2.0, None), (3.0, (14, 24, 30, 40)), (4.0, (12, 22, 36, 40))],
                       (1920, 1080))
    assert s["size"] == [1920, 1080] and s["seen"] == "3/4"
    assert s["at"] == [[1.0, 10, 20, 30, 40], [2.0, None], [3.0, 14, 24, 30, 40], [4.0, 12, 22, 36, 40]]
    assert s["box"] == [12, 22, 30, 40]
    assert s["range"] == [10, 20, 48, 64]
    assert "note" not in s


def test_summarize_none_seen():
    s = head.summarize([(1.0, None), (2.0, None)], (640, 360))
    assert s["box"] is None and s["range"] is None and s["seen"] == "0/2" and s["note"]


class _FakeBody:
    """Stands in for lib.pose.body: every frame has the FRONT face."""
    class PoseTracker:
        def __init__(self, *models):
            pass

        def __call__(self, frame):
            lm, vis = _lm(**{k.replace("l", "p"): v for k, v in FRONT.items()})
            return [type("P", (), {"landmarks": lm, "visibility": vis})()]

    @staticmethod
    def onnx_models(*a):
        return ("d", "l")


def _clip(tmp_path, w=640, h=360):
    p = str(tmp_path / "clip.mp4")
    subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={w}x{h}:rate=10:duration=2",
                    "-pix_fmt", "yuv420p", p], check=True)
    return p


def test_clip_faces_scales_decode_box_to_source(tmp_path, monkeypatch):
    from lib.pose import body, weights
    monkeypatch.setattr(body, "onnx_models", _FakeBody.onnx_models)
    monkeypatch.setattr(body, "PoseTracker", _FakeBody.PoseTracker)
    monkeypatch.setattr(weights, "body_models", lambda: ("a", "b"))
    out = head.clip_faces(_clip(tmp_path), [0.5, 1.0])   # 640 wide decoded at 360: x1.7778
    assert out["size"] == [640, 360] and out["seen"] == "2/2"
    assert out["box"] == [135, 107, 85, 160]             # (76, 60, 48, 90) * 640/360
    assert out["at"][0][0] == 0.5 and out["range"] == [135, 107, 220, 267]


def test_clip_faces_no_model_or_no_decode_is_a_note(tmp_path, monkeypatch):
    from lib.pose import weights
    def boom():
        raise RuntimeError("no model")
    monkeypatch.setattr(weights, "body_models", boom)
    out = head.clip_faces(_clip(tmp_path), [0.5])
    assert out["box"] is None and "unavailable" in out["note"]
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"not a video")
    assert head.clip_faces(str(bad), [0.5])["box"] is None


def _snapshot(argv, capsys, monkeypatch):
    spec = importlib.util.spec_from_file_location("snapshot_step", os.path.join(ROOT, "steps/media/snapshot.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(sys, "argv", ["snapshot.py", *argv])
    mod.main()
    return capsys.readouterr().out.strip()


def test_answer_shape_faces_on_and_off(tmp_path, monkeypatch, capsys):
    from lib.pose import weights
    monkeypatch.setattr(weights, "body_models", lambda: (_ for _ in ()).throw(RuntimeError("no model")))
    clip = _clip(tmp_path)
    off = _snapshot(["--inputs", clip, "--names", "A", "--cols", "2", "--out", str(tmp_path / "off.jpg")],
                    capsys, monkeypatch)
    assert off == str(tmp_path / "off.jpg")                       # faces off: the bare path, as before
    on = json.loads(_snapshot(["--inputs", clip, "--names", "A", "--cols", "2", "--faces",
                               "--out", str(tmp_path / "on.jpg")], capsys, monkeypatch))
    assert os.path.getsize(on["path"]) > 0 and set(on["faces"]) == {"A"}   # keyed by the name; sheet made anyway
    assert on["faces"]["A"]["box"] is None and on["faces"]["A"]["note"]
    at = json.loads(_snapshot(["--input", clip, "--at", "0.5", "--at", "1.5", "--faces",
                               "--out", str(tmp_path / "at.jpg")], capsys, monkeypatch))
    assert list(at["faces"]) == [clip]
    grid = json.loads(_snapshot(["--input", clip, "--cols", "2", "--rows", "1", "--faces",
                                 "--out", str(tmp_path / "g.jpg")], capsys, monkeypatch))
    assert os.path.isfile(grid["path"])
