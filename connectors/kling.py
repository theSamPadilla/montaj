"""Kling AI connector (HTTP + JWT auth).

One vendor, one credential pair, one SDK surface (direct HTTP via requests).
Currently wraps the omni-video endpoint; add more functions here as other
Kling endpoints get wrapped. See docs/CONNECTORS.md for the layering rule.

Current functions:
    generate(prompt, out_path, ...) -> str       # path to downloaded .mp4
    generate_speech(text, voice, out_path, ...) -> str  # path to downloaded audio
    check_key() -> dict
        One free call (GET /account/costs) to validate the key pair, with no
        billed call.

Library code — raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import base64, os, re, time
from connectors import (
    ConnectorError, _http, classify_http_error,
    INVALID_API_KEY, INSUFFICIENT_CREDIT, MODEL_RETIRED, UNREACHABLE,
)
from lib.credentials import get_credential, CredentialError, MissingCredentialError, missing_key_message

# api.klingai.com answers identically (verified 2026-09-28); keep Singapore.
BASE_URL = "https://api-singapore.klingai.com"
# kling-v3-omni is the default and stays so; kling-4.0 is chosen with --model.
DEFAULT_MODEL = "kling-v3-omni"
DEFAULT_MODE = "pro"   # the higher-quality of std/pro; costs more per clip
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
# The calling skill and connector both enforce the same API hard limit of 7.
MAX_REF_IMAGES = 7

# Model capabilities — the connector validates constraints per model.
# The 1201 "model is not supported" answers of 2026-09-28 (PV29) came from
# calling kling-4.0 on the legacy /v1/videos/omni-video endpoint. kling-4.0 has
# its own endpoint (A, below) and is served there. kling-3.0-turbo also has its
# own endpoint and is out of scope. With an empty balance a served model
# answers 1102 and an unserved one 1201, both for free.
#
# Kling 4.0, from Kling's docs (read 2026-10-29), cited A, B or C per fact:
#   A  https://kling.ai/document-api/api/video/4-0 (endpoint, body, query)
#   B  https://kling.ai/document-api/api/get-started/authentication (API key)
#   C  https://kling.ai/dev/model-release/kling-4 (release note)
# Kling 4.0 Flash also exists (C) but A documents no endpoint for it: not added.
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
    "kling-4.0": {
        "api": "v4",                           # own endpoint and body shape (A)
        "path": "/omni-video/kling-4.0",       # A: POST create
        "durations": list(range(3, 31)),       # A: settings.duration, int enum 3..30
        "multi_shot": False,                   # A: no multi_shot field
        "resolutions": ("720p", "1080p"),      # A: settings.resolution
        "aspect_ratios": ("21:9", "16:9", "9:16", "1:1", "adaptive"),  # A
        "max_images": 10,                      # A: "Maximum number of images: 10."
        # No end_frame_modes and no sound switch: audio is native stereo (C),
        # described in the prompt (A has no sound field).
    },
}

# Kling 4.0 (A). Prompt limit: English-only 26,000 chars, non-English-only
# 11,000, mixed input E / 26000 + N / 11000 <= 1.
V4_MAX_ENGLISH_CHARS = 26000
V4_MAX_OTHER_CHARS = 11000
V4_DEFAULT_RESOLUTION = "1080p"            # A: default 1080p
V4_QUERY_PATH = "/tasks"                   # A: GET /tasks?task_ids=<id>
# Aspect ratios only the legacy endpoint takes (lib/types/kling.py): 16:9, 9:16, 1:1.
V4_ONLY_ASPECTS = ("21:9", "adaptive")

# Retired model -> its replacement. build_payload refuses these before any
# HTTP call. Kling has no model-list endpoint and announces nothing, so a
# retirement first shows up as 1201 "model is not supported" for a model in
# MODELS (raised as MODEL_RETIRED); move the name from MODELS to here then.
RETIRED_MODELS: dict[str, str] = {}

OUT_OF_CREDIT_MESSAGE = "Your Kling account is out of credits. Top up a resource pack at kling.ai/dev."

# Kling's 429 body codes. Only the rate limits are retried; every other 429
# (1100 account exception, 1304 IP allow-list, anything unknown) is raised.
_BALANCE_CODES = frozenset({1101, 1102})       # arrears (postpaid); pack empty or expired
_RATE_LIMIT_CODES = frozenset({1302, 1303})    # too fast; over the pack's concurrency/QPS

# TTS — https://app.klingai.com/global/dev/document-api
# Synchronous: create response includes task_result directly. No poll endpoint.
TTS_CREATE_PATH = "/v1/audio/tts"

# Kling TTS voice IDs — aliases map friendly names to raw API voice_id strings.
# Callers can use either the alias ("the_reader") or raw ID ("reader_en_m-v1").
# Source: https://app.klingai.com/global/dev/document-api (Voice Guide)
#
# Most voice_ids work in both English (voice_language="en") and Chinese ("zh").
# The alias uses the official English voice name from Kling's docs.
TTS_VOICES = {
    # ── English voices (voice_language="en") ────────────────────────
    "sunny":            "genshin_vindi2",
    "sage":             "zhinen_xuesheng",
    "ace":              "AOT",
    "blossom":          "ai_shatang",
    "peppy":            "genshin_klee2",
    "dove":             "genshin_kirara",
    "shine":            "ai_kaiya",
    "anchor":           "oversea_male1",
    "lyric":            "ai_chenjiahao_712",
    "melody":           "girlfriend_4_speech02",
    "tender":           "chat1_female_new-3",
    "siren":            "chat_0407_5-1",
    "zippy":            "cartoon-boy-07",
    "bud":              "uk_boy1",
    "sprite":           "cartoon-girl-01",
    "candy":            "PeppaPig_platform",
    "beacon":           "ai_huangzhong_712",
    "rock":             "ai_huangyaoshi_712",
    "titan":            "ai_laoguowang_712",
    "grace":            "chengshu_jiejie",
    "helen":            "you_pingjing",
    "lore":             "calm_story1",
    "crag":             "uk_man2",
    "prattle":          "laopopo_speech02",
    "hearth":           "heainainai_speech02",
    "the_reader":       "reader_en_m-v1",
    "commercial_lady":  "commercial_lady_en_f-v1",
    # ── Chinese-only voices (voice_language="zh") ───────────────────
    "tiexin_nanyou":    "tiexin_nanyou",
    "tiyuxi_xuedi":     "tiyuxi_xuedi",
    "girlfriend_1":     "girlfriend_1_speech02",
    "girlfriend_2":     "girlfriend_2_speech02",
    "zhuxi":            "zhuxi_speech02",
    "uk_oldman":        "uk_oldman3",
    "dongbeilaotie":    "dongbeilaotie_speech02",
    "chongqingxiaohuo": "chongqingxiaohuo_speech02",
    "chuanmeizi":       "chuanmeizi_speech02",
    "chaoshandashu":    "chaoshandashu_speech02",
    "taiwan_man":       "ai_taiwan_man2_speech02",
    "xianzhanggui":     "xianzhanggui_speech02",
    "tianjinjiejie":    "tianjinjiejie_speech02",
    "news_anchor_cn":   "diyinnansang_DB_CN_M_04-v2",
    "dubbed_film_cn":   "yizhipiannan-v1",
    "raspy_cn":         "daopianyansang-v1",
    "mengwa":           "mengwa-v1",
}

VIDEO_QUERY_PATH = "/v1/videos/omni-video/{task_id}"


def _require_jwt():
    try:
        import jwt
        return jwt
    except ImportError:
        raise ConnectorError("Missing connector dependencies. Run: montaj install connectors")


def _legacy_pair() -> tuple[str, str]:
    """The legacy access/secret pair, or the error a user can act on.

    With neither half stored the user simply has no Kling key. With one half,
    the message names the missing half in plain words, and points at the API
    key: the Connectors page offers only that (§549).
    """
    def stored(key: str) -> str | None:
        try:
            return get_credential("kling", key)
        except MissingCredentialError:
            return None

    access_key, secret_key = stored("access_key"), stored("secret_key")
    if access_key and secret_key:
        return access_key, secret_key
    if not access_key and not secret_key:
        raise MissingCredentialError(missing_key_message("kling"), "kling", "api_key")
    have, missing = ("access key", "secret_key") if access_key else ("secret key", "access_key")
    raise MissingCredentialError(
        f"Your Kling {have} has no {missing.replace('_', ' ')}. "
        f"Add a Kling API key in Montaj under Connectors.",
        "kling", missing,
    )


def _make_token() -> str:
    access_key, secret_key = _legacy_pair()
    jwt = _require_jwt()
    now = time.time()
    payload = {"iss": access_key, "exp": int(now) + 1800, "nbf": int(now) - 5}
    headers = {"alg": "HS256", "typ": "JWT"}
    return jwt.encode(payload, secret_key, algorithm="HS256", headers=headers)


def _bearer() -> str:
    """The Authorization bearer value: the API key if stored, else a signed JWT.

    Kling's current standard is a single API Key sent straight as the bearer
    ("API Key (for all models)" in its auth docs, read 2026-09-29). The
    access-key/secret-key pair that `_make_token` signs is documented there as
    "API only applicable to legacy version design standards", so it stays as a
    fallback for accounts still on it rather than being removed.

    API key first, deliberately: an account holding both should use the current
    mechanism, and a stored api_key is the newer, explicit choice.
    """
    try:
        return get_credential("kling", "api_key")
    except CredentialError:
        # No API key stored: fall back to signing a JWT from the legacy pair.
        # get_credential RAISES when a key is absent, it does not return None,
        # so this except is the fallback path and not error handling.
        return _make_token()


def _bearer_v4() -> str:
    """The bearer for Kling 4.0: the API key only.

    B: "API Key (for all models)" against "Access Key / Secret Key (API only
    applicable to legacy version design standards)". A stored legacy pair does
    not work on 4.0, so it gets its own message instead of a JWT.
    """
    try:
        return get_credential("kling", "api_key")
    except MissingCredentialError:
        pass
    try:
        _legacy_pair()
    except MissingCredentialError:
        raise MissingCredentialError(missing_key_message("kling"), "kling", "api_key")
    raise MissingCredentialError(
        "Kling 4.0 needs a Kling API key; your access key and secret key work only "
        "for older Kling models. Add your Kling API key in Montaj under Connectors.",
        "kling", "api_key",
    )


def _auth_headers(bearer: str = None) -> dict:
    return {
        "Authorization": f"Bearer {bearer or _bearer()}",
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
    sound: str = None,
    aspect_ratio: str = "16:9",
    mode: str = None,
    external_task_id: str = None,
    multi_shot: bool = False,
    shot_type: str = None,
    multi_prompt: list[dict] = None,
    model: str = DEFAULT_MODEL,
    seed: int = None,
    resolution: str = None,
) -> dict:
    """Build the omni-video request payload.

    mode=None means DEFAULT_MODE and sound=None means "on" for the legacy
    models; kling-4.0 refuses both (it has neither) and builds its own body.

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
    if model in RETIRED_MODELS:
        raise ConnectorError(f"{model} is retired; use {RETIRED_MODELS[model]}",
                             reason=MODEL_RETIRED)
    if model not in MODELS:
        raise ConnectorError(
            f"Unknown model {model!r}; supported: {', '.join(MODELS)}"
        )
    model_caps = MODELS[model]

    if model_caps.get("api") == "v4":
        return build_payload_v4(
            prompt=prompt, first_frame_path=first_frame_path,
            last_frame_path=last_frame_path, reference_image_paths=reference_image_paths,
            duration_seconds=duration_seconds, negative_prompt=negative_prompt,
            sound=sound, aspect_ratio=aspect_ratio, mode=mode,
            external_task_id=external_task_id, multi_shot=multi_shot,
            shot_type=shot_type, multi_prompt=multi_prompt, model=model,
            seed=seed, resolution=resolution,
        )

    # ---- Legacy-only arguments ----
    if resolution is not None:
        raise ConnectorError(
            f"--resolution is for kling-4.0 only; {model} has no resolution switch "
            f"(use --mode std or pro)."
        )
    if aspect_ratio in V4_ONLY_ASPECTS:
        raise ConnectorError(
            f"Aspect ratio {aspect_ratio} is kling-4.0 only; {model} takes 16:9, 9:16, 1:1."
        )
    if mode is None:
        mode = DEFAULT_MODE
    if sound is None:
        sound = "on"

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


