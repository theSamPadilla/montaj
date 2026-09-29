#!/usr/bin/env python3
"""montaj render — thin launcher for render/render.js."""
import json, os, sys

# Import here to avoid circular imports when run standalone
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cli.output import emit_error
from cli.deps import render_runtime_dir
from cli.main import MONTAJ_ROOT as _MONTAJ_ROOT
from lib.common import node_child_env, progress


def _log_probe_failures(healed) -> None:
    """One render-log line per file the heal could not read (PV57): the file,
    the reason, and whether it is `blocking`, i.e. whether a clip was left as
    it is because of it (it then keeps its look in this render and is looked
    at again next time). A user whose clip does not heal can see which file
    matters. Never raises: the heal never stops a render, nor does its report."""
    try:
        for f in (healed or {}).get("probeFailed") or []:
            if f.get("blocking"):
                what = f"blocking: {f.get('src') or f['path']} is left as it is until this file reads"
            else:
                what = "not blocking: nothing was left undone because of it"
            progress(f"colour provenance: could not read {f['path']} ({f['reason']}: {f['detail']}); {what}")
    except Exception:
        pass


def main(project_path=None, out=None, workers=None, clean=False, scale=None, montaj_root=None, image_tone=None,
         export=None, sdr_curve=None):
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
        # Heal an HDR project whose SDR clips were converted in place before
        # PV42, so the export grades each layer by its origin. Never raises.
        if project_path and os.path.basename(project_path) == "project.json":
            from lib.color_provenance import ensure_color_provenance
            healed = ensure_color_provenance(os.path.dirname(os.path.abspath(project_path)))
            _log_probe_failures(healed)
        render_js = os.path.join(render_dir, "render.js")
        cmd = ["node", render_js]
        if project_path: cmd.append(project_path)
        if out:          cmd += ["--out", out]
        if workers:      cmd += ["--workers", str(workers)]
        if clean:        cmd.append("--clean")
        if image_tone:   cmd += ["--image-tone", image_tone]
        if export:       cmd += ["--export", export]
        if sdr_curve:    cmd += ["--sdr-curve", sdr_curve]

    env                = node_child_env()
    env["MONTAJ_ROOT"] = str(montaj_root or _MONTAJ_ROOT)

    try:
        os.execvpe("node", cmd, env)
    except FileNotFoundError:
        emit_error("node_not_found", "node is not on PATH — install Node.js to use montaj render")


if __name__ == "__main__":
    main()
