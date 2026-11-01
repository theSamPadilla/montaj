"""§642: look flags an overlay animation still running at its cut. end_motion on synthetic RGBA PNGs; the step with the
end-frame renderer faked at its seam (end_fn); end_frames with the sample_overlay call faked."""
import json
import sys
from pathlib import Path

from PIL import Image

MONTAJ_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(MONTAJ_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import look_check as lc  # noqa: E402
import steps.render.look as look  # noqa: E402
from test_look import _project, _fake_measure  # noqa: E402


def _png(tmp_path, name, x=200, alpha=255, w=1080, h=1920):
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    im.paste(Image.new("RGBA", (300, 200), (255, 255, 255, alpha)), (x, 300))
    p = tmp_path / name
    im.save(p)
    return str(p)


def test_end_motion_static_is_zero(tmp_path):
    assert lc.end_motion(_png(tmp_path, "a.png"), _png(tmp_path, "b.png")) == 0.0
    assert not lc.end_motion_flagged(0.0)


def test_end_motion_shifted_block_is_flagged(tmp_path):
    m = lc.end_motion(_png(tmp_path, "a.png", x=200), _png(tmp_path, "b.png", x=208))
    assert m is not None and m > lc.END_MOTION_MIN and lc.end_motion_flagged(m)


def test_end_motion_fade_out_is_not_flagged(tmp_path):
    assert lc.end_motion(_png(tmp_path, "a.png", alpha=255), _png(tmp_path, "b.png", alpha=0)) is None
    assert lc.end_motion(_png(tmp_path, "a.png", alpha=255), _png(tmp_path, "b.png", alpha=100)) is None
    assert not lc.end_motion_flagged(None)


def test_end_motion_unreadable_is_none(tmp_path):
    assert lc.end_motion(str(tmp_path / "nope.png"), str(tmp_path / "nope2.png")) is None


def _step(tmp_path, end_fn, overlays=None):
    path, _ = _project(tmp_path, overlays=overlays or [{"id": "ov-a", "start": 1, "end": 3}])
    return look.run(str(path), detail=True, measure_fn=_fake_measure({}), end_fn=end_fn)


def test_look_flags_an_overlay_moving_at_its_cut(tmp_path):
    pair = (_png(tmp_path, "a.png", x=200), _png(tmp_path, "b.png", x=208))
    out = _step(tmp_path, lambda entries: {e["label"]: pair for e in entries})
    assert any(i.endswith(f"ov-a: {lc.END_MOTION_TEXT}") for i in out["issues"])
    (row,) = out["endMotion"]
    assert row["src"] == "./overlays/ov-a.jsx" and row["endMotion"] > lc.END_MOTION_MIN and row["endMotion"] == round(row["endMotion"], 3)


def test_look_does_not_flag_a_fade(tmp_path):
    pair = (_png(tmp_path, "a.png", alpha=255), _png(tmp_path, "b.png", alpha=0))
    out = _step(tmp_path, lambda entries: {e["label"]: pair for e in entries})
    assert not any(lc.END_MOTION_TEXT in i for i in out.get("issues", [])) and "endMotion" not in out


def test_look_render_failure_leaves_no_issue(tmp_path):
    def boom(entries):
        raise RuntimeError("chrome gone")
    for fn in (boom, lambda entries: {}):
        out = _step(tmp_path, fn)
        assert not any(lc.END_MOTION_TEXT in i for i in out.get("issues", [])) and "endMotion" not in out


def _entry(src, duration=30):
    return {"item": {"src": src}, "path": "/x/o.jsx", "label": "ov", "duration": duration, "fps": 30, "width": 1080,
            "height": 1920, "out": "/nonexistent/ov-f15.png"}


def test_end_frames_skips_non_jsx_and_short_overlays(monkeypatch):
    called = []
    monkeypatch.setattr(look, "_run_group", lambda cmd, t: called.append(cmd))
    assert look.end_frames([_entry("./scenes/s.glb"), _entry("engine:orbit"), _entry("./o.jsx", duration=2)]) == {}
    assert called == []


def test_end_frames_asks_for_the_last_two_frames_in_one_call(monkeypatch, tmp_path):
    cmds = []

    def run(cmd, timeout):
        cmds.append(cmd)
        jobs = json.load(open(cmd[cmd.index("--jobs") + 1]))
        return 0, json.dumps({"results": [{"pngPath": j["out"]} for j in jobs]}) + "\n", ""
    monkeypatch.setattr(look, "_run_group", run)
    e = _entry("./o.jsx")
    e["out"] = str(tmp_path / "ov-f15.png")
    got = look.end_frames([e, _entry("./scenes/s.glb")])
    assert len(cmds) == 1 and "--no-measure" in cmds[0]
    jobs = json.load(open(tmp_path / "look-end-jobs.json"))
    assert [j["frame"] for j in jobs] == [28, 29] and all(j["duration"] == 30 for j in jobs)
    assert got == {"ov": (str(tmp_path / "ov-f15-end0.png"), str(tmp_path / "ov-f15-end1.png"))}


def test_end_frames_failed_call_is_unchecked(monkeypatch, tmp_path):
    monkeypatch.setattr(look, "_run_group", lambda cmd, t: (1, "", "boom"))
    e = _entry("./o.jsx")
    e["out"] = str(tmp_path / "ov-f15.png")
    assert look.end_frames([e]) == {}
