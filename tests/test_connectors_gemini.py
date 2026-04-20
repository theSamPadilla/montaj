"""Tests for connectors.gemini — Gemini media analysis and image generation."""
import os, types as stdlib_types
from unittest.mock import MagicMock, patch

import pytest

from connectors import ConnectorError


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def video_path(tmp_path):
    """A fake video file. Extension is .mp4 so analyze_media takes the Files API path."""
    p = tmp_path / "video.mp4"
    p.write_bytes(b"\x00" * 1024)  # non-zero size to pass require_file-style checks
    return str(p)


@pytest.fixture
def image_path(tmp_path):
    """A fake image file. Extension is .png so analyze_media takes the inline path."""
    p = tmp_path / "image.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 1024)  # PNG magic + filler
    return str(p)


@pytest.fixture
def huge_image_path(tmp_path, monkeypatch):
    """An image file larger than INLINE_BYTE_LIMIT, forcing the Files API path.

    We patch INLINE_BYTE_LIMIT down to a tiny value rather than actually writing
    a 20 MB file — much faster and equivalent for the branch condition.
    """
    import connectors.gemini as mod
    monkeypatch.setattr(mod, "INLINE_BYTE_LIMIT", 100)
    p = tmp_path / "huge.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 1024)  # 1032 bytes > 100
    return str(p)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_file(name="files/abc123", state_name="ACTIVE"):
    """Return a mock file object with .name and .state.name."""
    f = MagicMock()
    f.name = name
    f.state = MagicMock()
    f.state.name = state_name
    return f


def _make_mock_client(
    upload_file=None,
    get_states=None,
    generate_response_text="result text",
    upload_side_effect=None,
    generate_side_effect=None,
    delete_side_effect=None,
):
    """Build a mock genai Client.

    Parameters
    ----------
    upload_file : mock file returned by files.upload (default: ACTIVE file)
    get_states : list of state names for successive files.get calls
    generate_response_text : text for the response object
    upload_side_effect : exception to raise on files.upload
    generate_side_effect : exception to raise on models.generate_content
    delete_side_effect : exception to raise on files.delete
    """
    client = MagicMock()

    if upload_side_effect:
        client.files.upload.side_effect = upload_side_effect
    else:
        if upload_file is None:
            upload_file = _make_file(state_name="ACTIVE")
        client.files.upload.return_value = upload_file

    if get_states:
        client.files.get.side_effect = [
            _make_file(state_name=s) for s in get_states
        ]
    else:
        client.files.get.return_value = _make_file(state_name="ACTIVE")

    if generate_side_effect:
        client.models.generate_content.side_effect = generate_side_effect
    else:
        resp = MagicMock()
        resp.text = generate_response_text
        client.models.generate_content.return_value = resp

    if delete_side_effect:
        client.files.delete.side_effect = delete_side_effect

    return client


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestAnalyzeMediaJsonOutput:
    """json_output flag controls response_mime_type in config."""

    def test_json_output_true_passes_response_mime_type(self, monkeypatch, video_path):
        client = _make_mock_client()
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        # We need to mock the google.genai.types import inside analyze_media
        fake_types = MagicMock()
        fake_config_obj = MagicMock()
        fake_types.GenerateContentConfig.return_value = fake_config_obj

        fake_genai = stdlib_types.ModuleType("google.genai")
        fake_genai.types = fake_types
        fake_google = stdlib_types.ModuleType("google")
        fake_google.genai = fake_genai

        import connectors.gemini as mod

        with patch.dict("sys.modules", {
            "google": fake_google,
            "google.genai": fake_genai,
        }):
            mod.analyze_media(video_path, "describe this")

        # Should NOT have been called (json_output defaults to False)
        # Now test with json_output=True
        client2 = _make_mock_client()
        monkeypatch.setattr("connectors.gemini._client", lambda: client2)

        with patch.dict("sys.modules", {
            "google": fake_google,
            "google.genai": fake_genai,
        }):
            mod.analyze_media(video_path, "describe this", json_output=True)

        fake_types.GenerateContentConfig.assert_called_with(
            response_mime_type="application/json"
        )

    def test_json_output_false_no_response_mime_type(self, monkeypatch, video_path):
        client = _make_mock_client()
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types = MagicMock()
        fake_genai = stdlib_types.ModuleType("google.genai")
        fake_genai.types = fake_types
        fake_google = stdlib_types.ModuleType("google")
        fake_google.genai = fake_genai

        import connectors.gemini as mod

        with patch.dict("sys.modules", {
            "google": fake_google,
            "google.genai": fake_genai,
        }):
            mod.analyze_media(video_path, "describe this", json_output=False)

        # config should be None (empty dict → no config), so GenerateContentConfig
        # should NOT have been called
        client.models.generate_content.assert_called_once()
        call_kwargs = client.models.generate_content.call_args
        assert call_kwargs.kwargs.get("config") is None or call_kwargs[1].get("config") is None


