"""Kling AI connector (HTTP + JWT auth).

One vendor, one credential pair, one SDK surface (direct HTTP via requests).
Currently wraps the omni-video endpoint; add more functions here as other
Kling endpoints get wrapped. See docs/CONNECTORS.md for the layering rule.

Current functions:
    generate(prompt, out_path, ...) -> str       # path to downloaded .mp4
    generate_speech(text, voice, out_path, ...) -> str  # path to downloaded audio

Library code — raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import base64, os, time
from connectors import ConnectorError
from lib.credentials import get_credential

BASE_URL = "https://api-singapore.klingai.com"
DEFAULT_MODEL = "kling-v3-omni"
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

# Model capabilities — the connector validates constraints per model.
MODELS = {
    "kling-v3-omni": {
        "durations": list(range(3, 16)),       # 3–15, any integer
        "multi_shot": True,
        "end_frame_modes": ("std", "pro"),     # start+end frame in both modes
        "sound": True,                         # generates audio with sound="on"
    },
    "kling-video-o1": {
        "durations": [5, 10],                  # only 5 or 10
        "multi_shot": False,
        "end_frame_modes": ("pro",),           # end frame only in pro mode
        "sound": False,                        # does NOT generate audio
    },
}

# TTS — TODO(live-test): paths, model ID, and voice IDs are placeholders
# pending verification against Kling partner docs.
TTS_CREATE_PATH = "/v1/tts/create"
TTS_QUERY_PATH  = "/v1/tts/{task_id}"
DEFAULT_TTS_MODEL = "kling-tts-v1"

TTS_VOICES = {
    # Populate with real voice IDs after vendor docs verification.
    # "female_warm":   "<kling_voice_id>",
    # "male_calm":     "<kling_voice_id>",
}

VIDEO_QUERY_PATH = "/v1/videos/omni-video/{task_id}"


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
    model: str = DEFAULT_MODEL,
    seed: int = None,
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
    # ---- Model validation ----
    if model not in MODELS:
        raise ConnectorError(
            f"Unknown model {model!r}; supported: {', '.join(MODELS)}"
        )
    model_caps = MODELS[model]

    # ---- Multi-shot preconditions ----
    if multi_shot:
        if not model_caps["multi_shot"]:
            raise ConnectorError(
                f"Model {model!r} does not support multi-shot mode. "
                f"Use {DEFAULT_MODEL!r} or switch to independent dispatch."
            )
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

    # Validate end-frame support for this model + mode combination.
    if last_frame_path and mode not in model_caps["end_frame_modes"]:
        raise ConnectorError(
            f"Model {model!r} only supports end frame (--last-frame) in "
            f"{'/'.join(model_caps['end_frame_modes'])} mode, but mode={mode!r}. "
            f"Either switch to --mode pro or remove --last-frame."
        )

    # Validate/clamp duration against model capabilities.
    if not multi_shot:
        allowed = model_caps["durations"]
        if duration_seconds not in allowed:
            # Snap to nearest allowed duration.
            duration_seconds = min(allowed, key=lambda d: abs(d - duration_seconds))

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

    # Reference images — pure pass-through.
    #
    # Kling's omni-syntax uses <<<image_N>>> tokens in the prompt to bind
    # references to specific nouns ("The girl <<<image_1>>> sits on the
    # <<<image_2>>> slide"). N is 1-indexed and matches the order of entries
    # appended to image_list below (after any first/last frame entries).
    #
    # The connector does NOT mutate the prompt. Callers (agents/skills) are
    # responsible for placing <<<image_N>>> tokens inline at the nouns each
    # ref maps to, and for prepending any ref clause they want.
    if reference_image_paths:
        for ref_path in reference_image_paths:
            image_list.append({"image_url": _file_to_base64(ref_path)})

    runtime_prompt = prompt
    original_length = len(runtime_prompt) if runtime_prompt else 0
    truncated = original_length > MAX_PROMPT_CHARS
    if runtime_prompt and truncated:
        runtime_prompt = runtime_prompt[:MAX_PROMPT_CHARS]

    body = {
        "model_name": model,
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
    if seed is not None:
        body["seed"] = seed

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
    except requests.RequestException as e:
        raise ConnectorError(f"Kling API request failed: {e}") from e
    # Capture response body before raising on HTTP errors — Kling returns
    # useful error details in JSON even on 4xx/5xx responses.
    if r.status_code >= 400:
        try:
            err_data = r.json()
            msg = err_data.get("message") or err_data.get("msg") or r.text[:500]
        except Exception:
            msg = r.text[:500]
        raise ConnectorError(f"Kling API error (HTTP {r.status_code}): {msg}")
    data = r.json()
    if data.get("code") != 0:
        raise ConnectorError(f"Kling API error: {data.get('message', 'unknown error')}")
    return data["data"]


def query_task(task_id: str, path_template: str = VIDEO_QUERY_PATH) -> dict:
    """GET task status by ID."""
    requests = _require_requests()
    url = f"{BASE_URL}{path_template.format(task_id=task_id)}"
    try:
        r = requests.get(url, headers=_auth_headers(), timeout=30)
        r.raise_for_status()
    except requests.RequestException as e:
        raise ConnectorError(f"Kling API request failed: {e}") from e
    data = r.json()
    if data.get("code") != 0:
        raise ConnectorError(f"Kling API error: {data.get('message', 'unknown error')}")
    return data["data"]


def poll_until_done(task_id: str, path_template: str = VIDEO_QUERY_PATH) -> dict:
    """Poll task until succeed/failed. Returns task data on success."""
    elapsed = 0.0
    while elapsed < MAX_POLL_S:
        task_data = query_task(task_id, path_template)
        status = task_data.get("task_status")
        if status == "succeed":
            return task_data
        if status == "failed":
            msg = task_data.get("task_status_msg", "unknown error")
            raise ConnectorError(f"Kling task {task_id} failed: {msg}")
        time.sleep(POLL_INTERVAL_S)
        elapsed += POLL_INTERVAL_S
    raise ConnectorError(f"Kling task {task_id} did not complete within {MAX_POLL_S}s")


def _download_file(url: str, out_path: str) -> str:
    """Download file from URL to out_path."""
    requests = _require_requests()
    try:
        r = requests.get(url, stream=True, timeout=120)
        r.raise_for_status()
    except requests.RequestException as e:
        raise ConnectorError(f"Download failed: {e}") from e
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
    model: str = DEFAULT_MODEL,
    seed: int = None,
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
        model=model,
        seed=seed,
    )
    task_data = create_task(payload["body"])
    task_id = task_data["task_id"]
    result = poll_until_done(task_id)
    video_url = result["task_result"]["videos"][0]["url"]
    return _download_file(video_url, out_path)


def generate_speech(
    text: str,
    voice: str,
    out_path: str,
    model: str = DEFAULT_TTS_MODEL,
    speed: float = 1.0,
    language: str = None,
) -> str:
    """Generate speech audio from text via Kling TTS.

    text     — script to speak.
    voice    — voice identifier. Either a raw Kling voice ID or a key in TTS_VOICES.
    out_path — local file path for the downloaded audio.
    model    — Kling TTS model name.
    speed    — playback speed multiplier.
    language — optional language hint (e.g. 'en', 'zh').

    Returns out_path on success. Raises ConnectorError on failure.
    """
    if not text or not text.strip():
        raise ConnectorError("text must not be empty")
    if not out_path:
        raise ConnectorError("out_path is required")

    resolved_voice = TTS_VOICES.get(voice, voice)

    body = {
        "text": text,
        "voice_id": resolved_voice,
        "model": model,
        "speed": speed,
    }
    if language:
        body["language"] = language

    requests = _require_requests()
    url = f"{BASE_URL}{TTS_CREATE_PATH}"
    try:
        r = requests.post(url, json=body, headers=_auth_headers(), timeout=30)
    except requests.RequestException as e:
        raise ConnectorError(f"Kling TTS request failed: {e}") from e

    if r.status_code >= 400:
        try:
            err_data = r.json()
            msg = err_data.get("message") or err_data.get("msg") or r.text[:500]
        except Exception:
            msg = r.text[:500]
        raise ConnectorError(f"Kling TTS error (HTTP {r.status_code}): {msg}")

    data = r.json()
    if data.get("code") != 0:
        raise ConnectorError(f"Kling TTS error: {data.get('message', 'unknown error')}")

    result = data["data"]

    # Kling TTS endpoint shape is unverified — keep both sync (audio_url in
    # initial response) and async (task_id → poll) paths until a live test
    # confirms which applies, then delete the dead branch.
    audio_url = result.get("audio_url")
    if not audio_url:
        task_id = result.get("task_id")
        if not task_id:
            raise ConnectorError(f"Kling TTS returned neither audio_url nor task_id: {result}")
        task_data = poll_until_done(task_id, TTS_QUERY_PATH)
        audio_url = task_data.get("task_result", {}).get("audio_url")
        if not audio_url:
            raise ConnectorError(f"Kling TTS succeeded but returned no audio_url: {task_data}")

    return _download_file(audio_url, out_path)
