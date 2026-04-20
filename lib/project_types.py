"""Project type and status values — single source of truth.

Mirrored in ui/src/lib/project.ts. When adding/renaming a value, update BOTH
files. A mismatch breaks the round-trip between workflow JSON (written by
humans), project.json (written by init.py), and the UI branches.

Match the existing module-level-constant pattern from engine/validate.py;
do not use enum.Enum — none of the repo's other shared-constant files do,
and plain strings round-trip through JSON without ceremony.
"""
import logging

logger = logging.getLogger(__name__)

# ── Project types ─────────────────────────────────────────────────────────────

PROJECT_TYPES: tuple[str, ...] = ("editing", "music_video", "ai_video")
DEFAULT_PROJECT_TYPE: str = "editing"


def is_valid_project_type(value: str) -> bool:
    return value in PROJECT_TYPES


def normalize_project_type(value: str | None, *, warn: bool = True) -> str:
    """Coerce unknown/None values to DEFAULT_PROJECT_TYPE.

    Logs a warning for non-None invalid values so typos in workflow files
    are visible rather than silently swallowed.
    """
    if value is None:
        return DEFAULT_PROJECT_TYPE
    if value in PROJECT_TYPES:
        return value
    if warn:
        logger.warning("Unknown project_type %r — falling back to %r", value, DEFAULT_PROJECT_TYPE)
    return DEFAULT_PROJECT_TYPE


# ── Project statuses ──────────────────────────────────────────────────────────

PROJECT_STATUSES: tuple[str, ...] = ("pending", "storyboard_ready", "draft", "final")
DEFAULT_PROJECT_STATUS: str = "pending"


def is_valid_project_status(value: str) -> bool:
    return value in PROJECT_STATUSES
