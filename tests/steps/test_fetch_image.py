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


def test_redirected_fetch_answers_final_url_and_plain_path_otherwise(tmp_path, monkeypatch, capsys):
    """The answer is the bare path; after a redirect it is {path, type, finalUrl}."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("fetch_image_step", REPO_ROOT / "steps" / "media" / "fetch_image.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for url, final, expect_json in (("https://a.example/x.png", "https://a.example/x.png", False),
                                    ("https://a.example/go", "https://cdn.example/x.png", True)):
        def fake(u, out, hosts, max_bytes=0, info=None, _final=final):
            info["finalUrl"] = _final
            return out
        monkeypatch.setattr(mod, "fetch_image_to_path", fake)
        monkeypatch.setattr(sys, "argv", ["fetch_image.py", "--url", url, "--out", str(tmp_path / "o.png")])
        mod.main()
        out = capsys.readouterr().out.strip()
        if expect_json:
            assert json.loads(out) == {"path": str(tmp_path / "o.png"), "type": "image", "finalUrl": final}
        else:
            assert out == str(tmp_path / "o.png")