def _is_english(ch: str) -> bool:
    return ord(ch) < 128


def build_payload_v4(
    prompt: str = None,
    first_frame_path: str = None,
    last_frame_path: str = None,
    reference_image_paths: list[str] = None,
    duration_seconds: int = 10,
    negative_prompt: str = None,
    sound: str = None,
    aspect_ratio: str = "16:9",
    mode: str = None,
    external_task_id: str = None,
    multi_shot: bool = False,
    shot_type: str = None,
    multi_prompt: list[dict] = None,
    model: str = "kling-4.0",
    seed: int = None,
    resolution: str = None,
) -> dict:
    """Build the kling-4.0 request body (A: POST /omni-video/kling-4.0).

    Same return shape as build_payload. A has no model_name, mode, sound,
    multi_shot, negative_prompt or seed field, so each is refused here, never
    silently dropped.
    """
    caps = MODELS[model]
    if multi_shot or shot_type or multi_prompt:
        raise ConnectorError(
            f"{model} has no multi-shot mode. Generate each shot as its own clip, "
            f"or use {DEFAULT_MODEL} for multi-shot."
        )
    if mode is not None:
        raise ConnectorError(f"{model} has no std/pro mode; use --resolution 720p or 1080p.")
    if sound is not None:
        raise ConnectorError(
            f"{model} has no sound switch: it always generates audio. Describe the "
            f"sound you want in the prompt, or use {DEFAULT_MODEL} for --sound off."
        )
    if negative_prompt:
        raise ConnectorError(
            f"{model} has no negative prompt. Say what you want in the prompt, "
            f"or use {DEFAULT_MODEL}."
        )
    if seed is not None:
        raise ConnectorError(f"{model} has no seed. Drop the seed, or use {DEFAULT_MODEL}.")

    # A: a prompt item is required in contents.
    if not prompt or not prompt.strip():
        raise ConnectorError("Prompt must not be empty")
    # A: inputs are referenced as @id; the composer writes legacy <<<image_N>>>
    # tokens. N counts reference images only (compose_prompt and the skill), so
    # ref i is image_i. Frames carry their own ids (A: ids unique per task).
    runtime_prompt = re.sub(r"<<<image_(\d+)>>>", r"@image_\1", prompt)
    english = sum(1 for c in runtime_prompt if _is_english(c))
    other = len(runtime_prompt) - english
    if english / V4_MAX_ENGLISH_CHARS + other / V4_MAX_OTHER_CHARS > 1:
        raise ConnectorError(
            f"Prompt is too long for {model}: {V4_MAX_ENGLISH_CHARS:,} characters if "
            f"English only, {V4_MAX_OTHER_CHARS:,} if not, and mixed text must satisfy "
            f"English/{V4_MAX_ENGLISH_CHARS} + other/{V4_MAX_OTHER_CHARS} <= 1 "
            f"(yours: {english:,} English, {other:,} other). Shorten it."
        )

    refs = list(reference_image_paths or [])
    total_images = (1 if first_frame_path else 0) + (1 if last_frame_path else 0) + len(refs)
    if total_images > caps["max_images"]:
        raise ConnectorError(
            f"Too many images ({total_images}); {model} takes at most {caps['max_images']}."
        )

    resolution = resolution or V4_DEFAULT_RESOLUTION
    if resolution not in caps["resolutions"]:
        raise ConnectorError(
            f"Unknown resolution {resolution!r}; {model} takes {', '.join(caps['resolutions'])}."
        )
    if aspect_ratio is not None and aspect_ratio not in caps["aspect_ratios"]:
        raise ConnectorError(
            f"Unknown aspect ratio {aspect_ratio!r}; {model} takes "
            f"{', '.join(caps['aspect_ratios'])}."
        )
    allowed = caps["durations"]
    if duration_seconds not in allowed:
        duration_seconds = min(allowed, key=lambda d: abs(d - duration_seconds))

    contents = [{"type": "prompt", "text": runtime_prompt}]

    def add(kind: str, path: str, id_: str):
        contents.append({"type": kind, "url": _file_to_base64(path), "id": id_})

    if first_frame_path:
        add("first_frame", first_frame_path, "first_frame")
    if last_frame_path:   # A lists last_frame independently of first_frame
        add("last_frame", last_frame_path, "last_frame")
    for i, ref_path in enumerate(refs, 1):
        add("refer_image", ref_path, f"image_{i}")

    settings = {"resolution": resolution, "duration": int(duration_seconds)}
    if aspect_ratio is not None:
        settings["aspect_ratio"] = aspect_ratio
    body = {"contents": contents, "settings": settings}
    if external_task_id:
        body["options"] = {"external_task_id": external_task_id}

    return {
        "runtime_prompt": runtime_prompt,
        "body": body,
        "truncated": False,
        "original_prompt_length": len(prompt),
        "max_prompt_chars": V4_MAX_ENGLISH_CHARS,
    }


