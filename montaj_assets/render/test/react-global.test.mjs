// The render shim injects React as a global, the way the editor preview hands
// React to every overlay. Before this, an overlay calling React.useMemo(...)
// with no import drew in the editor and failed at sample and export with
// "React is not defined" (PV49 T8, measured). sampleOverlay runs the same shim
// (bundle.js generateShim) that export does.
// Point TMPDIR at a scratch dir: the sample cache lives under tmpdir().
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { FFMPEG } from '../ffmpeg-bin.js'

import { sampleOverlay } from '../sample-frame.js'

const base = { frame: 0, fps: 30, width: 200, height: 200 }

/** RGB of the centre pixel of a PNG, via the managed ffmpeg. */
function centrePixel(png) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', png, '-vf', 'crop=1:1:100:100',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' })
  assert.equal(r.status, 0, `ffmpeg failed: ${r.stderr}`)
  return [...r.stdout.subarray(0, 3)]
}

async function sample(src) {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-react-global-'))
  try {
    const comp = join(dir, 'overlay.jsx'), out = join(dir, 'out.png')
    writeFileSync(comp, src)
    await sampleOverlay({ componentPath: comp, props: {}, ...base, outPath: out })
    return centrePixel(out)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('an overlay using React with no import samples as it previews', { timeout: 120_000 }, async () => {
  const px = await sample(`export default function O() {
  const c = React.useMemo(() => '#00ff00', [])
  return <div style={{ position: 'absolute', inset: 0, background: c }} />
}
`)
  assert.deepEqual(px, [0, 255, 0])
})

test('an overlay importing React gets the same instance as the global', { timeout: 120_000 }, async () => {
  const px = await sample(`import React from 'react'
export default function O() {
  const same = React === window.React
  return <div style={{ position: 'absolute', inset: 0, background: same ? '#00ff00' : '#ff0000' }} />
}
`)
  assert.deepEqual(px, [0, 255, 0], 'window.React is the React the bundle resolves (one instance)')
})

// Both render shims inject React. This is deliberately NOT done in
// makeOverlayGlobals: the editor preview's wrapper already declares React as its
// first parameter and spreads the globals' keys after it, so a React key there
// would be a duplicate parameter name, a SyntaxError in strict mode, and every
// preview would break. So each render shim sets it, and this pins both.
test('both render shims (overlay and carousel) set window.React', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const here = fileURLToPath(new URL('..', import.meta.url))
  for (const f of ['bundle.js', 'render-carousel.js']) {
    const src = readFileSync(join(here, f), 'utf8')
    assert.match(src, /import React, \{ useState \} from 'react'/, `${f} imports React in its shim`)
    assert.match(src, /window\.React\s*=\s*React/, `${f} sets window.React in its shim`)
  }
})
