"""One legible look sheet (orientation plan, Sam 2026-10-26): every sheet the agent looks at (snapshot, shots,
sample_frame, contact_sheet, the brief's first looks) is laid out for 1280 px, the size the app delivers it at, so it
never needs a full-size fetch. lib/sheet.look_sheet is the one layout."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "lib"))

from PIL import Image  # noqa: E402

from sheet import LOOK_WIDTH, look_layout, look_sheet  # noqa: E402


def frames(tmp_path, n, size):
    out = []
    for i in range(n):
        p = tmp_path / f"f{i}.png"
        Image.new("RGB", size, (20 * (i % 10), 90, 120)).save(p)
        out.append(str(p))
    return out


def test_landscape_tiles_four_across_portrait_six_and_few_tiles_fewer():
    assert look_layout(18, 16 / 9)[0] == 4
    assert look_layout(9, 9 / 16)[0] == 6
    assert look_layout(2, 16 / 9)[0] == 2
    cols, tile_w, label_px = look_layout(18, 16 / 9)
    assert cols * tile_w <= LOOK_WIDTH and LOOK_WIDTH - cols * tile_w < 40 and label_px >= 20


def test_many_tiles_add_columns_so_the_sheet_stays_about_square():
    cols, tile_w, _ = look_layout(36, 16 / 9)
    rows = -(-36 // cols)
    assert cols > 4 and rows * (tile_w * 9 / 16 + 30) <= 1500


def test_the_sheet_is_1280_wide_and_labelled(tmp_path):
    out = tmp_path / "s.jpg"
    look_sheet(frames(tmp_path, 18, (1920, 1080)), [f"{i + 1}  0.0-1.0" for i in range(18)], str(out))
    with Image.open(out) as im:
        w, h = im.size
    assert LOOK_WIDTH - 8 <= w <= LOOK_WIDTH and h <= 1500


def test_mixed_shapes_fit_the_same_box(tmp_path):
    out = tmp_path / "s.jpg"
    paths = frames(tmp_path, 3, (1080, 1920)) + frames(tmp_path, 3, (1920, 1080))
    look_sheet(paths, [str(i) for i in range(6)], str(out), cols=3, box=True)
    with Image.open(out) as im:
        assert LOOK_WIDTH - 8 <= im.size[0] <= LOOK_WIDTH


def test_the_shots_sheet_and_snapshot_sheets_are_1280_wide(tmp_path):
    from lib import shots as sh
    import subprocess as sp
    from lib.common import ffmpeg_bin
    clip = tmp_path / "c.mp4"
    sp.run([ffmpeg_bin(), "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=320x180:d=2:r=30", "-f", "lavfi",
            "-i", "color=c=0x181818:s=320x180:d=2:r=30", "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]", "-map", "[v]",
            "-pix_fmt", "yuv420p", str(clip)], check=True)
    out = tmp_path / "shots.jpg"
    sh.sheet(str(clip), sh.shots_for(str(clip))["shots"], str(out))
    with Image.open(out) as im:
        assert LOOK_WIDTH - 8 <= im.size[0] <= LOOK_WIDTH
    snap = tmp_path / "at.jpg"
    r = subprocess.run([sys.executable, str(ROOT / "steps" / "media" / "snapshot.py"), "--input", str(clip),
                        "--at", "0.5", "--at", "1.5", "--at", "2.5", "--out", str(snap)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    with Image.open(snap) as im:
        assert LOOK_WIDTH - 8 <= im.size[0] <= LOOK_WIDTH


# -- sample_frame: the one timeline look (every, and any number of times) -------------------------------------------

def _run_sample_frame(tmp_path, monkeypatch, argv):
    import importlib.util
    spec = importlib.util.spec_from_file_location("sample_frame_look", ROOT / "steps" / "render" / "sample_frame.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    pdir = tmp_path / "proj"
    pdir.mkdir(exist_ok=True)
    pj = pdir / "project.json"
    pj.write_text(json.dumps({"id": "p", "settings": {"resolution": [1080, 1920]},
                              "tracks": [{"id": "t0", "items": [{"id": "v", "type": "video", "src": "/x.mp4", "start": 0, "end": 30}]}]}))
    seen = {}

    def fake_sample_frames(project, times, work, **kw):
        seen["times"] = list(times)
        out = []
        for i, _ in enumerate(times):
            p = Path(work) / f"f{i}.png"
            Image.new("RGB", (540, 960), (40, 80, 120)).save(p)
            out.append(str(p))
        return out
    monkeypatch.setattr(mod, "sample_frames", fake_sample_frames)
    monkeypatch.setattr(sys, "argv", ["sample_frame.py", "--project", str(pj), *argv])
    import io
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        mod.main()
    return seen, [l for l in buf.getvalue().splitlines() if l.strip()]


def test_sample_frame_every_grids_the_whole_project(tmp_path, monkeypatch):
    seen, paths = _run_sample_frame(tmp_path, monkeypatch, ["--every", "5"])
    assert seen["times"] == [0.0, 5.0, 10.0, 15.0, 20.0, 25.0]
    with Image.open(paths[0]) as im:
        assert LOOK_WIDTH - 8 <= im.size[0] <= LOOK_WIDTH


def test_sample_frame_takes_more_than_12_times_on_legible_sheets(tmp_path, monkeypatch):
    times = [str(t) for t in range(30)]
    argv = [a for t in times for a in ("--at", t)]
    seen, paths = _run_sample_frame(tmp_path, monkeypatch, argv)
    assert len(seen["times"]) == 30
    assert len(paths) == 2, "24 a sheet"
    for p in paths:
        with Image.open(p) as im:
            assert LOOK_WIDTH - 8 <= im.size[0] <= LOOK_WIDTH
