"""Retired project shapes, read as their current form.

serve converges a project on open (``_open_project``, with the tracks migration, under the project lock, through
``save_guard.maintenance_allows``), answers the revisions route through it and applies it to every PUT, so the next
save writes it too. Every other reader already copes: ``lib.types.project.normalize_project_type`` reads an unknown
type as ``editing``.

- ``projectType: "music_video"`` (the retired Lyric video) reads as ``"editing"``.
- A project from a 3D template (``workflow`` model-3d or toy-world-3d) typed ``"editing"``, or with no type, reads as
  ``"3d"``: the explicit type replaced "editing plus the template's id". Only the template decides: ``model3d`` is no
  sign of it, because ``save_model`` sets it on any project, and a 3D overlay is allowed in every video.
- ``renderMode: "ffmpeg-drawtext"`` (retired with the ``lyrics_render`` step) goes. That render burned the captions in
  and skipped the overlay tracks, which held only ``lyric-phrase.jsx`` overlays as an editor preview of them. Each
  such track is turned off (``enabled: false``; nothing is deleted), so the captions draw once, as before.

The app's Studio sync compares documents through the same rules (desktop/src/studio-sync/project-migrate.cjs in
montaj-app), so this write never pushes or clashes on its own. Change both together.

Pure: never mutates its input, and returns the SAME object when nothing changes.
"""

from lib.project_tracks import normalize_tracks

RETIRED_PROJECT_TYPES = {"music_video": "editing"}
THREE_D_WORKFLOWS = frozenset({"model-3d", "toy-world-3d"})
RETIRED_RENDER_MODE = "ffmpeg-drawtext"
_LYRIC_PREVIEW_TEMPLATE = "lyric-phrase.jsx"


def _basename(src) -> str:
    return src.replace("\\", "/").rsplit("/", 1)[-1] if isinstance(src, str) else ""


def _is_lyric_preview_track(track) -> bool:
    """A track object whose items are all lyric-phrase overlays (at least one)."""
    if not isinstance(track, dict) or not isinstance(track.get("items"), list) or not track["items"]:
        return False
    return all(
        isinstance(item, dict) and item.get("type") == "overlay" and _basename(item.get("src")) == _LYRIC_PREVIEW_TEMPLATE
        for item in track["items"]
    )


def migrate_project(project):
    """``project`` with its retired shapes converged (see the module doc). Tracks must be in object form already
    (``normalize_tracks`` first); a list of lists is left as it is."""
    if not isinstance(project, dict):
        return project
    out = None
    retired_type = project.get("projectType")
    if isinstance(retired_type, str) and retired_type in RETIRED_PROJECT_TYPES:
        out = dict(project)
        out["projectType"] = RETIRED_PROJECT_TYPES[retired_type]
    current_type = (out if out is not None else project).get("projectType")
    workflow = project.get("workflow")
    if isinstance(workflow, str) and workflow in THREE_D_WORKFLOWS and current_type in (None, "editing"):
        out = out if out is not None else dict(project)
        out["projectType"] = "3d"
    if project.get("renderMode") == RETIRED_RENDER_MODE:
        out = out if out is not None else dict(project)
        del out["renderMode"]
        tracks = project.get("tracks")
        if isinstance(tracks, list):
            out["tracks"] = [
                {**t, "enabled": False} if _is_lyric_preview_track(t) and t.get("enabled") is not False else t
                for t in tracks
            ]
    return project if out is None else out


def converge(project):
    """The project as every reader gets it: tracks in object form, then the retired shapes above. The SAME object
    when nothing changes."""
    return migrate_project(normalize_tracks(project))
