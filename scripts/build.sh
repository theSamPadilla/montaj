#!/bin/bash
# Build sdist + wheel for PyPI release.
#
# NEVER run `python -m build --wheel` alone. The --wheel-only form builds
# direct from source and bypasses MANIFEST.in `prune`, leaking ~600
# node_modules files into the wheel. The no-flag form routes wheel
# construction through the sdist where prunes apply — that's why this script
# exists, and why it ships an explicit guard assertion.
#
# Usage:
#   scripts/build.sh           # build + verify
#   twine upload dist/*        # publish (separate step — review dist/ first)
set -euo pipefail
cd "$(dirname "$0")/.."

# ANSI colors (TTY only — pipes and CI logs stay plain).
if [[ -t 1 ]]; then
  BOLD='\033[1m'; DIM='\033[2m'
  CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'
  RESET='\033[0m'
else
  BOLD=''; DIM=''; CYAN=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi

step()  { printf '%b→%b %s\n'   "$CYAN"  "$RESET" "$1"; }
ok()    { printf '%b✓%b %s\n'   "$GREEN" "$RESET" "$1"; }
warn()  { printf '%b⚠%b %s\n'   "$YELLOW" "$RESET" "$1"; }
fail()  { printf '%b✗ %s%b\n'   "$RED"   "$1" "$RESET" >&2; exit 1; }

trap 'fail "build failed — see output above"' ERR

step "cleaning ${BOLD}dist/${RESET}, ${BOLD}build/${RESET}, ${BOLD}*.egg-info${RESET}"
rm -rf dist/ build/ *.egg-info

step "running ${BOLD}python -m build${RESET} ${DIM}(sdist + wheel; do NOT pass --wheel)${RESET}"
.venv/bin/python -m build > /tmp/montaj-build.log 2>&1 \
  || { cat /tmp/montaj-build.log; fail "python -m build failed"; }
ok   "sdist + wheel built ${DIM}(log: /tmp/montaj-build.log)${RESET}"

step "verifying wheel contents"
.venv/bin/python <<'PY'
import glob, sys, zipfile
wheel = glob.glob('dist/*.whl')[0]
names = zipfile.ZipFile(wheel).namelist()
checks = {
    'node_modules': sum(1 for n in names if 'node_modules' in n),
    'ui/dist':      sum(1 for n in names if '/ui/dist/' in n),
    '__pycache__':  sum(1 for n in names if '__pycache__' in n),
}
for label, hits in checks.items():
    if hits:
        print(f"FAIL wheel leaked {hits} {label} entries", file=sys.stderr)
        sys.exit(1)
print(f"{wheel} | {len(names)} files | 0 leaks")
PY
ok   "wheel clean ${DIM}(0 node_modules, 0 ui/dist, 0 __pycache__)${RESET}"

echo
printf '%b%bReady to publish.%b\n' "$BOLD" "$GREEN" "$RESET"
printf '  Inspect: %bls -lh dist/%b\n'        "$DIM"  "$RESET"
printf '  Publish: %btwine upload dist/*%b\n' "$CYAN" "$RESET"
