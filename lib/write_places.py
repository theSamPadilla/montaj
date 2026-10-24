"""Where a step may write a file it names itself, outside any `out` the caller gave.

The deny predicate behind serve's export and beside-input checks (serve/out_guard.py), here so a step can use
it too: clean_cut writes a clip's transcript beside the clip, which can sit anywhere on disk. serve/out_guard.py
keeps its own `_real_home`, `_serve_home` and `_is_darwin` (its tests patch them) and passes them in.
"""
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

MONTAJ_ROOT = Path(__file__).resolve().parent.parent


def real(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


def fold(path: str) -> str:
    """Case and Unicode folded, so `~/LIBRARY` on a case-insensitive disk still counts as ~/Library."""
    return unicodedata.normalize("NFKC", path).casefold()


def is_darwin() -> bool:
    return sys.platform == "darwin"


def real_home() -> str:
    """The user's real home. In the app serve's HOME is the app's runtime home, so not os.path.expanduser."""
    try:
        import pwd
        return pwd.getpwuid(os.getuid()).pw_dir
    except (ImportError, KeyError, AttributeError):
        return os.path.expanduser("~")  # Windows: USERPROFILE


def serve_home() -> str:
    return os.path.expanduser("~")


def workspace_dir() -> str:
    """The workspace, by serve's precedence: MONTAJ_WORKSPACE_DIR, ~/.montaj/config.json, ~/Montaj."""
    env = os.environ.get("MONTAJ_WORKSPACE_DIR")
    if env:
        return env
    try:
        cfg = json.loads((Path.home() / ".montaj" / "config.json").read_text())
        if cfg.get("workspaceDir"):
            return str(cfg["workspaceDir"])
    except (OSError, ValueError, AttributeError):
        pass
    return str(Path.home() / "Montaj")


def ino(path: str):
    """(st_dev, st_ino) of `path`, or None when it does not exist."""
    try:
        st = os.stat(path)
        return (st.st_dev, st.st_ino)
    except OSError:
        return None


def under_by_ino(path: str, root_id) -> bool:
    """True when `path`, or any ancestor of it, is the folder identified by `root_id` (a dev:ino pair)."""
    if root_id is None:
        return False
    p = Path(path)
    for anc in (p, *p.parents):
        if ino(str(anc)) == root_id:
            return True
    return False


def within(path: str, root: str) -> bool:
    """`path` is `root` or below it; both already real and normcased."""
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:  # different drives on Windows
        return False


def has_git_component(*values: str) -> bool:
    """Any of `values` has a path component that folds to `.git`."""
    for value in values:
        if not value:
            continue
        for part in re.split(r"[\\/]", value):
            if part and fold(part) == fold(".git"):
                return True
    return False


def deny_root_paths(real_home_dir: str, serve_home_dir: str, montaj_root: str) -> list:
    """Real paths an export may never go under (compared by dev:ino)."""
    roots = [
        os.path.join(real_home_dir, "Library"),
        os.path.join(real_home_dir, "AppData"),
        os.path.join(serve_home_dir, ".montaj"),
        os.path.join(serve_home_dir, ".cache"),
        montaj_root,
        sys.prefix,
        sys.base_prefix,
        "/Applications",
        "/usr/local",
        "/opt/homebrew",
    ]
    return [real(r) for r in roots]


def cloud_roots(real_home_dir: str, darwin: bool) -> list:
    """The cloud-storage subtrees of ~/Library an export may go in (macOS only): iCloud Drive and each File
    Provider sync folder (`Library/CloudStorage/<Provider>-<account>`)."""
    if not darwin:
        return []
    lib = os.path.join(real_home_dir, "Library")
    roots = [os.path.join(lib, "Mobile Documents", "com~apple~CloudDocs")]
    cloud = os.path.join(lib, "CloudStorage")
    try:
        roots += [os.path.join(cloud, e) for e in os.listdir(cloud)]
    except OSError:
        pass
    # An entry that is a link out of its parent (a CloudStorage/x pointing at ~/Library/LaunchAgents) opens nothing.
    out = []
    for r in roots:
        parent_id = ino(os.path.dirname(r))
        rr = real(r)
        if ino(rr) != parent_id and under_by_ino(rr, parent_id):
            out.append(rr)
    return out


def export_folder_ok(path: str, *, real_home_dir=None, serve_home_dir=None, darwin=None, montaj_root=None) -> bool:
    """An existing folder a user may pick for an export: not hidden, not under `/System/Volumes/`, not an `.app`
    bundle, not a system or app folder (cloud-storage folders in ~/Library excepted; their hidden folders are
    still refused). Deny roots compare by dev:ino, so a firmlink form of `~/Library` is refused too."""
    real_home_dir = real_home() if real_home_dir is None else real_home_dir
    serve_home_dir = serve_home() if serve_home_dir is None else serve_home_dir
    darwin = is_darwin() if darwin is None else darwin
    montaj_root = str(MONTAJ_ROOT) if montaj_root is None else montaj_root
    if not os.path.isdir(path):
        return False
    if any(part.startswith(".") for part in Path(path).parts):
        return False
    if fold(path).startswith(fold("/System/Volumes/")):
        return False
    if any(fold(part).endswith(".app") for part in Path(path).parts):
        return False
    library_id = ino(os.path.join(real_home_dir, "Library"))
    cloud = any(under_by_ino(path, cid) for cid in (ino(r) for r in cloud_roots(real_home_dir, darwin)))
    for root in deny_root_paths(real_home_dir, serve_home_dir, montaj_root):
        root_id = ino(root)
        if root_id is None:
            continue
        if under_by_ino(path, root_id) and not (cloud and root_id == library_id):
            return False
    return True


def sidecar_folder_ok(folder: str, project_dir: str) -> bool:
    """A folder a step may put a file of its own naming in: no `.git` component, and inside the project or the
    workspace, or else an ordinary folder a user could pick for an export (`export_folder_ok`)."""
    r = real(folder)
    if has_git_component(folder, r):
        return False
    if within(r, real(project_dir)) or within(r, real(workspace_dir())):
        return True
    return export_folder_ok(r)
