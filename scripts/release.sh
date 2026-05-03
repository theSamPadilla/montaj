#!/usr/bin/env bash
# Create a GitHub Release for the current version in pyproject.toml.
#
# Source of truth: pyproject.toml (version) + CHANGELOG.md (notes).
# `gh release create` creates the tag and the GitHub Release in one step,
# so this script supersedes scripts/tag.sh for release builds.
#
# Behavior:
#   - Reads version from pyproject.toml; tag is `v<version>`.
#   - Extracts notes from the `## v<version>` section of CHANGELOG.md.
#   - Aborts if the release already exists, the section is missing/empty,
#     gh is not authed, or the working tree differs from origin/<branch>.
#   - With --attach-artifacts, uploads everything in dist/ to the release.
#
# Usage:
#   scripts/release.sh                       # publish release for current version
#   scripts/release.sh --attach-artifacts    # also upload dist/* to release
#   scripts/release.sh --draft               # create as draft (no tag pushed yet)
#   scripts/release.sh --dry-run             # print what would happen, do nothing

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ATTACH=0
DRY_RUN=0
EXTRA_FLAGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --attach-artifacts) ATTACH=1; shift ;;
    --draft)            EXTRA_FLAGS+=(--draft); shift ;;
    --dry-run)          DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; $d'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

VERSION="$(awk -F'"' '/^version[[:space:]]*=/ { print $2; exit }' pyproject.toml)"
if [[ -z "$VERSION" ]]; then
  echo "error: could not read version from pyproject.toml" >&2
  exit 1
fi
TAG="v$VERSION"

command -v gh >/dev/null || { echo "error: gh CLI not installed (https://cli.github.com)" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh not authenticated — run \`gh auth login\`" >&2; exit 1; }

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "error: release $TAG already exists on GitHub" >&2
  exit 1
fi

# Extract notes between `## v<version>` and the next `## ` heading. `### `
# subheadings are kept (they only match `^## `, two hashes + space).
NOTES_FILE="$(mktemp -t montaj-release-notes.XXXXXX)"
trap 'rm -f "$NOTES_FILE"' EXIT

awk -v header="## $TAG" '
  $0 == header        { in_section = 1; next }
  in_section && /^## / { exit }
  in_section          { print }
' CHANGELOG.md > "$NOTES_FILE"

# Trim leading/trailing blank lines.
python3 - "$NOTES_FILE" <<'PY'
import sys
p = sys.argv[1]
text = open(p).read().strip("\n")
open(p, "w").write(text + "\n" if text else "")
PY

if ! [[ -s "$NOTES_FILE" ]]; then
  echo "error: no '## $TAG' section found in CHANGELOG.md (or it is empty)" >&2
  echo "  hint: scripts/version-bump.sh promotes '## Unreleased' to '## $TAG' for you." >&2
  exit 1
fi

echo "release notes for $TAG:"
echo "----------------------------------------"
cat "$NOTES_FILE"
echo "----------------------------------------"

CMD=(gh release create "$TAG" --title "$TAG" --notes-file "$NOTES_FILE" "${EXTRA_FLAGS[@]}")
if [[ "$ATTACH" -eq 1 ]]; then
  shopt -s nullglob
  ARTIFACTS=(dist/*)
  shopt -u nullglob
  if [[ ${#ARTIFACTS[@]} -eq 0 ]]; then
    echo "error: --attach-artifacts requested but dist/ is empty (run scripts/build.sh first)" >&2
    exit 1
  fi
  CMD+=("${ARTIFACTS[@]}")
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "dry-run — would execute:"
  printf '  %q' "${CMD[@]}"
  echo
  exit 0
fi

echo
echo "creating GitHub release $TAG..."
"${CMD[@]}"
echo "done. release $TAG published."