def _parse(r) -> dict | None:
    """The response body as a JSON object, or None when it isn't one."""
    try:
        body = r.json()
    except Exception:
        return None
    return body if isinstance(body, dict) else None


def _is_rate_limit(r) -> bool:
    """Whether a 429 is a rate limit worth waiting out. Kling also answers 429
    for an empty balance (code 1102), which no retry can fix, so only a
    rate-limit code retries. A body that doesn't parse or carries any other
    code is not retried: wrongly retrying a billing error is worse than
    wrongly abandoning a rate limit."""
    body = _parse(r)
    return body is not None and body.get("code") in _RATE_LIMIT_CODES


def _request(method: str, url: str, *, retry_statuses: frozenset = frozenset(), **kwargs):
    """_http.request_with_retry, but a 429 retries only if _is_rate_limit."""
    for attempt in range(_http.RETRY_ATTEMPTS):
        r = _http.request_with_retry(method, url, retry_statuses=retry_statuses - {429}, **kwargs)
        if r.status_code != 429 or attempt == _http.RETRY_ATTEMPTS - 1 or not _is_rate_limit(r):
            return r
        time.sleep(_http.RETRY_BACKOFF_S * (2 ** attempt))


def _error(r, label: str, model: str = None) -> ConnectorError:
    """A failed Kling response as a ConnectorError with a shared reason.
    Kling puts useful detail in the JSON body even on 4xx/5xx."""
    body = _parse(r) or {}
    code = body.get("code")
    msg = body.get("message") or body.get("msg") or (r.text or "")[:500] or "unknown error"
    reason = classify_http_error(r.status_code, msg)
    if code in _BALANCE_CODES:
        reason = INSUFFICIENT_CREDIT
    elif code == 1201 and model in MODELS and "model is not supported" in msg.lower():
        reason = MODEL_RETIRED
    if reason == INVALID_API_KEY:
        return ConnectorError(f"Kling rejected the key: {msg}", reason=reason)
    if reason == INSUFFICIENT_CREDIT:
        extra = (" Kling 4.0 draws only on a Flagship Resource Pack or account balance."
                 if model == "kling-4.0" else "")
        return ConnectorError(f'{OUT_OF_CREDIT_MESSAGE} Kling says: "{msg}"{extra}', reason=reason)
    if reason == MODEL_RETIRED:
        return ConnectorError(f'Kling no longer serves {model or "this model"}: "{msg}"',
                              reason=reason)
    status = f" (HTTP {r.status_code})" if r.status_code >= 400 else ""
    return ConnectorError(f"{label} error{status}: {msg}", reason=reason)


