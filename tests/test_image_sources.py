"""Unit tests for lib/image_sources.py.

All HTTP is mocked via httpx.MockTransport — no live network calls.
"""
import ipaddress
import json
import socket
import sys
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

from lib.image_sources import (
    DEFAULT_IMAGE_HOSTS,
    allowed_image_hosts,
    commons_search,
    fetch_image_to_path,
    is_public_host,
    preflight_image_url,
    sportsdb_badge,
)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

def _make_transport(response: httpx.Response):
    """Return a MockTransport that always returns *response*."""
    def handler(request):
        return response
    return httpx.MockTransport(handler)


def _json_transport(payload: dict, status: int = 200):
    body = json.dumps(payload).encode()
    resp = httpx.Response(status, headers={"content-type": "application/json"}, content=body)
    return _make_transport(resp)


# ---------------------------------------------------------------------------
# Canned API payloads
# ---------------------------------------------------------------------------

COMMONS_PAYLOAD = {
    "query": {
        "pages": [
            {
                "title": "File:TestImage.jpg",
                "imageinfo": [
                    {
                        "url": "https://upload.wikimedia.org/wikipedia/commons/test.jpg",
                        "width": 1920,
                        "height": 1080,
                        "mime": "image/jpeg",
                        "extmetadata": {
                            "LicenseShortName": {"value": "CC BY-SA 4.0"},
                            "Artist": {"value": "<span>Jane <b>Doe</b></span>"},
                        },
                    }
                ],
            },
            {
                # SVG — should be filtered out
                "title": "File:Icon.svg",
                "imageinfo": [
                    {
                        "url": "https://upload.wikimedia.org/wikipedia/commons/icon.svg",
                        "width": 100,
                        "height": 100,
                        "mime": "image/svg+xml",
                        "extmetadata": {},
                    }
                ],
            },
            {
                # Non-image mime — should be filtered out
                "title": "File:Document.pdf",
                "imageinfo": [
                    {
                        "url": "https://upload.wikimedia.org/wikipedia/commons/doc.pdf",
                        "width": None,
                        "height": None,
                        "mime": "application/pdf",
                        "extmetadata": {},
                    }
                ],
            },
        ]
    }
}

SPORTSDB_PAYLOAD = {
    "teams": [
        {
            "strTeam": "FC Barcelona",
            "strSport": "Soccer",
            "strBadge": "https://www.thesportsdb.com/images/media/team/badge/barcelona.png",
        },
        {
            # Non-soccer entry — should be filtered
            "strTeam": "LA Lakers",
            "strSport": "Basketball",
            "strBadge": "https://www.thesportsdb.com/images/media/team/badge/lakers.png",
        },
        {
            # Soccer but no badge
            "strTeam": "Unknown FC",
            "strSport": "Soccer",
            "strBadge": "",
        },
    ]
}


# ---------------------------------------------------------------------------
# allowed_image_hosts
# ---------------------------------------------------------------------------

class TestAllowedImageHosts:
    def test_contains_defaults(self):
        hosts = allowed_image_hosts()
        assert DEFAULT_IMAGE_HOSTS.issubset(hosts)

    def test_merges_env_var(self, monkeypatch):
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "custom.example.com")
        hosts = allowed_image_hosts()
        assert "custom.example.com" in hosts
        assert DEFAULT_IMAGE_HOSTS.issubset(hosts)

    def test_empty_env_var(self, monkeypatch):
        monkeypatch.setenv("MONTAJ_HTTP_ALLOWED_HOSTS", "")
        hosts = allowed_image_hosts()
        assert hosts == DEFAULT_IMAGE_HOSTS


# ---------------------------------------------------------------------------
# is_public_host
# ---------------------------------------------------------------------------

def _mock_getaddrinfo(addr_str: str):
    """Return a monkeypatched getaddrinfo that always resolves to *addr_str*."""
    def _getaddrinfo(host, port, *args, **kwargs):
        return [(None, None, None, None, (addr_str, 0))]
    return _getaddrinfo


class TestIsPublicHost:
    def test_public_ip_returns_true(self, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("93.184.216.34"))
        assert is_public_host("example.com") is True

    def test_private_10_x_returns_false(self, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("10.0.0.1"))
        assert is_public_host("internal.example.com") is False

    def test_loopback_127_returns_false(self, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("127.0.0.1"))
        assert is_public_host("localhost") is False

    def test_link_local_returns_false(self, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("169.254.1.1"))
        assert is_public_host("link-local.example") is False

    def test_resolution_failure_returns_false(self, monkeypatch):
        def _raise(*args, **kwargs):
            raise socket.gaierror("name resolution failure")
        monkeypatch.setattr(socket, "getaddrinfo", _raise)
        assert is_public_host("nonexistent.invalid") is False

    def test_private_192_168_returns_false(self, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("192.168.1.1"))
        assert is_public_host("router.local") is False


# ---------------------------------------------------------------------------
# preflight_image_url
# ---------------------------------------------------------------------------

