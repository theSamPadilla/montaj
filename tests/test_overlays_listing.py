"""HTTP tests for GET /api/overlays/system and GET /api/overlays.

Tests four cases from the 2026-05-24-add-text-overlay plan (Task 6):
  1. GET /api/overlays/system returns at least the static-text entry.
  2. The entry's jsxPath exists on disk and is readable.
  3. The entry's props list matches the static-text.json schema (15 named props
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
    {"name": "text",          "type": "string", "default": "Your text here"},
    {"name": "fontSize",      "type": "string", "default": "80"},
    {"name": "fontFamily",    "type": "string",
     "default": 'system-ui, -apple-system, "Helvetica Neue", sans-serif'},
    {"name": "fontWeight",    "type": "string", "default": "400"},
    {"name": "fontStyle",     "type": "string", "default": "normal",      "enum": ["normal", "italic"]},
    {"name": "color",         "type": "string", "default": "#111111",     "format": "color"},
    {"name": "textAlign",     "type": "string", "default": "center",      "enum": ["left", "center", "right"]},
    {"name": "textTransform", "type": "string", "default": "none",        "enum": ["none", "uppercase", "lowercase", "capitalize"]},
    {"name": "bgColor",       "type": "string", "default": "transparent", "format": "color"},
    {"name": "effect",        "type": "string", "default": "none",        "enum": ["none", "shadow", "outline", "glow"]},
    {"name": "effectColor",   "type": "string", "default": "#000000",     "format": "color"},
    {"name": "effectStrength", "type": "string", "default": "60"},
    {"name": "fit",           "type": "string", "default": "false",       "enum": ["false", "true"]},
    {"name": "minFontSize",   "type": "string", "default": "24"},
    {"name": "runs",          "type": "string"},
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


# ── Sidecar settings: optional fields from <name>.json ────────────────────────

def _write_overlay(root: Path, name: str, meta: dict) -> None:
    import json
    d = root / name
    d.mkdir(parents=True)
    (d / f"{name}.jsx").write_text("export default () => null")
    (d / f"{name}.json").write_text(json.dumps(meta))


def test_sidecar_settings_are_returned(tmp_path):
    from serve.routes.overlays import scan_overlays
    _write_overlay(tmp_path, "card", {
        "description": "d", "props": [{"name": "t", "type": "string"}],
        "durationSeconds": 4.5, "fps": 30, "width": 1080, "height": 1920,
        "googleFonts": ["Syne", "Inter"], "opaque": True,
        "defaults": {"props": {"t": "hi"}, "junk": 1},
    })
    e = scan_overlays(tmp_path)[0]
    assert e["durationSeconds"] == 4.5 and e["fps"] == 30
    assert e["width"] == 1080 and e["height"] == 1920
    assert e["googleFonts"] == ["Syne", "Inter"] and e["opaque"] is True
    assert e["defaults"] == {"props": {"t": "hi"}}


def test_sidecar_without_settings_adds_no_keys(tmp_path):
    from serve.routes.overlays import scan_overlays
    _write_overlay(tmp_path, "plain", {"description": "d", "props": []})
    e = scan_overlays(tmp_path)[0]
    assert set(e) == {"name", "description", "props", "jsxPath"}


def test_sidecar_wrong_types_are_omitted(tmp_path):
    from serve.routes.overlays import scan_overlays
    _write_overlay(tmp_path, "bad", {
        "description": "d", "fps": "30", "googleFonts": "Syne",
        "durationSeconds": 0, "width": 10.5, "height": True,
        "opaque": "yes", "defaults": {"props": []},
    })
    entries = scan_overlays(tmp_path)
    assert len(entries) == 1
    for k in ("durationSeconds", "fps", "width", "height", "googleFonts", "opaque", "defaults"):
        assert k not in entries[0]


# ── low 18: the profile {name} segment is validated before any mkdir ──────────

# (a `/` in the name — %2f — is rejected by the router itself before the handler, so only single-segment
# bad names reach the guard: a dot, a tilde, and an encoded backslash traversal.)
@pytest.mark.parametrize("bad", ["a.b", "a~b", "%2e%2e%5cwin"])
def test_profile_overlay_group_rejects_a_bad_profile_name(bad):
    r = client.post(f"/api/profiles/{bad}/overlays/groups", json={"name": "grp"})
    assert r.status_code == 400 and r.json()["detail"]["error"] == "invalid_name", (bad, r.status_code)


@pytest.mark.parametrize("bad", ["a.b", "a~b"])
def test_list_profile_overlays_rejects_a_bad_profile_name(bad):
    r = client.get(f"/api/profiles/{bad}/overlays")
    assert r.status_code == 400 and r.json()["detail"]["error"] == "invalid_name", (bad, r.status_code)


def test_profile_overlay_group_accepts_a_plain_name(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    r = client.post("/api/profiles/default/overlays/groups", json={"name": "grp"})
    assert r.status_code == 201, r.text
    assert (tmp_path / ".montaj" / "profiles" / "default" / "overlays" / "grp").is_dir()


# ── §587 R2: the shape, line and frame templates carry their `category` ───────

def test_sidecar_category_is_passed_through(tmp_path):
    from serve.routes.overlays import scan_overlays
    _write_overlay(tmp_path, "blob", {"description": "d", "props": [], "category": "shape"})
    e = scan_overlays(tmp_path)[0]
    assert e["category"] == "shape"
    assert set(e) == {"name", "description", "props", "jsxPath", "category"}


@pytest.mark.parametrize("bad", ["", 3, None, ["shape"], {"k": "shape"}])
def test_sidecar_category_of_the_wrong_type_is_omitted(tmp_path, bad):
    from serve.routes.overlays import scan_overlays
    _write_overlay(tmp_path, "blob", {"description": "d", "props": [], "category": bad})
    assert "category" not in scan_overlays(tmp_path)[0]


def test_system_overlays_list_the_shapes_lines_and_frames_by_category():
    entries = client.get("/api/overlays/system").json()
    by_name = {e.get("name"): e for e in entries}
    assert by_name["shape-rect"]["category"] == "shape"
    assert by_name["shape-ellipse"]["category"] == "shape"
    assert by_name["line-dashed"]["category"] == "line"
    assert by_name["frame-border"]["category"] == "frame"
    # the templates without one are listed as before
    assert "category" not in by_name["static-text"]


# ── §587 R2 F-I: arrows and callouts, and a shape's own aspect ────────────────

def test_system_overlays_list_arrows_and_callouts_by_category():
    entries = client.get("/api/overlays/system").json()
    by_name = {e.get("name"): e for e in entries}
    # the block arrow moved to Arrows; the arrow line stays a line
    assert by_name["shape-arrow"]["category"] == "arrow"
    assert by_name["arrow-curved"]["category"] == "arrow"
    assert by_name["line-arrow"]["category"] == "line"
    assert by_name["callout-speech-round"]["category"] == "callout"
    assert by_name["shape-heart"]["category"] == "shape"
    assert by_name["line-dot-ends"]["category"] == "line"


@pytest.mark.parametrize("category", ["arrow", "callout"])
def test_sidecar_new_categories_are_passed_through(tmp_path, category):
    from serve.routes.overlays import scan_overlays
    _write_overlay(tmp_path, "blob", {"description": "d", "props": [], "category": category})
    assert scan_overlays(tmp_path)[0]["category"] == category


def test_sidecar_aspect_is_passed_through(tmp_path):
    from serve.routes.overlays import scan_overlays
    _write_overlay(tmp_path, "pill", {"description": "d", "props": [], "category": "shape", "aspect": 2})
    _write_overlay(tmp_path, "tall", {"description": "d", "props": [], "category": "shape", "aspect": 0.5})
    e = {x["name"]: x for x in scan_overlays(tmp_path)}
    assert e["pill"]["aspect"] == 2
    assert e["tall"]["aspect"] == 0.5
    pill = client.get("/api/overlays/system").json()
    assert {x["name"]: x for x in pill}["shape-pill"]["aspect"] == 2


@pytest.mark.parametrize("bad", [0, -1, "2", True, None, [2]])
def test_sidecar_aspect_of_the_wrong_type_is_omitted(tmp_path, bad):
    from serve.routes.overlays import scan_overlays
    _write_overlay(tmp_path, "pill", {"description": "d", "props": [], "aspect": bad})
    assert "aspect" not in scan_overlays(tmp_path)[0]


@pytest.mark.parametrize("bad", [float("inf"), float("-inf"), float("nan")])
def test_sidecar_non_finite_numbers_are_omitted(tmp_path, bad):
    """Python's json parses Infinity and NaN, but the response cannot carry them."""
    from serve.routes.overlays import scan_overlays
    _write_overlay(tmp_path, "pill", {"description": "d", "props": [], "aspect": bad, "durationSeconds": bad, "fps": bad})
    e = scan_overlays(tmp_path)[0]
    for k in ("aspect", "durationSeconds", "fps"):
        assert k not in e
    import json
    json.dumps(e, allow_nan=False)