def _ok_body(r, label: str, model: str = None) -> dict:
    """The parsed body of a successful response (HTTP < 400, code 0), else raise."""
    body = _parse(r) if r.status_code < 400 else None
    if body is None or body.get("code") != 0:
        raise _error(r, label, model)
    return body


def create_task(body: dict) -> dict:
    """POST /v1/videos/omni-video. Returns response data."""
    url = f"{BASE_URL}/v1/videos/omni-video"
    # Only a rate-limit 429 is retried (rejected, no task created). Network
    # errors and 5xx are NOT retried here: a timed-out/ambiguous POST may have
    # created a paid task server-side, and a duplicate submission costs money.
    r = _request("POST", url, json=body, headers=_auth_headers(), timeout=120,
                 retry_exceptions=False)
    return _ok_body(r, "Kling API", model=body.get("model_name"))["data"]


def create_task_v4(body: dict) -> dict:
    """POST /omni-video/kling-4.0 (A). Returns response data; the task id is data["id"].
    Same retry policy as create_task: a rate-limit 429 only."""
    url = f"{BASE_URL}{MODELS['kling-4.0']['path']}"
    r = _request("POST", url, json=body, headers=_auth_headers(_bearer_v4()), timeout=120,
                 retry_exceptions=False)
    return _ok_body(r, "Kling API", model="kling-4.0")["data"]


