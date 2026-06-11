"""Step discovery, /steps/{name} runner, and /normalize endpoint."""
import asyncio
import json
import os
import sys
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from lib.credentials import CredentialError, build_env_overlay
from serve.common import (
    MONTAJ_ROOT,
    run_subprocess,
    not_found, bad_request, server_error,
)

router = APIRouter(prefix="/api")

STEP_TIMEOUT_S = int(os.environ.get("MONTAJ_STEP_TIMEOUT", "900"))


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
        if param.get("type") == "bool":
            if val:
                flags.append(flag)
        elif isinstance(val, list):
            # Repeatable params: emit the flag once per element (matches MCP buildCliArgs).
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
    for param in schema.get("params", []):
        name  = param["name"]
        val   = body.get(name)
        ptype = param.get("type")

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
    return [schema for schema, _ in scan_steps().values()]


@router.post("/steps/{name}")
async def run_step(name: str, body: dict = Body(default={})):
    steps = scan_steps()
    if name not in steps:
        raise not_found("not_found", f"Step '{name}' not found")

    schema, py_path = steps[name]

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

    # Non-blocking subprocess — allows the server to keep serving UI, SSE,
    # and other API requests while long-running steps (kling_generate, etc.)
    # are in progress.
    try:
        stdout_text, stderr_text, returncode = await run_subprocess(
            [sys.executable, str(py_path), *cli_args],
            timeout=STEP_TIMEOUT_S,
            cwd=str(Path.cwd()),
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
    out = body.get("out") or f"{input_path.rsplit('.', 1)[0]}_normalized_{color_space}.mp4"

    def _run():
        from lib.normalize import normalize, probe_video, is_normalized

        info = probe_video(input_path)
        if info is None:
            raise server_error("probe_error", f"Cannot probe {input_path}")

        if is_normalized(input_path, info, color_space):
            return {"path": input_path, "skipped": True}

        try:
            result_path = normalize(input_path, out, color_space, info=info)
        except SystemExit:
            raise server_error("normalize_failed", "Normalization failed — check ffmpeg and zscale availability")

        return {"path": result_path or out, "skipped": False}

    return await asyncio.to_thread(_run)
