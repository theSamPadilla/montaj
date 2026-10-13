"""Tripo v3 API client: 3D models from text or images, rigging and animation.

One vendor, one API key, direct HTTP via requests. See docs/CONNECTORS.md for
the layering rule. Facts below were read from Tripo's own docs on 2026-10-13
(developers.tripo3d.ai/en/docs: introduction, files, task-query, task-lifecycle,
billing, rate-limits, error-handling, generation-image-to-model); re-read the
endpoint's page before building a request body for it.

Host: https://openapi.tripo3d.ai/v3 (the international site). The China site is
a different host (openapi.tripo3d.com) with its own keys and is NOT used here.
Auth: `Authorization: Bearer <api_key>`; keys are made in the Tripo console.
Every response is an envelope: success `{"code": 0, "data": {...}}`, failure
`{"code": <int>, "message": str, "suggestion": str}` (plus a request_id).

Task flow, the same for every generation, model and animation endpoint:
    POST /generation/…  (or /models/…, /animations/…)  -> {task_id}
        (credits are frozen at submit; a failed or cancelled task releases them)
    GET  /tasks/{task_id}  until status is success (output.model_url, …) or a
        terminal failure: failed, banned (content policy), expired (the output
        files are gone), cancelled. queued and running are the live statuses.
Local files go up first: POST /files (multipart field `file`) -> {file_token}.
Images JPEG/PNG up to 20 MB; models GLB/GLTF/FBX/OBJ/STL up to 150 MB. The
token goes in a later request's `input`. GET /account/balance (free, data
{balance, frozen}) is the key check.

Errors worth a distinct reason (error-handling.md): 1000/1001 or HTTP 401 bad
key; 2010 out of credits (can arrive as HTTP 403); 2008 content policy; 2015
version deprecated; 1007 (rate limit) and 2000 (per-category concurrency) on
HTTP 429, which carries a `Retry-After` header and queued nothing.

Current functions:
    upload(path) -> str                       # file_token
    create(endpoint, body) -> str             # task_id
    wait(task_id) -> dict                     # the finished task's data
    download(url, out_path) -> str
    resume(task_id, out_path) -> dict         # wait + download model_url: {path, taskId, creditsUsed}
    check_key() -> dict

Library code: raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import os, time
from urllib.parse import quote

from connectors import (ConnectorError, _http, CONTENT_REFUSED, INSUFFICIENT_CREDIT,
                        INVALID_API_KEY, MODEL_RETIRED, UNREACHABLE)
from lib.credentials import get_credential, CredentialError

API = "https://openapi.tripo3d.ai/v3"

# The newest geometry model Tripo's image-to-model page lists as "latest" (2026-10-13).
DEFAULT_MODEL = "v3.1-20260211"

# Upload limits and types (files.md). Sizes are read as MiB, so a file Tripo
# would call "over 20 MB" and we call under is still refused by Tripo itself.
IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}
MODEL_TYPES = (".glb", ".gltf", ".fbx", ".obj", ".stl")
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_MODEL_BYTES = 150 * 1024 * 1024

# A 3D task takes from tens of seconds to a few minutes. The poll stops short of
# serve's default 900 s step timeout, and says the task id so `resume` can pick
# it up without paying twice.
POLL_INTERVAL_S = 5.0
MAX_POLL_S = 840.0
MAX_CONSECUTIVE_POLL_FAILURES = 5

# A 429 queued nothing and charged nothing, so the same request is repeated after
# the server's own Retry-After (seconds), at most BUSY_RETRIES times.
BUSY_RETRIES = 3
BUSY_DEFAULT_WAIT_S = 5.0
BUSY_MAX_WAIT_S = 30.0

_KEY_CODES = frozenset({1000, 1001})
_BUSY_CODES = frozenset({1007, 2000})
_SERVER_STATUSES = frozenset({500, 502, 503, 504})


class _Busy(ConnectorError):
    """Tripo refused with a rate or concurrency limit and kept refusing. Distinct
    from other errors only so a poll loop can treat it as transient."""


def _key() -> str:
    try:
        return get_credential("tripo", "api_key").strip()
    except CredentialError as e:
        raise CredentialError(f"Tripo needs an API key. {e}") from e


def _headers() -> dict:
    # No Content-Type: requests sets it for the JSON and the multipart bodies.
    return {"Authorization": f"Bearer {_key()}"}


def _body(resp) -> dict:
    try:
        b = resp.json()
        return b if isinstance(b, dict) else {}
    except Exception:
        return {}


def _code(body: dict) -> int | None:
    c = body.get("code")
    if isinstance(c, bool):
        return None
    if isinstance(c, int):
        return c
    if isinstance(c, str) and c.strip().lstrip("-").isdigit():
        return int(c)
    return None


def _message(body: dict, text: str = "") -> str:
    """Tripo's own error text: {message, suggestion}."""
    msg = str(body.get("message") or "").strip() or (text or "").strip()[:300] or "no message"
    suggestion = str(body.get("suggestion") or "").strip()
    if suggestion:
        msg += f" ({suggestion})"
    return msg[:600]


