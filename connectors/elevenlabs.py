"""ElevenLabs connector (HTTP; speech, sound effects and music — PV29).

One vendor, one API key (header xi-api-key), direct HTTP via `_http`. See
docs/CONNECTORS.md for the layering rule.

Current functions:
    generate_speech(text, voice, out_path, model) -> str
        POST /v1/text-to-speech/{voice_id}. `voice` may be a raw voice_id or
        a premade voice name, resolved via GET /v1/voices.
    generate_sfx(text, out_path, duration_seconds, model) -> str
        POST /v1/sound-generation.
    generate_music(prompt, out_path, length_ms, model) -> str
        POST /v1/music. Free-plan accounts get a plan-gated 402, raised as
        ConnectorError(reason=INSUFFICIENT_CREDIT).
    check_key() -> dict
        Two free calls (GET /v1/user, GET /v1/models) to validate a key,
        confirm DEFAULT_TTS_MODEL is still available, and report whether the
        account's plan includes music. No billed call.

Library code — raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import os, time
from connectors import (
    ConnectorError, INSUFFICIENT_CREDIT, INVALID_API_KEY, UNREACHABLE,
    _http, classify_http_error, retarget_extension,
)
from lib.credentials import get_credential

BASE = "https://api.elevenlabs.io"

OUT_OF_CREDIT_MESSAGE = "Your ElevenLabs account is out of credits."

# ElevenLabs puts the real meaning of a 401 in detail.status, not just the
# HTTP code (verified live, PV29 follow-up 2026-09-28):
#   - "quota_exceeded"    -> out of characters/credits, not a bad key.
#   - "missing_permissions" / "detected_unusual_activity" -> the key
#     authenticated fine; the call itself was refused. Not a bad key either.
#   - "invalid_api_key", or any status this connector doesn't recognise ->
#     the only cases classified as a bad key.
_NO_REASON_401_STATUSES = frozenset({"missing_permissions", "detected_unusual_activity"})

# Only these 429 statuses are worth waiting out; anything else (including an
# unparseable body) is raised without a retry — a wrongly retried billing
# error is worse than a wrongly abandoned rate limit.
_RATE_LIMIT_STATUSES = frozenset({"too_many_concurrent_requests", "system_busy"})

# eleven_v3 is ElevenLabs' best current expressive TTS model (GA) — verified
# live 2026-09-28 (PV29 Task 0). eleven_multilingual_v2 is the documented
# fallback for a line that needs no prompt-tag direction; re-check against
# GET /v1/models before ever changing this.
DEFAULT_TTS_MODEL = "eleven_v3"
DEFAULT_SFX_MODEL = "eleven_text_to_sound_v2"
# POST /v1/music takes no model_id — the verified call (Task 0, 2026-09-28)
# sent none. None here means generate_music's request body omits model_id
# unless a caller explicitly passes one.
DEFAULT_MUSIC_MODEL = None

MIN_SFX_DURATION_S = 0.5
MAX_SFX_DURATION_S = 30.0
MIN_MUSIC_LENGTH_MS = 3000  # POST /v1/music 422s below this (verified Task 0).


def _headers() -> dict:
    return {"xi-api-key": get_credential("elevenlabs", "api_key")}


def _parse(r) -> dict | None:
    """The response body as a JSON object, or None when it isn't one."""
    try:
        body = r.json()
    except Exception:
        return None
    return body if isinstance(body, dict) else None


def _detail(r):
    """The `detail` field of a parsed error body: a dict, a string, or None."""
    body = _parse(r)
    return body.get("detail") if isinstance(body, dict) else None


def _status_of(r) -> str | None:
    """detail.status when `detail` is an object, else None (unparseable body,
    or `detail` is a plain string). This is where ElevenLabs puts the real
    meaning of a 401 or a 429 — see the module-level comments above."""
    detail = _detail(r)
    return detail.get("status") if isinstance(detail, dict) else None


def _message_of(r) -> str:
    """Best-effort vendor-facing message from a >=400 response."""
    detail = _detail(r)
    if isinstance(detail, dict):
        return detail.get("message") or str(detail)
    if isinstance(detail, str):
        return detail
    return (getattr(r, "text", None) or "")[:500]


