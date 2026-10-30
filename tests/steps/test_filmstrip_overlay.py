"""Tests for the overlay (.jsx) path of steps/media/filmstrip.py"""
import importlib.util
import json
import shutil
import subprocess
import time

import pytest

from tests.conftest import HAS_FFMPEG, REPO_ROOT, run_step, run_step_env

pytestmark = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not available")

SPEC = importlib.util.spec_from_file_location("filmstrip_mod", REPO_ROOT / "steps" / "media" / "filmstrip.py")
fs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fs)

JSX = """import { helper } from './helper.js'
export default function O() { return <div style={{background: 'red', width: '100%', height: '100%'}}>{helper()}</div> }
"""


@pytest.fixture
def overlay(tmp_path):
    d = tmp_path / "ov"
    d.mkdir()
    (d / "helper.js").write_text("export const helper = () => 'a'\n")
    (d / "o.jsx").write_text(JSX)
    return d


@pytest.fixture
def fake_node(monkeypatch, overlay):
    """Stands in for the node sampler: writes real PNGs, records each call."""
    calls = []

    def fake(cmd, timeout):
        calls.append(cmd)
        out = cmd[cmd.index("--out-dir") + 1]
        n = len(json.loads(cmd[cmd.index("--times") + 1]))
        pngs = []
        for i in range(n):
            p = f"{out}/t_{i:04d}.png"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red@0.5:s=16x28",
                            "-frames:v", "1", p], check=True)
            pngs.append(p)
        return {"pngs": pngs, "tileWidth": 160, "tileHeight": 284,
                "inputs": [[str(overlay / "o.jsx"), 1.0], [str(overlay / "helper.js"), 1.0]]}

    monkeypatch.setattr(fs, "run_overlay_strip_node", fake)
    monkeypatch.setattr(fs, "_render_dir", lambda: "/render")
    return calls


def build(overlay, out, **kw):
    args = dict(jsx=str(overlay / "o.jsx"), duration=3.0, out_dir=str(out), max_tiles=100, min_interval=1.0,
                cols=10, tile_width=160, tiles_per_sheet=100, timeout=60)
    args.update(kw)
    return fs.build_overlay(**args)


def test_overlay_writes_the_standard_index(fake_node, overlay, tmp_path):
    out = tmp_path / "out"
    idx = build(overlay, out)
    assert set(idx) >= {"sheets", "interval", "tileWidth"}
    assert idx["interval"] == pytest.approx(1.0)
    tiles = idx["sheets"][0]["tiles"]
    assert [t["t"] for t in tiles] == [0.0, 1.0, 2.0]
    assert idx["sheets"][0]["cols"] == 10 and idx["sheets"][0]["rows"] == 1
    assert str(idx["sheets"][0]["path"]).startswith(str(out))
    assert (out / "t").exists() is False
    cmd = fake_node[0]
    assert cmd[cmd.index("--duration") + 1] == "90"
    assert cmd[cmd.index("--tile-width") + 1] == "160"


def test_second_run_spawns_nothing(fake_node, overlay, tmp_path):
    out = tmp_path / "out"
    first = build(overlay, out)
    assert len(fake_node) == 1
    second = build(overlay, out)
    assert len(fake_node) == 1
    assert second == first


def test_hit_needs_its_sheets(fake_node, overlay, tmp_path):
    out = tmp_path / "out"
    idx = build(overlay, out)
    (tmp_path / "out").exists()
    import os
    os.remove(idx["sheets"][0]["path"])
    build(overlay, out)
    assert len(fake_node) == 2


@pytest.mark.parametrize("change", ["props", "fonts", "duration", "fps", "tile"])
def test_changing_a_param_changes_the_key(fake_node, overlay, tmp_path, change):
    out = tmp_path / "out"
    build(overlay, out)
    kw = {"props": dict(props='{"a":1}'), "fonts": dict(google_fonts="Syne"), "duration": dict(duration=4.0),
          "fps": dict(fps=60), "tile": dict(tile_width=200)}[change]
    build(overlay, out, **kw)
    assert len(fake_node) == 2


def test_props_key_order_does_not_matter(fake_node, overlay, tmp_path):
    out = tmp_path / "out"
    build(overlay, out, props='{"a":1,"b":2}')
    build(overlay, out, props='{"b":2,"a":1}')
    assert len(fake_node) == 1


def test_editing_the_jsx_changes_the_key(fake_node, overlay, tmp_path):
    out = tmp_path / "out"
    build(overlay, out)
    (overlay / "o.jsx").write_text(JSX + "// edit\n")
    build(overlay, out)
    assert len(fake_node) == 2


