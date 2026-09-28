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
import os
from connectors import ConnectorError, INSUFFICIENT_CREDIT, UNREACHABLE, _http, classify_http_error
from lib.credentials import get_credential

BASE = "https://api.elevenlabs.io"

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


def _error_from_response(r, error_prefix: str) -> ConnectorError:
    """Build a ConnectorError from a >=400 ElevenLabs response.

    ElevenLabs wraps its error body as {"detail": {...}} (a dict carrying
    "message"/"code"/"status") or occasionally {"detail": "plain string"}.
    A "code": "paid_plan_required" detail — verified on POST /v1/music on a
    free-plan account (Task 0) — always means the same thing regardless of
    which endpoint sent it, so it's checked before the generic classifier
    and gets a fixed operator-facing message rather than the vendor's own
    wording. Every other 4xx/5xx goes through classify_http_error same as
    every other connector.
    """
    try:
        body = r.json()
    except Exception:
        body = None
    detail = body.get("detail") if isinstance(body, dict) else None
    if isinstance(detail, dict):
        if detail.get("code") == "paid_plan_required":
            return ConnectorError("ElevenLabs music needs a paid plan.", reason=INSUFFICIENT_CREDIT)
        message = detail.get("message") or str(detail)
    elif isinstance(detail, str):
        message = detail
    else:
        message = (getattr(r, "text", None) or "")[:500]
    reason = classify_http_error(r.status_code, message)
    return ConnectorError(f"{error_prefix} (HTTP {r.status_code}): {message}", reason=reason)


def _get(path: str, *, error_prefix: str, timeout: int = 15):
    """GET {BASE}{path} with the shared retry helper, raising ConnectorError
    (reason=UNREACHABLE on a transport failure, else via _error_from_response)
    on any non-2xx outcome."""
    try:
        r = _http.request_with_retry("GET", f"{BASE}{path}", headers=_headers(), timeout=timeout)
    except ConnectorError as e:
        raise ConnectorError(str(e), reason=UNREACHABLE) from e
    if r.status_code >= 400:
        raise _error_from_response(r, error_prefix)
    return r


def _post_audio(path: str, body: dict, out_path: str, error_prefix: str) -> str:
    """POST {BASE}{path} and write the audio/mpeg response body to out_path.

    Generation here is synchronous — the audio comes back in this same
    response, so a timed-out/ambiguous POST may already be billed. Retry
    only on 429 (the request was rejected before generation ran), never on
    a network exception or 5xx — mirrors kling.generate_speech, the other
    synchronous billed-audio call in this codebase.
    """
    try:
        r = _http.request_with_retry(
            "POST", f"{BASE}{path}", json=body,
            headers={**_headers(), "Accept": "audio/mpeg"}, timeout=120,
            retry_statuses=frozenset({429}), retry_exceptions=False,
        )
    except ConnectorError as e:
        raise ConnectorError(str(e), reason=UNREACHABLE) from e
    if r.status_code >= 400:
        raise _error_from_response(r, error_prefix)
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
    (audio/mpeg) to out_path. Raises ConnectorError on empty text/out_path,
    an unresolvable voice, or a failed request."""
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
    (audio/mpeg) to out_path.

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
    (audio/mpeg) to out_path.

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

    Raises ConnectorError with reason invalid_api_key / insufficient_credit /
    None from classify_http_error on a 4xx/5xx response, or
    reason=UNREACHABLE for a transport failure.
    """
    user_resp = _get("/v1/user", error_prefix="ElevenLabs key check failed")
    tier = (user_resp.json().get("subscription") or {}).get("tier")

    models_resp = _get("/v1/models", error_prefix="ElevenLabs key check failed")
    model_ids = {m.get("model_id") for m in models_resp.json()}

    return {
        "ok": True,
        "default_model": DEFAULT_TTS_MODEL,
        "default_model_ok": DEFAULT_TTS_MODEL in model_ids,
        "music": tier != "free",
        "detail": f"{len(model_ids)} models available to this key; plan tier {tier!r}",
    }
