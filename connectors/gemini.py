"""Google Gemini connector (google-genai SDK).

One vendor, one API key, one SDK. Exposes one function per use case today;
add more here (chat, etc.) rather than creating new files per use case.
See docs/CONNECTORS.md for the layering rule.

Current functions:
    analyze_media(path, prompt, model, json_output) -> str
        Multimodal comprehension of a video, audio, or image file.
        - Images under INLINE_BYTE_LIMIT take a fast path: bytes are sent
          inline in generate_content, no Files API round-trip. Typical latency
          ~1s vs ~3-5s for the upload+poll+delete cycle.
        - Everything else (video, audio, oversized images) goes through the
          Files API via upload_media().
        Branching is internal — callers just pass a path and a prompt.
    generate_image(prompt, out_path, ref_images, size, model, aspect_ratio) -> str
    generate_speech(text, voice, out_path, model) -> str
    generate_music(prompt, out_path, instrumental, model, seed) -> str
    generate_video(prompt, out_path, image_path, last_frame_path,
                   reference_image_paths, duration, aspect_ratio, resolution,
                   negative_prompt, model) -> str
        Video with sound via Gemini Omni Flash (Interactions API): one request,
        never retried, then the clip's file. Billed per second once sent, so
        every input is checked by video_request_problem() before any network
        call, and a failure after sending never invites a blind re-run.
    video_request_problem(...) -> str | None
        Pure check of a video request; a short message for the first invalid
        combination, None when the request is valid.
    check_key() -> dict
        One free call (models.list) to validate a key and confirm each of the
        five default models (text, image, TTS, music, video) is still
        available, with no billed call.

Private helpers:
    _generate_audio(model, contents, config, out_path, ...) -> str
        Shared audio-modality generation: SDK call → response extraction → disk write.
        Used by generate_speech and generate_music.

Library code — raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import json as _json
import base64, os, re, sys, time, wave
from connectors import (
    ConnectorError, UNREACHABLE, INSUFFICIENT_CREDIT, MODEL_RETIRED, CONTENT_REFUSED, _http,
    retarget_extension as _retarget_extension,
)
from lib.credentials import get_credential

# gemini-2.5-flash started 404ing for new API keys ("no longer available to
# new users") — confirmed live against models.list + a real generate_content
# call on 2026-09-26. gemini-3.8-flash is live on the same key as of that
# date; re-check against models.list before ever changing this again.
DEFAULT_MODEL = "gemini-3.8-flash"
# PV29 T4b (2026-09-28, docs/plans/PV29-vendor-facts.md): gemini-3-pro-image
# ("Nano Banana Pro") went GA, replacing the preview default below. Not
# recorded as retired — still usable via --model.
#   Old default: gemini-3-pro-image-preview
DEFAULT_IMAGE_MODEL = "gemini-3-pro-image"
UPLOAD_POLL_INTERVAL_S = 1.0
UPLOAD_MAX_WAIT_S = 300.0

# Gemini's inline-data request cap is ~20 MB total payload. Use a conservative
# ceiling that leaves room for the prompt text + JSON overhead. Images above
# this go through the Files API.
INLINE_BYTE_LIMIT = 18 * 1024 * 1024  # 18 MB

# PV29 T4b (2026-09-28, docs/plans/PV29-vendor-facts.md): gemini-3.8-flash-tts
# and lyria-3.5 are the GA replacements below for the two 2026-09-26 preview
# defaults (neither recorded as retired — still usable via --model):
#   Old TTS default:   gemini-2.5-flash-preview-tts
#   Old music default: lyria-3-clip-preview
# Verified live 2026-09-28 (PV29 vendor facts, receipts 3 and 4):
# gemini-3.8-flash-tts works with voice Kore; lyria-3.5 works with the
# existing request shape and returns a ~68 s track.
DEFAULT_TTS_MODEL = "gemini-3.8-flash-tts"
DEFAULT_TTS_VOICE = "Kore"  # default for generate_speech when caller omits voice
DEFAULT_MUSIC_MODEL = "lyria-3.5"

# Video on the Gemini API is Gemini Omni Flash, through the Interactions API
# (§550). Google shut down every Veo 3.1 preview id on 2026-10-22 and names
# gemini-omni-1.1-flash (GA 2026-08-27) as their replacement
# (ai.google.dev/gemini-api/docs/deprecations). Facts read 2026-10-23 from
# ai.google.dev/gemini-api/docs/omni, /docs/models/gemini-omni-flash,
# /docs/pricing and /api/interactions-api, and from google-genai 2.33.0's own
# request types (VideoResponseFormat, VideoConfig):
# - One blocking POST /v1beta/interactions makes the video: the guide's
#   "background=false, store=false, stream=false" unary form. There is no
#   operation to poll, and with store false nothing can be fetched later.
# - Video with sound at 24 fps, 3 to 10 seconds, 16:9 or 9:16. No negative
#   prompt ("negative prompts are not supported"), so one goes in the prompt.
# - $17.50 per 1M output tokens at 5,792 tokens a second of 720p: about $0.10
#   a second. Paid tier only. 1080p and 4k are upscaled and Google gives them
#   no price, so only 720p is offered.
# - `duration` is in VideoResponseFormat but the guide never sets it; the
#   "Ns" form here is the protobuf Duration a str field takes, not measured.
VIDEO_ON = True
VIDEO_OFF_MESSAGE = "Gemini video is off in this version of Montaj. Use Kling, Seedance or Kinovi."
DEFAULT_VIDEO_MODEL = "gemini-omni-1.1-flash"
# What each model takes. "reference_images" is whether it accepts up to
# VIDEO_MAX_REFERENCE_IMAGES subject images.
VIDEO_MODELS = {
    "gemini-omni-1.1-flash": {"resolutions": ("720p",), "reference_images": True},
}
VIDEO_DURATIONS = tuple(range(3, 11))
VIDEO_ASPECT_RATIOS = ("16:9", "9:16")
VIDEO_RESOLUTIONS = ("720p",)
# The guide sets no limit; three keeps a request, and its upload, bounded.
VIDEO_MAX_REFERENCE_IMAGES = 3
VIDEO_PRICE_PER_SECOND_USD = {"720p": 0.10}
VIDEO_API = "https://generativelanguage.googleapis.com/v1beta"
# serve kills a step at 900 s. Everything from the request to the last byte of
# the download shares one deadline under that; the request itself waits 600 s.
VIDEO_DEADLINE_S = 840
VIDEO_REQUEST_TIMEOUT_S = 600
# A URI delivery is polled until the file is ACTIVE, as the guide's loop does.
VIDEO_FILE_POLL_INTERVAL_S = 5
VIDEO_FILE_MAX_WAIT_S = 180
VIDEO_DOWNLOAD_ATTEMPTS = 3
VIDEO_DOWNLOAD_RETRY_S = 3

_VIDEO_IMAGE_MIME_BY_EXT = {
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

# Shared fail() message for ConnectorError(reason="invalid_api_key"). One
# constant so every Gemini-calling step (analyze_media, generate_image,
# generate_voiceover, generate_music) shows the operator identical wording
# instead of four hand-written copies drifting apart. It names only the app's
# Connectors page: app users have no CLI (§549).
INVALID_API_KEY_MESSAGE = "Your Gemini API key was rejected. Update it in Montaj under Connectors."

_IMAGE_MIME_BY_EXT = {
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".gif":  "image/gif",
}

# Container extension per mime-type token, for _generate_audio's pass-through
# branch. Scanned as an ordered tuple of substrings rather than keyed on the
# full type because vendors spell the same container several ways
# ("audio/mpeg", "audio/mp3", "audio/mpeg3") and a prefix table would miss two
# of the three.
_AUDIO_EXT_BY_MIME_TOKEN = (
    ("wav",  ".wav"),
    ("mpeg", ".mp3"),
    ("mp3",  ".mp3"),
    ("flac", ".flac"),
    ("opus", ".opus"),
    ("ogg",  ".ogg"),
    ("aac",  ".m4a"),
    ("mp4",  ".m4a"),
)


def _audio_ext_for_mime(mime_type: str | None) -> str | None:
    """Container extension for a PRE-ENCODED audio mime type.

    ``None`` means "no container recognised", which callers read as raw PCM.
    """
    if not mime_type:
        return None
    lowered = mime_type.lower()
    for token, ext in _AUDIO_EXT_BY_MIME_TOKEN:
        if token in lowered:
            return ext
    return None


def _strip_markdown_fences(text: str) -> str:
    """Strip ```json ... ``` fences that Gemini often wraps around JSON responses.

    Applied automatically when json_output=True. Idempotent — plain JSON passes through.
    """
    stripped = re.sub(r"^```(?:json)?\s*\n?", "", text.strip())
    stripped = re.sub(r"\n?```\s*$", "", stripped)
    return stripped.strip()


def _image_mime(path: str) -> str | None:
    """Return Gemini mime-type for a known image extension, else None.

    Exotic formats (RAW, TIFF, etc.) fall through to None and take the
    Files API path — the SDK handles a wider set there.
    """
    ext = os.path.splitext(path)[1].lower()
    return _IMAGE_MIME_BY_EXT.get(ext)


def _client():
    """Lazily create a google-genai Client."""
    try:
        from google import genai
    except ImportError:
        raise ConnectorError(
            "Missing connector dependencies. Run: montaj install connectors"
        )
    return genai.Client(api_key=get_credential("gemini", "api_key"))


def _is_invalid_api_key_error(e: Exception) -> bool:
    """True if `e` is a google-genai SDK error indicating a rejected API key.

    Matched against the installed SDK's real shape (google/genai/errors.py):
    `APIError.raise_error` raises `ClientError` for any 4xx and `ServerError`
    for any 5xx, with `.code` the HTTP status (int), `.status` the API's
    string status (e.g. "INVALID_ARGUMENT", "PERMISSION_DENIED",
    "UNAUTHENTICATED"), and `.message` the human-readable text — all parsed
    from the response body, so any of the three can be None on an odd
    response shape.

    A rejected key from Google's API most often comes back as a plain 400
    with status "INVALID_ARGUMENT" and a message containing "API key" (e.g.
    "API key not valid. Please pass a valid API key."), which is why the
    message is checked, not just the status. 401/UNAUTHENTICATED is an auth
    failure regardless of message wording — the request carried no usable
    credential at all, so it is checked structurally. 403/PERMISSION_DENIED
    is NOT unconditional, unlike 401: that status also covers a perfectly
    valid key whose project lacks a permission or whose billing isn't set up
    (e.g. "The caller does not have permission" for an API not enabled on the
    project) — reporting that as a bad key would send the operator to
    re-enter a key that was never the problem. So 403/PERMISSION_DENIED is
    only treated as a key problem when the message itself says so ("api key"
    or "api_key", case-insensitive, e.g. "API key expired. Please renew the
    API key."). Anything not an APIError (a network error, a timeout) is
    never treated as a key problem.
    """
    try:
        from google.genai import errors
    except ImportError:
        return False
    if not isinstance(e, errors.APIError):
        return False
    code = getattr(e, "code", None)
    status = (getattr(e, "status", None) or "").upper()
    message = (getattr(e, "message", None) or str(e)).lower()
    if code == 401 or status == "UNAUTHENTICATED":
        return True
    if (code == 403 or status == "PERMISSION_DENIED") and (
        "api key" in message or "api_key" in message
    ):
        return True
    if code == 400 and "api key" in message:
        return True
    return False


# Defensive scrub for anything that looks like a Google API key or an
# AQ.-prefixed token, applied to any text sourced from an SDK exception
# before it reaches a ConnectorError message, a step's fail() text, or a
# terminal. Google's error bodies aren't expected to echo the key back, but
# nothing guarantees that, and a key that leaked into an error message would
# otherwise end up in exactly the places this connector is not allowed to
# put one.
_API_KEY_PATTERNS = (
    re.compile(r"AIza[\w-]{10,}"),
    re.compile(r"AQ\.[\w-]{10,}"),
)

_SDK_DETAIL_CHAR_LIMIT = 200


def _sanitize_sdk_detail(text: str | None, limit: int = _SDK_DETAIL_CHAR_LIMIT) -> str:
    """Redact API-key-shaped tokens and truncate to `limit` chars.

    Applied to SDK-sourced error text before it is embedded in a
    ConnectorError message or a step-facing fail() message.
    """
    text = (text or "").strip()
    for pattern in _API_KEY_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    if len(text) > limit:
        text = text[:limit].rstrip() + "..."
    return text


def _wrap_sdk_error(e: Exception, prefix: str) -> ConnectorError:
    """Turn an SDK exception into the ConnectorError a step should see.

    A rejected API key gets reason="invalid_api_key" so step scripts can
    give the operator a fix-it message instead of a generic api_error;
    every other SDK failure keeps the existing `{prefix}: {e}` shape. Either
    way, the SDK-sourced detail text is redacted (no API-key-shaped token
    survives) and truncated to ~200 chars before it lands in the message —
    Google's own error body can be long and, in principle, could echo back
    request contents.

    The invalid-key ConnectorError also stashes the sanitized detail as
    `.google_detail`, which `invalid_api_key_message()` uses to append
    Google's own wording to the operator-facing fix-it message instead of
    hiding it — see FQ1 #21. A ConnectorError built by hand (tests, or a
    non-Gemini connector reusing reason="invalid_api_key") simply has no
    such attribute.
    """
    if _is_invalid_api_key_error(e):
        detail = _sanitize_sdk_detail(getattr(e, "message", None) or str(e))
        err = ConnectorError(
            f"Gemini rejected the API key: {detail}", reason="invalid_api_key"
        )
        err.google_detail = detail
        return err
    detail = _sanitize_sdk_detail(str(e))
    return ConnectorError(f"{prefix}: {detail}")


def invalid_api_key_message(e: ConnectorError) -> str:
    """INVALID_API_KEY_MESSAGE, plus Google's own rejection text when known.

    Without this, every Gemini-calling step showed identical wording for
    every key rejection, hiding the actual cause (e.g. "API key not valid"
    vs. an expired key vs. a billing/permission issue) even though the SDK
    handed it to us. `e.google_detail` — set by `_wrap_sdk_error` — is
    already redacted and truncated, so it's safe to show as-is.
    """
    detail = getattr(e, "google_detail", None)
    if detail:
        return f"{INVALID_API_KEY_MESSAGE} Google said: {detail}"
    return INVALID_API_KEY_MESSAGE


def check_key() -> dict:
    """Validate the stored/overlaid Gemini key with one free call: models.list.

    No billed call — listing the models a key can see costs nothing.

    One Gemini key backs five generation capabilities under this connector
    (text, image, TTS, music, video), each with its own default model that can
    be retired independently of the others. check_key() is new and unreleased
    (PV29) with no backward compatibility to keep, and the app's
    Connectors tile and the release guard read only default_model_ok — so
    that field means ALL FIVE defaults are present in models.list, not just
    the text one:
      - default_model_ok is True only when DEFAULT_MODEL, DEFAULT_IMAGE_MODEL,
        DEFAULT_TTS_MODEL, DEFAULT_MUSIC_MODEL and DEFAULT_VIDEO_MODEL are all
        present.
      - When any are missing, default_model is set to the first missing
        one's id (checked in text, image, TTS, music, video order) instead of
        DEFAULT_MODEL, and detail names every missing one — a caller reading
        only {default_model, default_model_ok, detail} still sees which
        model retired, not just that something did.
      - image_model_ok / tts_model_ok / music_model_ok / video_model_ok are
        kept as the individual per-capability flags (same membership check,
        off the same models.list response — no extra call), for a caller that
        wants to know which capability specifically is affected rather than
        parse detail's text.

    A rejected key raises ConnectorError(reason="invalid_api_key") through the
    same detection every other Gemini call path uses (_wrap_sdk_error /
    _is_invalid_api_key_error). A network failure raises
    ConnectorError(reason=UNREACHABLE) — SDK calls transit httpx, which raises
    httpx.TransportError (connection refused, DNS failure, timeout) rather
    than a genai.errors.APIError, so that's caught separately.
    """
    client = _client()
    try:
        import httpx
    except ImportError:
        raise ConnectorError("Missing connector dependencies. Run: montaj install connectors")

    try:
        model_names = {(m.name or "").removeprefix("models/") for m in client.models.list()}
    except httpx.TransportError as e:
        raise ConnectorError(
            f"Gemini key check failed: could not reach the API: {e}", reason=UNREACHABLE
        ) from e
    except Exception as e:
        raise _wrap_sdk_error(e, "Gemini key check failed") from e

    # Checked in this order — text, image, TTS, music, video — so that when
    # more than one default is missing, the one surfaced through
    # `default_model` (a single-value field) is deterministic rather than
    # set-iteration order.
    capability_defaults = (
        ("image_model_ok", DEFAULT_IMAGE_MODEL),
        ("tts_model_ok", DEFAULT_TTS_MODEL),
        ("music_model_ok", DEFAULT_MUSIC_MODEL),
        # With Gemini video off there is no video default to check (None below).
        *((("video_model_ok", DEFAULT_VIDEO_MODEL),) if VIDEO_ON else ()),
    )
    text_ok = DEFAULT_MODEL in model_names
    missing = [] if text_ok else [DEFAULT_MODEL]
    availability = {}
    for flag_name, model in capability_defaults:
        ok = model in model_names
        availability[flag_name] = ok
        if not ok:
            missing.append(model)

    default_model_ok = not missing
    detail = f"{len(model_names)} models available to this key"
    if missing:
        detail += f"; missing default(s): {', '.join(missing)}"

    return {
        "ok": True,
        "default_model": missing[0] if missing else DEFAULT_MODEL,
        "default_model_ok": default_model_ok,
        "image_model_ok": availability["image_model_ok"],
        "tts_model_ok": availability["tts_model_ok"],
        "music_model_ok": availability["music_model_ok"],
        "video_model_ok": availability.get("video_model_ok"),
        "detail": detail,
    }


def upload_media(path: str):
    """Upload a media file (video, audio, or image) via Files API, poll until ACTIVE. Returns file object."""
    client = _client()
    try:
        media_file = client.files.upload(file=path)
    except Exception as e:
        raise _wrap_sdk_error(e, "Gemini file upload failed") from e

    elapsed = 0.0
    while elapsed < UPLOAD_MAX_WAIT_S:
        try:
            media_file = client.files.get(name=media_file.name)
        except Exception as e:
            raise _wrap_sdk_error(e, "Gemini file status check failed") from e
        if media_file.state.name == "ACTIVE":
            return media_file
        if media_file.state.name == "FAILED":
            raise ConnectorError(f"Gemini file processing failed for {media_file.name}")
        time.sleep(UPLOAD_POLL_INTERVAL_S)
        elapsed += UPLOAD_POLL_INTERVAL_S

    raise ConnectorError(
        f"Gemini file {media_file.name} did not become ACTIVE within {UPLOAD_MAX_WAIT_S}s"
    )


_MEDIA_RESOLUTIONS = ("low", "medium", "high")


def _usage_dict(response) -> dict | None:
    """Token counts from response.usage_metadata; any count may be None."""
    um = getattr(response, "usage_metadata", None)
    if um is None:
        return None

    def _n(name):
        v = getattr(um, name, None)
        return v if isinstance(v, int) else None

    return {
        "prompt": _n("prompt_token_count"),
        "output": _n("candidates_token_count"),
        "thinking": _n("thoughts_token_count"),
        "total": _n("total_token_count"),
    }


def _finish_reason(response) -> str | None:
    """Name of the first candidate's finish reason (e.g. "MAX_TOKENS"), None if unknown."""
    try:
        fr = response.candidates[0].finish_reason
    except (AttributeError, IndexError, TypeError):
        return None
    name = getattr(fr, "name", fr)
    return name if isinstance(name, str) else None


