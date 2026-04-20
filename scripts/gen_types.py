#!/usr/bin/env python3
"""Generate Python + TypeScript enum modules from schema/enums.yaml."""
import sys
from pathlib import Path

import yaml  # pyyaml

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA = REPO_ROOT / "schema" / "enums.yaml"
PY_OUT_DIR = REPO_ROOT / "lib" / "types"
TS_OUT_DIR = REPO_ROOT / "ui" / "src" / "lib" / "types"

HEADER_PY = """\
# GENERATED FROM schema/enums.yaml — DO NOT EDIT BY HAND.
# Run `python3 scripts/gen_types.py` after editing the YAML source.
"""

HEADER_TS = """\
// GENERATED FROM schema/enums.yaml — DO NOT EDIT BY HAND.
// Run `python3 scripts/gen_types.py` after editing the YAML source.
"""


def to_camel(name: str) -> str:
    """snake_case → camelCase"""
    parts = name.split("_")
    return parts[0] + "".join(p.title() for p in parts[1:])


def to_pascal(name: str) -> str:
    """snake_case → PascalCase"""
    return "".join(p.title() for p in name.split("_"))


def plural(name: str) -> str:
    upper = name.upper()
    if upper.endswith("S"):
        return upper + "ES"
    return upper + "S"


def validate_schema(enums: list[dict]) -> None:
    seen_names: set[str] = set()
    for e in enums:
        for req in ("name", "module", "values"):
            if req not in e:
                sys.exit(f"enum missing required field '{req}': {e}")
        if e["name"] in seen_names:
            sys.exit(f"duplicate enum name: {e['name']}")
        seen_names.add(e["name"])
        if not isinstance(e["values"], list) or not e["values"]:
            sys.exit(f"enum {e['name']}: 'values' must be a non-empty list")
        if "default" in e and e["default"] not in e["values"]:
            sys.exit(f"enum {e['name']}: default {e['default']!r} not in values")
        helpers = e.get("helpers", {})
        if helpers.get("normalize") and "default" not in e:
            sys.exit(f"enum {e['name']}: normalize:true requires a default")


def emit_python_module(module: str, enums: list[dict]) -> str:
    lines: list[str] = [HEADER_PY]

    # Collect descriptions for docstring
    descs = [e["description"].strip() for e in enums if e.get("description")]
    if descs:
        lines.append('"""')
        for d in descs:
            for line in d.splitlines():
                lines.append(line)
            lines.append("")
        lines.append('"""')

    # Import logging only if any enum uses normalize
    needs_logging = any(e.get("helpers", {}).get("normalize") for e in enums)
    if needs_logging:
        lines.append("import logging")
        lines.append("")
        lines.append("logger = logging.getLogger(__name__)")
    lines.append("")

    for e in enums:
        name = e["name"]
        values = e["values"]
        helpers = e.get("helpers", {})
        const_name = plural(name)
        default_name = f"DEFAULT_{name.upper()}"

        # Values tuple
        vals_str = ", ".join(f'"{v}"' for v in values)
        lines.append(f'{const_name}: tuple[str, ...] = ({vals_str})')

        # Default
        if "default" in e:
            lines.append(f'{default_name}: str = "{e["default"]}"')

        lines.append("")

        # is_valid helper
        if helpers.get("is_valid", True):
            lines.append(f"def is_valid_{name}(value: str) -> bool:")
            lines.append(f"    return value in {const_name}")
            lines.append("")

        # normalize helper
        if helpers.get("normalize"):
            lines.append(f"def normalize_{name}(value: str | None) -> str:")
            lines.append(f'    """Coerce unknown/None to {default_name}.')
            lines.append(f"    None → silent fallback.")
            lines.append(f"    Unknown string → warn + fallback.")
            lines.append(f'    """')
            lines.append(f"    if value is None:")
            lines.append(f"        return {default_name}")
            lines.append(f"    if value in {const_name}:")
            lines.append(f"        return value")
            lines.append(f"    logger.warning(")
            lines.append(f'        "Unknown {name} %r — falling back to %r. Valid values: %s",')
            lines.append(f"        value, {default_name}, {const_name},")
            lines.append(f"    )")
            lines.append(f"    return {default_name}")
            lines.append("")

    # Ensure file ends with single newline
    return "\n".join(lines).rstrip() + "\n"


def emit_typescript_module(module: str, enums: list[dict]) -> str:
    lines: list[str] = [HEADER_TS]

    for e in enums:
        name = e["name"]
        values = e["values"]
        helpers = e.get("helpers", {})
        const_name = plural(name)
        type_name = to_pascal(name)
        default_name = f"DEFAULT_{name.upper()}"
        camel_name = to_camel(name)

        # Values array
        vals_str = ", ".join(f"'{v}'" for v in values)
        lines.append(f"export const {const_name} = [{vals_str}] as const")
        lines.append(f"export type {type_name} = typeof {const_name}[number]")

        # Default
        if "default" in e:
            lines.append(f"export const {default_name}: {type_name} = '{e['default']}'")

        lines.append("")

        # is_valid helper (type guard)
        if helpers.get("is_valid", True):
            lines.append(f"export function is{type_name}(value: unknown): value is {type_name} {{")
            lines.append(f"  return typeof value === 'string' && ({const_name} as readonly string[]).includes(value)")
            lines.append(f"}}")
            lines.append("")

        # normalize helper
        if helpers.get("normalize"):
            lines.append(f"export function normalize{type_name}(value: unknown): {type_name} {{")
            lines.append(f"  if (value === null || value === undefined) return {default_name}")
            lines.append(f"  if (is{type_name}(value)) return value")
            lines.append(f"  // eslint-disable-next-line no-console")
            lines.append(f"  console.warn(")
            lines.append(f"    `Unknown {name} ${{JSON.stringify(value)}} — falling back to ${{{default_name}}}. ` +")
            lines.append(f"    `Valid values: ${{{const_name}.join(', ')}}`,")
            lines.append(f"  )")
            lines.append(f"  return {default_name}")
            lines.append(f"}}")
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    with open(SCHEMA) as f:
        doc = yaml.safe_load(f)
    enums = doc["enums"]
    validate_schema(enums)

    by_module: dict[str, list[dict]] = {}
    for e in enums:
        by_module.setdefault(e["module"], []).append(e)

    PY_OUT_DIR.mkdir(parents=True, exist_ok=True)
    TS_OUT_DIR.mkdir(parents=True, exist_ok=True)
    (PY_OUT_DIR / "__init__.py").write_text(
        '"""Generated enum modules. See schema/enums.yaml."""\n'
    )

    for module, mod_enums in by_module.items():
        py = emit_python_module(module, mod_enums)
        ts = emit_typescript_module(module, mod_enums)
        (PY_OUT_DIR / f"{module}.py").write_text(py)
        (TS_OUT_DIR / f"{module}.ts").write_text(ts)

    print(f"Generated {len(by_module)} module(s) × 2 languages.")


if __name__ == "__main__":
    main()
