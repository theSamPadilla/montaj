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
    logo_search,
    openverse_search,
    preflight_image_url,
    serpapi_image_search,
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
                        # iiprop=url's description page (MediaWiki API docs, prop=imageinfo; not a capture)
                        "descriptionurl": "https://commons.wikimedia.org/wiki/File:TestImage.jpg",
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

    def test_off_allowlist_public_host_allowed_by_default(self, monkeypatch):
        # Default (permissive) mode: any public HTTPS host passes — the host
        # allowlist is no longer a gate. is_public_host is the real guard.
        monkeypatch.delenv("MONTAJ_IMAGE_HOST_STRICT", raising=False)
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("1.2.3.4"))
        result = preflight_image_url("https://unknown.example.com/img.jpg", self.HOSTS)
        assert result is None

    def test_host_not_in_allowlist_rejected_in_strict_mode(self, monkeypatch):
        monkeypatch.setenv("MONTAJ_IMAGE_HOST_STRICT", "1")
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

    def test_page_url_is_the_files_description_page(self):
        c = httpx.Client(transport=_json_transport(COMMONS_PAYLOAD))
        assert commons_search("test", limit=10, client=c)[0]["pageUrl"] == \
            "https://commons.wikimedia.org/wiki/File:TestImage.jpg"

    def test_no_page_url_when_the_api_gives_none(self):
        payload = json.loads(json.dumps(COMMONS_PAYLOAD))
        del payload["query"]["pages"][0]["imageinfo"][0]["descriptionurl"]
        c = httpx.Client(transport=_json_transport(payload))
        assert "pageUrl" not in commons_search("test", limit=10, client=c)[0]

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
# serpapi_image_search (open-web, keyed)
# ---------------------------------------------------------------------------

SERPAPI_PAYLOAD = {
    "images_results": [
        {
            "title": "James Rodriguez Colombia",
            "original": "https://cdn.example-news.com/james.jpg",
            "original_width": 2000,
            "original_height": 2500,
            "thumbnail": "https://serpapi.example/thumb1.jpg",
            "source": "example-news.com",
            # the page the image is on (SerpApi Google Images API docs, images_results; not a capture)
            "link": "https://example-news.com/2026/james",
        },
        {
            "title": "insecure result",
            "original": "http://insecure.example.com/x.jpg",  # http → dropped
            "original_width": 800,
            "original_height": 600,
            "source": "insecure.example.com",
        },
        {
            "title": "no original url",
            "thumbnail": "https://serpapi.example/thumb3.jpg",
            "source": "noimg.example.com",
        },
    ]
}