def query_task_v4(task_id: str) -> dict:
    """GET /tasks?task_ids=<id> (A). data is a list; returns the task whose id matches."""
    r = _request("GET", f"{BASE_URL}{V4_QUERY_PATH}", params={"task_ids": task_id},
                 headers=_auth_headers(_bearer_v4()), timeout=30,
                 retry_statuses=_http.TRANSIENT_STATUS)
    for task in _ok_body(r, "Kling API")["data"] or []:
        if isinstance(task, dict) and task.get("id") == task_id:
            return task
    # A freshly created task may not be listed yet. Report it as submitted so
    # _poll keeps waiting within MAX_POLL_S instead of abandoning a paid task.
    return {"id": task_id, "status": "submitted"}


def query_task(task_id: str, path_template: str = VIDEO_QUERY_PATH) -> dict:
    """GET task status by ID. Idempotent — transient failures are retried."""
    url = f"{BASE_URL}{path_template.format(task_id=task_id)}"
    r = _request("GET", url, headers=_auth_headers(), timeout=30,
                 retry_statuses=_http.TRANSIENT_STATUS)
    return _ok_body(r, "Kling API")["data"]


# A transient error mid-poll must not abandon the task: generation is already
# paid for. Tolerate up to this many CONSECUTIVE failed status checks (each of
# which already retried transports internally) before giving up.
MAX_CONSECUTIVE_POLL_FAILURES = 5


