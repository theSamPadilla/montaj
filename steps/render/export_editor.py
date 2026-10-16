#!/usr/bin/env python3
"""Export a project for a video editor (Premiere Pro, DaVinci Resolve).

Runs render/export-editor.js (FCP7 XML + a copy of the media + one ProRes 4444
alpha movie per overlay + captions movie + captions.srt) and prints its JSON result. The CLI's
per-movie progress lines ({"progress": {...}}) are relayed to stderr as they
arrive; its error, if any, is the last JSON line on stderr, which serve reads.
"""
import argparse, json, os, shutil, subprocess, sys, threading

MONTAJ_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, MONTAJ_ROOT)
from cli.deps import render_runtime_dir
from lib.common import node_child_env, fail, require_file


def package_name(project_path: str, name):
    """The explicit name, else the project's own name (then its id, then its folder)."""
    if name and name.strip():
        return name.strip()
    try:
        with open(project_path, encoding="utf-8") as f:
            project = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        fail("invalid_project", f"Could not read project.json at {project_path}: {e}")
    return (project.get("name") or project.get("id")
            or os.path.basename(os.path.dirname(os.path.abspath(project_path))))


def build_command(node_bin: str, project_path: str, name: str, out, editor=None) -> list:
    script = os.path.join(render_runtime_dir(), "export-editor.js")
    cmd = [node_bin, script, "--project", project_path, "--name", name]
    if editor:
        cmd += ["--editor", editor]
    if out:
        cmd += ["--out", out]
    return cmd


def run_export(cmd: list, env: dict):
    """Run the CLI, relaying its stderr live. Returns (stdout, returncode, saw_error)."""
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    chunks = []
    reader = threading.Thread(target=lambda: chunks.append(proc.stdout.read()), daemon=True)
    reader.start()
    saw_error = False
    for raw in proc.stderr:
        line = raw.decode("utf-8", errors="replace")
        if line.startswith('{"error"'):
            saw_error = True
        sys.stderr.write(line)
        sys.stderr.flush()
    proc.wait()
    reader.join()
    return b"".join(chunks).decode("utf-8", errors="replace"), proc.returncode, saw_error


def main():
    parser = argparse.ArgumentParser(description="Export a project for a video editor")
    parser.add_argument("--project", required=True, help="Absolute path to project.json")
    parser.add_argument("--name", default=None, help="Package name (default: the project's name)")
    parser.add_argument("--editor", default=None, help="premiere (default), resolve, fcp or ae")
    parser.add_argument("--out", default=None,
                        help="The folder the package goes in (default: <project_dir>/export/)")
    args = parser.parse_args()

    require_file(args.project)
    node_bin = shutil.which("node")
    if not node_bin:
        fail("not_found", "node not found in PATH")
    script = os.path.join(render_runtime_dir(), "export-editor.js")
    if not os.path.isfile(script):
        fail("not_found", "export-editor.js not found")

    env = node_child_env()
    env["MONTAJ_ROOT"] = MONTAJ_ROOT
    cmd = build_command(node_bin, args.project, package_name(args.project, args.name), args.out, args.editor)

    stdout, code, saw_error = run_export(cmd, env)
    if code != 0:
        # The CLI's own error line is already on stderr; make sure there is one.
        if not saw_error:
            fail("export_failed", f"export-editor.js exited {code}")
        sys.exit(code)
    sys.stdout.write(stdout)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
