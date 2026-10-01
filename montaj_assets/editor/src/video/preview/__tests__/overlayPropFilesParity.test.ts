import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveOverlayPropPaths } from '../OverlayItemsLayer'

// Preview/render parity for overlay props that name files. The render is held
// to the SAME table (render/test/prop-file-paths.test.mjs): whatever file the
// preview loads for a prop, at any depth, the render must load too. Change a
// row here only with the render's walker (render/bundle.js) in the same commit.
type Row = { value: string; file: string | null }
const TABLE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../render/test/fixtures/overlay-prop-files.json'), 'utf8'),
) as { values: Row[]; props: Record<string, unknown>; files: Record<string, unknown> }

// The host's fileUrl, as the Montaj app and serve's own UI spell it.
const fileUrl = (p: string) => `/api/files?path=${encodeURIComponent(p)}`

// What the host answers: a files route serves the absolute path in its `path`
// query (serve's GET /api/files, the Hub's /api/hub/montaj/files). Nothing
// else the preview hands the browser is a local file.
function fileLoaded(v: unknown): unknown {
  if (typeof v === 'string') {
    if (!/^\/api\/(?:.+\/)?files\?/.test(v)) return null
    const p = new URLSearchParams(v.slice(v.indexOf('?') + 1)).get('path')
    return p && p.startsWith('/') ? p : null
  }
  if (Array.isArray(v)) return v.map(fileLoaded)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fileLoaded(x)]))
  return v
}

describe('overlay props: the files the preview loads (shared with the render)', () => {
  for (const { value, file } of TABLE.values) {
    it(`loads ${file === null ? 'no file' : file} for ${JSON.stringify(value)}`, () => {
      expect(fileLoaded(resolveOverlayPropPaths(value, fileUrl))).toBe(file)
    })
  }

  it('the same, nested: lists, lists of lists and objects inside both', () => {
    expect(fileLoaded(resolveOverlayPropPaths(TABLE.props, fileUrl))).toEqual(TABLE.files)
  })
})