def _poll(task_id: str, query, status_key: str, done: str, msg_key: str) -> dict:
    """Shared poll loop: query() until status_key reads `done` or "failed"."""
    elapsed = 0.0
    failures = 0
    while elapsed < MAX_POLL_S:
        try:
            task_data = query()
        except ConnectorError as e:
            failures += 1
            if failures >= MAX_CONSECUTIVE_POLL_FAILURES:
                raise ConnectorError(
                    f"Kling task {task_id}: {failures} consecutive status-check "
                    f"failures, giving up. Last error: {e}",
                    reason=e.reason,
                ) from e
        else:
            failures = 0
            status = task_data.get(status_key)
            if status == done:
                return task_data
            if status == "failed":
                msg = task_data.get(msg_key, "unknown error")
                raise ConnectorError(f"Kling task {task_id} failed: {msg}")
        time.sleep(POLL_INTERVAL_S)
        elapsed += POLL_INTERVAL_S
    raise ConnectorError(f"Kling task {task_id} did not complete within {MAX_POLL_S}s")


def poll_until_done(task_id: str, path_template: str = VIDEO_QUERY_PATH) -> dict:
    """Poll task until succeed/failed. Returns task data on success."""
    return _poll(task_id, lambda: query_task(task_id, path_template),
                 "task_status", "succeed", "task_status_msg")


def poll_until_done_v4(task_id: str) -> dict:
    """Poll a kling-4.0 task until succeeded/failed (A statuses)."""
    return _poll(task_id, lambda: query_task_v4(task_id),
                 "status", "succeeded", "message")


def _download_file(url: str, out_path: str) -> str:
    """Download file from URL to out_path."""
    return _http.download_file(url, out_path, timeout=120)


