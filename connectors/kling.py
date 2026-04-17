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
MAX_REF_IMAGES = 3


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


def build_payload(
    prompt: str,
    first_frame_path: str = None,
    last_frame_path: str = None,
    reference_image_paths: list[str] = None,
    duration_seconds: int = 5,
    negative_prompt: str = None,
    sound: str = "on",
    aspect_ratio: str = "16:9",
    mode: str = "std",
) -> dict:
    """Build the omni-video request payload.

    Returns {runtime_prompt, body, truncated, original_prompt_length, max_prompt_chars}.
    """
    if not prompt or not prompt.strip():
        raise ConnectorError("Prompt must not be empty")

    if reference_image_paths and len(reference_image_paths) > MAX_REF_IMAGES:
        raise ConnectorError(
            f"Too many reference images ({len(reference_image_paths)}); max is {MAX_REF_IMAGES}"
        )

    original_length = len(prompt)
    truncated = original_length > MAX_PROMPT_CHARS
    runtime_prompt = prompt[:MAX_PROMPT_CHARS] if truncated else prompt

    # Clamp duration
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

    # Reference images — add <<<image_N>>> prefix to prompt
    if reference_image_paths:
        prefix_parts = []
        for i, ref_path in enumerate(reference_image_paths):
            prefix_parts.append(f"<<<image_{i + 1}>>>")
            image_list.append({"image_url": _file_to_base64(ref_path)})
        runtime_prompt = " ".join(prefix_parts) + " " + runtime_prompt

    body = {
        "model_name": MODEL_NAME,
        "prompt": runtime_prompt,
        "duration": str(duration_seconds),
        "aspect_ratio": aspect_ratio,
        "mode": mode,
        "sound": sound,
    }

    if negative_prompt:
        body["negative_prompt"] = negative_prompt
    if image_list:
        body["image_list"] = image_list

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
    prompt: str,
    out_path: str,
    first_frame_path: str = None,
    last_frame_path: str = None,
    reference_image_paths: list[str] = None,
    duration_seconds: int = 5,
    negative_prompt: str = None,
    sound: str = "on",
    aspect_ratio: str = "16:9",
    mode: str = "std",
) -> str:
    """Top-level entry: build -> create -> poll -> download. Returns out_path."""
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
    )
    task_data = create_task(payload["body"])
    task_id = task_data["task_id"]
    result = poll_until_done(task_id)
    video_url = result["task_result"]["videos"][0]["url"]
    return download_video(video_url, out_path)
