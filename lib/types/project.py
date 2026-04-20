# GENERATED FROM schema/enums.yaml — DO NOT EDIT BY HAND.
# Run `python3 scripts/gen_types.py` after editing the YAML source.

"""
The project's top-level type. Inherited from the workflow's `project_type`
at init time; immutable after that. Drives UI branching and available features.

Where in the pipeline the project is. Progression is monotonic for a given
project type (ai_video goes pending → storyboard_ready → draft → final;
others skip storyboard_ready).

"""
import logging

logger = logging.getLogger(__name__)

PROJECT_TYPES: tuple[str, ...] = ("editing", "music_video", "ai_video")
DEFAULT_PROJECT_TYPE: str = "editing"

def is_valid_project_type(value: str) -> bool:
    return value in PROJECT_TYPES

def normalize_project_type(value: str | None) -> str:
    """Coerce unknown/None to DEFAULT_PROJECT_TYPE.
    None → silent fallback.
    Unknown string → warn + fallback.
    """
    if value is None:
        return DEFAULT_PROJECT_TYPE
    if value in PROJECT_TYPES:
        return value
    logger.warning(
        "Unknown project_type %r — falling back to %r. Valid values: %s",
        value, DEFAULT_PROJECT_TYPE, PROJECT_TYPES,
    )
    return DEFAULT_PROJECT_TYPE

PROJECT_STATUSES: tuple[str, ...] = ("pending", "storyboard_ready", "draft", "final")
DEFAULT_PROJECT_STATUS: str = "pending"

def is_valid_project_status(value: str) -> bool:
    return value in PROJECT_STATUSES