def empty_reply_message(finish_reason: str | None) -> str:
    """Why a reply with no text is empty, with the fix when the cause is the token cap."""
    if finish_reason == "MAX_TOKENS":
        return ("Gemini stopped (MAX_TOKENS) before writing anything: "
                "raise max-output-tokens or lower thinking-budget")
    return f"Gemini returned no text (finish reason: {finish_reason or 'unknown'})"


def _result(response, model: str, json_output: bool) -> dict:
    raw = response.text or ""
    return {
        "text": _strip_markdown_fences(raw) if json_output and raw else raw,
        "raw": raw,
        "usage": _usage_dict(response),
        "model": model,
        "finish_reason": _finish_reason(response),
    }


def analyze_media_meta(
    path: str,
    prompt: str,
    model: str = DEFAULT_MODEL,
    json_output: bool = False,
    *,
    max_output_tokens: int | None = None,
    thinking_budget: int | None = None,
    video_fps: float | None = None,
    media_resolution: str | None = None,
) -> dict:
    """Analyze a media file (video, audio, or image) with Gemini.

    Returns {"text": str, "raw": str, "usage": {"prompt", "output", "thinking", "total"} | None,
    "model": str, "finish_reason": str | None}. `text` is "" when the reply has no text
    (see empty_reply_message); `raw` is the reply before code fences are stripped.
    `usage` comes from response.usage_metadata; any count may be None.

    Branching:
    - Images under INLINE_BYTE_LIMIT: inline bytes in generate_content, no
      Files API upload. Faster and no server-side file cleanup needed.
    - Everything else: Files API (upload_media) + generate_content +
      best-effort delete. `video_fps` rides on the uploaded file's part.
    """
    if not prompt or not prompt.strip():
        raise ConnectorError("Prompt must not be empty")
    if media_resolution is not None and media_resolution not in _MEDIA_RESOLUTIONS:
        raise ConnectorError(
            f"media_resolution must be one of {', '.join(_MEDIA_RESOLUTIONS)}, got {media_resolution!r}"
        )

    try:
        size = os.path.getsize(path)
    except OSError as e:
        raise ConnectorError(f"Could not stat {path}: {e}") from e

    mime = _image_mime(path)
    use_inline = mime is not None and size <= INLINE_BYTE_LIMIT

    client = _client()
    try:
        from google.genai import types
    except ImportError:
        raise ConnectorError(
            "Missing connector dependencies. Run: montaj install connectors"
        )

    config = {}
    if json_output:
        config["response_mime_type"] = "application/json"
    if max_output_tokens is not None:
        config["max_output_tokens"] = max_output_tokens
    if thinking_budget is not None:
        config["thinking_config"] = types.ThinkingConfig(thinking_budget=thinking_budget)
    if media_resolution is not None:
        config["media_resolution"] = getattr(
            types.MediaResolution, f"MEDIA_RESOLUTION_{media_resolution.upper()}"
        )
    config_obj = types.GenerateContentConfig(**config) if config else None

    if use_inline:
        # Fast path: inline image bytes, no Files API round-trip.
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError as e:
            raise ConnectorError(f"Could not read {path}: {e}") from e
        try:
            response = client.models.generate_content(
                model=model,
                contents=[types.Part.from_bytes(data=data, mime_type=mime), prompt],
                config=config_obj,
            )
        except Exception as e:
            raise _wrap_sdk_error(e, "Gemini generate_content failed") from e
        return _result(response, model, json_output)

    # Files API path for video, audio, and oversized images.
    media_file = upload_media(path)
    media_part = media_file
    if video_fps is not None:
        media_part = types.Part(
            file_data=types.FileData(file_uri=media_file.uri, mime_type=media_file.mime_type),
            video_metadata=types.VideoMetadata(fps=video_fps),
        )
    try:
        response = client.models.generate_content(
            model=model,
            contents=[media_part, prompt],
            config=config_obj,
        )
    except ConnectorError:
        raise
    except Exception as e:
        raise _wrap_sdk_error(e, "Gemini generate_content failed") from e
    finally:
        # Best-effort cleanup — but log failures: silently leaked uploads
        # accumulate against the account's Files API quota.
        try:
            client.files.delete(name=media_file.name)
        except Exception as e:
            print(_json.dumps({"progress": f"gemini: failed to delete uploaded file {media_file.name}: {e}"}),
                  file=sys.stderr, flush=True)

    return _result(response, model, json_output)


