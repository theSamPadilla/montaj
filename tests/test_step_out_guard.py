"""serve/out_guard.py: where a step run through POST /api/steps/{name} may write.

Every step: a write path (`out`, `out-dir`, any `outKind` param) must resolve inside the workspace, the
system temp folder, or the folder of the project the step runs on, by serve's own record of its id. A NATIVE
step's `"outKind": "export"` param may also be an existing folder that is not hidden and not a system or app
folder. Nothing here runs a real step: the route tests use a fake step, and the matrix calls the guard.
"""
import json
import os
import sys
import textwrap
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient

import serve.out_guard as guard
import serve.routes.steps as steps_mod
from serve.common import MONTAJ_ROOT
from serve.server import app

ROOT = Path(__file__).resolve().parent.parent


def native_schema(name):
    for f in (ROOT / "steps").rglob(f"{name}.json"):
        return json.loads(f.read_text())
    raise AssertionError(f"no step {name}")


PLAIN = {"name": "plain", "params": [{"name": "out", "type": "path"}, {"name": "out-dir", "type": "string"}]}


@pytest.fixture()
def places(tmp_path, monkeypatch):
    """A workspace, a stand-in system temp folder, somewhere else, the real home and serve's HOME, all apart.
    (pytest's own tmp_path is under the real temp folder, so the guard's temp folder is swapped for one here.)"""
    p = {k: (tmp_path / k) for k in ("ws", "systmp", "elsewhere", "home", "servehome")}
    for d in p.values():
        d.mkdir()
    p = {k: Path(os.path.realpath(v)) for k, v in p.items()}
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(p["ws"]))
    monkeypatch.setenv("HOME", str(p["servehome"]))
    monkeypatch.setattr(guard, "_system_temp_dir", lambda: str(p["systmp"]))
    monkeypatch.setattr(guard, "_real_home", lambda: str(p["home"]))
    return p


def refused(schema, body, native=True):
    with pytest.raises(HTTPException) as e:
        guard.check_step_out(schema.get("name", "x"), schema, body, native=native)
    assert e.value.status_code == 403 and e.value.detail["error"] == "out_not_allowed"
    return e.value.detail


def allowed(schema, body, native=True):
    guard.check_step_out(schema.get("name", "x"), schema, body, native=native)


# ── every step ───────────────────────────────────────────────────────────────

def test_dot_dot_is_refused_even_when_it_would_land_inside(places):
    refused(PLAIN, {"out": "../x.png"})
    refused(PLAIN, {"out": "a/../../x.png"})
    refused(PLAIN, {"out": str(places["ws"] / "a" / ".." / "x.png")})
    refused(PLAIN, {"out": "a\\..\\x.png"})


def test_an_absolute_path_outside_is_refused_naming_the_param_not_the_path(places):
    target = str(places["elsewhere"] / "x.png")
    detail = refused(PLAIN, {"out": target})
    assert "'out'" in detail["message"] and target not in detail["message"] and "elsewhere" not in detail["message"]
    detail = refused(PLAIN, {"out-dir": str(places["elsewhere"])})
    assert "'out-dir'" in detail["message"]
    refused(PLAIN, {"out_dir": str(places["elsewhere"])})       # the underscore spelling too
    refused(PLAIN, {"out": "/etc/x"})


def test_out_is_checked_on_a_step_that_does_not_declare_it(places):
    refused({"name": "nodecl", "params": []}, {"out": str(places["elsewhere"] / "x")})


def test_a_symlink_inside_the_workspace_that_points_outside_is_refused(places):
    (places["ws"] / "link").symlink_to(places["elsewhere"], target_is_directory=True)
    refused(PLAIN, {"out": str(places["ws"] / "link" / "x.png")})
    refused(PLAIN, {"out": "link/x.png"})
    refused(PLAIN, {"out": "link/new/deeper/x.png"})
    # a link to a file outside, used as the out itself
    (places["elsewhere"] / "target.txt").write_text("keep")
    (places["ws"] / "f.png").symlink_to(places["elsewhere"] / "target.txt")
    refused(PLAIN, {"out": "f.png"})


