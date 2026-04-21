"""Kling AI connector (HTTP + JWT auth).

One vendor, one credential pair, one SDK surface (direct HTTP via requests).
Currently wraps the omni-video endpoint; add more functions here as other
Kling endpoints get wrapped. See docs/CONNECTORS.md for the layering rule.

Current functions:
    generate(prompt, out_path, ...) -> str  # path to downloaded .mp4

Library code — raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import base64, os, time
from connectors import ConnectorError
from lib.credentials import get_credential

BASE_URL = "https://api-singapore.klingai.com"
MODEL_NAME = "kling-v3-omni"
POLL_INTERVAL_S = 10.0
MAX_POLL_S = 600.0
MAX_PROMPT_CHARS = 2500
MAX_MULTI_PROMPT_CHARS = 512   # per-storyboard cap in multi_shot mode (docs).
MAX_MULTI_SHOTS = 6            # docs: "Supports up to 6 storyboards, minimum 1."
VALID_SHOT_TYPES = ("customize", "intelligence")
# Kling omni-video reference-image cap. Per docs:
#   "When there is no reference video and only multi-image elements, the sum
#    of the number of reference images and multi-image elements must not
#    exceed 7."
# We don't use element_list or video_list, so the effective cap is 7 refs.
# Higher editorial caps (e.g. "3 refs per scene") belong in the calling skill,
# not here — the connector only enforces the API's hard limit.
MAX_REF_IMAGES = 7


def _require_jwt():
    try:
        import jwt
        return jwt
    except ImportError:
        raise ConnectorError("Missing connector dependencies. Run: montaj install connectors")


def _require_requests():
    try:
        import requests
        return requests
    except ImportError:
        raise ConnectorError("Missing connector dependencies. Run: montaj install connectors")


def _make_token() -> str:
    jwt = _require_jwt()
    access_key = get_credential("kling", "access_key")
    secret_key = get_credential("kling", "secret_key")
    now = time.time()
    payload = {"iss": access_key, "exp": int(now) + 1800, "nbf": int(now) - 5}
    headers = {"alg": "HS256", "typ": "JWT"}
    return jwt.encode(payload, secret_key, algorithm="HS256", headers=headers)


def _auth_headers() -> dict:
    return {
        "Authorization": f"Bearer {_make_token()}",
        "Content-Type": "application/json",
    }


def _file_to_base64(path: str) -> str:
    """Read file and return raw base64 (no data-URI prefix)."""
    try:
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")
    except OSError as e:
        raise ConnectorError(f"Could not read image file {path}: {e}") from e


def _validate_multi_prompt(multi_prompt: list[dict]) -> None:
    """Validate multi_prompt entries against Kling's rules."""
    if not isinstance(multi_prompt, list):
        raise ConnectorError("multi_prompt must be a list")
    if not (1 <= len(multi_prompt) <= MAX_MULTI_SHOTS):
        raise ConnectorError(
            f"multi_prompt must have 1-{MAX_MULTI_SHOTS} entries, got {len(multi_prompt)}"
        )
    for i, entry in enumerate(multi_prompt):
        if not isinstance(entry, dict):
            raise ConnectorError(f"multi_prompt[{i}] must be an object")
        for k in ("index", "prompt", "duration"):
            if k not in entry:
                raise ConnectorError(f"multi_prompt[{i}] missing required field '{k}'")
        p = entry["prompt"]
        if not isinstance(p, str) or not p.strip():
            raise ConnectorError(f"multi_prompt[{i}].prompt must be a non-empty string")
        if len(p) > MAX_MULTI_PROMPT_CHARS:
            raise ConnectorError(
                f"multi_prompt[{i}].prompt exceeds {MAX_MULTI_PROMPT_CHARS} chars "
                f"(got {len(p)}). Per-storyboard limit is stricter than single-shot."
            )