def analyze_media(
    path: str,
    prompt: str,
    model: str = DEFAULT_MODEL,
    json_output: bool = False,
    *,
    max_output_tokens: int | None = None,
    thinking_budget: int | None = None,
    video_fps: float | None = None,
    media_resolution: str | None = None,
) -> str:
    """The model's reply as a str. Raises ConnectorError when the reply has no text."""
    r = analyze_media_meta(
        path, prompt, model, json_output,
        max_output_tokens=max_output_tokens,
        thinking_budget=thinking_budget,
        video_fps=video_fps,
        media_resolution=media_resolution,
    )
    if not r["text"]:
        raise ConnectorError(empty_reply_message(r["finish_reason"]))
    return r["text"]


def generate_image(
    prompt: str,
    out_path: str,
    ref_images: list[str] | None = None,
    size: str = "1024x1024",
    model: str = DEFAULT_IMAGE_MODEL,
    aspect_ratio: str | None = None,
) -> str:
    """Generate an image via Gemini. Returns local path to saved PNG.

    - ref_images: list of local image paths used as multimodal context.
    - size: present for interface symmetry with OpenAI; Gemini prefers
      aspect_ratio. If aspect_ratio is set, use it.
    - Raises ConnectorError on SDK failure, empty response, or no image in output.
    """
    if not prompt or not prompt.strip():
        raise ConnectorError("Prompt must not be empty")

    client = _client()
    try:
        from google.genai import types
    except ImportError:
        raise ConnectorError("Missing connector dependencies. Run: montaj install connectors")

    # Build multimodal content parts
    parts = []
    for ref_path in (ref_images or []):
        try:
            with open(ref_path, "rb") as f:
                img_bytes = f.read()
        except OSError as e:
            raise ConnectorError(f"Could not read reference image {ref_path}: {e}") from e
        mime = "image/png" if ref_path.lower().endswith(".png") else "image/jpeg"
        parts.append(types.Part.from_bytes(data=img_bytes, mime_type=mime))
    parts.append(types.Part.from_text(text=prompt))

    # Config
    config_kwargs = {"response_modalities": ["IMAGE", "TEXT"]}
    if aspect_ratio:
        config_kwargs["image_config"] = types.ImageConfig(aspect_ratio=aspect_ratio)

    try:
        resp = client.models.generate_content(
            model=model,
            contents=parts,
            config=types.GenerateContentConfig(**config_kwargs),
        )
    except ConnectorError:
        raise
    except Exception as e:
        raise _wrap_sdk_error(e, "Gemini image generation failed") from e

    # Extract image bytes from response
    if not resp.candidates:
        reason = getattr(resp, "prompt_feedback", None)
        raise ConnectorError(f"Gemini returned no candidates. Feedback: {reason}")
    candidate = resp.candidates[0]
    if not candidate.content or not candidate.content.parts:
        finish = getattr(candidate, "finish_reason", "unknown")
        raise ConnectorError(f"Gemini returned empty content. Finish reason: {finish}")

    for part in candidate.content.parts:
        inline = getattr(part, "inline_data", None)
        if inline is not None and inline.data:
            os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
            with open(out_path, "wb") as f:
                f.write(inline.data)
            return out_path

    raise ConnectorError("Gemini returned no image in response")


