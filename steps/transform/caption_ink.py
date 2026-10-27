#!/usr/bin/env python3
"""caption_ink: set each caption's ink from the backdrop under it (the rules are lib/caption_ink.py).

Over a light card (graphics covering the caption's band: an opaque overlay, a 3D scene with a backdrop, or an overlay
whose pixels cover the band, as frame_broll's matte does) a caption draws dark, so it reads; elsewhere it draws
as its style does. The step reads the backdrop from the card's own render (a JSX card) or from one frame without captions per 3D item, measures the band the caption
draws in, and writes `ink` ("dark" or "light") and `inkAuto` ({card, ink, backdrop}: what it wrote) on the caption. An `ink` is the
step's only while `inkAuto` names the same ink; any other ink (none, edited, removed) is a person's and never changed.
Ink the step wrote is cleared when the card is gone. A caption whose words lie over different cards, or over a card and
footage, is split at the word nearest the edge, each piece inked on its own (a person's captions, translated ones and
those with translations are never split). It stops starting frames after 240 s (those captions are left as
they are, with a warning) and writes the ones it has.

The write: `captions` only, under the project lock, onto the captions as they are now; refused (`project_changed`,
nothing written) when a caption it changes, or the captions' style, was edited meanwhile. Prints one short JSON: {dark,
light, cleared, kept, split, snapped, changed, warnings?}; `changed` is whether anything was written.
"""
import argparse, json, os, sys

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from lib import caption_ink  # noqa: E402
from lib.common import fail  # noqa: E402
from lib.project_lock import ProjectLockTimeout, ProjectReadOnly  # noqa: E402
from lib.sync_clash import SyncBusy, SyncConflict, exit_refused  # noqa: E402

EMPTY = {"dark": 0, "light": 0, "cleared": 0, "kept": 0, "split": 0, "changed": False}


def run(project_path, render_fn=None):
    try:
        out = caption_ink.update(project_path, render_fn=render_fn)
    except (OSError, ValueError):
        fail("not_found", f"Project not readable: {project_path}")
    except caption_ink.InkProjectChanged:
        fail("project_changed", "The captions changed since caption_ink read them (an edit in the editor, or new "
                                "captions). Run caption_ink again.")
    except ProjectLockTimeout as e:
        fail("project_locked", str(e))
    except ProjectReadOnly as e:
        fail("project_read_only", str(e))
    except (SyncConflict, SyncBusy) as e:
        exit_refused(e.body)
    return out if out is not None else dict(EMPTY)


def main():
    parser = argparse.ArgumentParser(description="Set each caption's ink from the backdrop under it")
    parser.add_argument("--project", required=True, help="The project id, its folder, or its project.json")
    args = parser.parse_args()
    project_path = args.project
    if os.path.isdir(project_path):
        project_path = os.path.join(project_path, "project.json")
    if not os.path.isfile(project_path):
        fail("file_not_found", f"No project.json at {args.project}")
    print(json.dumps(run(project_path)))


if __name__ == "__main__":
    main()
