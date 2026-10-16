// render/test/glass-plate-layering.integration.test.mjs (§308 P3)
//
// An image on a track above a glass overlay draws over the glass in the
// export, so it must not be blurred into the glass's plate (a frosted halo of
// itself). The plate is the footage under the item: renderBaseParts, unblurred,
// for a full-canvas blue image above the glass over green footage, is green.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG } from '../ffmpeg-bin.js'
import { renderBaseParts } from '../glass-plate.js'
import { pixel, near } from './fixtures/pixels.mjs'

test('glass plate: the clips above the glass item are not in its plate', { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-glass-layer-'))
  try {
    const green = join(dir, 'green.mp4')
    const blue = join(dir, 'blue.png')
    for (const args of [
      ['-f', 'lavfi', '-i', 'color=c=0x00ff00:size=180x320:rate=10:duration=2', '-pix_fmt', 'yuv420p', green],
      ['-f', 'lavfi', '-i', 'color=c=0x0000ff:size=180x320:rate=1', '-frames:v', '1', '-update', '1', blue],
    ]) {
      const r = spawnSync(FFMPEG, ['-y', '-v', 'error', ...args], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
    }
    writeFileSync(join(dir, 'g.jsx'), 'export default function Glass() { return null }\n')
    const projectPath = join(dir, 'project.json')
    writeFileSync(projectPath, JSON.stringify({
      version: '0.2', status: 'final', settings: { resolution: [180, 320], fps: 10, colorSpace: 'sdr_bt709' },
      tracks: [
        [{ id: 'footage', type: 'video', src: green, start: 0, end: 2, inPoint: 0, outPoint: 2 }],
        [{ id: 'glass', type: 'overlay', src: join(dir, 'g.jsx'), start: 0, end: 2 }],
        [{ id: 'above', type: 'image', src: blue, start: 0, end: 2 }],
      ],
      audio: {},
    }))
    const { parts } = await renderBaseParts({ projectPath, itemId: 'glass', shortEdge: 90, workDir: join(dir, 'parts') })
    assert.ok(parts.length >= 1)
    near(pixel(parts[0].path, 0), [0, 255, 0], 'the plate is the footage under the glass, not the image above it')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
