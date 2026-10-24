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
    """A workspace, somewhere else, the real home and serve's HOME, all apart. `systmp` is a folder that was
    the system temp allowance until M11 dropped it (2026-10-21), kept as another "outside" place to prove it
    is refused now."""
    p = {k: (tmp_path / k) for k in ("ws", "systmp", "elsewhere", "home", "servehome")}
    for d in p.values():
        d.mkdir()
    p = {k: Path(os.path.realpath(v)) for k, v in p.items()}
    monkeypatch.setenv("MONTAJ_WORKSPACE_DIR", str(p["ws"]))
    monkeypatch.setenv("HOME", str(p["servehome"]))
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


def test_the_workspace_is_allowed(places):
    allowed(PLAIN, {"out": ".cache/overlay-previews/ov-1.png", "out-dir": ".cache/filmstrips/p/k"})
    allowed(PLAIN, {"out": str(places["ws"] / "proj" / "assets" / "x.png")})
    allowed(PLAIN, {"out": "plain-name.png"})                    # a plain name is the workspace's
    allowed(PLAIN, {})                                           # nothing to check


def test_the_system_temp_folder_is_no_longer_allowed(places):
    # M11 (2026-10-21): temp dropped from the allowlist — nothing montaj ships writes a step out there.
    refused(PLAIN, {"out": str(places["systmp"] / "x.png")})
    refused(PLAIN, {"out": str(places["systmp"] / "new" / "x.png")})


def test_a_file_out_equal_to_a_root_is_refused_but_a_folder_out_may_equal_it(places):
    # low 13: a FILE output must be strictly below a root (transcribe writes `<out>.json` in the parent);
    # a folder output (out-dir) may equal a root.
    refused(PLAIN, {"out": str(places["ws"])})
    refused(PLAIN, {"out": "."})
    allowed(PLAIN, {"out-dir": str(places["ws"])})


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
    allowed(inbox, {"inbox": str(places["ws"] / "inbox")})
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


# ── firmlink / .app / system roots (M8) ──────────────────────────────────────

def test_a_dot_app_bundle_is_refused_as_an_export_target(places):
    schema = native_schema("export_editor")
    bundle = places["elsewhere"] / "Montaj.app" / "Contents"
    bundle.mkdir(parents=True)
    refused(schema, {"out": str(bundle)})
    refused(schema, {"out": str(places["elsewhere"] / "Montaj.app")})


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS system roots")
def test_real_system_roots_are_refused_as_export_targets(places):
    # Deny roots compare by dev:ino, so these real folders are refused whatever string reaches them (M8).
    schema = native_schema("export_editor")
    for root in ("/Applications", "/usr/local", "/opt/homebrew"):
        if os.path.isdir(root):
            refused(schema, {"out": root})


@pytest.mark.skipif(sys.platform != "darwin" or not os.path.isdir("/System/Volumes/Data"),
                    reason="macOS data-volume firmlink")
def test_the_system_volumes_firmlink_form_is_refused(places):
    # The firmlink-canonical form ~/Library becomes (/System/Volumes/Data/Users/.../Library) lives under
    # /System/Volumes/, which realpath leaves intact and this rule refuses outright (M8).
    schema = native_schema("export_editor")
    refused(schema, {"out": "/System/Volumes/Data"})


# ── beside-input steps (M9, deny-root) ────────────────────────────────────────
# A beside-input step with no `out` writes a fixed, step-chosen sidecar into the input's own folder. The
# sidecar name/suffix is the step's, never the caller's (proven in test_beside_input_defaults.py), so the
# folder is checked as a DENY location, not against the allowlist: a normal outside folder like ~/Desktop is
# allowed (an earlier round, M9, wrongly refused it); only hidden/system/package/home-config folders are
# refused. An explicit `out` is unchanged (the allowlist).


def _beside_schema(name="extract_audio"):
    return {"name": name, "input": {"type": "video"}, "params": []}


def test_a_beside_input_step_allows_the_workspace_and_a_normal_outside_folder(places):
    schema = _beside_schema()
    allowed(schema, {"input": str(places["ws"] / "clip.mp4")})          # workspace
    allowed(schema, {"input": "footage/clip.mp4"})                      # workspace-relative
    allowed(schema, {"input": str(places["elsewhere"] / "clip.mp4")})   # a normal outside folder (restored)
    # inputs (plural): both in ordinary folders → allowed.
    allowed(schema, {"inputs": [str(places["ws"] / "ok.mp4"), str(places["elsewhere"] / "bad.mp4")]})


