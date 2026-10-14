// §240: a render whose browser launch fails must not leave the other workers'
// Chrome running. renderAllSegments launches its pool through launchPool.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer'
import { launchPool, launchWorkerBrowser } from '../renderer.js'
import { overlayPageLaunchOptions } from '../page-guard.js'

const fakeWorker = (log, id) => ({ id, close: async () => { log.push(`close ${id}`) } })

test('launchPool: all launches succeed → the workers, in launch order, none closed', async () => {
  const log = []
  const workers = await launchPool(3, async i => fakeWorker(log, i))
  assert.deepEqual(workers.map(w => w.id), [0, 1, 2])
  assert.deepEqual(log, [])
})

test('launchPool: one launch fails → every launched worker is closed, then the first failure is thrown', async () => {
  const log = []
  const boom = new Error('Timed out after 30000 ms while waiting for the WS endpoint URL to appear in stdout!')
  await assert.rejects(
    launchPool(3, async i => {
      if (i === 1) throw boom
      return fakeWorker(log, i)
    }),
    err => err === boom,
  )
  assert.deepEqual(log.sort(), ['close 0', 'close 2'])
})

test('launchPool: a sibling still launching when another fails is waited for and closed', async () => {
  const log = []
  await assert.rejects(launchPool(2, async i => {
    if (i === 0) throw new Error('launch failed')
    await new Promise(r => setTimeout(r, 50))
    log.push('launched 1')
    return fakeWorker(log, 1)
  }), /launch failed/)
  assert.deepEqual(log, ['launched 1', 'close 1'])
})

test('launchPool: a close that throws does not hide the launch failure', async () => {
  await assert.rejects(launchPool(2, async i => {
    if (i === 1) throw new Error('launch failed')
    return { close: async () => { throw new Error('close failed') } }
  }), /launch failed/)
})

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

test('launchPool, real Chrome: a timed-out launch leaves the other worker\'s Chrome closed (§240)', { timeout: 120_000 }, async () => {
  let pid = null
  try {
    await assert.rejects(launchPool(2, async i => {
      if (i === 1) return puppeteer.launch({ ...overlayPageLaunchOptions({}), timeout: 150 })
      const worker = await launchWorkerBrowser({})
      pid = worker.browser.process().pid
      return worker
    }), /Timed out after 150 ms/)
    assert.ok(pid, 'the real worker launched')
    for (let t = 0; t < 50 && alive(pid); t++) await new Promise(r => setTimeout(r, 100))
    assert.equal(alive(pid), false, `worker Chrome ${pid} still running after launchPool rejected`)
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
  }
})