def _generate_audio(
    model: str,
    contents,
    config,
    out_path: str,
    channels: int,
    sample_rate: int,
    error_prefix: str = "Audio generation",
) -> str:
    """Shared helper: Gemini audio-modality generation -> bytes -> disk.

    Handles SDK invocation, response extraction, mime_type routing
    (pass-through for pre-encoded wav/mp3, WAV-wrap for raw PCM),
    and file writing. Callers build the config and pick sample rate/channels.
    """
    client = _client()
    try:
        response = client.models.generate_content(
            model=model,
            contents=contents,
            config=config,
        )
    except Exception as e:
        raise _wrap_sdk_error(e, f"{error_prefix} request failed") from e

    # Lyria returns multiple parts (text lyrics + audio); TTS returns one.
    # Iterate to find the part with inline_data rather than assuming parts[0].
    try:
        audio_bytes = None
        mime_type = None
        for part in response.candidates[0].content.parts:
            if part.inline_data is not None:
                audio_bytes = part.inline_data.data
                mime_type = part.inline_data.mime_type
                break
        if audio_bytes is None:
            raise ConnectorError(f"{error_prefix} returned no audio part in response")
    except (AttributeError, IndexError) as e:
        raise ConnectorError(f"{error_prefix} returned unexpected shape: {e}") from e

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)

    # The file is named after what the bytes ARE, not what the caller asked to
    # call them. Lyria answers `audio/mpeg` whatever `--out` said, so honouring
    # the requested name wrote an MP3 called `.wav`: ffmpeg sniffs content and
    # coped, but Finder, QuickTime and every consumer that trusts the extension
    # refused to open it, with nothing anywhere saying why. Re-encoding to the
    # requested container is the other way to close this, and is deliberately
    # NOT what happens — a generation step writes vendor bytes verbatim and
    # leaves encoding to render time.
    ext = _audio_ext_for_mime(mime_type)
    written = _retarget_extension(out_path, ext if ext is not None else ".wav")
    if written != out_path:
        detail = (f"vendor returned {mime_type}" if ext is not None
                  else f"raw PCM wrapped as WAV (mime_type={mime_type!r})")
        print(_json.dumps({"warn": f"{error_prefix}: {detail}; wrote {written}, not {out_path}"}),
              file=sys.stderr)

    if ext is not None:
        with open(written, "wb") as f:
            f.write(audio_bytes)
    else:
        # No container recognised — treat as raw PCM and wrap it at the
        # caller-specified rate/channels. If mime_type was None or unknown
        # this may still produce corrupt output, hence the warning above.
        print(_json.dumps({"warn": f"{error_prefix}: assuming raw PCM (mime_type={mime_type!r})"}),
              file=sys.stderr)
        with wave.open(written, "wb") as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(sample_rate)
            wf.writeframes(audio_bytes)

    return written