class TestGenerateContentErrors:
    """SDK exceptions from generate_content → ConnectorError."""

    def test_generate_content_exception_becomes_connector_error(self, monkeypatch, video_path):
        client = _make_mock_client(
            generate_side_effect=RuntimeError("API quota exceeded")
        )
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types = MagicMock()
        fake_genai = stdlib_types.ModuleType("google.genai")
        fake_genai.types = fake_types
        fake_google = stdlib_types.ModuleType("google")
        fake_google.genai = fake_genai

        import connectors.gemini as mod

        with patch.dict("sys.modules", {
            "google": fake_google,
            "google.genai": fake_genai,
        }):
            with pytest.raises(ConnectorError, match="generate_content failed"):
                mod.analyze_media(video_path, "describe this")


class TestUploadErrors:
    """SDK exceptions from files.upload → ConnectorError."""

    def test_upload_exception_becomes_connector_error(self, monkeypatch):
        client = _make_mock_client(
            upload_side_effect=RuntimeError("Network error")
        )
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        import connectors.gemini as mod

        with pytest.raises(ConnectorError, match="file upload failed"):
            mod.upload_media("/tmp/video.mp4")


class TestUploadVideoPolling:
    """upload_media polls until PROCESSING → ACTIVE."""

    def test_polls_until_active(self, monkeypatch):
        upload_file = _make_file(state_name="PROCESSING")
        client = _make_mock_client(
            upload_file=upload_file,
            get_states=["PROCESSING", "PROCESSING", "ACTIVE"],
        )
        monkeypatch.setattr("connectors.gemini._client", lambda: client)
        # Speed up polling
        import connectors.gemini as mod
        monkeypatch.setattr(mod, "UPLOAD_POLL_INTERVAL_S", 0.0)

        result = mod.upload_media("/tmp/video.mp4")
        assert result.state.name == "ACTIVE"
        assert client.files.get.call_count == 3

    def test_raises_on_failed_state(self, monkeypatch):
        upload_file = _make_file(state_name="PROCESSING")
        client = _make_mock_client(
            upload_file=upload_file,
            get_states=["PROCESSING", "FAILED"],
        )
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        import connectors.gemini as mod
        monkeypatch.setattr(mod, "UPLOAD_POLL_INTERVAL_S", 0.0)

        with pytest.raises(ConnectorError, match="processing failed"):
            mod.upload_media("/tmp/video.mp4")

    def test_raises_on_timeout(self, monkeypatch):
        upload_file = _make_file(state_name="PROCESSING")
        # Always return PROCESSING
        client = _make_mock_client(upload_file=upload_file)
        client.files.get.return_value = _make_file(state_name="PROCESSING")
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        import connectors.gemini as mod
        monkeypatch.setattr(mod, "UPLOAD_POLL_INTERVAL_S", 0.0)
        monkeypatch.setattr(mod, "UPLOAD_MAX_WAIT_S", 0.0)

        with pytest.raises(ConnectorError, match="did not become ACTIVE"):
            mod.upload_media("/tmp/video.mp4")


class TestDeleteFailureSwallowed:
    """Post-call files.delete failure does NOT propagate."""

    def test_delete_failure_does_not_propagate(self, monkeypatch, video_path):
        client = _make_mock_client(
            delete_side_effect=RuntimeError("delete failed"),
            generate_response_text="all good",
        )
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types = MagicMock()
        fake_genai = stdlib_types.ModuleType("google.genai")
        fake_genai.types = fake_types
        fake_google = stdlib_types.ModuleType("google")
        fake_google.genai = fake_genai

        import connectors.gemini as mod

        with patch.dict("sys.modules", {
            "google": fake_google,
            "google.genai": fake_genai,
        }):
            result = mod.analyze_media(video_path, "describe this")

        assert result == "all good"


