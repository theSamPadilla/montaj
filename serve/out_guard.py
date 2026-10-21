"""Where a step run through POST /api/steps/{name} may write: `check_step_out`.

A step's write params (`out`, `out-dir`, ...) used to pass through unchanged, so any caller of the steps
route (the app's window, overlay code running inside it, an AI agent through MCP run_step) could make a
native step write anywhere, including over code serve or node runs later (~/.cache/montaj/render/*.js,
~/.montaj/steps/*.py) or a shell rc file. A denylist of such places cannot be complete, so this is an
allowlist, checked before the step starts (sync and async alike):

- every step: a write path must resolve inside the workspace root, the system temp folder (on macOS also /tmp),
  or the folder of
  the project the step runs on, where that folder comes from serve's own record of the project id
  (`find_project_dir`), never from a path the caller gave;
- a param a NATIVE step's schema marks `"outKind": "export"` (a folder the user picks anywhere, e.g. ~/Movies)
  may also be any existing folder that is not hidden (no component starts with "."), not in ~/Library (except the
  iCloud Drive and ~/Library/CloudStorage/<provider> folders) or ~/AppData of the real user home, not in serve's HOME's .montaj or .cache, not in the montaj package and not
  in the Python install. Such a step writes only into a new folder it creates inside it. A custom step (from
  ~/.montaj/steps) never gets this, whatever its schema says.

Paths are compared by real path: the path itself, or when it does not exist yet its nearest existing ancestor
plus the rest, so a symlink anywhere counts as its target. A `..` component, a NUL and a URL scheme (`file:`,
which ffmpeg opens as a protocol) are refused outright. A relative path is the workspace's (the step's cwd), and
a `~` or `$VAR` in it is checked as what it may expand to as well.

Inventory (2026-10-21): the params a native step WRITES to (or deletes in), checked here.
  out, file, overwritten: detect_beats, extract_audio, mix_timeline, stem_separation (index), synth_audio,
      waveform_trim, caption, lyrics_sync, lyrics_render, detect_shots, shot_sheet (index), snapshot (a file, or
      a frames folder), normalize, paper_cutout, track_camera, track_pose, analyze_media (the model's reply
      text), fetch_image (refuses an existing file since this change), contact_sheet, sample_frame (+
      `<out>.clamped.json`), sample_overlay, sample_diff, transcribe (a prefix: `<out>.json`, `<out>.srt`),
      crop_spec, materialize_cut, normalize_window, proxy, remove_bg (+ `<stem>_preview.webm`), resize,
      generate_image, generate_music, generate_sfx, generate_voiceover, kling_generate, veo_generate (+ a
      normalized copy beside it), seedance_generate, kinovi_generate.
  out, file, never overwritten: generate_model, animate_model, rig_model (+ `<out>.tripo.json`, temps);
      fetch (yt-dlp keeps an existing file).
  out, folder: creator_diagnostic (stills/, diagnostic.json), glass_plate (its own NNNN.jpg frames).
  out, export folder (`"outKind": "export"`): export_editor, export_overlay_pages, export_carousel_pages; each
      makes a new folder inside it and changes nothing already there.
  out-dir, folder, files overwritten: stem_separation, waveform_image, capture_site, filmstrip, shot_sheet.
  frames-dir (contact_sheet, frames kept) and inbox (creator_diagnostic DELETES each measured video directly
      in it): `"outKind": "write"`.
  Not checked: `project` (the project.json a step reads; speech_edit and speech_text also write in its folder,
      and glass_plate, sample_frame and export_editor put their default output there). A project outside the
      workspace is opened by path, and the step needs a real project there to write anything.

Callers of the steps route that pass a write path (desktop app; the montaj CLI and its own MCP server run the
step scripts directly, so this guard does not see them):
  sample_overlay out     `.cache/overlay-previews/...`, `.cache/profile-overlay-previews/...` (relative: workspace)
  waveform_image out-dir `.cache/waveforms/<track>` (relative: workspace)
  filmstrip out-dir      `.cache/filmstrips/<project>/<key>` (relative: workspace)
  generate_image, sample_frame out  `/api/projects/{id}/reserve-path` (the project's folder: workspace)
  fetch out              `<workspace>/.imports/<job>` (the app's MCP import)
  export_overlay_pages, export_carousel_pages out  `<picked folder>/overlays|slides` (a user-picked folder,
                         default `<Movies>/Montaj/<project>`): the export branch
  run_step (MCP)         whatever the agent passes; the app's mcp.md tells it to leave `out` off and pass
                         `project`, which lands in the project's assets folder
"""
import json
import os
import re
import sys
import tempfile
import unicodedata
from pathlib import Path

