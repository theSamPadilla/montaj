# GENERATED FROM schema/enums.yaml — DO NOT EDIT BY HAND.
# Run `python3 scripts/gen_types.py` after editing the YAML source.

"""
Aspect ratio of an image-carousel project. Locked at project init,
applies to every slide. Resolutions:
  square   = 1080x1080  (Instagram square)
  portrait = 1080x1350  (Instagram portrait — dominant carousel format in 2026)
  vertical = 1080x1920  (TikTok photo mode, IG/Threads stories)

"""
import logging

logger = logging.getLogger(__name__)

CAROUSEL_ASPECTS: tuple[str, ...] = ("square", "portrait", "vertical")
DEFAULT_CAROUSEL_ASPECT: str = "square"

def is_valid_carousel_aspect(value: str) -> bool:
    return value in CAROUSEL_ASPECTS

def normalize_carousel_aspect(value: str | None) -> str:
    """Coerce unknown/None to DEFAULT_CAROUSEL_ASPECT.
    None → silent fallback.
    Unknown string → warn + fallback.
    """
    if value is None:
        return DEFAULT_CAROUSEL_ASPECT
    if value in CAROUSEL_ASPECTS:
        return value
    logger.warning(
        "Unknown carousel_aspect %r — falling back to %r. Valid values: %s",
        value, DEFAULT_CAROUSEL_ASPECT, CAROUSEL_ASPECTS,
    )
    return DEFAULT_CAROUSEL_ASPECT

CAROUSEL_RESOLUTIONS: dict[str, tuple[int, int]] = {
    "square": (1080, 1080),
    "portrait": (1080, 1350),
    "vertical": (1080, 1920),
}