def test_a_path_that_does_not_exist_yet_is_judged_by_its_nearest_existing_folder(places):
    allowed(PLAIN, {"out": str(places["ws"] / "a" / "b" / "c" / "x.png")})
    allowed(PLAIN, {"out": "new/deep/x.png"})
    refused(PLAIN, {"out": str(places["elsewhere"] / "a" / "b" / "x.png")})


def test_the_workspace_and_the_system_temp_folder_are_allowed(places):
    allowed(PLAIN, {"out": ".cache/overlay-previews/ov-1.png", "out-dir": ".cache/filmstrips/p/k"})
    allowed(PLAIN, {"out": str(places["ws"] / "proj" / "assets" / "x.png")})
    allowed(PLAIN, {"out": str(places["systmp"] / "x.png")})
    allowed(PLAIN, {"out": str(places["systmp"] / "new" / "x.png")})
    allowed(PLAIN, {"out": "plain-name.png"})                    # a plain name is the workspace's
    allowed(PLAIN, {})                                           # nothing to check


def test_a_leading_tilde_is_checked_as_the_home_it_may_expand_to(places):
    # Taken literally it is `<workspace>/~/x`; expanded it is serve's HOME, outside.
    refused(PLAIN, {"out": "~/x.png"})


def test_an_environment_variable_is_checked_as_what_it_expands_to(places):
    # yt-dlp (fetch) expands $VAR in its output; literally these are workspace paths.
    refused(PLAIN, {"out": "$HOME/.montaj/steps/x.py"})
    refused(PLAIN, {"out": "${HOME}/x.png"})
    allowed(PLAIN, {"out": "$MONTAJ_WORKSPACE_DIR/x.png"})


@pytest.mark.parametrize("url", ["file:/etc/x.mp4", "file:x.mp4", "http://example.com/up", "pipe:1", "tcp://h:1"])
def test_a_url_scheme_is_refused(places, url):
    # ffmpeg opens these as protocols, never as the workspace path they look like.
    refused(PLAIN, {"out": url})


def test_list_values_and_write_marked_params_are_checked(places):
    schema = {"name": "lst", "params": [{"name": "keep", "type": "path", "outKind": "write"}]}
    refused(schema, {"keep": [str(places["ws"] / "a"), str(places["elsewhere"] / "b")]})
    allowed(schema, {"keep": [str(places["ws"] / "a")]})


def test_native_write_params_are_marked(places):
    inbox = native_schema("creator_diagnostic")
    refused(inbox, {"inbox": str(places["elsewhere"])})          # it deletes the videos in it
    allowed(inbox, {"inbox": str(places["systmp"] / "inbox")})
    sheet = native_schema("contact_sheet")
    refused(sheet, {"frames-dir": str(places["elsewhere"]), "out": "s.png"})


# ── the project the step runs on ─────────────────────────────────────────────

@pytest.fixture()
def outside_project(places, monkeypatch):
    """A project outside the workspace that serve's record knows by id (find_project_dir is the record)."""
    proj = places["elsewhere"] / "proj"
    (proj / "assets").mkdir(parents=True)
    (proj / "project.json").write_text(json.dumps({"id": "p-out"}))
    other = places["elsewhere"] / "other"
    other.mkdir()
    (other / "project.json").write_text(json.dumps({"id": "p-other"}))
    record = {"p-out": proj, "p-other": other}
    monkeypatch.setattr(guard, "find_project_dir", lambda ws, pid: record.get(pid))
    return proj


@pytest.mark.parametrize("field", ["_project", "project-id", "project_id", "projectId", "project"])
def test_an_out_inside_the_project_the_step_runs_on_is_allowed(outside_project, field):
    allowed(PLAIN, {field: "p-out", "out": str(outside_project / "assets" / "x.png")})
    allowed(PLAIN, {field: "p-out", "out": str(outside_project / "new" / "x.png")})