def _retry_after(resp) -> float:
    """Seconds to wait before repeating a refused request: the Retry-After
    header, else a default, never more than the cap."""
    raw = (getattr(resp, "headers", None) or {}).get("Retry-After")
    try:
        wait = float(raw)
    except (TypeError, ValueError):
        return BUSY_DEFAULT_WAIT_S
    if wait < 0 or wait != wait:
        return BUSY_DEFAULT_WAIT_S
    return min(wait, BUSY_MAX_WAIT_S)


def _error(status: int, body: dict, text: str, what: str) -> ConnectorError:
    """The ConnectorError for a failed response. Tripo's business `code` decides
    first (an out-of-credits refusal can come as HTTP 403), then the status."""
    code, msg = _code(body), _message(body, text)
    if status == 401 or code in _KEY_CODES:
        return ConnectorError(
            f"Tripo rejected the API key ({msg}). Create the key on tripo3d.ai, the "
            f"international site, not the China site, then save it again.",
            reason=INVALID_API_KEY)
    if code == 2010:
        return ConnectorError("Tripo: not enough credits. Add credit at platform.tripo3d.ai.",
                              reason=INSUFFICIENT_CREDIT)
    if code == 2008:
        return ConnectorError(
            f"Tripo's content policy refused the input ({msg}). Change the prompt or the "
            f"image and try again.", reason=CONTENT_REFUSED)
    if code == 2015:
        return ConnectorError(
            f"Tripo says this API or model version is deprecated ({msg}). Update Montaj "
            f"to a release that uses the current one.", reason=MODEL_RETIRED)
    if status >= 500:
        return ConnectorError(f"Tripo {what} failed (HTTP {status}): {msg}. Tripo is not "
                              f"responding; try again shortly.", reason=UNREACHABLE)
    if status == 403:
        return ConnectorError(f"Tripo {what} was refused (HTTP 403): {msg}")
    where = f"HTTP {status}" + (f", code {code}" if code is not None else "")
    return ConnectorError(f"Tripo {what} failed ({where}): {msg}")


def _request(method: str, path: str, what: str, *, busy_retries: int = BUSY_RETRIES,
             repeatable: bool = True, **kwargs):
    """One Tripo call; the envelope's `data`. Raises ConnectorError for everything
    else, with the reason set where the step needs to branch.

    A 429 (or code 1007/2000) is repeated after Retry-After, `busy_retries` times,
    then raised as _Busy. repeatable=False is for a submit: a request that timed
    out, or came back 5xx, may already be a task, so it is never repeated by the
    transport (a 429 still is, because it queued nothing).
    """
    headers = _headers()
    for attempt in range(busy_retries + 1):
        try:
            r = _http.request_with_retry(
                method, f"{API}{path}", headers=headers,
                retry_statuses=_SERVER_STATUSES if repeatable else frozenset(),
                retry_exceptions=repeatable, **kwargs)
        except ConnectorError as e:
            hint = "" if repeatable else (
                " If it timed out, the task may still have been created (its credits stay "
                "frozen until it finishes); check the Tripo console before generating again.")
            raise ConnectorError(f"Tripo {what} failed: {e}.{hint}", reason=UNREACHABLE) from e
        body, text = _body(r), getattr(r, "text", "") or ""
        if r.status_code == 429 or _code(body) in _BUSY_CODES:
            if attempt < busy_retries:
                time.sleep(_retry_after(r))
                continue
            raise _Busy(f"Tripo is busy: it refused the {what} {attempt + 1} "
                        f"time{'s' if attempt else ''} in a row ({_message(body, text)}). "
                        f"Wait a minute and try again.")
        if r.status_code >= 400 or _code(body) not in (0, None):
            raise _error(r.status_code, body, text, what)
        if not body:
            raise ConnectorError(f"Tripo {what} returned an unreadable response (HTTP {r.status_code})",
                                 reason=UNREACHABLE)
        return body.get("data")


