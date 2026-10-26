"""The file a typed path means when its name was typed with other spaces or another Unicode form (PL89i).

macOS names every screen recording and screenshot with a NARROW NO-BREAK SPACE (U+202F) before AM/PM
("Screen Recording 2026-10-21 at 11.59.52 AM.mov"); an agent or a paste types a plain space, and the path
names no file. The same goes for U+00A0, U+2007 and every other Unicode space, and for a name stored in NFD and
typed in NFC. When a path names no file, a name in its folder that differs only in those ways is its twin.

Used wherever montaj takes a path an agent typed: a step's inputs (serve/routes/steps.py resolve_spacing), an item
src a save writes (serve/routes/projects.py), /api/files (read_file) and frame_broll's clip.
"""
import os
import re
import unicodedata

# Whitespace and every Unicode space separator (category Zs), a run read as one plain space.
_SPACES = re.compile(r"[\s   -   　]+")


def space_key(name: str) -> str:
    """`name` in NFC with each run of spaces of any kind as one plain space."""
    return _SPACES.sub(" ", unicodedata.normalize("NFC", name))


def spaced_twins(path) -> list:
    """Every file beside an absolute `path` that names nothing, whose name differs from it only in its kinds of space
    or its Unicode form (sorted full paths); [] when `path` exists, is not absolute, or nothing matches."""
    if not isinstance(path, str) or not os.path.isabs(path) or os.path.lexists(path):
        return []
    folder, name = os.path.split(path)
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    want = space_key(name)
    return sorted(os.path.join(folder, n) for n in names if n != name and space_key(n) == want)


def spaced_twin(path):
    """The one twin of `path` (spaced_twins), else None: never a guess between two."""
    hits = spaced_twins(path)
    return hits[0] if len(hits) == 1 else None
