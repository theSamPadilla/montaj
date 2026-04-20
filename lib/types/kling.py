# GENERATED FROM schema/enums.yaml — DO NOT EDIT BY HAND.
# Run `python3 scripts/gen_types.py` after editing the YAML source.

"""
Kling `aspect_ratio` body parameter for omni-video (model kling-v3-omni).
Constant across an ai_video project's scenes.

"""
import logging

logger = logging.getLogger(__name__)

ASPECT_RATIOS: tuple[str, ...] = ("16:9", "9:16", "1:1")
DEFAULT_ASPECT_RATIO: str = "16:9"

def is_valid_aspect_ratio(value: str) -> bool:
    return value in ASPECT_RATIOS

def normalize_aspect_ratio(value: str | None) -> str:
    """Coerce unknown/None to DEFAULT_ASPECT_RATIO.
    None → silent fallback.
    Unknown string → warn + fallback.
    """
    if value is None:
        return DEFAULT_ASPECT_RATIO
    if value in ASPECT_RATIOS:
        return value
    logger.warning(
        "Unknown aspect_ratio %r — falling back to %r. Valid values: %s",
        value, DEFAULT_ASPECT_RATIO, ASPECT_RATIOS,
    )
    return DEFAULT_ASPECT_RATIO
