"""Step discovery, /steps/{name} runner, and /normalize endpoint."""
import asyncio
import json
import math
import os
import sys
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse

from lib.color_provenance import ProbeError, is_probe_retryable
from lib.credentials import CredentialError, build_env_overlay
from lib.step_schema import flag_value
from serve.disk_full import STATUS as disk_full_status, child_disk_full, workspace_root as disk_full_root
from serve.common import (
    MONTAJ_ROOT,
    find_project_dir,
    lands_on_project_file,
    resolve_workspace,
    run_subprocess,
    not_found, bad_request, server_error,
)
from lib import sync_clash
from serve.jobs import create_job, set_done, set_error, get_job
from serve.out_guard import (
    BESIDE_INPUT_STEPS, _DIR_WRITE_PARAMS, _beside_input_paths, _candidates, _has_explicit_write, _write_values,
    check_route_out, check_step_out,
)
from serve import provenance, save_guard

router = APIRouter(prefix="/api")

STEP_TIMEOUT_S = int(os.environ.get("MONTAJ_STEP_TIMEOUT", "900"))

# Whisper steps' outer ceiling (see _step_timeout). Runaway guards, like the
# whisper guard in lib/common they sit on top of: not estimates of how long a
# step should take. Audio extraction and model load get the overhead on top of
# the whisper guard; a whisper step serve cannot size (generate_captions works
# on a project, not a file) gets the flat backstop, since every stage inside it
# has its own bounded timeout and the whisper stage's is sized to the real audio.
WHISPER_STEP_OVERHEAD_S = 300
WHISPER_STEP_NO_DURATION_S = 12 * 3600


def _runs_whisper(schema: dict) -> bool:
    """A step that transcribes with whisper: its `model` param defaults to the
    whisper default (transcribe, rm_fillers, rm_nonspeech,
    generate_captions)."""
    from lib.common import DEFAULT_WHISPER_MODEL
    return any(p.get("name") == "model" and p.get("default") == DEFAULT_WHISPER_MODEL
               for p in schema.get("params", []))


def _step_timeout(schema: dict, body: dict) -> int:
    """The subprocess ceiling for one step run: the flat STEP_TIMEOUT_S, except
    for a whisper step. Whisper on a CPU (Windows) runs far slower than on Apple
    silicon, and the flat 900 s killed long transcriptions part-way, so a whisper
    step's ceiling outlasts its own whisper runaway guard on the input's duration
    (lib/common.whisper_runaway_timeout) plus WHISPER_STEP_OVERHEAD_S. A stuck
    whisper then fails as the step's structured transcription_timeout, not as
    this 504. A trim-spec input is sized by its source (an upper bound). Never
    below STEP_TIMEOUT_S, so MONTAJ_STEP_TIMEOUT still raises every step."""
    if not _runs_whisper(schema):
        # A step may declare a longer ceiling of its own (export_editor renders
        # one movie per overlay); never below the flat one.
        declared = schema.get("timeout_s")
        if isinstance(declared, (int, float)) and not isinstance(declared, bool) \
                and math.isfinite(declared) and declared > 0:
            return max(STEP_TIMEOUT_S, int(declared))
        return STEP_TIMEOUT_S
    from lib.common import get_duration, whisper_runaway_timeout
    from lib.trim_spec import is_trim_spec, load as load_spec
    path = body.get("input") or (body.get("inputs") or [None])[0]
    duration = None
    try:
        if isinstance(path, str) and path:
            # The step runs with the workspace as its cwd, so a relative path is the workspace's, and absolute,
            # so ffprobe never reads caller text like `concat:...` as a protocol (§563).
            def absolute(p):
                return p if os.path.isabs(p) else os.path.join(str(resolve_workspace()), p)
            path = absolute(path)
            if is_trim_spec(path):
                path = absolute(load_spec(path)["input"])
            duration = get_duration(path)
    except (Exception, SystemExit):  # get_duration exits through fail()
        duration = None
    if duration is None:
        return max(STEP_TIMEOUT_S, WHISPER_STEP_NO_DURATION_S)
    return max(STEP_TIMEOUT_S, whisper_runaway_timeout(duration) + WHISPER_STEP_OVERHEAD_S)


# The built-in steps. A step found here is native; one from ~/.montaj/steps is
# custom, and may shadow a native one of the same name on purpose.
NATIVE_STEPS_DIR = MONTAJ_ROOT / "steps"


def scan_steps() -> dict[str, tuple[dict, Path]]:
    """Scan native (built-in) then custom (~/.montaj/steps). Later scope overwrites earlier.
    Returns dict[name, (schema, py_path)]. Schema gets an injected 'category' field from subdirectory name."""
    scopes = [
        NATIVE_STEPS_DIR,
        Path.home() / ".montaj" / "steps",
    ]
    steps: dict[str, tuple[dict, Path]] = {}
    for scope in scopes:
        if not scope.exists():
            continue
        # Flat files (backwards compat)
        for json_file in scope.glob("*.json"):
            _try_add_step(steps, json_file, scope, category=None)
        # One level of subdirectories
        for subdir in sorted(scope.iterdir()):
            if subdir.is_dir() and not subdir.name.startswith((".", "_")):
                for json_file in subdir.glob("*.json"):
                    _try_add_step(steps, json_file, subdir, category=subdir.name)
    return steps


def _try_add_step(steps: dict, json_file: Path, parent: Path, category: str | None):
    """Parse a step JSON and add it to the steps dict if valid."""
    try:
        schema = json.loads(json_file.read_text())
    except Exception:
        return
    name = schema.get("name")
    if not name:
        return
    py_path = parent / (name + ".py")
    if not py_path.exists():
        return
    if category:
        schema["category"] = category
    steps[name] = (schema, py_path)


