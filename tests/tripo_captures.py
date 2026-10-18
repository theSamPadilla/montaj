"""Tripo's real responses, for the Tripo tests (not a test module).

tests/fixtures/tripo/captures/<name>.json is one API call from a real paid run on
2026-10-18 (see tests/fixtures/tripo/README.md): {source, method, path, status,
captured, request?, response}. `response` is the exact body Tripo sent, with the
key-like values, URL queries and the account's ids redacted.

Every call returns a fresh object, so a test can change what it gets.
"""
import json
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures" / "tripo"
CAPTURES = FIXTURES / "captures"

# The two real models Tripo made in that run (textures downscaled to 256x256).
PROP_GLB = FIXTURES / "prop-image-to-model.glb"
CHARACTER_GLB = FIXTURES / "character-rigged-animated.glb"


def _load(name: str) -> dict:
    return json.loads((CAPTURES / f"{name}.json").read_text())


def captured(name: str) -> dict:
    """The body Tripo sent for the call in captures/<name>.json."""
    return _load(name)["response"]


def captured_status(name: str) -> int:
    """The HTTP status Tripo sent with it."""
    return _load(name)["status"]


def captured_request(name: str) -> dict | None:
    """The JSON body the run sent (for a POST; the account's upload id is redacted)."""
    return _load(name).get("request")
