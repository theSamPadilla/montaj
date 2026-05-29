"""Project working color space — Python loader for montaj_assets/schemas/color_space.json.

The JSON is the canonical source of truth (loaded by both Python and JS). This
module exposes typed accessors and detection/smart-pick helpers.
"""
import json
from pathlib import Path
from typing import Literal, TypedDict

ColorSpaceKey = Literal["sdr_bt709", "hdr_hlg", "hdr_pq"]


class ColorSpaceSpec(TypedDict):
    key: ColorSpaceKey
    transfer_values: tuple[str, ...]
    pix_fmts: tuple[str, ...]
    encoder: str
    output_pix_fmt: str
    encoder_params: dict[str, str]
    output_color_args: tuple[str, ...]
    setparams: str


_SCHEMA_PATH = Path(__file__).resolve().parent.parent.parent / "montaj_assets" / "schemas" / "color_space.json"
_DATA = json.loads(_SCHEMA_PATH.read_text())

ALL_COLOR_SPACES: tuple[ColorSpaceKey, ...] = tuple(_DATA["all"])
DEFAULT_COLOR_SPACE: ColorSpaceKey = _DATA["default"]

# Convert lists from JSON to tuples for immutability semantics.
SPECS: dict[ColorSpaceKey, ColorSpaceSpec] = {
    key: {
        **spec,
        "transfer_values": tuple(spec["transfer_values"]),
        "pix_fmts": tuple(spec["pix_fmts"]),
        "output_color_args": tuple(spec["output_color_args"]),
    }
    for key, spec in _DATA["specs"].items()
}


def is_hdr(key: str) -> bool:
    """True if key is an HDR color space (hlg or pq)."""
    return key in ("hdr_hlg", "hdr_pq")


def detect_from_transfer(color_transfer: str | None) -> ColorSpaceKey:
    """Map a ffprobe color_transfer value to its color space key. Unknown/None → SDR."""
    if not color_transfer:
        return DEFAULT_COLOR_SPACE
    for key, spec in SPECS.items():
        if color_transfer in spec["transfer_values"]:
            return key
    return DEFAULT_COLOR_SPACE


def require_valid_key(value: str | None) -> ColorSpaceKey:
    """Strict validator. Raises ValueError with a clear message if value is not a
    known color space key. Use at load sites (e.g., reading project.json) where
    a hand-edited bad value should fail loudly rather than silently coerce.

    Contrast with normalize_key(), which silently maps missing/invalid → SDR.
    """
    if value is None or value not in ALL_COLOR_SPACES:
        raise ValueError(
            f"Unknown colorSpace {value!r}. Expected one of {ALL_COLOR_SPACES}. "
            f"Check project.json settings.colorSpace or the --color-space flag."
        )
    return value  # type: ignore[return-value]


def normalize_key(value: str | None) -> ColorSpaceKey:
    """Coerce a possibly-invalid string to a known ColorSpaceKey, defaulting to SDR."""
    if value in ALL_COLOR_SPACES:
        return value  # type: ignore[return-value]
    return DEFAULT_COLOR_SPACE


def smart_detect(detected_keys: list[ColorSpaceKey]) -> ColorSpaceKey:
    """Pick a project color space from the per-clip detected keys.

    Policy: **modal wins.** The most common color space across all clips defines
    the project. Outliers get converted on the fly (HDR→SDR via tonemap when
    project is SDR; SDR→HDR via stretch when project is HDR — see
    _build_color_conversion_vf). This matches FCP/Resolve behavior: a single
    SDR clip dropped into an iPhone-HDR project is treated as SDR-graded
    content shown on an HDR canvas, not a reason to flip the entire project
    down to SDR.

    Tiebreak rules (when two or more keys are tied for most common):
      - All HDR variants only (HLG+PQ tie, no SDR): PQ wins (larger gamut;
        HLG → PQ is a clean transfer-curve conversion).
      - SDR tied with any HDR: SDR wins (conservative — inverse-stretch is
        creative guesswork at scale, while tonemap-down is well-defined).

    Empty list (no clips probed): SDR default.
    """
    if not detected_keys:
        return DEFAULT_COLOR_SPACE

    counts: dict[ColorSpaceKey, int] = {}
    for k in detected_keys:
        counts[k] = counts.get(k, 0) + 1

    max_count = max(counts.values())
    modes = [k for k, c in counts.items() if c == max_count]

    if len(modes) == 1:
        return modes[0]

    # Tied modes — apply tiebreak rules.
    if DEFAULT_COLOR_SPACE in modes:
        # Conservative when SDR is tied with HDR (avoids defaulting to inverse-stretch).
        return DEFAULT_COLOR_SPACE
    if set(modes) == {"hdr_hlg", "hdr_pq"}:
        return "hdr_pq"
    # Three-way HDR tie or any other unusual case — fall back to SDR.
    return DEFAULT_COLOR_SPACE
