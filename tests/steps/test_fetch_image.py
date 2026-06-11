"""Step-level tests for steps/media/fetch_image.py.

Rejection paths (http://, unlisted host) are exercised WITHOUT network calls
by invoking the step script as a subprocess — they fail before any I/O.

The fetch logic itself (content-type check, size cap, success path) is
covered via lib-level tests in test_image_sources.py using MockTransport.

We do add a shallow arg-handling test to confirm the step wrapper passes
args through correctly.
"""
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

from tests.conftest import assert_error, run_step


class TestFetchImageRejections:
    def test_http_url_rejected(self, tmp_path):
        """http:// URL → fail(url_rejected, not_https)."""
        out = tmp_path / "out.jpg"
        proc = run_step(
            "fetch_image.py",
            "--url", "http://upload.wikimedia.org/test.jpg",
            "--out", str(out),
        )
        assert_error(proc, "url_rejected")

    def test_unlisted_host_rejected(self, tmp_path):
        """Host not in DEFAULT_IMAGE_HOSTS and not in env → fail(url_rejected, host_not_allowed)."""
        out = tmp_path / "out.jpg"
        proc = run_step(
            "fetch_image.py",
            "--url", "https://evil.example.com/test.jpg",
            "--out", str(out),
        )
        assert_error(proc, "url_rejected")

    def test_missing_url_arg(self, tmp_path):
        """--url is required; missing it → nonzero exit."""
        out = tmp_path / "out.jpg"
        proc = run_step("fetch_image.py", "--out", str(out))
        assert proc.returncode != 0

    def test_missing_out_arg(self):
        """--out is required; missing it → nonzero exit."""
        proc = run_step(
            "fetch_image.py",
            "--url", "https://upload.wikimedia.org/test.jpg",
        )
        assert proc.returncode != 0


class TestFetchImageArgParsing:
    def test_max_bytes_arg_accepted(self, tmp_path):
        """--max-bytes is parsed without error (rejection still happens on bad host)."""
        out = tmp_path / "out.jpg"
        proc = run_step(
            "fetch_image.py",
            "--url", "http://upload.wikimedia.org/test.jpg",  # http → rejected before fetch
            "--out", str(out),
            "--max-bytes", "1024",
        )
        # Still fails on preflight (not_https), but argparse must not error
        assert proc.returncode != 0
        err = json.loads(proc.stderr)
        assert err["error"] == "url_rejected"
