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

Private helpers:
    _generate_audio(model, contents, config, out_path, ...) -> str
        Shared audio-modality generation: SDK call → response extraction → disk write.
        Used by generate_speech and generate_music.

Library code — raises ConnectorError, never calls fail() or sys.exit.
Step scripts catch ConnectorError and translate to fail().
"""
import os, re, time, wave
from connectors import ConnectorError
from lib.credentials import get_credential

DEFAULT_MODEL = "gemini-2.5-flash"
DEFAULT_IMAGE_MODEL = "gemini-3-pro-image-preview"
UPLOAD_POLL_INTERVAL_S = 1.0
UPLOAD_MAX_WAIT_S = 300.0

# Gemini's inline-data request cap is ~20 MB total payload. Use a conservative
# ceiling that leaves room for the prompt text + JSON overhead. Images above
# this go through the Files API.
INLINE_BYTE_LIMIT = 18 * 1024 * 1024  # 18 MB

DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts"
DEFAULT_TTS_VOICE = "Kore"  # default for generate_speech when caller omits voice
DEFAULT_MUSIC_MODEL = "lyria-3-clip-preview"

_IMAGE_MIME_BY_EXT = {
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".gif":  "image/gif",
}


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


def upload_media(path: str):
    """Upload a media file (video, audio, or image) via Files API, poll until ACTIVE. Returns file object."""
    client = _client()
    try:
        media_file = client.files.upload(file=path)
    except Exception as e:
        raise ConnectorError(f"Gemini file upload failed: {e}") from e

    elapsed = 0.0
    while elapsed < UPLOAD_MAX_WAIT_S:
        try:
            media_file = client.files.get(name=media_file.name)
        except Exception as e:
            raise ConnectorError(f"Gemini file status check failed: {e}") from e
        if media_file.state.name == "ACTIVE":
            return media_file
        if media_file.state.name == "FAILED":
            raise ConnectorError(f"Gemini file processing failed for {media_file.name}")
        time.sleep(UPLOAD_POLL_INTERVAL_S)
        elapsed += UPLOAD_POLL_INTERVAL_S

    raise ConnectorError(
        f"Gemini file {media_file.name} did not become ACTIVE within {UPLOAD_MAX_WAIT_S}s"
    )


def analyze_media(
    path: str,
    prompt: str,
    model: str = DEFAULT_MODEL,
    json_output: bool = False,
) -> str:
    """Analyze a media file (video, audio, or image) with Gemini.

    Branching:
    - Images under INLINE_BYTE_LIMIT: inline bytes in generate_content, no
      Files API upload. Faster and no server-side file cleanup needed.
    - Everything else: Files API (upload_media) + generate_content +
      best-effort delete.
    """
    if not prompt or not prompt.strip():
        raise ConnectorError("Prompt must not be empty")

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
            raise ConnectorError(f"Gemini generate_content failed: {e}") from e
        text = response.text
        return _strip_markdown_fences(text) if json_output else text

    # Files API path for video, audio, and oversized images.
    media_file = upload_media(path)
    try:
        response = client.models.generate_content(
            model=model,
            contents=[media_file, prompt],
            config=config_obj,
        )
    except ConnectorError:
        raise
    except Exception as e:
        raise ConnectorError(f"Gemini generate_content failed: {e}") from e
    finally:
        # Best-effort cleanup
        try:
            client.files.delete(name=media_file.name)
        except Exception:
            pass

    text = response.text
    return _strip_markdown_fences(text) if json_output else text


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
        raise ConnectorError(f"{error_prefix} request failed: {e}") from e

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

    if mime_type and ("wav" in mime_type or "mp3" in mime_type or "mpeg" in mime_type):
        with open(out_path, "wb") as f:
            f.write(audio_bytes)
    else:
        # Raw PCM — wrap in WAV header at the caller-specified rate/channels.
        # If mime_type is None or unrecognised, this may produce corrupt output.
        import sys as _sys
        print(f'{{"warn": "{error_prefix}: assuming raw PCM (mime_type={mime_type!r})"}}', file=_sys.stderr)
        with wave.open(out_path, "wb") as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(sample_rate)
            wf.writeframes(audio_bytes)

    return out_path


def generate_speech(
    text: str,
    voice: str = DEFAULT_TTS_VOICE,
    out_path: str = None,
    model: str = DEFAULT_TTS_MODEL,
) -> str:
    """Generate speech audio from text via Gemini TTS (single-speaker).

    Writes a WAV file at out_path. Returns out_path on success.
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
    out_path     — local file path for the downloaded audio (wav or mp3 per docs).
    instrumental — if True, ask Lyria to produce instrumental-only output
                   (suitable for background music under narration).
    model        — Lyria model variant. Default: lyria-3-clip-preview (30s clips).
    seed         — optional RNG seed for reproducible outputs.

    Returns out_path on success. Raises ConnectorError on failure.
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
