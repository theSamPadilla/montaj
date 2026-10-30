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
                "inputs": [[str(f), f.stat().st_mtime * 1000] for f in (overlay / "o.jsx", overlay / "helper.js")]}

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
    held = dict(first, interval=9.0)  # what another process wrote
    index.write_text(json.dumps(held))
    real = fs.os.replace
    def locked(src, dst):
        if str(dst).endswith("index.json"):
            raise PermissionError("EPERM")
        return real(src, dst)
    monkeypatch.setattr(fs.os, "replace", locked)
    got = fs._write_json_atomic(str(index), first, valid=lambda d: bool(d and d.get("sheets")))
    assert got == held
    assert json.loads(index.read_text()) == held
    assert not list(index.parent.glob("*.tmp"))
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


def test_edit_during_the_render_is_not_cached(overlay, tmp_path, monkeypatch, fake_node):
    out = tmp_path / "out"
    inner = fs.run_overlay_strip_node

    def edits_then_returns(cmd, timeout):
        got = inner(cmd, timeout)
        (overlay / "helper.js").write_text("export const helper = () => 'edited mid-render'\n")
        return got

    monkeypatch.setattr(fs, "run_overlay_strip_node", edits_then_returns)
    idx = build(overlay, out)
    assert idx["sheets"] and all(__import__("os").path.isfile(s["path"]) for s in idx["sheets"])
    assert not list(out.glob("*/imports.json")) and not list(out.glob("*/index.json"))
    # the sheets never went into a key folder: they sit in a stale_ folder of their own
    assert all(__import__("pathlib").Path(s["path"]).parent.name.startswith("stale_") for s in idx["sheets"])
    # nothing was cached, so the next build renders again and does cache
    monkeypatch.setattr(fs, "run_overlay_strip_node", inner)
    build(overlay, out)
    assert len(fake_node) == 2
    assert list(out.glob("*/index.json"))
    build(overlay, out)
    assert len(fake_node) == 2


def test_edit_of_the_jsx_during_the_render_is_not_cached(overlay, tmp_path, monkeypatch, fake_node):
    out = tmp_path / "out"
    inner = fs.run_overlay_strip_node

    def edits_then_returns(cmd, timeout):
        got = inner(cmd, timeout)
        (overlay / "o.jsx").write_text(JSX + "// edit\n")
        return got

    monkeypatch.setattr(fs, "run_overlay_strip_node", edits_then_returns)
    build(overlay, out)
    assert not list(out.glob("*/index.json"))


def test_a_stat_that_moved_is_stale(overlay, monkeypatch):
    jsx = str(overlay / "o.jsx")
    sha = fs._file_sha(jsx)
    mt = (overlay / "o.jsx").stat().st_mtime * 1000
    assert fs._inputs_changed(jsx, sha, [[jsx, mt]]) is False
    assert fs._inputs_changed(jsx, sha, [[jsx, mt + 0.5]]) is False  # inside the 1 ms tolerance
    assert fs._inputs_changed(jsx, sha, [[jsx, mt + 5]]) is True
    assert fs._inputs_changed(jsx, sha, [[str(overlay / "gone.js"), 1.0]]) is True


def test_node_timeout_fails_cleanly(overlay, tmp_path, monkeypatch, capsys):
    import common
    seen = {}

    def boom(cmd, timeout, **kw):
        seen["cmd"], seen["timeout"] = cmd, timeout
        raise subprocess.TimeoutExpired(cmd, 1)
    # run_stopping, not subprocess.run: past the timeout the sampler's whole group gets SIGTERM, so its Chromium closes
    monkeypatch.setattr(common, "run_stopping", boom)
    monkeypatch.setattr(fs, "_render_dir", lambda: "/render")
    out = tmp_path / "out"
    with pytest.raises(SystemExit):
        build(overlay, out)
    err = json.loads(capsys.readouterr().err.strip().splitlines()[-1])
    assert err == {"error": "timeout", "message": "Overlay strip timed out"}
    assert not list(out.glob(".strip_*"))
    # the sampler's own deadline sits 15 s inside the step's, so it closes Chromium and exits first
    assert seen["timeout"] == 60
    assert seen["cmd"][seen["cmd"].index("--deadline-ms") + 1] == "45000"
    assert fs.node_deadline_ms(10) == 5000


def test_work_dir_is_gone_and_sheets_sit_under_the_key(fake_node, overlay, tmp_path):
    out = tmp_path / "out"
    idx = build(overlay, out)
    assert not list(out.glob(".strip_*"))
    index_dir = [p for p in out.glob("*/index.json")][0].parent
    assert __import__("pathlib").Path(idx["sheets"][0]["path"]).parent == index_dir


