// render/test/layering-parity.integration.test.mjs (§308 P3, task 17)
//
// Layering parity, the render half. The shared project
// (timeline-core/test/layering-parity.project.json) is exported and sampled
// here, and stacked by the editor's real preview layer in
// editor/src/video/preview/__tests__/layering-parity.test.tsx. Both halves
// check the fixture's `expectTop`, so what is on top at each layer boundary is
// the same in the preview, in sample_frame and in the export.
//
// The project's JSON order is not the editor's: an image-only track (plate) is
// listed below the footage, and a picture-in-picture video track (pip) above
// two image tracks. Until 5.33.3 the export stacked the clips by JSON track and
// every overlay over every clip: the footage drew over the plate, the stage
// over the backing image, the pip over the backing. The editor stacks every
// video track first, by track after that, and so does the export now.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trackLayerPositions } from '@bycrux/timeline-core'
import { FFMPEG } from '../ffmpeg-bin.js'
import { sampleFrame } from '../sample-frame.js'
import { pixel, near } from './fixtures/pixels.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDER_JS = join(__dirname, '..', 'render.js')
const FIXTURE = JSON.parse(readFileSync(join(__dirname, '..', '..', 'timeline-core', 'test', 'layering-parity.project.json'), 'utf8'))
const { fps: FPS, resolution: [W, H] } = FIXTURE.settings
const rgb = hex => [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16))

/** The fixture written out with its media: solid colours, every src made absolute. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-layering-parity-'))
  writeFileSync(join(dir, 'fill.jsx'), `export default function Fill({ color }) {
  return <div style={{ position: 'absolute', inset: 0, background: color }} />
}
`)
  const tracks = FIXTURE.tracks.map(items => items.map((item) => {
    const src = join(dir, item.src)
    const color = (FIXTURE.colors[item.id] ?? '#000000').slice(1)
    const args = item.type === 'video'
      ? ['-f', 'lavfi', '-i', `color=c=0x${color}:size=${W}x${H}:rate=${FPS}:duration=${item.end - item.start}`, '-pix_fmt', 'yuv420p', src]
      : item.type === 'image'
        ? ['-f', 'lavfi', '-i', `color=c=0x${color}:size=${W}x${H}:rate=1`, '-frames:v', '1', '-update', '1', src]
        : null
    if (args) {
      const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
    }
    return { ...item, src }
  }))
  const projectPath = join(dir, 'project.json')
  writeFileSync(projectPath, JSON.stringify({ version: '0.2', id: 'layering-parity', status: 'final', projectType: 'editing', settings: FIXTURE.settings, tracks, audio: {} }))
  return { dir, projectPath }
}

test('the fixture\'s layer positions are timeline-core\'s, which the editor test pins to the editor\'s', () => {
  assert.deepEqual(trackLayerPositions(FIXTURE.tracks), FIXTURE.layerPositions)
})

test('export and sample_frame put the same layer on top as the editor preview, at every layer boundary', { timeout: 300_000 }, async () => {
  const { dir, projectPath } = world()
  try {
    const out = join(dir, 'out.mp4')
    const r = spawnSync('node', [RENDER_JS, projectPath, '--out', out], { encoding: 'utf8', timeout: 280_000 })
    assert.equal(r.status, 0, `render failed: ${r.stderr?.slice(-600)}`)
    for (const [t, id] of FIXTURE.expectTop) {
      near(pixel(out, Math.round(t * FPS)), rgb(FIXTURE.colors[id]), `export at ${t}s: ${id} on top`)
      const png = join(dir, `at-${t}.png`)
      await sampleFrame({ projectJson: projectPath, atSeconds: t, outPath: png })
      near(pixel(png, 0), rgb(FIXTURE.colors[id]), `sample_frame at ${t}s: ${id} on top`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
