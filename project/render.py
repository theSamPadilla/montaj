#!/usr/bin/env python3
"""montaj render — thin launcher for render/render.js."""
import json, os, sys

# Import here to avoid circular imports when run standalone
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cli.output import emit_error
from cli.deps import render_runtime_dir
from cli.main import MONTAJ_ROOT as _MONTAJ_ROOT
from lib.common import ffmpeg_bin, ffprobe_bin


def main(project_path=None, out=None, workers=None, clean=False, scale=None, montaj_root=None, image_tone=None):
    # Determine project type so we can dispatch to the correct renderer.
    project_type = None
    if project_path and os.path.isfile(project_path):
        try:
            with open(project_path, "r", encoding="utf-8") as f:
                project_type = json.load(f).get("projectType")
        except Exception:
            pass  # Let the node script handle bad JSON

    render_dir = render_runtime_dir()

    if project_type == "carousel":
        # Transcode any .webp image bed to a sibling .png and render a normalized
        # copy of project.json — the render Chromium can't decode .webp. Returns the
        # original path unchanged when there's nothing to normalize.
        from project.carousel_normalize import normalize_carousel_assets
        render_input = str(normalize_carousel_assets(project_path))
        render_js = os.path.join(render_dir, "render-carousel.js")
        cmd = ["node", render_js, "--project-json", render_input]
        if out:    cmd += ["--out", out]
        if clean:  cmd.append("--clean")
        if scale is not None: cmd += ["--scale", str(scale)]
    else:
        render_js = os.path.join(render_dir, "render.js")
        cmd = ["node", render_js]
        if project_path: cmd.append(project_path)
        if out:          cmd += ["--out", out]
        if workers:      cmd += ["--workers", str(workers)]
        if clean:        cmd.append("--clean")
        if image_tone:   cmd += ["--image-tone", image_tone]

    env                = os.environ.copy()
    env["MONTAJ_ROOT"] = str(montaj_root or _MONTAJ_ROOT)
    env["MONTAJ_FFMPEG"]  = ffmpeg_bin()
    env["MONTAJ_FFPROBE"] = ffprobe_bin()

    try:
        os.execvpe("node", cmd, env)
    except FileNotFoundError:
        emit_error("node_not_found", "node is not on PATH — install Node.js to use montaj render")


if __name__ == "__main__":
    main()
