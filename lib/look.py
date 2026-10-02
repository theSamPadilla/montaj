#!/usr/bin/env python3
"""Look/curve manifest loader — montaj_assets/luts/looks.json.

The JSON is the canonical source of truth for which color-grade LUTs exist
and which one is the project default ("master look"). No heavy imports here
(JSON + paths only) so this stays cheap to import from anywhere: lib/proxy.py,
lib/normalize.py, cli/, serve/.

Asset path resolution mirrors lib/types/colorspace.py:24 — montaj_assets/ is
a sibling of lib/ at the repo/install root.
"""
import json
from pathlib import Path

_LUTS_DIR = Path(__file__).resolve().parent.parent / "montaj_assets" / "luts"
_MANIFEST_PATH = _LUTS_DIR / "looks.json"
_DATA = json.loads(_MANIFEST_PATH.read_text())

MASTER_LOOK: str = _DATA["masterLook"]
"""The manifest's default look id ("natural1" since PL24): the curve every HDR→SDR grade
uses unless a caller names another."""

PREVIOUS_MASTER_LOOKS: tuple[str, ...] = tuple(_DATA.get("previousMasterLooks", ()))
"""Every earlier masterLook that tagged artifact filenames, oldest first ("vivid1"
before PL24). APPEND the outgoing id here, in looks.json, on each bump: serve's
look migration retires a normalized master tagged with any of these, and
`montaj clean` keeps their files cleanable. "hable1" never tagged a master, so
it is not here (clean names it itself, for proxies)."""

_CURVES: dict = _DATA["curves"]


def curve_ids() -> list[str]:
    """All registered curve ids, in manifest order."""
    return list(_CURVES.keys())


def lut_path(curve_id: str | None = None) -> Path:
    """Absolute path to the .cube file for `curve_id`.

    `curve_id=None` resolves to MASTER_LOOK. Raises ValueError if `curve_id`
    is not a registered curve.
    """
    if curve_id is None:
        curve_id = MASTER_LOOK
    if curve_id not in _CURVES:
        raise ValueError(
            f"Unknown look curve {curve_id!r}. Expected one of {curve_ids()}. "
            f"Check montaj_assets/luts/looks.json."
        )
    return _LUTS_DIR / _CURVES[curve_id]["file"]