from fastapi import HTTPException

from serve.common import MONTAJ_ROOT, find_project_dir, resolve_workspace

# Params a step writes to: these names on any step, and any param with an `outKind` ("write", or "export" for a
# user-picked export folder). The body may use the underscore spelling too. `out` is checked for every step,
# declared or not: build_cli_args passes it to any step that is given one.
WRITE_PARAMS = ("out", "out-dir")
EXPORT_OUT_KIND = "export"

# Body fields that may carry the id of the project a step runs on.
_PROJECT_ID_FIELDS = ("_project", "project-id", "project_id", "projectId", "project")


def _system_temp_dir() -> str:
    return os.path.realpath(tempfile.gettempdir())


def _is_darwin() -> bool:
    return sys.platform == "darwin"


def _temp_roots() -> list[str]:
    """The system temp folder; on macOS also /tmp (its realpath is /private/tmp), as tempfile.gettempdir() is
    /var/folders/... there and an agent writes /tmp/x.png. Nothing is executed from temp."""
    roots = [os.path.normcase(_system_temp_dir())]
    if _is_darwin():
        roots.append(os.path.normcase(os.path.realpath("/tmp")))
    return roots


def _real_home() -> str:
    """The user's real home. In the app serve's HOME is the app's runtime home, so not os.path.expanduser."""
    try:
        import pwd
        return pwd.getpwuid(os.getuid()).pw_dir
    except (ImportError, KeyError, AttributeError):
        return os.path.expanduser("~")  # Windows: USERPROFILE


def _serve_home() -> str:
    return os.path.expanduser("~")


def _real(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


def _within(path: str, root: str) -> bool:
    """`path` is `root` or below it. Both already real and normcased."""
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:  # different drives on Windows
        return False


def _fold(path: str) -> str:
    """For the export denylist only: case and Unicode folded, so `~/LIBRARY` on a case-insensitive disk (whose
    real path keeps the spelling given) still counts as ~/Library."""
    return unicodedata.normalize("NFKC", path).casefold()


# `file:`, `http:`, `pipe:` ...: ffmpeg opens such an output as a protocol URL (`file:/abs` writes there), so it is
# never the workspace-relative path it looks like. Two letters at least: `C:` is a Windows drive.
_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.\-]+:")


def _candidates(value: str) -> list[str] | None:
    """The absolute paths a step may take `value` to mean, or None for a value refused outright (a `..`
    component, a NUL, a URL scheme). Relative is the workspace's, the step's cwd; a leading `~` and environment
    variables are checked both as given and as what they may expand to (yt-dlp expands both)."""
    if "\x00" in value or ".." in re.split(r"[\\/]", value) or _SCHEME.match(value):
        return None
    out = [os.path.join(os.path.abspath(resolve_workspace()), value)]
    expanded = os.path.expandvars(os.path.expanduser(value))
    if expanded != value:
        if ".." in re.split(r"[\\/]", expanded):
            return None
        out.append(os.path.join(os.path.abspath(resolve_workspace()), expanded))
    return out


def _project_ids(body: dict) -> list[str]:
    """Project ids the body names: a plain id only. A path (a separator, absolute, `.`/`..`) grants nothing."""
    ids = []
    for field in _PROJECT_ID_FIELDS:
        v = body.get(field)
        if not isinstance(v, str):
            continue
        v = v.strip()
        if v and v not in (".", "..") and "\x00" not in v and not re.search(r"[\\/]", v) \
                and not os.path.isabs(v) and not v.startswith("~"):
            ids.append(v)
    return ids


def _project_roots(body: dict) -> list[str]:
    """Real folders of the projects the body names by id, from serve's own record."""
    roots = []
    ws = Path(resolve_workspace())
    for pid in _project_ids(body):
        found = find_project_dir(ws, pid)
        if found is not None:
            roots.append(_real(str(found)))
    return roots


def _deny_roots() -> list[str]:
    home, real_home = _serve_home(), _real_home()
    roots = [
        os.path.join(real_home, "Library"),
        os.path.join(real_home, "AppData"),
        os.path.join(home, ".montaj"),
        os.path.join(home, ".cache"),
        str(MONTAJ_ROOT),
        sys.prefix,
        sys.base_prefix,
    ]
    return [_fold(_real(r)) for r in roots]