def test_a_beside_input_step_refuses_a_deny_root_folder(places):
    # transcribe is the step mcp.md leaves `out` off for; S5 (the Windows smoke) hits exactly this.
    schema = _beside_schema("transcribe")

    # A hidden folder.
    hidden = places["elsewhere"] / ".secret"
    hidden.mkdir()
    refused(schema, {"input": str(hidden / "clip.mp4")})

    # Under the real home's ~/Library.
    lib = places["home"] / "Library" / "LaunchAgents"
    lib.mkdir(parents=True)
    refused(schema, {"input": str(lib / "clip.mp4")})
    refused(schema, {"input": str(places["home"] / "Library" / "clip.mp4")})

    # Under serve's HOME .montaj and .cache.
    montaj = places["servehome"] / ".montaj" / "steps"
    montaj.mkdir(parents=True)
    refused(schema, {"input": str(montaj / "clip.mp4")})
    cache = places["servehome"] / ".cache" / "montaj"
    cache.mkdir(parents=True)
    refused(schema, {"input": str(cache / "clip.mp4")})

    # One bad input among good ones still refuses the whole run.
    refused(schema, {"inputs": [str(places["ws"] / "ok.mp4"), str(lib / "bad.mp4")]})


@pytest.mark.skipif(sys.platform != "darwin" or not os.path.isdir("/System/Volumes/Data"),
                    reason="macOS data-volume firmlink")
def test_a_beside_input_under_the_system_volumes_firmlink_is_refused(places):
    # The firmlink form of ~/Library (/System/Volumes/Data/...) that realpath leaves intact is refused (M8).
    refused(_beside_schema("transcribe"), {"input": "/System/Volumes/Data/clip.mp4"})


def test_a_beside_input_into_a_git_folder_is_refused(places):
    # A `.git` folder is never a write target (H5), even inside the workspace.
    (places["ws"] / "proj" / ".git").mkdir(parents=True)
    refused(_beside_schema(), {"input": str(places["ws"] / "proj" / ".git" / "clip.mp4")})


def test_a_beside_input_with_a_dotdot_input_folder_is_refused(places):
    refused(_beside_schema(), {"input": "../outside/clip.mp4"})


def test_a_beside_input_step_with_an_explicit_out_is_not_a_beside_write(places):
    schema = {"name": "extract_audio", "input": {"type": "video"}, "params": [{"name": "out", "type": "path"}]}
    # With an allowed out, the outside input folder is not checked (it is only read).
    allowed(schema, {"input": str(places["elsewhere"] / "clip.mp4"), "out": str(places["ws"] / "a.wav")})
    # An explicit hostile out is still refused (the allowlist, unchanged).
    refused(schema, {"input": str(places["ws"] / "clip.mp4"), "out": str(places["elsewhere"] / "a.wav")})


def test_a_beside_input_spec_checks_each_segment_src_folder(places):
    # A spec input (mix_timeline / materialize_cut): each segments[].src folder is checked too. A src in a
    # normal outside folder is allowed; a src under a deny root refuses the run.
    (places["home"] / "Library").mkdir(parents=True, exist_ok=True)
    ok_spec = places["ws"] / "ok.json"
    ok_spec.write_text(json.dumps({"segments": [{"src": str(places["ws"] / "a.mp4")},
                                                {"src": str(places["elsewhere"] / "b.mp4")}]}))
    allowed({"name": "mix_timeline", "input": {"type": "video"}, "params": []}, {"input": str(ok_spec)})

    bad_spec = places["ws"] / "bad.json"
    bad_spec.write_text(json.dumps({"segments": [{"src": str(places["ws"] / "a.mp4")},
                                                 {"src": str(places["home"] / "Library" / "b.mp4")}]}))
    refused({"name": "mix_timeline", "input": {"type": "video"}, "params": []}, {"input": str(bad_spec)})


def test_a_trim_spec_checks_the_source_media_folder_not_just_the_spec(places):
    # The single-source trim spec {"input": ..., "keeps": [...]} (transcribe, materialize_cut): the step writes
    # its output BESIDE the spec's source media, so the source's folder faces the deny check, not only the spec
    # file's folder. A spec sitting in an allowed folder must not be a way to write a sidecar into a deny root.
    (places["home"] / "Library").mkdir(parents=True, exist_ok=True)
    for step in ("transcribe", "materialize_cut"):
        schema = {"name": step, "input": {"type": "video"}, "params": []}
        ok_spec = places["ws"] / f"ok_{step}.json"
        ok_spec.write_text(json.dumps({"input": str(places["elsewhere"] / "clip.mp4"), "keeps": [[0, 1]]}))
        allowed(schema, {"input": str(ok_spec)})

        # The spec is in an allowed folder, but its source media is under ~/Library: refused.
        bad_spec = places["ws"] / f"bad_{step}.json"
        bad_spec.write_text(json.dumps({"input": str(places["home"] / "Library" / "clip.mp4"), "keeps": [[0, 1]]}))
        refused(schema, {"input": str(bad_spec)})


