"""fal.ai queue client, used for ByteDance Seedance video (PV29).

One vendor, one API key, direct HTTP via requests. See docs/CONNECTORS.md for
the layering rule. Facts below were verified live on 2026-09-28
(montaj-app docs/plans/PV29-vendor-facts.md).

Auth: `Authorization: Key <api_key>`. Queue flow: POST
https://queue.fal.run/<endpoint_id> → {request_id, status_url, response_url};
poll status_url until COMPLETED; GET response_url → {"video": {"url": ...}}.

Three modes, picked from the inputs:
    t2v  text only
    i2v  image_path (first frame), optional end_image_path (last frame)
    r2v  reference_image_paths (up to the model's max_refs); the prompt names
         them @Image1, @Image2… in list order. The connector does not touch the
         prompt, like Kling's <<<image_N>>> tokens.

Images go in as JPEG data URIs (accepted live, no upload step), re-encoded
through Pillow: EXIF-rotated, transparency flattened onto white, longest side
capped at FRAME_MAX_SIDE for first/last frames and REF_MAX_SIDE for references.
Inputs a mode doesn't take (seed, a fixed aspect ratio) are dropped with a
{"warn": …} line on stderr rather than sent to a 422.

Current functions:
    build_request(prompt, ...) -> (endpoint_id, body)   # pure, validates
    generate_video(prompt, out_path, ...) -> str        # path to downloaded .mp4
    submit(model_id, payload) -> dict
    wait(status_url) -> dict
    fetch_result(response_url) -> dict
    check_key() -> dict

Library code — raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import base64, io, json, re, sys, time
from connectors import ConnectorError, _http, classify_http_error, MODEL_RETIRED, UNREACHABLE
from lib.credentials import get_credential, CredentialError

QUEUE = "https://queue.fal.run"
MODELS_API = "https://api.fal.ai/v1/models"

MODES = ("t2v", "i2v", "r2v")
ASPECT_RATIOS = ("auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16")
DEFAULT_ASPECT_RATIO = "9:16"   # t2v and r2v; i2v defaults to "auto" (follow the first frame)

# Input limits per model, read on 2026-09-28 from fal's public OpenAPI (free,
# no key), one lookup per endpoint:
#   https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint_id>
# Re-read it there before changing anything below.
#   durations    seconds; sent as strings, and "auto" is also valid in every mode
#   aspect_ratios per mode; 2.5 image-to-video is const "auto"
#   seed_modes   the modes whose input schema has a seed field
#   max_refs     reference-to-video's image_urls cap
MODELS = {
    "seedance-2.5": {
        "t2v": "bytedance/seedance-2.5/text-to-video",
        "i2v": "bytedance/seedance-2.5/image-to-video",
        "r2v": "bytedance/seedance-2.5/reference-to-video",
        "durations": list(range(4, 31)),
        "resolutions": ("480p", "720p", "1080p"),
        "aspect_ratios": {"t2v": ASPECT_RATIOS, "i2v": ("auto",), "r2v": ASPECT_RATIOS},
        "seed_modes": ("r2v",),
        "max_refs": 30,
    },
    "seedance-2.0": {
        "t2v": "bytedance/seedance-2.0/text-to-video",
        "i2v": "bytedance/seedance-2.0/image-to-video",
        "r2v": "bytedance/seedance-2.0/reference-to-video",
        "durations": list(range(4, 16)),
        "resolutions": ("480p", "720p", "1080p", "4k"),
        "aspect_ratios": {m: ASPECT_RATIOS for m in MODES},
        "seed_modes": (),
        "max_refs": 9,
    },
}
DEFAULT_MODEL = "seedance-2.5"   # best current Seedance (Task 0 item 4)
# Retired model or endpoint ID → what to use instead. fal marks these
# "deprecated" in its model API.
RETIRED_MODELS: dict[str, str] = {
    "fal-ai/bytedance/seedance/v1/lite/text-to-video": "seedance-2.5",
    "fal-ai/bytedance/seedance/v1/lite/image-to-video": "seedance-2.5",
    "fal-ai/bytedance/seedance/v1/lite/reference-to-video": "seedance-2.5",
}
# fal's cap is 30 MB per image; a q88 JPEG at these sizes is far below it.
# First/last frames get 2048 so 1080p output isn't softened; references stay
# at 1024, the size proven live.
FRAME_MAX_SIDE = 2048
REF_MAX_SIDE = 1024
JPEG_QUALITY = 88

# A 5 s 720p clip took 199 s live, a 9 s one 314 s.
POLL_INTERVAL_S, MAX_POLL_S = 5.0, 900.0
# A transient error mid-poll must not abandon the job: it is already paid for.
MAX_CONSECUTIVE_POLL_FAILURES = 5

# A request ID that can't exist: a status lookup on it is free and tells a
# valid key (404) from a rejected one (401).
_KEY_CHECK_REQUEST_ID = "00000000-0000-0000-0000-000000000000"

# Words that mark a 429 as an actual rate limit, worth waiting out. A 429
# whose message doesn't say any of these is not assumed to be a rate limit —
# retrying an unclassified 429 after a billed submit risks a second charge.
_RATE_LIMIT_WORDS = ("too many requests", "rate limit", "concurren")

_REQUEST_ID_RE = re.compile(r"/requests/([^/]+)")


def _request_id_from_url(url: str) -> str:
    """Best-effort request id parsed out of a status/response URL, for a
    failure message — falls back to the full URL when it doesn't match."""
    m = _REQUEST_ID_RE.search(url)
    return m.group(1) if m else url