def build_cli_args(schema: dict, body: dict) -> list[str]:
    """Map request body fields to CLI flags. Mirrors mcp/server.js buildCliArgs."""
    flags: list[str] = []

    inp = schema.get("input", {})
    if inp.get("multiple"):
        files = body.get("inputs", [])
        # Also accept singular "input" for convenience (UI sends singular for single-file calls)
        if not files and "input" in body:
            files = [body["input"]]
        if len(files) == 1:
            flags += ["--input", str(files[0])]
        elif files:
            flags += ["--inputs"] + [str(f) for f in files]
    elif "input" in body:
        flags += ["--input", str(body["input"])]

    for param in schema.get("params", []):
        name = param["name"]
        if name == "out":
            continue  # emitted once, last, below (a declared `out` used to go in twice, the last one winning)
        # Accept both hyphenated (schema canonical) and underscored (JSON convenience).
        val = body.get(name)
        if val is None:
            val = body.get(name.replace("-", "_"))
        if val is None:
            continue
        flag = "--" + name
        numeric = param.get("type") in ("int", "float")
        if param.get("type") in ("bool", "boolean"):
            if val:
                flags.append(flag)
        elif isinstance(val, list) and param.get("type") == "array":
            # `array` params are argparse nargs="+" (remove_bg, materialize_cut --inputs):
            # one flag then every value. A repeated flag would overwrite, keeping only the last.
            flags.append(flag)
            flags += [str(item) for item in val]
        elif isinstance(val, list):
            # Any other list value is an action="append" param (--at, --ref-image, ...):
            # repeat the flag once per element. No step declares type "list"; `array` is the
            # only JSON type that means nargs, so the type separates the two shapes.
            for item in val:
                flags += flag_value(flag, item, numeric)
        elif isinstance(val, dict):
            flags += [flag, json.dumps(val)]
        else:
            flags += flag_value(flag, val, numeric)

    if "out" in body:
        # The step's cwd is the workspace, so a relative `out` is that workspace file: it goes absolute, the path
        # the out-guard checked, never text a tool could read as a protocol (§563 review). An empty `out` is no
        # out at all and stays empty: joined, it would name the workspace root.
        out = str(body["out"])
        flags += ["--out", out if not out or os.path.isabs(out) else os.path.join(str(resolve_workspace()), out)]

    return flags


def _is_plain_number(value: str) -> bool:
    """`value` is a plain number (so `-1.5` on an int/float param is a legitimate negative, not a flag)."""
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def _reject_flag_values(schema: dict, body: dict) -> None:
    """A string value (or list item) that begins with `-` would be read by argparse as a FLAG, not a value:
    `--out=/x` smuggled in `inputs`, a bare `-rf`, `--output-dir=...`. build_cli_args turns every value into
    argv, so such an item becomes a real `--out`/`--out-dir` the out-guard never saw (H2). Refuse it (422
    `invalid_param`, naming the param), EXCEPT a plain negative number on an int/float param. A path that
    merely CONTAINS a dash (`/a/-b/c`) is fine; only a value that STARTS with `-` is refused."""
    numeric = {p["name"] for p in schema.get("params", [])
               if isinstance(p, dict) and p.get("type") in ("int", "float")}

    def _check(param_name: str, value, numeric_ok: bool) -> None:
        for item in (value if isinstance(value, list) else [value]):
            if isinstance(item, str) and item.startswith("-"):
                if numeric_ok and _is_plain_number(item):
                    continue
                raise HTTPException(422, detail={
                    "error": "invalid_param",
                    "message": (f"'{param_name}' may not begin with '-'; it would be read as a "
                                "command-line flag. Pass a path or value that does not start with a dash."),
                })

    for key in ("input", "inputs"):
        if body.get(key) is not None:
            _check(key, body[key], numeric_ok=False)
    for param in schema.get("params", []):
        name = param["name"]
        val = body.get(name)
        if val is None:
            val = body.get(name.replace("-", "_"))
        if val is not None:
            _check(name, val, numeric_ok=name in numeric)


def validate_params(schema: dict, body: dict) -> None:
    """Validate body params against schema constraints. Raises HTTPException 422 on failure."""
    _reject_flag_values(schema, body)
    errors = []

    # Reject unknown fields. Silently dropping an unrecognized arg is the footgun
    # that let rm_nonspeech run full-file detection: a caller passed `keeps`
    # (and `language`) on a step that didn't declare them, build_cli_args
    # quietly skipped them, and the step ignored the intended trim window.
    # Fail loud instead so a mis-driven call is obvious. Recognized keys:
    # input/inputs/out, every declared param (canonical + underscore alias),
    # and reserved control fields (leading underscore, e.g. _async) plus
    # `credentials` — both are popped before this runs on the real route, but
    # allow them so direct callers/tests don't trip on them.
    recognized = {"input", "inputs", "out", "credentials"}
    for param in schema.get("params", []):
        recognized.add(param["name"])
        recognized.add(param["name"].replace("-", "_"))
    unknown = sorted(k for k in body if k not in recognized and not k.startswith("_"))
    if unknown:
        allowed = sorted(p["name"] for p in schema.get("params", []))
        errors.append(
            f"unknown field(s): {', '.join(unknown)}. This step accepts "
            f"{allowed} plus input/inputs/out. "
            f"(A trim window must be embedded in a trim-spec .json passed as 'input', "
            f"not sent as a 'keeps' field.)"
        )

    for param in schema.get("params", []):
        name  = param["name"]
        val   = body.get(name)
        ptype = param.get("type")

        if val is None:
            val = body.get(name.replace("-", "_"))
        if val is None:
            if param.get("required"):
                errors.append(f"'{name}' is required")
            continue

        # A repeatable param (argparse action="append", e.g. contact_sheet's --at)
        # takes a list: each item is checked as one value, and build_cli_args
        # repeats the flag per item. A list on any other scalar param is refused.
        values = val if isinstance(val, list) and param.get("repeatable") else [val]

        if ptype in ("float", "int"):
            for item in values:
                try:
                    num = float(item) if ptype == "float" else int(item)
                except (TypeError, ValueError, OverflowError):
                    errors.append(f"'{name}' must be a {ptype}, got {item!r}")
                    continue
                # §558: NaN and infinity (as numbers or as "nan", "inf" strings, which float() takes) pass every min
                # and max check, and a step would write them into project.json, which then does not open
                if not math.isfinite(num):
                    errors.append(f"'{name}' must be a finite {ptype}, got {item!r}")
                    continue
                if "min" in param and num < param["min"]:
                    errors.append(f"'{name}' must be >= {param['min']}, got {num}")
                if "max" in param and num > param["max"]:
                    errors.append(f"'{name}' must be <= {param['max']}, got {num}")

        elif ptype == "enum":
            options = param.get("options", [])
            for item in values:
                if item not in options:
                    errors.append(f"'{name}' must be one of {options}, got {item!r}")

    if errors:
        raise HTTPException(422, detail={"error": "invalid_params", "message": "; ".join(errors)})


_PROJECT_ALIASES = ("projectId", "project_id")
_PROJECT_EXAMPLE = '{"project": "3f2a..."}'