def upload(path: str) -> str:
    """Upload a local image (JPEG/PNG, up to 20 MB) or model (GLB, GLTF, FBX, OBJ,
    STL, up to 150 MB) to Tripo; its file_token. The type and size are checked
    here first, so a file Tripo would refuse is never sent."""
    name = os.path.basename(path or "")
    ext = os.path.splitext(name)[1].lower()
    if ext in IMAGE_TYPES:
        limit, content_type, kind = MAX_IMAGE_BYTES, IMAGE_TYPES[ext], "images"
    elif ext in MODEL_TYPES:
        limit, content_type, kind = MAX_MODEL_BYTES, "application/octet-stream", "models"
    else:
        raise ConnectorError(
            f"Tripo takes images as JPEG or PNG and models as GLB, GLTF, FBX, OBJ or STL; "
            f"{name or 'the file'} is {ext or 'a file with no extension'}")
    try:
        size = os.path.getsize(path)
    except OSError as e:
        raise ConnectorError(f"Could not read {path}: {e}") from e
    if size == 0:
        raise ConnectorError(f"Tripo can't use {name}: the file is empty")
    if size > limit:
        raise ConnectorError(f"Tripo takes {kind} up to {limit >> 20} MB; {name} is {size / (1 << 20):.1f} MB")
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as e:
        raise ConnectorError(f"Could not read {path}: {e}") from e
    result = _request("POST", "/files", "upload", files={"file": (name, data, content_type)}, timeout=300)
    token = result.get("file_token") if isinstance(result, dict) else None
    if not token:
        raise ConnectorError(f"Tripo upload of {name} returned no file_token")
    return str(token)


def create(endpoint: str, body: dict) -> str:
    """POST a task. `endpoint` is the path under /v3 (e.g. "/generation/image-to-model");
    returns its task_id. Nothing here knows the body's shape: the caller builds it
    from the endpoint's own page. A submit that timed out or came back 5xx is never
    repeated, since it may already be a task."""
    if not isinstance(endpoint, str) or not endpoint.startswith("/"):
        raise ConnectorError(f"Tripo endpoint must be a path under /v3 starting with '/', got {endpoint!r}")
    if not isinstance(body, dict):
        raise ConnectorError("Tripo request body must be an object")
    result = _request("POST", endpoint, "submit", json=body, timeout=120, repeatable=False)
    task_id = result.get("task_id") if isinstance(result, dict) else None
    if not task_id:
        raise ConnectorError("Tripo accepted the task but returned no task_id")
    return str(task_id)


