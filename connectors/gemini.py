"""Google Gemini connector (google-genai SDK).

One vendor, one API key, one SDK. Exposes one function per use case today;
add more here (chat, etc.) rather than creating new files per use case.
See docs/CONNECTORS.md for the layering rule.

Current functions:
    analyze_video(path, prompt, model, json_output) -> str
    generate_image(prompt, out_path, ref_images, size, model, aspect_ratio) -> str

Library code — raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import os, time
from connectors import ConnectorError
from lib.credentials import get_credential

DEFAULT_MODEL = "gemini-2.5-flash"
DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview"
UPLOAD_POLL_INTERVAL_S = 1.0
UPLOAD_MAX_WAIT_S = 300.0


def _client():
    """Lazily create a google-genai Client."""
    try:
        from google import genai
    except ImportError:
        raise ConnectorError(
            "Missing connector dependencies. Run: montaj install connectors"
        )
    return genai.Client(api_key=get_credential("gemini", "api_key"))


def upload_video(path: str):
    """Upload video via Files API, poll until ACTIVE. Returns file object."""
    client = _client()
    try:
        video_file = client.files.upload(file=path)
    except Exception as e:
        raise ConnectorError(f"Gemini file upload failed: {e}") from e

    elapsed = 0.0
    while elapsed < UPLOAD_MAX_WAIT_S:
        try:
            video_file = client.files.get(name=video_file.name)
        except Exception as e:
            raise ConnectorError(f"Gemini file status check failed: {e}") from e
        if video_file.state.name == "ACTIVE":
            return video_file
        if video_file.state.name == "FAILED":
            raise ConnectorError(f"Gemini file processing failed for {video_file.name}")
        time.sleep(UPLOAD_POLL_INTERVAL_S)
        elapsed += UPLOAD_POLL_INTERVAL_S

    raise ConnectorError(
        f"Gemini file {video_file.name} did not become ACTIVE within {UPLOAD_MAX_WAIT_S}s"
    )


def analyze_video(
    path: str,
    prompt: str,
    model: str = DEFAULT_MODEL,
    json_output: bool = False,
) -> str:
    """Upload video, generate content, return response text.

    Deletes uploaded file afterward (best-effort).
    """
    if not prompt or not prompt.strip():
        raise ConnectorError("Prompt must not be empty")

    client = _client()
    video_file = upload_video(path)

    config = {}
    if json_output:
        config["response_mime_type"] = "application/json"

    try:
        from google.genai import types
        config_obj = types.GenerateContentConfig(**config) if config else None
        response = client.models.generate_content(
            model=model,
            contents=[video_file, prompt],
            config=config_obj,
        )
    except ConnectorError:
        raise
    except Exception as e:
        raise ConnectorError(f"Gemini generate_content failed: {e}") from e
    finally:
        # Best-effort cleanup
        try:
            client.files.delete(name=video_file.name)
        except Exception:
            pass

    return response.text


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
        raise ConnectorError(f"Gemini image generation failed: {e}") from e

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
