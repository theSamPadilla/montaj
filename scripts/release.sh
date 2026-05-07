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

# ── Colors (only when stdout is a TTY) ──────────────────────────────────────
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'   C_DIM=$'\033[2m'    C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'    C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'   C_CYAN=$'\033[36m'
else
  C_RESET=''  C_DIM=''  C_BOLD=''
  C_RED=''    C_GREEN='' C_YELLOW=''
  C_BLUE=''   C_CYAN=''
fi

err()  { printf '%s%serror:%s %s\n' "$C_BOLD" "$C_RED"   "$C_RESET" "$1" >&2; }
warn() { printf '%s%swarn:%s  %s\n' "$C_BOLD" "$C_YELLOW" "$C_RESET" "$1" >&2; }
info() { printf '%s%s%s\n'          "$C_BOLD" "$1"        "$C_RESET"; }
ok()   { printf '%s%s✓%s %s\n'      "$C_BOLD" "$C_GREEN"  "$C_RESET" "$1"; }
hint() { printf '%s%s%s\n'          "$C_DIM"  "$1"        "$C_RESET"; }

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
    *) err "unknown arg: $1"; exit 2 ;;
  esac
done

VERSION="$(awk -F'"' '/^version[[:space:]]*=/ { print $2; exit }' pyproject.toml)"
if [[ -z "$VERSION" ]]; then
  err "could not read version from pyproject.toml"
  exit 1
fi
TAG="v$VERSION"

command -v gh >/dev/null || { err "gh CLI not installed (https://cli.github.com)"; exit 1; }
gh auth status >/dev/null 2>&1 || { err "gh not authenticated — run \`gh auth login\`"; exit 1; }

if gh release view "$TAG" >/dev/null 2>&1; then
  err "release $TAG already exists on GitHub"
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
  err "no '## $TAG' section found in CHANGELOG.md (or it is empty)"
  hint "  hint: scripts/version-bump.sh promotes '## Unreleased' to '## $TAG' for you."
  exit 1
fi

info "release notes for ${C_CYAN}$TAG${C_RESET}${C_BOLD}:"
printf '%s%s%s\n' "$C_DIM" "----------------------------------------" "$C_RESET"
cat "$NOTES_FILE"
printf '%s%s%s\n' "$C_DIM" "----------------------------------------" "$C_RESET"

# Note: ${EXTRA_FLAGS[@]+...} is the bash 3.2-safe expansion for an array that
# may be empty. Bare "${EXTRA_FLAGS[@]}" trips `set -u` on macOS's stock bash.
CMD=(gh release create "$TAG" --title "$TAG" --notes-file "$NOTES_FILE" ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"})
if [[ "$ATTACH" -eq 1 ]]; then
  shopt -s nullglob
  ARTIFACTS=(dist/*)
  shopt -u nullglob
  if [[ ${#ARTIFACTS[@]} -eq 0 ]]; then
    err "--attach-artifacts requested but dist/ is empty (run scripts/build.sh first)"
    exit 1
  fi
  CMD+=("${ARTIFACTS[@]}")
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  info "dry-run — would execute:"
  printf "${C_DIM}  "
  printf '%q ' "${CMD[@]}"
  printf "${C_RESET}\n"
  exit 0
fi

echo
info "creating GitHub release ${C_CYAN}$TAG${C_RESET}${C_BOLD}…"
"${CMD[@]}"
ok "release ${C_CYAN}$TAG${C_RESET} published."
