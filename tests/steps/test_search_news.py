"""Unit tests for the search_news step's parsing and mapping."""
import pytest
import httpx

from steps.media.search_news import parse_feed, build_url

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <item>
      <title>First headline</title>
      <link>https://example.com/a</link>
      <pubDate>Mon, 18 Aug 2026 10:07:00 GMT</pubDate>
      <source url="https://example.com">Example News</source>
      <description>A short summary of the article.</description>
    </item>
    <item>
      <title>Second headline</title>
      <link>https://other.org/b</link>
      <pubDate>Sun, 17 Aug 2026 14:55:47 GMT</pubDate>
      <description>Another summary.</description>
    </item>
  </channel>
</rss>"""


def test_parse_feed_maps_documented_shape():
    items = parse_feed(RSS, limit=25)
    assert len(items) == 2
    first = items[0]
    assert first["title"] == "First headline"
    assert first["link"] == "https://example.com/a"
    assert first["source"] == "Example News"
    assert first["snippet"] == "A short summary of the article."
    # pubDate normalized to ISO-8601 UTC
    assert first["pubDate"] == "2026-08-18T10:07:00Z"


def test_parse_feed_falls_back_to_link_domain_for_source():
    items = parse_feed(RSS, limit=25)
    assert items[1]["source"] == "other.org"


def test_parse_feed_respects_limit():
    assert len(parse_feed(RSS, limit=1)) == 1


def test_parse_feed_drops_items_without_title():
    rss = RSS.replace("<title>Second headline</title>", "")
    items = parse_feed(rss, limit=25)
    assert [i["title"] for i in items] == ["First headline"]


def test_parse_feed_truncates_long_snippets():
    long_desc = "x" * 500
    rss = RSS.replace("A short summary of the article.", long_desc)
    assert len(parse_feed(rss, limit=25)[0]["snippet"]) == 280


def test_parse_feed_raises_on_non_xml():
    with pytest.raises(ValueError, match="unparseable_feed"):
        parse_feed("<html><body>blocked</body></html>", limit=25)


def test_build_url_encodes_query_and_sets_locale():
    url = build_url("wedding photography")
    assert "q=wedding+photography" in url
    assert "hl=en-US" in url


def test_parse_feed_strips_html_from_snippet():
    """Google News descriptions are <a href> blobs — the href must not eat the snippet."""
    desc = (
        '&lt;a href="https://news.google.com/rss/articles/'
        + "CBMitgFBVV95cUxOUDEtNVhOZ3Z0" * 20
        + '"&gt;Real headline text&lt;/a&gt;&amp;nbsp;&amp;nbsp;'
        '&lt;font color="#6f6f6f"&gt;Example News&lt;/font&gt;'
    )
    rss = RSS.replace("A short summary of the article.", desc)
    snippet = parse_feed(rss, limit=25)[0]["snippet"]
    assert snippet is not None
    assert snippet.startswith("Real headline text")
    assert "href" not in snippet
    assert "news.google.com" not in snippet