def generate_speech(
    text: str,
    voice: str = DEFAULT_TTS_VOICE,
    out_path: str = None,
    model: str = DEFAULT_TTS_MODEL,
) -> str:
    """Generate speech audio from text via Gemini TTS (single-speaker).

    Writes a WAV file — Gemini TTS returns raw PCM, which is wrapped here — and
    returns the path written. That path is normally out_path; if TTS ever answers
    with a pre-encoded container instead, the extension follows the bytes, so use
    the return value rather than assuming out_path exists.
    Raises ConnectorError on failure.
    """
    if not text or not text.strip():
        raise ConnectorError("text must not be empty")
    if not out_path:
        raise ConnectorError("out_path is required")

    try:
        from google.genai import types
    except ImportError:
        raise ConnectorError("Missing connector dependencies. Run: montaj install connectors")

    config = types.GenerateContentConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice),
            ),
        ),
    )

    return _generate_audio(
        model=model, contents=text, config=config,
        out_path=out_path, channels=1, sample_rate=24000,
        error_prefix="Gemini TTS",
    )


def generate_music(
    prompt: str,
    out_path: str,
    instrumental: bool = True,
    model: str = DEFAULT_MUSIC_MODEL,
    seed: int = None,
) -> str:
    """Generate a music clip from a text prompt via Lyria 3.

    prompt       — text description of the music (genre, mood, instrumentation).
    out_path     — desired local file path. Its EXTENSION is advisory: the file
                   is named after the container Lyria actually returns, which is
                   `audio/mpeg` in practice, so asking for `cue.wav` writes
                   `cue.mp3`. The bytes are never re-encoded to match the request.
    instrumental — if True, ask Lyria to produce instrumental-only output
                   (suitable for background music under narration).
    model        — Lyria model variant. Default: lyria-3.5 (~68 s tracks).
    seed         — optional RNG seed for reproducible outputs.

    Returns THE PATH WRITTEN, which may differ from out_path by extension — use
    the return value rather than assuming out_path exists. Raises ConnectorError
    on failure.
    """
    if not prompt or not prompt.strip():
        raise ConnectorError("prompt must not be empty")
    if not out_path:
        raise ConnectorError("out_path is required")

    try:
        from google.genai import types
    except ImportError:
        raise ConnectorError("Missing connector dependencies. Run: montaj install connectors")

    effective_prompt = ("Instrumental only. " + prompt) if instrumental else prompt

    # Lyria returns both text (lyrics/structure) and audio parts.
    # Don't force response_modalities=["AUDIO"] — it can suppress the audio part.
    # The basic Lyria example in Google's docs passes no config at all.
    config_kwargs = {}
    if seed is not None:
        config_kwargs["seed"] = seed
    config = types.GenerateContentConfig(**config_kwargs) if config_kwargs else None

    return _generate_audio(
        model=model, contents=effective_prompt, config=config,
        out_path=out_path, channels=2, sample_rate=44100,
        error_prefix="Lyria music",
    )