def test_the_same_out_with_another_project_or_none_is_refused(outside_project):
    out = str(outside_project / "assets" / "x.png")
    refused(PLAIN, {"_project": "p-other", "out": out})
    refused(PLAIN, {"project-id": "nope", "out": out})
    refused(PLAIN, {"out": out})


def test_a_project_path_grants_nothing(outside_project):
    out = str(outside_project / "assets" / "x.png")
    refused(PLAIN, {"project": str(outside_project / "project.json"), "out": out})
    refused(PLAIN, {"project": str(outside_project), "out": out})
    refused(PLAIN, {"_project": str(outside_project), "out": out})
    refused(PLAIN, {"project": "../elsewhere/proj", "out": out})


def test_the_real_record_finds_a_workspace_project_by_id(places):
    proj = places["ws"] / "team" / "proj"
    proj.mkdir(parents=True)
    (proj / "project.json").write_text(json.dumps({"id": "p-in"}))
    assert guard._project_roots({"project": "p-in"}) == [os.path.normcase(os.path.realpath(proj))]
    assert guard._project_roots({"project": str(proj)}) == []


# ── export folders ───────────────────────────────────────────────────────────

EXPORTS = ["export_editor", "export_overlay_pages", "export_carousel_pages"]


@pytest.mark.parametrize("step", EXPORTS)
def test_export_steps_mark_out_as_export(step):
    out = next(p for p in native_schema(step)["params"] if p["name"] == "out")
    assert out.get("outKind") == "export"


@pytest.mark.parametrize("step", EXPORTS)
def test_an_export_may_go_in_an_ordinary_existing_folder(places, step):
    picked = places["elsewhere"] / "Movies" / "Montaj"
    picked.mkdir(parents=True)
    allowed(native_schema(step), {"project": "p", "out": str(picked)})
    allowed(native_schema(step), {"project": "p", "out": str(places["ws"] / "proj" / "export")})  # workspace: may be new


@pytest.mark.parametrize("step", EXPORTS)
def test_an_export_outside_the_workspace_must_be_an_existing_folder(places, step):
    refused(native_schema(step), {"out": str(places["elsewhere"] / "not-yet")})
    (places["elsewhere"] / "a-file").write_text("x")
    refused(native_schema(step), {"out": str(places["elsewhere"] / "a-file")})


def test_an_export_into_a_hidden_folder_is_refused(places):
    schema = native_schema("export_editor")
    hidden = places["elsewhere"] / ".config" / "autostart"
    hidden.mkdir(parents=True)
    refused(schema, {"out": str(hidden)})
    refused(schema, {"out": str(places["elsewhere"] / ".config")})
    # a link with an ordinary name to a hidden folder counts as its target
    (places["elsewhere"] / "plain").symlink_to(hidden, target_is_directory=True)
    refused(schema, {"out": str(places["elsewhere"] / "plain")})


def test_an_export_into_library_of_the_real_home_is_refused(places):
    schema = native_schema("export_overlay_pages")
    agents = places["home"] / "Library" / "LaunchAgents"
    agents.mkdir(parents=True)
    refused(schema, {"out": str(agents)})
    refused(schema, {"out": str(places["home"] / "Library")})
    # spelled in another case (a case-insensitive disk keeps the spelling given)
    other_case = places["home"] / "LIBRARY" / "LaunchAgents"
    if not other_case.exists():
        other_case.mkdir(parents=True)
    refused(schema, {"out": str(other_case)})
    docs = places["home"] / "Documents"
    docs.mkdir()
    allowed(schema, {"out": str(docs)})


def test_an_export_into_app_code_is_refused(places):
    schema = native_schema("export_carousel_pages")
    refused(schema, {"out": str(MONTAJ_ROOT / "steps")})
    refused(schema, {"out": os.path.realpath(sys.prefix)})
    refused(schema, {"out": os.path.realpath(sys.base_prefix)})
    montaj_home = places["servehome"] / ".montaj" / "steps"
    montaj_home.mkdir(parents=True)
    refused(schema, {"out": str(montaj_home)})