def build_payload(
    prompt: str = None,
    first_frame_path: str = None,
    last_frame_path: str = None,
    reference_image_paths: list[str] = None,
    duration_seconds: int = 5,
    negative_prompt: str = None,
    sound: str = "on",
    aspect_ratio: str = "16:9",
    mode: str = "std",
    external_task_id: str = None,
    multi_shot: bool = False,
    shot_type: str = None,
    multi_prompt: list[dict] = None,
) -> dict:
    """Build the omni-video request payload.

    Returns {runtime_prompt, body, truncated, original_prompt_length, max_prompt_chars}.

    external_task_id: optional caller-supplied correlation ID. Kling echoes it back
    on queries (must be unique per user account). Useful for binding an API task
    to a local object (e.g. an ai_video scene ID).

    multi_shot / shot_type / multi_prompt: opt-in to Kling's multi-shot mode —
    up to 6 storyboard entries generated in a single API call.
      - shot_type="customize" + multi_prompt=[...] → caller defines each shot.
      - shot_type="intelligence" + single prompt    → Kling splits into shots.
    When multi_shot=True, first_frame_path and last_frame_path are NOT supported
    (per Kling docs). Total `duration` is computed from the sum of shot durations.
    """
    # ---- Multi-shot preconditions ----
    if multi_shot:
        if shot_type not in VALID_SHOT_TYPES:
            raise ConnectorError(
                f"multi_shot=True requires shot_type in {VALID_SHOT_TYPES}; got {shot_type!r}"
            )
        if first_frame_path or last_frame_path:
            raise ConnectorError(
                "multi_shot=True does not support first_frame / last_frame images"
            )
        if shot_type == "customize":
            if not multi_prompt:
                raise ConnectorError(
                    "shot_type='customize' requires multi_prompt with 1-6 entries"
                )
            _validate_multi_prompt(multi_prompt)
            # Override duration with the sum of shot durations.
            try:
                total = sum(int(e["duration"]) for e in multi_prompt)
            except (ValueError, TypeError) as e:
                raise ConnectorError(
                    f"multi_prompt entries must have integer durations: {e}"
                ) from e
            duration_seconds = total
        else:  # intelligence
            if not prompt or not prompt.strip():
                raise ConnectorError(
                    "shot_type='intelligence' requires a non-empty prompt"
                )
    else:
        if not prompt or not prompt.strip():
            raise ConnectorError("Prompt must not be empty")
        # multi_prompt / shot_type silently ignored in single-shot mode — no-op.

    if reference_image_paths and len(reference_image_paths) > MAX_REF_IMAGES:
        raise ConnectorError(
            f"Too many reference images ({len(reference_image_paths)}); max is {MAX_REF_IMAGES}"
        )

    original_length = len(prompt) if prompt else 0
    truncated = original_length > MAX_PROMPT_CHARS
    runtime_prompt = prompt[:MAX_PROMPT_CHARS] if (prompt and truncated) else prompt

    # Clamp duration (single-shot; multi-shot computes above from multi_prompt sum).
    if not multi_shot:
        duration_seconds = max(3, min(15, duration_seconds))

    image_list = []

    # First/last frames
    if first_frame_path:
        image_list.append({
            "image_url": _file_to_base64(first_frame_path),
            "type": "first_frame",
        })
    if last_frame_path:
        image_list.append({
            "image_url": _file_to_base64(last_frame_path),
            "type": "end_frame",
        })

    # Reference images — caller owns token placement.
    #
    # Kling's omni-syntax uses <<<image_N>>> tokens in the prompt to bind
    # references to specific nouns ("The man <<<image_1>>> walks past the
    # <<<image_2>>> tree"). N is 1-indexed and matches the order of entries
    # appended to image_list below.
    #
    # The connector is pure pass-through: it attaches the images but never
    # mutates the prompt. Callers (agents/skills) are responsible for placing
    # <<<image_N>>> tokens inline at the noun each ref maps to.
    if reference_image_paths:
        for ref_path in reference_image_paths:
            image_list.append({"image_url": _file_to_base64(ref_path)})

    body = {
        "model_name": MODEL_NAME,
        "duration": str(duration_seconds),
        "aspect_ratio": aspect_ratio,
        "mode": mode,
        "sound": sound,
    }

    # Prompt field: included in single-shot mode and in multi_shot+intelligence mode.
    # Omitted entirely in multi_shot+customize (per docs: "When multi_shot is true,
    # the prompt parameter is invalid").
    if not (multi_shot and shot_type == "customize"):
        body["prompt"] = runtime_prompt

    if multi_shot:
        body["multi_shot"] = True
        body["shot_type"] = shot_type
        if shot_type == "customize":
            body["multi_prompt"] = multi_prompt

    if negative_prompt:
        body["negative_prompt"] = negative_prompt
    if image_list:
        body["image_list"] = image_list
    if external_task_id:
        body["external_task_id"] = external_task_id

    return {
        "runtime_prompt": runtime_prompt,
        "body": body,
        "truncated": truncated,
        "original_prompt_length": original_length,
        "max_prompt_chars": MAX_PROMPT_CHARS,
    }


