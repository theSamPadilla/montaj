"""Where a step run through POST /api/steps/{name} may write: `check_step_out`.

A step's write params (`out`, `out-dir`, ...) used to pass through unchanged, so any caller of the steps
route (the app's window, overlay code running inside it, an AI agent through MCP run_step) could make a
native step write anywhere, including over code serve or node runs later (~/.cache/montaj/render/*.js,
~/.montaj/steps/*.py) or a shell rc file. A denylist of such places cannot be complete, so this is an
allowlist, checked before the step starts (sync and async alike):

- every step: a write path must resolve inside the workspace root, or the folder of
  the project the step runs on, where that folder comes from serve's own record of the project id
  (`find_project_dir`), never from a path the caller gave. The system temp folder is NO LONGER an allowed
  target (M11, 2026-10-21): nothing montaj ships writes a step `out` to temp, no documented MCP flow needs it,
  and allowing it reached engine caches reused without content checks. A FILE output must be STRICTLY below one of those
  (not equal to it), because a prefix-style `out` (transcribe writes `<out>.json`) would otherwise write in
  the root's parent (low 13); a folder output (`out-dir`, `frames-dir`, `inbox`, an export folder) may equal a
  root. No write path may name a `.git` component (H5): serve shells git in a project, so a written hook or
  config would run.
- a param a NATIVE step's schema marks `"outKind": "export"` (a folder the user picks anywhere, e.g. ~/Movies)
  may also be any existing folder that is not hidden (no component starts with "."), not under `/System/Volumes/`,
  not an `.app` bundle, not in ~/Library (except the iCloud Drive and ~/Library/CloudStorage/<provider> folders)
  or ~/AppData of the real user home, not in serve's HOME's .montaj or .cache, not in the montaj package, the
  Python install, /Applications, /usr/local or /opt/homebrew. Deny roots compare by dev:ino, so a firmlink form
  of any of them (`/System/Volumes/Data/Users/<u>/Library/...`) is refused too (M8). Such a step writes only
  into a new folder it creates inside the picked one. A custom step (from ~/.montaj/steps) never gets this,
  whatever its schema says.
- a BESIDE_INPUT step (M9: extract_audio, normalize, resize, ...) run with NO write param writes into whatever
  folder holds each input, so that folder (and each spec `segments[].src` folder) is checked as a write path.
  For a project inside the workspace this is the project's own folder (allowed), so `mcp.md`'s guidance to omit
  `out` and pass `project` still works; an input OUTSIDE the allowed roots with no `out` is refused.

Paths are compared by real path: the path itself, or when it does not exist yet its nearest existing ancestor
plus the rest, so a symlink anywhere counts as its target. A `..` component, a NUL and a URL scheme (`file:`,
`pipe:`, `concat:`, `subfile,`, which ffmpeg opens as a protocol) are refused outright. A relative path is the
workspace's (the step's cwd), and a `~` or `$VAR` in it is checked as what it may expand to as well.

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
  beside the input when `out` is omitted (BESIDE_INPUT_STEPS, M9): extract_audio, normalize, resize, snapshot,
      stem_separation, waveform_image, caption, lyrics_sync, lyrics_render, crop_spec, paper_cutout, remove_bg,
      mix_timeline, materialize_cut, transcribe. The input's folder (and each spec `segments[].src` folder) is
      then checked as the write path.
  `project` (the id or folder of the project a step reads; speech_edit and speech_text also write in its folder,
      and glass_plate, sample_frame and export_editor put their default output there) is confined to a project
      serve finds by id or a path INSIDE the workspace (steps.py, low 14); an absolute path elsewhere no longer
      passes through, and grants no write root.

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
import unicodedata
from pathlib import Path

from fastapi import HTTPException

from serve.common import MONTAJ_ROOT, find_project_dir, resolve_workspace

# Params a step writes to: these names on any step, and any param with an `outKind` ("write", or "export" for a
# user-picked export folder). The body may use the underscore spelling too. `out` is checked for every step,
# declared or not: build_cli_args passes it to any step that is given one.
WRITE_PARAMS = ("out", "out-dir")
EXPORT_OUT_KIND = "export"

# Params whose value is a FOLDER (so it may equal an allowed root); every other write param is a file path
# (strict-below, low 13). Export-marked params are folders too, handled where the export mark is read.
_DIR_WRITE_PARAMS = ("out-dir", "frames-dir", "inbox")

# Steps that default their output BESIDE the input when `out` is omitted (M9): the file lands in whatever
# folder holds a decodable input, which may be anywhere on disk. When such a step runs with no write param,
# the parent folder of each input (and of each spec `segments[].src`) is checked instead.
BESIDE_INPUT_STEPS = frozenset({
    "extract_audio", "normalize", "resize", "snapshot", "stem_separation", "waveform_image", "caption",
    "lyrics_sync", "lyrics_render", "crop_spec", "paper_cutout", "remove_bg", "mix_timeline",
    "materialize_cut", "transcribe",
})

# Body fields that may carry the id of the project a step runs on.
_PROJECT_ID_FIELDS = ("_project", "project-id", "project_id", "projectId", "project")


def _is_darwin() -> bool:
    return sys.platform == "darwin"


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


def _within(path: str, root: str, *, allow_equal: bool = True) -> bool:
    """`path` is `root` or below it. Both already real and normcased. `allow_equal=False`
    means strictly below: a FILE output (as opposed to a directory output) must not BE a
    root, because a step that takes its `out` as a prefix (transcribe writes `<out>.json`)
    would then write `<root>.json` in the root's parent, outside it (low 13)."""
    try:
        if os.path.commonpath([path, root]) != root:
            return False
    except ValueError:  # different drives on Windows
        return False
    return allow_equal or path != root


