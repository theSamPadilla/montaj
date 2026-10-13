"""Tripo v3 API client: 3D models from text or images, rigging and animation.

One vendor, one API key, direct HTTP via requests. See docs/CONNECTORS.md for
the layering rule. Facts below were read from Tripo's own docs on 2026-10-13
(developers.tripo3d.ai/en/docs: introduction, files, task-query, task-lifecycle,
billing, rate-limits, error-handling, generation-text-to-model,
generation-image-to-model, generation-multiview-to-model); re-read the
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
    build_generation_body(...) -> (endpoint, body)   # pure, validates
    generate_model(out_path=..., ...) -> dict # text, image or multiview to a .glb
    resume_model(task_id, out_path) -> dict   # collect a generation already submitted
    check_key() -> dict

A generated model is recorded beside its output before Tripo is polled:
`<out>.tripo.json` = {task_id, kind: "model", model, endpoint, created} (and
credits_consumed once it finishes). A run that stopped (a timeout, a closed
laptop) and is retried with the same out re-attaches to that task instead of
paying for a new one; a task that ended without a model (failed, banned,
expired, cancelled) removes the record, so the retry submits again.

Library code: raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import json, os, sys, time
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit

from connectors import (ConnectorError, _http, CONTENT_REFUSED, INSUFFICIENT_CREDIT,
                        INVALID_API_KEY, MODEL_RETIRED, UNREACHABLE)
from lib.credentials import get_credential, CredentialError
from lib.glb_textures import GlbTextureError, ensure_supported_textures

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

# Generation, from generation-{text,image,multiview}-to-model/standard.md (read
# 2026-10-13). Only what Montaj sends is listed: the body never carries quad (it
# forces FBX), compress (meshopt), generate_parts (no textures), smart_low_poly
# or export_orientation (a later rig or convert can come out wrongly oriented
# while the task still reports success).
GENERATION_ENDPOINTS = {
    "text": "/generation/text-to-model",
    "image": "/generation/image-to-model",
    "multiview": "/generation/multiview-to-model",
}
PROMPT_MAX = 1024            # text-to-model: "up to 1024 characters"
NEGATIVE_PROMPT_MAX = 255    # text-to-model: "up to 255 characters"
TEXTURE_QUALITIES = ("standard", "detailed")
VIEWS = ("front", "left", "back", "right")   # the order the server canonicalizes to
# Montaj's budget, not Tripo's limit (v3.1 takes up to 1.5M triangles): it keeps a
# model under the editor's 300k-vertex cap.
FACE_LIMIT_DEFAULT = 30000
FACE_LIMIT_RANGE = (1000, 150000)

SIDECAR_SUFFIX = ".tripo.json"

_KEY_CODES = frozenset({1000, 1001})
_BUSY_CODES = frozenset({1007, 2000})
_SERVER_STATUSES = frozenset({500, 502, 503, 504})


class _Busy(ConnectorError):
    """Tripo refused with a rate or concurrency limit and kept refusing. Distinct
    from other errors only so a poll loop can treat it as transient."""


class _TaskEnded(ConnectorError):
    """The task reached a terminal status with no output (failed, banned, expired,
    cancelled): waiting again can't help, so a resume record for it is dropped."""


class UnsupportedModel(ConnectorError):
    """Tripo delivered a model Montaj can't load and this module can't fix
    (compressed geometry, a KTX2 texture, a file outside the GLB). `kind` is
    lib.glb_textures.GlbTextureError's kind; `task_id` is the paid task."""

    def __init__(self, message: str, kind: str, task_id: str):
        super().__init__(message)
        self.kind = kind
        self.task_id = task_id


def _warn(message: str) -> None:
    print(json.dumps({"warn": message}), file=sys.stderr)


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
        if _code({"code": code}) == 2008:
            return _TaskEnded(
                f"Tripo's content policy refused task {task_id}{detail}. Change the prompt or the "
                f"image and try again. A failed task is not charged.", reason=CONTENT_REFUSED)
        return _TaskEnded(f"Tripo task {task_id} failed{detail}. A failed task is not charged.")
    if status == "banned":
        return _TaskEnded(
            f"Tripo's content policy refused task {task_id}. Change the prompt or the image "
            f"and try again.", reason=CONTENT_REFUSED)
    if status == "expired":
        return _TaskEnded(f"Tripo task {task_id} expired: its output files are no longer "
                          f"available. Generate it again.")
    if status == "cancelled":
        return _TaskEnded(f"Tripo task {task_id} was cancelled. A cancelled task is not charged.")
    return None


