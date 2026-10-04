"""DELETE /api/projects/{id}?preserve_assets=true (serve/routes/projects.py).

"Back to setup" deletes a pending project and re-fills the new-project form
from the files this route keeps. Every file a test creates lives under its own
tmp_path; the workspace is pointed there with MONTAJ_WORKSPACE_DIR.
"""
import json
import os
import uuid
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from lib.normalize import normalized_output_path
from serve.server import app

client = TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    ws = (tmp_path / "ws").resolve()
    ws.mkdir()
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(ws))
    return ws


def _file(path: Path, content: bytes) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return str(path)


def _clip(i: int, src: str, **extra) -> dict:
    return {"id": f"clip-{i}", "type": "video", "src": src, "start": 0.0, "end": 0.0, **extra}


def _new_dir(workspace: Path) -> tuple[str, Path]:
    pid = str(uuid.uuid4())
    project_dir = workspace / f"2026-10-04-{pid[:8]}"
    project_dir.mkdir(parents=True)
    return pid, project_dir


def _write(project_dir: Path, pid: str, *, clips=(), image_refs=(), style_refs=(),
           status="pending") -> None:
    """A pending ai_video project.json shaped like project/init.py writes one:
    the clips list is both `sources` and track 0's items."""
    clips = list(clips)
    (project_dir / "project.json").write_text(json.dumps({
        "version": "0.2",
        "id": pid,
        "status": status,
        "projectType": "ai_video",
        "workflow": "ai_video",
        "editingPrompt": "test",
        "sources": clips,
        "settings": {"resolution": [1080, 1920], "fps": 30},
        "tracks": [{"id": "trk-0", "items": clips}],
        "assets": [],
        "audio": {},
        "storyboard": {
            "imageRefs": [
                {"id": f"ref{i + 1}", "label": f"ref{i + 1}", "refImages": [p],
                 "source": "upload", "status": "pending"}
                for i, p in enumerate(image_refs)
            ],
            "styleRefs": [
                {"id": f"style{i + 1}", "kind": "image", "path": p, "label": f"style {i + 1}"}
                for i, p in enumerate(style_refs)
            ],
            "scenes": [],
        },
    }))


def _delete_preserving(pid: str) -> dict:
    resp = client.delete(f"/api/projects/{pid}?preserve_assets=true")
    assert resp.status_code == 200, resp.text
    return resp.json()["preserved"]


def _uploads(workspace: Path) -> dict:
    d = workspace / "_uploads"
    return {p.name: p.read_bytes() for p in d.iterdir()} if d.is_dir() else {}


# ---------------------------------------------------------------------------
# Clips
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("status", ["pending", "storyboard_ready"])
def test_preserve_keeps_every_clip_and_image_and_maps_every_path(workspace, status):
    pid, project_dir = _new_dir(workspace)
    clip_a = _file(project_dir / "clip-a.mov", b"footage A")
    clip_b = _file(project_dir / "clip-b.mp4", b"footage B")
    image = _file(project_dir / "face.png", b"image")
    style = _file(project_dir / "look.jpg", b"style")
    _write(project_dir, pid, clips=[_clip(0, clip_a), _clip(1, clip_b)],
           image_refs=[image], style_refs=[style], status=status)

    preserved = _delete_preserving(pid)

    uploads = workspace / "_uploads"
    assert preserved == {
        clip_a: str(uploads / "clip-a.mov"),
        clip_b: str(uploads / "clip-b.mp4"),
        image: str(uploads / "face.png"),
        style: str(uploads / "look.jpg"),
    }
    # Each clip referenced twice (sources + track) was moved once: no _1 copy.
    assert _uploads(workspace) == {
        "clip-a.mov": b"footage A",
        "clip-b.mp4": b"footage B",
        "face.png": b"image",
        "look.jpg": b"style",
    }
    assert not project_dir.exists()


def test_clip_outside_the_project_is_left_in_place_and_maps_to_itself(workspace, tmp_path):
    outside = _file(tmp_path / "footage" / "outside.mov", b"user's own file")
    pid, project_dir = _new_dir(workspace)
    _write(project_dir, pid, clips=[_clip(0, outside)])

    preserved = _delete_preserving(pid)

    assert preserved == {outside: outside}
    assert Path(outside).read_bytes() == b"user's own file"
    assert _uploads(workspace) == {}
    assert not project_dir.exists()


