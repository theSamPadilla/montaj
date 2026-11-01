"""Licensed-image search and safe image fetch helpers.

Provides:
  - commons_search(query, limit, client)  — Wikimedia Commons API
  - sportsdb_badge(team, client)          — TheSportsDB badge API
  - openverse_search(query, limit, client) — Openverse (keyless, openly licensed)
  - logo_search(query, limit, client)     — a brand's own icons from its domain (keyless)
  - fetch_image_to_path(url, out, hosts, client) — safe image download
  - allowed_image_hosts()                 — merged allowlist
  - is_public_host(hostname)              — rejects RFC-1918 / loopback / link-local
  - preflight_image_url(url, hosts)       — composed pre-flight check
"""
import contextlib
import ipaddress
import json
import mimetypes
import os
import re
import socket
import sys
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

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
_OPENVERSE_API = "https://api.openverse.org/v1/images/"
_FAVICON_SERVICE = "https://www.google.com/s2/favicons"
_MAX_REDIRECTS = 5
_HTML_MAX_BYTES = 1_048_576       # a homepage is untrusted: read no more than this
_MANIFEST_MAX_BYTES = 262_144
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
# Redirects, followed by hand
# ---------------------------------------------------------------------------

class FetchRefused(Exception):
    """A fetch the safety checks refused: `code` is the step error code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


@contextlib.contextmanager
def stream_following(c: httpx.Client, url: str, hosts: set[str]):
    """Yield (response, final_url) for a GET of *url*, following redirects by hand.

    The client never follows (follow_redirects=False per request, even for an
    injected client built with True): a followed redirect would connect before
    any host check, which is the SSRF the pre-flight exists to stop. So each
    hop's Location is resolved against the current URL and put through the same
    preflight_image_url as the first (HTTPS, allowlist if strict, public host)
    before it is requested. The first URL is the caller's to have checked.
    At most _MAX_REDIRECTS hops, then `too_many_redirects`. A refused hop raises
    FetchRefused("url_rejected", <preflight code>), as the first URL would."""
    cur = url
    with contextlib.ExitStack() as stack:
        for hop in range(_MAX_REDIRECTS + 1):
            try:
                resp = stack.enter_context(
                    c.stream("GET", cur, headers={"User-Agent": _UA}, follow_redirects=False))
            except httpx.InvalidURL as exc:    # a Location like "https:host/x" gets past the checks and httpx refuses it
                raise FetchRefused("url_rejected", f"Malformed URL in a redirect: {str(exc)[:120]}")
            except httpx.RemoteProtocolError as exc:    # httpx's own parse of a Location ("...:bad/x", a control character)
                if "Invalid URL" not in str(exc):
                    raise
                raise FetchRefused("url_rejected", f"Malformed URL in a redirect: {str(exc)[:120]}")
            if not resp.is_redirect:
                yield resp, cur
                return
            if hop == _MAX_REDIRECTS:
                break
            try:
                nxt = urljoin(cur, resp.headers.get("location", "")).split("#", 1)[0]
                err = preflight_image_url(nxt, hosts)
            except ValueError as exc:    # a Location urllib cannot parse (a bad IPv6 literal)
                raise FetchRefused("url_rejected", f"Malformed redirect Location: {str(exc)[:120]}")
            if err:
                raise FetchRefused("url_rejected", err)
            resp.close()
            cur = nxt
    raise FetchRefused("too_many_redirects", f"More than {_MAX_REDIRECTS} redirects: {url}")


# ---------------------------------------------------------------------------
# Wikimedia Commons search
# ---------------------------------------------------------------------------

def _is_page_url(value) -> bool:
    # A page is only recorded, never fetched, so http is fine.
    return isinstance(value, str) and value.startswith(("https://", "http://"))


def commons_search(
    query: str,
    limit: int = 10,
    client: httpx.Client | None = None,
) -> list[dict]:
    """Search Wikimedia Commons for freely-licensed images.

    Returns a list of dicts with keys:
      title, url, width, height, mime, license, artist, source, and pageUrl
      (the file's description page) when the API gives it
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

        result = {
            "title": page.get("title", ""),
            "url": url,
            "width": ii.get("width"),
            "height": ii.get("height"),
            "mime": mime,
            "license": license_val,
            "artist": artist,
            "source": "commons",
        }
        # iiprop=url also gives `descriptionurl`, the File: page (MediaWiki API, prop=imageinfo).
        if _is_page_url(ii.get("descriptionurl")):
            result["pageUrl"] = ii["descriptionurl"]
        results.append(result)
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
# Openverse (keyless, openly licensed photos and illustrations)
# ---------------------------------------------------------------------------

def _openverse_licence(lic, version) -> str:
    """Openverse's ("by-sa", "4.0") as the usual "CC BY-SA 4.0"; cc0 and pdm are
    not "CC <x>" ("CC0 1.0", "PDM 1.0")."""
    lic = (lic or "").strip().lower()
    if not lic:
        return "unknown"
    name = lic.upper() if lic in ("cc0", "pdm") else "CC " + lic.upper()
    return f"{name} {version}".strip() if version else name


def openverse_search(
    query: str,
    limit: int = 10,
    client: httpx.Client | None = None,
) -> list[dict]:
    """Search Openverse (api.openverse.org/v1/images, no key, no auth header).

    Same result shape as commons_search plus `thumbnail` and `pageUrl` (the
    work's own page, `foreign_landing_url`). One request per search: anonymous
    use is rate limited (429 raises a plain-language ValueError). Only HTTPS
    originals are kept so fetch_image accepts them. Anonymous page_size tops
    out at 20."""
    own_client = client is None
    c = _make_client(client)
    try:
        resp = c.get(
            _OPENVERSE_API,
            params={"q": query, "page_size": str(min(max(1, limit), 20))},
            headers={"User-Agent": _UA},
            follow_redirects=True,   # our own constant API endpoint, not an agent-supplied URL
        )
        if resp.status_code == 429:
            raise ValueError("openverse rate limit reached (anonymous use); wait a minute and retry")
        resp.raise_for_status()
        data = resp.json()
    finally:
        if own_client:
            c.close()

    results: list[dict] = []
    for r in (data.get("results") or []):
        url = (r.get("url") or "").strip()
        if not url.startswith("https://"):
            continue
        ft = (r.get("filetype") or "").strip().lower()
        result = {
            "title": r.get("title") or "",
            "url": url,
            "width": r.get("width"),
            "height": r.get("height"),
            "mime": (mimetypes.guess_type(f"x.{ft}")[0] if ft else None)
                    or mimetypes.guess_type(urlparse(url).path)[0],
            "license": _openverse_licence(r.get("license"), r.get("license_version")),
            "artist": r.get("creator") or None,
            "source": "openverse",
            "thumbnail": r.get("thumbnail"),
        }
        if _is_page_url(r.get("foreign_landing_url")):
            result["pageUrl"] = r["foreign_landing_url"]
        results.append(result)
        if len(results) >= limit:
            break
    return results


# ---------------------------------------------------------------------------
# Brand logo by domain (keyless): the site's own declared icons
# ---------------------------------------------------------------------------

class _IconParser(HTMLParser):
    """Collects <link rel=icon|apple-touch-icon|mask-icon|manifest> and og:image."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links: list[dict] = []
        self.og_image: str | None = None
        self.manifest: str | None = None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "link" and a.get("href"):
            rels = a.get("rel", "").lower().split()
            if "manifest" in rels:
                self.manifest = self.manifest or a["href"]
            elif "apple-touch-icon" in rels or "apple-touch-icon-precomposed" in rels:
                self.links.append({"group": 0, **a})
            elif "icon" in rels:   # also "shortcut icon"
                self.links.append({"group": 1, **a})
            elif "mask-icon" in rels:
                self.links.append({"group": 2, **a})
        elif tag == "meta" and a.get("content") and self.og_image is None:
            if (a.get("property") or a.get("name") or "").lower() == "og:image":
                self.og_image = a["content"]


def _largest_size(sizes: str) -> int | None:
    """Biggest edge of a `sizes` value ("16x16 32x32"); None for "any" or none."""
    best = None
    for m in re.finditer(r"(\d+)\s*x\s*(\d+)", (sizes or "").lower()):
        best = max(best or 0, int(m.group(1)), int(m.group(2)))
    return best


def _logo_target(query: str) -> tuple[str, str]:
    """(homepage URL, hostname) from a domain or URL, or ValueError."""
    q = (query or "").strip()
    host = urlparse(q if "://" in q else "https://" + q).hostname or ""
    if not q or " " in q or "." not in host:
        raise ValueError(f"logo search needs a brand's domain or URL, like stripe.com (got {query!r}); pass the domain, not the name")
    parsed = urlparse(q if "://" in q else "https://" + q)
    # http becomes https: the page is fetched over HTTPS only.
    return parsed._replace(scheme="https", fragment="", path=parsed.path or "/").geturl(), host


def _fetch_text(c: httpx.Client, url: str, max_bytes: int, hosts: set[str]) -> tuple[str, str]:
    """(text, final URL) of an untrusted page: public hosts only, redirects by
    hand, at most max_bytes read. FetchRefused when a safety check says no."""
    err = preflight_image_url(url, hosts)
    if err:
        raise FetchRefused("url_rejected", err)
    with stream_following(c, url, hosts) as (resp, final):
        if resp.status_code < 200 or resp.status_code >= 300:
            raise FetchRefused("upstream_error", f"{final} returned {resp.status_code}")
        buf = b""
        for chunk in resp.iter_bytes():
            buf += chunk
            if len(buf) >= max_bytes:
                buf = buf[:max_bytes]   # an icon list is in the head; the rest is not needed
                break
        return buf.decode(resp.encoding or "utf-8", errors="replace"), final


def logo_search(
    query: str,
    limit: int = 10,
    client: httpx.Client | None = None,
) -> list[dict]:
    """A brand's own logo candidates from its domain, best first.

    The homepage's declared icons: apple-touch-icon, icon, mask-icon (each
    biggest first), the web app manifest's icons, then og:image; then the
    favicon service at 256 px. Same result shape as commons_search with
    license "trademark" (the brand owns it) and source "site", or "favicon"
    for the service. Homepage and manifest are untrusted fetches (public
    hosts, HTTPS, redirects by hand, size-capped); a homepage that cannot be
    fetched (refused, redirected away, timed out) still yields the favicon
    service, with a note saying why."""
    home, host = _logo_target(query)
    hosts = allowed_image_hosts()
    own_client = client is None
    c = _make_client(client)
    note = None
    try:
        try:
            html, page = _fetch_text(c, home, _HTML_MAX_BYTES, hosts)
        except FetchRefused as exc:
            # A refused or failed homepage (a redirect to http, too many redirects, a host the checks refuse) still
            # gets the favicon service, a fixed Google host that is safe whatever the site did; the note says why.
            html, page = "", home
            note = f"homepage not read ({exc.code}: {exc.message[:100]}); the favicon service only"
        except httpx.HTTPError as exc:
            html, page = "", home
            note = f"homepage not read ({type(exc).__name__}); the favicon service only"
        parser = _IconParser()
        parser.feed(html)
        parser.close()

        def https(href):
            u = urljoin(page, href.strip()).split("#", 1)[0]
            return u if u.startswith("https://") else None

        found: list[tuple[int, int, dict]] = []   # (group, -size, result)

        def add(group, href, sizes, mime, label):
            u = https(href)
            if not u:
                return
            size = _largest_size(sizes)
            found.append((group, -(size or 0), {
                "title": f"{host} {label}", "url": u,
                "width": size, "height": size,
                "mime": mime or mimetypes.guess_type(urlparse(u).path)[0],
                "license": "trademark", "artist": None, "source": "site", "pageUrl": page,
            }))

        for ln in parser.links:
            add(ln["group"], ln["href"], ln.get("sizes"), ln.get("type") or None,
                ("apple-touch-icon", "icon", "mask-icon")[ln["group"]])
        if parser.manifest:
            try:
                murl = https(parser.manifest)
                text, mfinal = _fetch_text(c, murl, _MANIFEST_MAX_BYTES, hosts) if murl else ("", page)
                icons = json.loads(text).get("icons") if text else None
                for ic in (icons if isinstance(icons, list) else []):
                    if isinstance(ic, dict) and isinstance(ic.get("src"), str):
                        u = urljoin(mfinal, ic["src"]).split("#", 1)[0]
                        size = _largest_size(ic.get("sizes"))
                        if u.startswith("https://"):
                            found.append((3, -(size or 0), {
                                "title": f"{host} manifest icon", "url": u, "width": size, "height": size,
                                "mime": ic.get("type") or mimetypes.guess_type(urlparse(u).path)[0],
                                "license": "trademark", "artist": None, "source": "site", "pageUrl": page,
                            }))
            except (FetchRefused, httpx.HTTPError, ValueError, AttributeError, RecursionError):
                pass   # a hostile manifest (nested past the parser's depth) is skipped; the manifest is a bonus; its failure never fails the search
        if parser.og_image:
            add(4, parser.og_image, None, None, "og:image")
    finally:
        if own_client:
            c.close()

    found.sort(key=lambda t: (t[0], t[1]))   # stable: page order within a size
    results, seen = [], set()
    for _g, _s, r in found:
        if r["url"] not in seen:
            seen.add(r["url"])
            results.append(r)
    results.append({
        "title": f"{host} favicon", "url": f"{_FAVICON_SERVICE}?domain={host}&sz=256",
        "width": 256, "height": 256, "mime": "image/png",
        "license": "trademark", "artist": None, "source": "favicon", "pageUrl": page,
        **({"note": note} if note else {}),
    })
    return results[:limit]


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

    Returns the same dict shape as commons_search (plus a `thumbnail`, and
    `pageUrl`, the page the image is on, from the result's `link`). License
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
        result = {
            "title": r.get("title") or "",
            "url": url,
            "width": r.get("original_width"),
            "height": r.get("original_height"),
            "mime": mimetypes.guess_type(urlparse(url).path)[0],
            "license": "unknown",
            "artist": (r.get("source") or None),
            "source": "web",
            "thumbnail": r.get("thumbnail"),
        }
        # `link` is the page the image was found on (SerpApi Google Images API, images_results).
        if _is_page_url(r.get("link")):
            result["pageUrl"] = r["link"]
        results.append(result)
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
    info: dict | None = None,
) -> Path:
    """Fetch *url* to *out*, enforcing safety checks.

    *out* must not exist: it is created exclusively (never through a link)
    before anything is fetched, so an existing file is never replaced or
    deleted (`out_exists`, nothing fetched). On any failure the file this call
    created is removed.

    Redirects are followed by hand (stream_following): every hop gets the full
    pre-flight, at most 5. *info*, when given, receives `finalUrl`.

    Raises SystemExit(1) via fail() on any violation (mirrors step convention).
    Returns *out* resolved as an absolute Path on success.
    """
    # Import fail here to avoid circular imports at module level.
    from common import fail

    err = preflight_image_url(url, hosts)
    if err:
        fail("url_rejected", err)

    # Absolute but not resolved: the last component is created as itself, so a
    # link already at *out* is refused as existing rather than followed.
    out = Path(os.path.abspath(out))
    out.parent.mkdir(parents=True, exist_ok=True)
    flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL
             | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    try:
        fd = os.open(out, flags, 0o644)
    except FileExistsError:
        fail("out_exists", "out already exists; fetch_image never replaces a file. Choose a new name.")
    except OSError as exc:
        fail("write_error", str(exc))

    done = False
    own_client = client is None
    c = None
    try:
        with os.fdopen(fd, "wb") as fh:
            c = _make_client(client)
            with stream_following(c, url, hosts) as (resp, final):
                if info is not None:
                    info["finalUrl"] = final
                if resp.status_code < 200 or resp.status_code >= 300:
                    fail("upstream_error", f"Upstream returned {resp.status_code}")

                ct = resp.headers.get("content-type", "")
                if not ct.split(";")[0].strip().lower().startswith("image/"):
                    fail("not_an_image", f"Expected image/*, got {ct!r}")

                count = 0
                for chunk in resp.iter_bytes():
                    count += len(chunk)
                    if count > max_bytes:
                        fail("too_large", f"Response exceeded {max_bytes} bytes")
                    try:
                        fh.write(chunk)
                    except OSError as exc:
                        fail("write_error", str(exc))
        done = True
    except FetchRefused as exc:
        fail(exc.code, exc.message)
    except httpx.TimeoutException as exc:
        fail("timeout", str(exc))
    except httpx.TransportError as exc:
        fail("network_error", str(exc))
    except OSError as exc:
        fail("write_error", str(exc))
    finally:
        if not done:
            # Only ever the file this call created above.
            out.unlink(missing_ok=True)
        if own_client and c is not None:
            c.close()

    return out.resolve()
