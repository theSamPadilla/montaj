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

        # URL downloads now go through the shared _http helper (streamed,
        # retried) — fake the requests module it lazily imports.
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.iter_content.return_value = iter([img_data])
        mock_requests = MagicMock()
        mock_requests.request.return_value = mock_response
        mock_requests.RequestException = Exception
        from connectors import _http
        monkeypatch.setattr(_http, "_require_requests", lambda: mock_requests)

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


# ---------------------------------------------------------------------------
# _client: PV29 review item 9. The SDK default (max_retries=2) retries
# timeouts, 429s and 5xx on billed images.generate/images.edit calls — a
# timed-out image can be charged twice. This connector does its own retry
# decisions (or none) at the ConnectorError layer, so the SDK must not retry
# underneath it.
# ---------------------------------------------------------------------------

class TestClientDisablesSdkRetries:
    def test_client_passes_max_retries_zero(self, monkeypatch):
        captured = {}

        class _FakeOpenAI:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        import openai as openai_sdk
        monkeypatch.setattr(openai_sdk, "OpenAI", _FakeOpenAI)
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")

        import connectors.openai as mod
        mod._client()

        assert captured.get("max_retries") == 0


# ---------------------------------------------------------------------------
# generate_image: SDK exceptions classified via classify_http_error — PV29 T3.
#
# openai.APIStatusError/.APIConnectionError are the REAL SDK classes (openai
# is a real installed dependency), built the way the SDK itself does, not a
# fake shape.
# ---------------------------------------------------------------------------

import httpx  # noqa: E402
import openai as openai_sdk  # noqa: E402


def _api_status_error(status_code, body, method="POST", url="https://api.openai.com/v1/images/generations"):
    request = httpx.Request(method, url)
    response = httpx.Response(status_code, request=request, json=body)
    err_msg = f"Error code: {status_code} - {body}"
    return openai_sdk.APIStatusError(err_msg, response=response, body=body)


def _api_connection_error(method="GET", url="https://api.openai.com/v1/images/generations"):
    request = httpx.Request(method, url)
    return openai_sdk.APIConnectionError(request=request)


class TestGenerateImageErrorClassification:
    """A rejected key / no credit / a network failure get the shared reason,
    instead of the old bare 'OpenAI image generation failed: {e}' with no
    reason at all."""

    def test_401_status_error_is_invalid_api_key(self, monkeypatch, tmp_path):
        err = _api_status_error(401, {"error": {"message": "Invalid API key provided", "type": "invalid_request_error"}})
        client = MagicMock()
        client.images.generate.side_effect = err
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        import connectors.openai as mod
        with pytest.raises(ConnectorError) as ei:
            mod.generate_image("a cat", str(tmp_path / "out.png"))
        assert ei.value.reason == "invalid_api_key"

    def test_402_status_error_is_insufficient_credit(self, monkeypatch, tmp_path):
        err = _api_status_error(402, {"error": {"message": "You exceeded your current quota"}})
        client = MagicMock()
        client.images.generate.side_effect = err
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        import connectors.openai as mod
        with pytest.raises(ConnectorError) as ei:
            mod.generate_image("a cat", str(tmp_path / "out.png"))
        assert ei.value.reason == "insufficient_credit"

    def test_unclassified_status_error_has_none_reason(self, monkeypatch, tmp_path):
        err = _api_status_error(500, {"error": {"message": "internal error"}})
        client = MagicMock()
        client.images.generate.side_effect = err
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        import connectors.openai as mod
        with pytest.raises(ConnectorError) as ei:
            mod.generate_image("a cat", str(tmp_path / "out.png"))
        assert ei.value.reason is None

    def test_connection_error_is_unreachable(self, monkeypatch, tmp_path):
        client = MagicMock()
        client.images.generate.side_effect = _api_connection_error()
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        import connectors.openai as mod
        with pytest.raises(ConnectorError) as ei:
            mod.generate_image("a cat", str(tmp_path / "out.png"))
        assert ei.value.reason == "unreachable"

    def test_plain_exception_still_generic(self, monkeypatch, tmp_path):
        """Non-SDK exceptions (e.g. a bug elsewhere) keep the old generic
        shape — reason None — same as test_sdk_generate_error_becomes_connector_error."""
        client = MagicMock()
        client.images.generate.side_effect = RuntimeError("boom")
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        import connectors.openai as mod
        with pytest.raises(ConnectorError) as ei:
            mod.generate_image("a cat", str(tmp_path / "out.png"))
        assert ei.value.reason is None


# ---------------------------------------------------------------------------
# check_key — PV29 T3. One free call: GET /v1/models.
# ---------------------------------------------------------------------------

import json as json_module  # noqa: E402


class _FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = json_module.dumps(body) if body is not None else ""

    def json(self):
        return self._body