def resolve_project_param(schema: dict, body: dict) -> None:
    """A step whose `project` param is the path of a project.json
    (sample_frame, contact_sheet) also takes the project's id or its folder,
    the way every other project tool does. Resolved here, in place, to that
    project's project.json before the step runs. An absolute path is allowed
    only when it resolves INSIDE the workspace (low 14): the step opens the
    project it names and writes in that folder by default, so a path outside
    the workspace would be an unguarded write target. An absolute path inside
    the workspace that is a project folder is rewritten to its project.json;
    anything else absolute-and-inside passes through for the step to report;
    an absolute path OUTSIDE the workspace is a 422.

    `projectId` and `project_id` are aliases of `project`, and so is the
    step's own `input` when its input block is `"type": "project"`
    (sample_frame declares one but its script has no --input). Each alias is
    used only when `project` itself is absent. An id no project in the
    workspace has is a 422 invalid_params naming the field.
    """
    params = schema.get("params") or []
    if not any(p.get("name") == "project" and p.get("type") == "path" for p in params):
        return
    aliases = list(_PROJECT_ALIASES)
    if (schema.get("input") or {}).get("type") == "project":
        aliases.append("input")
    if body.get("project") is None:
        for alias in aliases:
            if isinstance(body.get(alias), str) and body[alias].strip():
                body["project"] = body[alias]
                break
    for alias in aliases:
        body.pop(alias, None)

    value = body.get("project")
    if not isinstance(value, str) or not value.strip():
        return  # validate_params reports a missing project
    value = value.strip()
    path = Path(value).expanduser()
    if path.is_absolute():
        real = Path(os.path.realpath(path))
        ws = Path(os.path.realpath(resolve_workspace()))
        if real != ws and ws not in real.parents:
            raise HTTPException(422, detail={
                "error": "invalid_params",
                "message": ('"project" must be a project id, its folder, or a path inside the workspace. '
                            f"Example: {_PROJECT_EXAMPLE}"),
            })
        if path.is_dir() and (path / "project.json").is_file():
            body["project"] = str(path / "project.json")
        return
    found = find_project_dir(resolve_workspace(), value)
    if found is None:
        raise HTTPException(422, detail={
            "error": "invalid_params",
            "message": (
                f'No project with the id "{value}". "project" takes the project id, '
                f"its folder or the absolute path of its project.json. Example: {_PROJECT_EXAMPLE}"
            ),
        })
    body["project"] = str(found / "project.json")

_OUT_EXT = {"image": ".png", "audio": ".mp3", "video": ".mp4", "model": ".glb"}
# Only for the generated name: a plain name the caller gives a json step may be a
# folder (glass_plate's plates), so it keeps no extension.
_AUTO_OUT_EXT = {**_OUT_EXT, "json": ".json"}
_RESERVED_OUTS: set[str] = set()


def _project_dir_for(value) -> Path:
    """The folder of the project named by `_project`: an id, or a folder with a
    project.json. Either way it must resolve (symlinks followed) to a folder
    inside the workspace; anything else is a 422 naming `project`."""
    found = None
    if isinstance(value, str) and value.strip():
        v = value.strip()
        path = Path(v).expanduser()
        if path.is_absolute():
            if path.is_dir() and (path / "project.json").is_file():
                found = path
        else:
            f = find_project_dir(resolve_workspace(), v)
            found = Path(f) if f is not None else None
    if found is not None:
        real = Path(os.path.realpath(found))
        ws = Path(os.path.realpath(resolve_workspace()))
        if (real / "project.json").is_file() and real != ws and ws in real.parents:
            return real
    raise HTTPException(422, detail={
        "error": "invalid_params",
        "message": f'No project "{value}" in the workspace. "_project" takes the project id or its folder.',
    })


def _is_plain_name(out) -> bool:
    return (isinstance(out, str) and out not in ("", ".", "..")
            and "/" not in out and "\\" not in out and not Path(out).is_absolute())


def _project_out_dir(schema: dict) -> str:
    """The project folder a `_project` out lands in: the `out` param's `projectDir`, else `assets`."""
    out_param = next((p for p in schema.get("params") or [] if p.get("name") == "out"), None)
    return (out_param or {}).get("projectDir") or "assets"


def resolve_project_out(name: str, schema: dict, body: dict) -> str | None:
    """`_project` (reserved, popped here): a step that declares `out` saves into
    the project's assets folder when `out` is left off or is a plain file name
    (no separator, not . or ..): `<step>-<YYYYMMDD-HHMMSS><ext>`, or the name
    with that extension when it has none. The extension is the `out` param's
    own `"ext"` when it declares one (the file a step writes is not always what
    it prints: synth_audio prints JSON and writes a WAV), else the step's
    output type's. Any other
    `out` passes through unchanged here; the route has already refused one that
    leaves the allowed places (serve/out_guard.py). A name already taken gets -2, -3, ... The
    result never leaves its folder, `<project>/assets/` by default (a symlinked folder is a 422).
    An `out` param with `"projectDir": "render/samples"` saves into that folder of
    the project instead of `assets/` (check images, which are not the user's assets).
    An `out` param marked `"projectDefault": "step"` is left off when it is
    left off: that step keeps its own stable place in the project, replaced on
    a re-run (glass_plate's `plates/<item>/`), where a timestamped name would
    leave every earlier run behind (§176).
    An `out` that lands on a project's provenance record is a 422, given or
    resolved (`_refuse_record_out`).
    Returns the resolved path, or None when nothing was resolved."""
    from datetime import datetime
    _refuse_record_out(body.get("out"), name=name)
    project = body.pop("_project", None)
    if project is None:
        return None
    pdir = _project_dir_for(project)
    out_param = next((p for p in schema.get("params") or [] if p.get("name") == "out"), None)
    if out_param is None:
        return None
    out = body.get("out")
    if out is None and out_param.get("projectDefault") == "step":
        return None
    if out is not None and not _is_plain_name(out):
        return None
    file_ext = out_param.get("ext")
    ext = file_ext or _OUT_EXT.get((schema.get("output") or {}).get("type"), "")
    if out is None:
        auto_ext = file_ext or _AUTO_OUT_EXT.get((schema.get("output") or {}).get("type"), "")
        stem, suffix = f"{name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}", auto_ext
    else:
        stem, suffix = os.path.splitext(out)
        if not suffix:
            stem, suffix = out, ext
    sub = _project_out_dir(schema)
    parts = Path(sub).parts
    if Path(sub).is_absolute() or ".." in parts or not parts:
        raise HTTPException(422, detail={"error": "invalid_params", "message": f'Step "{name}" declares a bad projectDir.'})
    assets = pdir
    for part in parts:
        assets = assets / part
        if assets.is_symlink():
            raise HTTPException(422, detail={
                "error": "invalid_params", "message": f'The project\'s "{sub}" folder is a symlink; "_project" will not write through it.'})
    try:
        assets.mkdir(parents=True, exist_ok=True)
    except OSError:
        raise HTTPException(422, detail={"error": "invalid_params", "message": f'The project\'s "{sub}" is not a folder.'})
    n = 1
    while True:
        cand = assets / (f"{stem}{suffix}" if n == 1 else f"{stem}-{n}{suffix}")
        # lexists, not exists: a dangling or redirecting symlink at the name is still "taken", so the
        # resolved out is never a path that writes THROUGH a pre-planted link (low 15).
        if not os.path.lexists(cand) and str(cand) not in _RESERVED_OUTS:
            break
        n += 1
    if Path(os.path.realpath(assets)) != pdir.joinpath(*parts) or cand.parent != assets:
        raise HTTPException(422, detail={"error": "invalid_params", "message": f"resolved output left the project's {sub} folder"})
    _refuse_record_out(str(cand), name=name)
    _RESERVED_OUTS.add(str(cand))
    body["out"] = str(cand)
    return str(cand)


