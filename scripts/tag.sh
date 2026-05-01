#!/usr/bin/env bash
# Tag the current commit with the version from pyproject.toml and push it.
#
# Source of truth: pyproject.toml. The tag is `v<version>` (e.g. v2.1.3).
#
# Behavior:
#   - Reads version from pyproject.toml.
#   - If the tag already exists locally OR on origin, exits cleanly (idempotent).
#   - Otherwise creates an annotated tag on HEAD and pushes it to origin.
#
# Usage:
#   scripts/tag.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="$(awk -F'"' '/^version[[:space:]]*=/ { print $2; exit }' pyproject.toml)"
if [[ -z "$VERSION" ]]; then
  echo "error: could not read version from pyproject.toml" >&2
  exit 1
fi

TAG="v$VERSION"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "tag $TAG already exists locally — nothing to do"
  exit 0
fi

if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "tag $TAG already exists on origin — nothing to do"
  exit 0
fi

echo "tagging HEAD as $TAG"
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
echo "pushed $TAG to origin"