# ---------------------------------------------------------------------------
# Video: Gemini Omni Flash through the Interactions API (§550)
# ---------------------------------------------------------------------------

# $17.50 per 1M output tokens (ai.google.dev/gemini-api/docs/pricing, read 2026-10-23).
_VIDEO_OUTPUT_USD_PER_TOKEN = 17.50 / 1_000_000


def _video_duration(duration) -> int | None:
    """`duration` as an int when it is a whole number of seconds, else None."""
    if isinstance(duration, bool):
        return None
    if isinstance(duration, int):
        return duration
    if isinstance(duration, float) and duration.is_integer():
        return int(duration)
    if isinstance(duration, str) and duration.strip().isdigit():
        return int(duration.strip())
    return None


def video_request_problem(
    prompt: str,
    image_path: str | None = None,
    last_frame_path: str | None = None,
    reference_image_paths: list[str] | None = None,
    duration=8,
    aspect_ratio: str = "9:16",
    resolution: str = "720p",
    model: str = DEFAULT_VIDEO_MODEL,
) -> str | None:
    """A short message for the first invalid video request, None when it is valid.

    Pure: looks at the values and the file extensions, never at the disk or the
    network. Gemini video is billed per second once the request is sent, so
    generate_video() and the step call this first and send nothing on a problem.
    """
    if not VIDEO_ON:
        return VIDEO_OFF_MESSAGE
    refs = list(reference_image_paths or [])
    if not prompt or not prompt.strip():
        return "Prompt must not be empty."
    spec = VIDEO_MODELS.get(model)
    if spec is None:
        return f"Unknown Gemini video model {model}. Use {', '.join(VIDEO_MODELS)}."
    if _video_duration(duration) not in VIDEO_DURATIONS:
        return f"Gemini video clips are {VIDEO_DURATIONS[0]} to {VIDEO_DURATIONS[-1]} seconds."
    if aspect_ratio not in VIDEO_ASPECT_RATIOS:
        return "Gemini makes 16:9 or 9:16 video."
    if resolution not in spec["resolutions"]:
        return f"Gemini video is {' or '.join(spec['resolutions'])} only."
    for label, path in (("first frame", image_path), ("last frame", last_frame_path),
                        *(("reference image", r) for r in refs)):
        if path and os.path.splitext(path)[1].lower() not in _VIDEO_IMAGE_MIME_BY_EXT:
            return f"Gemini video takes PNG, JPEG or WebP images; the {label} is {os.path.basename(path)}."
    if last_frame_path and not image_path:
        return "A last frame needs a first frame."
    if refs and image_path:
        return "Use either a first frame or reference images, not both."
    if len(refs) > VIDEO_MAX_REFERENCE_IMAGES:
        return f"Gemini video takes up to {VIDEO_MAX_REFERENCE_IMAGES} reference images."
    if refs and not spec["reference_images"]:
        return f"{model} takes no reference images."
    return None


def video_cost_usd(duration, resolution: str = "720p") -> float | None:
    """Google's price for a clip of `duration` seconds, None when it has none."""
    rate, seconds = VIDEO_PRICE_PER_SECOND_USD.get(resolution), _video_duration(duration)
    return None if rate is None or seconds is None else round(rate * seconds, 2)


def _video_progress(message: str) -> None:
    print(_json.dumps({"progress": message}), file=sys.stderr, flush=True)


def _video_image_part(path: str) -> dict:
    """An input image item (extension already validated), as in the guide's examples."""
    mime = _VIDEO_IMAGE_MIME_BY_EXT[os.path.splitext(path)[1].lower()]
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as e:
        raise ConnectorError(f"Could not read image {path}: {e}") from e
    return {"type": "image", "data": base64.b64encode(data).decode("ascii"), "mime_type": mime}


def _video_body(prompt, image_path, last_frame_path, refs, seconds, aspect_ratio, resolution,
                negative_prompt, model) -> dict:
    """The POST /v1beta/interactions body.

    Text alone is a plain `input` string; with images, `input` is the image
    items then the text, the order of the guide's image-to-video, first and
    last frame, and subject reference examples. Those last two send the same
    shape, and the guide's examples set no task, so only references name one
    (`generation_config.video_config.task`, the guide's tasks parameter).
    """
    text = prompt.strip()
    if negative_prompt and negative_prompt.strip():
        text += f"\n\nAvoid: {negative_prompt.strip()}"
    images = [p for p in (image_path, last_frame_path) if p] or list(refs or [])
    body = {
        "model": model,
        "input": [*(_video_image_part(p) for p in images), {"type": "text", "text": text}] if images else text,
        "response_format": {"type": "video", "aspect_ratio": aspect_ratio, "resolution": resolution,
                            "duration": f"{seconds}s", "delivery": "uri"},
        "background": False, "store": False, "stream": False,
    }
    if refs:
        body["generation_config"] = {"video_config": {"task": "reference_to_video"}}
    return body