class TestSerpapiImageSearch:
    def test_maps_results_and_drops_non_https(self):
        c = httpx.Client(transport=_json_transport(SERPAPI_PAYLOAD))
        results = serpapi_image_search("james colombia", "KEY123", client=c)
        # Only the HTTPS-original result survives.
        assert len(results) == 1
        r = results[0]
        assert r["url"] == "https://cdn.example-news.com/james.jpg"
        assert r["width"] == 2000 and r["height"] == 2500
        assert r["source"] == "web"
        assert r["license"] == "unknown"
        assert r["artist"] == "example-news.com"
        assert r["mime"] == "image/jpeg"
        assert r["thumbnail"] == "https://serpapi.example/thumb1.jpg"
        assert r["pageUrl"] == "https://example-news.com/2026/james"

    def test_limit_caps_results(self):
        payload = {"images_results": [
            {"original": f"https://cdn.example.com/{i}.jpg", "title": str(i)}
            for i in range(10)
        ]}
        c = httpx.Client(transport=_json_transport(payload))
        results = serpapi_image_search("q", "KEY", limit=3, client=c)
        assert len(results) == 3

    def test_empty_key_raises(self):
        with pytest.raises(ValueError):
            serpapi_image_search("q", "", client=httpx.Client(transport=_json_transport({})))

    def test_serpapi_error_surfaced(self):
        c = httpx.Client(transport=_json_transport({"error": "Invalid API key"}))
        with pytest.raises(ValueError):
            serpapi_image_search("q", "BADKEY", client=c)

    def test_missing_images_results(self):
        c = httpx.Client(transport=_json_transport({}))
        assert serpapi_image_search("q", "KEY", client=c) == []


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

    def test_unlisted_host_rejected_in_strict_mode(self, tmp_path, monkeypatch):
        # Default mode now allows any public host; the allowlist gate is opt-in.
        monkeypatch.setenv("MONTAJ_IMAGE_HOST_STRICT", "1")
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("1.2.3.4"))
        c = httpx.Client(transport=self._image_transport())
        out = tmp_path / "out.jpg"
        with pytest.raises(SystemExit):
            fetch_image_to_path(
                "https://evil.example.com/test.jpg", out, self.HOSTS, client=c
            )

    def test_unlisted_public_host_allowed_by_default(self, tmp_path, monkeypatch):
        monkeypatch.delenv("MONTAJ_IMAGE_HOST_STRICT", raising=False)
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("1.2.3.4"))
        c = httpx.Client(transport=self._image_transport())
        out = tmp_path / "out.jpg"
        result = fetch_image_to_path(
            "https://some-news-cdn.example.com/photo.jpg", out, self.HOSTS, client=c
        )
        assert result == out
        assert out.exists() and out.stat().st_size > 0

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

    # -- redirects: followed by hand, every hop re-checked -------------------

    @staticmethod
    def _redirecting(routes, final=b"IMG"):
        """Client whose handler maps host+path to a redirect target or an image; records each URL asked."""
        calls = []

        def handler(request):
            calls.append(str(request.url))
            tgt = routes.get(str(request.url))
            if tgt:
                return httpx.Response(302, headers={"location": tgt})
            return httpx.Response(200, headers={"content-type": "image/png"}, content=final)
        # follow_redirects=True on the client: the fetch must still see the raw 302s.
        return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True), calls

    def test_redirect_to_public_https_followed(self, tmp_path, monkeypatch):
        monkeypatch.delenv("MONTAJ_IMAGE_HOST_STRICT", raising=False)
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("1.2.3.4"))
        c, calls = self._redirecting({"https://a.example.com/f": "/real.png"})
        info = {}
        out = tmp_path / "o.png"
        fetch_image_to_path("https://a.example.com/f", out, self.HOSTS, client=c, info=info)
        assert out.read_bytes() == b"IMG"
        assert calls == ["https://a.example.com/f", "https://a.example.com/real.png"]
        assert info["finalUrl"] == "https://a.example.com/real.png"

    def test_no_redirect_final_url_is_the_url(self, tmp_path, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("1.2.3.4"))
        c, _ = self._redirecting({})
        info = {}
        fetch_image_to_path("https://a.example.com/x.png", tmp_path / "o.png", self.HOSTS, client=c, info=info)
        assert info["finalUrl"] == "https://a.example.com/x.png"

    def test_redirect_to_private_ip_refused(self, tmp_path, monkeypatch, capsys):
        def gai(host, *a, **k):
            return [(None, None, None, None, ("10.0.0.5" if host == "internal.example.com" else "1.2.3.4", 0))]
        monkeypatch.setattr(socket, "getaddrinfo", gai)
        c, calls = self._redirecting({"https://a.example.com/f": "https://internal.example.com/secret.png"})
        out = tmp_path / "o.png"
        with pytest.raises(SystemExit):
            fetch_image_to_path("https://a.example.com/f", out, self.HOSTS, client=c)
        err = json.loads(capsys.readouterr().err)
        assert (err["error"], err["message"]) == ("url_rejected", "host_not_public")
        assert calls == ["https://a.example.com/f"]   # the private host was never connected to
        assert not out.exists()

    def test_redirect_to_http_refused(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("1.2.3.4"))
        c, calls = self._redirecting({"https://a.example.com/f": "http://a.example.com/x.png"})
        with pytest.raises(SystemExit):
            fetch_image_to_path("https://a.example.com/f", tmp_path / "o.png", self.HOSTS, client=c)
        err = json.loads(capsys.readouterr().err)
        assert (err["error"], err["message"]) == ("url_rejected", "not_https")
        assert len(calls) == 1

    def test_redirect_outside_strict_allowlist_refused(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setenv("MONTAJ_IMAGE_HOST_STRICT", "1")
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("1.2.3.4"))
        c, calls = self._redirecting({"https://upload.wikimedia.org/f": "https://evil.example.com/x.png"})
        with pytest.raises(SystemExit):
            fetch_image_to_path("https://upload.wikimedia.org/f", tmp_path / "o.png", self.HOSTS, client=c)
        err = json.loads(capsys.readouterr().err)
        assert (err["error"], err["message"]) == ("url_rejected", "host_not_allowed")
        assert len(calls) == 1

    def test_redirect_loop_stops_at_five_hops(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("1.2.3.4"))
        c, calls = self._redirecting({"https://a.example.com/a": "/b", "https://a.example.com/b": "/a"})
        out = tmp_path / "o.png"
        with pytest.raises(SystemExit):
            fetch_image_to_path("https://a.example.com/a", out, self.HOSTS, client=c)
        assert json.loads(capsys.readouterr().err)["error"] == "too_many_redirects"
        assert len(calls) == 6   # the first request plus five followed hops
        assert not out.exists()

    def test_five_hops_are_allowed(self, tmp_path, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("1.2.3.4"))
        routes = {f"https://a.example.com/{i}": f"/{i + 1}" for i in range(5)}
        c, calls = self._redirecting(routes)
        fetch_image_to_path("https://a.example.com/0", tmp_path / "o.png", self.HOSTS, client=c)
        assert len(calls) == 6

    # -- never overwrites --------------------------------------------------

    def _counting_client(self, calls, content=b"NEW", mime="image/jpeg"):
        def handler(request):
            calls.append(str(request.url))
            return httpx.Response(200, headers={"content-type": mime}, content=content)
        return httpx.Client(transport=httpx.MockTransport(handler))

    def test_existing_target_refused_and_nothing_fetched_or_written(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("91.198.174.192"))
        out = tmp_path / "taken.jpg"
        out.write_bytes(b"KEEP")
        calls = []
        with pytest.raises(SystemExit):
            fetch_image_to_path("https://upload.wikimedia.org/test.jpg", out, self.HOSTS,
                                client=self._counting_client(calls))
        err = json.loads(capsys.readouterr().err)
        assert err["error"] == "out_exists" and str(out) not in err["message"]
        assert out.read_bytes() == b"KEEP"
        assert calls == []

    def test_link_at_target_refused_and_its_target_untouched(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("91.198.174.192"))
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        dangling = tmp_path / "dangling.jpg"
        dangling.symlink_to(elsewhere / "made-through-link.sh")
        live_target = elsewhere / "rc"
        live_target.write_bytes(b"KEEP")
        live = tmp_path / "live.jpg"
        live.symlink_to(live_target)
        calls = []
        for out in (dangling, live):
            with pytest.raises(SystemExit):
                fetch_image_to_path("https://upload.wikimedia.org/test.jpg", out, self.HOSTS,
                                    client=self._counting_client(calls))
            assert json.loads(capsys.readouterr().err)["error"] == "out_exists"
        assert not (elsewhere / "made-through-link.sh").exists()
        assert live_target.read_bytes() == b"KEEP"
        assert calls == []

    def test_failed_fetch_removes_only_the_file_it_made(self, tmp_path, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("91.198.174.192"))

        def handler(request):
            raise httpx.ConnectTimeout("slow", request=request)

        out = tmp_path / "new.jpg"
        neighbour = tmp_path / "neighbour.jpg"
        neighbour.write_bytes(b"KEEP")
        with pytest.raises(SystemExit):
            fetch_image_to_path("https://upload.wikimedia.org/test.jpg", out, self.HOSTS,
                                client=httpx.Client(transport=httpx.MockTransport(handler)))
        assert not out.exists()
        assert neighbour.read_bytes() == b"KEEP"


