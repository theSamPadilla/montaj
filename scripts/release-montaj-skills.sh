#!/usr/bin/env bash
#
# release-montaj-skills.sh — version + publish @bycrux/montaj-skills (montaj_assets/montaj-skills).
#
# Wraps the montaj-skills package release flow:
#   1. Detects whether the package changed since the last `montaj-skills-v*` tag.
#   2. Picks the semver bump from the change size (conventional commits), or use
#      an explicit level.
#   3. Runs the gate (the stage.mjs prepack script to confirm staging succeeds).
#   4. Bumps package.json, commits, tags `montaj-skills-v<version>`, publishes to
#      npm, and pushes.
#
# Usage:
#   scripts/release-montaj-skills.sh                  # auto-detect bump from commits
#   scripts/release-montaj-skills.sh patch|minor|major   # force a bump level
#   scripts/release-montaj-skills.sh --dry-run        # show what it WOULD do, change nothing
#   scripts/release-montaj-skills.sh --yes            # skip the confirmation prompt
#
# Auth (publishing):
#   - Preferred: export NPM_TOKEN=<npm automation/granular token>. Automation
#     tokens bypass 2FA, so no OTP code is ever needed. The token is written to
#     a throwaway npmrc for the publish and removed immediately after.
#     Create one at npmjs.com → Access Tokens → Generate → "Automation".
#   - Fallback: pass --otp <code> for interactive 2FA, or rely on `npm login`.
#
# Bump auto-detection (commits touching montaj_assets/montaj-skills since the last tag):
#   - any `BREAKING CHANGE` or `type!:` subject  → major
#   - any `feat:` / `feat(...):` subject          → minor
#   - otherwise                                   → patch
#
# Notes:
#   - npm versions are IMMUTABLE — a bad publish means bumping again.
#   - Publishing is independent of Montaj's own version (do NOT use version-bump.sh).
#   - Requires a clean working tree and either NPM_TOKEN (preferred) or an npm
#     login with publish rights to the `bycrux` org.
#   - The `prepack` script (scripts/stage.mjs) runs automatically on `npm publish`,
#     staging the domain skills + contract before packing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$ROOT/montaj_assets/montaj-skills"
PKG_NAME="@bycrux/montaj-skills"
TAG_PREFIX="montaj-skills-v"

LEVEL="auto"
DRY_RUN=0
ASSUME_YES=0
OTP=""
FIRST_RELEASE=0
while [ $# -gt 0 ]; do
  case "$1" in
    patch|minor|major) LEVEL="$1" ;;
    --dry-run)         DRY_RUN=1 ;;
    --yes|-y)          ASSUME_YES=1 ;;
    --otp)             shift; OTP="${1:-}" ;;
    --otp=*)           OTP="${1#--otp=}" ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

note() { printf '\033[36m[release-montaj-skills]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[release-montaj-skills] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────
[ -f "$PKG_DIR/package.json" ] || die "package not found at $PKG_DIR"

# Clean tree: we commit + tag + publish, so the published version must equal a
# committed state. (Run this AFTER committing your montaj-skills changes.)
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  die "working tree is dirty — commit (or stash) your changes first, then release."
fi

BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  note "WARNING: on branch '$BRANCH', not 'main'. Publish from main when possible."
  if [ "$ASSUME_YES" -ne 1 ]; then
    read -r -p "Continue from '$BRANCH'? [y/N] " ans; [ "$ans" = "y" ] || die "aborted."
  fi
fi

git -C "$ROOT" fetch --tags --quiet || true

CUR_VERSION="$(node -p "require('$PKG_DIR/package.json').version")"
LAST_TAG="$(git -C "$ROOT" tag -l "${TAG_PREFIX}*" | sort -V | tail -1)"

# ── Bootstrap: no prior tag ───────────────────────────────────────────────────
# Two cases when there's no `montaj-skills-v*` tag:
#   - The package is ALREADY on npm (e.g. published out-of-band): just plant the
#     baseline tag so future runs can diff against it — no bump, no publish.
#   - The package is NOT on npm yet: this is the first-ever release. Publishing a
#     baseline-then-rerun would dead-end ("no changes since the tag"), so do a
#     real first release here. Default to a `minor` (0.0.0 → 0.1.0) unless an
#     explicit level was passed.
if [ -z "$LAST_TAG" ]; then
  if npm view "$PKG_NAME" version >/dev/null 2>&1; then
    note "No '${TAG_PREFIX}*' tag, but ${PKG_NAME} is already on npm. Baselining (no bump, no publish)."
    if [ "$DRY_RUN" -eq 1 ]; then note "[dry-run] would: git tag ${TAG_PREFIX}${CUR_VERSION} && git push origin ${TAG_PREFIX}${CUR_VERSION}"; exit 0; fi
    git -C "$ROOT" tag "${TAG_PREFIX}${CUR_VERSION}"
    git -C "$ROOT" push origin "${TAG_PREFIX}${CUR_VERSION}"
    note "Tagged ${TAG_PREFIX}${CUR_VERSION}. Re-run after committing package changes."
    exit 0
  fi
  note "No '${TAG_PREFIX}*' tag and ${PKG_NAME} is not on npm yet — publishing the FIRST release."
  FIRST_RELEASE=1
  [ "$LEVEL" = "auto" ] && LEVEL="minor"
fi

# ── Detect changes to the package since the last tag (skip on first release) ──
if [ "$FIRST_RELEASE" -ne 1 ]; then
  if git -C "$ROOT" diff --quiet "$LAST_TAG" HEAD -- montaj_assets/montaj-skills; then
    note "No changes to montaj_assets/montaj-skills since $LAST_TAG — nothing to publish."
    exit 0
  fi

  SUBJECTS="$(git -C "$ROOT" log "$LAST_TAG"..HEAD --format='%s%n%b' -- montaj_assets/montaj-skills)"

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
if [ "$FIRST_RELEASE" -eq 1 ]; then
  note "First release of ${PKG_NAME} (not previously on npm)."
else
  note "Commits since $LAST_TAG touching the package:"
  git -C "$ROOT" log "$LAST_TAG"..HEAD --oneline -- montaj_assets/montaj-skills | sed 's/^/    /'
fi
echo

if [ "$DRY_RUN" -eq 1 ]; then
  note "[dry-run] would: bump → gate → commit → tag ${TAG_PREFIX}${NEXT_VERSION} → npm publish → push. Nothing changed."
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Release ${PKG_NAME}@${NEXT_VERSION}? [y/N] " ans; [ "$ans" = "y" ] || die "aborted."
fi

# ── Gate ──────────────────────────────────────────────────────────────────────
note "Gate: stage domain skills (prepack dry-run — confirms staging succeeds before publish)"
( cd "$PKG_DIR" && node scripts/stage.mjs )

# ── Bump, commit, tag, publish, push ─────────────────────────────────────────
note "Bumping package.json → $NEXT_VERSION"
( cd "$PKG_DIR" && npm version "$NEXT_VERSION" --no-git-tag-version >/dev/null )

git -C "$ROOT" add montaj_assets/montaj-skills/package.json
git -C "$ROOT" commit -m "release(montaj-skills): ${PKG_NAME} v${NEXT_VERSION}"
git -C "$ROOT" tag "${TAG_PREFIX}${NEXT_VERSION}"

# Auth precedence: NPM_TOKEN (automation token, bypasses 2FA) → --otp → npm login.
# access:public + default registry come from the package's publishConfig.
# The prepack script (scripts/stage.mjs) runs automatically via `npm publish`,
# so domain skills are freshly staged from /skills at the tagged commit.
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