def _video_headers(key: str) -> dict:
    return {"x-goog-api-key": key, "Content-Type": "application/json"}


# Google's "generation blocked" codes (ai.google.dev/gemini-api/docs/api-errors, read 2026-10-23).
_VIDEO_BLOCKED_CODES = frozenset({
    "safety", "recitation", "language", "prohibited_content", "spii", "blocklist", "content_blocked",
    "image_safety", "image_prohibited_content", "image_recitation", "image_other",
})
# Said of every failure once Google may have taken the request: billing is on output
# tokens (ai.google.dev/gemini-api/docs/pricing), and no doc says a failed run is free.
_VIDEO_CHARGED = " It may have been charged, so don't regenerate right away."


def _error_code(code) -> str:
    """An error code's last segment, lower case: `errors[].code` may be a URI."""
    return str(code or "").rstrip("/").rsplit("/", 1)[-1].strip().lower()


def _video_safety_text(text: str) -> bool:
    lowered = text.lower()
    return any(w in lowered for w in (
        "safety", "policy", "policies", "guideline", "responsible ai", "prohibited", "sensitive", "blocked",
    ))


def _video_refusal(detail: str) -> ConnectorError:
    message = "Gemini blocked this video on safety grounds. Change the prompt or the images and try again."
    if detail:
        message += f" Google said: {detail}"
    return ConnectorError(message, reason=CONTENT_REFUSED)


def _video_http_error(status: int, text: str, model: str) -> ConnectorError:
    """The ConnectorError for a non-200 answer to the video request.

    Google's error body is {"error": {"code", "message"}}, with the statuses on
    ai.google.dev/gemini-api/docs/api-errors: 401 a bad key, 402 or a 400
    failed_precondition no billing, 429 a quota, 404 model_not_found.
    """
    try:
        err = (_json.loads(text) or {}).get("error") or {}
    except (ValueError, AttributeError):
        err = {}
    raw = str(err.get("message") or text or "")
    code = str(err.get("code") or err.get("status") or "").lower()
    lowered = raw.lower()
    detail = _sanitize_sdk_detail(raw)
    google = f" Google said: {detail}" if detail else ""

    if status == 401 or code in ("authentication", "unauthenticated") or (
            status in (400, 403) and ("api key" in lowered or "api_key" in lowered)):
        e = ConnectorError(f"{INVALID_API_KEY_MESSAGE}{google}", reason="invalid_api_key")
        e.google_detail = detail
        return e
    if status == 429 or "quota" in code or "rate_limit" in code:
        # Google's quota 429 says "check your plan and billing details" even on a
        # paid key; a zero limit or a free-tier metric means no billing at all.
        if re.search(r"limit:\s*0\b", lowered) or "free_tier" in lowered or "free tier" in lowered:
            return ConnectorError(
                "Gemini video needs billing on your Gemini key. Turn it on in Google AI Studio, "
                "then try again." + google, reason=INSUFFICIENT_CREDIT)
        return ConnectorError(
            "Your Gemini video quota was reached. Wait a few minutes and try again, "
            "or raise the limit in Google AI Studio." + google)
    if status == 402 or "payment" in code or "billing" in lowered or "failed_precondition" in code:
        return ConnectorError(
            "Gemini video needs billing on your Gemini key. Turn it on in Google AI Studio, "
            "then try again." + google, reason=INSUFFICIENT_CREDIT)
    if status == 404 or "model_not_found" in code:
        return ConnectorError(f"Gemini video model {model} is not available to your Gemini key." + google,
                              reason=MODEL_RETIRED)
    if _error_code(code) in _VIDEO_BLOCKED_CODES or (status == 400 and _video_safety_text(lowered)):
        return _video_refusal(detail)
    # A 5xx or a timeout status may come after Google took the request.
    charged = _VIDEO_CHARGED if status >= 500 or status in (408, 499) else ""
    return ConnectorError(f"Gemini video request failed (HTTP {status}).{google}{charged}")


def _video_content(body: dict) -> dict | None:
    """The video item of the last model_output step: the SDK's own `output_video`
    walk (google-genai 2.33.0, types/interactions/interaction.py)."""
    for step in reversed(body.get("steps") or []):
        if not isinstance(step, dict):
            continue
        if step.get("type") == "user_input":
            break
        if step.get("type") != "model_output":
            continue
        for item in reversed(step.get("content") or []):
            if isinstance(item, dict) and item.get("type") == "video":
                return item
    return None


# The full form (https://.../v1beta/files/<id>:download?alt=media) or the short one
# ("files/<id>", the guide's own example). Both URLs are built from the id, so the
# key header only ever goes to the Gemini API.
_FILE_ID_RE = re.compile(r"(?:^|/)files/([A-Za-z0-9_-]+)")