def wait(task_id: str) -> dict:
    """Poll the task until it succeeds; its data. A task that ended any other way
    raises. Transient poll failures are tolerated (MAX_CONSECUTIVE_POLL_FAILURES in
    a row); the task is already submitted, so giving up says how to pick it up
    again rather than to regenerate. An unknown status counts as still running."""
    if not task_id:
        raise ConnectorError("task_id is required")
    path = f"/tasks/{quote(str(task_id), safe='')}"
    # Wall time, so the time each status check itself takes counts too.
    start, failures, last = time.monotonic(), 0, None
    while time.monotonic() - start < MAX_POLL_S:
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
    raise ConnectorError(
        f"Tripo task {task_id} is still running after {MAX_POLL_S:.0f} s. It is submitted and "
        f"may still finish: resume it with --task-id {task_id} instead of generating again.")


def _plain_url(url: str) -> str:
    """A signed URL without its query string: the signature is a credential."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def download(url: str, out_path: str) -> str:
    """Fetch a finished output (a signed CDN URL: no API key is sent) to out_path.
    Written beside it first and renamed, so a failed download leaves no partial file.
    A network failure (or a 5xx after the transport's retries) is UNREACHABLE."""
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        raise ConnectorError(f"Tripo returned an unusable download URL: {url!r}")
    if not out_path:
        raise ConnectorError("out_path is required")
    tmp = f"{out_path}.part"
    try:
        try:
            r = _http.request_with_retry("GET", url, stream=True, timeout=300)
        except ConnectorError as e:
            raise ConnectorError(f"Tripo download of {_plain_url(url)} failed: {e}",
                                 reason=UNREACHABLE) from e
        if r.status_code >= 400:
            raise ConnectorError(
                f"Tripo download failed (HTTP {r.status_code}): {_plain_url(url)}",
                reason=UNREACHABLE if r.status_code >= 500 else None)
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
        os.replace(tmp, out_path)
    except Exception as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        if isinstance(e, ConnectorError):
            raise
        # requests' own errors subclass OSError: a dropped stream is the network, not the disk.
        if isinstance(e, OSError) and not isinstance(e, _http._require_requests().RequestException):
            raise ConnectorError(f"Could not write {out_path}: {e}") from e
        raise ConnectorError(f"Tripo download of {_plain_url(url)} failed: {e}", reason=UNREACHABLE) from e
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


# ---------------------------------------------------------------------------
# Generation: text, image or multiview to a .glb
# ---------------------------------------------------------------------------

def _face_limit(value) -> int:
    """The face budget: FACE_LIMIT_DEFAULT when unset, clamped to FACE_LIMIT_RANGE."""
    if value is None:
        return FACE_LIMIT_DEFAULT
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConnectorError(f"Tripo face_limit must be a whole number, got {value!r}")
    lo, hi = FACE_LIMIT_RANGE
    clamped = min(max(value, lo), hi)
    if clamped != value:
        _warn(f"Tripo face_limit {value} is outside {lo:,}-{hi:,}; using {clamped:,}")
    return clamped


def _view_inputs(views) -> list[dict]:
    """The multiview `inputs`, view-key form: one {view: image} object per view
    given, in the canonical order. Front is required, and at least 2 views."""
    if not isinstance(views, dict):
        raise ConnectorError("Tripo views must map front, left, back or right to an image")
    unknown = sorted(str(k) for k in views if k not in VIEWS)
    if unknown:
        raise ConnectorError(f"Tripo views are front, left, back and right; got {', '.join(unknown)}")
    given = {k: v for k, v in views.items() if v is not None}
    for name, value in given.items():
        if not isinstance(value, str) or not value.strip():
            raise ConnectorError(f"Tripo's {name} view is empty")
    if "front" not in given:
        raise ConnectorError("Tripo multiview needs a front view")
    if len(given) < 2:
        raise ConnectorError("Tripo multiview needs at least 2 views: the front and one of left, back or right")
    return [{name: given[name]} for name in VIEWS if name in given]


def build_generation_body(*, prompt=None, image_input=None, views=None, texture="standard",
                          face_limit=None, negative_prompt=None, model=DEFAULT_MODEL) -> tuple[str, dict]:
    """Validate and build one generation request: (endpoint, body). No HTTP.

    Exactly one mode: `prompt` (text-to-model), `image_input` (image-to-model:
    a file_token or URL) or `views` ({front, left?, back?, right?} of file_tokens
    or URLs: multiview-to-model). A value of None means not given. Every body
    asks for PBR textures at `texture` quality ("standard" or "detailed") and
    sets face_limit (FACE_LIMIT_DEFAULT unless given, clamped to FACE_LIMIT_RANGE).
    `negative_prompt` goes with a text prompt only.
    """
    modes = [m for m, v in (("text", prompt), ("image", image_input), ("multiview", views)) if v is not None]
    if len(modes) != 1:
        got = f"; got {' and '.join(modes)}" if modes else ""
        raise ConnectorError("Tripo makes a model from exactly one of a prompt, an image or views "
                             f"(the front and at least one more){got}")
    mode = modes[0]
    if not isinstance(model, str) or not model.strip():
        raise ConnectorError(f"Tripo model must be a version string, got {model!r}")
    if texture not in TEXTURE_QUALITIES:
        raise ConnectorError(f"Tripo texture must be one of {', '.join(TEXTURE_QUALITIES)}, got {texture!r}")
    faces = _face_limit(face_limit)
    if negative_prompt is not None and not isinstance(negative_prompt, str):
        raise ConnectorError(f"Tripo negative prompt must be text, got {negative_prompt!r}")
    negative = negative_prompt if negative_prompt and negative_prompt.strip() else None

    body = {}
    if mode == "text":
        if not isinstance(prompt, str) or not prompt.strip():
            raise ConnectorError("Tripo needs a prompt: it must not be empty")
        if len(prompt) > PROMPT_MAX:
            raise ConnectorError(f"Tripo prompts are up to {PROMPT_MAX} characters; this one is {len(prompt)}")
        body["prompt"] = prompt
        if negative is not None:
            if len(negative) > NEGATIVE_PROMPT_MAX:
                raise ConnectorError(f"Tripo negative prompts are up to {NEGATIVE_PROMPT_MAX} characters; "
                                     f"this one is {len(negative)}")
            body["negative_prompt"] = negative
    elif negative is not None:
        raise ConnectorError("Tripo takes a negative prompt with a text prompt only, not with an image or views")
    elif mode == "image":
        if not isinstance(image_input, str) or not image_input.strip():
            raise ConnectorError("Tripo needs an image: it must not be empty")
        body["input"] = image_input
    else:
        body["inputs"] = _view_inputs(views)
    body.update(model=model, texture=True, pbr=True, texture_quality=texture, face_limit=faces)
    return GENERATION_ENDPOINTS[mode], body


def sidecar_path(out_path: str) -> str:
    """Where a model's task record lives: `<out>.tripo.json`."""
    return f"{out_path}{SIDECAR_SUFFIX}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _read_sidecar(out_path: str) -> dict | None:
    """The task record beside out_path, or None when there is none (or it names
    no task). An unreadable one is refused: it may be the only note of a paid task."""
    path = sidecar_path(out_path)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            record = json.load(f)
    except (OSError, ValueError) as e:
        raise ConnectorError(
            f"The Tripo task record {path} is unreadable ({e}). If you know its task id, collect "
            f"it with --task-id; otherwise delete the file and generate again.") from e
    if not isinstance(record, dict) or not record.get("task_id"):
        return None
    kind = record.get("kind", "model")
    if kind != "model":
        raise ConnectorError(f"{path} records a Tripo {kind} task, not a model. Choose another output path.")
    return record


def _write_sidecar(out_path: str, record: dict) -> None:
    """Write the task record atomically. A failure is a warning, not an error:
    the task is already paid for, and the record is only the way back to it."""
    path, tmp = sidecar_path(out_path), sidecar_path(out_path) + ".part"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except OSError as e:
        _remove(tmp)
        task_id = record.get("task_id")
        _warn(f"Could not record Tripo task {task_id} in {path} ({e}). If this run stops, "
              f"collect the task with --task-id {task_id}.")


def _check_out(out_path: str) -> None:
    if not out_path:
        raise ConnectorError("out_path is required")
    if not str(out_path).lower().endswith(".glb"):
        raise ConnectorError(f"Tripo models are GLB files: the output path must end in .glb, got {out_path}")
    if os.path.lexists(out_path):
        raise ConnectorError(f"{out_path} already exists. Montaj does not overwrite a model: "
                             f"choose a new output path.")


def _unsupported(e: GlbTextureError, task_id: str) -> UnsupportedModel:
    if e.kind == "compressed":
        message = f"Tripo returned a compressed model; Montaj needs it uncompressed ({e}, task {task_id})."
    else:
        message = f"Tripo returned a model Montaj can't use: {e} (task {task_id})."
    return UnsupportedModel(message, e.kind, task_id)


def _collect(record: dict, out_path: str) -> dict:
    """Wait for the recorded task, download its model, make its textures ones
    Montaj reads, and only then put it at out_path. Returns the step's result."""
    task_id = record["task_id"]
    try:
        task = wait(task_id)
    except _TaskEnded:
        _remove(sidecar_path(out_path))   # nothing to collect: a retry submits again
        raise
    output = task.get("output") if isinstance(task.get("output"), dict) else {}
    url = output.get("model_url")
    if not url:
        raise ConnectorError(f"Tripo task {task_id} succeeded but returned no model_url")
    staged = f"{out_path}.download"
    try:
        try:
            download(url, staged)
        except ConnectorError as e:
            raise ConnectorError(f"{e}. The model is made and paid for: collect it again with "
                                 f"--task-id {task_id} (no new charge).", reason=e.reason) from e
        try:
            report = ensure_supported_textures(staged)
        except GlbTextureError as e:
            raise _unsupported(e, task_id) from e
        except OSError as e:
            raise ConnectorError(f"Could not read the downloaded model {staged}: {e}") from e
        try:
            os.replace(staged, out_path)
        except OSError as e:
            raise ConnectorError(f"Could not write {out_path}: {e}") from e
    finally:
        _remove(staged)
    credits = _credits(task.get("credits_consumed"))
    _write_sidecar(out_path, {**record, "credits_consumed": credits})
    return {"path": out_path, "taskId": task_id, "model": record.get("model"),
            "creditsUsed": credits, "textures": report}


def _source(value):
    """A local image uploaded (its file_token); a URL, None or "" as it is."""
    if not value or str(value).startswith(("http://", "https://")):
        return value
    return upload(value)


def _placeholder(value):
    return "u" if value else value


def generate_model(*, out_path, prompt=None, image_path=None, view_paths=None, texture="standard",
                   face_limit=None, negative_prompt=None) -> dict:
    """Text, image or multiview to a .glb at out_path (which must not exist yet).
    Local images are uploaded first (URLs pass through); view_paths maps front,
    left, back and right to an image (None for a view not given).

    The task is recorded in `<out>.tripo.json` before polling. When that record
    exists and out_path does not, this re-attaches to the recorded task (no new
    task, no new charge) and the inputs given here are not sent.

    Returns {path, taskId, model, creditsUsed, textures}: textures is
    lib.glb_textures.ensure_supported_textures's report. Raises UnsupportedModel
    when the GLB can't be made loadable, ConnectorError for everything else."""
    _check_out(out_path)
    record = _read_sidecar(out_path)
    if record:
        _warn(f"Re-attaching to Tripo task {record['task_id']} recorded in {sidecar_path(out_path)}: "
              f"no new task, no new charge. This run's inputs are not sent.")
        return _collect(record, out_path)

    faces = _face_limit(face_limit)
    views = dict(view_paths) if isinstance(view_paths, dict) else view_paths
    kwargs = dict(texture=texture, face_limit=faces, negative_prompt=negative_prompt)
    # Dry run first: a bad input costs neither an upload nor a submit.
    build_generation_body(
        prompt=prompt, image_input=_placeholder(image_path),
        views={k: _placeholder(v) for k, v in views.items()} if isinstance(views, dict) else views, **kwargs)
    try:
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    except OSError as e:
        raise ConnectorError(f"Could not make the folder for {out_path}: {e}") from e
    endpoint, body = build_generation_body(
        prompt=prompt, image_input=_source(image_path),
        views={k: _source(v) for k, v in views.items()} if isinstance(views, dict) else views, **kwargs)
    task_id = create(endpoint, body)
    record = {"task_id": task_id, "kind": "model", "model": body["model"], "endpoint": endpoint,
              "created": _now()}
    _write_sidecar(out_path, record)
    return _collect(record, out_path)


def resume_model(task_id: str, out_path: str) -> dict:
    """Collect a generation already submitted (a run that stopped): wait, download,
    fix the textures. No new task, no new charge. Records the task beside out_path
    first, keeping what an existing record for the same task says."""
    if not task_id:
        raise ConnectorError("task_id is required")
    _check_out(out_path)
    try:
        record = _read_sidecar(out_path)
    except ConnectorError:
        record = None     # the explicit task id wins over an unreadable or other record
    if not record or record.get("task_id") != task_id:
        record = {"task_id": task_id, "kind": "model", "model": None, "endpoint": None, "created": _now()}
    _write_sidecar(out_path, record)
    return _collect(record, out_path)


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