# ── .git is never a write target (H5) ─────────────────────────────────────────

def test_a_git_component_in_a_write_path_is_refused(places):
    proj = places["ws"] / "proj"
    (proj / ".git" / "hooks").mkdir(parents=True)
    refused(PLAIN, {"out": str(proj / ".git" / "hooks" / "pre-commit")})
    refused(PLAIN, {"out": "proj/.git/config"})
    # a link with an innocent name that resolves into .git counts too
    (proj / "sneaky").symlink_to(proj / ".git", target_is_directory=True)
    refused(PLAIN, {"out": str(proj / "sneaky" / "config")})
    allowed(PLAIN, {"out": str(proj / "assets" / "x.png")})


# ── /tmp on macOS ────────────────────────────────────────────────────────────

@pytest.mark.skipif(sys.platform != "darwin", reason="/tmp is a link to /private/tmp on macOS only")
def test_tmp_is_no_longer_a_target(places):
    # M11: temp (and /tmp on macOS) was dropped from the allowlist.
    refused(PLAIN, {"out": "/tmp/x.png"})
    refused(PLAIN, {"out": "/private/tmp/new/x.png"})
    refused(PLAIN, {"out": "/private/etc/x.png"})


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
    for out in (str(places["ws"] / "proj" / "assets" / "x.mp4"), "rel/x.mp4"):
        r = client.post(f"/api/{route}", json={"input": str(media), "colorSpace": "sdr_bt709", "tonemap": False,
                                               "out": out})
        assert r.status_code == 200, (out, r.text)
    body = {"input": str(media), "colorSpace": "sdr_bt709", "tonemap": False}   # no out: the route's default
    assert client.post(f"/api/{route}", json=body).status_code != 403


# ── an out is a workspace file, never a protocol (§563 review) ──────────────

def test_every_ffmpeg_scheme_form_is_refused(places):
    """ffmpeg reads any run of [A-Za-z0-9+.-] (two or more) before a ':' as a protocol, a digit or '.' first too."""
    for out in ("http://host/x.wav", "HTTP://host/x.wav", "tee:a.wav|b.wav", "fd:3", "crypto+http://h/x",
                "1a:x.wav", ".x:y.wav", "-x:y.wav", "+x:y.wav"):
        refused(PLAIN, {"out": out})
    allowed(PLAIN, {"out": "a/http/x.wav"})


def test_a_relative_out_reaches_the_step_as_the_workspace_file(places, client, monkeypatch, tmp_path):
    """The step gets `--out <workspace>/<out>`: the file the guard checked, and an absolute path no ffmpeg reads
    as a protocol. The stub step only echoes its argv; nothing runs ffmpeg or touches the network."""
    py = tmp_path / "plain.py"
    py.write_text(ECHO)
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {"plain": (PLAIN, py)})
    for out in ("clips/x.wav", " http://host/x.wav", "./http://host/x.wav"):
        r = client.post("/api/steps/plain", json={"out": out})
        assert r.status_code == 200, r.text
        argv = r.json()["argv"]
        assert argv.count("--out") == 1  # a declared `out` used to go in twice
        assert argv[argv.index("--out") + 1] == os.path.join(str(places["ws"]), out)
    r = client.post("/api/steps/plain", json={"out": "http://host/x.wav"})
    assert r.status_code == 403


def test_an_empty_out_reaches_the_step_empty(places, client, monkeypatch, tmp_path):
    """out "" means no out (an export step then refuses or picks its own folder); it must not become the workspace
    root (§563 final review)."""
    assert steps_mod.build_cli_args(PLAIN, {"out": ""}) == ["--out", ""]
    # Through the route, as a native export step (whose export folder the guard lets be ""): the step gets "".
    native = tmp_path / "montaj" / "steps"
    (native / "render").mkdir(parents=True)
    py = native / "render" / "export_editor.py"
    py.write_text(ECHO)
    monkeypatch.setattr(steps_mod, "NATIVE_STEPS_DIR", native)
    schema = native_schema("export_editor")
    monkeypatch.setattr(steps_mod, "scan_steps", lambda: {"export_editor": (schema, py)})
    proj = places["ws"] / "proj"
    proj.mkdir()
    (proj / "project.json").write_text(json.dumps({"version": "0.2", "id": "p", "tracks": []}))
    r = client.post("/api/steps/export_editor", json={"project": str(proj / "project.json"), "out": ""})
    assert r.status_code == 200, r.text
    argv = r.json()["argv"]
    assert argv[argv.index("--out") + 1] == ""
