import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
// See ./node-shims.d.ts: this package has no @types/node, so the `node:*`
// specifiers above have no type declarations under this package's tsconfig.
// Vitest itself runs on Node and provides the real modules at runtime.

// Tailwind cannot generate a rule for a `/NN` opacity modifier on an
// arbitrary CSS-variable color — `text-[var(--editor-text)]/60` and friends
// — because it can't parse an opaque `var(...)` reference to inject an alpha
// channel. It silently emits NO rule (measured under a host app's Tailwind
// v3.4), so the class falls back to an inherited/default color, which is how
// toolbar and timeline icons went invisible against the editor's dark
// surface. The fix is `color-mix(in_srgb,var(--editor-X)_NN%,transparent)`
// baked directly into the arbitrary value, so Tailwind never has to parse
// the color itself (see CHANGELOG.md "Unreleased", and LeftPanelTabs.tsx for
// the original instance of this fix).
//
// This guard fails the build if that dead pattern comes back anywhere in
// this package's source, from a revert, a bad merge, or a new component
// copy-pasting an old snippet.

const SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// The one deliberate exception: this file quotes the OLD broken class with a
// real digit (`text-[var(--editor-text)]/40`) inside a comment, as a
// historical example for a narrower regression test that predates this
// repo-wide fix. It is not live code and this guard would otherwise treat
// that quote as a violation.
const ALLOWLIST = new Set(['video/CaptionListPanel.test.tsx'])

// Requires a digit or `[` right after the slash, matching how the modifier
// actually looks in real Tailwind classes (`/60`, `/[0.06]`) — this keeps
// prose like "`text-[var(--editor-text)]/N`" (an `N` placeholder, not a real
// modifier) out of the check without needing it on the allowlist below.
const DEAD_OPACITY_MODIFIER = /var\(--editor-[a-z-]+\)\]\/[\d[]/

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      collectSourceFiles(full, out)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

describe('no dead Tailwind opacity modifier on --editor-* vars', () => {
  it('finds zero `[var(--editor-*)]/NN`-style classes anywhere in src', () => {
    const thisFile = fileURLToPath(import.meta.url)
    const offenders: { file: string; line: number; text: string }[] = []

    for (const file of collectSourceFiles(SRC_ROOT)) {
      if (file === thisFile) continue
      const rel = relative(SRC_ROOT, file)
      if (ALLOWLIST.has(rel)) continue

      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (DEAD_OPACITY_MODIFIER.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() })
        }
      })
    }

    if (offenders.length > 0) {
      const report = offenders
        .map((o) => `  ${o.file}:${o.line}: ${o.text}`)
        .join('\n')
      throw new Error(
        `Found ${offenders.length} dead Tailwind opacity-modifier class(es) on an --editor-* var ` +
          `(Tailwind emits no rule for these — see this test's header comment).\n` +
          `Replace each with color-mix(in_srgb,var(--editor-X)_NN%,transparent):\n${report}`,
      )
    }

    expect(offenders).toEqual([])
  })
})
