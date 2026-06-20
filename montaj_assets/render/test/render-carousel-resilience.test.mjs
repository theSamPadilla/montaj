// render/test/render-carousel-resilience.test.mjs
//
// A single failing slide must NOT abort the whole carousel render. The good
// slides still render, the run exits non-zero, and manifest.failures records the
// bad slide(s). Regression for the "8 of 9 slides, no error surfaced" truncation.
//
// The bad slide references an overlay template that does not exist, so esbuild
// fails to bundle it — a deterministic per-slide failure that does not depend on
// the platform's image codecs.
//
// Launches a real Puppeteer browser for the good slides (~10–20 s).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'render-carousel.js')

function goodSlide(i) {
  return { id: `good-${i}`, base_color: '#3a86ff', elements: [] }
}

function badSlide(i) {
  // Overlay template path that does not exist → esbuild bundle throws.
  return {
    id: `bad-${i}`,
    base_color: '#ff006e',
    elements: [
      {
        id: `bad-${i}-ov`,
        type: 'overlay',
        overlay: { template: '/montaj/does-not-exist/missing-overlay.jsx', props: {} },
        frame: 0, x: 0, y: 0, w: 1080, h: 1080, rotation: 0,
      },
    ],
  }
}

function writeTempProject(project) {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-carousel-resilience-'))
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2))
  return dir
}

function runRenderer(args) {
  const result = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', timeout: 120_000 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

test('one failing slide does not abort the batch: good slides written, non-zero exit, manifest.failures populated', { timeout: 120_000 }, () => {
  // slide 1 good, slide 2 bad, slide 3 good
  const project = {
    projectType: 'carousel',
    settings: { resolution: [1080, 1080] },
    carousel: { aspect: 'square' },
    slides: [goodSlide(1), badSlide(2), goodSlide(3)],
  }
  const dir = writeTempProject(project)
  const outDir = join(dir, 'render')
  try {
    const { status, stdout, stderr } = runRenderer([
      '--project-json', join(dir, 'project.json'),
      '--out', outDir,
      '--scale', '1',
    ])

    // Partial render signals non-zero — but did NOT abort.
    assert.notEqual(status, 0, `expected non-zero exit on partial render\n${stderr}`)

    // Good slides were still rendered at their original indices.
    assert.ok(existsSync(join(outDir, 'slide_01.png')), 'slide_01.png (good) should exist')
    assert.ok(existsSync(join(outDir, 'slide_03.png')), 'slide_03.png (good) should exist')
    // The bad slide produced no PNG.
    assert.ok(!existsSync(join(outDir, 'slide_02.png')), 'slide_02.png (bad) should NOT exist')

    // stdout still carries the output dir so tooling can find the good slides.
    assert.ok(stdout.trim().length > 0, 'stdout should still carry the output dir')

    // Manifest records the good slides and the failure.
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.slides.length, 2, 'manifest should list the 2 good slides')
    assert.deepEqual(manifest.slides.map(s => s.index).sort(), [1, 3])
    assert.ok(Array.isArray(manifest.failures), 'manifest.failures should be an array')
    assert.equal(manifest.failures.length, 1, 'exactly one slide failed')
    assert.equal(manifest.failures[0].index, 2, 'the failed slide index is 2')
    assert.equal(manifest.failures[0].id, 'bad-2')
    assert.ok(typeof manifest.failures[0].error === 'string' && manifest.failures[0].error.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('all-good carousel: zero exit and empty manifest.failures', { timeout: 120_000 }, () => {
  const project = {
    projectType: 'carousel',
    settings: { resolution: [1080, 1080] },
    carousel: { aspect: 'square' },
    slides: [goodSlide(1), goodSlide(2)],
  }
  const dir = writeTempProject(project)
  const outDir = join(dir, 'render')
  try {
    const { status, stderr } = runRenderer([
      '--project-json', join(dir, 'project.json'),
      '--out', outDir,
      '--scale', '1',
    ])
    assert.equal(status, 0, `expected clean exit\n${stderr}`)
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.failures, [], 'failures should be empty on a clean run')
    assert.equal(manifest.slides.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
