// render/test/render-carousel.test.mjs
//
// Integration tests for render-carousel.js --scale flag.
// Shells out to Node to invoke render-carousel.js against a tiny fixture project.
// PNG dimensions are read from the IHDR chunk (bytes 16–23).
//
// NOTE: These tests launch a real Puppeteer browser, so they are slow (~10–20 s
// each). Run them individually or allow enough timeout.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Path to render-carousel.js (one directory up from test/)
const SCRIPT = resolve(__dirname, '..', 'render-carousel.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal 1080×1080 carousel project.json with n solid-colour slides.
 */
function buildFixtureProject(n = 1) {
  return {
    projectType: 'carousel',
    settings:    { resolution: [1080, 1080] },
    carousel:    { aspect: 'square' },
    slides: Array.from({ length: n }, (_, i) => ({
      id:         `slide-${i + 1}`,
      base_color: '#3a86ff',
      elements:   [],
    })),
  }
}

/**
 * Build a minimal portrait 1080×1350 carousel project.json with n solid slides.
 */
function buildPortraitFixtureProject(n = 1) {
  return {
    projectType: 'carousel',
    settings:    { resolution: [1080, 1350] },
    carousel:    { aspect: 'portrait' },
    slides: Array.from({ length: n }, (_, i) => ({
      id:         `slide-${i + 1}`,
      base_color: '#3a86ff',
      elements:   [],
    })),
  }
}

/**
 * Write a fixture project.json to a temp dir and return the dir path.
 */
function writeTempProject(project) {
  const dir = mkdtempSync(join(tmpdir(), 'montaj-carousel-test-'))
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2))
  return dir
}

/**
 * Read PNG dimensions from the IHDR chunk.
 * PNG layout: 8-byte sig, then IHDR chunk (4 len + 4 type + 4 width + 4 height + ...).
 * Width is at byte offset 16–19, height at 20–23 (big-endian uint32).
 */
function readPngDimensions(pngPath) {
  const buf = readFileSync(pngPath)
  const width  = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return { width, height }
}

/**
 * Run render-carousel.js synchronously. Returns { status, stdout, stderr }.
 */