def test_editing_an_imported_file_changes_the_key(fake_node, overlay, tmp_path):
    out = tmp_path / "out"
    build(overlay, out)
    assert len(fake_node) == 1
    (overlay / "helper.js").write_text("export const helper = () => 'b'\n")
    build(overlay, out)
    assert len(fake_node) == 2
    build(overlay, out)
    assert len(fake_node) == 2


def test_overlay_requires_duration(overlay, tmp_path):
    proc = run_step("filmstrip.py", "--input", str(overlay / "o.jsx"), "--out-dir", str(tmp_path / "o"))
    assert proc.returncode != 0
    assert "duration" in proc.stderr


def test_video_path_unchanged(tmp_path):
    vid = tmp_path / "v.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=320x240:d=4",
                    "-r", "30", "-pix_fmt", "yuv420p", str(vid)], check=True)
    proc = run_step("filmstrip.py", "--input", str(vid), "--out-dir", str(tmp_path / "o"), "--max-tiles", "4")
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)
    assert set(data) == {"sheets", "interval", "tileWidth"}
    assert len(data["sheets"][0]["tiles"]) == 4


def test_real_overlay_strip_three_tiles(overlay, tmp_path):
    if not shutil.which("node"):
        pytest.skip("node not available")
    try:
        render = fs._render_dir()
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"render runtime not resolvable: {e}")
    if not (__import__("pathlib").Path(render) / "node_modules" / "puppeteer").exists():
        pytest.skip("render runtime has no puppeteer")
    out = tmp_path / "real"
    t0 = time.time()
    # the read boundary admits the workspace; the fixture folder stands in for it
    proc = run_step_env("filmstrip.py", {"MONTAJ_WORKSPACE_DIR": str(tmp_path.resolve())},
                        "--input", str(overlay / "o.jsx"), "--out-dir", str(out),
                        "--duration", "3", "--tile-width", "108", "--timeout", "120")
    if proc.returncode != 0 and "chrom" in proc.stderr.lower():
        pytest.skip(f"Chromium not launchable headless: {proc.stderr[-200:]}")
    assert proc.returncode == 0, proc.stderr
    print(f"3-tile render took {time.time() - t0:.1f}s")
    data = json.loads(proc.stdout)
    assert len(data["sheets"][0]["tiles"]) == 3
    assert data["tileWidth"] == 108 and data["tileHeight"] == 192
    assert (out / data["sheets"][0]["path"].split("/")[-2] / "index.json").exists()


def test_key_is_stable_across_path_separators(monkeypatch):
    # content reads are a host concern; the pure key code sees only the (normalised) path text
    monkeypatch.setattr(fs, "_file_sha", lambda p: "same")
    posix = "C:/Users/x/ov/a.js"
    win = "C:\\Users\\x\\ov\\a.js"
    assert fs.overlay_key("base", [posix]) == fs.overlay_key("base", [win])
    assert fs._norm("C:\\Users\\x\\o.jsx") == "C:/Users/x/o.jsx"


def test_rename_failure_over_a_valid_target_is_a_hit(tmp_path, monkeypatch):
    target = tmp_path / "index.json"
    target.write_text(json.dumps({"sheets": [1]}))
    def boom(*a):
        raise PermissionError("EPERM")
    monkeypatch.setattr(fs.os, "replace", boom)
    fs._write_json_atomic(str(target), {"sheets": [2]}, valid=lambda d: bool(d and d.get("sheets")))
    assert json.loads(target.read_text()) == {"sheets": [1]}
    assert not list(tmp_path.glob("*.tmp"))
    target.write_text("junk")
    with pytest.raises(PermissionError):
        fs._write_json_atomic(str(target), {"sheets": [2]}, valid=lambda d: bool(d and d.get("sheets")))


def test_locked_index_json_returns_the_valid_one_already_there(fake_node, overlay, tmp_path, monkeypatch):
    out = tmp_path / "out"
    first = build(overlay, out)
    index = [p for p in out.glob("*/index.json")][0]
    index.unlink()
    held = dict(first, interval=9.0)  # what another process wrote
    index.write_text(json.dumps(held))
    real = fs.os.replace
    def locked(src, dst):
        if str(dst).endswith("index.json"):
            raise PermissionError("EPERM")
        return real(src, dst)
    monkeypatch.setattr(fs.os, "replace", locked)
    (overlay / "helper.js").write_text("export const helper = () => 'same key not needed'\n")
    # same key again: wipe the cache hit by removing a sheet, so it renders and reaches the write
    for sh in held["sheets"]:
        pass
    got = fs._write_json_atomic(str(index), first, valid=lambda d: bool(d and d.get("sheets")))
    assert got == held
