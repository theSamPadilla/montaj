// render/test/shim-bake.test.mjs
//
// The render bake (SP9b T2.2). `generateShim` gained ONE new job: when an
// overlay item carries keyframes, wrap the component in a full-canvas layer
// whose CSS transform is re-derived every frame from timeline-core's
// `geometryAt`. Everything this file asserts falls into two buckets:
//
//   (1) THE UN-BAKED SHIM DID NOT MOVE. A keyframe-free overlay is the
//       overwhelmingly common case and its shim must be byte-identical to the
//       pre-keyframes one — the same identity claim `geometryAt` makes about
//       `geometryFor`, one layer up. Pinned against a fixture captured from the
//       commit before this feature, NOT against a re-run of today's code.
//
//   (2) THE BAKED SHIM ASKS TIMELINE-CORE, and asks it for the right instant.
//       The parity contract is that the preview and the bake sample the SAME
//       function; a lerp appearing in the generated source would satisfy any
//       "does it animate" test while being exactly the bug this feature must
//       not have.
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { fileURLToPath } from 'url'
import { generateShim, bundleComponent, cleanupBundle, generateHtml } from '../bundle.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures', 'shim-unbaked.expected.jsx')

// The exact arguments the fixture was captured with. Changing either means
// regenerating the fixture, which defeats its purpose — don't.
const COMPONENT = '/abs/overlay.jsx'
const PROPS     = { title: 'hi', img: '/abs/pic.png' }
const FPS       = 30
const FRAMES    = 90

const TRACKS = [
  { prop: 'offsetX', points: [{ t: 0, value: 0 }, { t: 2, value: 25 }] },
  { prop: 'opacity', points: [{ t: 0, value: 0, easing: 'ease-out' }, { t: 1, value: 1 }] },
]

describe('shim bake: an un-keyframed overlay', () => {
  test('(a) produces the byte-identical pre-SP9b shim', () => {
    const expected = readFileSync(FIXTURE, 'utf8')
    for (const [label, bake] of [['omitted', undefined], ['null', null]]) {
      const got = generateShim(COMPONENT, PROPS, FPS, FRAMES, bake)
      assert.equal(got, expected,
        `bakeGeometry ${label}: the un-baked shim must not move by a single byte — `
        + 'this is what keeps a keyframe-free project\'s capture (and therefore its '
        + 'render goldens) valid')
    }
  })

  test('(b) an EMPTY keyframes array is un-keyframed, not keyframed', () => {
    // The editor can leave `keyframes: []` behind after the last key is deleted.
    // That item animates nothing and must go back down the byte-identical path,
    // exactly as `geometryAt` hands an empty-track item to `geometryFor`.
    const expected = readFileSync(FIXTURE, 'utf8')
    const got = generateShim(COMPONENT, PROPS, FPS, FRAMES,
      { offsetX: 0, offsetY: 0, scale: 1, rotation: 0, opacity: 1, keyframes: [] })
    // generateShim trusts its caller here; bundleComponent is the layer that
    // decides null-vs-object, so assert THAT instead — see test (h).
    assert.notEqual(got, expected,
      'generateShim itself takes the object at face value; the empty-array rule lives in bundleComponent')
  })

  test('(c) imports nothing from timeline-core', () => {
    const got = generateShim(COMPONENT, PROPS, FPS, FRAMES)
    assert.doesNotMatch(got, /timeline-core/,
      'a static overlay must not pull the resolver into its bundle at all')
    assert.doesNotMatch(got, /geometryAt/)
    assert.doesNotMatch(got, /transformOrigin/)
  })
})

