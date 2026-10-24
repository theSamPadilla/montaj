"""§569: an overlay template stored as the absolute path of an overlay shipped with Montaj.

The editor's "+ Text" (and the slides step) store a carousel overlay's `template` as the jsxPath serve listed: the
shipped overlay inside the maker's own runtime. The same project opened on another Mac (another user name, or Windows)
names a path that is not there. So a path that is MISSING and ends in `render/templates/overlays/<name>/<name>.jsx` (or
the flat `render/templates/overlays/<name>.jsx`) is read from the shipped copy of that name in this runtime. A path that exists is
always used as it is. The render side is montaj_assets/render/shipped-template.js, with the same rule.
"""
import re
from pathlib import Path

_NAME = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def shipped_template_key(path) -> "str | None":
    """`templates/overlays/<name>/<name>.jsx` or `templates/overlays/<name>.jsx` for a path ending in one, else None."""
    if not isinstance(path, str) or not path:
        return None
    segs = [s for s in re.split(r"[\\/]+", path)]
    if ".." in segs:
        return None
    n = len(segs)
    file = segs[-1]
    if not file.endswith(".jsx"):
        return None
    name = file[: -len(".jsx")]
    if not _NAME.match(name):
        return None
    # `render/` before `templates/` too: only the engine's own render folder, never e.g. a profile named `templates`
    if n >= 5 and segs[n - 5] == "render" and segs[n - 4] == "templates" and segs[n - 3] == "overlays" and segs[n - 2] == name:
        return f"templates/overlays/{name}/{name}.jsx"
    if n >= 4 and segs[n - 4] == "render" and segs[n - 3] == "templates" and segs[n - 2] == "overlays":
        return f"templates/overlays/{name}.jsx"
    return None


def resolve_template_path(path: str, render_dir) -> "Path | None":
    """The file for an overlay template: the path itself when it is a file, else this runtime's shipped copy
    (`render_dir`, the folder holding templates/) for a missing shipped overlay, else None."""
    p = Path(path)
    if p.is_file():
        return p
    key = shipped_template_key(path)
    if key is None:
        return None
    shipped = Path(render_dir).joinpath(*key.split("/"))
    return shipped if shipped.is_file() else None
