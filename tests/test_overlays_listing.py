"""HTTP tests for GET /api/overlays/system and GET /api/overlays.

Tests four cases from the 2026-05-24-add-text-overlay plan (Task 6):
  1. GET /api/overlays/system returns at least the static-text entry.
  2. The entry's jsxPath exists on disk and is readable.
  3. The entry's props list matches the static-text.json schema (7 named props
     with correct defaults).
  4. GET /api/overlays (user-library) does NOT include static-text.
     Path.home is patched to an empty tmp dir to isolate from the developer's
     real ~/.montaj/overlays/.

Path-construction approach (option a):
  render_runtime_dir() is NOT patched — in a dev checkout it resolves to
  montaj_assets/render, so templates/overlays/static-text/ contains the real
  files written by Tasks 1–2.  The plan's acceptance criterion ("The entry's
  jsxPath exists on disk and is readable") explicitly permits exercising the
  real shipped-templates directory, and option (a) is the plan's default.
"""
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from serve.server import app

client = TestClient(app)

# ── expected props from static-text.json ──────────────────────────────────────

EXPECTED_PROPS = [
    {"name": "text",       "type": "string", "default": "Your text here"},
    {"name": "fontSize",   "type": "string", "default": "80"},
    {"name": "color",      "type": "string", "default": "#111111",     "format": "color"},
    {"name": "fontFamily", "type": "string",
     "default": 'system-ui, -apple-system, "Helvetica Neue", sans-serif'},
    {"name": "fontWeight", "type": "string", "default": "400"},
    {"name": "textAlign",  "type": "string", "default": "center",
     "enum": ["left", "center", "right"]},
    {"name": "bgColor",    "type": "string", "default": "transparent", "format": "color"},
]


# ── helper ─────────────────────────────────────────────────────────────────────

def _find_entry(entries: list[dict], name: str) -> dict | None:
    return next((e for e in entries if e.get("name") == name), None)


# ── Case 1: system endpoint returns static-text ────────────────────────────────

def test_system_overlays_includes_static_text():
    resp = client.get("/api/overlays/system")
    assert resp.status_code == 200
    entries = resp.json()
    assert isinstance(entries, list)
    entry = _find_entry(entries, "static-text")
    assert entry is not None, (
        f"Expected 'static-text' in /api/overlays/system; got names: "
        f"{[e.get('name') for e in entries]}"
    )


# ── Case 2: jsxPath exists on disk and is readable ────────────────────────────

def test_system_overlay_jsx_path_exists():
    resp = client.get("/api/overlays/system")
    assert resp.status_code == 200
    entry = _find_entry(resp.json(), "static-text")
    assert entry is not None

    jsx_path = Path(entry["jsxPath"])
    assert jsx_path.exists(), f"jsxPath does not exist on disk: {jsx_path}"
    assert jsx_path.is_file(), f"jsxPath is not a file: {jsx_path}"
    content = jsx_path.read_text()
    assert content.strip(), f"jsxPath file is empty: {jsx_path}"


# ── Case 3: props match the static-text.json schema exactly ──────────────────

def test_system_overlay_props_match_schema():
    resp = client.get("/api/overlays/system")
    assert resp.status_code == 200
    entry = _find_entry(resp.json(), "static-text")
    assert entry is not None

    props = entry.get("props", [])
    assert len(props) == len(EXPECTED_PROPS), (
        f"Expected {len(EXPECTED_PROPS)} props, got {len(props)}: "
        f"{[p.get('name') for p in props]}"
    )

    for expected, actual in zip(EXPECTED_PROPS, props):
        assert actual == expected, (
            f"Prop mismatch for '{expected['name']}': expected {expected}, got {actual}"
        )


# ── Case 4: user-library endpoint does NOT include static-text ────────────────
#
# The user-library endpoint reads Path.home() / ".montaj" / "overlays".
# We patch Path.home() to return an empty tmp dir so the test is isolated from
# whatever the developer actually has in ~/.montaj/overlays/ — including any
# accidental static-text overlay that would cause a spurious failure.

def test_user_library_does_not_include_static_text(tmp_path):
    # Empty tmp dir stands in for ~/.montaj; overlays subdir intentionally absent.
    fake_home = tmp_path / "fake-home"
    fake_home.mkdir()

    with patch("pathlib.Path.home", return_value=fake_home):
        resp = client.get("/api/overlays")

    assert resp.status_code == 200
    entries = resp.json()
    names = [e.get("name") for e in entries]
    assert "static-text" not in names, (
        f"'static-text' must not appear in user-library /api/overlays; got: {names}"
    )