def _headers() -> dict:
    try:
        key = get_credential("fal", "api_key").strip()
    except CredentialError as e:
        raise CredentialError(f"Seedance needs a fal.ai key. {e}") from e
    return {"Authorization": f"Key {key}", "Content-Type": "application/json"}


def _app_path(endpoint_id: str) -> str:
    """fal serves status/response URLs under the endpoint's first two segments
    (`bytedance/seedance-2.5`); the full endpoint path there is a 405."""
    return "/".join(endpoint_id.split("/")[:2])


def _error_message(resp) -> str:
    """fal's error text: `{"detail": str}`, or FastAPI's list of
    `{loc, msg}` for validation errors (their `input` echoes the request, so
    it is left out). Falls back to the raw body."""
    try:
        body = resp.json()
    except Exception:
        return (resp.text or "")[:500]
    detail = body.get("detail", body.get("error") or body.get("message")) if isinstance(body, dict) else None
    if isinstance(detail, str):
        return detail[:500]
    if isinstance(detail, list):
        parts = []
        for d in detail:
            if isinstance(d, dict):
                loc = ".".join(str(x) for x in d.get("loc", []) if x != "body")
                msg = d.get("msg") or ""
                parts.append(f"{loc}: {msg}" if loc else msg)
            else:
                parts.append(str(d))
        return "; ".join(p for p in parts if p)[:500]
    if isinstance(detail, dict):
        return str(detail.get("message") or detail.get("msg") or detail)[:500]
    return (resp.text or "")[:500]


def _warn(message: str) -> None:
    print(json.dumps({"warn": message}), file=sys.stderr)


def _get(url: str, headers: dict, what: str, **kwargs):
    """Idempotent GET with transient retry; a network failure is UNREACHABLE."""
    try:
        return _http.request_with_retry("GET", url, headers=headers, **kwargs)
    except ConnectorError as e:
        raise ConnectorError(f"fal.ai {what} failed: {e}", reason=UNREACHABLE) from e


def _image_data_uri(path: str, max_side: int) -> str:
    """Image file → `data:image/jpeg;base64,…`, longest side capped at max_side."""
    from PIL import Image, ImageOps
    try:
        with Image.open(path) as src:
            im = ImageOps.exif_transpose(src)
            if im.mode in ("RGBA", "LA", "P", "PA"):
                im = im.convert("RGBA")
                flat = Image.new("RGB", im.size, (255, 255, 255))
                flat.paste(im, mask=im.getchannel("A"))
                im = flat
            else:
                im = im.convert("RGB")
            if max(im.size) > max_side:
                im.thumbnail((max_side, max_side), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=JPEG_QUALITY)
    except OSError as e:
        raise ConnectorError(f"Could not read image file {path}: {e}") from e
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _retired_error(model: str) -> ConnectorError | None:
    """ConnectorError(MODEL_RETIRED) if `model` or any of its endpoints is retired."""
    names = [model, *(MODELS.get(model, {}).get(m) for m in MODES)]
    for name in names:
        if name in RETIRED_MODELS:
            return ConnectorError(
                f"Seedance model {name!r} has been retired on fal.ai. "
                f"Use {RETIRED_MODELS[name]!r} instead.",
                reason=MODEL_RETIRED,
            )
    return None


