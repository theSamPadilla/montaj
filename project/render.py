#!/usr/bin/env python3
"""montaj render — thin launcher for render/render.js."""
import os, sys

# Import here to avoid circular imports when run standalone
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cli.output import emit_error


def main(project_path=None, out=None, workers=None, clean=False, montaj_root=None):
    root       = montaj_root or os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    render_js  = os.path.join(root, "render", "render.js")

    cmd = ["node", render_js]
    if project_path: cmd.append(project_path)
    if out:          cmd += ["--out", out]
    if workers:      cmd += ["--workers", str(workers)]
    if clean:        cmd.append("--clean")

    env               = os.environ.copy()
    env["MONTAJ_ROOT"] = root

    try:
        os.execvpe("node", cmd, env)
    except FileNotFoundError:
        emit_error("node_not_found", "node is not on PATH — install Node.js to use montaj render")


if __name__ == "__main__":
    main()