# ---------------------------------------------------------------------------
# openverse_search (keyless)
# ---------------------------------------------------------------------------

# Shape per Openverse's v1 API docs (api.openverse.org/v1/images/); hand-written, not a capture.
_OPENVERSE = {"results": [
    {"title": "Red fox", "url": "https://live.staticflickr.com/1/fox.jpg", "creator": "A. Person",
     "license": "by-sa", "license_version": "4.0", "foreign_landing_url": "https://www.flickr.com/photos/1/2",
     "width": 4000, "height": 3000, "thumbnail": "https://api.openverse.org/v1/images/x/thumb/",
     "source": "flickr", "provider": "flickr", "filetype": "jpg"},
    {"title": "Plain", "url": "https://upload.wikimedia.org/p.png", "creator": None,
     "license": "cc0", "license_version": "1.0", "foreign_landing_url": "https://commons.wikimedia.org/wiki/File:p.png",
     "width": 10, "height": 10, "thumbnail": None, "filetype": "png"},
    {"title": "Old", "url": "https://x.example.com/o.jpg", "creator": "Z", "license": "pdm",
     "license_version": "1.0", "foreign_landing_url": "http://x.example.com/page", "filetype": None},
    {"title": "Insecure", "url": "http://x.example.com/i.jpg", "license": "by", "license_version": "2.0"},
]}