describe('shim bake: a keyframed overlay', () => {
  const baked = generateShim(COMPONENT, PROPS, FPS, FRAMES, {
    offsetX: 5, offsetY: -10, scale: 0.5, rotation: 12, opacity: 0.8, keyframes: TRACKS,
  })

  test('(d) imports geometryAt and evaluates NO easing of its own', () => {
    assert.match(baked, /import \{ geometryAt \} from '@bycrux\/timeline-core'/)
    assert.match(baked, /geometryAt\(__bakeItem, 'overlay',/)
    // The whole point of the package. Any of these appearing in generated render
    // source means the bake started doing its own curve math, which is a parity
    // bug against the preview no visual test would reliably catch.
    for (const forbidden of [/\blerp\b/, /\bcubicBezier\b/, /\beaseProgress\b/, /\bsampleTrack\b/, /Math\.pow/]) {
      assert.doesNotMatch(baked, forbidden,
        `curve evaluation lives ONLY in @bycrux/timeline-core/src/curves.js (${forbidden})`)
    }
  })

  test('(e) samples at localT = frame / fps — item-relative seconds', () => {
    // frame 0 of this shim IS the overlay item's own quantized `start`
    // (collectPuppeteerSegments emits one segment per item; renderChunk passes
    // the SEGMENT-relative frame index, continuing the count across chunks), so
    // dividing by fps is already item-relative — no offset term belongs here.
    assert.match(baked, /geometryAt\(__bakeItem, 'overlay', f \/ 30\)/)
    const at60 = generateShim(COMPONENT, PROPS, 60, FRAMES, {
      offsetX: 0, offsetY: 0, scale: 1, rotation: 0, opacity: 1, keyframes: TRACKS,
    })
    assert.match(at60, /geometryAt\(__bakeItem, 'overlay', f \/ 60\)/,
      'the divisor is the project fps, not a hardcoded 30')
    // Re-derived per frame, not once at mount — otherwise every frame would
    // carry frame 0's geometry and the export would be a still.
    assert.match(baked, /__bakeStyle\(frame\)/)
  })

  test('(f) emits the preview\'s transform string, order and origin verbatim', () => {
    // Copied from OverlayItemsLayer.tsx's own wrapper style. Transform functions
    // do NOT commute: translate → rotate → scale about the centre is a different
    // matrix from any other ordering, so the order is part of the contract, not
    // a formatting choice.
    assert.match(baked,
      /transform: `translate\(\$\{g\.offsetX\}%, \$\{g\.offsetY\}%\) rotate\(\$\{g\.rotation\}deg\) scale\(\$\{g\.scale\}\)`/)
    assert.match(baked, /transformOrigin: 'center center'/)
    // Beside the transform, never inside it — the preview applies it the same way.
    assert.match(baked, /opacity: g\.opacity/)
  })

  test('(g) the transform layer is the FULL design canvas', () => {
    // Load-bearing: CSS `translate(%)` resolves against the element's OWN border
    // box. Anything smaller than the frame would reinterpret offsetX/offsetY as
    // a percentage of the component's box and silently shrink every animated
    // move — while still looking like it animates.
    assert.match(baked, /position: 'absolute',\n\s*inset: 0,\n\s*transform:/)
    assert.match(baked, /<div style=\{__bakeStyle\(frame\)\}><Component/,
      'the wrapper must sit between the root layer and the component')
    assert.match(baked, /\/><\/div>\n\s*<\/div>/, 'and must be closed inside the root layer')
  })

  test('(h) carries the static scalars, so a partly-animated item keeps the rest', () => {
    // geometryAt falls back to the item's own scalar for any prop with no track.
    // Dropping these would snap every un-animated property to its DEFAULT — an
    // item that animates only opacity would jump to scale 1 / rotation 0.
    const item = JSON.parse(baked.match(/const __bakeItem = (\{.*?\})\nfunction __bakeStyle/s)[1])
    assert.deepEqual(item, {
      offsetX: 5, offsetY: -10, scale: 0.5, rotation: 12, opacity: 0.8, keyframes: TRACKS,
    })
  })
})

describe('shim bake: bundleComponent decides baked-vs-not', () => {
  // esbuild has to actually resolve the component, so this one needs a file on
  // disk. It is trivial on purpose — what is under test is the shim around it.
  const tmpComponent = join(tmpdir(), `montaj-shim-bake-${randomBytes(6).toString('hex')}.jsx`)
  writeFileSync(tmpComponent, 'export default function Ov() { return <div>ov</div> }\n')
  after(() => rmSync(tmpComponent, { force: true }))

  const base = { componentPath: tmpComponent, props: PROPS, fps: FPS, durationFrames: FRAMES, width: 1080, height: 1920 }

  // bundleComponent writes shim.jsx and then esbuilds it. Reading the shim back
  // off disk proves the wiring end to end, and the successful build proves
  // '@bycrux/timeline-core' actually RESOLVES from a temp dir via esbuild's
  // nodePaths — a browser-target bundle of a package that turned out to need a
  // Node builtin would fail here rather than in production.
  async function shimFor(opts) {
    const { workDir } = await bundleComponent({ ...base, ...opts })
    try {
      return {
        shim: readFileSync(join(workDir, 'shim.jsx'), 'utf8'),
        bundle: readFileSync(join(workDir, 'bundle.js'), 'utf8'),
      }
    } finally {
      cleanupBundle(workDir)
      assert.equal(existsSync(workDir), false)
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  test('(i) no keyframes, or an empty array, writes the un-baked shim', async () => {
    // Against `generateShim`'s own un-baked output for these same inputs, which
    // test (a) has already pinned to the pre-SP9b fixture. Two links, one chain:
    // fixture ⇒ generateShim ⇒ bundleComponent.
    const expected = generateShim(tmpComponent, PROPS, FPS, FRAMES)
    assert.equal(expected.replace(tmpComponent, COMPONENT),
      readFileSync(FIXTURE, 'utf8'),
      'the only difference from the frozen fixture may be the component path')

    for (const [label, opts] of [
      ['absent',        {}],
      ['null',          { keyframes: null }],
      ['empty array',   { keyframes: [] }],
      // The five geometry scalars are DEAD without keyframes and must stay dead:
      // a positioned-but-static overlay is placed by ffmpeg, and baking it here
      // as well would double-apply the transform.
      ['scalars only',  { offsetX: 30, offsetY: 30, scale: 2, rotation: 45, opacity: 0.25 }],
    ]) {
      const { shim } = await shimFor(opts)
      assert.equal(shim, expected, `keyframes ${label}: shim must not move`)
    }
  })

  test('(j) tracks present writes the baked shim, and it bundles', async () => {
    const { shim, bundle } = await shimFor({
      offsetX: 5, scale: 0.5, keyframes: TRACKS,
    })
    assert.match(shim, /geometryAt/)
    assert.match(shim, /transformOrigin: 'center center'/)
    // esbuild inlined timeline-core rather than leaving a bare specifier the
    // browser would fail to resolve from a file:// page.
    assert.doesNotMatch(bundle, /from\s*["']@bycrux\/timeline-core["']/)
    assert.match(bundle, /transformOrigin/)
  })

  // `fps` and `durationFrames` are the ONLY values interpolated raw into the
  // generated source — everything else goes through JSON.stringify, which
  // quotes and escapes. They come from project.json (`settings.fps || 30` in
  // render.js), which is agent- and user-authored and never numerically
  // coerced upstream, so without a guard a non-numeric value would land in the
  // shim as executable SOURCE rather than as a number. That raw interpolation
  // predates keyframes (it already fed `window.fps` and the component's `fps`
  // prop); the bake simply added another site, which is what surfaced it.
  describe('raw-interpolated numerics cannot become source', () => {
    for (const [label, hostile] of [
      ['statement injection', '30); window.__pwned = 1; //'],
      ['expression injection', '0 || (window.__pwned = 1)'],
      ['non-numeric string',   'thirty'],
      ['NaN',                  NaN],
      ['Infinity',             Infinity],
      ['zero',                 0],
    ]) {
      test(`(k) fps: ${label} is coerced, never emitted verbatim`, () => {
        const shim = generateShim('/abs/overlay.jsx', {}, hostile, 90, {
          offsetX: 0, offsetY: 0, scale: 1, rotation: 0, opacity: 1, keyframes: TRACKS,
        })
        assert.doesNotMatch(shim, /__pwned/, 'injected source must not survive')
        assert.doesNotMatch(shim, /thirty/,  'non-numeric text must not survive')
        // Every site that consumes fps got a finite, positive number. A zero or
        // non-finite fps would also produce `f / 0` -> Infinity in the bake's
        // localT, so the guard is a correctness fix as much as a safety one.
        assert.match(shim, /window\.fps\s*=\s*30\b/)
        assert.match(shim, /f \/ 30\)/)
      })
    }

    test('(k) a valid numeric STRING still means the number it always meant', () => {
      const shim = generateShim('/abs/overlay.jsx', {}, '24', '48', {
        offsetX: 0, offsetY: 0, scale: 1, rotation: 0, opacity: 1, keyframes: TRACKS,
      })
      assert.match(shim, /window\.fps\s*=\s*24\b/)
      assert.match(shim, /window\.duration\s*=\s*48\b/)
      assert.match(shim, /f \/ 24\)/)
    })
  })
})

// `generateHtml`'s <link href="...css2?family=..."> interpolates googleFonts
// entries with only THREE characters escaped (`escapeFontSpec`, bundle.js)
// — everything else, including the literal `+ : @ ;` Google's CSS2 API
// requires, passes through unescaped BY DESIGN (the function's own comment
// explains why a general URL-encode would break real font specs). This pins
// the boundary: the three characters that can break out of the attribute or
// open a new tag must be escaped; the four Google-required characters must
// not be. Entries are unsanitized project.json (render.js's
// `googleFonts`/`captionFonts`, sample-frame.js's `ov.googleFonts`), and
// this page runs in Puppeteer over `file://` WITH network access, so an
// injected `<script>` can read local files.
/** The `<link rel="stylesheet" href="...css2?...">` line generateHtml emits.
 *  Non-greedy up to the FIRST `>` — exactly what a real HTML parser stops at
 *  once it's past the (properly quoted) attributes, so a still-broken escape
 *  that let a raw `>` through would show up as a truncated match here rather
 *  than silently passing. */
function stylesheetLinkTag(html) {
  const m = html.match(/<link rel="stylesheet"[^]*?>/)
  assert.ok(m, 'expected a stylesheet <link> when googleFonts is non-empty')
  return m[0]
}

describe('generateHtml: googleFonts entries cannot break out of the href attribute', () => {
  test('(l) an attribute-breakout entry introduces no unescaped double-quote inside the href value', () => {
    // Baseline: exactly the two delimiting quotes of `rel="stylesheet"` plus
    // the two of `href="...swap"` — four, whatever the font text is, as long
    // as it carries no quote of its own.
    const baselineQuotes = (stylesheetLinkTag(generateHtml(1080, 1920, false, ['Baseline'])).match(/"/g) ?? []).length

    const tag = stylesheetLinkTag(generateHtml(1080, 1920, false, ['Anton" onload="window.__pwned=1']))
    const quoteCount = (tag.match(/"/g) ?? []).length
    // An unescaped fix regression would add the entry's own two raw quotes on
    // top of the baseline count — asserting EQUAL, not just "some", pins that
    // no unescaped `"` of any kind survived into the tag.
    assert.equal(quoteCount, baselineQuotes, `expected only the delimiting quotes, got: ${tag}`)
  })

  test('(l) a tag-injection entry cannot open a <script> element', () => {
    const html = generateHtml(1080, 1920, false, ['Anton"><script>alert(1)</script>'])
    assert.doesNotMatch(html, /<script>alert/i)
  })

  test('(l) a literal & is escaped so it cannot start a second, attacker-controlled query param', () => {
    const html = generateHtml(1080, 1920, false, ['A&evil=1'])
    assert.doesNotMatch(html, /family=A&evil=1/)
    assert.match(html, /family=A&amp;evil=1/)
  })

  test('(l) a normal font spec with the literal + : @ ; Google requires passes through completely unchanged', () => {
    const html = generateHtml(1080, 1920, false, ['Baloo+2:wght@700', 'Roboto:wght@400;700'])
    assert.match(html, /family=Baloo\+2:wght@700/)
    assert.match(html, /family=Roboto:wght@400;700/)
  })
})
