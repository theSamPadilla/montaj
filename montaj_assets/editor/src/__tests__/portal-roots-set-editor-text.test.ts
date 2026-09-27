import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
// See ./node-shims.d.ts for why the `node:*` imports typecheck here.

// Anything this package portals to `document.body` lands OUTSIDE the editor
// root, so it no longer inherits the editor's `text-[var(--editor-text)]`.
// It inherits the HOST page's text colour instead: in the Montaj desktop app
// that is `text-gray-900` (#111827), which is exactly the dark theme's
// `--editor-surface`. Any child without its own text class (or whose class the
// host's Tailwind failed to emit) then renders dark on dark, which is how the
// Export dialog's Cancel label and tier dims went invisible.
//
// Guard: in every file that calls `createPortal`, every `fixed` overlay root
// must set its own text colour, so portalled content inherits the editor's
// text, never the host's.

const SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TEXT_COLOUR = /(^|\s)text-(\[var\(--editor-text\)\]|white)(\s|$)/

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectSourceFiles(full, out)
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) out.push(full)
  }
  return out
}

describe('portal roots set the editor text colour', () => {
  it('every `fixed` root in a portalling component carries a text colour', () => {
    const offenders: string[] = []
    let checked = 0
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const src = readFileSync(file, 'utf8')
      if (!src.includes('createPortal(')) continue
      // Static className strings and the static head of template literals.
      const re = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        const cls = (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, ' ')
        if (!/(^|\s)fixed(\s|$)/.test(cls)) continue
        checked += 1
        if (!TEXT_COLOUR.test(cls)) {
          const line = src.slice(0, m.index).split('\n').length
          offenders.push(`${relative(SRC_ROOT, file)}:${line}: ${cls.trim()}`)
        }
      }
    }
    expect(checked).toBeGreaterThan(5)
    expect(offenders).toEqual([])
  })
})