class TestAnalyzeMediaReturnsText:
    """analyze_media returns .text from the response."""

    def test_returns_response_text(self, monkeypatch, video_path):
        client = _make_mock_client(generate_response_text="The video shows a cat.")
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types = MagicMock()
        fake_genai = stdlib_types.ModuleType("google.genai")
        fake_genai.types = fake_types
        fake_google = stdlib_types.ModuleType("google")
        fake_google.genai = fake_genai

        import connectors.gemini as mod

        with patch.dict("sys.modules", {
            "google": fake_google,
            "google.genai": fake_genai,
        }):
            result = mod.analyze_media(video_path, "describe this")

        assert result == "The video shows a cat."


class TestModuleImportsCleanly:
    """Module imports without google-genai installed."""

    def test_import_without_google_genai(self):
        # This just verifies the import doesn't blow up at module level
        import connectors.gemini  # noqa: F401
        assert hasattr(connectors.gemini, "analyze_media")
        assert hasattr(connectors.gemini, "upload_media")
        assert hasattr(connectors.gemini, "generate_image")


class TestAnalyzeMediaInlineImage:
    """Images under INLINE_BYTE_LIMIT take the inline path — no Files API."""

    def test_image_skips_files_api(self, monkeypatch, image_path):
        """Analyzing a PNG should NOT call files.upload / files.delete."""
        client = _make_mock_client(generate_response_text="a cat")
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types = MagicMock()
        fake_types.Part.from_bytes.side_effect = (
            lambda data, mime_type: ("bytes_part", mime_type, len(data))
        )
        fake_genai = stdlib_types.ModuleType("google.genai")
        fake_genai.types = fake_types
        fake_google = stdlib_types.ModuleType("google")
        fake_google.genai = fake_genai

        import connectors.gemini as mod

        with patch.dict("sys.modules", {
            "google": fake_google,
            "google.genai": fake_genai,
        }):
            result = mod.analyze_media(image_path, "describe this")

        assert result == "a cat"
        # Files API must NOT be touched on the inline path.
        client.files.upload.assert_not_called()
        client.files.delete.assert_not_called()
        # generate_content called once with an inline Part.from_bytes + prompt.
        assert client.models.generate_content.call_count == 1
        call = client.models.generate_content.call_args
        contents = call.kwargs.get("contents") or call.args[0]
        # First part is the inline bytes tuple, second is the prompt string.
        assert len(contents) == 2
        assert contents[0][0] == "bytes_part"
        assert contents[0][1] == "image/png"
        assert contents[1] == "describe this"

    def test_jpeg_detected_as_image(self, monkeypatch, tmp_path):
        """JPEG extension → image/jpeg mime, inline path."""
        p = tmp_path / "photo.jpg"
        p.write_bytes(b"\xff\xd8\xff" + b"\x00" * 512)
        client = _make_mock_client()
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types = MagicMock()
        fake_types.Part.from_bytes.side_effect = (
            lambda data, mime_type: ("bytes_part", mime_type)
        )
        fake_genai = stdlib_types.ModuleType("google.genai")
        fake_genai.types = fake_types
        fake_google = stdlib_types.ModuleType("google")
        fake_google.genai = fake_genai

        import connectors.gemini as mod
        with patch.dict("sys.modules", {
            "google": fake_google,
            "google.genai": fake_genai,
        }):
            mod.analyze_media(str(p), "describe")

        fake_types.Part.from_bytes.assert_called_once()
        assert fake_types.Part.from_bytes.call_args.kwargs.get("mime_type") == "image/jpeg" \
            or fake_types.Part.from_bytes.call_args[1].get("mime_type") == "image/jpeg"
        client.files.upload.assert_not_called()

    def test_oversized_image_falls_back_to_files_api(self, monkeypatch, huge_image_path):
        """Image above INLINE_BYTE_LIMIT → Files API path."""
        client = _make_mock_client(generate_response_text="big image")
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types = MagicMock()
        fake_genai = stdlib_types.ModuleType("google.genai")
        fake_genai.types = fake_types
        fake_google = stdlib_types.ModuleType("google")
        fake_google.genai = fake_genai

        import connectors.gemini as mod

        with patch.dict("sys.modules", {
            "google": fake_google,
            "google.genai": fake_genai,
        }):
            mod.analyze_media(huge_image_path, "describe this")

        # Falls back to Files API — upload IS called.
        client.files.upload.assert_called_once()
        # delete also called (best-effort cleanup).
        client.files.delete.assert_called_once()

    def test_video_still_uses_files_api(self, monkeypatch, video_path):
        """Non-image extension → Files API path (unchanged behavior)."""
        client = _make_mock_client(generate_response_text="a video")
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types = MagicMock()
        fake_genai = stdlib_types.ModuleType("google.genai")
        fake_genai.types = fake_types
        fake_google = stdlib_types.ModuleType("google")
        fake_google.genai = fake_genai

        import connectors.gemini as mod

        with patch.dict("sys.modules", {
            "google": fake_google,
            "google.genai": fake_genai,
        }):
            mod.analyze_media(video_path, "describe")

        client.files.upload.assert_called_once()

    def test_nonexistent_path_raises_connector_error(self, monkeypatch):
        """Stat failure on the path surfaces as ConnectorError, not OSError."""
        monkeypatch.setattr("connectors.gemini._client", lambda: MagicMock())
        import connectors.gemini as mod
        with pytest.raises(ConnectorError, match="Could not stat"):
            mod.analyze_media("/nonexistent/file.png", "describe")

    def test_inline_image_generate_content_exception_wrapped(self, monkeypatch, image_path):
        """SDK exception on inline-path generate_content → ConnectorError."""
        client = _make_mock_client(
            generate_side_effect=RuntimeError("quota exceeded")
        )
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types = MagicMock()
        fake_types.Part.from_bytes.side_effect = lambda **kw: ("bytes_part",)
        fake_genai = stdlib_types.ModuleType("google.genai")
        fake_genai.types = fake_types
        fake_google = stdlib_types.ModuleType("google")
        fake_google.genai = fake_genai

        import connectors.gemini as mod

        with patch.dict("sys.modules", {
            "google": fake_google,
            "google.genai": fake_genai,
        }):
            with pytest.raises(ConnectorError, match="generate_content failed"):
                mod.analyze_media(image_path, "describe")


