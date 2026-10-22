"""RAW preview (§524): sample_frame / contact_sheet --raw gives the untouched source frame.

Wiring-level: schemas declare `raw` (default false) and serve's /api/steps forwards it to
the step argv (serve drops undeclared params), contact_sheet threads it to its sampler.
Full-render: a real node + ffmpeg run through /api/steps (skipped without node/ffmpeg or
the render runtime); the browser overlay compositor is never started in raw mode.
"""
import json
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

import serve.routes.steps as steps_mod
from serve.server import app
from tests.conftest import STEPS_DIR, HAS_FFMPEG, FFMPEG_BIN

client = TestClient(app)
RENDER = Path(STEPS_DIR) / "render"


def _schema(name):
    return json.loads((RENDER / f"{name}.json").read_text())


@pytest.mark.parametrize("name", ["sample_frame", "contact_sheet"])
def test_schema_advertises_raw_default_false(name):
    p = {x["name"]: x for x in _schema(name)["params"]}
    assert p["raw"]["type"] == "bool" and p["raw"]["default"] is False and p["raw"]["required"] is False


@pytest.fixture()
def stub_env(tmp_path, monkeypatch):
    ws = tmp_path / "Montaj"
    pdir = ws / "p"
    pdir.mkdir(parents=True)
    pid = str(uuid.uuid4())
    (pdir / "project.json").write_text(json.dumps({"id": pid, "tracks": []}))
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    steps_mod._RESERVED_OUTS.clear()
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {
        n: (_schema(n), RENDER / f"{n}.py") for n in ("sample_frame", "contact_sheet")})
    calls = []

    async def fake_run(cmd, **kw):
        calls.append(cmd)
        return "ok\n", "", 0

    monkeypatch.setattr(steps_mod, "run_subprocess", fake_run)
    return pdir, calls


@pytest.mark.parametrize("name,extra", [("sample_frame", {"at": 1.0}), ("contact_sheet", {"at": [1.0]})])
def test_serve_forwards_raw_only_when_set(stub_env, name, extra):
    pdir, calls = stub_env
    base = {"project": str(pdir / "project.json"), "out": str(pdir / "o.png"), **extra}
    assert client.post(f"/api/steps/{name}", json={**base, "raw": True}).status_code == 200
    assert "--raw" in calls[-1]
    assert client.post(f"/api/steps/{name}", json=base).status_code == 200
    assert "--raw" not in calls[-1]


def test_contact_sheet_threads_raw_to_sampler(tmp_path):
    from steps.render import contact_sheet as cs
    seen = []

    def sampler(project, t, out, raw=False):
        seen.append(raw)
        from PIL import Image
        Image.new("RGB", (32, 24)).save(out)

    cs.build("p.json", [0.0, 1.0], 2, 32, str(tmp_path / "s.png"), sampler=sampler, raw=True)
    cs.build("p.json", [0.0], 1, 32, str(tmp_path / "s2.png"), sampler=sampler)
    assert seen == [True, True, False]


def test_sample_frame_raw_argv_reaches_node(tmp_path, monkeypatch):
    """raw -> node sample-frame.js --raw (the source-decode route); no --raw otherwise."""
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "node").write_text("#!/usr/bin/env python3\nimport sys,json\nprint(json.dumps(sys.argv[1:]))\n")
    (fake / "node").chmod(0o755)
    proj = tmp_path / "project.json"
    proj.write_text(json.dumps({"settings": {}}))
    import os
    env = {**os.environ, "PATH": f"{fake}:{os.environ['PATH']}"}
    step = str(RENDER / "sample_frame.py")
    def run(*a):
        return json.loads(subprocess.run([sys.executable, step, "--project", str(proj), "--at", "1", "--out",
                                          str(tmp_path / "o.png"), *a], capture_output=True, text=True, env=env).stdout)
    assert "--raw" in run("--raw")
    assert "--raw" not in run()


needs_real = pytest.mark.skipif(not (HAS_FFMPEG and shutil.which("node")), reason="node + ffmpeg required")


@needs_real
@pytest.mark.parametrize("name", ["sample_frame", "contact_sheet"])
def test_raw_through_serve_is_source_frame_of_clip_2(tmp_path, monkeypatch, name):
    from PIL import Image
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path / "ws"))
    steps_mod._RESERVED_OUTS.clear()

    def clip(n, color):
        f = tmp_path / n
        subprocess.run([FFMPEG_BIN, "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c={color}:s=64x48:d=2:r=10",
                        "-pix_fmt", "yuv420p", str(f)], check=True)
        return str(f)

    def item(i, src, s):
        return {"id": i, "type": "video", "src": src, "start": s, "end": s + 2, "inPoint": 0, "outPoint": 2,
                "sourceWidth": 64, "sourceHeight": 48, "transform": {"scale": 3}}
    pdir = tmp_path / "ws" / "p"
    pdir.mkdir(parents=True)
    pj = pdir / "project.json"
    pj.write_text(json.dumps({"settings": {"resolution": [1080, 1920], "fps": 10}, "tracks": [
        {"type": "video", "items": [item("a", clip("r.mp4", "red"), 0), item("b", clip("b.mp4", "blue"), 2)]}]}))
    out = pdir / "o.png"
    body = {"project": str(pj), "out": str(out), "raw": True,
            **({"at": 3.0} if name == "sample_frame" else {"at": [3.0], "tile-width": 64, "cols": 1})}
    r = client.post(f"/api/steps/{name}", json=body)
    # The render runtime (montaj_assets/render/node_modules) is absent in a bare worktree: both the puppeteer path
    # and node's own module resolver say so. Skip consistently for either step rather than fail only contact_sheet.
    low = r.text.lower()
    if r.status_code != 200 and (("render" in low and "puppeteer" in low) or "err_module_not_found" in low or "cannot find package" in low):
        pytest.skip("render runtime unavailable")
    assert r.status_code == 200, r.text
    im = Image.open(out).convert("RGB")
    if name == "sample_frame":
        assert im.size == (64, 48), "source size: no project canvas fit, crop or zoom"
        px = im.getpixel((32, 24))
    else:
        px = im.getpixel((4 + 32, 4 + 24))
    assert px[2] > 200 and px[0] < 60, f"expected clip 2 (blue), got {px}"
