"""PL89i: a path typed with an ASCII space where the file's name has U+202F (every macOS screen recording and
screenshot names its time "11.59.52 AM"), another Unicode space, or another Unicode form, finds that file:
in lib/path_match.py, in a step's input through serve, in an item src a save writes, in /api/files and in
frame_broll's clip. A real kung fu run lost 14 calls to it: snapshot "File not found" five times, globs, then
frame_broll "The clip's file is missing" on the src it saved."""
import json
import os
import sys
import textwrap
import unicodedata
from pathlib import Path

import pytest
from starlette.testclient import TestClient

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

from lib.path_match import space_key, spaced_twin, spaced_twins  # noqa: E402
from serve.server import app  # noqa: E402
import serve.routes.steps as steps_mod  # noqa: E402
from tests.test_server_canvas_follows_footage import _setup as _serve_setup, client  # noqa: E402,F401
from tests.test_server_source_dims import PID  # noqa: E402

REAL = "Screen Recording 2026-10-21 at 11.59.52 AM.mov"
TYPED = "Screen Recording 2026-10-21 at 11.59.52 AM.mov"


def test_space_key_reads_every_unicode_space_as_a_space_and_nfd_as_nfc():
    assert space_key(REAL) == TYPED
    assert space_key("a\u00a0b\u2007c\u2009d\u3000e") == "a b c d e"
    assert space_key(unicodedata.normalize("NFD", "café")) == "café"


def test_spaced_twin_finds_the_one_file_and_never_guesses(tmp_path):
    real = tmp_path / REAL
    real.write_bytes(b"x")
    assert spaced_twin(str(tmp_path / TYPED)) == str(real)
    assert spaced_twin(str(real)) is None, "an existing path has no twin: it is used as it is"
    assert spaced_twin(str(tmp_path / "nothing.mov")) is None
    nfd = tmp_path / unicodedata.normalize("NFD", "Café shot.png")
    nfd.write_bytes(b"x")
    if not (tmp_path / "Café shot.png").exists():   # APFS finds an NFC name for an NFD file by itself
        assert spaced_twin(str(tmp_path / "Café shot.png")) == str(nfd)
    (tmp_path / "clip\u202fA.mov").write_bytes(b"x")
    (tmp_path / "clip\u00a0A.mov").write_bytes(b"x")
    assert spaced_twin(str(tmp_path / "clip A.mov")) is None
    assert [os.path.basename(h) for h in spaced_twins(str(tmp_path / "clip A.mov"))] == ["clip\u00a0A.mov", "clip\u202fA.mov"]


# ── a step's input, through serve ───────────────────────────────────────────

ECHO = textwrap.dedent("""\
    import sys
    print("ARGV=" + repr(sys.argv[1:]))
""")


@pytest.fixture()
def echo_step(tmp_path, monkeypatch):
    py = tmp_path / "echo_paths.py"
    py.write_text(ECHO)
    schema = {"name": "echo_paths", "input": {"type": "video"},
              "params": [{"name": "ref", "type": "path"}, {"name": "out", "type": "path", "outKind": "write"}],
              "output": {"type": "text"}}
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {"echo_paths": (schema, py)})
    return py


def test_a_step_input_typed_with_an_ascii_space_runs_on_the_real_file(tmp_path, echo_step):
    (tmp_path / REAL).write_bytes(b"x")
    c = TestClient(app, raise_server_exceptions=False)
    r = c.post("/api/steps/echo_paths", json={"input": str(tmp_path / TYPED), "ref": str(tmp_path / TYPED)})
    assert r.status_code == 200, r.text
    argv = r.json()["path"]  # the echo step prints repr(argv): U+202F shows escaped
    assert argv.count(repr(str(tmp_path / REAL))) == 2, argv
    assert TYPED not in argv


def test_a_step_input_that_matches_several_files_is_a_422_naming_them(tmp_path, echo_step):
    (tmp_path / "clip A.mov").write_bytes(b"x")
    (tmp_path / "clip A.mov").write_bytes(b"x")
    r = TestClient(app, raise_server_exceptions=False).post("/api/steps/echo_paths", json={"input": str(tmp_path / "clip A.mov")})
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "ambiguous_path" and len(r.json()["detail"]["matches"]) == 2


# ── an item src a save writes ───────────────────────────────────────────────

def test_a_saved_item_src_typed_with_an_ascii_space_is_saved_as_the_real_name(client, tmp_path):
    c, holder = client
    holder["dir"] = d = _serve_setup(tmp_path)
    (d / REAL).write_bytes(b"x")
    item = {"id": "broll-1", "type": "video", "src": str(d / TYPED), "start": 0, "end": 1, "inPoint": 0, "outPoint": 1}
    rel = {"id": "broll-2", "type": "video", "src": TYPED, "start": 1, "end": 2, "inPoint": 0, "outPoint": 1}
    gone = {"id": "broll-3", "type": "video", "src": str(d / "gone.mov"), "start": 2, "end": 3, "inPoint": 0, "outPoint": 1}
    r = c.put(f"/api/projects/{PID}", json={"id": PID, "tracks": [{"id": "trk-0", "items": [item, rel, gone]}]})
    assert r.status_code == 200, r.text
    saved = {it["id"]: it["src"] for it in json.loads((d / "project.json").read_text())["tracks"][0]["items"]}
    assert saved == {"broll-1": str(d / REAL), "broll-2": REAL, "broll-3": str(d / "gone.mov")}
    warnings = r.json()["warnings"]
    assert len(warnings) == 2 and warnings[0].startswith("broll-1: no file at") and str(d / REAL) in warnings[0]
    assert warnings[1].startswith("broll-2:") and "broll-3" not in " ".join(warnings)


def test_a_saved_src_that_matches_several_files_is_kept_and_named(client, tmp_path):
    c, holder = client
    holder["dir"] = d = _serve_setup(tmp_path)
    (d / "clip A.mov").write_bytes(b"x")
    (d / "clip A.mov").write_bytes(b"x")
    item = {"id": "v1", "type": "video", "src": str(d / "clip A.mov"), "start": 0, "end": 1, "inPoint": 0, "outPoint": 1}
    r = c.put(f"/api/projects/{PID}", json={"id": PID, "tracks": [{"id": "trk-0", "items": [item]}]})
    assert r.status_code == 200, r.text
    assert json.loads((d / "project.json").read_text())["tracks"][0]["items"][0]["src"] == str(d / "clip A.mov")
    (w,) = r.json()["warnings"]
    assert w.startswith("v1: no file at") and "clip\u202fA.mov" in w and "clip\u00a0A.mov" in w


# ── /api/files (read_file) ──────────────────────────────────────────────────

def test_api_files_reads_a_typed_space_and_names_several(client, tmp_path, monkeypatch):
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(tmp_path))  # /api/files serves only inside the allowed roots
    c, holder = client
    holder["dir"] = d = _serve_setup(tmp_path)
    (d / REAL).write_bytes(b"hello")
    r = c.get("/api/files", params={"path": str(d / TYPED)})
    assert r.status_code == 200, r.text
    assert r.content == b"hello"
    (d / "clip\u202fA.mov").write_bytes(b"x")
    (d / "clip\u00a0A.mov").write_bytes(b"x")
    r = c.get("/api/files", params={"path": str(d / "clip A.mov")})
    assert r.status_code == 400 and "clip\u202fA.mov" in r.json()["detail"]["message"]
