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
- a BESIDE_INPUT step (M9: extract_audio, normalize, resize, ...) run with NO write param writes a fixed,
  step-chosen sidecar into whatever folder holds each input, so that folder (and each spec `segments[].src`
  folder) is checked. The default output's name and suffix are the step's, never the caller's (see
  `_check_beside_input` and tests/test_beside_input_defaults.py), so this is a DENY check, not the allowlist:
  the folder is allowed when it is the workspace or the step's project folder (so `mcp.md`'s guidance to omit
  `out` and pass `project` still works), and otherwise allowed only when it passes the export carve-out
  (`_export_folder_ok` — an ordinary non-hidden, non-system folder). A normal outside folder (e.g. `~/Desktop`)
  is allowed; a hidden folder, `~/Library`, `.montaj`, `.cache`, the package, the Python install or a system
  root is refused with the same 403. An explicit `out` is unchanged (the allowlist, via `check_write_paths`).

Paths are compared by real path: the path itself, or when it does not exist yet its nearest existing ancestor
plus the rest, so a symlink anywhere counts as its target. A `..` component, a NUL and a URL scheme (`file:`,
`pipe:`, `concat:`, `subfile,`, which ffmpeg opens as a protocol) are refused outright. A relative path is the
workspace's (the step's cwd), and a `~` or `$VAR` in it is checked as what it may expand to as well.

Inventory (2026-10-21): the params a native step WRITES to (or deletes in), checked here.
  out, file, overwritten: detect_beats, extract_audio, mix_timeline, synth_audio,
      waveform_trim, caption, lyrics_render, detect_shots, shot_sheet (index), snapshot (a file, or
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
  out-dir, folder, files overwritten: waveform_image, capture_site, filmstrip, shot_sheet.
  frames-dir (contact_sheet, frames kept) and inbox (creator_diagnostic DELETES each measured video directly
      in it): `"outKind": "write"`.
  beside the input when `out` is omitted (BESIDE_INPUT_STEPS, M9): extract_audio, normalize, resize, snapshot,
      waveform_image, caption, lyrics_render, crop_spec, paper_cutout, remove_bg,
      mix_timeline, materialize_cut, transcribe. The input's folder (and each spec `segments[].src` folder) is
      then checked as a DENY location (`_check_beside_input`), not against the allowlist: a normal outside
      folder is allowed, a hidden/system/package/home-config folder is refused.
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
                         `project`, which lands in the project's assets folder (or the `projectDir` the step's `out` declares)
"""
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

from fastapi import HTTPException

from lib import write_places
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
    "extract_audio", "normalize", "resize", "snapshot", "waveform_image", "caption",
    "lyrics_render", "crop_spec", "paper_cutout", "remove_bg", "mix_timeline",
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
    """For the export denylist only: case and Unicode folded (lib/write_places.fold)."""
    return write_places.fold(path)


# `file:`, `http:`, `pipe:`, `concat:`, `subfile,` ...: ffmpeg opens such an output as a protocol URL
# (`file:/abs` writes there, `pipe:1` is a fd, `subfile,,start,..:...` wraps another path), so it is never the
# workspace-relative path it looks like. The `scheme:` form is ffmpeg's own: two or more of [A-Za-z0-9+.-]
# (a digit or a `.` first too, §563 review) before a `:` (`C:` is a Windows drive); `subfile,` uses a comma,
# not a colon, so it is matched explicitly.
_SCHEME = re.compile(r"^([A-Za-z0-9+.\-]{2,}:|subfile,)")


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
    """(st_dev, st_ino) of `path`, or None when it does not exist (lib/write_places.ino)."""
    return write_places.ino(path)


def _under_by_ino(real: str, root_id) -> bool:
    """True when `real`, or any ancestor of it, is the folder `root_id` names (lib/write_places.under_by_ino)."""
    return write_places.under_by_ino(real, root_id)


def _deny_root_paths() -> list[str]:
    """Real paths an export may never go under (lib/write_places.deny_root_paths), with this module's homes."""
    return write_places.deny_root_paths(_real_home(), _serve_home(), str(MONTAJ_ROOT))


def _cloud_roots() -> list[str]:
    """The cloud-storage subtrees of ~/Library an export may go in (lib/write_places.cloud_roots)."""
    return write_places.cloud_roots(_real_home(), _is_darwin())


