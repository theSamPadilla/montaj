"""Tests for connectors.openai — OpenAI image generation connector."""
import base64, os
from unittest.mock import MagicMock, call

import pytest

from connectors import ConnectorError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_mock_client(b64_json=None, url=None, generate_side_effect=None, edit_side_effect=None):
    """Build a mock OpenAI Client.

    Parameters
    ----------
    b64_json : base64 string for the response image
    url : URL string for the response image (DALL-E fallback)
    generate_side_effect : exception to raise on images.generate
    edit_side_effect : exception to raise on images.edit
    """
    client = MagicMock()

    item = MagicMock()
    item.b64_json = b64_json
    item.url = url

    resp = MagicMock()
    resp.data = [item]

    if generate_side_effect:
        client.images.generate.side_effect = generate_side_effect
    else:
        client.images.generate.return_value = resp

    if edit_side_effect:
        client.images.edit.side_effect = edit_side_effect
    else:
        client.images.edit.return_value = resp

    return client


# ---------------------------------------------------------------------------
# Tests: generate vs edit dispatch
# ---------------------------------------------------------------------------

class TestGenerateDispatch:
    """generate_image without ref_images calls images.generate, not edit."""

    def test_no_refs_calls_generate(self, monkeypatch, tmp_path):
        b64 = base64.b64encode(b"fake-png-data").decode()
        client = _make_mock_client(b64_json=b64)
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        import connectors.openai as mod
        out = str(tmp_path / "out.png")
        result = mod.generate_image("a red apple", out)

        assert result == out
        client.images.generate.assert_called_once()
        client.images.edit.assert_not_called()

    def test_single_ref_calls_edit_with_file(self, monkeypatch, tmp_path):
        b64 = base64.b64encode(b"fake-png-data").decode()
        client = _make_mock_client(b64_json=b64)
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        # Create a ref image file
        ref = tmp_path / "ref.png"
        ref.write_bytes(b"ref-data")

        import connectors.openai as mod
        out = str(tmp_path / "out.png")
        mod.generate_image("same style", out, ref_images=[str(ref)])

        client.images.edit.assert_called_once()
        client.images.generate.assert_not_called()
        # Single ref → passed directly, not as a list
        call_kwargs = client.images.edit.call_args
        image_arg = call_kwargs.kwargs.get("image") or call_kwargs[1].get("image")
        # Should not be a list for single ref
        assert not isinstance(image_arg, list)

    def test_multiple_refs_passes_list(self, monkeypatch, tmp_path):
        b64 = base64.b64encode(b"fake-png-data").decode()
        client = _make_mock_client(b64_json=b64)
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        ref1 = tmp_path / "ref1.png"
        ref2 = tmp_path / "ref2.png"
        ref1.write_bytes(b"ref1")
        ref2.write_bytes(b"ref2")

        import connectors.openai as mod
        out = str(tmp_path / "out.png")
        mod.generate_image("same style", out, ref_images=[str(ref1), str(ref2)])

        client.images.edit.assert_called_once()
        call_kwargs = client.images.edit.call_args
        image_arg = call_kwargs.kwargs.get("image") or call_kwargs[1].get("image")
        assert isinstance(image_arg, list)
        assert len(image_arg) == 2


# ---------------------------------------------------------------------------
# Tests: response handling
# ---------------------------------------------------------------------------

class TestResponseHandling:
    """b64_json vs url response formats."""

    def test_b64_json_decodes_and_writes(self, monkeypatch, tmp_path):
        img_data = b"PNG image bytes here"
        b64 = base64.b64encode(img_data).decode()
        client = _make_mock_client(b64_json=b64)
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        import connectors.openai as mod
        out = str(tmp_path / "out.png")
        mod.generate_image("a cat", out)

        with open(out, "rb") as f:
            assert f.read() == img_data

    def test_url_downloads_and_writes(self, monkeypatch, tmp_path):
        img_data = b"downloaded image bytes"
        client = _make_mock_client(b64_json=None, url="https://example.com/img.png")
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        # Mock requests.get
        mock_response = MagicMock()
        mock_response.content = img_data
        mock_requests = MagicMock()
        mock_requests.get.return_value = mock_response
        mock_requests.RequestException = Exception
        monkeypatch.setitem(__import__("sys").modules, "requests", mock_requests)

        import connectors.openai as mod
        out = str(tmp_path / "out.png")
        mod.generate_image("a cat", out)

        with open(out, "rb") as f:
            assert f.read() == img_data

    def test_neither_b64_nor_url_raises(self, monkeypatch, tmp_path):
        client = _make_mock_client(b64_json=None, url=None)
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        import connectors.openai as mod
        out = str(tmp_path / "out.png")
        with pytest.raises(ConnectorError, match="neither b64_json nor url"):
            mod.generate_image("a cat", out)

    def test_empty_data_raises(self, monkeypatch, tmp_path):
        client = _make_mock_client()
        resp = MagicMock()
        resp.data = None
        client.images.generate.return_value = resp
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        import connectors.openai as mod
        out = str(tmp_path / "out.png")
        with pytest.raises(ConnectorError, match="no image data"):
            mod.generate_image("a cat", out)


# ---------------------------------------------------------------------------
# Tests: error handling
# ---------------------------------------------------------------------------

class TestErrorHandling:
    """SDK exceptions → ConnectorError."""

    def test_sdk_generate_error_becomes_connector_error(self, monkeypatch, tmp_path):
        client = _make_mock_client(generate_side_effect=RuntimeError("API quota"))
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        import connectors.openai as mod
        with pytest.raises(ConnectorError, match="OpenAI image generation failed"):
            mod.generate_image("a cat", str(tmp_path / "out.png"))

    def test_unreadable_ref_raises_connector_error(self, monkeypatch, tmp_path):
        b64 = base64.b64encode(b"data").decode()
        client = _make_mock_client(b64_json=b64)
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        import connectors.openai as mod
        with pytest.raises(ConnectorError, match="Could not read reference image"):
            mod.generate_image("a cat", str(tmp_path / "out.png"),
                               ref_images=["/nonexistent/ref.png"])

    def test_empty_prompt_raises(self, monkeypatch):
        import connectors.openai as mod
        with pytest.raises(ConnectorError, match="Prompt must not be empty"):
            mod.generate_image("", "/tmp/out.png")

    def test_whitespace_prompt_raises(self, monkeypatch):
        import connectors.openai as mod
        with pytest.raises(ConnectorError, match="Prompt must not be empty"):
            mod.generate_image("   ", "/tmp/out.png")


# ---------------------------------------------------------------------------
# Tests: module import
# ---------------------------------------------------------------------------

class TestModuleImportsCleanly:
    """Module imports without openai SDK installed."""

    def test_import_without_openai_sdk(self):
        import connectors.openai  # noqa: F401
        assert hasattr(connectors.openai, "generate_image")
        assert hasattr(connectors.openai, "DEFAULT_IMAGE_MODEL")