def _fold(path: str) -> str:
    """For the export denylist only: case and Unicode folded, so `~/LIBRARY` on a case-insensitive disk (whose
    real path keeps the spelling given) still counts as ~/Library."""
    return unicodedata.normalize("NFKC", path).casefold()


# `file:`, `http:`, `pipe:`, `concat:`, `subfile,` ...: ffmpeg opens such an output as a protocol URL
# (`file:/abs` writes there, `pipe:1` is a fd, `subfile,,start,..:...` wraps another path), so it is never the
# workspace-relative path it looks like. The `scheme:` form needs two letters at least (`C:` is a Windows
# drive); `subfile,` uses a comma, not a colon, so it is matched explicitly.
_SCHEME = re.compile(r"^([A-Za-z][A-Za-z0-9+.\-]+:|subfile,)")


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


def _ino(path: str):
    """(st_dev, st_ino) of `path`, or None when it does not exist. The filesystem's own identity
    for a folder, which a firmlink or a case-folding name cannot disguise."""
    try:
        st = os.stat(path)
        return (st.st_dev, st.st_ino)
    except OSError:
        return None


def _under_by_ino(real: str, root_id) -> bool:
    """True when `real`, or any ancestor of it, is the folder identified by `root_id` (a dev:ino
    pair). Compared by inode, not string prefix, so `/System/Volumes/Data/Users/u/Library` (the
    firmlink form `realpath` leaves intact) is still recognised as `~/Library` (M8)."""
    if root_id is None:
        return False
    p = Path(real)
    for anc in (p, *p.parents):
        if _ino(str(anc)) == root_id:
            return True
    return False


def _deny_root_paths() -> list[str]:
    """Real paths an export may never go under. Compared by dev:ino (`_under_by_ino`), so the
    firmlink twin of any of them is caught too. `~/Library` carries a cloud carve-out (see
    `_export_folder_ok`)."""
    home, real_home = _serve_home(), _real_home()
    roots = [
        os.path.join(real_home, "Library"),
        os.path.join(real_home, "AppData"),
        os.path.join(home, ".montaj"),
        os.path.join(home, ".cache"),
        str(MONTAJ_ROOT),
        sys.prefix,
        sys.base_prefix,
        "/Applications",
        "/usr/local",
        "/opt/homebrew",
    ]
    return [_real(r) for r in roots]


def _cloud_roots() -> list[str]:
    """The two cloud-storage subtrees of ~/Library an export may go in (macOS only, by real path):
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
    out = []
    for r in roots:
        parent_id = _ino(os.path.dirname(r))
        real = _real(r)
        if _ino(real) != parent_id and _under_by_ino(real, parent_id):
            out.append(real)
    return out


def _export_folder_ok(real: str) -> bool:
    """An existing folder a user may pick for an export: not hidden, not under `/System/Volumes/`, not an
    `.app` bundle, not a system or app folder (cloud-storage folders in ~/Library excepted, `_cloud_roots`;
    their hidden folders are still refused). Deny roots compare by dev:ino (`_under_by_ino`), so a firmlink
    form of `~/Library` is refused too (M8)."""
    if not os.path.isdir(real):
        return False
    if any(part.startswith(".") for part in Path(real).parts):
        return False
    # The firmlink-canonical form of the data volume, and any `.app` bundle, are refused outright.
    if _fold(real).startswith(_fold("/System/Volumes/")):
        return False
    if any(_fold(part).endswith(".app") for part in Path(real).parts):
        return False
    library_id = _ino(os.path.join(_real_home(), "Library"))
    cloud_ids = [_ino(r) for r in _cloud_roots()]
    cloud = any(_under_by_ino(real, cid) for cid in cloud_ids)
    for root in _deny_root_paths():
        root_id = _ino(root)
        if root_id is None:
            continue
        if _under_by_ino(real, root_id) and not (cloud and root_id == library_id):
            return False
    return True


def _has_git_component(*values: str) -> bool:
    """Any of `values` has a path component that folds to `.git` (H5): a project's own git dir, where a
    written hook or config would run when serve shells git there."""
    for value in values:
        if not value:
            continue
        for part in re.split(r"[\\/]", value):
            if part and _fold(part) == _fold(".git"):
                return True
    return False


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
    export-marked, value) triples, that leaves the allowed places (module docstring), or that names a `.git`
    component (H5). `body` names the project (for its folder). `native`: only then does an export mark count.
    A FILE output (anything but `out-dir`/`frames-dir`/`inbox` and the export folders) must be STRICTLY below
    an allowed root, never equal to it (low 13). Reads, changes nothing."""
    roots = None
    project_roots = None
    for param, export, value in items:
        cands = _candidates(value)
        is_dir = export or param in _DIR_WRITE_PARAMS
        ok = cands is not None
        for cand in cands or []:
            real = _real(cand)
            if _has_git_component(cand, real):
                raise HTTPException(403, detail={
                    "error": "out_not_allowed",
                    "message": f"'{param}' of {name} may not write inside a project's .git folder.",
                })
            if roots is None:
                roots = [_real(str(resolve_workspace()))]
            if any(_within(real, r, allow_equal=is_dir) for r in roots):
                continue
            if project_roots is None:
                project_roots = _project_roots(body)
            if any(_within(real, r, allow_equal=is_dir) for r in project_roots):
                continue
            if export and native and _export_folder_ok(real):
                continue
            ok = False
            break
        if not ok:
            where = ("inside the workspace or the project's folder, or an existing "
                     "folder that is not hidden and not a system or app folder"
                     if export and native else
                     "inside the workspace or the project's folder")
            raise HTTPException(403, detail={
                "error": "out_not_allowed",
                "message": f"'{param}' of {name} must be {where}.",
            })


