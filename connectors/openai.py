"""OpenAI connector (openai SDK).

One vendor, one API key, one SDK. Exposes one function per use case today;
add more here (chat, transcription, etc.) rather than creating new files per
use case. See docs/CONNECTORS.md for the layering rule.

Current functions:
    generate_image(prompt, out_path, ref_images, size, model) -> str
    check_key() -> dict
        One free call (GET /v1/models) to validate a key and confirm
        DEFAULT_IMAGE_MODEL is still available, with no billed call.

Library code — raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import base64, os
from connectors import ConnectorError, _http, classify_http_error, UNREACHABLE
from lib.credentials import get_credential

# PV29 T4b, controller decision (2026-09-28, operator): taken from vendor
# docs (developers.openai.com/api/docs/models), not verified by a live call
# — the stored key returns 401 and the operator chose not to chase a working
# one for this. gpt-image-2.5-sunburst (snapshot
# gpt-image-2.5-sunburst-2026-09-08) is GA there: "our most capable model
# for image generation and editing," serving both v1/images/generations and
# v1/images/edits — this connector's generate_image() uses both (images.generate
# / images.edit below). Its quality enum (low/medium/high/xhigh/max/auto) and
# size enum are a superset of what this connector ever sends: only `size`
# goes on the wire, never `quality`, so the vendor default `auto` applies —
# no request-shape change needed for this default.
# Old default, not deprecated ("previous-generation," still served), kept as
# a documented fallback via --model:
#   gpt-image-1
DEFAULT_IMAGE_MODEL = "gpt-image-2.5-sunburst"


def _client():
    """Lazily create an OpenAI Client."""
    try:
        import openai
    except ImportError:
        raise ConnectorError(
            "Missing connector dependencies. Run: montaj install connectors"
        )
    return openai.OpenAI(api_key=get_credential("openai", "api_key"))


def generate_image(
    prompt: str,
    out_path: str,
    ref_images: list[str] | None = None,
    size: str = "1024x1024",
    model: str = DEFAULT_IMAGE_MODEL,
) -> str:
    """Generate an image via OpenAI. Returns local path to saved PNG.

    - ref_images: if present, uses images.edit; otherwise images.generate.
    - size: one of the sizes supported by the model.
    - Raises ConnectorError on SDK failure or missing response data.
    """
    if not prompt or not prompt.strip():
        raise ConnectorError("Prompt must not be empty")

    client = _client()

    try:
        if ref_images:
            # Open reference files for the edit endpoint.
            file_handles = []
            try:
                for ref_path in ref_images:
                    try:
                        file_handles.append(open(ref_path, "rb"))
                    except OSError as e:
                        raise ConnectorError(
                            f"Could not read reference image {ref_path}: {e}"
                        ) from e
                resp = client.images.edit(
                    model=model,
                    image=file_handles if len(file_handles) > 1 else file_handles[0],
                    prompt=prompt,
                    size=size,
                )
            finally:
                for fh in file_handles:
                    try:
                        fh.close()
                    except Exception:
                        pass
        else:
            resp = client.images.generate(
                model=model,
                prompt=prompt,
                size=size,
            )
    except ConnectorError:
        raise
    except Exception as e:
        # _client() already succeeded, so the openai SDK is importable here —
        # this is not a fresh dependency check, just a name lookup for isinstance.
        import openai
        if isinstance(e, openai.APIStatusError):
            reason = classify_http_error(e.status_code, e.message)
            raise ConnectorError(f"OpenAI image generation failed: {e.message}", reason=reason) from e
        if isinstance(e, openai.APIConnectionError):
            raise ConnectorError(f"OpenAI image generation failed: {e}", reason=UNREACHABLE) from e
        raise ConnectorError(f"OpenAI image generation failed: {e}") from e

    # gpt-image-1 only supports b64_json; DALL-E models may return url.
    if not getattr(resp, "data", None):
        raise ConnectorError("OpenAI returned no image data")
    item = resp.data[0]

    b64 = getattr(item, "b64_json", None)
    if b64:
        img_bytes = base64.b64decode(b64)
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(img_bytes)
        return out_path

    url = getattr(item, "url", None)
    if not url:
        raise ConnectorError("OpenAI response has neither b64_json nor url")
    return _http.download_file(url, out_path, timeout=60)


def _error_message(resp) -> str:
    """Best-effort extraction of the vendor's error text from a failed OpenAI
    HTTP response (``{"error": {"message": ...}}``), else the raw body."""
    try:
        body = resp.json()
    except Exception:
        return resp.text or ""
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and err.get("message"):
            return err["message"]
    return resp.text or ""


def check_key() -> dict:
    """Validate the stored/overlaid OpenAI key with one free call: GET
    /v1/models. No billed call — listing models costs nothing.

    default_model_ok is True when DEFAULT_IMAGE_MODEL is among the models
    this key can see, which is how a retirement shows up before any real
    generation step ever runs against it.

    Raises ConnectorError with reason invalid_api_key / insufficient_credit /
    None from classify_http_error on a 4xx/5xx response, or reason=UNREACHABLE
    for an actual connection failure or timeout — the only case
    _http.request_with_retry raises rather than returning a response, since
    every HTTP status (including 4xx/5xx) comes back as a response object.
    """
    api_key = get_credential("openai", "api_key")
    try:
        resp = _http.request_with_retry(
            "GET", "https://api.openai.com/v1/models",
            headers={"Authorization": f"Bearer {api_key}"}, timeout=15,
        )
    except ConnectorError as e:
        raise ConnectorError(str(e), reason=UNREACHABLE) from e

    if resp.status_code >= 400:
        message = _error_message(resp)
        reason = classify_http_error(resp.status_code, message)
        raise ConnectorError(
            f"OpenAI key check failed (HTTP {resp.status_code}): {message}", reason=reason
        )

    data = resp.json()
    model_ids = {m.get("id") for m in data.get("data", [])}
    return {
        "ok": True,
        "default_model": DEFAULT_IMAGE_MODEL,
        "default_model_ok": DEFAULT_IMAGE_MODEL in model_ids,
        "detail": f"{len(model_ids)} models available to this key",
    }
