#!/usr/bin/env bash
# Bump the project version everywhere it's declared.
#
# Source of truth: pyproject.toml. The script reads the current version from
# there for the no-arg "show" mode, and writes the new version to all four
# tracked files plus the JS package-lock.json mirrors:
#
#   - pyproject.toml
#   - montaj_assets/render/package.json     (+ package-lock.json)
#   - montaj_assets/ui/package.json         (+ package-lock.json)
#   - montaj_assets/mcp/package.json        (+ package-lock.json)
#
# Usage:
#   scripts/bump-version.sh                 # show current version
#   scripts/bump-version.sh 2.1.0           # set everywhere to 2.1.0
#
# The script is idempotent — running it twice with the same version is a no-op.
# It does NOT git-commit; review the diff and commit yourself.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PYPROJECT="pyproject.toml"
PKG_JSONS=(
  "montaj_assets/render/package.json"
  "montaj_assets/ui/package.json"
  "montaj_assets/mcp/package.json"
)
LOCK_JSONS=(
  "montaj_assets/render/package-lock.json"
  "montaj_assets/ui/package-lock.json"
  "montaj_assets/mcp/package-lock.json"
)

current_version() {
  # Read `version = "X.Y.Z"` from pyproject.toml (top-level, project section).
  awk -F'"' '/^version[[:space:]]*=/ { print $2; exit }' "$PYPROJECT"
}

if [[ $# -eq 0 ]]; then
  echo "current version: $(current_version)"
  exit 0
fi

NEW_VERSION="$1"

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must match X.Y.Z (got: $NEW_VERSION)" >&2
  exit 2
fi

OLD_VERSION="$(current_version)"

if [[ "$OLD_VERSION" == "$NEW_VERSION" ]]; then
  echo "already at $NEW_VERSION — nothing to do"
  exit 0
fi

echo "bumping $OLD_VERSION → $NEW_VERSION"

# pyproject.toml — single targeted line edit (avoids touching dependency pins
# that happen to match X.Y.Z form).
python3 - "$PYPROJECT" "$NEW_VERSION" <<'PY'
import re, sys
path, new = sys.argv[1], sys.argv[2]
text = open(path).read()
new_text, n = re.subn(r'(?m)^(version\s*=\s*")[^"]+(")', rf'\g<1>{new}\g<2>', text, count=1)
if n != 1:
    sys.exit(f"failed to find version line in {path}")
open(path, "w").write(new_text)
PY

# package.json files — JSON-safe edit via python.
python3 - "$NEW_VERSION" "${PKG_JSONS[@]}" <<'PY'
import json, sys
new = sys.argv[1]
for path in sys.argv[2:]:
    with open(path) as f:
        data = json.load(f)
    data["version"] = new
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
PY

# package-lock.json files — version appears twice (top-level + packages[""])
# and lockfileVersion 3 also keeps name there. Leave name/lockfileVersion alone;
# only sync version. If a lock file is missing (fresh checkout, no npm install
# yet), skip it silently.
python3 - "$NEW_VERSION" "${LOCK_JSONS[@]}" <<'PY'
import json, os, sys
new = sys.argv[1]
for path in sys.argv[2:]:
    if not os.path.exists(path):
        continue
    with open(path) as f:
        data = json.load(f)
    data["version"] = new
    if "" in data.get("packages", {}):
        data["packages"][""]["version"] = new
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
PY

echo "done. files updated:"
echo "  $PYPROJECT"
for f in "${PKG_JSONS[@]}" "${LOCK_JSONS[@]}"; do
  [[ -f "$f" ]] && echo "  $f"
done
echo
echo "next: review the diff (\`git diff\`), then commit."
