#!/usr/bin/env python3
"""Search for images — Wikimedia Commons, TheSportsDB, or the open web (SerpApi)."""
import json
import os
import sys
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail
from image_sources import commons_search, sportsdb_badge, serpapi_image_search


def main():
    p = argparse.ArgumentParser(description="Search for images")
    p.add_argument("--query", required=True, help="Search query")
    p.add_argument("--provider", default="commons",
                   choices=["commons", "sportsdb", "web"],
                   help="Image provider (default: commons)")
    p.add_argument("--limit", type=int, default=10,
                   help="Max results to return (default: 10, max: 30)")
    args = p.parse_args()

    limit = min(max(1, args.limit), 30)

    try:
        if args.provider == "commons":
            results = commons_search(args.query, limit=limit)
        elif args.provider == "sportsdb":
            results = sportsdb_badge(args.query)
            results = results[:limit]
        elif args.provider == "web":
            # Keyed provider. The SerpApi key is injected per-request via the
            # run_step credential passthrough (credentials.serpapi.api_key →
            # SERPAPI_API_KEY) — never read from a file on the multi-tenant box.
            api_key = os.environ.get("SERPAPI_API_KEY", "").strip()
            if not api_key:
                fail("missing_credentials",
                     "provider 'web' needs SerpApi credentials — pass "
                     "credentials.serpapi.api_key in the step body")
            results = serpapi_image_search(args.query, api_key, limit=limit)
        else:
            fail("bad_provider", f"Unknown provider: {args.provider}")
    except SystemExit:
        raise
    except Exception as exc:
        fail("search_failed", str(exc))

    print(json.dumps({"results": results}))


if __name__ == "__main__":
    main()
