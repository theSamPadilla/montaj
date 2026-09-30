// Pure selection: does --prefer-proxy decode the proxy for this item?
// A remove_bg item with a nobg_src must decode the cutout (as the render does),
// never the raw proxy, which still has the background.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldUseProxy } from '../sample-frame.js'

const yes = () => true
const no = () => false

test('proxy-only item under preferProxy uses the proxy', () => {
  assert.equal(shouldUseProxy({ proxySrc: '/p.mp4' }, true, yes), true)
})

test('remove_bg item with proxySrc and nobg_src does not use the proxy', () => {
  const item = { proxySrc: '/p.mp4', remove_bg: true, nobg_src: '/c_nobg.mov' }
  assert.equal(shouldUseProxy(item, true, yes), false)
})

test('nobg_src without remove_bg on still uses the proxy (render ignores it)', () => {
  assert.equal(shouldUseProxy({ proxySrc: '/p.mp4', nobg_src: '/c_nobg.mov' }, true, yes), true)
})

test('no preferProxy, no proxySrc, or missing file: no proxy', () => {
  assert.equal(shouldUseProxy({ proxySrc: '/p.mp4' }, false, yes), false)
  assert.equal(shouldUseProxy({}, true, yes), false)
  assert.equal(shouldUseProxy({ proxySrc: '/p.mp4' }, true, no), false)
})