def _duration_str(duration, allowed: list[int], mode: str) -> str:
    if duration == "auto":
        return "auto"
    if isinstance(duration, str) and duration.isdigit():
        seconds = int(duration)
    elif isinstance(duration, int) and not isinstance(duration, bool):
        seconds = duration
    else:
        seconds = None
    if seconds not in allowed:
        raise ConnectorError(
            f"Seedance {mode} duration must be 'auto' or {allowed[0]}-{allowed[-1]} "
            f"seconds, got {duration!r}"
        )
    return str(seconds)


def build_request(
    prompt: str,
    image_path: str = None,
    duration=5,
    aspect_ratio: str = None,
    resolution: str = "720p",
    model: str = DEFAULT_MODEL,
    seed: int = None,
    end_image_path: str = None,
    reference_image_paths: list[str] = None,
    generate_audio: bool = False,
    negative_prompt: str = None,
) -> tuple[str, dict]:
    """Validate the inputs and build (endpoint_id, body). No HTTP.

    duration: int seconds, a digit string, or "auto"; checked against the
    model's range. aspect_ratio None means "auto" for i2v (follow the first
    frame) and DEFAULT_ASPECT_RATIO otherwise; a mode with a fixed ratio (2.5
    i2v) drops any other value with a warning. seed is sent only to modes that
    take one (2.5 r2v) and dropped with a warning elsewhere. generate_audio
    defaults to False here (fal's own default is True, which costs more): pass
    True only when the scene wants Seedance's sound. Seedance has no
    negative-prompt field, so negative_prompt is appended as "Avoid: …".
    """
    retired = _retired_error(model)
    if retired:
        raise retired
    if model not in MODELS:
        raise ConnectorError(f"Unknown Seedance model {model!r}; supported: {', '.join(MODELS)}")
    caps = MODELS[model]

    if not prompt or not prompt.strip():
        raise ConnectorError("Prompt must not be empty")
    if image_path and reference_image_paths:
        raise ConnectorError("Use either a first frame (image_path) or reference images, not both")
    if end_image_path and not image_path:
        raise ConnectorError("An end frame (end_image_path) needs a first frame (image_path)")
    max_refs = caps["max_refs"]
    if reference_image_paths is not None and not 1 <= len(reference_image_paths) <= max_refs:
        raise ConnectorError(
            f"{model} takes 1-{max_refs} reference images, got {len(reference_image_paths)}"
        )
    mode = "i2v" if image_path else "r2v" if reference_image_paths else "t2v"

    body = {"prompt": prompt}
    if negative_prompt and negative_prompt.strip():
        body["prompt"] = f"{prompt.rstrip()}\n\nAvoid: {negative_prompt.strip()}"
    body["duration"] = _duration_str(duration, caps["durations"], mode)

    if aspect_ratio is None:
        aspect_ratio = "auto" if mode == "i2v" else DEFAULT_ASPECT_RATIO
    if aspect_ratio not in ASPECT_RATIOS:
        raise ConnectorError(f"aspect_ratio must be one of {', '.join(ASPECT_RATIOS)}, got {aspect_ratio!r}")
    mode_ratios = caps["aspect_ratios"][mode]
    if aspect_ratio not in mode_ratios:
        _warn(f"{model} {mode} ignores aspect_ratio {aspect_ratio!r} and uses "
              f"{mode_ratios[0]!r}: the output follows the first frame")
        aspect_ratio = mode_ratios[0]

    if resolution not in caps["resolutions"]:
        raise ConnectorError(
            f"{model} resolution must be one of {', '.join(caps['resolutions'])}, got {resolution!r}"
        )
    body.update(aspect_ratio=aspect_ratio, resolution=resolution, generate_audio=bool(generate_audio))
    if seed is not None:
        if mode in caps["seed_modes"]:
            body["seed"] = seed
        else:
            _warn(f"{model} {mode} takes no seed; ignoring seed={seed}")

    if mode == "i2v":
        body["image_url"] = _image_data_uri(image_path, FRAME_MAX_SIDE)
        if end_image_path:
            body["end_image_url"] = _image_data_uri(end_image_path, FRAME_MAX_SIDE)
    elif mode == "r2v":
        body["image_urls"] = [_image_data_uri(p, REF_MAX_SIDE) for p in reference_image_paths]

    return caps[mode], body


