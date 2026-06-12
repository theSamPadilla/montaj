"""Licensed-image search and safe image fetch helpers.

Provides:
  - commons_search(query, limit, client)  — Wikimedia Commons API
  - sportsdb_badge(team, client)          — TheSportsDB badge API
  - fetch_image_to_path(url, out, hosts, client) — safe image download
  - allowed_image_hosts()                 — merged allowlist
  - is_public_host(hostname)              — rejects RFC-1918 / loopback / link-local
  - preflight_image_url(url, hosts)       — composed pre-flight check
"""
import ipaddress
import mimetypes
import os
import re
import socket
import sys
from pathlib import Path
from urllib.parse import urlparse

import httpx

# Make lib/ importable when called from step scripts.
_LIB_DIR = Path(__file__).resolve().parent
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

from remote_io import _TIMEOUT, parse_allowed_hosts

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_IMAGE_HOSTS: set[str] = {
    "upload.wikimedia.org",
    "commons.wikimedia.org",
    "www.thesportsdb.com",
    "r2.thesportsdb.com",
}

_COMMONS_API = "https://commons.wikimedia.org/w/api.php"
_SPORTSDB_API = "https://www.thesportsdb.com/api/v1/json/3/searchteams.php"
_SERPAPI_URL = "https://serpapi.com/search.json"
_UA = "Montaj/1 (image_sources; +https://github.com/bycrux/montaj)"

# Strip HTML tags from artist strings.
_TAG_RE = re.compile(r"<[^>]+>")


# ---------------------------------------------------------------------------
# Host helpers
# ---------------------------------------------------------------------------

def allowed_image_hosts() -> set[str]:
    """Return DEFAULT_IMAGE_HOSTS merged with MONTAJ_HTTP_ALLOWED_HOSTS env var.

    Only consulted when strict mode is on (see host_allowlist_strict). In the
    default permissive mode the explicit allowlist is irrelevant — any public
    host is fetchable — so this is kept for strict deployments and tests.
    """
    return DEFAULT_IMAGE_HOSTS | parse_allowed_hosts()


def host_allowlist_strict() -> bool:
    """Whether to gate fetches on the explicit host allowlist.

    Default OFF: any public HTTPS host is fetchable. The real SSRF protection
    is is_public_host() (blocks loopback/private/link-local/non-global IPs),
    plus the HTTPS-only, image-content-type, and size-cap checks downstream —
    those always apply. The host allowlist was belt-and-suspenders; gating on
    it kept legitimate press/news/CDN photos out, so it's opt-in now.

    Set MONTAJ_IMAGE_HOST_STRICT=1 (or true/yes) to re-enable the allowlist
    gate for a locked-down deployment — no code change needed to tighten.
    """
    return os.environ.get("MONTAJ_IMAGE_HOST_STRICT", "").strip().lower() in ("1", "true", "yes")


def is_public_host(hostname: str) -> bool:
    """Resolve *hostname* and verify every address is publicly routable.

    Returns False if:
      - DNS resolution fails
      - any resolved IP is loopback, private, link-local, or otherwise
        "not global" according to ipaddress module
    """
    try:
        results = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return False
    if not results:
        return False
    for _family, _type, _proto, _canonname, sockaddr in results:
        addr_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(addr_str)
        except ValueError:
            return False
        if not ip.is_global:
            return False
    return True


def preflight_image_url(url: str, hosts: set[str]) -> str | None:
    """Return error-code string if URL fails pre-flight; None if OK.

    Checks (in order):
      1. HTTPS only
      2. Hostname present (malformed URLs rejected)
      3. Hostname in allowlist — ONLY in strict mode (host_allowlist_strict)
      4. Hostname resolves to public IPs only (the real SSRF guard, always on)
    """
    if not isinstance(url, str) or not url.startswith("https://"):
        return "not_https"
    hostname = (urlparse(url).hostname or "").lower()
    if not hostname:
        return "host_not_allowed"
    if host_allowlist_strict() and hostname not in hosts:
        return "host_not_allowed"
    if not is_public_host(hostname):
        return "host_not_public"
    return None