class TestPreflightImageUrl:
    HOSTS = {"upload.wikimedia.org"}

    def test_valid_url_returns_none(self, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("91.198.174.192"))
        result = preflight_image_url(
            "https://upload.wikimedia.org/test.jpg", self.HOSTS
        )
        assert result is None

    def test_http_returns_not_https(self):
        result = preflight_image_url("http://upload.wikimedia.org/test.jpg", self.HOSTS)
        assert result == "not_https"

    def test_non_url_returns_not_https(self):
        assert preflight_image_url("not a url", self.HOSTS) == "not_https"

    def test_host_not_in_allowlist_returns_host_not_allowed(self, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("1.2.3.4"))
        result = preflight_image_url("https://unknown.example.com/img.jpg", self.HOSTS)
        assert result == "host_not_allowed"

    def test_private_host_returns_host_not_public(self, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("10.0.0.1"))
        result = preflight_image_url(
            "https://upload.wikimedia.org/img.jpg", self.HOSTS
        )
        assert result == "host_not_public"


# ---------------------------------------------------------------------------
# commons_search
# ---------------------------------------------------------------------------

class TestCommonsSearch:
    def test_parses_title_url_size(self):
        transport = _json_transport(COMMONS_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = commons_search("test", limit=10, client=c)
        assert len(results) == 1  # SVG and PDF filtered out
        r = results[0]
        assert r["title"] == "File:TestImage.jpg"
        assert r["url"] == "https://upload.wikimedia.org/wikipedia/commons/test.jpg"
        assert r["width"] == 1920
        assert r["height"] == 1080

    def test_parses_license(self):
        transport = _json_transport(COMMONS_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = commons_search("test", limit=10, client=c)
        assert results[0]["license"] == "CC BY-SA 4.0"

    def test_strips_html_from_artist(self):
        transport = _json_transport(COMMONS_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = commons_search("test", limit=10, client=c)
        # "<span>Jane <b>Doe</b></span>" → "Jane Doe"
        assert results[0]["artist"] == "Jane Doe"

    def test_svg_filtered_out(self):
        transport = _json_transport(COMMONS_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = commons_search("test", limit=10, client=c)
        mimes = [r["mime"] for r in results]
        assert "image/svg+xml" not in mimes

    def test_non_image_mime_filtered_out(self):
        transport = _json_transport(COMMONS_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = commons_search("test", limit=10, client=c)
        for r in results:
            assert r["mime"].startswith("image/")

    def test_source_field_is_commons(self):
        transport = _json_transport(COMMONS_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = commons_search("test", client=c)
        assert all(r["source"] == "commons" for r in results)

    def test_limit_respected(self):
        # Build a payload with 5 valid image entries
        pages = [
            {
                "title": f"File:Image{i}.jpg",
                "imageinfo": [{
                    "url": f"https://upload.wikimedia.org/img{i}.jpg",
                    "width": 100,
                    "height": 100,
                    "mime": "image/jpeg",
                    "extmetadata": {},
                }],
            }
            for i in range(5)
        ]
        transport = _json_transport({"query": {"pages": pages}})
        c = httpx.Client(transport=transport)
        results = commons_search("test", limit=3, client=c)
        assert len(results) == 3

    def test_empty_response(self):
        transport = _json_transport({})
        c = httpx.Client(transport=transport)
        results = commons_search("noresults", client=c)
        assert results == []

    def test_gsrlimit_param_sent_to_api(self):
        """The limit is forwarded to the Commons API as gsrlimit (capped at 50)."""
        seen = {}

        def handler(request):
            seen.update(dict(request.url.params))
            return httpx.Response(
                200, headers={"content-type": "application/json"},
                content=json.dumps({}).encode(),
            )

        c = httpx.Client(transport=httpx.MockTransport(handler))
        commons_search("test", limit=7, client=c)
        assert seen["gsrlimit"] == "7"

        commons_search("test", limit=200, client=c)
        assert seen["gsrlimit"] == "50"


# ---------------------------------------------------------------------------
# sportsdb_badge
# ---------------------------------------------------------------------------

class TestSportsdbBadge:
    def test_returns_soccer_entries_only(self):
        transport = _json_transport(SPORTSDB_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = sportsdb_badge("Barcelona", client=c)
        assert len(results) == 1
        assert results[0]["title"] == "FC Barcelona"

    def test_filters_non_soccer(self):
        transport = _json_transport(SPORTSDB_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = sportsdb_badge("Lakers", client=c)
        # Lakers is Basketball, not Soccer
        assert all(r["title"] != "LA Lakers" for r in results)

    def test_filters_empty_badge(self):
        transport = _json_transport(SPORTSDB_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = sportsdb_badge("Unknown", client=c)
        assert all(r["url"] for r in results)

    def test_badge_url_not_modified(self):
        transport = _json_transport(SPORTSDB_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = sportsdb_badge("Barcelona", client=c)
        # URL must NOT have /preview appended
        assert results[0]["url"] == (
            "https://www.thesportsdb.com/images/media/team/badge/barcelona.png"
        )
        assert not results[0]["url"].endswith("/preview")

    def test_source_field_is_sportsdb(self):
        transport = _json_transport(SPORTSDB_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = sportsdb_badge("Barcelona", client=c)
        assert all(r["source"] == "sportsdb" for r in results)

    def test_mime_is_image_png(self):
        transport = _json_transport(SPORTSDB_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = sportsdb_badge("Barcelona", client=c)
        assert all(r["mime"] == "image/png" for r in results)

    def test_license_is_editorial(self):
        transport = _json_transport(SPORTSDB_PAYLOAD)
        c = httpx.Client(transport=transport)
        results = sportsdb_badge("Barcelona", client=c)
        assert all(r["license"] == "editorial" for r in results)

    def test_null_teams_response(self):
        transport = _json_transport({"teams": None})
        c = httpx.Client(transport=transport)
        results = sportsdb_badge("nobody", client=c)
        assert results == []


# ---------------------------------------------------------------------------
# fetch_image_to_path
# ---------------------------------------------------------------------------

class TestFetchImageToPath:
    HOSTS = {"upload.wikimedia.org"}

    def _image_transport(self, content=b"IMGDATA", mime="image/jpeg", status=200):
        resp = httpx.Response(
            status,
            headers={"content-type": mime},
            content=content,
        )
        return _make_transport(resp)

    def test_success_writes_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("91.198.174.192"))
        transport = self._image_transport(b"FAKE_IMAGE_DATA")
        c = httpx.Client(transport=transport)
        out = tmp_path / "result.jpg"
        result = fetch_image_to_path(
            "https://upload.wikimedia.org/test.jpg", out, self.HOSTS, client=c
        )
        assert result == out
        assert out.read_bytes() == b"FAKE_IMAGE_DATA"

    def test_http_url_rejected(self, tmp_path, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("91.198.174.192"))
        c = httpx.Client(transport=self._image_transport())
        out = tmp_path / "out.jpg"
        with pytest.raises(SystemExit):
            fetch_image_to_path("http://upload.wikimedia.org/test.jpg", out, self.HOSTS, client=c)

    def test_unlisted_host_rejected(self, tmp_path, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("1.2.3.4"))
        c = httpx.Client(transport=self._image_transport())
        out = tmp_path / "out.jpg"
        with pytest.raises(SystemExit):
            fetch_image_to_path(
                "https://evil.example.com/test.jpg", out, self.HOSTS, client=c
            )

    def test_non_image_content_type_rejected(self, tmp_path, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("91.198.174.192"))
        transport = self._image_transport(mime="text/html")
        c = httpx.Client(transport=transport)
        out = tmp_path / "out.jpg"
        with pytest.raises(SystemExit):
            fetch_image_to_path(
                "https://upload.wikimedia.org/test.jpg", out, self.HOSTS, client=c
            )

    def test_size_cap_exceeded(self, tmp_path, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("91.198.174.192"))
        big_content = b"X" * 200
        transport = self._image_transport(content=big_content)
        c = httpx.Client(transport=transport)
        out = tmp_path / "out.jpg"
        with pytest.raises(SystemExit):
            fetch_image_to_path(
                "https://upload.wikimedia.org/test.jpg", out, self.HOSTS,
                max_bytes=100, client=c
            )
        # Partial file must be cleaned up
        assert not out.exists()

    def test_creates_parent_dirs(self, tmp_path, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("91.198.174.192"))
        transport = self._image_transport(b"IMG")
        c = httpx.Client(transport=transport)
        out = tmp_path / "deep" / "nested" / "dir" / "img.jpg"
        fetch_image_to_path(
            "https://upload.wikimedia.org/test.jpg", out, self.HOSTS, client=c
        )
        assert out.exists()

    def test_redirect_rejected(self, tmp_path, monkeypatch, capsys):
        """A 301 redirect response → fail(redirect_rejected); nothing written."""
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("91.198.174.192"))
        resp = httpx.Response(
            301,
            headers={"location": "https://internal.example.com/secret.jpg"},
        )
        c = httpx.Client(transport=_make_transport(resp))
        out = tmp_path / "out.jpg"
        with pytest.raises(SystemExit):
            fetch_image_to_path(
                "https://upload.wikimedia.org/test.jpg", out, self.HOSTS, client=c
            )
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "redirect_rejected"
        assert not out.exists()

    def test_injected_client_with_follow_redirects_true_still_rejects(self, tmp_path, monkeypatch, capsys):
        """follow_redirects=False is forced per-request: even a client built with
        follow_redirects=True must see the raw 302 and reject it."""
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("91.198.174.192"))

        def handler(request):
            if request.url.host == "upload.wikimedia.org":
                return httpx.Response(
                    302, headers={"location": "https://evil.example.com/x.jpg"}
                )
            # If the redirect were followed, this would return a "valid" image.
            return httpx.Response(
                200, headers={"content-type": "image/jpeg"}, content=b"EVIL"
            )

        c = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)
        out = tmp_path / "out.jpg"
        with pytest.raises(SystemExit):
            fetch_image_to_path(
                "https://upload.wikimedia.org/test.jpg", out, self.HOSTS, client=c
            )
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "redirect_rejected"
        assert not out.exists()
