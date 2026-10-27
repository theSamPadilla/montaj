"""look's still-hold check (PL89): a stretch over 4 s where nothing moves and nothing cuts.

PL89b held a still 3D frame for 6 s twice and its talking head sat at 100% between cutaways; Claude alone cut or
moved about every 3 s. Any item starting or ending is a beat; a stretch between beats is alive when something in it
moves: keyed framing (push_in's scale, a pan), footage on an upper track, a 3D whose camera moves or whose cast walks
(only while the walk plays), or an overlay that uses the runtime's motion() helper.
"""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib import look_check as lc  # noqa: E402


def doc(tracks):
    return {"settings": {"fps": 30, "resolution": [1080, 1920]}, "tracks": [{"id": f"t{i}", "items": items} for i, items in enumerate(tracks)]}


def vid(i, s, e, **kw):
    return {"id": i, "type": "video", "src": "/x.mp4", "start": s, "end": e, **kw}


def holds(project, project_dir="/nowhere"):
    return [(round(h["t"], 2), h["text"]) for h in lc.still_holds(project, project_dir)]


def test_a_bare_talking_head_over_4_s_is_a_still_hold_and_a_beat_splits_it():
    assert [t for t, _ in holds(doc([[vid("c0", 0, 10)]]))] == [0.0]
    split = holds(doc([[vid("c0", 0, 10)], [{"id": "o", "type": "overlay", "src": "./o.jsx", "start": 3, "end": 4}]]))
    assert [t for t, _ in split] == [4.0]
    assert "6.0 s" in split[0][1] and "push_in" in split[0][1]
    assert holds(doc([[vid("c0", 0, 3.9), vid("c1", 3.9, 7.8)]])) == [], "a cut every 3.9 s is a beat"


def test_a_pushed_clip_and_footage_on_an_upper_track_move():
    push = [{"prop": "scale", "points": [{"t": 0, "value": 1}, {"t": 10, "value": 1.07}]}]
    assert holds(doc([[vid("c0", 0, 10, keyframes=push)]])) == []
    p = doc([[vid("c0", 0, 13)], [vid("b", 2, 8)]])
    assert [t for t, _ in holds(p)] == [8.0], "0-2 is short, 2-8 is footage, 8-13 is still"


def test_a_3d_item_moves_only_where_its_camera_or_its_cast_does(tmp_path):
    models = tmp_path / "models"
    for sid, cam, cast in (
        ("still", [[0, [0, -1, 0.4]], [6, [0, -1, 0.4]]], [{"model": "bot"}]),
        ("orbit", [[0, [0, -1, 0.4]], [6, [0.5, -0.8, 0.4]]], [{"model": "bot"}]),
        ("walk", [[0, [0, -1, 0.4]], [6, [0, -1, 0.4]]], [{"model": "bot", "moves": [{"move": "Bot Stand", "start": 0}, {"move": "walk 0.2", "start": 0.2}]}]),
    ):
        (models / "scenes" / sid).mkdir(parents=True)
        (models / "scenes" / sid / "scene.json").write_text(json.dumps({"camera": {"location": cam, "target": [[0, [0, 0, 0.2]], [6, [0, 0, 0.2]]]}, "cast": cast}))
    (models / "bot").mkdir()
    (models / "bot" / "moves.json").write_text(json.dumps({"moves": {"Bot Stand": {"duration": 4}, "walk 0.2": {"duration": 1.3}}}))
    scene = lambda sid, s, e: {"id": sid, "type": "overlay", "src": "engine:scene3d", "start": s, "end": e, "props": {"scene": sid}}  # noqa: E731
    over = lambda s: [vid("c0", 0, 40)]  # noqa: E731
    assert [t for t, _ in holds(doc([over(0), [scene("still", 10, 16)]]), tmp_path)] == [0.0, 10.0, 16.0]
    assert [t for t, _ in holds(doc([over(0), [scene("orbit", 10, 16)]]), tmp_path)] == [0.0, 16.0]
    walk = holds(doc([over(0), [scene("walk", 10, 16)]]), tmp_path)
    assert [t for t, _ in walk] == [0.0, 11.5, 16.0], "the walk plays 10.2-11.5; the 4.5 s after it is still"


def test_an_overlay_using_motion_counts_as_moving(tmp_path):
    (tmp_path / "overlays").mkdir()
    (tmp_path / "overlays" / "live.jsx").write_text("export default function L() { const m = Motion.motion(frame, fps, duration); return <div style={{ opacity: m.opacity }} /> }")
    (tmp_path / "overlays" / "still.jsx").write_text("export default function S() { return <div>x</div> }")
    live = {"id": "o", "type": "overlay", "src": "./overlays/live.jsx", "start": 0, "end": 10}
    still = {"id": "o", "type": "overlay", "src": "./overlays/still.jsx", "start": 0, "end": 10}
    assert holds(doc([[vid("c0", 0, 10)], [live]]), tmp_path) == []
    assert [t for t, _ in holds(doc([[vid("c0", 0, 10)], [still]]), tmp_path)] == [0.0]


def test_look_reports_still_holds_among_its_issues(tmp_path):
    import steps.render.look as look
    p = tmp_path / "project.json"
    p.write_text(json.dumps({"version": "0.2", "id": "x", "status": "draft", "workflow": "overlays", "editingPrompt": "",
                             **doc([[vid("c0", 0, 10)]])}))
    out = look.run(str(p), detail=True, measure_fn=lambda *a: (None, "no measure"), sheet_fn=lambda *a: (None, "no sheet"))
    assert any("still for" in i for i in out["issues"]), out