# ---------------------------------------------------------------------------
# HTTP client helper
# ---------------------------------------------------------------------------

def _make_client(client: httpx.Client | None = None) -> httpx.Client:
    if client is not None:
        return client
    return httpx.Client(
        timeout=_TIMEOUT,
        follow_redirects=False,
        headers={"User-Agent": _UA},
    )


# ---------------------------------------------------------------------------
# Wikimedia Commons search
# ---------------------------------------------------------------------------

def commons_search(
    query: str,
    limit: int = 10,
    client: httpx.Client | None = None,
) -> list[dict]:
    """Search Wikimedia Commons for freely-licensed images.

    Returns a list of dicts with keys:
      title, url, width, height, mime, license, artist, source
    """
    own_client = client is None
    c = _make_client(client)
    try:
        resp = c.get(
            _COMMONS_API,
            params={
                "action": "query",
                "generator": "search",
                "gsrsearch": query,
                "gsrnamespace": "6",          # File namespace
                "gsrlimit": str(min(limit, 50)),
                "prop": "imageinfo",
                "iiprop": "url|size|mime|extmetadata",
                "iiextmetadatafilter": "LicenseShortName|Artist",
                "format": "json",
                "formatversion": "2",
            },
            headers={"User-Agent": _UA},
        )
        resp.raise_for_status()
        data = resp.json()
    finally:
        if own_client:
            c.close()

    pages = (
        data.get("query", {}).get("pages") or []
    )

    results: list[dict] = []
    for page in pages:
        ii_list = page.get("imageinfo") or []
        if not ii_list:
            continue
        ii = ii_list[0]
        mime = ii.get("mime", "")
        # Skip non-image mimes; skip SVG (not useful for raster compositing)
        if not mime.startswith("image/"):
            continue
        if mime == "image/svg+xml":
            continue

        ext = ii.get("extmetadata") or {}
        license_val = (ext.get("LicenseShortName") or {}).get("value", "unknown")
        artist_raw = (ext.get("Artist") or {}).get("value", "")
        artist = _TAG_RE.sub("", artist_raw).strip()

        url = ii.get("url", "")
        if not url:
            continue

        results.append({
            "title": page.get("title", ""),
            "url": url,
            "width": ii.get("width"),
            "height": ii.get("height"),
            "mime": mime,
            "license": license_val,
            "artist": artist,
            "source": "commons",
        })
        if len(results) >= limit:
            break

    return results


# ---------------------------------------------------------------------------
# TheSportsDB badge search
# ---------------------------------------------------------------------------

def sportsdb_badge(
    team: str,
    client: httpx.Client | None = None,
) -> list[dict]:
    """Look up team badge URLs from TheSportsDB.

    Returns a list of dicts (same shape as commons_search results) for Soccer
    entries that have a badge URL. The badge URL is used as-is (no /preview
    suffix).
    """
    own_client = client is None
    c = _make_client(client)
    try:
        resp = c.get(
            _SPORTSDB_API,
            params={"t": team},
            headers={"User-Agent": _UA},
        )
        resp.raise_for_status()
        data = resp.json()
    finally:
        if own_client:
            c.close()

    teams = data.get("teams") or []
    results: list[dict] = []
    for t in teams:
        if (t.get("strSport") or "").strip().lower() != "soccer":
            continue
        badge = (t.get("strBadge") or "").strip()
        if not badge:
            continue
        results.append({
            "title": t.get("strTeam", ""),
            "url": badge,
            "width": None,
            "height": None,
            "mime": "image/png",
            "license": "editorial",
            "artist": None,
            "source": "sportsdb",
        })
    return results


# ---------------------------------------------------------------------------
# Open-web image search (SerpApi / Google Images) — keyed
# ---------------------------------------------------------------------------

