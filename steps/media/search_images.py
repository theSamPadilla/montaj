#!/usr/bin/env python3
"""Search for licensed images from Wikimedia Commons or TheSportsDB."""
import json
import os
import sys
import argparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lib"))
from common import fail
from image_sources import commons_search, sportsdb_badge


def main():
    p = argparse.ArgumentParser(description="Search for licensed images")
    p.add_argument("--query", required=True, help="Search query")
    p.add_argument("--provider", default="commons",
                   choices=["commons", "sportsdb"],
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
        else:
            fail("bad_provider", f"Unknown provider: {args.provider}")
    except Exception as exc:
        fail("search_failed", str(exc))

    print(json.dumps({"results": results}))


if __name__ == "__main__":
    main()