class TestOpenverseSearch:
    def test_mapping_and_licence_strings(self):
        seen = {}

        def handler(request):
            seen["url"] = request.url
            seen["headers"] = request.headers
            return httpx.Response(200, json=_OPENVERSE)
        r = openverse_search("fox", limit=10, client=httpx.Client(transport=httpx.MockTransport(handler)))
        assert [x["license"] for x in r] == ["CC BY-SA 4.0", "CC0 1.0", "PDM 1.0"]   # http result dropped
        a = r[0]
        assert (a["title"], a["artist"], a["source"], a["mime"]) == ("Red fox", "A. Person", "openverse", "image/jpeg")
        assert (a["width"], a["height"]) == (4000, 3000)
        assert a["pageUrl"] == "https://www.flickr.com/photos/1/2" and a["thumbnail"].startswith("https://")
        assert r[1]["artist"] is None and r[1]["mime"] == "image/png"
        assert r[2]["pageUrl"] == "http://x.example.com/page"   # a page is only recorded, never fetched: http is fine
        assert seen["url"].params["q"] == "fox" and seen["url"].host == "api.openverse.org"
        assert "authorization" not in seen["headers"]

    def test_limit_applies_after_filtering(self):
        c = httpx.Client(transport=_json_transport(_OPENVERSE))
        assert len(openverse_search("fox", limit=2, client=c)) == 2

    def test_one_request_and_page_size_capped(self):
        calls = []

        def handler(request):
            calls.append(request.url.params["page_size"])
            return httpx.Response(200, json={"results": []})
        openverse_search("x", limit=30, client=httpx.Client(transport=httpx.MockTransport(handler)))
        assert calls == ["20"]

    def test_rate_limit_is_plain(self):
        c = httpx.Client(transport=_json_transport({"detail": "slow down"}, status=429))
        with pytest.raises(ValueError, match="rate limit"):
            openverse_search("x", client=c)


# ---------------------------------------------------------------------------
# logo_search (keyless): a brand's declared icons
# ---------------------------------------------------------------------------

_HOME = """<!doctype html><html><head>
<meta property="og:image" content="/og.png">
<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png">
<link rel="shortcut icon" href="/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-180.png">
<link rel="apple-touch-icon" sizes="120x120" href="https://cdn.example.com/apple-120.png">
<link rel="mask-icon" href="/mask.svg">
<link rel="icon" href="http://insecure.example.com/x.png">
<link rel="manifest" href="/site.webmanifest">
</head><body>ignored</body></html>"""
_MANIFEST = {"icons": [{"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
                       {"src": "/icon-512.png", "sizes": "512x512"}]}


def _site_client(home=_HOME, manifest=_MANIFEST, redirect_to=None):
    calls = []

    def handler(request):
        u = str(request.url)
        calls.append(u)
        if redirect_to and u == "https://brand.example/":
            return httpx.Response(301, headers={"location": redirect_to})
        if u.endswith("/site.webmanifest"):
            return httpx.Response(200, headers={"content-type": "application/manifest+json"}, json=manifest)
        return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, content=home.encode())
    return httpx.Client(transport=httpx.MockTransport(handler)), calls