def _error_from_response(r, error_prefix: str) -> ConnectorError:
    """Build a ConnectorError from a >=400 ElevenLabs response.

    A "code": "paid_plan_required" detail — verified on POST /v1/music on a
    free-plan account (Task 0) — always means the same thing regardless of
    which endpoint sent it, so it's checked first and gets a fixed
    operator-facing message rather than the vendor's own wording.

    A 401 is then classified by detail.status, not the blanket "401 always
    means a bad key" rule classify_http_error uses for other vendors:
    "quota_exceeded" is INSUFFICIENT_CREDIT (never retried — billing, not
    auth); "missing_permissions" / "detected_unusual_activity" mean the key
    authenticated fine and the call itself was refused, so reason is None
    (a plain api_error), never INVALID_API_KEY; "invalid_api_key", or any
    status this connector doesn't recognise, is the only case classified as
    a bad key.

    Every other 4xx/5xx goes through classify_http_error same as every
    other connector.
    """
    detail = _detail(r)
    if isinstance(detail, dict) and detail.get("code") == "paid_plan_required":
        return ConnectorError("ElevenLabs music needs a paid plan.", reason=INSUFFICIENT_CREDIT)

    message = _message_of(r)

    if r.status_code == 401:
        status = _status_of(r)
        if status == "quota_exceeded":
            return ConnectorError(
                f'{OUT_OF_CREDIT_MESSAGE} ElevenLabs says: "{message}"', reason=INSUFFICIENT_CREDIT
            )
        if status in _NO_REASON_401_STATUSES:
            return ConnectorError(f"{error_prefix} (HTTP 401): {message}", reason=None)
        # "invalid_api_key", or any other/unrecognised status, is a bad key.
        return ConnectorError(f"{error_prefix} (HTTP 401): {message}", reason=INVALID_API_KEY)

    reason = classify_http_error(r.status_code, message)
    return ConnectorError(f"{error_prefix} (HTTP {r.status_code}): {message}", reason=reason)


def _is_rate_limit(r) -> bool:
    """Whether a 429 is a rate limit worth waiting out. Any other 429 (a
    billing/abuse signal, or a body that doesn't parse) is not retried:
    wrongly retrying a billing error is worse than wrongly abandoning a
    rate limit."""
    return _status_of(r) in _RATE_LIMIT_STATUSES


def _request(method: str, url: str, *, retry_statuses: frozenset = frozenset(), **kwargs):
    """_http.request_with_retry, but a 429 retries only if _is_rate_limit —
    mirrors connectors/kling.py's _request/_is_rate_limit."""
    for attempt in range(_http.RETRY_ATTEMPTS):
        r = _http.request_with_retry(method, url, retry_statuses=retry_statuses - {429}, **kwargs)
        if r.status_code != 429 or attempt == _http.RETRY_ATTEMPTS - 1 or not _is_rate_limit(r):
            return r
        time.sleep(_http.RETRY_BACKOFF_S * (2 ** attempt))


# Sentinel: the key authenticated but this specific call was refused for
# lacking a scope (401, detail.status == "missing_permissions"). Only
# check_key treats this leniently — see _get_or_restricted.
_RESTRICTED = object()


def _get(path: str, *, error_prefix: str, timeout: int = 15):
    """GET {BASE}{path}, raising ConnectorError (reason=UNREACHABLE on a
    transport failure, else via _error_from_response) on any non-2xx
    outcome. A 429 retries only when the body says it's a rate limit."""
    try:
        r = _request("GET", f"{BASE}{path}", retry_statuses=_http.TRANSIENT_STATUS,
                      headers=_headers(), timeout=timeout)
    except ConnectorError as e:
        raise ConnectorError(str(e), reason=UNREACHABLE) from e
    if r.status_code >= 400:
        raise _error_from_response(r, error_prefix)
    return r


def _get_or_restricted(path: str, *, error_prefix: str, timeout: int = 15):
    """Like _get, but a 401/missing_permissions becomes the _RESTRICTED
    sentinel instead of raising. check_key uses this: a key that
    authenticates fine but was created with restricted scopes must never be
    refused at save — it just can't report everything."""
    try:
        r = _request("GET", f"{BASE}{path}", retry_statuses=_http.TRANSIENT_STATUS,
                      headers=_headers(), timeout=timeout)
    except ConnectorError as e:
        raise ConnectorError(str(e), reason=UNREACHABLE) from e
    if r.status_code == 401 and _status_of(r) == "missing_permissions":
        return _RESTRICTED
    if r.status_code >= 400:
        raise _error_from_response(r, error_prefix)
    return r


