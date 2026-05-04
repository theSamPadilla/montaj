"""Unit tests for lib/profile_assets.py — pure manifest I/O over
~/.montaj/profiles/{name}/assets/manifest.json.

HOME is monkeypatched to tmp_path so the helpers' Path.home()-based path
resolution stays inside the test sandbox.
"""
import json
from pathlib import Path

import pytest

from lib.profile_assets import (
    MAX_ASSET_BYTES,
    build_profile_snapshot,
    load_assets_manifest,
    save_assets_manifest,
)


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def profile(home):
    """Create ~/.montaj/profiles/alpha/ (no assets dir yet)."""
    p = home / ".montaj" / "profiles" / "alpha"
    p.mkdir(parents=True)
    return p


# ---------------------------------------------------------------------------
# load_assets_manifest — empty / failure modes all coerce to the canonical default
# ---------------------------------------------------------------------------

def test_load_missing_profile_returns_empty(home):
    """Profile dir doesn't even exist → canonical empty manifest."""
    assert load_assets_manifest("ghost") == {"summary": "", "files": {}}


def test_load_missing_manifest_returns_empty(profile):
    """Profile dir exists, no assets/ subdir → canonical empty manifest."""
    assert load_assets_manifest("alpha") == {"summary": "", "files": {}}


def test_load_empty_assets_dir_returns_empty(profile):
    """assets/ exists but no manifest.json → canonical empty manifest."""
    (profile / "assets").mkdir()
    assert load_assets_manifest("alpha") == {"summary": "", "files": {}}


def test_load_empty_file_returns_empty(profile):
    """manifest.json is zero-byte / whitespace-only → canonical empty manifest."""
    (profile / "assets").mkdir()
    (profile / "assets" / "manifest.json").write_text("   \n  ")
    assert load_assets_manifest("alpha") == {"summary": "", "files": {}}


def test_load_corrupt_json_returns_empty(profile):
    """Invalid JSON → canonical empty manifest (no exception)."""
    (profile / "assets").mkdir()
    (profile / "assets" / "manifest.json").write_text("{not json")
    assert load_assets_manifest("alpha") == {"summary": "", "files": {}}


def test_load_non_dict_top_level_returns_empty(profile):
    """Top-level JSON is not a dict (list, scalar) → canonical empty manifest."""
    (profile / "assets").mkdir()
    (profile / "assets" / "manifest.json").write_text("[1, 2, 3]")
    assert load_assets_manifest("alpha") == {"summary": "", "files": {}}


def test_load_coerces_wrong_inner_types(profile):
    """summary=non-str + files=non-dict → both coerced to canonical defaults."""
    (profile / "assets").mkdir()
    (profile / "assets" / "manifest.json").write_text(json.dumps({
        "summary": 5,
        "files": "wrong",
    }))
    assert load_assets_manifest("alpha") == {"summary": "", "files": {}}


def test_load_partial_manifest_fills_defaults(profile):
    """Missing 'files' key → fills with {} and preserves valid 'summary'."""
    (profile / "assets").mkdir()
    (profile / "assets" / "manifest.json").write_text(json.dumps({"summary": "hello"}))
    assert load_assets_manifest("alpha") == {"summary": "hello", "files": {}}


def test_load_valid_manifest_round_trip_shape(profile):
    """Valid manifest passes through with both keys preserved."""
    (profile / "assets").mkdir()
    payload = {
        "summary": "brand kit v2",
        "files": {
            "logo.png": {"description": "primary", "tags": ["logo"]},
        },
    }
    (profile / "assets" / "manifest.json").write_text(json.dumps(payload))
    assert load_assets_manifest("alpha") == payload


# ---------------------------------------------------------------------------
# save_assets_manifest — atomicity + parent-dir creation
# ---------------------------------------------------------------------------

def test_save_creates_assets_dir_when_missing(profile):
    """save_assets_manifest creates the assets/ parent dir if absent."""
    assert not (profile / "assets").exists()
    save_assets_manifest("alpha", {"summary": "hi", "files": {}})
    assert (profile / "assets" / "manifest.json").exists()


def test_save_writes_expected_payload(profile):
    """Round-trip via the manifest file: written bytes parse back to input."""
    payload = {
        "summary": "brand kit",
        "files": {
            "logo.png": {"description": "primary logo", "tags": ["logo", "dark"]},
        },
    }
    save_assets_manifest("alpha", payload)
    written = json.loads((profile / "assets" / "manifest.json").read_text())
    assert written == payload


