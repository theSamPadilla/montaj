// Run: npm --prefix montaj_assets/editor run test:browser
//
// §587 round 3, in a real browser: select one word in a text box with the
// keyboard, make it bold and red from the element toolbar, and see it change
// while still editing; the edit closed, the canvas draws the word from the
// saved runs through the real static-text template.
//
// The fixture (fixtures/text-runs.tsx) is the real CarouselEditor in the rail
// layout, bundled with esbuild into a temp dir and opened from file://. The
// browser is render's puppeteer and its pinned headless Chrome, launched with a
// throwaway profile and no network, and closed at the end. It never reaches a
// running app or the person's browser.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const EDITOR = join(HERE, '..')
const requireFromRender = createRequire(join(HERE, '..', '..', 'render', 'package.json'))
const { default: puppeteer } = await import(pathToFileURL(requireFromRender.resolve('puppeteer')).href)

// The template lives beside render's own React: one React, the editor's.
const oneReact = {
  name: 'one-react',
  setup(b) {
    b.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) =>
      args.resolveDir.startsWith(EDITOR) ? undefined : b.resolve(args.path, { kind: args.kind, resolveDir: EDITOR }))
  },
}

let browser
let page
let workDir
const errors = []

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'text-runs-'))
  await build({
    entryPoints: [join(HERE, 'fixtures', 'text-runs.tsx')],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    outfile: join(workDir, 'page.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.css': 'empty', '.jsx': 'jsx' },
    plugins: [oneReact],
    logLevel: 'error',
  })
  writeFileSync(
    join(workDir, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; background: #fff; font: 12px sans-serif; }
      /* The package ships no stylesheet: the few utilities the layout needs. */
      .flex { display: flex } .flex-col { flex-direction: column } .items-center { align-items: center }
      .flex-1 { flex: 1 1 0% } .min-w-0 { min-width: 0 } .min-h-0 { min-height: 0 } .h-full { height: 100% } .w-full { width: 100% }
      .flex-shrink-0 { flex-shrink: 0 } .w-\\[72px\\] { width: 72px } .w-\\[320px\\] { width: 320px } .w-\\[360px\\] { width: 360px }
      .relative { position: relative } .absolute { position: absolute } .h-5 { height: 1.25rem } .w-5 { width: 1.25rem } .block { display: block }
      .overflow-auto { overflow: auto } .overflow-hidden { overflow: hidden } .justify-center { justify-content: center }
      /* The toolbar's strip over the canvas column, so the slide's margin box does not cover it. */
      .pt-14 { padding-top: 3.5rem } .inset-x-0 { left: 0; right: 0 } .top-2 { top: 0.5rem } .z-30 { z-index: 30 }
      .pointer-events-none { pointer-events: none } .pointer-events-auto { pointer-events: auto }
    </style></head><body><div id="root"></div><script src="page.js"></script></body></html>`,
  )
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--use-mock-keychain', '--password-store=basic', '--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND'],
  })
  page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => errors.push(e))
  await page.goto(pathToFileURL(join(workDir, 'index.html')).href)
  await page.waitForFunction(() => window.__ready === true)
  await page.waitForSelector('[data-element-wrapper][data-element-id="t"] [data-montaj-text]')
})

after(async () => {
  await browser?.close()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

const EDITOR_SEL = '[role="textbox"][aria-label="Edit text"]'
const BTN = (name) => `[role="toolbar"][aria-label="Element"] button[aria-label="${name}"]`
/** The computed colour and weight of the span drawing `word` under `root`. */
const spanStyle = (root, word) => page.$$eval(`${root} span`, (spans, w) => {
  const s = spans.find((el) => el.textContent === w)
  if (!s) return null
  const cs = getComputedStyle(s)
  return { color: cs.color, weight: cs.fontWeight }
}, word)
const saves = () => page.evaluate(() => window.__saves)

test('one word selected with the keyboard turns bold and red while editing, and stays so once saved', async () => {
  const box = await page.$eval('[data-element-wrapper][data-element-id="t"]', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  // Select, then double-click to edit, as a person does.
  await page.mouse.click(box.x, box.y)
  await page.mouse.click(box.x, box.y, { clickCount: 2 })
  await page.waitForSelector(EDITOR_SEL)
  assert.ok(await page.$eval(EDITOR_SEL, (el) => document.activeElement === el), 'the editor does not have the focus')

  // The whole text is selected on open: End, then Shift+Left three times takes "red".
  await page.keyboard.press('End')
  for (let i = 0; i < 3; i++) {
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Shift')
  }
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'red')
  await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-pressed') === 'false', {}, BTN('Bold'))

  // Bold: the press keeps the edit and its selection.
  await page.click(BTN('Bold'))
  await page.waitForFunction(() => window.__saves.length === 1)
  assert.ok(await page.$(EDITOR_SEL), 'Bold closed the editor')
  assert.equal(await page.evaluate(() => window.getSelection().toString()), 'red', 'Bold lost the selection')
  assert.equal((await spanStyle(EDITOR_SEL, 'red'))?.weight, '700', 'the word is not bold while editing')
  assert.equal((await spanStyle(EDITOR_SEL, 'Make it '))?.weight, '400', 'the rest turned bold')
  assert.equal(await page.$eval(BTN('Bold'), (b) => b.getAttribute('aria-pressed')), 'true')

  // Red, from the colour panel.
  await page.click(BTN('Text color'))
  await page.waitForSelector('section[aria-label="Colour panel"]')
  await page.click('section[aria-label="Colour panel"] button[aria-label="Default color #ef4444"]')
  await page.waitForFunction(() => window.__saves.length === 2)
  assert.ok(await page.$(EDITOR_SEL), 'the colour pick closed the editor')
  assert.deepEqual(await spanStyle(EDITOR_SEL, 'red'), { color: 'rgb(239, 68, 68)', weight: '700' }, 'the word is not red while editing')
  assert.equal((await spanStyle(EDITOR_SEL, 'Make it '))?.color, 'rgb(17, 17, 17)', 'the rest turned red')

  const saved = (await saves()).at(-1)[0].elements.find((e) => e.id === 't').overlay.props
  assert.equal(saved.runs, '[{"t":"Make it "},{"t":"red","c":"#ef4444","b":1}]')
  assert.equal(saved.text, 'Make it red')
  assert.equal(saved.color, '#111111')
  assert.equal(saved.fontWeight, '400')

  // A click on the empty slide beside the text ends the edit; it writes nothing more.
  // Measured now: the colour panel opening moved the canvas.
  const away = await page.$eval('[data-element-wrapper][data-element-id="t"]', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.right + 30, y: r.top + r.height / 2 }
  })
  assert.equal(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('section[aria-label="Colour panel"], [role="toolbar"], [contenteditable]'), away), false, 'the click point is not on the empty slide')
  await page.mouse.click(away.x, away.y)
  await page.waitForFunction((sel) => !document.querySelector(sel), {}, EDITOR_SEL)
  const canvasWord = '[data-element-wrapper][data-element-id="t"] [data-montaj-text]'
  await page.waitForSelector(`${canvasWord} span`)
  assert.deepEqual(await spanStyle(canvasWord, 'red'), { color: 'rgb(239, 68, 68)', weight: '700' }, 'the canvas does not draw the saved runs')
  assert.equal((await spanStyle(canvasWord, 'Make it '))?.color, 'rgb(17, 17, 17)')
  assert.equal((await saves()).length, 2, 'closing the edit wrote again')
  assert.deepEqual(errors, [])
})

/** Selects the text box, then double-clicks it to edit, as a person does. */
async function openEditor() {
  const box = await page.$eval('[data-element-wrapper][data-element-id="t"]', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.mouse.click(box.x, box.y)
  await page.mouse.click(box.x, box.y, { clickCount: 2 })
  await page.waitForSelector(EDITOR_SEL)
  return page.$eval(EDITOR_SEL, (el) => el.textContent)
}
const editorText = () => page.$eval(EDITOR_SEL, (el) => el.textContent)
const savedText = async () => (await saves()).at(-1)[0].elements.find((e) => e.id === 't').overlay.props.text

test('the Enter that confirms an IME composition keeps the edit open, and the composed text is saved', async () => {
  const before = await openEditor()
  await page.keyboard.press('End')
  // The page's own session: a second one does not drive the same input. With
  // focus emulation on, a synthetic IME key does not blur the headless window.
  const cdp = page._client()
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 })
  // The IME's own Enter (keyCode 229, during the composition) confirms it.
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
  assert.ok(await page.$(EDITOR_SEL), 'the IME\'s Enter closed the edit')
  assert.equal(await editorText(), `${before}に`)
  const n = (await saves()).length
  await page.keyboard.press('Enter')
  await page.waitForFunction((sel) => !document.querySelector(sel), {}, EDITOR_SEL)
  await page.waitForFunction((k) => window.__saves.length > k, {}, n)
  assert.equal(await savedText(), `${before}に`)
  assert.deepEqual(errors, [])
})

test('Cmd+Z inside the edit takes back an underlined word, then the typing; Cmd+Shift+Z puts the underline back', async () => {
  const before = await openEditor()
  await page.keyboard.press('End')
  await page.keyboard.type(' now')
  assert.equal(await editorText(), `${before} now`)
  for (let i = 0; i < 3; i++) {
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Shift')
  }
  const chord = async (key, shift = false) => {
    await page.keyboard.down('Meta')
    if (shift) await page.keyboard.down('Shift')
    await page.keyboard.press(key)
    if (shift) await page.keyboard.up('Shift')
    await page.keyboard.up('Meta')
  }
  // Underline: nothing before this test underlines, so the word starts without it.
  const underlined = () => page.$$eval(`${EDITOR_SEL} span`, (spans) =>
    spans.filter((s) => getComputedStyle(s).textDecorationLine === 'underline').map((s) => s.textContent))
  assert.deepEqual(await underlined(), [])
  await chord('u')
  assert.deepEqual(await underlined(), ['now'], 'Cmd+U did not underline the word')

  await chord('z')
  assert.ok(await page.$(EDITOR_SEL), 'Cmd+Z closed the edit')
  assert.deepEqual(await underlined(), [], 'Cmd+Z did not take back the underline')
  assert.equal(await editorText(), `${before} now`)

  await chord('z', true)
  assert.deepEqual(await underlined(), ['now'], 'Cmd+Shift+Z did not put the underline back')

  await chord('z')
  await chord('z')
  assert.equal(await editorText(), before, 'Cmd+Z did not take back the typing')

  const n = (await saves()).length
  await page.keyboard.press('Escape')
  await page.waitForFunction((sel) => !document.querySelector(sel), {}, EDITOR_SEL)
  await page.waitForFunction((k) => window.__saves.length > k, {}, n)
  assert.equal(await savedText(), before, 'the undone edit was not what closed')
  assert.deepEqual(errors, [])
})