def _credits(value) -> float | None:
    """credits_consumed is a JSON number with up to two decimals: a float, never an int."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _terminal_error(task_id: str, status: str, task: dict) -> ConnectorError | None:
    """The error for a task that ended without an output, or None while it is live."""
    if status == "failed":
        code, message = task.get("error_code"), task.get("error_message")
        detail = (f" ({code}: {message})" if code is not None and message else
                  f" ({code})" if code is not None else f" ({message})" if message else "")
        return ConnectorError(f"Tripo task {task_id} failed{detail}. A failed task is not charged.")
    if status == "banned":
        return ConnectorError(
            f"Tripo's content policy refused task {task_id}. Change the prompt or the image "
            f"and try again.", reason=CONTENT_REFUSED)
    if status == "expired":
        return ConnectorError(f"Tripo task {task_id} expired: its output files are no longer "
                              f"available. Generate it again.")
    if status == "cancelled":
        return ConnectorError(f"Tripo task {task_id} was cancelled. A cancelled task is not charged.")
    return None


def wait(task_id: str) -> dict:
    """Poll the task until it succeeds; its data. A task that ended any other way
    raises. Transient poll failures are tolerated (MAX_CONSECUTIVE_POLL_FAILURES in
    a row); the task is already submitted, so giving up says how to pick it up
    again rather than to regenerate. An unknown status counts as still running."""
    if not task_id:
        raise ConnectorError("task_id is required")
    path = f"/tasks/{quote(str(task_id), safe='')}"
    elapsed, failures, last = 0.0, 0, None
    while elapsed < MAX_POLL_S:
        task = None
        try:
            # A 429 while polling is just a missed tick: the loop is the retry.
            task = _request("GET", path, f"status check for task {task_id}", timeout=30, busy_retries=0)
        except _Busy as e:
            last = e
        except ConnectorError as e:
            if e.reason != UNREACHABLE:
                raise
            last = e
        if task is None:
            failures += 1
            if failures >= MAX_CONSECUTIVE_POLL_FAILURES:
                raise ConnectorError(
                    f"Tripo task {task_id}: {failures} status checks failed in a row. It may still "
                    f"finish; resume it with --task-id {task_id} instead of generating again. "
                    f"Last error: {last}")
        else:
            failures = 0
            task = task if isinstance(task, dict) else {}
            status = str(task.get("status") or "").lower()
            if status == "success":
                return task
            error = _terminal_error(task_id, status, task)
            if error:
                raise error
        time.sleep(POLL_INTERVAL_S)
        elapsed += POLL_INTERVAL_S
    raise ConnectorError(
        f"Tripo task {task_id} is still running after {MAX_POLL_S:.0f} s. It is submitted and "
        f"may still finish: resume it with --task-id {task_id} instead of generating again.")


def download(url: str, out_path: str) -> str:
    """Fetch a finished output (a signed CDN URL: no API key is sent) to out_path.
    Written beside it first and renamed, so a failed download leaves no partial file."""
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        raise ConnectorError(f"Tripo returned an unusable download URL: {url!r}")
    if not out_path:
        raise ConnectorError("out_path is required")
    tmp = f"{out_path}.part"
    try:
        _http.download_file(url, tmp, timeout=300)
        os.replace(tmp, out_path)
    except Exception as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        if isinstance(e, ConnectorError):
            raise
        if isinstance(e, OSError):
            raise ConnectorError(f"Could not write {out_path}: {e}") from e
        raise ConnectorError(f"Tripo download failed: {e}", reason=UNREACHABLE) from e
    return out_path


def resume(task_id: str, out_path: str) -> dict:
    """Wait for an already-submitted task and download its model: no new task, no
    new charge. Returns {path, taskId, creditsUsed} (creditsUsed a float, or None)."""
    if not task_id:
        raise ConnectorError("task_id is required")
    if not out_path:
        raise ConnectorError("out_path is required")
    task = wait(task_id)
    output = task.get("output") if isinstance(task.get("output"), dict) else {}
    url = output.get("model_url")
    if not url:
        raise ConnectorError(f"Tripo task {task_id} succeeded but returned no model_url")
    path = download(url, out_path)
    return {"path": path, "taskId": task_id, "creditsUsed": _credits(task.get("credits_consumed"))}


def _number(value) -> str:
    return f"{float(value):.2f}".rstrip("0").rstrip(".")


def check_key() -> dict:
    """Validate the stored/overlaid key with one free call: GET /account/balance
    (a read of the live balance). Returns the balance as `credits` (and the frozen
    credits as `frozen`). The default model can't be confirmed without a task, so
    default_model_verified is False."""
    data = _request("GET", "/account/balance", "key check", timeout=15)
    data = data if isinstance(data, dict) else {}
    balance, frozen = _credits(data.get("balance")), _credits(data.get("frozen"))
    result = {
        "ok": True,
        "default_model": DEFAULT_MODEL,
        "default_model_ok": True,
        "default_model_verified": False,
        "credits": balance,
        "detail": f"balance {_number(balance)} credits" if balance is not None else "balance unknown",
    }
    if frozen is not None:
        result["frozen"] = frozen
    return result
