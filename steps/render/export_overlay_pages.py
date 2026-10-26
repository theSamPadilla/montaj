#!/usr/bin/env python3
"""Export a project's overlays and captions as self-contained web pages.

Runs render/export-pages.js into a temporary folder, then writes it as one new zip inside --out (`overlays.zip`,
then `overlays 2.zip`, ...; nothing already in --out is changed; inside, one folder named like the zip holds the
pages and assets/) and prints its JSON result with `zip` in place of `dir`. Its progress lines go to stderr as they arrive; its error, if any, is
the last JSON line on stderr, which serve reads.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from cli.deps import render_runtime_dir
from lib.common import node_child_env, fail, new_file_in, require_file, zip_folder

NAME = "overlays"
MARKER = ".montaj-overlay-pages"  # export-pages.js marks a folder it wrote; not part of the pages


def build_command(node_bin: str, project_path: str, out, items, list_only: bool) -> list:
    script = os.path.join(render_runtime_dir(), "export-pages.js")
    cmd = [node_bin, script, "--project", project_path]
    if list_only:
        cmd += ["--list"]
    else:
        cmd += ["--out", out]
        if items:
            cmd += ["--items", items]
    return cmd


def main():
    parser = argparse.ArgumentParser(description="Export a project's overlays as web pages")
    parser.add_argument("--project", required=True, help="Absolute path to project.json")
    parser.add_argument("--out", default=None, help="The folder to put the pages' zip in")
    parser.add_argument("--items", default=None, help="Comma-separated overlay ids or names (default: all)")
    parser.add_argument("--list", dest="list_only", action="store_true", help="List the overlays and write nothing")
    args = parser.parse_args()

    require_file(args.project)
    if not args.list_only and not args.out:
        fail("invalid_args", "--out <folder> is required unless --list is set")
    node_bin = shutil.which("node")
    if not node_bin:
        fail("not_found", "node not found in PATH")
    script = os.path.join(render_runtime_dir(), "export-pages.js")
    if not os.path.isfile(script):
        fail("not_found", "export-pages.js not found")

    env = node_child_env()
    env["MONTAJ_ROOT"] = MONTAJ_ROOT
    if args.list_only:
        proc = subprocess.run(build_command(node_bin, args.project, None, args.items, True), env=env,
                              stdout=subprocess.PIPE, stderr=None)
        if proc.returncode != 0:
            sys.exit(proc.returncode)  # the CLI's own error line is already on stderr (inherited), where serve reads it
        sys.stdout.write(proc.stdout.decode("utf-8", errors="replace"))
        sys.stdout.flush()
        return

    dest = new_file_in(args.out, NAME, ".zip")
    top = os.path.basename(dest)[:-len(".zip")]
    work = tempfile.mkdtemp(prefix="montaj-overlay-pages-")
    try:
        out = os.path.join(work, top)
        proc = subprocess.run(build_command(node_bin, args.project, out, args.items, False), env=env,
                              stdout=subprocess.PIPE, stderr=None)
        if proc.returncode != 0:
            os.remove(dest)  # the zip this run made, and only that
            sys.exit(proc.returncode)  # the CLI's own error line is already on stderr (inherited), where serve reads it
        result = json.loads(proc.stdout.decode("utf-8", errors="replace"))
        try:
            zip_folder(out, dest, top, skip={MARKER})
        except BaseException:
            os.remove(dest)
            raise
    finally:
        shutil.rmtree(work, ignore_errors=True)
    result.pop("dir", None)
    sys.stdout.write(json.dumps({"zip": dest, **result}) + "\n")
    sys.stdout.flush()

if __name__ == "__main__":
    main()