def test_symlinked_clip_maps_to_its_target_and_the_target_is_never_moved(workspace, tmp_path):
    target = _file(tmp_path / "footage" / "shared.mov", b"shared source")
    pid, project_dir = _new_dir(workspace)
    link = project_dir / "shared.mov"
    os.symlink(target, link)
    _write(project_dir, pid, clips=[_clip(0, str(link))])

    preserved = _delete_preserving(pid)

    # The link dies with the project folder; the footage it points at survives.
    assert preserved == {str(link): str(Path(target).resolve())}
    assert Path(target).read_bytes() == b"shared source"
    assert _uploads(workspace) == {}
    assert not project_dir.exists()


def test_a_normalized_src_preserves_the_users_original_not_the_derived_files(workspace):
    pid, project_dir = _new_dir(workspace)
    original = _file(project_dir / "IMG_0001.MOV", b"camera original")
    master = _file(Path(normalized_output_path(original, "sdr_bt709", tonemapped=True)), b"master")
    proxy = _file(project_dir / "IMG_0001_proxy.mp4", b"proxy")
    # init.py swaps `src` onto the conformed master when it transcodes.
    _write(project_dir, pid, clips=[_clip(0, master, proxySrc=proxy)])

    preserved = _delete_preserving(pid)

    assert preserved == {master: str(workspace / "_uploads" / "IMG_0001.MOV")}
    assert _uploads(workspace) == {"IMG_0001.MOV": b"camera original"}


def test_a_normalized_src_with_no_original_beside_it_is_kept_itself(workspace):
    pid, project_dir = _new_dir(workspace)
    master = _file(project_dir / "clip_normalized_hdr_hlg.mp4", b"only copy left")
    _write(project_dir, pid, clips=[_clip(0, master)])

    preserved = _delete_preserving(pid)

    assert preserved == {master: str(workspace / "_uploads" / "clip_normalized_hdr_hlg.mp4")}
    assert _uploads(workspace) == {"clip_normalized_hdr_hlg.mp4": b"only copy left"}


def test_a_clip_name_collision_in_uploads_never_overwrites(workspace):
    _file(workspace / "_uploads" / "clip-a.mov", b"already staged")
    pid, project_dir = _new_dir(workspace)
    clip_a = _file(project_dir / "clip-a.mov", b"footage A")
    _write(project_dir, pid, clips=[_clip(0, clip_a)])

    preserved = _delete_preserving(pid)

    assert preserved == {clip_a: str(workspace / "_uploads" / "clip-a_1.mov")}
    assert _uploads(workspace) == {"clip-a.mov": b"already staged", "clip-a_1.mov": b"footage A"}


# ---------------------------------------------------------------------------
# Image and style refs: behaviour from before clips were preserved
# ---------------------------------------------------------------------------

def test_image_and_style_refs_are_moved_and_outside_refs_stay_unmapped(workspace, tmp_path):
    pid, project_dir = _new_dir(workspace)
    image = _file(project_dir / "face.png", b"image")
    style = _file(project_dir / "look.jpg", b"style")
    outside_image = _file(tmp_path / "elsewhere" / "logo.png", b"outside image")
    missing = str(project_dir / "gone.png")
    _write(project_dir, pid,
           image_refs=[image, outside_image, missing], style_refs=[style])

    preserved = _delete_preserving(pid)

    uploads = workspace / "_uploads"
    assert preserved == {image: str(uploads / "face.png"), style: str(uploads / "look.jpg")}
    assert _uploads(workspace) == {"face.png": b"image", "look.jpg": b"style"}
    assert Path(outside_image).read_bytes() == b"outside image"
    assert not project_dir.exists()


def test_without_preserve_the_project_is_removed_and_nothing_is_kept(workspace):
    pid, project_dir = _new_dir(workspace)
    clip_a = _file(project_dir / "clip-a.mov", b"footage A")
    _write(project_dir, pid, clips=[_clip(0, clip_a)])

    resp = client.delete(f"/api/projects/{pid}")

    assert resp.status_code == 204
    assert not project_dir.exists()
    assert _uploads(workspace) == {}