def _refuse_record_out(out, *, name: str | None = None) -> None:
    """An `out` that lands on one of a project's OWN files — project.json, its temp file, its lock, or a
    provenance record (`PROJECT_FILE_NAMES`) — by name under case and Unicode folding or as the same file on
    disk, is a 422: serve is their only writer, and a step `out` here would bypass the project lock and the
    §477 save guard (M10). For transcribe, whose `out` is a prefix, its `<out>.json` and `<out>.srt` sidecars
    are checked too, so `out=<project>/project` cannot write `project.json`. A relative `out` is the
    workspace's, as the step's cwd is."""
    if not isinstance(out, str) or not out:
        return
    candidates = [out]
    if name == "transcribe":
        candidates += [out + ".json", out + ".srt"]
    for value in candidates:
        p = Path(value) if os.path.isabs(value) else Path(resolve_workspace()) / value
        try:
            real = Path(os.path.realpath(p))
        except (OSError, ValueError):
            real = p
        if lands_on_project_file(p, real):
            raise HTTPException(422, detail={
                "error": "invalid_params",
                "message": ("'out' would write a project's own file (project.json, its lock or a provenance "
                            "record), which only Montaj writes. Choose another name."),
            })


def wrap_output(stdout: str, schema: dict) -> dict:
    """Wrap bare file paths as JSON. Steps that already return JSON pass through.

    Output that looks like JSON but does not parse is never dropped: it comes
    back as {text, type, parseError}, so a paid reply with one syntax error survives."""
    text = stdout.strip()
    if text.startswith(("{", "[")):
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            return {"text": text, "type": schema.get("output", {}).get("type", "text"),
                    "parseError": str(e)}
    return {"path": text, "type": schema.get("output", {}).get("type", "file")}


@router.get("/steps")
async def list_steps():
    """Every step's schema, plus `runsWhisper` (`_runs_whisper`): a host that
    gates whisper steps on the model being installed builds its list from this."""
    return [{**schema, "runsWhisper": _runs_whisper(schema)} for schema, _ in scan_steps().values()]


# Steps whose run must never queue proxies after it: `proxy` makes them (a loop otherwise).
_NO_PROXY_QUEUE_STEPS = frozenset({"proxy"})


def _writes_tracks(name: str) -> bool:
    """Whether a step can add a clip to the tracks (so its project may need proxies). A step that writes no tracks
    queues none: its proxy write-backs would change the tracks inside the next guarded write's window."""
    if name in STEP_WRITES_NOTHING:
        return False
    return name not in STEP_WRITES or "tracks" in STEP_WRITES[name][0]


async def _queue_proxies_after_step(name: str, refs: list, broadcaster) -> None:
    """After a step that ran against a project: queue that project's editing proxies, the way
    POST /projects/{id}/proxies does. An AI video step writes its clip onto the first track with no
    `proxySrc`, and without proxies the editor's player refuses the project. Reuses
    `_ensure_current_proxies`' de-dupe and freshness check, so a step that wrote no clip, or a project
    whose proxies are current, queues nothing. Queue only (never awaits an encode) and best effort: it
    never raises, so it can never fail, slow or change the step's answer."""
    if name in _NO_PROXY_QUEUE_STEPS:
        return
    try:
        from serve.routes import projects as projects_routes
        folders: dict = {}
        for ref in refs:
            named = _named_project(ref)
            if named is not None and named[1] is not None:
                folders.setdefault(Path(named[1]).resolve(), named[0])
        for folder in folders:
            pj = folder / "project.json"
            if not pj.is_file():
                continue
            project = json.loads(await asyncio.to_thread(pj.read_text))
            await projects_routes._warm_proxy_inputs(projects_routes._video_srcs(project))
            await projects_routes._ensure_current_proxies_async(
                project.get("id") or folders[folder], folder, project, broadcaster)
    except Exception as e:
        print(f"[montaj] step {name}: could not queue proxies: {e}")