# ---------------------------------------------------------------------------
# generate_image tests
# ---------------------------------------------------------------------------

def _make_image_response(image_data=b"fake-png"):
    """Build a mock response with inline_data containing image bytes."""
    inline = MagicMock()
    inline.data = image_data

    part = MagicMock()
    part.inline_data = inline

    content = MagicMock()
    content.parts = [part]

    candidate = MagicMock()
    candidate.content = content

    resp = MagicMock()
    resp.candidates = [candidate]
    return resp


def _make_empty_candidates_response():
    resp = MagicMock()
    resp.candidates = []
    resp.prompt_feedback = "SAFETY"
    return resp


def _make_no_image_response():
    """Response with text part only, no inline_data."""
    part = MagicMock()
    part.inline_data = None

    content = MagicMock()
    content.parts = [part]

    candidate = MagicMock()
    candidate.content = content

    resp = MagicMock()
    resp.candidates = [candidate]
    return resp


def _patch_genai_types():
    """Return (fake_types, fake_google, modules_dict) for patching."""
    fake_types = MagicMock()
    # Make Part.from_bytes and Part.from_text return distinguishable mocks
    fake_types.Part.from_bytes.side_effect = lambda data, mime_type: ("bytes_part", mime_type)
    fake_types.Part.from_text.side_effect = lambda text: ("text_part", text)

    fake_genai = stdlib_types.ModuleType("google.genai")
    fake_genai.types = fake_types
    fake_google = stdlib_types.ModuleType("google")
    fake_google.genai = fake_genai
    modules = {
        "google": fake_google,
        "google.genai": fake_genai,
    }
    return fake_types, fake_google, modules


class TestGenerateImageWritesOutput:
    """generate_image writes image bytes to out_path."""

    def test_writes_image_and_returns_path(self, monkeypatch, tmp_path):
        img_data = b"PNG_IMAGE_DATA"
        client = MagicMock()
        client.models.generate_content.return_value = _make_image_response(img_data)
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types, _, modules = _patch_genai_types()

        import connectors.gemini as mod
        out = str(tmp_path / "out.png")
        with patch.dict("sys.modules", modules):
            result = mod.generate_image("a sunset", out)

        assert result == out
        with open(out, "rb") as f:
            assert f.read() == img_data


