#!/usr/bin/env bash
#
# release-editor.sh — version + publish @bycrux/editor (montaj_assets/editor).
#
# Wraps the editor-package release flow documented in RELEASE.md:
#   1. Detects whether the package changed since the last `editor-v*` tag.
#   2. Picks the semver bump from the change size (conventional commits), or use
#      an explicit level.
#   3. Runs the gate (test + lint + tsc, and the Montaj dogfood typecheck).
#   4. Bumps package.json, commits, tags `editor-v<version>`, publishes to npm,
#      and pushes.
#
# Usage:
#   scripts/release-editor.sh                # auto-detect bump from commits
#   scripts/release-editor.sh patch|minor|major   # force a bump level
#   scripts/release-editor.sh --dry-run      # show what it WOULD do, change nothing
#   scripts/release-editor.sh --yes          # skip the confirmation prompt
#   scripts/release-editor.sh --build        # also run the full Montaj `ui` vite build (slow)
#
# Auth (publishing):
#   - Preferred: export NPM_TOKEN=<npm automation/granular token>. Automation
#     tokens bypass 2FA, so no OTP code is ever needed. The token is written to
#     a throwaway npmrc for the publish and removed immediately after.
#     Create one at npmjs.com → Access Tokens → Generate → "Automation".
#   - Fallback: pass --otp <code> for interactive 2FA, or rely on `npm login`.
#
# Bump auto-detection (commits touching montaj_assets/editor since the last tag):
#   - any `BREAKING CHANGE` or `type!:` subject  → major
#   - any `feat:` / `feat(...):` subject          → minor
#   - otherwise                                   → patch
#
# Notes:
#   - npm versions are IMMUTABLE — a bad publish means bumping again.
#   - Publishing is independent of Montaj's own version (do NOT use version-bump.sh).
#   - Requires a clean working tree and either NPM_TOKEN (preferred) or an npm
#     login with publish rights to the `bycrux` org.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$ROOT/montaj_assets/editor"
UI_DIR="$ROOT/montaj_assets/ui"
PKG_NAME="@bycrux/editor"
TAG_PREFIX="editor-v"

LEVEL="auto"
DRY_RUN=0
ASSUME_YES=0
RUN_BUILD=0
OTP=""
while [ $# -gt 0 ]; do
  case "$1" in
    patch|minor|major) LEVEL="$1" ;;
    --dry-run)         DRY_RUN=1 ;;
    --yes|-y)          ASSUME_YES=1 ;;
    --build)           RUN_BUILD=1 ;;
    --otp)             shift; OTP="${1:-}" ;;
    --otp=*)           OTP="${1#--otp=}" ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

