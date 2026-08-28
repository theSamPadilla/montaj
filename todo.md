# Todo

Open items as of 2026-08-26.

## Security / dependencies

### 1. Raise the dependency floors in `pyproject.toml`

`uv.lock` is now patched (commit `87de7cd`), but **that does not protect anyone
installing montaj**. CI installs via `pip install -e ".[test]"` and PyPI/Homebrew
users resolve from the floors in `pyproject.toml`, which still permit every
vulnerable version:

- `Pillow>=10.0` — allows the versions with the heap OOB writes in
  `paste`/`crop`/`RankFilter`/`ImageCms` and the decompression-bomb bypasses
  (patched in 12.3.0)
- `yt-dlp>=2026.3` — allows arbitrary code exec via aria2c manifest downloads
  and command injection via `--exec` (patched in 2026.7.4)

A fresh `pip install montaj` today can still resolve to these. Raising the floors
is the change that actually closes it, and it tightens constraints on published
releases — which is why it was left as a deliberate decision rather than folded
into the lockfile patch.

### 2. torch bump — unblocks the last two advisories

`setuptools` is held at 81.0.0 by `torch 2.11.0`, so these two only clear when
torch moves. One problem, not two:

- `setuptools` CVE-2026-59890 (moderate) — needs 83.0.0
- `torch` CVE-2025-3000 (low) — needs 2.13.0

torch is a heavy `rvm`/`demucs` extra, so it was kept out of the security patch.
Needs its own pass with the ML extras actually installed and exercised.

### 3. npm-side Dependabot alerts

Only the pip side was addressed. Still open on the default branch, across
`montaj_assets/{editor,ui,render,mcp}/package-lock.json`:

- **2 critical** — `vitest` CVE-2026-47429 (CVSS 9.8), editor + ui. Verified
  **not exploitable here**: `@vitest/ui` is not installed, neither
  `vitest.config.ts` sets `api`/`api.host` so the server never binds, the
  path-traversal half is Windows-only, and it is `scope: development` in both
  manifests so it never ships. Fix is a `^2` → `^3.2.6` major bump, which needs
  a real test-suite pass since Vitest 3 changed defaults.
- **~35 high/moderate** — `vite`, `postcss`, `js-yaml`, `brace-expansion`,
  `ip-address`, `fast-uri`, `hono`, `react-router`, `esbuild`.
- `extract-zip` (render) — symlink path traversal, **no patch available**.
  Nothing to bump to; needs a decision, not an upgrade.

## Release tooling

### 4. `release-timeline-core.sh` tags before it publishes

This bit on 2026-08-26 and cost a full debugging cycle. The script's order is
gate → bump → commit → tag → `npm publish` → push. When the publish failed
(2FA: the account is `auth-and-writes`, and neither `NPM_TOKEN` nor `--otp` was
supplied, so it died with `EOTP`), the tag was already written — asserting a
release that never happened. The push never ran either, so the state was:
local says 0.2.0 shipped, npm still served 0.1.0, origin had neither.

**The damaging part is the recovery behaviour.** Every subsequent run gates on
`git diff --quiet timeline-core-v0.2.0 HEAD -- montaj_assets/timeline-core`,
finds nothing newer, prints `nothing to publish` — and **exits 0**. A clean
no-op that is indistinguishable from success. Anything chaining these scripts
with `&&` treats it as done and walks straight into the editor gate, which is
the only thing that then catches it.

There is also no supported way out: no `--force`/republish flag, and deleting
the local tags to reach the first-release path does not work, because line 94
runs `git fetch --tags` and pulls `timeline-core-v0.1.0` back from origin —
so instead of republishing 0.2.0 as-is it would compute a bump off 0.2.0 and
publish 0.2.1/0.3.0, orphaning the existing commit and tag. Recovery had to be
a bare `npm publish` of the already-committed version.

Worth considering:

- Tag *after* a successful publish, not before (or delete the tag on failure).
- Exit non-zero, or at least loudly, when a `timeline-core-v*` tag exists but
  that version is absent from npm — that exact mismatch is the stuck state.
- A `--republish` path for "tag exists, npm does not have it".
- Prefer `NPM_TOKEN` in the docs over `--otp`: the editor release needs its
  publish credential at the *end* of a multi-minute test/lint/tsc gate, so a
  hand-typed 30-second OTP is a bad fit.

## Test environment

### 5. Nine tests can't run without optional extras

Not a regression — they fail identically on the old lock, so this is
pre-existing. Noting it because it makes any dependency work harder to verify:

- `tests/test_remove_bg.py` (7) — hard-exits at import with
  `missing_dependency: torch, torchvision, av`. CI installs only `.[test]`, so
  these presumably do not pass there either.
- `tests/test_init.py` (2) — `vf.index("zscale=")` raises; needs a
  zscale-capable ffmpeg resolvable from the venv under test.

Either skip these when the extras/binary are absent, or document that a full
verification run needs `--extra rvm` and a managed ffmpeg.
