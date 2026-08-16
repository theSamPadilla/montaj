# @bycrux/timeline-core

Pure resolver for "what is on screen at time T" — the single source of
truth shared by Montaj's editor preview, render engine, and
`sample-frame.js`. Python's `caption_job.py` stays a separate
implementation but is checked against the same fixture corpus.

## Rules

- **Zero build step.** Plain JS ESM with JSDoc types (`// @ts-check`), plus
  a hand-written `index.d.ts`. No `dist/`, no bundler, no `prepare` step.
- **Zero runtime dependencies.** `devDependencies` is `typescript` only.
- **Pure.** No `Date`, `Math.random`, I/O, or globals. Same inputs always
  produce the same outputs. `tsconfig.json` omits the DOM lib on purpose,
  so accidental `window`/`document`/timer usage is a compile error.
- **`index.d.ts` is normative.** It is the contract this package
  guarantees — read it before reading the implementation.

## Commands

```sh
npm install        # first time / after package.json changes
npm run typecheck   # tsc --noEmit, strict checkJs over index.js + src/**
npm test             # node --test
```

## The corpus (fixtures/, expected/, KNOWN-DIVERGENCES.md)

`fixtures/*.json` is a shared, committed corpus of `project.json`-shaped test
projects — no fixture depends on a real file on disk, so it runs the same on
every machine and in CI. `expected/*.json` is the frozen golden output of
running the resolver (`index.js`) over each fixture.
`test/corpus.test.mjs` recomputes every golden fresh on each run and
deep-equals it against the committed file.

The suite is **hermetic**: nothing reachable from `test/**`, at any depth,
imports outside this package. A test at the end of `test/activation.test.mjs`
section 3 walks the whole static import graph and enforces that, so the
package can be copied anywhere and its tests still pass.

To regenerate the resolver goldens after a deliberate resolver change:

```sh
node scripts/regen-goldens.mjs
```

Then **hand-audit the diff** against the legacy code paths cited in
`src/*.js`'s module headers and in `KNOWN-DIVERGENCES.md` before committing —
a regenerated golden is not self-validating; see `fixtures/README.md` for the
full corpus map (which fixture pins which bug/divergence) and the documented
shape of `expected/*.json` (including the source-window golden shape a Python
parity test reads).

### ⚠️ `expected/encode-args.*.json` are frozen pre-SP2 artifacts

Two files under `expected/` are not resolver goldens:
`encode-args.source-crop.json` and `encode-args.source-crop-missing-dims.json`.
They hold the **render pipeline's** output (`collectAllItems` + `planSegments`
+ `encodeSegment(..., {_dryRun:true})`) captured **before** render was swapped
onto this package, and they are the only artifact proving that swap did not
change what ffmpeg is asked to encode.

`scripts/regen-goldens.mjs` cannot write them. They are checked by
`montaj_assets/render/test/encode-args-golden.test.mjs`, which also owns the
staged-opt-in regeneration path: `--regen` plus the env var gets you a
comparison, never a write. A golden whose bytes still match is left untouched;
a golden whose bytes CHANGED is refused with a diff and needs a further
`--i-am-deliberately-changing-render-output`. **Overwriting them destroys the
render-output-unchanged gate permanently** — the generator is now the resolver,
so a regenerated golden only ever says "the resolver agrees with itself". If
that test fails, fix the render code. See `fixtures/README.md` for the full
warning.

`KNOWN-DIVERGENCES.md` is the registry of places where the editor preview and
the render engine already, independently, disagree with each other in
production today. This package documents those; it does not fix them.