def _post_audio(path: str, body: dict, out_path: str, error_prefix: str) -> str:
    """POST {BASE}{path} and write the audio/mpeg response body to out_path.

    Generation here is synchronous — the audio comes back in this same
    response, so a timed-out/ambiguous POST may already be billed. Retry
    only on a rate-limit-classified 429 (the request was rejected before
    generation ran), never on a network exception, a 5xx, or a billing/abuse
    429 — mirrors kling.generate_speech, the other synchronous billed-audio
    call in this codebase.

    ElevenLabs always returns MP3 bytes here, regardless of what out_path
    asked for (a caller passing `--out bed.wav` used to get an MP3 named
    .wav) — out_path is retargeted to `.mp3` before writing, same rule as
    Gemini's TTS/Lyria output (connectors.retarget_extension). Returns the
    path actually written, which may differ from out_path by extension.
    """
    try:
        r = _request(
            "POST", f"{BASE}{path}", json=body,
            headers={**_headers(), "Accept": "audio/mpeg"}, timeout=120,
            retry_exceptions=False,
        )
    except ConnectorError as e:
        raise ConnectorError(str(e), reason=UNREACHABLE) from e
    if r.status_code >= 400:
        raise _error_from_response(r, error_prefix)
    out_path = retarget_extension(out_path, ".mp3")
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(r.content)
    return out_path


def _resolve_voice(voice: str) -> str:
    """Resolve `voice` to an ElevenLabs voice_id via GET /v1/voices.

    `voice` may already be a voice_id — checked against the real list and
    passed through unchanged — or a voice name, matched case-insensitively
    against the part of the voice's display name before " - " (e.g. "george"
    matches "George - Warm, Captivating Storyteller"). An unknown value
    raises with the list of available names.
    """
    resp = _get("/v1/voices", error_prefix="ElevenLabs voice lookup failed")
    voices = resp.json().get("voices") or []

    ids = {v.get("voice_id") for v in voices}
    if voice in ids:
        return voice

    by_name = {}
    for v in voices:
        name = v.get("name") or ""
        key = name.split(" - ", 1)[0].strip().lower()
        if key:
            by_name[key] = v.get("voice_id")

    resolved = by_name.get(voice.strip().lower())
    if resolved:
        return resolved

    available = ", ".join(sorted(by_name))
    raise ConnectorError(f"Unknown ElevenLabs voice {voice!r}. Available: {available}")


def generate_speech(
    text: str,
    voice: str,
    out_path: str,
    model: str = DEFAULT_TTS_MODEL,
) -> str:
    """Generate speech audio via ElevenLabs TTS. Writes the response bytes
    (audio/mpeg) to out_path, retargeted to a `.mp3` extension — use the
    return value, not out_path, since they may differ. Raises ConnectorError
    on empty text/out_path, an unresolvable voice, or a failed request."""
    if not text or not text.strip():
        raise ConnectorError("text must not be empty")
    if not out_path:
        raise ConnectorError("out_path is required")

    voice_id = _resolve_voice(voice)
    body = {"text": text, "model_id": model}
    return _post_audio(
        f"/v1/text-to-speech/{voice_id}", body, out_path,
        error_prefix="ElevenLabs speech generation failed",
    )


def generate_sfx(
    text: str,
    out_path: str,
    duration_seconds: float | None = None,
    model: str = DEFAULT_SFX_MODEL,
) -> str:
    """Generate a sound effect via ElevenLabs. Writes the response bytes
    (audio/mpeg) to out_path, retargeted to a `.mp3` extension — use the
    return value, not out_path, since they may differ.

    duration_seconds, if given, must be within [MIN_SFX_DURATION_S,
    MAX_SFX_DURATION_S] — validated before any HTTP call.
    """
    if not text or not text.strip():
        raise ConnectorError("text must not be empty")
    if not out_path:
        raise ConnectorError("out_path is required")
    if duration_seconds is not None and not (MIN_SFX_DURATION_S <= duration_seconds <= MAX_SFX_DURATION_S):
        raise ConnectorError(
            f"duration_seconds must be between {MIN_SFX_DURATION_S} and "
            f"{MAX_SFX_DURATION_S}, got {duration_seconds}"
        )

    body = {"text": text, "model_id": model}
    if duration_seconds is not None:
        body["duration_seconds"] = duration_seconds
    return _post_audio(
        "/v1/sound-generation", body, out_path,
        error_prefix="ElevenLabs sound effect generation failed",
    )