def _spec_segment_srcs(path: str) -> list[str]:
    """The `segments[].src` paths of a cut/timeline spec JSON, best effort. A spec is how mix_timeline and
    materialize_cut take their inputs; each segment names a media file the step reads (and writes beside)."""
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return []
    segs = data.get("segments") if isinstance(data, dict) else None
    out = []
    for seg in segs or []:
        if isinstance(seg, dict) and isinstance(seg.get("src"), str) and seg["src"]:
            out.append(seg["src"])
    return out


def _beside_input_paths(body: dict) -> list[str]:
    """The input media paths a beside-input step would write next to: `input`/`inputs`, and for a spec input
    its `segments[].src`. Relative inputs are the workspace's (the step's cwd)."""
    raw: list[str] = []
    for key in ("input", "inputs"):
        v = body.get(key)
        for item in (v if isinstance(v, list) else [v]):
            if isinstance(item, str) and item:
                raw.append(item)
    paths: list[str] = []
    for item in raw:
        paths.append(item)
        paths += _spec_segment_srcs(item if os.path.isabs(item)
                                    else os.path.join(os.path.abspath(resolve_workspace()), item))
    return paths


def _check_beside_input(name: str, body: dict) -> None:
    """A beside-input step with no write param writes into each input's own folder (M9): refuse if that
    folder is outside the allowed roots, so the caller must pass an allowed `out`. The parent folder is a
    directory output (`out-dir` semantics), so it may equal an allowed root."""
    items = [("out-dir", False, os.path.dirname(p) or p) for p in _beside_input_paths(body)]
    if items:
        check_write_paths(name, items, body, native=False)


def check_step_out(name: str, schema: dict, body: dict, *, native: bool) -> None:
    """The write params of a step run through POST /api/steps/{name}: `check_write_paths` on each. A
    beside-input step (M9) with no write param in the body is checked on its inputs' folders instead."""
    check_write_paths(name, _write_values(schema, body), body, native=native)
    if name in BESIDE_INPUT_STEPS and not _has_explicit_write(schema, body):
        _check_beside_input(name, body)


def _has_explicit_write(schema: dict, body: dict) -> bool:
    """True when the body carries a write path (out, out-dir, or any outKind param): then the step writes
    there, not beside its input."""
    params = {p["name"]: p for p in schema.get("params") or []
              if isinstance(p, dict) and isinstance(p.get("name"), str)}
    names = list(WRITE_PARAMS) + [n for n, p in params.items() if p.get("outKind")]
    for n in names:
        for key in dict.fromkeys((n, n.replace("-", "_"))):
            v = body.get(key)
            if isinstance(v, str) and v.strip():
                return True
            if isinstance(v, list) and any(isinstance(i, str) and i.strip() for i in v):
                return True
    return False


def check_route_out(name: str, body: dict) -> None:
    """The `out` of a serve route that is not a step run (/api/normalize, /api/proxy): the ordinary rule. With
    no `out`, /api/normalize writes its conformed copy beside the input, so the input's folder is checked (M9);
    /api/proxy instead writes into the workspace proxy cache, so it is not a beside-input write."""
    val = body.get("out")
    if val is None or val == "":
        if name == "normalize":
            _check_beside_input(name, body)
        return
    check_write_paths(name, [("out", False, str(val))], body, native=False)