def _export_folder_ok(real: str) -> bool:
    """An existing folder a user may pick for an export (lib/write_places.export_folder_ok, which steps use
    too), with this module's homes and platform, so tests that patch them reach it."""
    return write_places.export_folder_ok(real, real_home_dir=_real_home(), serve_home_dir=_serve_home(),
                                         darwin=_is_darwin(), montaj_root=str(MONTAJ_ROOT))


def _has_git_component(*values: str) -> bool:
    """Any of `values` has a path component that folds to `.git` (H5; lib/write_places.has_git_component)."""
    return write_places.has_git_component(*values)


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
                    "message": f"'{param}' of {name} may not write inside a project's .git folder. Choose a path outside it.",
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
                # §558: only `out` may be left out (a project's run then saves into its assets).
                "message": f"'{param}' of {name} must be {where}. Choose a path there"
                           + (", or leave 'out' out." if param == "out" else "."),
            })


def _spec_media_srcs(path: str) -> list[str]:
    """The media files a cut/timeline spec JSON names, best effort. A spec is how mix_timeline, materialize_cut
    and transcribe take their inputs; the step reads each and writes its default output BESIDE it, so each one's
    folder must face the same deny check as a plain input. Two shapes: `segments[].src` (a multi-segment spec),
    and the single-source trim spec `{"input": ..., "keeps": [...]}`, whose top-level `input` is the source media
    (materialize_cut and transcribe write beside it, not beside the spec file)."""
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    out = []
    for seg in data.get("segments") or []:
        if isinstance(seg, dict) and isinstance(seg.get("src"), str) and seg["src"]:
            out.append(seg["src"])
    if "keeps" in data and isinstance(data.get("input"), str) and data["input"]:
        out.append(data["input"])
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
        paths += _spec_media_srcs(item if os.path.isabs(item)
                                  else os.path.join(os.path.abspath(resolve_workspace()), item))
    return paths


def _check_beside_input(name: str, body: dict) -> None:
    """A beside-input step with no write param writes a fixed, step-chosen sidecar into the folder of each
    input (M9). The default output's NAME and suffix are the STEP's, never the caller's (proven for every
    member of BESIDE_INPUT_STEPS in tests/test_beside_input_defaults.py: never an in-place overwrite, always a
    safe non-executable suffix), so that folder only has to be kept out of code and config locations, not
    confined to the workspace. For each input's real folder:

      - allow when it is the workspace or the step's project folder, or below one (the existing allow);
      - else allow only when `_export_folder_ok` is True, i.e. it is an ordinary place a user could pick for an
        export: an existing folder that is not hidden, not under `/System/Volumes/`, not an `.app` bundle, and
        not ~/Library or ~/AppData of the real home, `.montaj`, `.cache`, the montaj package, the Python
        install, /Applications, /usr/local or /opt/homebrew (compared by dev:ino, so a firmlink form of any of
        them is caught too, with the cloud-storage carve-out);
      - else refuse 403 `out_not_allowed`.

    This restores writing beside an input that sits in a normal outside folder (e.g. `~/Desktop/clip.mov` with
    no project and no `out`), which an earlier security round (M9) had refused, while still keeping the sidecar
    out of the deny roots. A `.git` folder is never a write target (H5), and a `..`/NUL/URL-scheme path is
    refused outright. A folder of outputs written beside the input (snapshot `--frames all`,
    waveform_image) lands in this same checked folder, so this one check covers it. An explicit `out` does not
    reach here: it is the allowlist via `check_write_paths`."""
    ws = None
    project_roots = None
    for path in _beside_input_paths(body):
        cands = _candidates(os.path.dirname(path) or path)
        refuse = cands is None
        for cand in cands or []:
            real_dir = _real(cand)
            if _has_git_component(cand, real_dir):
                refuse = True
                break
            if ws is None:
                ws = _real(str(resolve_workspace()))
            if _within(real_dir, ws):
                continue
            if project_roots is None:
                project_roots = _project_roots(body)
            if any(_within(real_dir, r) for r in project_roots):
                continue
            if _export_folder_ok(real_dir):
                continue
            refuse = True
            break
        if refuse:
            raise HTTPException(403, detail={
                "error": "out_not_allowed",
                "message": (f"{name} writes beside its input when no 'out' is given, but that input's folder "
                            f"is not a place it may write. Pass an allowed 'out', or move the input out of a "
                            f"hidden or system folder."),
            })


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
