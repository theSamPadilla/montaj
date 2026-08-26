"""Anti-drift guard for the deliberately-duplicated ffmpeg/ffprobe pin.

The pinned static-build metadata (build_id + sha256, per (os, arch)) lives in
two places on purpose:

  1. lib/ffmpeg_static.py — PINNED_BUILDS, read by `montaj install ffmpeg`.
  2. ../homebrew-montaj/Formula/montaj.rb — literal `resource "ffmpeg"` /
     `resource "ffprobe"` blocks, read by `brew install montaj`.

Nothing enforces the two agree except this test. If it fails, one of the two
files is stale: update whichever one disagrees so both name the same
build_id/sha256 for every (os, arch), then re-run this test to confirm.

Skips (module-wide) when the homebrew-montaj tap isn't checked out next to
this repo, e.g. in CI that only checks out montaj.
"""
import os
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import ffmpeg_static

REPO_ROOT = Path(__file__).parent.parent
FORMULA_PATH = REPO_ROOT.parent / "homebrew-montaj" / "Formula" / "montaj.rb"

pytestmark = pytest.mark.skipif(
    not FORMULA_PATH.exists(),
    reason=f"homebrew-montaj tap not checked out alongside montaj (expected {FORMULA_PATH})",
)

# Matches `resource "<name>" do / url "<url>" / sha256 "<sha>" / end`. Keyed
# off the URL path (.../download/<os>/<arch>/<build_id>/<name>.zip) rather
# than tracking the surrounding on_macos/on_arm Ruby nesting — the URL
# already carries (os, arch, build_id), so this is far more robust.
_RESOURCE_RE = re.compile(
    r'resource\s+"(?P<name>[a-zA-Z0-9_]+)"\s+do\s*\n'
    r'\s*url\s+"(?P<url>[^"]+)"\s*\n'
    r'\s*sha256\s+"(?P<sha256>[0-9a-f]+)"\s*\n'
    r'\s*end'
)
_URL_RE = re.compile(
    r'/download/(?P<os>[a-z0-9]+)/(?P<arch>[a-z0-9]+)/(?P<build_id>[^/]+)/(?P<name>[a-zA-Z0-9_]+)\.zip$'
)


def _parse_formula():
    """Return {(os, arch, name): {"url": ..., "sha256": ..., "build_id": ...}}."""
    text = FORMULA_PATH.read_text()
    result = {}
    for m in _RESOURCE_RE.finditer(text):
        url = m.group("url")
        url_match = _URL_RE.search(url)
        assert url_match, (
            f'{FORMULA_PATH}: resource "{m.group("name")}" url does not match the '
            f"expected .../download/<os>/<arch>/<build_id>/<name>.zip shape: {url}"
        )
        assert url_match.group("name") == m.group("name"), (
            f'{FORMULA_PATH}: resource "{m.group("name")}" block has a url pointing '
            f'at binary "{url_match.group("name")}" instead: {url}'
        )
        key = (url_match.group("os"), url_match.group("arch"), m.group("name"))
        result[key] = {
            "url": url,
            "sha256": m.group("sha256"),
            "build_id": url_match.group("build_id"),
        }
    return result


class TestFfmpegPinSync:
    @pytest.mark.parametrize("name", ["ffmpeg", "ffprobe"])
    @pytest.mark.parametrize("key", sorted(ffmpeg_static.PINNED_BUILDS.keys()))
    def test_formula_matches_pinned_build(self, key, name):
        os_key, arch = key
        entry = ffmpeg_static.PINNED_BUILDS[key]
        formula = _parse_formula()

        resource_key = (os_key, arch, name)
        assert resource_key in formula, (
            f'{os_key}/{arch} {name}: no `resource "{name}"` block found in '
            f"{FORMULA_PATH} for this (os, arch). Reconcile lib/ffmpeg_static.py "
            f"PINNED_BUILDS[{key!r}] (build_id {entry['build_id']!r}) with "
            f"{FORMULA_PATH} — one of the two is missing this platform."
        )

        actual = formula[resource_key]
        expected_url = ffmpeg_static._zip_url(key, entry["build_id"], name)
        assert actual["url"] == expected_url, (
            f"{os_key}/{arch} {name}: url mismatch between the two pins.\n"
            f"  lib/ffmpeg_static.py PINNED_BUILDS[{key!r}][\"build_id\"] "
            f"({entry['build_id']!r}) implies: {expected_url}\n"
            f"  {FORMULA_PATH} resource url is:                          {actual['url']}\n"
            f"Update whichever file is stale so both agree."
        )

        expected_sha = entry[f"{name}_sha256"]
        assert actual["sha256"] == expected_sha, (
            f"{os_key}/{arch} {name}: sha256 mismatch between the two pins.\n"
            f'  lib/ffmpeg_static.py PINNED_BUILDS[{key!r}]["{name}_sha256"] = {expected_sha}\n'
            f"  {FORMULA_PATH} resource sha256 =                                {actual['sha256']}\n"
            f"Update whichever file is stale so both agree."
        )

    def test_no_stale_or_extra_arches_in_formula(self):
        """Reverse direction: every formula resource must be a known pin.

        Catches a stale/extra (os, arch) block left in the formula (e.g.
        after a platform is dropped from PINNED_BUILDS) that the forward
        test above would never look at, since it only iterates PINNED_BUILDS.
        """
        formula = _parse_formula()
        pinned_keys = set(ffmpeg_static.PINNED_BUILDS.keys())
        for (os_key, arch, name) in formula:
            assert (os_key, arch) in pinned_keys, (
                f'{FORMULA_PATH} has a resource "{name}" block for {os_key}/{arch}, '
                f"which is not a key in lib/ffmpeg_static.py PINNED_BUILDS "
                f"({sorted(pinned_keys)}). Either add {(os_key, arch)!r} to "
                f"PINNED_BUILDS or remove the stale block from {FORMULA_PATH}."
            )
