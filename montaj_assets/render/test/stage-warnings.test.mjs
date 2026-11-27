// render/test/stage-warnings.test.mjs
//
// stage-warnings.js: the 3D stage's fail-open console lines (`model3d: ...`) and an overlay's skipped parts
// (`overlay: ...`), console.warn or console.info, reach the render log and a sample's warnings. renderer.js used to
// read the page console for errors only, so a look pass that failed mid-render left the rest of the segment ungraded
// without a word.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stageWarningOf, STAGE_WARNING_PREFIX } from '../stage-warnings.js'

const HERE = join(import.meta.dirname, '..')

test('the stage lines, warn or info, are kept; nothing else is', () => {
  assert.equal(stageWarningOf({ type: 'warning', text: 'model3d: the look pass failed, drawing without it shader x' }),
    'model3d: the look pass failed, drawing without it shader x')
  assert.equal(stageWarningOf({ type: 'info', text: "  model3d: the scene's physics bake was not played (format); the stage shows keyed motion " }),
    "model3d: the scene's physics bake was not played (format); the stage shows keyed motion")
  assert.equal(stageWarningOf({ type: 'log', text: 'model3d: applying textures failed' }), 'model3d: applying textures failed')
  assert.equal(stageWarningOf({ type: 'warning', text: 'overlay: cee_diagram part "gear-2" (gear) was not drawn: bad radius' }),
    'overlay: cee_diagram part "gear-2" (gear) was not drawn: bad radius')
  for (const m of [
    { type: 'error', text: 'model3d: an error is a page error, not this' },
    { type: 'debug', text: 'model3d: debug chatter' },
    { type: 'warning', text: 'THREE.WebGLRenderer: something' },
    { type: 'info', text: 'the model3d: prefix must lead' },
    { type: 'warning', text: 'model3d:no space' },
    {},
  ]) assert.equal(stageWarningOf(m), null, JSON.stringify(m))
})

test('a long line is cut to 300 characters', () => {
  const w = stageWarningOf({ type: 'warning', text: `model3d: ${'x'.repeat(1000)}` })
  assert.equal(w.length, 300)
  assert.ok(w.endsWith('...'))
})

test('renderer.js logs each stage line once per page with the prefix the app reads; sample-frame.js returns them as warnings', () => {
  assert.equal(STAGE_WARNING_PREFIX, 'page warning: ')
  const renderer = readFileSync(join(HERE, 'renderer.js'), 'utf8')
  assert.match(renderer, /import \{ stageWarningOf, STAGE_WARNING_PREFIX \} from '\.\/stage-warnings\.js'/)
  assert.match(renderer, /const stage = stageWarningOf\(\{ type: msg\.type\(\), text: msg\.text\(\) \}\)\n\s+if \(stage\) \{\n\s+if \(!stageWarnings\.has\(stage\)\) \{ stageWarnings\.add\(stage\); log\(`\$\{STAGE_WARNING_PREFIX\}\$\{stage\}`\) \}/)
  // The stage lines are read before the errors-only filter, which used to drop them.
  const handler = renderer.slice(renderer.indexOf("page.on('console'"), renderer.indexOf("page.on('console'") + 600)
  assert.ok(handler.indexOf('stageWarningOf') < handler.indexOf("msg.type() !== 'error'"), handler)
  const sample = readFileSync(join(HERE, 'sample-frame.js'), 'utf8')
  assert.match(sample, /if \(stage\) \{ stageWarnings\.add\(stage\); return \}/)
  assert.match(sample, /for \(const w of stageWarnings\) warnings\.push\(w\)/)
  assert.match(sample, /\|\| stageWarnings\.size > 0\n/)
})
