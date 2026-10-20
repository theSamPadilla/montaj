"""A project folder that cannot be written answers 409 `project_read_only` in
serve and the structured step error `project_read_only` in steps, never a raw
500 or a traceback. Nothing is written and no temp file is left."""
import json
import os
import stat
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

import lib.project_lock as pl  # noqa: E402
from tests.test_server_canvas_follows_footage import _setup as _serve_setup, client  # noqa: E402,F401
from tests.test_server_source_dims import PID  # noqa: E402

MESSAGE = ("This project's folder is read-only, so Montaj can't save changes to it. "
           "Make the folder writable (or copy the project somewhere writable) and try again.")

pytestmark = pytest.mark.skipif(os.name == "nt" or os.geteuid() == 0, reason="chmod")


@pytest.fixture
def read_only(request):
    """lock(dir) makes a folder read-only; the finalizer makes everything
    writable again so pytest can clean up."""
    made = []

    def lock(d):
        os.chmod(d, stat.S_IRUSR | stat.S_IXUSR)
        made.append(d)
    yield lock
    for d in made:
        os.chmod(d, 0o755)


def _error(capsys):
    err = [ln for ln in capsys.readouterr().err.strip().splitlines() if ln.startswith("{")]
    return json.loads(err[-1])


def test_update_project_raises_project_read_only(tmp_path, read_only):
    pj = tmp_path / "project.json"
    pj.write_text('{"a": 1}')
    read_only(tmp_path)
    with pytest.raises(pl.ProjectReadOnly) as ei:
        pl.update_project(pj, lambda p: {**p, "a": 2})
    assert str(ei.value) == MESSAGE
    assert isinstance(ei.value, RuntimeError)
    assert pj.read_text() == '{"a": 1}'
    assert not [f for f in os.listdir(tmp_path) if f.endswith(".tmp")]


def test_put_in_a_read_only_folder_is_409(client, tmp_path, read_only):
    c, holder = client
    holder["dir"] = d = _serve_setup(tmp_path)
    before = (d / "project.json").read_bytes()
    read_only(d)
    r = c.put(f"/api/projects/{PID}", json={"id": PID, "name": "x"})
    assert r.status_code == 409
    assert r.json()["detail"] == {"error": "project_read_only", "message": MESSAGE}
    assert (d / "project.json").read_bytes() == before
    assert not [f for f in os.listdir(d) if f.endswith(".tmp")]
    assert c.get(f"/api/projects/{PID}").status_code == 200


def test_the_app_maps_project_read_only_to_409():
    import asyncio
    from serve.server import app, _project_read_only_handler
    assert app.exception_handlers[pl.ProjectReadOnly] is _project_read_only_handler
    r = asyncio.run(_project_read_only_handler(None, pl.ProjectReadOnly()))
    assert r.status_code == 409
    assert json.loads(r.body)["detail"] == {"error": "project_read_only", "message": MESSAGE}


def test_update_project_or_fail_ends_the_step(tmp_path, read_only, capsys):
    pj = tmp_path / "project.json"
    pj.write_text("{}")
    read_only(tmp_path)
    from lib.common import fail
    with pytest.raises(SystemExit):
        pl.update_project_or_fail(pj, lambda p: {"x": 1}, fail)
    e = _error(capsys)
    assert (e["error"], e["message"]) == ("project_read_only", MESSAGE)


def test_project_lock_or_fail_ends_the_step(tmp_path, read_only, capsys):
    pj = tmp_path / "project.json"
    pj.write_text("{}")
    read_only(tmp_path)
    from lib.common import fail
    with pytest.raises(SystemExit):
        with pl.project_lock_or_fail(pj, fail):
            pl.write_json_atomic(pj, {"x": 1})
    assert _error(capsys)["error"] == "project_read_only"


def test_cut_steps_save_helper_ends_with_project_read_only(tmp_path, read_only, capsys):
    """jump_cut, cross_cut and montage save through save_project_changes."""
    from lib import ai_video
    pj = tmp_path / "project.json"
    pj.write_text(json.dumps({"tracks": []}))
    read_only(tmp_path)
    with pytest.raises(SystemExit):
        ai_video.save_project_changes(pj, {"tracks": []}, {"tracks": [{"id": "t"}]})
    assert _error(capsys)["error"] == "project_read_only"
    with pytest.raises(SystemExit):
        ai_video.save_project(pj, {"tracks": []})
    assert _error(capsys)["error"] == "project_read_only"


def test_background_writeback_drops_without_retrying(tmp_path, read_only):
    import asyncio
    import serve.routes.projects as routes
    pj = tmp_path / "project.json"
    pj.write_text("{}")
    calls = []

    def fn():
        calls.append(1)
        raise pl.ProjectReadOnly()
    assert asyncio.run(routes._locked_writeback([pj], fn)) is None
    assert calls == [1]


def test_generate_captions_and_approve_map_it():
    for rel in ("steps/transform/generate_captions.py", "cli/commands/approve.py", "cli/commands/regen.py"):
        src = (REPO_ROOT / rel).read_text()
        assert "project_read_only" in src, rel
