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
 * `env` is merged over this process's environment.
 */
function runRenderer(args, { cwd, env } = {}) {
  const result = spawnSync(
    'node',
    [SCRIPT, ...args],
    { encoding: 'utf8', timeout: 120_000, cwd, env: env && { ...process.env, ...env } },
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

// ---------------------------------------------------------------------------
// Font remount (PV50 T3)
// ---------------------------------------------------------------------------
//
// A slide mounts before its webfont loads, so an overlay that measures its text
// once at mount measured fallback metrics and kept them: the fonts wait re-runs
// nothing. With the remount, that slide must come out pixel-identical to a
// slide placing the same words at hardcoded, already-correct positions
// (WordsFixed, whose numbers were measured with the fixture font). The fonts are
// the offline fixture set, so the render reaches no network.

const FONT_FIXTURES    = resolve(__dirname, 'fixtures', 'fonts')
const REMOUNT_FIXTURES = resolve(__dirname, 'fixtures', 'font-remount')

test('a slide that measures its text at mount matches the same text at hardcoded positions', { timeout: 120_000 }, () => {
  const slide = (id, template) => ({
    id,
    base_color: '#000000',
    elements: [{
      id:          `${id}-overlay`,
      type:        'overlay',
      x: 0, y: 0, w: 1080, h: 1080,
      googleFonts: ['Bebas+Neue'],
      overlay:     { template: join(REMOUNT_FIXTURES, template), props: {} },
    }],
  })
  const dir = writeTempProject({
    projectType: 'carousel',
    settings:    { resolution: [1080, 1080] },
    carousel:    { aspect: 'square' },
    slides:      [slide('measured', 'WordsMount.jsx'), slide('fixed', 'WordsFixed.jsx')],
  })
  const outDir = join(dir, 'render')
  try {
    const { status, stderr } = runRenderer(
      ['--project-json', join(dir, 'project.json'), '--out', outDir, '--scale', '1'],
      { env: { MONTAJ_FONTS_DIR: FONT_FIXTURES } },
    )
    assert.equal(status, 0, `render failed:\n${stderr}`)
    // Bebas Neue came from the fixture set, not from Google and not missing.
    assert.match(stderr, /fonts: vendored set/)
    assert.doesNotMatch(stderr, /fonts\.googleapis\.com/)

    const measured = readFileSync(join(outDir, 'slide_01.png'))
    const fixed    = readFileSync(join(outDir, 'slide_02.png'))
    assert.ok(measured.equals(fixed),
      'the slide that measures at mount must be pixel-identical to the hardcoded one; '
      + 'a difference means it kept the positions it measured before Bebas Neue loaded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// --pdf: one PDF page per slide PNG
// ---------------------------------------------------------------------------

/** Concatenated IDAT bytes of a PNG file. */
function idatBytes(png) {
  const parts = []
  let p = 8
  while (p < png.length) {
    const len = png.readUInt32BE(p)
    if (png.toString('latin1', p + 4, p + 8) === 'IDAT') parts.push(png.subarray(p + 8, p + 8 + len))
    p += 12 + len
  }
  return Buffer.concat(parts)
}

test('--pdf writes carousel.pdf: one page per slide, the slide PNGs as images, design-size pages', () => {
  const dir = writeTempProject(buildPortraitFixtureProject(2))
  try {
    const { status } = runRenderer(['--project-json', join(dir, 'project.json'), '--pdf'])
    assert.equal(status, 0)
    const out = join(dir, 'render')
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    assert.equal(manifest.pdf, 'carousel.pdf')
    const pdf = readFileSync(join(out, 'carousel.pdf'))
    const text = pdf.toString('latin1')
    assert.equal(text.match(/\/Type \/Page\b(?!s)/g).length, 2)
    assert.equal(text.match(/\/MediaBox \[0 0 1080 1350\]/g).length, 2)
    for (const f of ['slide_01.png', 'slide_02.png']) {
      assert.ok(pdf.includes(idatBytes(readFileSync(join(out, f)))), `${f} IDAT is in the PDF`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a render without --pdf removes a stale carousel.pdf and records pdf: null', () => {
  const dir = writeTempProject(buildFixtureProject(1))
  try {
    mkdirSync(join(dir, 'render'), { recursive: true })
    writeFileSync(join(dir, 'render', 'carousel.pdf'), 'stale')
    const { status } = runRenderer(['--project-json', join(dir, 'project.json'), '--scale', '1'])
    assert.equal(status, 0)
    assert.equal(existsSync(join(dir, 'render', 'carousel.pdf')), false)
    assert.equal(JSON.parse(readFileSync(join(dir, 'render', 'manifest.json'), 'utf8')).pdf, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed slide with --pdf writes no carousel.pdf, manifest pdf is null, exit 1', () => {
  const project = buildFixtureProject(2)
  // An overlay template that does not exist fails that slide only.
  project.slides[1].elements = [{ type: 'overlay', id: 'o', overlay: { template: '/nonexistent/overlay.jsx' } }]
  const dir = writeTempProject(project)
  try {
    const { status } = runRenderer(['--project-json', join(dir, 'project.json'), '--scale', '1', '--pdf'])
    assert.equal(status, 1)
    assert.equal(existsSync(join(dir, 'render', 'carousel.pdf')), false)
    const manifest = JSON.parse(readFileSync(join(dir, 'render', 'manifest.json'), 'utf8'))
    assert.equal(manifest.pdf, null)
    assert.equal(manifest.failures.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a PDF write error is a warning: exit 0, PNGs kept, manifest pdf null', () => {
  const dir = writeTempProject(buildFixtureProject(1))
  try {
    // A non-empty directory where the temp file goes: the stale cleanup's rmSync
    // (not recursive) cannot remove it, and the PDF write into it fails.
    mkdirSync(join(dir, 'render', '.carousel.pdf.tmp', 'x'), { recursive: true })
    const { status, stderr } = runRenderer(['--project-json', join(dir, 'project.json'), '--scale', '1', '--pdf'])
    assert.equal(status, 0)
    assert.ok(existsSync(join(dir, 'render', 'slide_01.png')))
    const manifest = JSON.parse(readFileSync(join(dir, 'render', 'manifest.json'), 'utf8'))
    assert.equal(manifest.pdf, null)
    assert.match(stderr, /pdf failed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