function runRenderer(args, { cwd } = {}) {
  const result = spawnSync(
    'node',
    [SCRIPT, ...args],
    { encoding: 'utf8', timeout: 120_000, cwd },
  )
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

// ---------------------------------------------------------------------------
// Validation / rejection tests (fast — no Puppeteer)
// ---------------------------------------------------------------------------

test('--scale 0 exits non-zero with JSON error on stderr', () => {
  const dir = writeTempProject(buildFixtureProject())
  try {
    const { status, stderr } = runRenderer([
      '--project-json', join(dir, 'project.json'),
      '--scale', '0',
    ])
    assert.notEqual(status, 0, 'should exit non-zero')
    const err = JSON.parse(stderr.trim())
    assert.equal(err.error, 'invalid_argument')
    assert.ok(typeof err.message === 'string' && err.message.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--scale 4 exits non-zero with JSON error on stderr', () => {
  const dir = writeTempProject(buildFixtureProject())
  try {
    const { status, stderr } = runRenderer([
      '--project-json', join(dir, 'project.json'),
      '--scale', '4',
    ])
    assert.notEqual(status, 0, 'should exit non-zero')
    const err = JSON.parse(stderr.trim())
    assert.equal(err.error, 'invalid_argument')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--scale 1.5 exits non-zero with JSON error on stderr', () => {
  const dir = writeTempProject(buildFixtureProject())
  try {
    const { status, stderr } = runRenderer([
      '--project-json', join(dir, 'project.json'),
      '--scale', '1.5',
    ])
    assert.notEqual(status, 0, 'should exit non-zero')
    const err = JSON.parse(stderr.trim())
    assert.equal(err.error, 'invalid_argument')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--scale abc exits non-zero with JSON error on stderr', () => {
  const dir = writeTempProject(buildFixtureProject())
  try {
    const { status, stderr } = runRenderer([
      '--project-json', join(dir, 'project.json'),
      '--scale', 'abc',
    ])
    assert.notEqual(status, 0, 'should exit non-zero')
    const err = JSON.parse(stderr.trim())
    assert.equal(err.error, 'invalid_argument')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Rendering tests (launch Puppeteer — ~10–20 s each)
// ---------------------------------------------------------------------------

test('explicit --scale 1: PNG is 1080×1080 and manifest is correct', { timeout: 120_000 }, () => {
  const project = buildFixtureProject(1)
  const dir     = writeTempProject(project)
  const outDir  = join(dir, 'render')
  try {
    const { status, stdout, stderr } = runRenderer([
      '--project-json', join(dir, 'project.json'),
      '--out', outDir,
      '--scale', '1',
    ])
    assert.equal(status, 0, `render failed:\n${stderr}`)

    // PNG dimensions
    const pngPath = join(outDir, 'slide_01.png')
    assert.ok(existsSync(pngPath), 'slide_01.png should exist')
    const { width, height } = readPngDimensions(pngPath)
    assert.equal(width,  1080, 'PNG width should be 1080')
    assert.equal(height, 1080, 'PNG height should be 1080')

    // Manifest
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.scale, 1)
    assert.deepEqual(manifest.outputResolution, [1080, 1080])
    assert.equal(manifest.slides.length, 1)
    const s = manifest.slides[0]
    assert.equal(s.designWidth,  1080)
    assert.equal(s.designHeight, 1080)
    assert.equal(s.width,        1080)
    assert.equal(s.height,       1080)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('default (no --scale): portrait 1080×1350 renders at 2× → 2160×2700', { timeout: 120_000 }, () => {
  const project = buildPortraitFixtureProject(1)
  const dir     = writeTempProject(project)
  const outDir  = join(dir, 'render')
  try {
    const { status, stderr } = runRenderer([
      '--project-json', join(dir, 'project.json'),
      '--out', outDir,
    ])
    assert.equal(status, 0, `render failed:\n${stderr}`)

    // PNG dimensions: 2× the 1080×1350 design canvas.
    const pngPath = join(outDir, 'slide_01.png')
    assert.ok(existsSync(pngPath), 'slide_01.png should exist')
    const { width, height } = readPngDimensions(pngPath)
    assert.equal(width,  2160, 'default PNG width should be 2160 (2× of 1080)')
    assert.equal(height, 2700, 'default PNG height should be 2700 (2× of 1350)')

    // Manifest: scale 2, design coords unchanged, output coords doubled.
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.scale, 2, 'default scale should be 2')
    assert.deepEqual(manifest.resolution, [1080, 1350], 'design resolution unchanged')
    assert.deepEqual(manifest.outputResolution, [2160, 2700])
    const s = manifest.slides[0]
    assert.equal(s.designWidth,  1080)
    assert.equal(s.designHeight, 1350)
    assert.equal(s.width,        2160)
    assert.equal(s.height,       2700)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--scale 2: PNGs are 2160×2160 and manifest separates design from output dims', { timeout: 120_000 }, () => {
  const project = buildFixtureProject(1)
  const dir     = writeTempProject(project)
  const outDir  = join(dir, 'render')
  try {
    const { status, stderr } = runRenderer([
      '--project-json', join(dir, 'project.json'),
      '--out', outDir,
      '--scale', '2',
    ])
    assert.equal(status, 0, `render failed:\n${stderr}`)

    // PNG dimensions
    const pngPath = join(outDir, 'slide_01.png')
    assert.ok(existsSync(pngPath), 'slide_01.png should exist')
    const { width, height } = readPngDimensions(pngPath)
    assert.equal(width,  2160, 'PNG width should be 2160 at scale=2')
    assert.equal(height, 2160, 'PNG height should be 2160 at scale=2')

    // Manifest
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.scale, 2)
    assert.deepEqual(manifest.outputResolution, [2160, 2160])
    // resolution stays at design coords
    assert.deepEqual(manifest.resolution, [1080, 1080])
    assert.equal(manifest.slides.length, 1)
    const s = manifest.slides[0]
    assert.equal(s.designWidth,  1080, 'designWidth should be design-coord 1080')
    assert.equal(s.designHeight, 1080, 'designHeight should be design-coord 1080')
    assert.equal(s.width,        2160, 'width should be scaled 2160')
    assert.equal(s.height,       2160, 'height should be scaled 2160')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
