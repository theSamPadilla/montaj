#!/usr/bin/env python3
"""Export a carousel as web pages: one still page per slide and a swipeable index.html.

Runs render/render-carousel.js with --html-dir --html-only (the slides are drawn by the same code and page that
produce the PNGs) and prints a JSON result. Its progress lines go to stderr; its error, if any, is the last JSON line
on stderr, which serve reads.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from cli.deps import render_runtime_dir
from lib.common import node_child_env, fail, require_file

MARKER = ".montaj-carousel-pages"


def read_project(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            project = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        fail("invalid_project", f"Could not read project.json at {path}: {e}")
    if project.get("projectType") != "carousel":
        fail("not_a_carousel", f"projectType must be 'carousel', got '{project.get('projectType')}'")
    return project


def check_out(out: str) -> None:
    """The folder is replaced only when it is new, empty, or one this step wrote."""
    if not os.path.exists(out):
        return
    if not os.path.isdir(out):
        fail("out_exists", f"{out} is a file")
    if os.listdir(out) and not os.path.exists(os.path.join(out, MARKER)):
        fail("out_exists", f"{out} already has other files in it; pick an empty folder")


def build_command(node_bin: str, project_path: str, out: str, tmp: str, slides) -> list:
    script = os.path.join(render_runtime_dir(), "render-carousel.js")
    cmd = [node_bin, script, "--project-json", project_path, "--out", tmp, "--scale", "1",
           "--html-dir", out, "--html-only"]
    if slides:
        cmd += ["--only", slides]
    return cmd


def main():
    parser = argparse.ArgumentParser(description="Export a carousel as web pages")
    parser.add_argument("--project", required=True, help="Absolute path to project.json")
    parser.add_argument("--out", default=None, help="The folder to write the pages to")
    parser.add_argument("--slides", default=None, help="Comma-separated slide numbers (default: all)")
    parser.add_argument("--list", dest="list_only", action="store_true", help="List the slides and write nothing")
    args = parser.parse_args()

    require_file(args.project)
    project = read_project(args.project)
    if args.list_only:
        items = [{"index": i + 1, "id": s.get("id")} for i, s in enumerate(project.get("slides") or [])]
        sys.stdout.write(json.dumps({"items": items}) + "\n")
        return
    if not args.out:
        fail("invalid_args", "--out <folder> is required unless --list is set")
    if not (project.get("slides") or []):
        fail("no_items", "The carousel has no slides to export")
    node_bin = shutil.which("node")
    if not node_bin:
        fail("not_found", "node not found in PATH")
    if not os.path.isfile(os.path.join(render_runtime_dir(), "render-carousel.js")):
        fail("not_found", "render-carousel.js not found")

    out = os.path.abspath(args.out)
    check_out(out)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    with open(os.path.join(out, MARKER), "w") as f:
        f.write("written by export_carousel_pages; a re-export replaces this folder\n")

    env = node_child_env()
    env["MONTAJ_ROOT"] = MONTAJ_ROOT
    tmp = tempfile.mkdtemp(prefix="montaj-carousel-pages-")
    try:
        proc = subprocess.run(build_command(node_bin, os.path.abspath(args.project), out, tmp, args.slides),
                              env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    stderr = proc.stderr.decode("utf-8", errors="replace")
    sys.stderr.write(stderr)
    warnings = [l.split("warning: ", 1)[1] for l in stderr.splitlines() if "warning: " in l]
    if proc.returncode != 0:
        if '{"error"' not in stderr:
            fail("export_failed", f"render-carousel.js exited {proc.returncode}")
        sys.exit(proc.returncode)
    files = []
    for root, _dirs, names in os.walk(out):
        for n in sorted(names):
            if n != MARKER:
                files.append(os.path.relpath(os.path.join(root, n), out))
    files.sort()
    pages = [f for f in files if f.startswith("slide-") and f.endswith(".html")]
    sys.stdout.write(json.dumps({"dir": out, "pages": pages, "index": "index.html", "files": files, "warnings": warnings}) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