def serpapi_image_search(
    query: str,
    api_key: str,
    limit: int = 10,
    client: httpx.Client | None = None,
) -> list[dict]:
    """Search the open web for images via SerpApi's google_images engine.

    Returns the same dict shape as commons_search (plus a `thumbnail`). License
    is reported as "unknown" — web results are NOT license-filtered; editorial
    use is the caller's call (the account pushes licensing downstream to the
    posting platform). Only HTTPS originals are returned, so the downstream
    `fetch_image` (HTTPS-only) accepts them.

    The key is never stored on the multi-tenant sidecar — the step reads it
    from SERPAPI_API_KEY, injected per-request via credential passthrough.
    Empty key raises ValueError (caller translates to a missing-credentials
    failure).
    """
    if not api_key:
        raise ValueError("missing_serpapi_key")
    own_client = client is None
    c = client or httpx.Client(
        timeout=_TIMEOUT,
        follow_redirects=True,   # API endpoint — unlike the image fetch path
        headers={"User-Agent": _UA},
    )
    try:
        resp = c.get(
            _SERPAPI_URL,
            params={
                "engine": "google_images",
                "q": query,
                "ijn": "0",
                "api_key": api_key,
            },
        )
        resp.raise_for_status()
        data = resp.json()
    finally:
        if own_client:
            c.close()

    if isinstance(data, dict) and data.get("error"):
        # SerpApi reports invalid key / blocked query here. Surface it; the
        # run_step secret scrubber strips the key from the error if echoed.
        raise ValueError(f"serpapi: {data['error']}")

    results: list[dict] = []
    for r in (data.get("images_results") or []):
        url = (r.get("original") or "").strip()
        if not url.startswith("https://"):
            continue  # HTTPS-only so the downstream fetch_image will accept it
        results.append({
            "title": r.get("title") or "",
            "url": url,
            "width": r.get("original_width"),
            "height": r.get("original_height"),
            "mime": mimetypes.guess_type(urlparse(url).path)[0],
            "license": "unknown",
            "artist": (r.get("source") or None),
            "source": "web",
            "thumbnail": r.get("thumbnail"),
        })
        if len(results) >= limit:
            break
    return results


# ---------------------------------------------------------------------------
# Safe image fetch
# ---------------------------------------------------------------------------

def fetch_image_to_path(
    url: str,
    out: Path,
    hosts: set[str],
    max_bytes: int = 26_214_400,
    client: httpx.Client | None = None,
) -> Path:
    """Fetch *url* to *out*, enforcing safety checks.

    Raises SystemExit(1) via fail() on any violation (mirrors step convention).
    Returns *out* resolved as an absolute Path on success.
    """
    # Import fail here to avoid circular imports at module level.
    from common import fail

    err = preflight_image_url(url, hosts)
    if err:
        fail("url_rejected", err)

    out = Path(out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    own_client = client is None
    c = _make_client(client)
    try:
        # follow_redirects=False is forced per-request so an injected client
        # configured with follow_redirects=True can never silently follow a
        # redirect (which would bypass the pre-connection host checks).
        with c.stream("GET", url, headers={"User-Agent": _UA},
                      follow_redirects=False) as resp:
            if resp.is_redirect:
                fail("redirect_rejected", f"Redirect not followed: {url}")
            if resp.status_code < 200 or resp.status_code >= 300:
                fail("upstream_error", f"Upstream returned {resp.status_code}")

            ct = resp.headers.get("content-type", "")
            if not ct.split(";")[0].strip().lower().startswith("image/"):
                fail("not_an_image", f"Expected image/*, got {ct!r}")

            count = 0
            try:
                with out.open("wb") as fh:
                    for chunk in resp.iter_bytes():
                        count += len(chunk)
                        if count > max_bytes:
                            fh.close()
                            out.unlink(missing_ok=True)
                            fail("too_large", f"Response exceeded {max_bytes} bytes")
                        fh.write(chunk)
            except OSError as exc:
                out.unlink(missing_ok=True)
                fail("write_error", str(exc))
    except httpx.TimeoutException as exc:
        out.unlink(missing_ok=True)
        fail("timeout", str(exc))
    except httpx.TransportError as exc:
        out.unlink(missing_ok=True)
        fail("network_error", str(exc))
    finally:
        if own_client:
            c.close()

    return out