def create_task(body: dict) -> dict:
    """POST /v1/videos/omni-video. Returns response data."""
    requests = _require_requests()
    url = f"{BASE_URL}/v1/videos/omni-video"
    try:
        r = requests.post(url, json=body, headers=_auth_headers(), timeout=30)
        r.raise_for_status()
    except requests.RequestException as e:
        raise ConnectorError(f"Kling API request failed: {e}") from e
    data = r.json()
    if data.get("code") != 0:
        raise ConnectorError(f"Kling API error: {data.get('message', 'unknown error')}")
    return data["data"]


def query_task(task_id: str) -> dict:
    """GET task status by ID."""
    requests = _require_requests()
    url = f"{BASE_URL}/v1/videos/omni-video/{task_id}"
    try:
        r = requests.get(url, headers=_auth_headers(), timeout=30)
        r.raise_for_status()
    except requests.RequestException as e:
        raise ConnectorError(f"Kling API request failed: {e}") from e
    data = r.json()
    if data.get("code") != 0:
        raise ConnectorError(f"Kling API error: {data.get('message', 'unknown error')}")
    return data["data"]


def poll_until_done(task_id: str) -> dict:
    """Poll task until succeed/failed. Returns task data on success."""
    elapsed = 0.0
    while elapsed < MAX_POLL_S:
        task_data = query_task(task_id)
        status = task_data.get("task_status")
        if status == "succeed":
            return task_data
        if status == "failed":
            msg = task_data.get("task_status_msg", "unknown error")
            raise ConnectorError(f"Kling task {task_id} failed: {msg}")
        time.sleep(POLL_INTERVAL_S)
        elapsed += POLL_INTERVAL_S
    raise ConnectorError(f"Kling task {task_id} did not complete within {MAX_POLL_S}s")


def download_video(url: str, out_path: str) -> str:
    """Download video from URL to out_path."""
    requests = _require_requests()
    try:
        r = requests.get(url, stream=True, timeout=120)
        r.raise_for_status()
    except requests.RequestException as e:
        raise ConnectorError(f"Failed to download video: {e}") from e
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
    return out_path


def generate(
    prompt: str = None,
    out_path: str = None,
    first_frame_path: str = None,
    last_frame_path: str = None,
    reference_image_paths: list[str] = None,
    duration_seconds: int = 5,
    negative_prompt: str = None,
    sound: str = "on",
    aspect_ratio: str = "16:9",
    mode: str = "std",
    external_task_id: str = None,
    multi_shot: bool = False,
    shot_type: str = None,
    multi_prompt: list[dict] = None,
) -> str:
    """Top-level entry: build -> create -> poll -> download. Returns out_path."""
    if not out_path:
        raise ConnectorError("out_path is required")
    payload = build_payload(
        prompt=prompt,
        first_frame_path=first_frame_path,
        last_frame_path=last_frame_path,
        reference_image_paths=reference_image_paths,
        duration_seconds=duration_seconds,
        negative_prompt=negative_prompt,
        sound=sound,
        aspect_ratio=aspect_ratio,
        mode=mode,
        external_task_id=external_task_id,
        multi_shot=multi_shot,
        shot_type=shot_type,
        multi_prompt=multi_prompt,
    )
    task_data = create_task(payload["body"])
    task_id = task_data["task_id"]
    result = poll_until_done(task_id)
    video_url = result["task_result"]["videos"][0]["url"]
    return download_video(video_url, out_path)
