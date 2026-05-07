#!/usr/bin/env python3
"""montaj render — thin launcher for render/render.js."""
import json, os, sys

# Import here to avoid circular imports when run standalone
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cli.output import emit_error


def main(project_path=None, out=None, workers=None, clean=False, montaj_root=None):
    root = montaj_root or os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

    # Determine project type so we can dispatch to the correct renderer.
    project_type = None
    if project_path and os.path.isfile(project_path):
        try:
            with open(project_path, "r", encoding="utf-8") as f:
                project_type = json.load(f).get("projectType")
        except Exception:
            pass  # Let the node script handle bad JSON

    if project_type == "carousel":
        render_js = os.path.join(root, "montaj_assets", "render", "render-carousel.js")
        cmd = ["node", render_js, "--project-json", project_path]
        if out:    cmd += ["--out", out]
        if clean:  cmd.append("--clean")
    else:
        render_js = os.path.join(root, "montaj_assets", "render", "render.js")
        cmd = ["node", render_js]
        if project_path: cmd.append(project_path)
        if out:          cmd += ["--out", out]
        if workers:      cmd += ["--workers", str(workers)]
        if clean:        cmd.append("--clean")

    env                = os.environ.copy()
    env["MONTAJ_ROOT"] = root

    try:
        os.execvpe("node", cmd, env)
    except FileNotFoundError:
        emit_error("node_not_found", "node is not on PATH — install Node.js to use montaj render")


if __name__ == "__main__":
    main()