async def _execute_step(name: str, schema: dict, py_path: Path, body: dict, *, timeout: int | None = None,
                        origin: str | None = None, queue_proxies: bool = False, broadcaster=None) -> dict:
    """Run one step subprocess and return its wrap_output payload.

    Raises HTTPException on credential/validation/subprocess error exactly as
    the sync route always has. The secret-scrub lives HERE (not in the caller)
    so both the sync 500 path and the async error-job path get scrubbed output.

    `timeout` defaults to `_step_timeout` (the flat STEP_TIMEOUT_S, or a
    duration-scaled ceiling for a whisper step); the proxy job driver forwards
    its own duration-scaled timeout (see proxy_video) so a long-form source
    doesn't get killed mid-encode.
    """
    # Reserved field: per-request credentials become env vars for THIS one
    # subprocess and nothing else. Pop FIRST — before validate_params /
    # build_cli_args ever see the body — so it can never collide with a schema
    # param, leak into argv, or be echoed back in a validation error. The
    # values are secrets: they must not appear in any log or error response.
    env = None
    secret_values: list[str] = []
    creds = body.pop("credentials", None)
    if creds is not None:
        if not isinstance(creds, dict):
            raise HTTPException(422, detail={
                "error": "invalid_credentials",
                "message": "credentials must be an object of {provider: {key: value}}",
            })
        try:
            overlay = build_env_overlay(creds)
        except CredentialError as e:
            # CredentialError messages are value-free by construction.
            raise HTTPException(422, detail={"error": "invalid_credentials", "message": str(e)})
        if overlay:
            env = {**os.environ, **overlay}
            secret_values = list(overlay.values())
    if origin is not None and sync_clash.state_dir():
        # §482: whose run this is, for the step's own check under the project lock (lib/sync_clash.py). Only
        # serve sets it, and only with Studio sync on; `human` is the window's run alone.
        env = {**(env if env is not None else os.environ), sync_clash.ORIGIN_ENV: origin}

    project_ref = body.get("_project")
    named_refs = [body.get(k) for k in _STEP_PROJECT_FIELDS] + [project_ref]
    resolved_out = resolve_project_out(name, schema, body)
    resolve_project_param(schema, body)
    # Re-run the write guard: `_project` naming and the `project` param resolve `out`/`project` to new paths
    # AFTER run_step's first guard pass, and both resolve only inside the workspace, so this never refuses a
    # legitimate resolved path but catches anything the resolution produced that would leave the allowed
    # roots (low 15).
    check_step_out(name, schema, body, native=job_step_name(name, py_path) == name)
    validate_params(schema, body)
    cli_args = build_cli_args(schema, body)
    if timeout is None:
        timeout = _step_timeout(schema, body)

    # Non-blocking subprocess — allows the server to keep serving UI, SSE,
    # and other API requests while long-running steps (kling_generate, etc.)
    # are in progress.
    #
    # cwd is the WORKSPACE, not the server process's own cwd. Callers pass
    # relative `--out-dir`s by convention (`montajAdapter`'s
    # `.cache/filmstrips/<projectId>/<hash>`, `.cache/waveforms/<trackId>`),
    # and those only mean anything relative to the workspace: resolved against
    # the process cwd instead, a `montaj serve` started from anywhere but the
    # workspace wrote its caches outside it, where `/api/files` correctly
    # refuses to serve them ("Path is outside the allowed roots") and the
    # filmstrips/waveform images silently never appeared. Inputs are always
    # absolute, so nothing else depends on this cwd.
    try:
        stdout_text, stderr_text, returncode = await run_subprocess(
            [sys.executable, str(py_path), *cli_args],
            timeout=timeout,
            cwd=str(resolve_workspace()),
            env=env,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise server_error("step_failed", str(e))

    if returncode != 0:
        # stderr may contain multiple JSON lines (progress + error).
        # Find the last line with an "error" key; fall back to raw text.
        err = None
        for line in reversed(stderr_text.strip().splitlines()):
            try:
                parsed = json.loads(line)
                if "error" in parsed:
                    err = parsed
                    break
            except Exception:
                continue
        if not err:
            err = {"error": "step_failed", "message": stderr_text.strip()}
        if err.get("error") == "sync_conflict" and isinstance(err.get("fields"), list):
            # §482: the step's write refused under the lock, answered in the binding shape.
            raise HTTPException(409, detail=sync_clash.refusal(
                [f for f in err["fields"] if isinstance(f, str)]))
        # §541: a step that ran out of disk is the 507 with one plain sentence.
        full = child_disk_full(err, stderr_text, disk_full_root())
        if full is not None:
            raise HTTPException(disk_full_status, detail=full)
        # Passthrough credential values must never leave the server, even when
        # an upstream provider echoes the caller's own key in its error body
        # (OpenAI does: "Incorrect API key provided: <key>"). The error detail
        # transits proxies and logs, so scrub every injected secret value.
        if secret_values:
            err = json.loads(_scrub_secrets(json.dumps(err), secret_values))
        raise HTTPException(500, detail=err)

    result = wrap_output(stdout_text, schema)
    if resolved_out and isinstance(result, dict):
        result.setdefault("out", resolved_out)
    # In a thread: the record is written under the project lock, which blocks.
    await asyncio.to_thread(_note_provenance, name, schema, body, result, project_ref)
    if queue_proxies and _writes_tracks(name):
        # The one completion point of both the synchronous run and the async job. `project` is read
        # again here: resolve_project_param rewrote it to the project's project.json. In the background: the
        # queue probes every video source and may wait on the project lock, which must not delay the answer.
        task = asyncio.create_task(_queue_proxies_after_step(name, named_refs + [body.get("project")], broadcaster))
        _BACKGROUND_TASKS.add(task)
        task.add_done_callback(_BACKGROUND_TASKS.discard)
    return result


def _note_provenance(name: str, schema: dict, body: dict, result, project_ref) -> None:
    """Each file a finished step made in a project's folder goes in that project's
    `assets/.provenance.json` (serve/provenance.py: `step_records` says which
    files and what entry). The project is the one `_project` named, else the
    folder above the file with a project.json. Best effort: a record that cannot
    be written never fails the step, and one file's failure leaves the others."""
    try:
        named = None
        if project_ref is not None:
            try:
                named = _project_dir_for(project_ref)
            except HTTPException:
                named = None
        records = provenance.step_records(name, schema, body, result, str(resolve_workspace()), named)
    except Exception as e:  # never fail a finished step over its record
        print(f"[provenance] not recorded for {name}: {e}", file=sys.stderr)
        return
    by_project: dict = {}
    for pdir, out, entry in records:
        by_project.setdefault(pdir, []).append((out, entry))
    for pdir, items in by_project.items():   # one write per project
        try:
            _, refused = provenance.record_many(pdir, items)
        except Exception as e:
            print(f"[provenance] not recorded for {name} in {pdir}: {e}", file=sys.stderr)
            continue
        for out, e in refused:
            print(f"[provenance] not recorded for {name} ({out}): {e}", file=sys.stderr)


def job_step_name(name: str, py_path: Path) -> str:
    """The step an async job records, which a caller may trust to say what ran:
    `name` only when the step is the native one (its schema's folder and its
    script, by real path, under NATIVE_STEPS_DIR, the script being <name>.py),
    else "custom:<name>". A custom step that shadows a native one still runs;
    its record just cannot pass for the native step's."""
    try:
        root = NATIVE_STEPS_DIR.resolve(strict=True)
        folder = Path(py_path).parent.resolve(strict=True)
        script = Path(py_path).resolve(strict=True)
    except OSError:
        return f"custom:{name}"
    if folder.is_relative_to(root) and script.is_relative_to(root) and script.name == f"{name}.py":
        return name
    return f"custom:{name}"


async def _run_to_job(job_id: str, name: str, schema: dict, py_path: Path, body: dict,
                      origin: str | None = None, broadcaster=None) -> None:
    """Background driver: run a step and record its result/error on the job."""
    try:
        result = await _execute_step(name, schema, py_path, body, origin=origin,
                                     queue_proxies=True, broadcaster=broadcaster)
        set_done(job_id, result)
    except HTTPException as e:
        set_error(job_id, e.detail)
    except Exception as e:
        set_error(job_id, {"error": "step_failed", "message": str(e)})


# asyncio only holds a WEAK reference to a bare create_task() result, so a
# fire-and-forget background job can be garbage-collected mid-run ("Task was
# destroyed but it is pending") — the exact failure mode for a 60-90s whisper
# job. Keep a strong reference until the task finishes.
_BACKGROUND_TASKS: set[asyncio.Task] = set()


# ── §482 M4: what a step writes, for the Studio sync backstop ────────────────
#
# No step declares what it writes, so this table comes from the steps' code (montaj-app
# docs/plans/s482-m4-design.md §3). For a project the body names (`project`, `project-id`, `projectId`,
# `project_id`): a step here is checked on its fields and files; a step in STEP_WRITES_NOTHING runs; any other
# step is refused while ANY clash is open in that project (fail closed: a new step that writes the project must
# get a row). `_project` (the out folder) is the out param's `projectDir`, `assets/` by default. Every write path (out, out-dir, an outKind param) inside a
# project folder is checked as its relpath, and a beside-input step with no write path as its input's folder.
# The step checks again itself, under the project lock, on the fields it really changes (lib/sync_clash.py).
STEP_WRITES = {
    "jump_cut": (("tracks",), ()),
    "speech_edit": (("tracks", "captions", "audio", "markers", "notes"), ("speech-text.md",)),
    # cut also writes a transcript `<stem>.json` beside each untranscribed clip (often outside the project, so
    # not a project file here). out_guard does not see it: the step checks the place itself
    # (lib/write_places.sidecar_folder_ok) and never replaces a file there.
    "cut": (("tracks", "captions", "audio", "markers", "notes", "cleanCut", "status"), ("speech-text.md", "cut-plan.md", "cut-plan.prev.md", "cut-plan.prev-")),
    # §558: place adds an overlay (and its preset file), captions styles the captions, slides edits the slides
    "place": (("tracks",), ("overlays/",)),
    # PL89: push_in keys the talking-head clips' scale and offsetY
    "push_in": (("tracks",), ()),
    # PL89: frame_broll frames one b-roll clip (its crop or its card overlay, and the card's preset file)
    "frame_broll": (("tracks",), ("overlays/",)),
    "captions": (("captions",), ()),
    "slides": (("slides",), ()),
    "generate_captions": (("captions",), ()),
    "kling_generate": (("tracks", "storyboard", "status"), ()),
    "veo_generate": (("tracks", "storyboard", "status"), ()),
    "speech_text": ((), ("speech-text.md",)),
    "glass_plate": ((), ("plates/",)),
}
STEP_WRITES_NOTHING = frozenset({
    "sample_frame", "contact_sheet", "export_editor", "export_overlay_pages", "export_carousel_pages",
    "track_points", "probe", "transcribe", "look",
})
# Where a step writes inside the project it names when no `out` is given (review 40): checked as that folder. Neither
# is a folder Studio sync carries today (the uploader skips render/, and export/ holds nothing a project references),
# so these refuse only if a later sync scope names a file there; guarded rather than assumed.
STEP_DEFAULT_OUT = {
    "sample_frame": "render/samples/",   # steps/render/sample_frame.py: <project>/render/samples/frame-<at>s.png
    "look": "render/samples/",           # steps/render/look.py: <project>/render/samples/ (its check pictures)
    "export_editor": "export/",          # montaj_assets/render/export-editor.js: <project>/export/<package>/
}
_STEP_PROJECT_FIELDS = ("project", "project-id", "project_id", "projectId")


def _named_project(value) -> "tuple[str | None, Path | None] | None":
    """(id, folder) of a project a step body names: an id, its folder or its project.json. None for none."""
    if not isinstance(value, str) or not value.strip():
        return None
    v = value.strip()
    path = Path(v).expanduser()
    if path.is_absolute():
        folder = path.parent if path.name == "project.json" else path
        found = save_guard.project_of_path(str(folder), folder=True)
        return (found[0], folder) if found is not None else None
    folder = find_project_dir(resolve_workspace(), v)
    # An id no project has: the step finds nothing to write either (it answers that itself).
    return (v, folder) if folder is not None else None


def check_step_sync(name: str, schema: dict, body: dict, headers) -> None:
    """§482: refuse (409 sync_conflict) a step run that would write a clashed field or file. Nothing is read
    with MONTAJ_SYNC_STATE_DIR unset, or for the window's run.

    This runs before the step, which may take minutes. What closes the gap after it (review 40): a step's
    project.json write is checked again under the project lock on the fields it really changes (update_project,
    speech_apply); speech_text's speech-text.md and glass_plate's plates/ folder are checked again under the lock
    as they are written. Not checked again: the `out` file of kling_generate and veo_generate, which the provider
    connector writes in place at the end of the generation (a check there needs the connectors to land by rename),
    and any other step's own output file; for those this check is the only one."""
    if not sync_clash.state_dir() or save_guard.sync_who(headers).kind in ("human", "sync"):
        return
    targets: dict = {}

    def add(pid, fields=(), files=(), everything=False):
        t = targets.setdefault(pid, {"fields": [], "files": [], "everything": False})
        t["fields"] += list(fields)
        t["files"] += list(files)
        t["everything"] = t["everything"] or everything

    for key in _STEP_PROJECT_FIELDS:
        named = _named_project(body.get(key))
        if named is None:
            continue
        if name in STEP_WRITES:
            add(named[0], *STEP_WRITES[name])
        elif name not in STEP_WRITES_NOTHING:
            add(named[0], everything=True)
        if name in STEP_DEFAULT_OUT and not _has_explicit_write(schema, body):
            add(named[0], files=[STEP_DEFAULT_OUT[name]])
    named = _named_project(body.get("_project"))
    if named is not None:
        add(named[0], files=[_project_out_dir(schema).rstrip("/") + "/"])
    writes = []
    for param, export, value in _write_values(schema, body):
        for cand in _candidates(value) or []:
            writes.append((cand, param in _DIR_WRITE_PARAMS or export))
    if name in BESIDE_INPUT_STEPS and not _has_explicit_write(schema, body):
        for path in _beside_input_paths(body):
            for cand in _candidates(os.path.dirname(path) or path) or []:
                writes.append((cand, True))
    for path, is_folder in writes:
        found = save_guard.project_of_path(path, folder=is_folder)
        if found is not None:
            add(found[0], files=[found[1]])
    for pid, t in targets.items():
        save_guard.check_sync(headers, pid, t["fields"], t["files"], everything=t["everything"])


@router.post("/steps/{name}")
async def run_step(name: str, body: dict = Body(default={}), request: Request = None):
    steps = scan_steps()
    if name not in steps:
        raise not_found("not_found", f"Step '{name}' not found")

    schema, py_path = steps[name]
    # Before anything runs, sync or async: where this step may write (serve/out_guard.py).
    check_step_out(name, schema, body, native=job_step_name(name, py_path) == name)
    # §482: what it may write, against open Studio sync clashes (and again by the step itself, under the lock).
    headers = getattr(request, "headers", None)
    check_step_sync(name, schema, body, headers)
    origin = save_guard.step_origin(headers)

    is_async = bool(body.pop("_async", False))
    broadcaster = getattr(request.app.state, "broadcaster", None) if request is not None else None
    if not is_async:
        return await _execute_step(name, schema, py_path, body, origin=origin,
                                   queue_proxies=True, broadcaster=broadcaster)

    # The job records the step by the route's own name, never anything in the
    # body, and only as itself when it is the native step (job_step_name).
    job_id = create_job(job_step_name(name, py_path))
    task = asyncio.create_task(_run_to_job(job_id, name, schema, py_path, body, origin, broadcaster))
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return JSONResponse({"job_id": job_id, "status": "running"}, status_code=202)


@router.get("/steps/jobs/{job_id}")
async def get_step_job(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise not_found("job_not_found", f"Job '{job_id}' not found. Montaj may have restarted: check whether the step's output is there before running it again.")
    return job


def _scrub_secrets(text: str, secrets: list[str]) -> str:
    for value in secrets:
        if value:
            text = text.replace(value, "[redacted]")
            # json.dumps may have escaped characters in the secret; scrub the
            # JSON-encoded form too (drop the surrounding quotes).
            encoded = json.dumps(value)[1:-1]
            if encoded != value:
                text = text.replace(encoded, "[redacted]")
    return text


@router.post("/normalize")
async def normalize_video(body: dict = Body(...), request: Request = None):
    """Normalize a video file to the project's working color space + codec.

    Request:  { "input": "/abs/path/to/video.mp4", "colorSpace": "sdr_bt709", "out": "/abs/path/to/output.mp4" }
    Response: { "path": "/abs/path/to/output.mp4", "skipped": false }
    """
    from lib.types.colorspace import ALL_COLOR_SPACES, DEFAULT_COLOR_SPACE

    input_path = body.get("input")
    if not input_path or not Path(input_path).is_file():
        raise bad_request("missing_input", "'input' must be an absolute path to an existing file")

    color_space = body.get("colorSpace", DEFAULT_COLOR_SPACE)
    if color_space not in ALL_COLOR_SPACES:
        raise bad_request(
            "invalid_color_space",
            f"colorSpace must be one of {ALL_COLOR_SPACES} (got {color_space!r})",
        )
    explicit_out = body.get("out")
    # Where this route may write: the ordinary step rule (serve/out_guard.py).
    check_route_out("normalize", body)
    # §482: the file it writes, `out` or each name the default may take beside the input.
    if explicit_out:
        outs = [explicit_out]
    else:
        from lib.normalize import normalized_output_path
        outs = [normalized_output_path(input_path, color_space, tonemapped=t, sdr_stretch=st)
                for t in (False, True) for st in (False, True)]
    save_guard.check_sync_paths(getattr(request, "headers", None), [(o, False) for o in outs])

    return await asyncio.to_thread(_normalize_sync, input_path, color_space, explicit_out)


def _normalize_sync(input_path: str, color_space: str, explicit_out: str | None) -> dict:
    """Blocking normalize — probe, freshness short-circuit, encode.

    Split out of `normalize_video` so the look-migration job wrapper below can
    drive the exact same work off the event loop without going through the
    (synchronous) HTTP route. Returns the route's `{"path", "skipped"}` payload;
    raises HTTPException on probe/encode failure exactly as the route always has.
    """
    from lib.normalize import normalize, normalized_output_path, probe_video, is_normalized
    from lib.types.colorspace import detect_from_transfer, is_hdr

    info = probe_video(input_path)
    if info is None:
        raise server_error("probe_error", f"Cannot probe {input_path}")

    if is_normalized(input_path, info, color_space):
        return {"path": input_path, "skipped": True}

    tonemapped = is_hdr(detect_from_transfer(info.get("color_transfer"))) and color_space == "sdr_bt709"
    sdr_stretch = not is_hdr(detect_from_transfer(info.get("color_transfer"))) and is_hdr(color_space)
    out = explicit_out or normalized_output_path(input_path, color_space, tonemapped=tonemapped,
                                                 sdr_stretch=sdr_stretch)

    try:
        result_path = normalize(input_path, out, color_space, info=info)
    except SystemExit:
        raise server_error("normalize_failed", "Normalization failed — check ffmpeg and zscale availability")

    return {"path": result_path or out, "skipped": False}


async def run_normalize_job(job_id: str, input_path: str, color_space: str, *, out: str | None = None) -> None:
    """Background driver for a master re-encode: run `_normalize_sync` off the
    event loop and record its result/error on `job_id` — the same job shape
    `_run_proxy_to_job` produces (`{"path": ..., "skipped": ...}`).

    POST /api/normalize is deliberately SYNCHRONOUS (see its docstring above):
    it blocks the caller for the length of the encode. The project-open look
    migration (serve/routes/projects.py) can't block a GET on a multi-minute
    ffmpeg run, so it schedules this wrapper instead — same registry, same
    GET /api/steps/jobs/{job_id} polling surface as every other async step.
    """
    try:
        result = await asyncio.to_thread(_normalize_sync, input_path, color_space, out)
        set_done(job_id, result)
    except HTTPException as e:
        set_error(job_id, e.detail)
    except Exception as e:
        set_error(job_id, {"error": "normalize_failed", "message": str(e)})


def probe_failed_body(e: ProbeError) -> dict:
    """The named error for a file that exists and that ffprobe could not read
    (PV57): the serve error envelope (`error`, `message`) plus the file, the
    failure kind, ffprobe's own words and whether a retry can help
    (lib.color_provenance.is_probe_retryable — the one place that decides
    this, PV57 review; a 'spawn' failure is retryable UNLESS it is ENOENT, no
    ffprobe binary at all, which is an operator problem no retry fixes). One
    shape for an HTTP error's detail, a failed job and a skipped item in a
    batch."""
    return {"error": "probe_failed", "message": str(e), "path": e.path, "reason": e.reason,
            "detail": e.detail, "retryable": is_probe_retryable(e)}


def probe_failed_error(e: ProbeError) -> HTTPException:
    """probe_failed_body as an HTTPException. 503 when a retry can help, so a
    client may retry; 422 when it cannot, since the same file fails the same
    way (including ENOENT: no ffprobe at all needs an operator, not a retry).
    Not the 504 that run_subprocess uses for a timeout: that is the request's
    own operation running out of time, while here the request is fine and a
    dependency was briefly unavailable. Never a 500."""
    body = probe_failed_body(e)
    return HTTPException(503 if body["retryable"] else 422, detail=body)


async def _run_proxy_to_job(job_id: str, schema: dict, py_path: Path, body: dict, *, timeout: int = STEP_TIMEOUT_S) -> None:
    """Background driver for /api/proxy: run the proxy step and record its
    result/error on the job — same shape as _run_to_job, plus a `skipped:
    false` field so a completed job's result matches the fresh-skip response
    (both are `{"path": ..., "skipped": ...}`)."""
    try:
        result = await _execute_step("proxy", schema, py_path, body, timeout=timeout)
        if isinstance(result, dict):
            result.setdefault("skipped", False)
        set_done(job_id, result)
    except HTTPException as e:
        set_error(job_id, e.detail)
    except Exception as e:
        set_error(job_id, {"error": "step_failed", "message": str(e)})


@router.post("/proxy")
async def proxy_video(body: dict = Body(...), request: Request = None):
    """Encode the full-source, 720p, all-intra AV1+Opus editing proxy for `input`.

    Request:  { "input": "/abs/path/to/video.mp4", "out": "/abs/path/to/video_proxy_natural1_h264.mp4", "tonemap": false }
    ("tonemap" defaults to the input's provenance
    (lib.color_provenance.proxy_source_for): HDR-origin footage is graded, so
    backfilling a lazy HDR project can't silently produce an un-tone-mapped
    proxy (SP3 fix S3), and a marked SDR-origin conversion is encoded from its
    SDR original, ungraded (PV42). An explicit true/false overrides that and
    encodes `input` itself. "out" defaults to lib.proxy.proxy_path_for of the
    file the proxy is encoded from.)

    Proxy encodes run for minutes, so — unlike /api/normalize's blocking
    asyncio.to_thread shape — this is the async job pattern: a fresh proxy
    short-circuits synchronously (200, no job), otherwise the encode runs in
    a background job (202 + job_id), polled via the existing
    GET /api/steps/jobs/{job_id}.

    Responses:
      - fresh cache hit:  200 {"path": ..., "skipped": true} — no job started
      - encode needed:    202 {"job_id": ..., "status": "running"}
      - job completion:   GET /api/steps/jobs/{job_id} -> {"status": "done",
                           "result": {"path": ..., "skipped": false}}

    This endpoint only produces the proxy file and returns its path — it does
    NOT write proxySrc into project.json. The caller does that separately via
    PUT /api/projects/{id} (read-modify-write; SSE then delivers it to any
    open editor).
    """
    from lib.proxy import is_proxy_fresh, proxy_path_for

    input_path = body.get("input")
    if not input_path or not Path(input_path).is_file():
        raise bad_request("missing_input", "'input' must be an absolute path to an existing file")

    check_route_out("proxy", body)  # before any probe or encode (serve/out_guard.py)
    if body.get("out"):   # §482: an explicit proxy file in a project folder, before any probe
        save_guard.check_sync_paths(getattr(request, "headers", None), [(body["out"], False)])

    tonemap = body.get("tonemap") if "tonemap" in body else None
    source = input_path  # the file the proxy is encoded from (run_proxy_job's rule)
    if tonemap is None:
        from lib.color_provenance import proxy_source_for
        try:
            source, _ = await asyncio.to_thread(proxy_source_for, input_path)
        except ProbeError as e:
            # The input, or the original its marker names, exists and could not
            # be read, so which file to encode and whether to grade it are both
            # unknown (PV57). No proxy, rather than one graded on a guess and
            # then kept (proxies are fresh by mtime alone): a named error, 503
            # or 422 by whether a retry can help (probe_failed_error).
            raise probe_failed_error(e)

    out = body.get("out") or proxy_path_for(source)
    if not body.get("out"):   # §482: the default proxy file, when it lands in a project folder
        save_guard.check_sync_paths(getattr(request, "headers", None), [(out, False)])

    if is_proxy_fresh(out, source):
        return {"path": out, "skipped": True}

    job_id = create_job()
    task = asyncio.create_task(run_proxy_job(job_id, input_path, out=out, tonemap=tonemap))
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return JSONResponse({"job_id": job_id, "status": "running"}, status_code=202)


async def run_proxy_job(job_id: str, input_path: str, *, out: str, tonemap: bool | None = None) -> None:
    """Drive one proxy encode to completion on `job_id`: resolve the step, decide
    the tonemap arm, size the timeout, then hand off to `_run_proxy_to_job`.

    Split out of `proxy_video` so a caller that needs to OWN the scheduling can
    reuse the exact same encode. The project-open look migration
    (serve/routes/projects.py) does: it bounds how many encodes run at once and
    awaits completion so it can write the fresh path back into project.json,
    neither of which the route's fire-and-forget 202 shape allows.

    `tonemap=None` means "ask the provenance resolver" (the route's default):
    lib.color_provenance.proxy_source_for picks both the file encoded and the
    grade, so a marked SDR-origin conversion is encoded from its original,
    ungraded (PV42). True/False is an explicit override that encodes
    `input_path` itself. `out` is used as given.
    """
    try:
        steps = scan_steps()
        if "proxy" not in steps:
            raise server_error("not_found", "Step 'proxy' not found")
        schema, py_path = steps["proxy"]
        step_body = {"input": input_path, "out": out}
        # tonemap (SP3 fix S3): an explicit value (true OR false) wins; otherwise
        # the input's provenance decides, exactly like init.py: HDR-origin
        # footage is graded, and a marked SDR-origin conversion is encoded from
        # its original, ungraded (PV42).
        if tonemap is not None:
            if tonemap:
                step_body["tonemap"] = True
        else:
            from lib.color_provenance import proxy_source_for
            step_body["input"], graded = await asyncio.to_thread(proxy_source_for, input_path)
            if graded:
                step_body["tonemap"] = True

        # lib/proxy.py's own timeout (max(900, duration * 2)) is duration-scaled so
        # a long-form source doesn't get killed mid-encode — but that math only
        # applies once ffmpeg is already running. The subprocess wrapper here needs
        # its OWN timeout sized the same way, or run_subprocess kills the encode at
        # the flat STEP_TIMEOUT_S (900s) regardless. get_duration() can raise
        # SystemExit (this repo's fail() convention), which a bare `except
        # Exception` would NOT catch — probe failures degrade to the flat default
        # instead of taking down the request.
        from lib.common import get_duration
        try:
            proxy_timeout = max(STEP_TIMEOUT_S, int(get_duration(step_body["input"]) * 3))
        except (Exception, SystemExit):
            proxy_timeout = STEP_TIMEOUT_S
    except ProbeError as e:
        # The grade is unknown (PV57): no encode, and the job fails with the
        # same named error as the route, naming the file and the reason. A
        # look-migration unit that fails this way writes nothing back, so no
        # item is pointed at a proxy graded on a guess.
        set_error(job_id, probe_failed_body(e))
        return
    except HTTPException as e:
        set_error(job_id, e.detail)
        return
    except Exception as e:
        set_error(job_id, {"error": "step_failed", "message": str(e)})
        return

    await _run_proxy_to_job(job_id, schema, py_path, step_body, timeout=proxy_timeout)