def test_save_no_lingering_tmp(profile):
    """Atomic-write contract: the .tmp sidecar is renamed away, never left."""
    save_assets_manifest("alpha", {"summary": "ok", "files": {}})
    assert (profile / "assets" / "manifest.json").exists()
    assert not (profile / "assets" / "manifest.json.tmp").exists()


def test_save_overwrites_existing(profile):
    """Last-writer-wins on the whole manifest — second save replaces first."""
    save_assets_manifest("alpha", {"summary": "v1", "files": {"a.png": {"description": "", "tags": []}}})
    save_assets_manifest("alpha", {"summary": "v2", "files": {}})
    out = json.loads((profile / "assets" / "manifest.json").read_text())
    assert out == {"summary": "v2", "files": {}}


def test_round_trip_save_then_load(profile):
    """save then load returns the exact same dict — the public contract for
    consumers (route handlers, project/init.py snapshot) round-tripping
    creator-edited manifests."""
    payload = {
        "summary": "round-trip",
        "files": {
            "a.png": {"description": "alpha asset", "tags": ["a"]},
            "b.svg": {"description": "beta asset",  "tags": []},
        },
    }
    save_assets_manifest("alpha", payload)
    assert load_assets_manifest("alpha") == payload


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

def test_max_asset_bytes_is_2_gib():
    """Sanity-check the public constant — consumers (route + future CLI) all
    derive from this single source of truth."""
    assert MAX_ASSET_BYTES == 2 * 1024 * 1024 * 1024


# ---------------------------------------------------------------------------
# build_profile_snapshot — derived view written into project.json at init
# ---------------------------------------------------------------------------

def test_build_snapshot_returns_none_for_falsy_profile_name(home):
    """No --profile (None or empty string) → helper returns None so the
    caller omits the field from project.json entirely."""
    assert build_profile_snapshot(None) is None
    assert build_profile_snapshot("") is None


def test_build_snapshot_with_populated_manifest(profile):
    """Full manifest → snapshot has name, summary, sorted availableAssets."""
    save_assets_manifest("alpha", {
        "summary": "alpha brand kit",
        "files": {
            "z.png": {"description": "logo dark", "tags": ["logo"]},
            "a.png": {"description": "headshot",  "tags": []},
        },
    })
    snap = build_profile_snapshot("alpha")
    assert snap is not None
    assert snap["name"]    == "alpha"
    assert snap["summary"] == "alpha brand kit"
    # availableAssets sorted by filename for determinism
    assert [a["filename"] for a in snap["availableAssets"]] == ["a.png", "z.png"]
    assert snap["availableAssets"][0] == {
        "filename": "a.png", "description": "headshot", "tags": []
    }


def test_build_snapshot_no_manifest_yields_empty_defaults(profile):
    """Profile dir exists but no assets/manifest.json → snapshot has empty
    summary + empty availableAssets (load_assets_manifest's defaults)."""
    snap = build_profile_snapshot("alpha")
    assert snap == {"name": "alpha", "summary": "", "availableAssets": []}


def test_build_snapshot_includes_style_profile_path_when_file_exists(profile):
    """style_profile.md present at init → snapshot includes absolute path."""
    style_md = profile / "style_profile.md"
    style_md.write_text("# Alpha — analyzed style\n")
    snap = build_profile_snapshot("alpha")
    assert snap is not None
    assert snap["styleProfilePath"] == str(style_md)


def test_build_snapshot_omits_style_profile_path_when_file_absent(profile):
    """style_profile.md missing → field is OMITTED entirely (not None,
    not empty string). Lets the agent gate on `if "styleProfilePath" in snap`
    instead of try/except on a missing file."""
    snap = build_profile_snapshot("alpha")
    assert snap is not None
    assert "styleProfilePath" not in snap


def test_build_snapshot_entry_with_missing_description_and_tags(profile):
    """Manifest entry like {} → defaults to description='' and tags=[].
    Defensive shape: agents see the canonical fields even when the user
    hasn't filled them in."""
    save_assets_manifest("alpha", {
        "summary": "",
        "files": {"bare.png": {}},
    })
    snap = build_profile_snapshot("alpha")
    assert snap is not None
    assert snap["availableAssets"] == [
        {"filename": "bare.png", "description": "", "tags": []},
    ]
