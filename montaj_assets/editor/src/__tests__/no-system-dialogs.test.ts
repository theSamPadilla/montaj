import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
// See ./node-shims.d.ts for why the `node:*` imports typecheck here.

// §337: the editor never opens a system alert, confirm or prompt. They block
// the whole window, look like neither the editor nor its host, and in a
// headless browser they freeze the page outright. A failure the user should
// see goes to the host (`onError`), which shows it its own way. Tests may stub
// the globals, so only non-test source is scanned.

const SRC_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SYSTEM_DIALOG = /(^|[^\w.])(window\.|globalThis\.)?(alert|confirm|prompt)\s*\(/

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectSourceFiles(full, out)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

describe('no system dialogs in the editor', () => {
  it('no source file calls alert, confirm or prompt', () => {
    const hits: string[] = []
    for (const file of collectSourceFiles(SRC_ROOT)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '')
        if (SYSTEM_DIALOG.test(code)) hits.push(`${relative(SRC_ROOT, file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })
})
