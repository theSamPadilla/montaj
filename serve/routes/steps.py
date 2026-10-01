"""Step discovery, /steps/{name} runner, and /normalize endpoint."""
import asyncio
import json
import os
import sys
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import JSONResponse

from lib.color_provenance import ProbeError, is_probe_retryable
from lib.credentials import CredentialError, build_env_overlay
from serve.common import (
    MONTAJ_ROOT,
    resolve_workspace,
    run_subprocess,
    not_found, bad_request, server_error,
)
from serve.jobs import create_job, set_done, set_error, get_job

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
    whisper default (transcribe, rm_fillers, rm_nonspeech, lyrics_sync,
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
        return STEP_TIMEOUT_S
    from lib.common import get_duration, whisper_runaway_timeout
    from lib.trim_spec import is_trim_spec, load as load_spec
    path = body.get("input") or (body.get("inputs") or [None])[0]
    duration = None
    try:
        if isinstance(path, str) and path:
            if is_trim_spec(path):
                path = load_spec(path)["input"]
            duration = get_duration(path)
    except (Exception, SystemExit):  # get_duration exits through fail()
        duration = None
    if duration is None:
        return max(STEP_TIMEOUT_S, WHISPER_STEP_NO_DURATION_S)
    return max(STEP_TIMEOUT_S, whisper_runaway_timeout(duration) + WHISPER_STEP_OVERHEAD_S)


def scan_steps() -> dict[str, tuple[dict, Path]]:
    """Scan native (built-in) then custom (~/.montaj/steps). Later scope overwrites earlier.
    Returns dict[name, (schema, py_path)]. Schema gets an injected 'category' field from subdirectory name."""
    scopes = [
        MONTAJ_ROOT / "steps",
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
        # Accept both hyphenated (schema canonical) and underscored (JSON convenience).
        val = body.get(name)
        if val is None:
            val = body.get(name.replace("-", "_"))
        if val is None:
            continue
        flag = "--" + name
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
                flags += [flag, str(item)]
        elif isinstance(val, dict):
            flags += [flag, json.dumps(val)]
        else:
            flags += [flag, str(val)]

    if "out" in body:
        flags += ["--out", str(body["out"])]

    return flags


def validate_params(schema: dict, body: dict) -> None:
    """Validate body params against schema constraints. Raises HTTPException 422 on failure."""
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

        if ptype in ("float", "int"):
            try:
                num = float(val) if ptype == "float" else int(val)
            except (TypeError, ValueError):
                errors.append(f"'{name}' must be a {ptype}, got {val!r}")
                continue
            if "min" in param and num < param["min"]:
                errors.append(f"'{name}' must be >= {param['min']}, got {num}")
            if "max" in param and num > param["max"]:
                errors.append(f"'{name}' must be <= {param['max']}, got {num}")

        elif ptype == "enum":
            options = param.get("options", [])
            if val not in options:
                errors.append(f"'{name}' must be one of {options}, got {val!r}")

    if errors:
        raise HTTPException(422, detail={"error": "invalid_params", "message": "; ".join(errors)})


def wrap_output(stdout: str, schema: dict) -> dict:
    """Wrap bare file paths as JSON. Steps that already return JSON pass through."""
    text = stdout.strip()
    if text.startswith(("{", "[")):
        return json.loads(text)
    return {"path": text, "type": schema.get("output", {}).get("type", "file")}


@router.get("/steps")
async def list_steps():
    """Every step's schema, plus `runsWhisper` (`_runs_whisper`): a host that
    gates whisper steps on the model being installed builds its list from this."""
    return [{**schema, "runsWhisper": _runs_whisper(schema)} for schema, _ in scan_steps().values()]


async def _execute_step(name: str, schema: dict, py_path: Path, body: dict, *, timeout: int | None = None) -> dict:
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
        # Passthrough credential values must never leave the server, even when
        # an upstream provider echoes the caller's own key in its error body
        # (OpenAI does: "Incorrect API key provided: <key>"). The error detail
        # transits proxies and logs, so scrub every injected secret value.
        if secret_values:
            err = json.loads(_scrub_secrets(json.dumps(err), secret_values))
        raise HTTPException(500, detail=err)

    return wrap_output(stdout_text, schema)


async def _run_to_job(job_id: str, name: str, schema: dict, py_path: Path, body: dict) -> None:
    """Background driver: run a step and record its result/error on the job."""
    try:
        result = await _execute_step(name, schema, py_path, body)
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


@router.post("/steps/{name}")
async def run_step(name: str, body: dict = Body(default={})):
    steps = scan_steps()
    if name not in steps:
        raise not_found("not_found", f"Step '{name}' not found")

    schema, py_path = steps[name]

    is_async = bool(body.pop("_async", False))
    if not is_async:
        return await _execute_step(name, schema, py_path, body)

    job_id = create_job()
    task = asyncio.create_task(_run_to_job(job_id, name, schema, py_path, body))
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return JSONResponse({"job_id": job_id, "status": "running"}, status_code=202)


@router.get("/steps/jobs/{job_id}")
async def get_step_job(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise not_found("job_not_found", f"Job '{job_id}' not found")
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
async def normalize_video(body: dict = Body(...)):
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
async def proxy_video(body: dict = Body(...)):
    """Encode the full-source, 720p, all-intra AV1+Opus editing proxy for `input`.

    Request:  { "input": "/abs/path/to/video.mp4", "out": "/abs/path/to/video_proxy_vivid1.mp4", "tonemap": false }
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
