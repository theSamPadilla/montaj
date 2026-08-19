#!/usr/bin/env python3
"""Search Google News RSS for recent articles.

Exists because Hub's own egress (Google Cloud) is refused by Google News with
a 503, while this sidecar's egress is not. Hub calls this step instead of
fetching the feed itself; the returned shape is Hub's `NewsItem` contract, so
Hub maps it through unchanged.
"""
import argparse
import html
import json
import os
import re
import sys
from datetime import timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlencode, urlparse
from xml.etree import ElementTree

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail  # noqa: E402

BASE_URL = "https://news.google.com/rss/search"
MAX_SNIPPET_LEN = 280
TIMEOUT = 15.0
UA = "montaj-search-news/1.0"

DC = "{http://purl.org/dc/elements/1.1/}"
_TAG_RE = re.compile(r"<[^>]+>")


def build_url(query: str) -> str:
    return f"{BASE_URL}?{urlencode({'q': query, 'hl': 'en-US'})}"


def _text(node, tag: str) -> str | None:
    el = node.find(tag)
    return el.text.strip() if el is not None and el.text else None


def _plain(raw: str | None) -> str | None:
    """Google News <description> is an HTML <a> blob (and, for story clusters,
    an <ol> of related headlines). Strip to plain text before truncating —
    otherwise the 280-char snippet is entirely consumed by a redirect href."""
    if not raw:
        return None
    text = html.unescape(_TAG_RE.sub(" ", raw))
    text = " ".join(text.split())  # collapses \xa0 from &nbsp; too
    return text or None


def _iso(pub_date: str | None) -> str | None:
    """RFC-2822 pubDate -> ISO-8601 UTC. Returns None if unparseable."""
    if not pub_date:
        return None
    try:
        dt = parsedate_to_datetime(pub_date)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _source(item) -> str | None:
    """<source> name, then dc:creator, then the link's domain."""
    src = item.find("source")
    if src is not None and src.text and src.text.strip():
        return src.text.strip()
    creator = _text(item, f"{DC}creator")
    if creator:
        return creator
    link = _text(item, "link")
    if link:
        try:
            return urlparse(link).hostname.removeprefix("www.")
        except (ValueError, AttributeError):
            return None
    return None


def parse_feed(body: str, limit: int) -> list[dict]:
    try:
        root = ElementTree.fromstring(body)
    except ElementTree.ParseError as e:
        # Google returns an HTML interstitial instead of RSS when it throttles.
        raise ValueError(f"unparseable_feed: {e}") from e

    if root.tag != "rss":
        # Well-formed XML (or HTML) but not an RSS feed — same throttle/block
        # signal as a ParseError, just one that parses successfully.
        raise ValueError(f"unparseable_feed: root element is <{root.tag}>, expected <rss>")

    items = []
    for item in root.iterfind("./channel/item"):
        title = _text(item, "title")
        if not title:
            continue  # title is non-nullable in the Hub contract
        snippet = _plain(_text(item, "description"))
        items.append(
            {
                "title": title,
                "link": _text(item, "link") or "",
                "pubDate": _iso(_text(item, "pubDate")),
                "source": _source(item),
                "snippet": snippet[:MAX_SNIPPET_LEN] if snippet else None,
            }
        )
        if len(items) >= limit:
            break
    return items


def main():
    p = argparse.ArgumentParser(description="Search Google News RSS")
    p.add_argument("--query", required=True, help="Search query")
    p.add_argument("--limit", type=int, default=25, help="Max items (1-50)")
    args = p.parse_args()

    limit = max(1, min(args.limit, 50))

    # `fail()` prints structured JSON to stderr and sys.exit(1)s — no return needed.
    try:
        resp = httpx.get(
            build_url(args.query),
            timeout=TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": UA},
        )
    except httpx.HTTPError as e:
        fail("upstream_unavailable", f"News fetch failed: {e}")

    if resp.status_code != 200:
        fail("upstream_unavailable", f"News upstream returned {resp.status_code}")

    try:
        items = parse_feed(resp.text, limit)
    except ValueError as e:
        fail("upstream_unavailable", str(e))

    print(json.dumps({"items": items}))


if __name__ == "__main__":
    main()