class TestGenerateImageRefImages:
    """Reference images are included as multimodal parts."""

    def test_ref_images_included_in_contents(self, monkeypatch, tmp_path):
        client = MagicMock()
        client.models.generate_content.return_value = _make_image_response()
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types, _, modules = _patch_genai_types()

        ref = tmp_path / "ref.png"
        ref.write_bytes(b"ref-image-data")

        import connectors.gemini as mod
        out = str(tmp_path / "out.png")
        with patch.dict("sys.modules", modules):
            mod.generate_image("same style", out, ref_images=[str(ref)])

        # Check contents passed to generate_content
        call_kwargs = client.models.generate_content.call_args
        contents = call_kwargs.kwargs.get("contents") or call_kwargs[1].get("contents")
        # Should have 2 parts: bytes_part + text_part
        assert len(contents) == 2
        assert contents[0][0] == "bytes_part"  # from Part.from_bytes
        assert contents[1][0] == "text_part"   # from Part.from_text


class TestGenerateImageAspectRatio:
    """aspect_ratio controls image_config in the config."""

    def test_with_aspect_ratio_sets_image_config(self, monkeypatch, tmp_path):
        client = MagicMock()
        client.models.generate_content.return_value = _make_image_response()
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types, _, modules = _patch_genai_types()

        import connectors.gemini as mod
        out = str(tmp_path / "out.png")
        with patch.dict("sys.modules", modules):
            mod.generate_image("portrait", out, aspect_ratio="9:16")

        # ImageConfig should have been called with aspect_ratio
        fake_types.ImageConfig.assert_called_with(aspect_ratio="9:16")

    def test_without_aspect_ratio_no_image_config(self, monkeypatch, tmp_path):
        client = MagicMock()
        client.models.generate_content.return_value = _make_image_response()
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types, _, modules = _patch_genai_types()

        import connectors.gemini as mod
        out = str(tmp_path / "out.png")
        with patch.dict("sys.modules", modules):
            mod.generate_image("landscape", out)

        fake_types.ImageConfig.assert_not_called()


class TestGenerateImageErrors:
    """Error paths for generate_image."""

    def test_no_candidates_raises(self, monkeypatch, tmp_path):
        client = MagicMock()
        client.models.generate_content.return_value = _make_empty_candidates_response()
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types, _, modules = _patch_genai_types()

        import connectors.gemini as mod
        with patch.dict("sys.modules", modules):
            with pytest.raises(ConnectorError, match="no candidates"):
                mod.generate_image("test", str(tmp_path / "out.png"))

    def test_no_image_in_response_raises(self, monkeypatch, tmp_path):
        client = MagicMock()
        client.models.generate_content.return_value = _make_no_image_response()
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types, _, modules = _patch_genai_types()

        import connectors.gemini as mod
        with patch.dict("sys.modules", modules):
            with pytest.raises(ConnectorError, match="no image in response"):
                mod.generate_image("test", str(tmp_path / "out.png"))

    def test_sdk_exception_becomes_connector_error(self, monkeypatch, tmp_path):
        client = MagicMock()
        client.models.generate_content.side_effect = RuntimeError("quota")
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types, _, modules = _patch_genai_types()

        import connectors.gemini as mod
        with patch.dict("sys.modules", modules):
            with pytest.raises(ConnectorError, match="image generation failed"):
                mod.generate_image("test", str(tmp_path / "out.png"))

    def test_unreadable_ref_raises(self, monkeypatch, tmp_path):
        client = MagicMock()
        monkeypatch.setattr("connectors.gemini._client", lambda: client)

        fake_types, _, modules = _patch_genai_types()

        import connectors.gemini as mod
        with patch.dict("sys.modules", modules):
            with pytest.raises(ConnectorError, match="Could not read reference image"):
                mod.generate_image("test", str(tmp_path / "out.png"),
                                   ref_images=["/nonexistent/ref.png"])

    def test_empty_prompt_raises(self):
        import connectors.gemini as mod
        with pytest.raises(ConnectorError, match="Prompt must not be empty"):
            mod.generate_image("", "/tmp/out.png")