class TestCheckKey:
    @pytest.fixture(autouse=True)
    def _fake_key(self, monkeypatch):
        # PV29 T7: check_key() calls get_credential("openai", "api_key") for
        # real — without this, these tests silently pass or fail depending
        # on whatever OPENAI_API_KEY / ~/.montaj/credentials.json happen to
        # be on the machine running them. Under a fresh HOME with no env key
        # (the standing rule for this suite), get_credential would raise
        # CredentialError before ever reaching the mocked HTTP call below.
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")

    def test_ok_default_model_present(self, monkeypatch):
        body = {"data": [{"id": "gpt-image-2.5-sunburst"}, {"id": "gpt-4o"}]}
        resp = _FakeResponse(200, body)
        monkeypatch.setattr("connectors.openai._http.request_with_retry", lambda *a, **kw: resp)

        import connectors.openai as mod
        result = mod.check_key()
        assert result["ok"] is True
        assert result["default_model"] == mod.DEFAULT_IMAGE_MODEL
        assert result["default_model_ok"] is True

    def test_default_model_missing(self, monkeypatch):
        body = {"data": [{"id": "gpt-4o"}]}
        resp = _FakeResponse(200, body)
        monkeypatch.setattr("connectors.openai._http.request_with_retry", lambda *a, **kw: resp)

        import connectors.openai as mod
        result = mod.check_key()
        assert result["default_model_ok"] is False

    def test_401_raises_invalid_api_key(self, monkeypatch):
        resp = _FakeResponse(401, {"error": {"message": "Invalid API key provided"}})
        monkeypatch.setattr("connectors.openai._http.request_with_retry", lambda *a, **kw: resp)

        import connectors.openai as mod
        with pytest.raises(ConnectorError) as ei:
            mod.check_key()
        assert ei.value.reason == "invalid_api_key"

    def test_connection_failure_raises_unreachable(self, monkeypatch):
        def boom(*a, **kw):
            raise ConnectorError("GET https://api.openai.com/v1/models failed after 3 attempts: timed out")
        monkeypatch.setattr("connectors.openai._http.request_with_retry", boom)

        import connectors.openai as mod
        with pytest.raises(ConnectorError) as ei:
            mod.check_key()
        assert ei.value.reason == "unreachable"

    def test_never_sends_a_real_request(self, monkeypatch):
        """Guard: this test file must never let check_key reach the network."""
        def fail_if_called(*a, **kw):
            raise AssertionError("check_key must not call the real requests module")
        monkeypatch.setattr("connectors._http._require_requests", fail_if_called)
        resp = _FakeResponse(200, {"data": [{"id": "gpt-image-2.5-sunburst"}]})
        monkeypatch.setattr("connectors.openai._http.request_with_retry", lambda *a, **kw: resp)

        import connectors.openai as mod
        mod.check_key()  # would raise via fail_if_called if it fell through to real requests


# ---------------------------------------------------------------------------
# Best-model default — PV29 T4b. gpt-image-1 was the original default here
# (the stored OpenAI key returns 401, so it couldn't be verified live).
# Controller decision (2026-09-28, operator): take the default from the
# vendor docs (developers.openai.com/api/docs/models) instead of a live
# probe — gpt-image-2.5-sunburst is GA there, "our most capable model for
# image generation and editing," snapshot gpt-image-2.5-sunburst-2026-09-08,
# serving both v1/images/generations and v1/images/edits (this connector
# uses both paths). Never called by this connector — deliberate, per the
# operator. gpt-image-1 ("previous-generation," not deprecated) is the
# documented fallback via --model.
# ---------------------------------------------------------------------------

class TestBestModelDefault:
    def test_default_image_model_matches_vendor_docs(self):
        import connectors.openai as mod
        assert mod.DEFAULT_IMAGE_MODEL == "gpt-image-2.5-sunburst"

    def test_default_model_reaches_generate_without_refs(self, monkeypatch, tmp_path):
        """The default must actually flow through to images.generate, and
        this connector must never send a `quality` value gpt-image-2.5-sunburst
        doesn't support — it sends none at all, so the vendor default
        ('auto') applies, which every GPT-Image model accepts."""
        b64 = base64.b64encode(b"fake-png-data").decode()
        client = _make_mock_client(b64_json=b64)
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        import connectors.openai as mod
        mod.generate_image("a red apple", str(tmp_path / "out.png"))

        call_kwargs = client.images.generate.call_args
        assert call_kwargs.kwargs.get("model") == "gpt-image-2.5-sunburst"
        assert "quality" not in call_kwargs.kwargs

    def test_default_model_reaches_edit_with_refs(self, monkeypatch, tmp_path):
        """gpt-image-2.5-sunburst also serves v1/images/edits — the ref-image
        path must use the same default model."""
        b64 = base64.b64encode(b"fake-png-data").decode()
        client = _make_mock_client(b64_json=b64)
        monkeypatch.setattr("connectors.openai._client", lambda: client)

        ref = tmp_path / "ref.png"
        ref.write_bytes(b"ref-data")

        import connectors.openai as mod
        mod.generate_image("same style", str(tmp_path / "out.png"), ref_images=[str(ref)])

        call_kwargs = client.images.edit.call_args
        assert call_kwargs.kwargs.get("model") == "gpt-image-2.5-sunburst"