def _cloud_roots() -> list[str]:
    """The two cloud-storage subtrees of ~/Library an export may go in (macOS only, by real path, folded):
    iCloud Drive (`Library/Mobile Documents/com~apple~CloudDocs`) and each File Provider sync folder
    (`Library/CloudStorage/<Provider>-<account>`: Dropbox, Google Drive, OneDrive, Box). Not `Mobile Documents`
    itself (other apps' containers), not `CloudStorage` itself, nothing else in ~/Library.
    Windows needs none: OneDrive lives under the home folder, not under AppData."""
    if not _is_darwin():
        return []
    lib = os.path.join(_real_home(), "Library")
    roots = [os.path.join(lib, "Mobile Documents", "com~apple~CloudDocs")]
    cloud = os.path.join(lib, "CloudStorage")
    try:
        roots += [os.path.join(cloud, e) for e in os.listdir(cloud)]
    except OSError:
        pass
    # An entry that is a link out of its parent (a CloudStorage/x pointing at ~/Library/LaunchAgents) opens nothing.
    parents = {os.path.dirname(r): _fold(_real(os.path.dirname(r))) for r in roots}
    out = []
    for r in roots:
        real = _fold(_real(r))
        if real != parents[os.path.dirname(r)] and _within(real, parents[os.path.dirname(r)]):
            out.append(real)
    return out


def _export_folder_ok(real: str) -> bool:
    """An existing folder a user may pick for an export: not hidden, not a system or app folder (cloud-storage
    folders in ~/Library excepted, `_cloud_roots`; their hidden folders are still refused)."""
    if not os.path.isdir(real):
        return False
    if any(part.startswith(".") for part in Path(real).parts):
        return False
    folded = _fold(real)
    library = _fold(_real(os.path.join(_real_home(), "Library")))
    cloud = any(_within(folded, r) for r in _cloud_roots())
    for root in _deny_roots():
        if _within(folded, root) and not (cloud and root == library):
            return False
    return True


def _write_values(schema: dict, body: dict):
    """(param name, export-marked, value as the step will get it) for each write path in the body."""
    params = {p["name"]: p for p in schema.get("params") or []
              if isinstance(p, dict) and isinstance(p.get("name"), str)}
    names = [n for n in params if n in WRITE_PARAMS or params[n].get("outKind")]
    if "out" not in names:
        names.append("out")
    for name in names:
        param = params.get(name) or {}
        for key in dict.fromkeys((name, name.replace("-", "_"))):
            if key not in body or body[key] is None:
                continue
            val = body[key]
            items = val if isinstance(val, list) else [val]
            for item in items:
                if item is None:
                    continue
                text = json.dumps(item) if isinstance(item, dict) else str(item)
                yield name, param.get("outKind") == EXPORT_OUT_KIND, text


def check_write_paths(name: str, items, body: dict, *, native: bool) -> None:
    """Refuse (403 out_not_allowed, naming the param, never the path) the first of `items`, (param name,
    export-marked, value) triples, that leaves the allowed places (module docstring). `body` names the project
    (for its folder). `native`: only then does an export mark count. Reads, changes nothing."""
    roots = None
    project_roots = None
    for param, export, value in items:
        cands = _candidates(value)
        ok = cands is not None
        for cand in cands or []:
            real = _real(cand)
            if roots is None:
                roots = [_real(str(resolve_workspace()))] + _temp_roots()
            if any(_within(real, r) for r in roots):
                continue
            if project_roots is None:
                project_roots = _project_roots(body)
            if any(_within(real, r) for r in project_roots):
                continue
            if export and native and _export_folder_ok(real):
                continue
            ok = False
            break
        if not ok:
            where = ("inside the workspace, the project's folder or the system temp folder, or an existing "
                     "folder that is not hidden and not a system or app folder"
                     if export and native else
                     "inside the workspace, the project's folder or the system temp folder")
            raise HTTPException(403, detail={
                "error": "out_not_allowed",
                "message": f"'{param}' of {name} must be {where}.",
            })


def check_step_out(name: str, schema: dict, body: dict, *, native: bool) -> None:
    """The write params of a step run through POST /api/steps/{name}: `check_write_paths` on each."""
    check_write_paths(name, _write_values(schema, body), body, native=native)


def check_route_out(name: str, body: dict) -> None:
    """The `out` of a serve route that is not a step run (/api/normalize, /api/proxy): the ordinary rule."""
    val = body.get("out")
    if val is None or val == "":
        return
    check_write_paths(name, [("out", False, str(val))], body, native=False)