def test_montaj_version_is_in_the_key(fake_node, overlay, tmp_path, monkeypatch):
    out = tmp_path / "out"
    build(overlay, out)
    monkeypatch.setattr(fs, "_montaj_version", lambda: "9.9.9")
    build(overlay, out)
    assert len(fake_node) == 2


# ---------------------------------------------------------------------------
# 3D items (--input engine:scene3d)
# ---------------------------------------------------------------------------

@pytest.fixture
def project3d(tmp_path, monkeypatch):
    """A project with two saved 3Ds, and the host stage the app supplies."""
    proj = tmp_path / "proj"
    for sid in ("hands", "walk"):
        (proj / "models" / "scenes" / sid).mkdir(parents=True)
        (proj / "models" / "scenes" / sid / "active.json").write_text(json.dumps({"model": {"id": sid}}))
    (proj / "project.json").write_text("{}")
    stage = tmp_path / "stage.jsx"
    stage.write_text("export default function Stage() { return null }\n")
    monkeypatch.setenv(fs.SCENE3D_STAGE_ENV, str(stage))
    return proj


@pytest.fixture
def fake_node3d(monkeypatch, project3d):
    """The node sampler for a 3D strip: real PNGs, and the stage and scene as the files it read."""
    calls = []

    def fake(cmd, timeout):
        calls.append(cmd)
        out = cmd[cmd.index("--out-dir") + 1]
        props = json.loads(cmd[cmd.index("--props") + 1])
        scene = project3d / "models" / "scenes" / props.get("scene", "hands") / "active.json"
        stage = fs.os.environ[fs.SCENE3D_STAGE_ENV]
        pngs = []
        for i in range(len(json.loads(cmd[cmd.index("--times") + 1]))):
            p = f"{out}/t_{i:04d}.png"
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue@0.5:s=16x28",
                            "-frames:v", "1", p], check=True)
            pngs.append(p)
        return {"pngs": pngs, "tileWidth": 160, "tileHeight": 284,
                "inputs": [[str(f), fs.os.stat(f).st_mtime * 1000] for f in (stage, str(scene))]}

    monkeypatch.setattr(fs, "run_overlay_strip_node", fake)
    monkeypatch.setattr(fs, "_render_dir", lambda: "/render")
    return calls


def build3d(project, out, **kw):
    args = dict(project=str(project), duration=3.0, out_dir=str(out), max_tiles=100, min_interval=1.0,
                cols=10, tile_width=160, tiles_per_sheet=100, timeout=60, props='{"scene":"hands","inPoint":2}')
    args.update(kw)
    return fs.build_scene3d(**args)


def test_3d_strip_renders_the_scene_through_the_overlay_strip_session(fake_node3d, project3d, tmp_path):
    idx = build3d(project3d, tmp_path / "out")
    assert [t["t"] for t in idx["sheets"][0]["tiles"]] == [0.0, 1.0, 2.0]
    cmd = fake_node3d[0]
    assert cmd[cmd.index("--mode") + 1] == "overlay-strip"
    assert cmd[cmd.index("--component") + 1] == "engine:scene3d"
    assert cmd[cmd.index("--project-dir") + 1] == str(project3d)
    assert json.loads(cmd[cmd.index("--props") + 1]) == {"scene": "hands", "inPoint": 2}


def test_3d_strip_takes_project_json_too_and_drops_derived_props(fake_node3d, project3d, tmp_path):
    build3d(project3d / "project.json", tmp_path / "out",
            props=json.dumps({"scene": "hands", "inPoint": 2, "sceneJson": "{}", "sceneFile": "/x/active.json"}))
    cmd = fake_node3d[0]
    assert cmd[cmd.index("--project-dir") + 1] == str(project3d)
    assert json.loads(cmd[cmd.index("--props") + 1]) == {"scene": "hands", "inPoint": 2}


def test_3d_strip_second_run_is_a_hit(fake_node3d, project3d, tmp_path):
    first = build3d(project3d, tmp_path / "out")
    assert build3d(project3d, tmp_path / "out") == first
    assert len(fake_node3d) == 1


def test_editing_the_saved_3d_changes_the_key(fake_node3d, project3d, tmp_path):
    build3d(project3d, tmp_path / "out")
    (project3d / "models" / "scenes" / "hands" / "active.json").write_text(json.dumps({"model": {"id": "hands", "v": 2}}))
    build3d(project3d, tmp_path / "out")
    assert len(fake_node3d) == 2
    # Another 3D's file changing does not touch this one's key.
    (project3d / "models" / "scenes" / "walk" / "active.json").write_text(json.dumps({"model": {"id": "walk", "v": 2}}))
    build3d(project3d, tmp_path / "out")
    assert len(fake_node3d) == 2