note() { printf '\033[36m[release-editor]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[release-editor] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────
[ -f "$PKG_DIR/package.json" ] || die "package not found at $PKG_DIR"

# Clean tree: we commit + tag + publish, so the published version must equal a
# committed state. (Run this AFTER committing your editor changes.)
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  die "working tree is dirty — commit (or stash) your changes first, then release."
fi

BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  note "WARNING: on branch '$BRANCH', not 'main'. Publish carousel/video-stable from main."
  if [ "$ASSUME_YES" -ne 1 ]; then
    read -r -p "Continue from '$BRANCH'? [y/N] " ans; [ "$ans" = "y" ] || die "aborted."
  fi
fi

git -C "$ROOT" fetch --tags --quiet || true

CUR_VERSION="$(node -p "require('$PKG_DIR/package.json').version")"
LAST_TAG="$(git -C "$ROOT" tag -l "${TAG_PREFIX}*" | sort -V | tail -1)"

# ── Bootstrap: no prior tag → tag the current published version as the baseline ─
if [ -z "$LAST_TAG" ]; then
  note "No '${TAG_PREFIX}*' tag found. Baselining the current published version ${PKG_NAME}@${CUR_VERSION}."
  note "This run only sets the baseline tag (no bump, no publish). Make changes, then re-run."
  if [ "$DRY_RUN" -eq 1 ]; then note "[dry-run] would: git tag ${TAG_PREFIX}${CUR_VERSION} && git push origin ${TAG_PREFIX}${CUR_VERSION}"; exit 0; fi
  git -C "$ROOT" tag "${TAG_PREFIX}${CUR_VERSION}"
  git -C "$ROOT" push origin "${TAG_PREFIX}${CUR_VERSION}"
  note "Tagged ${TAG_PREFIX}${CUR_VERSION}. Re-run after committing package changes."
  exit 0
fi

# ── Detect changes to the package since the last tag ──────────────────────────
if git -C "$ROOT" diff --quiet "$LAST_TAG" HEAD -- montaj_assets/editor; then
  note "No changes to montaj_assets/editor since $LAST_TAG — nothing to publish."
  exit 0
fi

SUBJECTS="$(git -C "$ROOT" log "$LAST_TAG"..HEAD --format='%s%n%b' -- montaj_assets/editor)"

if [ "$LEVEL" = "auto" ]; then
  if echo "$SUBJECTS" | grep -qiE '(BREAKING CHANGE|^[a-z]+(\([^)]*\))?!:)'; then
    LEVEL="major"
  elif echo "$SUBJECTS" | grep -qiE '^feat(\([^)]*\))?:'; then
    LEVEL="minor"
  else
    LEVEL="patch"
  fi
  note "Auto-detected bump: $LEVEL (from commits since $LAST_TAG)."
fi

# Compute the next version WITHOUT mutating anything. (Do NOT use
# `npm version --dry-run` here — on some npm builds it ignores --dry-run and
# actually writes package.json, which then trips the real bump with
# "Version not changed". Compute purely with node instead.)
NEXT_VERSION="$(node -e '
    const [maj,min,pat]=require(process.argv[1]).version.split(".").map(Number);
    const l=process.argv[2];
    console.log(l==="major"?`${maj+1}.0.0`:l==="minor"?`${maj}.${min+1}.0`:`${maj}.${min}.${pat+1}`);
  ' "$PKG_DIR/package.json" "$LEVEL")"
[ -n "$NEXT_VERSION" ] || die "could not compute next version from $CUR_VERSION ($LEVEL)"

echo
note "Package : $PKG_NAME"
note "Current : $CUR_VERSION  →  Next: $NEXT_VERSION  ($LEVEL)"
note "Commits since $LAST_TAG touching the package:"
git -C "$ROOT" log "$LAST_TAG"..HEAD --oneline -- montaj_assets/editor | sed 's/^/    /'
echo

if [ "$DRY_RUN" -eq 1 ]; then
  note "[dry-run] would: bump → gate → commit → tag ${TAG_PREFIX}${NEXT_VERSION} → npm publish → push. Nothing changed."
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Release ${PKG_NAME}@${NEXT_VERSION}? [y/N] " ans; [ "$ans" = "y" ] || die "aborted."
fi

# ── Gate ──────────────────────────────────────────────────────────────────────
note "Gate: package test + lint + tsc"
( cd "$PKG_DIR" && npm test && npm run lint && npx tsc --noEmit )
note "Gate: Montaj dogfood typecheck (ui tsc)"
( cd "$UI_DIR" && npx tsc --noEmit )
if [ "$RUN_BUILD" -eq 1 ]; then
  note "Gate: Montaj ui build"
  ( cd "$UI_DIR" && npm run build )
fi

# ── Bump, commit, tag, publish, push ─────────────────────────────────────────
note "Bumping package.json → $NEXT_VERSION"
( cd "$PKG_DIR" && npm version "$NEXT_VERSION" --no-git-tag-version >/dev/null )

git -C "$ROOT" add montaj_assets/editor/package.json montaj_assets/editor/package-lock.json
git -C "$ROOT" commit -m "release(editor): ${PKG_NAME} v${NEXT_VERSION}"
git -C "$ROOT" tag "${TAG_PREFIX}${NEXT_VERSION}"

# Auth precedence: NPM_TOKEN (automation token, bypasses 2FA) → --otp → npm login.
# access:public + default registry come from the package's publishConfig.
note "Publishing to npm…"
if [ -n "${NPM_TOKEN:-}" ]; then
  note "Authenticating with NPM_TOKEN (automation token — no OTP needed)."
  TMP_NPMRC="$(mktemp)"
  trap 'rm -f "$TMP_NPMRC"' EXIT
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$TMP_NPMRC"
  ( cd "$PKG_DIR" && npm publish --userconfig "$TMP_NPMRC" )
  rm -f "$TMP_NPMRC"; trap - EXIT
else
  ( cd "$PKG_DIR" && npm publish ${OTP:+--otp="$OTP"} )
fi

note "Pushing commit + tag"
git -C "$ROOT" push origin HEAD
git -C "$ROOT" push origin "${TAG_PREFIX}${NEXT_VERSION}"

echo
note "Released ${PKG_NAME}@${NEXT_VERSION} ✓   (npmjs.com/package/${PKG_NAME})"
note "Consumers: bump their dependency to ^${NEXT_VERSION} and reinstall."