def submit(model_id: str, payload: dict) -> dict:
    """POST the job to fal's queue. Returns {request_id, status_url, response_url, …}.

    Only a plain 429 is retried: the request was refused, so nothing was queued.
    A timed-out POST or a 5xx may already be a billed job, and a 429 that reads
    as a billing limit won't clear by waiting, so neither is retried.
    """
    url = f"{QUEUE}/{model_id}"
    headers = _headers()
    attempts = _http.RETRY_ATTEMPTS
    for attempt in range(attempts):
        try:
            r = _http.request_with_retry(
                "POST", url, json=payload, headers=headers, timeout=120,
                retry_statuses=frozenset(), retry_exceptions=False,
            )
        except ConnectorError as e:
            # A timed-out/ambiguous submit may already be billed and queued —
            # UNREACHABLE reads as "nothing happened" and invites a wrongful
            # re-run, so this is reason=None, not UNREACHABLE (PV29 review).
            raise ConnectorError(
                f"fal.ai submit failed: {e}. If it timed out, the job may still "
                f"have been queued and may still finish on fal.ai; don't "
                f"regenerate before checking the fal.ai dashboard.",
            ) from e
        if r.status_code < 400:
            return r.json()
        message = _error_message(r)
        reason = classify_http_error(r.status_code, message)
        is_rate_limit = reason is None and any(w in message.lower() for w in _RATE_LIMIT_WORDS)
        if r.status_code == 429 and is_rate_limit and attempt < attempts - 1:
            time.sleep(_http.RETRY_BACKOFF_S * (2 ** attempt))
            continue
        raise ConnectorError(f"fal.ai rejected the request (HTTP {r.status_code}): {message}",
                             reason=reason)


def wait(status_url: str) -> dict:
    """Poll status_url until COMPLETED. Returns the final status body.

    Up to MAX_CONSECUTIVE_POLL_FAILURES transient failures in a row (network,
    429, 5xx, each already retried by _http) are tolerated. Any other 4xx raises
    at once: it won't clear by polling again.
    """
    headers = _headers()
    elapsed, failures = 0.0, 0
    while elapsed < MAX_POLL_S:
        data, last = None, None
        try:
            r = _http.request_with_retry("GET", status_url, headers=headers, timeout=30)
        except ConnectorError as e:
            last = e
        else:
            if r.status_code >= 400 and r.status_code not in _http.TRANSIENT_STATUS:
                message = _error_message(r)
                raise ConnectorError(f"fal.ai status check failed (HTTP {r.status_code}): {message}",
                                     reason=classify_http_error(r.status_code, message))
            if r.status_code >= 400:
                last = f"HTTP {r.status_code}: {_error_message(r)}"
            else:
                try:
                    data = r.json()
                except ValueError as e:
                    last = f"unreadable status body: {e}"
        if data is None:
            failures += 1
            if failures >= MAX_CONSECUTIVE_POLL_FAILURES:
                # The job is already submitted and billed by this point —
                # UNREACHABLE reads as "nothing happened" and invites a
                # wrongful re-run, so this is reason=None (PV29 review).
                request_id = _request_id_from_url(status_url)
                raise ConnectorError(
                    f"fal.ai job {request_id}: {failures} status checks failed in a row, "
                    f"giving up. It may still finish on fal.ai; don't regenerate. "
                    f"Last error: {last}",
                )
        else:
            failures = 0
            status, error = data.get("status"), data.get("error")
            if status in ("FAILED", "ERROR") or (status == "COMPLETED" and error):
                raise ConnectorError(f"Seedance job failed on fal.ai: {error or data.get('detail') or status}")
            if status == "COMPLETED":
                return data
        time.sleep(POLL_INTERVAL_S)
        elapsed += POLL_INTERVAL_S
    raise ConnectorError(f"fal.ai job {status_url} did not complete within {MAX_POLL_S:.0f}s")