@pytest.mark.parametrize("change", ["scene", "inPoint", "stage", "duration"])
def test_3d_strip_key_follows_scene_props_stage_and_length(fake_node3d, project3d, tmp_path, change):
    build3d(project3d, tmp_path / "out")
    if change == "stage":
        stage = fs.os.environ[fs.SCENE3D_STAGE_ENV]
        with open(stage, "a") as f:
            f.write("// newer stage\n")
        build3d(project3d, tmp_path / "out")
    else:
        kw = {"scene": dict(props='{"scene":"walk","inPoint":2}'), "inPoint": dict(props='{"scene":"hands","inPoint":3}'),
              "duration": dict(duration=4.0)}[change]
        build3d(project3d, tmp_path / "out", **kw)
    assert len(fake_node3d) == 2


def test_3d_strip_refuses_a_bad_id_and_a_missing_project(fake_node3d, project3d, tmp_path):
    with pytest.raises(SystemExit):
        build3d(project3d, tmp_path / "out", props='{"scene":"../etc"}')
    with pytest.raises(SystemExit):
        fs.build_scene3d(None, 3.0, str(tmp_path / "out"), 100, 1.0, 10, 160, 100, 60, props='{"scene":"hands"}')
    assert fake_node3d == []


# ---------------------------------------------------------------------------
# Coverage: only visual overlays get a strip
# ---------------------------------------------------------------------------

def _png(path, size=(160, 284), box=None, alpha=255):
    """A transparent PNG, filled (or only `box` filled) with opaque red."""
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle(box or (0, 0, size[0] - 1, size[1] - 1), fill=(255, 0, 0, alpha))
    im.save(path)
    return str(path)


def test_coverage_reads_alpha(tmp_path):
    assert fs.tile_coverage(_png(tmp_path / "full.png")) == pytest.approx(1.0)
    # a line of tiny text: a strip 4 px tall across a 284 px frame
    assert fs.tile_coverage(_png(tmp_path / "text.png", box=(20, 140, 140, 143))) < fs.VISUAL_COVERAGE
    # alpha at or under 0.1 is not coverage
    assert fs.tile_coverage(_png(tmp_path / "faint.png", alpha=20)) == 0.0


@pytest.mark.parametrize("box, visual", [(None, True), ((20, 140, 140, 143), False)])
def test_index_says_whether_the_overlay_is_visual(monkeypatch, overlay, tmp_path, box, visual):
    def fake(cmd, timeout):
        out = cmd[cmd.index("--out-dir") + 1]
        n = len(json.loads(cmd[cmd.index("--times") + 1]))
        return {"pngs": [_png(f"{out}/t_{i:04d}.png", box=box) for i in range(n)], "tileWidth": 160, "tileHeight": 284,
                "inputs": [[str(overlay / "o.jsx"), (overlay / "o.jsx").stat().st_mtime * 1000]]}
    monkeypatch.setattr(fs, "run_overlay_strip_node", fake)
    monkeypatch.setattr(fs, "_render_dir", lambda: "/render")
    idx = build(overlay, tmp_path / "out")
    assert idx["visual"] is visual
    assert (idx["coverage"] >= fs.VISUAL_COVERAGE) is visual
    # the sheet keeps alpha, so the editor can lay it over the footage
    from PIL import Image
    path = idx["sheets"][0]["path"]
    assert path.endswith(".png")
    with Image.open(path) as im:
        assert im.mode == "RGBA"
        assert im.size == (10 * 160, 284)
        assert im.getpixel((10 * 160 - 1, 0))[3] == 0  # the empty cells of a short row stay transparent


def test_prune_keeps_the_newest_strips(fake_node, overlay, tmp_path):
    out = tmp_path / "out"
    for d in range(1, 7):
        build(overlay, out, duration=float(d))
        time.sleep(0.02)  # distinct mtimes, so the newest is unambiguous
    keys = [f for f in out.iterdir() if f.is_dir() and (f / "index.json").exists()]
    assert len(keys) == fs.KEEP_STRIPS
    # the newest build is still a hit; the oldest renders again
    n = len(fake_node)
    build(overlay, out, duration=6.0)
    assert len(fake_node) == n
    build(overlay, out, duration=1.0)
    assert len(fake_node) == n + 1
    # import lists whose strip was pruned are gone too
    for f in out.iterdir():
        if (f / "imports.json").exists():
            imports = json.loads((f / "imports.json").read_text())
            assert (out / fs.overlay_key(f.name, imports)).is_dir()
    # a folder still being written (no index.json) and work folders are left alone
    (out / ("a" * 64)).mkdir()
    (out / ".strip_x").mkdir()
    fs.prune_strips(str(out), keep=0)
    assert (out / ("a" * 64)).is_dir() and (out / ".strip_x").is_dir()
    assert not [f for f in out.iterdir() if (f / "index.json").exists()]
    fs.prune_strips(str(tmp_path / "missing"))  # never raises