def _video_bytes(item: dict, key: str, deadline: float) -> bytes:
    """The clip's bytes: inline data, or the URI once its file is ACTIVE.

    Every failure here comes after Google made the video, so each says it may
    have been charged.
    """
    if item.get("data"):
        try:
            return base64.b64decode(item["data"])
        except (ValueError, TypeError) as e:
            raise ConnectorError(f"Gemini video came back unreadable: {e}.{_VIDEO_CHARGED}") from e
    m = _FILE_ID_RE.search(str(item.get("uri") or ""))
    if not m:
        raise ConnectorError(f"Gemini video finished with no video.{_VIDEO_CHARGED}")
    file_url = f"{VIDEO_API}/files/{m.group(1)}"
    headers = {"x-goog-api-key": key}

    def left() -> float:
        return deadline - time.monotonic()

    waited = 0
    while True:
        if left() <= 0:
            raise ConnectorError(f"Gemini video finished but its file was not ready in time.{_VIDEO_CHARGED}")
        try:
            r = _http.request_with_retry("GET", file_url, headers=headers, timeout=min(30, max(1, left())))
        except ConnectorError as e:
            raise ConnectorError(f"Gemini video finished but its file could not be checked: "
                                 f"{_sanitize_sdk_detail(str(e))}.{_VIDEO_CHARGED}") from e
        state = ""
        if r.status_code == 200:
            try:
                state = str((r.json() or {}).get("state") or "").upper()
            except ValueError:
                state = ""
        if state == "ACTIVE":
            break
        if state == "FAILED":
            raise ConnectorError(f"Gemini video finished but its file failed on Google's side.{_VIDEO_CHARGED}")
        if waited >= VIDEO_FILE_MAX_WAIT_S:
            raise ConnectorError(
                f"Gemini video finished but its file was not ready within {VIDEO_FILE_MAX_WAIT_S}s.{_VIDEO_CHARGED}")
        time.sleep(VIDEO_FILE_POLL_INTERVAL_S)
        waited += VIDEO_FILE_POLL_INTERVAL_S
    download = f"{file_url}:download?alt=media"
    last = "no data came back"
    for attempt in range(VIDEO_DOWNLOAD_ATTEMPTS):
        if left() <= 0:
            last = "out of time"
            break
        try:
            r = _http.request_with_retry("GET", download, headers=headers, attempts=1,
                                         timeout=min(120, max(1, left())))
            if r.status_code == 200 and r.content:
                return r.content
            last = f"HTTP {r.status_code}"
        except ConnectorError as e:
            last = _sanitize_sdk_detail(str(e))
        if attempt < VIDEO_DOWNLOAD_ATTEMPTS - 1:
            time.sleep(VIDEO_DOWNLOAD_RETRY_S)
    raise ConnectorError(f"Gemini video finished but the download failed: {last}.{_VIDEO_CHARGED}")


def generate_video(
    prompt: str,
    out_path: str,
    image_path: str | None = None,
    last_frame_path: str | None = None,
    reference_image_paths: list[str] | None = None,
    duration: int = 8,
    aspect_ratio: str = "9:16",
    resolution: str = "720p",
    negative_prompt: str | None = None,
    model: str = DEFAULT_VIDEO_MODEL,
) -> str:
    """Generate a video with sound via Gemini Omni Flash. Writes an .mp4 and returns out_path.

    Mode follows the inputs: text only, image_path (first frame, with an
    optional last_frame_path), or reference_image_paths (up to 3 subject
    images). Every input is checked by video_request_problem() before any
    network call.

    One request, sent once and never retried: it is billed per second of video,
    and a retry after a request Google already took would pay twice. Every
    failure once it may have been taken (a timeout, a dropped connection, a 5xx,
    a failed or empty answer, a failed download) says the video may have been
    charged. The request, the file checks and the download share one deadline
    (VIDEO_DEADLINE_S) under serve's 900 s kill.
    """
    if not out_path:
        raise ConnectorError("out_path is required")
    refs = list(reference_image_paths or [])
    problem = video_request_problem(
        prompt, image_path=image_path, last_frame_path=last_frame_path,
        reference_image_paths=refs, duration=duration,
        aspect_ratio=aspect_ratio, resolution=resolution, model=model,
    )
    if problem:
        raise ConnectorError(problem)
    seconds = _video_duration(duration)
    key = get_credential("gemini", "api_key")
    body = _video_body(prompt, image_path, last_frame_path, refs, seconds, aspect_ratio, resolution,
                       negative_prompt, model)

    requests = _http._require_requests()
    deadline = time.monotonic() + VIDEO_DEADLINE_S
    cost = video_cost_usd(seconds, resolution)
    _video_progress(f"Gemini video ({model}, {seconds}s, {resolution}) sent"
                    + (f", about ${cost:.2f}" if cost is not None else "")
                    + "; it usually takes a few minutes")
    try:
        r = requests.post(f"{VIDEO_API}/interactions", headers=_video_headers(key), json=body,
                          timeout=(15, VIDEO_REQUEST_TIMEOUT_S))
    except requests.exceptions.ConnectTimeout as e:
        raise ConnectorError(
            f"Gemini video request failed: could not reach the Gemini API: {_sanitize_sdk_detail(str(e))}",
            reason=UNREACHABLE) from e
    except requests.exceptions.RequestException as e:
        detail = _sanitize_sdk_detail(str(e))
        if isinstance(e, requests.exceptions.ConnectionError) and not isinstance(e, requests.exceptions.ReadTimeout) \
                and any(w in str(e) for w in ("NewConnectionError", "NameResolutionError", "Failed to resolve")):
            raise ConnectorError(f"Gemini video request failed: could not reach the Gemini API: {detail}",
                                 reason=UNREACHABLE) from e
        raise ConnectorError(f"Gemini video request failed: {detail}.{_VIDEO_CHARGED}") from e

    if r.status_code != 200:
        raise _video_http_error(r.status_code, r.text, model)
    try:
        answer = r.json()
    except ValueError as e:
        raise ConnectorError(f"Gemini video answered with something that is not JSON.{_VIDEO_CHARGED}") from e
    if not isinstance(answer, dict):
        raise ConnectorError(f"Gemini video answered with no interaction.{_VIDEO_CHARGED}")
    status = str(answer.get("status") or "")
    if status == "failed":
        errors = [e for e in (answer.get("errors") or []) if isinstance(e, dict)]
        detail = _sanitize_sdk_detail("; ".join(str(e.get("message") or e.get("code") or "") for e in errors))
        if any(_error_code(e.get("code")) in _VIDEO_BLOCKED_CODES for e in errors) or _video_safety_text(detail):
            raise _video_refusal(detail)
        raise ConnectorError("Gemini video failed on Google's side."
                             + (f" Google said: {detail}." if detail else "") + _VIDEO_CHARGED)
    item = _video_content(answer)
    if item is None:
        if status and status != "completed":
            raise ConnectorError(f"Gemini video ended as {status} with no video.{_VIDEO_CHARGED}")
        raise ConnectorError(f"Gemini video finished with no video.{_VIDEO_CHARGED}")
    data = _video_bytes(item, key, deadline)

    usage = answer.get("usage") if isinstance(answer.get("usage"), dict) else {}
    tokens = usage.get("total_output_tokens")
    if isinstance(tokens, int) and tokens > 0:
        _video_progress(f"Gemini video done: {tokens} output tokens, about "
                        f"${tokens * _VIDEO_OUTPUT_USD_PER_TOKEN:.2f}")

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(data)
    return out_path