def test_a_custom_step_cannot_opt_in_to_export(places):
    picked = places["elsewhere"] / "Exports"
    picked.mkdir()
    schema = native_schema("export_editor")
    allowed(schema, {"out": str(picked)}, native=True)
    refused(schema, {"out": str(picked)}, native=False)


# ── through the route ────────────────────────────────────────────────────────

ECHO = textwrap.dedent("""\
    import json, sys
    print(json.dumps({"argv": sys.argv[1:]}))
""")


@pytest.fixture()
def client():
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def test_the_route_refuses_before_the_step_runs_sync_and_async(places, client, monkeypatch, tmp_path):
    ran = tmp_path / "ran"
    py = tmp_path / "plain.py"
    py.write_text(f"open({str(ran)!r}, 'w').write('x')\n" + ECHO)
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {"plain": (PLAIN, py)})
    out = str(places["elsewhere"] / "x.png")
    for body in ({"out": out}, {"out": out, "_async": True}):
        r = client.post("/api/steps/plain", json=body)
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["error"] == "out_not_allowed"
        assert out not in r.text
    assert not ran.exists()
    r = client.post("/api/steps/plain", json={"out": str(places["ws"] / "x.png")})
    assert r.status_code == 200, r.text
    assert ran.exists()


def test_the_route_gives_a_custom_export_step_no_export_folder(places, client, monkeypatch, tmp_path):
    """A step from ~/.montaj/steps that copies export_editor's schema, name and all, is still custom."""
    custom = places["servehome"] / ".montaj" / "steps"
    custom.mkdir(parents=True)
    schema = native_schema("export_editor")
    (custom / "export_editor.json").write_text(json.dumps(schema))
    (custom / "export_editor.py").write_text(ECHO)
    monkeypatch.setattr(steps_mod, "scan_steps",
                        lambda: {"export_editor": (schema, custom / "export_editor.py")})
    picked = places["elsewhere"] / "Exports"
    picked.mkdir()
    r = client.post("/api/steps/export_editor", json={"project": "p", "out": str(picked)})
    assert r.status_code == 403 and r.json()["detail"]["error"] == "out_not_allowed"


# ── cloud-storage folders in ~/Library ───────────────────────────────────────

@pytest.fixture()
def darwin(monkeypatch):
    monkeypatch.setattr(guard, "_is_darwin", lambda: True)


def test_icloud_drive_and_file_provider_folders_are_export_targets(places, darwin):
    schema = native_schema("export_overlay_pages")
    icloud = places["home"] / "Library" / "Mobile Documents" / "com~apple~CloudDocs" / "Exports"
    icloud.mkdir(parents=True)
    dropbox = places["home"] / "Library" / "CloudStorage" / "Dropbox-Acme" / "Videos"
    dropbox.mkdir(parents=True)
    allowed(schema, {"out": str(icloud)})
    allowed(schema, {"out": str(icloud.parent)})            # iCloud Drive itself
    allowed(schema, {"out": str(dropbox)})
    allowed(schema, {"out": str(dropbox.parent)})           # the provider's root


def test_a_hidden_folder_inside_a_cloud_folder_is_still_refused(places, darwin):
    schema = native_schema("export_overlay_pages")
    hidden = places["home"] / "Library" / "CloudStorage" / "GoogleDrive-a@b.c" / ".shortcut-targets"
    hidden.mkdir(parents=True)
    refused(schema, {"out": str(hidden)})
    hidden2 = places["home"] / "Library" / "Mobile Documents" / "com~apple~CloudDocs" / ".Trash"
    hidden2.mkdir(parents=True)
    refused(schema, {"out": str(hidden2)})


