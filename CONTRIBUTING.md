# Contributing to Montaj

## Setup

```bash
git clone https://github.com/theSamPadilla/montaj
cd montaj

# Python (CLI, steps, server)
python -m venv venv && source venv/bin/activate
pip install -e ".[test]"

# UI
cd ui && npm install

# Render engine
cd render && npm install
```

System deps: `ffmpeg`, `ffprobe`, `whisper.cpp` (with at least `ggml-base.en.bin`).

---

## Running tests

```bash
make test          # run the full suite
make test-fast     # skip slow/ffmpeg-heavy tests
pytest tests/steps/test_probe.py   # single file
```

Tests require `ffmpeg`. Whisper-dependent tests use a fake binary fixture — no model download needed.

---

## Adding a step

A step is a Python script in `steps/` paired with a JSON schema. That's it.

**1. Write the script** (`steps/my_step.py`):

```python
#!/usr/bin/env python3
import argparse, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from common import fail, require_file, check_output, run

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()

    require_file(args.input)
    out = args.out or args.input.replace(".mp4", "_mystep.mp4")

    run(["ffmpeg", "-y", "-i", args.input, ..., out])
    check_output(out)
    print(out)   # stdout = result path

if __name__ == "__main__":
    main()
```

**Output contract:**
- Success → print result path (or JSON) to stdout, exit 0
- Error → print JSON `{"error": "code", "message": "..."}` to stderr, exit 1
- Never print progress to stdout — use stderr

**2. Write the schema** (`steps/my_step.json`):

```json
{
  "name": "my_step",
  "description": "One sentence: what it does and when to use it.",
  "params": [
    { "name": "input",  "type": "string",  "required": true,  "description": "Source video file" },
    { "name": "out",    "type": "string",  "required": false, "description": "Output path (default: input + _mystep.mp4)" }
  ]
}
```

The schema is what the agent and MCP server use to discover and call steps — keep the description agent-readable.

**3. Write a test** (`tests/steps/test_my_step.py`):

```python
import pytest
from conftest import run_step, assert_file_output

def test_my_step_basic(test_video):
    proc = run_step("my_step.py", "--input", str(test_video))
    assert_file_output(proc)
```

**4. That's it.** The step is automatically available via `montaj step my-step`, `POST /api/steps/my_step`, and MCP.

---

## Adding a workflow

Workflows live in `workflows/`. Copy `workflows/overlays.json`, adjust the step sequence and `needs` dependencies, and document it in `docs/WORKFLOWS.md`.

---

## Adding a shared enum

Shared enums that both Python and TypeScript need to agree on (project types, project statuses, Kling aspect ratios, etc.) live in a single source of truth at `schema/enums.yaml`. A codegen script emits the per-language modules — you never hand-edit the generated files.

**1. Edit `schema/enums.yaml`:**

```yaml
enums:
  # ...existing entries...

  - name: video_mode              # snake_case, singular
    module: kling                 # emits lib/types/kling.py + ui/src/lib/types/kling.ts
    values: [std, pro]            # list order is preserved in generated tuples
    default: std                  # required if helpers.normalize is true
    description: |
      Kling `mode` body parameter. `std` is cheaper/faster; `pro` is
      higher-quality at higher cost. Constant across an ai_video project.
    helpers:
      is_valid: true              # emits is_valid_video_mode / isVideoMode
      normalize: true             # emits normalize_video_mode / normalizeVideoMode (warns on typo)
```

**2. Run codegen:**

```bash
python3 scripts/gen_types.py          # from repo root
# OR
cd ui && npm run gen                   # from ui/
```

This regenerates `lib/types/<module>.py` and `ui/src/lib/types/<module>.ts`. Both have a `GENERATED FROM schema/enums.yaml — DO NOT EDIT BY HAND` header.

**3. Commit both the YAML and the generated files.** CI runs `python3 scripts/gen_types.py && git diff --exit-code` and fails if you forgot to regenerate.

### Rules

- **Never hand-edit a file with the `GENERATED FROM` header.** Your changes will be overwritten on the next regen.
- **The codegen is dev-only.** It doesn't run at server startup, user install, or production deploy — the generated files are source-controlled artifacts. Runtime code imports the committed outputs directly. `pyyaml` is declared in `requirements-dev.txt`, not runtime deps.
- **Closed enums only.** Compound interfaces (like `Project`, `Workflow`, `VisualItem`) are hand-written in `ui/src/lib/types/schema.ts` — they're not part of the codegen pipeline today.
- **Python callers** import via fully-qualified package paths:
  ```python
  sys.path.insert(0, REPO_ROOT)  # not "lib" — the repo root
  from lib.types.project import normalize_project_type
  from lib.types.kling import ASPECT_RATIOS, is_valid_aspect_ratio
  ```
  Use this pattern when adding new importers. The older `sys.path.insert(..., "lib"); from project_types import ...` convention still works for existing `lib/` modules (`common`, `workflow`, etc.) but can't reach nested packages like `lib.types.project` because stdlib `types` shadows the bare `types` name.

- **TypeScript callers** import from `@/lib/types/<module>` for generated enums and `@/lib/types/schema` for hand-written interfaces:
  ```ts
  import { PROJECT_TYPES, normalizeProjectType } from '@/lib/types/project'
  import { ASPECT_RATIOS } from '@/lib/types/kling'
  import type { Project, VisualItem } from '@/lib/types/schema'
  ```

---


## PRs

- Keep PRs focused — one feature or fix per PR
- New steps need a test and a schema
- Run `make test` before opening a PR
- If you're not sure about a direction, open an issue first
