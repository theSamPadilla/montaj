"""OpenAI connector (openai SDK).

One vendor, one API key, one SDK. Exposes one function per use case today;
add more here (chat, transcription, etc.) rather than creating new files per
use case. See docs/CONNECTORS.md for the layering rule.

Current functions:
    generate_image(prompt, out_path, ref_images, size, model) -> str

Library code — raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import base64, os
from connectors import ConnectorError
from lib.credentials import get_credential

DEFAULT_IMAGE_MODEL = "gpt-image-1"


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
        raise ConnectorError(f"OpenAI image generation failed: {e}") from e

    # gpt-image-1 only supports b64_json; DALL-E models may return url.
    if not getattr(resp, "data", None):
        raise ConnectorError("OpenAI returned no image data")
    item = resp.data[0]

    b64 = getattr(item, "b64_json", None)
    if b64:
        img_bytes = base64.b64decode(b64)
    else:
        url = getattr(item, "url", None)
        if not url:
            raise ConnectorError("OpenAI response has neither b64_json nor url")
        try:
            import requests
        except ImportError:
            raise ConnectorError("Missing connector dependencies. Run: montaj install connectors")
        try:
            r = requests.get(url, timeout=60)
            r.raise_for_status()
            img_bytes = r.content
        except requests.RequestException as e:
            raise ConnectorError(f"Failed to download OpenAI image: {e}") from e

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(img_bytes)
    return out_path