class TestLogoSearch:
    @pytest.fixture(autouse=True)
    def _public(self, monkeypatch):
        monkeypatch.delenv("MONTAJ_IMAGE_HOST_STRICT", raising=False)
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("1.2.3.4"))

    def test_order_resolution_and_fallback(self):
        c, calls = _site_client()
        r = logo_search("brand.example", client=c)
        assert [x["url"] for x in r] == [
            "https://brand.example/apple-180.png",        # apple-touch-icon, biggest first
            "https://cdn.example.com/apple-120.png",
            "https://brand.example/favicon-32.png",       # icons, biggest first (http one dropped)
            "https://brand.example/favicon-16.png",
            "https://brand.example/mask.svg",
            "https://brand.example/icon-512.png",         # manifest icons, relative to the manifest
            "https://brand.example/icon-192.png",
            "https://brand.example/og.png",               # og:image last of the site's own
            "https://www.google.com/s2/favicons?domain=brand.example&sz=256",
        ]
        assert r[0]["width"] == 180 and r[0]["license"] == "trademark" and r[0]["source"] == "site"
        assert r[2]["mime"] is None or r[2]["mime"] == "image/png"
        assert r[3]["mime"] == "image/png"
        assert r[-1]["source"] == "favicon" and r[-1]["width"] == 256
        assert all(x["url"].startswith("https://") for x in r)
        assert r[0]["pageUrl"] == "https://brand.example/"
        assert len(calls) == 2   # homepage, manifest

    def test_url_query_and_limit(self):
        c, calls = _site_client()
        r = logo_search("https://brand.example/about?x=1", limit=2, client=c)
        assert len(r) == 2 and calls[0] == "https://brand.example/about?x=1"

    def test_http_query_is_upgraded(self):
        c, calls = _site_client()
        logo_search("http://brand.example", client=c)
        assert calls[0].startswith("https://")

    def test_relative_hrefs_resolve_against_the_final_url(self):
        c, _ = _site_client(redirect_to="https://www.brand.example/home/")
        r = logo_search("brand.example", client=c)
        assert r[0]["url"] == "https://www.brand.example/apple-180.png"

    def test_no_icons_still_gives_the_favicon_service(self):
        c, _ = _site_client(home="<html><head></head></html>")
        r = logo_search("brand.example", client=c)
        assert [x["source"] for x in r] == ["favicon"]

    def test_homepage_read_is_capped(self):
        big = "<html><head>" + "<!-- x -->" * 300_000 + '<link rel="icon" href="/late.png"></head>'
        c, _ = _site_client(home=big)
        r = logo_search("brand.example", client=c)
        assert all("late.png" not in x["url"] for x in r)

    @pytest.mark.parametrize("q", ["stripe", "Stripe Inc", "", "localhost"])
    def test_bare_word_is_an_error_naming_the_fix(self, q):
        c, calls = _site_client()
        with pytest.raises(ValueError, match="domain"):
            logo_search(q, client=c)
        assert calls == []

    def test_private_host_homepage_refused(self, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", _mock_getaddrinfo("192.168.1.9"))
        c, calls = _site_client()
        with pytest.raises(ValueError, match="host_not_public"):
            logo_search("intranet.example", client=c)
        assert calls == []

    def test_homepage_redirect_to_private_host_refused(self, monkeypatch):
        def gai(host, *a, **k):
            return [(None, None, None, None, ("10.1.1.1" if host == "internal.example" else "1.2.3.4", 0))]
        monkeypatch.setattr(socket, "getaddrinfo", gai)
        c, calls = _site_client(redirect_to="https://internal.example/")
        with pytest.raises(ValueError, match="host_not_public"):
            logo_search("brand.example", client=c)
        assert calls == ["https://brand.example/"]

    def test_manifest_on_a_private_host_is_skipped_not_fetched(self, monkeypatch):
        def gai(host, *a, **k):
            return [(None, None, None, None, ("10.1.1.1" if host == "m.internal" else "1.2.3.4", 0))]
        monkeypatch.setattr(socket, "getaddrinfo", gai)
        home = '<link rel="manifest" href="https://m.internal/site.webmanifest"><link rel="icon" href="/a.png" sizes="64x64">'
        c, calls = _site_client(home=home)
        r = logo_search("brand.example", client=c)
        assert calls == ["https://brand.example/"] and r[0]["url"] == "https://brand.example/a.png"