def generate(
    prompt: str = None,
    out_path: str = None,
    first_frame_path: str = None,
    last_frame_path: str = None,
    reference_image_paths: list[str] = None,
    duration_seconds: int = 5,
    negative_prompt: str = None,
    sound: str = None,
    aspect_ratio: str = "16:9",
    mode: str = None,
    external_task_id: str = None,
    multi_shot: bool = False,
    shot_type: str = None,
    multi_prompt: list[dict] = None,
    model: str = DEFAULT_MODEL,
    seed: int = None,
    resolution: str = None,
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
        resolution=resolution,
    )
    if MODELS[model].get("api") == "v4":
        task_id = create_task_v4(payload["body"])["id"]
        result = poll_until_done_v4(task_id)
        video_url = next((o.get("url") for o in result.get("outputs") or []
                          if isinstance(o, dict) and o.get("type") == "video" and o.get("url")), None)
        if not video_url:
            raise ConnectorError(f"Kling task {task_id} finished with no video output")
        return _download_file(video_url, out_path)
    task_data = create_task(payload["body"])
    task_id = task_data["task_id"]
    result = poll_until_done(task_id)
    video_url = result["task_result"]["videos"][0]["url"]
    return _download_file(video_url, out_path)


def generate_speech(
    text: str,
    voice: str,
    out_path: str,
    speed: float = 1.0,
    language: str = "en",
) -> str:
    """Generate speech audio from text via Kling TTS.

    text     — script to speak (max 1000 chars per API docs).
    voice    — voice identifier. Either a raw Kling voice ID or a key in TTS_VOICES.
    out_path — local file path for the downloaded audio.
    speed    — playback speed multiplier [0.8, 2.0].
    language — voice language: 'en' or 'zh' (must match the voice_id).

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
        "voice_language": language,
        "voice_speed": speed,
    }

    url = f"{BASE_URL}{TTS_CREATE_PATH}"
    # TTS is synchronous — the API blocks and returns the audio in the
    # create response. No separate query/poll endpoint exists.
    # Longer timeout since the API may block for the full synthesis. Like
    # create_task: only a rate-limit 429 is retried (a timed-out POST may have
    # been billed).
    r = _request("POST", url, json=body, headers=_auth_headers(), timeout=120,
                 retry_exceptions=False)
    result = _ok_body(r, "Kling TTS")["data"]

    status = result.get("task_status")
    if status == "failed":
        msg = result.get("task_status_msg", "unknown error")
        raise ConnectorError(f"Kling TTS failed: {msg}")

    try:
        audio_url = result["task_result"]["audios"][0]["url"]
    except (KeyError, IndexError, TypeError) as e:
        raise ConnectorError(
            f"Kling TTS returned no audio URL (status={status}): {result}"
        ) from e

    return _download_file(audio_url, out_path)


def check_key() -> dict:
    """Validate the stored/overlaid key pair with one free call: the account's
    resource-pack costs for the last 7 days, GET /account/costs (no /v1; that
    path 404s). No billed call.

    Kling has no model-list endpoint, so the default model is not checked:
    default_model_verified is always False, and default_model_ok only says
    DEFAULT_MODEL is not in RETIRED_MODELS. An unannounced retirement shows up
    on the next create as MODEL_RETIRED instead.

    The endpoint allows about 1 QPS, so nothing is retried: not a 429, not a
    dropped connection. Raises ConnectorError with the reason _error gives, or
    UNREACHABLE when no response came back.
    """
    headers = _auth_headers()  # a missing credential raises here, not as UNREACHABLE
    now_ms = int(time.time() * 1000)
    params = {"start_time": now_ms - 7 * 24 * 3600 * 1000, "end_time": now_ms}
    try:
        r = _http.request_with_retry(
            "GET", f"{BASE_URL}/account/costs", params=params, headers=headers,
            timeout=15, retry_statuses=frozenset(), retry_exceptions=False,
        )
    except ConnectorError as e:
        raise ConnectorError(f"Could not reach Kling: {e}", reason=UNREACHABLE) from e
    _ok_body(r, "Kling key check")
    return {
        "ok": True,
        "default_model": DEFAULT_MODEL,
        "default_model_ok": DEFAULT_MODEL not in RETIRED_MODELS,
        "default_model_verified": False,
        "detail": "Default model not checked: Kling has no model-list endpoint",
    }