def test_nothing_else_in_library_opens_up(places, darwin):
    schema = native_schema("export_overlay_pages")
    lib = places["home"] / "Library"
    for sub in ("LaunchAgents", "Mobile Documents", "Mobile Documents/com~apple~Notes", "CloudStorage",
                "Application Support"):
        (lib / sub).mkdir(parents=True, exist_ok=True)
        refused(schema, {"out": str(lib / sub)})
    # a link inside CloudStorage that points into LaunchAgents counts as its target
    (lib / "CloudStorage" / "Evil-x").symlink_to(lib / "LaunchAgents", target_is_directory=True)
    refused(schema, {"out": str(lib / "CloudStorage" / "Evil-x")})


def test_the_cloud_folders_are_not_opened_off_macos(places, monkeypatch):
    monkeypatch.setattr(guard, "_is_darwin", lambda: False)
    icloud = places["home"] / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
    icloud.mkdir(parents=True)
    refused(native_schema("export_overlay_pages"), {"out": str(icloud)})


def test_a_cloud_folder_is_no_ordinary_step_target(places, darwin):
    icloud = places["home"] / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
    icloud.mkdir(parents=True)
    refused(PLAIN, {"out": str(icloud / "x.png")})          # the carve-out is for export steps only


# ── /tmp on macOS ────────────────────────────────────────────────────────────

@pytest.mark.skipif(sys.platform != "darwin", reason="/tmp is a link to /private/tmp on macOS only")
def test_tmp_counts_as_temp_on_macos(places):
    allowed(PLAIN, {"out": "/tmp/x.png"})
    allowed(PLAIN, {"out": "/private/tmp/new/x.png"})
    refused(PLAIN, {"out": "/private/etc/x.png"})
    refused(PLAIN, {"out": "/private/var/x.png"})


# ── /api/normalize and /api/proxy ────────────────────────────────────────────

@pytest.fixture()
def media(places):
    f = places["ws"] / "in.mp4"
    f.write_bytes(b"x")
    return f


def _stub_routes(monkeypatch):
    calls = []
    monkeypatch.setattr(steps_mod, "_normalize_sync",
                        lambda i, c, o: calls.append(o) or {"path": o or i, "skipped": False})
    import lib.proxy as proxy
    monkeypatch.setattr(proxy, "is_proxy_fresh", lambda out, src: True)
    return calls


@pytest.mark.parametrize("route", ["normalize", "proxy"])
def test_normalize_and_proxy_refuse_an_out_outside(places, client, media, monkeypatch, route):
    calls = _stub_routes(monkeypatch)
    (places["ws"] / "link").symlink_to(places["elsewhere"], target_is_directory=True)
    bad = ["../x.mp4", str(places["elsewhere"] / "x.mp4"), "/etc/x.mp4", "link/x.mp4",
           str(places["ws"] / "link" / "new" / "x.mp4"), "file:/etc/x.mp4"]
    for out in bad:
        r = client.post(f"/api/{route}", json={"input": str(media), "colorSpace": "sdr_bt709", "tonemap": False,
                                               "out": out})
        assert r.status_code == 403, (out, r.text)
        assert r.json()["detail"]["error"] == "out_not_allowed"
        assert "'out'" in r.json()["detail"]["message"] and out not in r.json()["detail"]["message"]
    assert calls == []


@pytest.mark.parametrize("route", ["normalize", "proxy"])
def test_normalize_and_proxy_accept_an_out_in_the_workspace_or_none(places, client, media, monkeypatch, route):
    _stub_routes(monkeypatch)
    for out in (str(places["ws"] / "proj" / "assets" / "x.mp4"), "rel/x.mp4", str(places["systmp"] / "x.mp4")):
        r = client.post(f"/api/{route}", json={"input": str(media), "colorSpace": "sdr_bt709", "tonemap": False,
                                               "out": out})
        assert r.status_code == 200, (out, r.text)
    body = {"input": str(media), "colorSpace": "sdr_bt709", "tonemap": False}   # no out: the route's default
    assert client.post(f"/api/{route}", json=body).status_code != 403