def generate_music(
    prompt: str,
    out_path: str,
    length_ms: int,
    model: str = DEFAULT_MUSIC_MODEL,
) -> str:
    """Generate a music clip via ElevenLabs. Writes the response bytes
    (audio/mpeg) to out_path, retargeted to a `.mp3` extension — use the
    return value, not out_path, since they may differ.

    length_ms must be at least MIN_MUSIC_LENGTH_MS — validated before any
    HTTP call. `model` is normally left unset: the verified /v1/music call
    (Task 0) sent no model_id at all, so one is only added to the request
    body when a caller explicitly passes one.

    A plan-gated response (an account without the music entitlement) raises
    ConnectorError("ElevenLabs music needs a paid plan.",
    reason=INSUFFICIENT_CREDIT) — see _error_from_response.
    """
    if not prompt or not prompt.strip():
        raise ConnectorError("prompt must not be empty")
    if not out_path:
        raise ConnectorError("out_path is required")
    if length_ms < MIN_MUSIC_LENGTH_MS:
        raise ConnectorError(f"length_ms must be at least {MIN_MUSIC_LENGTH_MS}, got {length_ms}")

    body = {"prompt": prompt, "music_length_ms": length_ms}
    if model:
        body["model_id"] = model
    return _post_audio(
        "/v1/music", body, out_path,
        error_prefix="ElevenLabs music generation failed",
    )


def check_key() -> dict:
    """Validate the stored/overlaid ElevenLabs key with two free calls:
    GET /v1/user (subscription tier, for the music entitlement) and
    GET /v1/models (confirms DEFAULT_TTS_MODEL is still available). No
    billed call.

    default_model_ok is True when DEFAULT_TTS_MODEL is among the models this
    key can see, which is how a retirement shows up before any real
    generation step ever runs against it. music is True unless the account's
    subscription tier is "free" (POST /v1/music 402s with
    code=paid_plan_required on that tier — verified Task 0).

    A key that authenticates but was created with restricted scopes (401,
    detail.status == "missing_permissions" on either call) is never refused
    here — see _get_or_restricted. Instead:
    - /v1/user restricted: music is None (unknown, can't read the plan) and
      `detail` says so.
    - /v1/models restricted too: default_model_ok is True (can't disprove
      it) and default_model_verified is False, with a note appended to
      `detail`. A working restricted key must never be refused at save.

    Raises ConnectorError with reason invalid_api_key / insufficient_credit /
    None from classify_http_error on any other 4xx/5xx response, or
    reason=UNREACHABLE for a transport failure.
    """
    user_resp = _get_or_restricted("/v1/user", error_prefix="ElevenLabs key check failed")
    user_restricted = user_resp is _RESTRICTED
    if user_restricted:
        tier = None
        music = None
    else:
        tier = (user_resp.json().get("subscription") or {}).get("tier")
        music = tier != "free"

    models_resp = _get_or_restricted("/v1/models", error_prefix="ElevenLabs key check failed")
    models_restricted = models_resp is _RESTRICTED
    if models_restricted:
        default_model_ok = True
    else:
        model_ids = {m.get("model_id") for m in models_resp.json()}
        default_model_ok = DEFAULT_TTS_MODEL in model_ids

    result = {
        "ok": True,
        "default_model": DEFAULT_TTS_MODEL,
        "default_model_ok": default_model_ok,
        "music": music,
    }
    if models_restricted:
        result["default_model_verified"] = False

    if user_restricted:
        detail = "Key works but can't read the account plan (missing user_read permission)"
        if models_restricted:
            detail += ("; could not verify the default model is still available "
                       "(missing permission to list models)")
    elif models_restricted:
        detail = (f"plan tier {tier!r}; could not verify the default model is still available "
                  "(missing permission to list models)")
    else:
        detail = f"{len(model_ids)} models available to this key; plan tier {tier!r}"
    result["detail"] = detail

    return result