def fetch_result(response_url: str) -> dict:
    """GET the finished job's output: {"video": {"url", …}, "seed", …}."""
    try:
        r = _get(response_url, _headers(), "result fetch", timeout=60)
    except ConnectorError as e:
        # The job is already submitted and billed by this point — UNREACHABLE
        # (what _get raises) reads as "nothing happened" and invites a
        # wrongful re-run, so this is re-raised as reason=None (PV29 review).
        request_id = _request_id_from_url(response_url)
        raise ConnectorError(
            f"fal.ai result fetch failed for job {request_id}: {e}. It may "
            f"still finish on fal.ai; don't regenerate.",
        ) from e
    if r.status_code >= 400:
        message = _error_message(r)
        raise ConnectorError(f"Seedance job failed on fal.ai (HTTP {r.status_code}): {message}",
                             reason=classify_http_error(r.status_code, message))
    return r.json()


def generate_video(
    prompt: str,
    out_path: str,
    image_path: str = None,
    duration=5,
    aspect_ratio: str = None,
    resolution: str = "720p",
    model: str = DEFAULT_MODEL,
    seed: int = None,
    end_image_path: str = None,
    reference_image_paths: list[str] = None,
    generate_audio: bool = False,
    negative_prompt: str = None,
) -> str:
    """Top-level entry: validate → submit → wait → download. Returns out_path.

    Mode: i2v when image_path is set, r2v when reference_image_paths is set,
    else t2v. Every input is validated before any HTTP (see build_request).
    """
    if not out_path:
        raise ConnectorError("out_path is required")
    endpoint, body = build_request(
        prompt, image_path=image_path, duration=duration, aspect_ratio=aspect_ratio,
        resolution=resolution, model=model, seed=seed, end_image_path=end_image_path,
        reference_image_paths=reference_image_paths, generate_audio=generate_audio,
        negative_prompt=negative_prompt,
    )
    queued = submit(endpoint, body)
    request_id = queued.get("request_id")
    base = f"{QUEUE}/{_app_path(endpoint)}/requests/{request_id}"
    wait(queued.get("status_url") or f"{base}/status")
    result = fetch_result(queued.get("response_url") or base)
    video_url = (result.get("video") or {}).get("url")
    if not video_url:
        raise ConnectorError(f"fal.ai returned no video URL for job {request_id}")
    return _http.download_file(video_url, out_path, timeout=300)


def check_key() -> dict:
    """Validate the stored/overlaid fal key with free calls only.

    1. A status lookup on a request ID that can't exist: 404 means the key is
       good, 401 means it's rejected. No job, no charge.
    2. fal's model API for the default t2v endpoint: default_model_ok is True
       when its status is "active" (fal marks retirements "deprecated").
       Skipped when DEFAULT_MODEL is already in RETIRED_MODELS.

    Raises ConnectorError with a classify_http_error reason on a 4xx/5xx, or
    UNREACHABLE when fal can't be reached.
    """
    headers = _headers()
    endpoint = MODELS[DEFAULT_MODEL]["t2v"]
    url = f"{QUEUE}/{_app_path(endpoint)}/requests/{_KEY_CHECK_REQUEST_ID}/status"
    r = _get(url, headers, "key check", timeout=15)
    if r.status_code >= 400 and r.status_code != 404:
        message = _error_message(r)
        raise ConnectorError(f"fal.ai key check failed (HTTP {r.status_code}): {message}",
                             reason=classify_http_error(r.status_code, message))

    if _retired_error(DEFAULT_MODEL):
        return {"ok": True, "default_model": DEFAULT_MODEL, "default_model_ok": False,
                "detail": f"{DEFAULT_MODEL} is retired"}

    r = _get(MODELS_API, headers, "model lookup", params={"endpoint_id": endpoint}, timeout=15)
    if r.status_code >= 400:
        message = _error_message(r)
        raise ConnectorError(f"fal.ai model lookup failed (HTTP {r.status_code}): {message}",
                             reason=classify_http_error(r.status_code, message))
    status = next((((m.get("metadata") or {}).get("status"))
                   for m in r.json().get("models") or [] if m.get("endpoint_id") == endpoint), None)
    return {
        "ok": True,
        "default_model": DEFAULT_MODEL,
        "default_model_ok": status == "active",
        "detail": f"{endpoint}: {status or 'not listed'}",
    }
