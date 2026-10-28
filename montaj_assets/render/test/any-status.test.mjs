// A project renders at any status. `status` is a label (pending, draft, final),
// never a gate: render.js used to refuse anything but `final` with
// `invalid_status`, and an export from the app of a draft project failed.
//
// An empty timeline renders in a moment (no segments), so this runs the real
// render.js on one per status and requires it to finish with its output path.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RENDER_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'render.js')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'montaj-any-status-')))
after(() => rmSync(root, { recursive: true, force: true }))

for (const status of ['pending', 'draft', 'final', undefined]) {
  test(`a ${status ?? 'status-less'} project renders`, () => {
    const dir = join(root, status ?? 'none')
    mkdirSync(dir)
    const project = { version: '0.2', id: `s-${status ?? 'none'}`, settings: { resolution: [64, 64], fps: 30 }, tracks: [] }
    if (status) project.status = status
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project))
    const out = join(dir, 'out.mp4')
    const r = spawnSync(process.execPath, [RENDER_JS, join(dir, 'project.json'), '--out', out], { encoding: 'utf8', timeout: 60_000 })
    assert.doesNotMatch(r.stdout + r.stderr, /invalid_status/)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /out\.mp4/)
  })
}
