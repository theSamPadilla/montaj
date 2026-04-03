#!/usr/bin/env python3
"""montaj create-step — scaffold a new custom step."""
import os, sys
from cli.output import emit_error

STEP_PY_TEMPLATE = '''\
#!/usr/bin/env python3
"""{name} — describe what this step does."""
import os, sys, argparse
import cli.main as _m
sys.path.insert(0, os.path.join(os.path.dirname(_m.__file__), "..", "lib"))
from common import fail, require_file, check_output, run

def main():
    parser = argparse.ArgumentParser(description="{name}")
    parser.add_argument("--input", required=True, help="Input video file")
    parser.add_argument("--out", help="Output file path")
    args = parser.parse_args()

    require_file(args.input)
    ext = os.path.splitext(args.input)[1]
    out = args.out or os.path.splitext(args.input)[0] + "_{name}" + ext

    # TODO: implement
    fail("not_implemented", "{name} is not yet implemented")

    check_output(out)
    print(out)

if __name__ == "__main__":
    main()
'''

STEP_JSON_TEMPLATE = '''\
{{
  "name": "{name}",
  "description": "Describe what this step does",
  "input": {{ "type": "video", "description": "Input video file" }},
  "output": {{ "type": "video", "description": "Output video file" }},
  "params": []
}}
'''


def register(subparsers):
    p = subparsers.add_parser("create-step", help="Scaffold a new custom step")
    p.add_argument("name", help="Step name")
    p.set_defaults(func=handle)


def handle(args):
    steps_dir = os.path.join(os.getcwd(), "steps")
    os.makedirs(steps_dir, exist_ok=True)
    py_path   = os.path.join(steps_dir, f"{args.name}.py")
    json_path = os.path.join(steps_dir, f"{args.name}.json")
    if os.path.exists(py_path) or os.path.exists(json_path):
        emit_error("already_exists", f"Step already exists: {args.name}")
    with open(py_path, "w") as f:
        f.write(STEP_PY_TEMPLATE.format(name=args.name))
    os.chmod(py_path, 0o755)
    with open(json_path, "w") as f:
        f.write(STEP_JSON_TEMPLATE.format(name=args.name))
    print(py_path)
    print(json_path)
