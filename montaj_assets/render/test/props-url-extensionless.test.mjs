// render/test/props-url-extensionless.test.mjs
//
// A props URL with NO extension (Spotify cover art: https://i.scdn.co/image/ab67…,
// an image CDN's https://images.example.com/photo-123?w=800) is fetched ON
// DEMAND, the way the editor preview loads it: never before the page loads,
// only when the overlay page requests that exact URL (page-guard.js
// installPageGuard). Node fetches it then, with the same timeout, size cap,
// concurrency and redirect rules as a media URL's prefetch, and keeps it only
// when the response says `Content-Type: image/*` or its first bytes are a PNG,
// JPEG, WebP, GIF or AVIF; anything else is aborted and logged "not fetched".
// So a text-only link with no extension is never requested (PV54), and nothing
// else PV54 decides moves: media URLs, pages, other extensions, file: and data:.
//
// The new names are read off the module namespaces, so on code without them
// each test fails on its own rather than the file failing to load.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import * as guard from '../page-guard.js'
import * as build from '../overlay-build.js'

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(48, 1)])
const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(48, 2)])
const HTML = Buffer.from('<!doctype html><html><head><title>Sign up</title></head><body>hello</body></html>')
const ftyp = (major, ...compat) => {
  const brands = [major, '\0\0\0\0', ...compat].join('')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(8 + brands.length)
  return Buffer.concat([size, Buffer.from('ftyp' + brands, 'latin1'), Buffer.alloc(16)])
}

// ---------------------------------------------------------------------------
// which props URLs are fetched, and when
// ---------------------------------------------------------------------------

describe('a props URL with no extension is fetched on demand; file:, data: and pages are not', () => {
  test('isExtensionlessPropsUrl: http(s), and the last path segment is a name with no dot', () => {
    for (const url of [
      'https://i.scdn.co/image/ab67616d0000b273e8b066f70c206551210d902b',
      'https://images.example.com/photo-1506744038136?w=800&q=80',
      'HTTP://Example.COM/a/b',
      'https://cdn.example.com/v1.2/cover',
    ]) assert.equal(build.isExtensionlessPropsUrl(url), true, url)
    for (const url of [
      'https://example.com/', 'https://example.com', 'https://example.com/team/',   // a page, not a file
      'https://example.com/signup.php?token=abc', 'https://example.com/page.html',   // an extension, not media
      'https://cdn.example.com/a.png',                                               // media: prefetched as before
      'file:///Users/me/secret', 'file:///Users/me/cover',                            // never through this path
      'data:image/png;base64,AAAA', 'blob:https://x/1', 'ftp://h/x', 'not a url',
    ]) assert.equal(build.isExtensionlessPropsUrl(url), false, url)
  })

  test('the boundary: media URLs prefetched, extension-less ones on demand, pages never; file: and data: where they were', () => {
    const cover = 'https://i.scdn.co/image/ab67616d0000b273e8b066f70c206551210d902b'
    const b = build.overlayReadBoundary({ props: {
      cover, badge: 'https://cdn.example.com/a.png',
      home: 'https://example.com/', page: 'https://example.com/signup.php?token=abc',
      inline: 'data:image/png;base64,AAAA', local: 'file:///nonexistent/montaj-fq54/cover',
    } })
    assert.deepEqual([...b.urls], ['https://cdn.example.com/a.png'], 'only media is prefetched')
    assert.deepEqual([...b.onDemandUrls], [cover])
    assert.deepEqual([...b.unfetchedUrls], ['https://example.com/', 'https://example.com/signup.php?token=abc'])
    assert.equal(b.files.size, 0, 'a missing file: names nothing; data: is not a file')
    assert.deepEqual(build.namedPropsUrls({ cover, badge: 'https://cdn.example.com/a.png', local: 'file:///x/cover' }),
      ['https://cdn.example.com/a.png'], 'render.js prefetches media only')
  })
})

// ---------------------------------------------------------------------------
// what makes it an image
// ---------------------------------------------------------------------------

describe('sniffImageType: the first bytes of a PNG, JPEG, WebP, GIF or AVIF', () => {
  test('each format is named by its MIME type', () => {
    assert.equal(guard.sniffImageType(PNG), 'image/png')
    assert.equal(guard.sniffImageType(JPEG), 'image/jpeg')
    assert.equal(guard.sniffImageType(Buffer.from('GIF87a......')), 'image/gif')
    assert.equal(guard.sniffImageType(Buffer.from('GIF89a......')), 'image/gif')
    assert.equal(guard.sniffImageType(Buffer.concat([Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'), Buffer.alloc(16)])), 'image/webp')
    assert.equal(guard.sniffImageType(ftyp('avif', 'avif', 'mif1', 'miaf')), 'image/avif')
    assert.equal(guard.sniffImageType(ftyp('avis', 'avis', 'msf1')), 'image/avif')
    assert.equal(guard.sniffImageType(ftyp('mif1', 'mif1', 'avif')), 'image/avif', 'avif as a compatible brand')
  })

  test('anything else is not an image', () => {
    for (const [label, bytes] of [
      ['html', HTML], ['empty', Buffer.alloc(0)], ['a cut-off PNG signature', PNG.subarray(0, 4)],
      ['json', Buffer.from('{"image":"x.png"}')], ['RIFF that is not WebP', Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ', 'latin1')],
      ['HEIC', ftyp('heic', 'mif1', 'heic')], ['MP4', ftyp('isom', 'isom', 'mp41')],
    ]) assert.equal(guard.sniffImageType(bytes), null, label)
  })
})

// ---------------------------------------------------------------------------
// the decision: an exact props URL with no extension, GET only
// ---------------------------------------------------------------------------

describe('pageRequestDecision on an extension-less URL', () => {
  const cover = 'https://i.scdn.co/image/ab67?size=640'
  const boundary = {
    allows: () => false,
    onDemandUrls: new Set([cover]),
    unfetchedUrls: new Set(['https://example.com/signup.php?token=abc']),
  }
  const decide = (url, method = 'GET') => guard.pageRequestDecision({ url, method }, { boundary })

  test('the exact props URL, GET: fetched on demand', () => {
    assert.deepEqual(decide(cover), { action: 'fetch', url: cover })
  })

  test('not GET, or not exactly a props URL: aborted as a network request, as before', () => {
    assert.deepEqual(decide(cover, 'POST'), { action: 'abort', kind: 'network', host: 'i.scdn.co' })
    assert.deepEqual(decide('https://i.scdn.co/image/ab67'), { action: 'abort', kind: 'network', host: 'i.scdn.co' })
    assert.deepEqual(decide('https://i.scdn.co/image/other'), { action: 'abort', kind: 'network', host: 'i.scdn.co' })
  })

  test('a props URL with a non-media extension: never fetched, as before', () => {
    assert.deepEqual(decide('https://example.com/signup.php?token=abc'),
      { action: 'abort', kind: 'unfetched', url: 'https://example.com/signup.php' })
  })
})

// ---------------------------------------------------------------------------
// the fetch and the guard: same caps, an image or nothing
// ---------------------------------------------------------------------------

describe('on demand: fetched when the page asks, kept only if it is an image', () => {
  let server, origin
  const hits = []
  const held = new Set()
  let inFlight = 0, maxInFlight = 0

  before(async () => {
    server = createServer((req, res) => {
      hits.push(req.url)
      const send = (type, body, extra = {}) => {
        res.writeHead(200, { ...(type ? { 'content-type': type } : {}), 'content-length': body.length, ...extra })
        res.end(body)
      }
      if (req.url.startsWith('/busy/')) {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
        return setTimeout(() => { inFlight--; send('image/png', PNG) }, 80)
      }
      switch (req.url) {
        case '/img/png': case '/img/png-again': case '/img/guard-png': return send('image/png', PNG)
        case '/img/octet': case '/img/guard-octet': return send('application/octet-stream', PNG)
        case '/img/untyped': return send(null, JPEG)
        case '/img/mislabelled': return send('text/plain; charset=utf-8', PNG)
        case '/img/html': case '/img/guard-html': return send('text/html; charset=utf-8', HTML)
        case '/img/empty': return send('application/octet-stream', Buffer.alloc(0))
        case '/img/html-endless': {
          // A page that never ends: refused on its first bytes, not read to the cap or the timeout.
          res.writeHead(200, { 'content-type': 'text/html' })
          res.write(HTML)
          held.add(res)
          return
        }
        case '/img/declared-big':
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(4 * 1024 * 1024) })
          return res.end()
        case '/img/streamed-big': {
          // Sniffs as a PNG, then keeps going: the cap still applies past the sniff.
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          res.write(PNG)
          const chunk = Buffer.alloc(256 * 1024)
          let sent = 0
          const pump = () => {
            while (sent < 4 * 1024 * 1024) {
              sent += chunk.length
              if (!res.write(chunk)) return res.once('drain', pump)
            }
            res.end()
          }
          return pump()
        }
        case '/img/slow': return   // never answers
        case '/img/to-file': res.writeHead(302, { location: 'file:///etc/hosts' }); return res.end()
        case '/img/to-data': res.writeHead(302, { location: `data:image/png;base64,${PNG.toString('base64')}` }); return res.end()
        case '/img/to-png': res.writeHead(302, { location: '/img/png' }); return res.end()
        case '/img/to-big': res.writeHead(302, { location: '/img/declared-big' }); return res.end()
        case '/page.png': return send('text/html', HTML)   // a media URL: prefetched as fetched, as before
      }
      res.writeHead(404); res.end()
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${server.address().port}`
  })
  after(() => {
    for (const res of held) res.destroy()
    server.closeAllConnections(); server.close()
  })

  async function withStderr(fn) {
    const orig = process.stderr.write.bind(process.stderr)
    let text = ''
    process.stderr.write = c => { text += String(c); return true }
    try { return [await fn(), text] } finally { process.stderr.write = orig }
  }
  const fetchOne = async (path, opts) => {
    const url = `${origin}${path}`
    const [entry, log] = await withStderr(() => guard.fetchOnDemandPropsUrl(url, opts))
    return { url, entry, log }
  }

  test('Content-Type image/*: kept, served as sent; fetched once per job', async () => {
    hits.length = 0
    const { url, entry } = await fetchOne('/img/png-again')
    assert.equal(entry.contentType, 'image/png')
    assert.deepEqual(entry.body, PNG)
    assert.equal(await guard.fetchOnDemandPropsUrl(url), entry)
    assert.deepEqual(hits, ['/img/png-again'])
  })

  for (const [path, type, bytes] of [
    ['/img/octet', 'image/png', PNG],
    ['/img/untyped', 'image/jpeg', JPEG],
    ['/img/mislabelled', 'image/png', PNG],
  ]) {
    test(`${path}: not labelled an image, but its bytes are one: kept, served as ${type}`, async () => {
      const { entry } = await fetchOne(path)
      assert.equal(entry.error, undefined, entry.error?.message)
      assert.equal(entry.contentType, type)
      assert.deepEqual(entry.body, bytes)
    })
  }

  for (const path of ['/img/html', '/img/empty']) {
    test(`${path}: not an image: refused, holding nothing`, async () => {
      const { entry, log } = await fetchOne(path)
      assert.deepEqual(entry, { notImage: true })
      assert.equal(log, '', 'the guard logs it, once, when it aborts the request')
    })
  }

  test('a page that never ends is refused on its first bytes, not read to the timeout', async () => {
    const t0 = Date.now()
    const { entry } = await fetchOne('/img/html-endless', { timeoutMs: 5000 })
    assert.deepEqual(entry, { notImage: true })
    assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`)
  })

  const MB = 1024 * 1024
  for (const [label, path, opts, pattern] of [
    ['a declared size over the cap', '/img/declared-big', { maxBytes: MB }, /exceeds 1 MB$/],
    ['a streamed size over the cap, past a PNG sniff', '/img/streamed-big', { maxBytes: MB }, /exceeds 1 MB$/],
    ['a timeout', '/img/slow', { timeoutMs: 300 }, /could not be fetched: timed out after 0 s$/],
    ['a 404', '/img/missing', {}, /could not be fetched: HTTP 404$/],
    ['a redirect to file:', '/img/to-file', {}, /could not be fetched: /],
    ['a redirect to data:', '/img/to-data', {}, /could not be fetched: /],
    ['a redirect to an image over the cap', '/img/to-big', { maxBytes: MB }, /exceeds 1 MB$/],
  ]) {
    test(`${label}: the same named failure as a media URL`, async () => {
      const { url, entry, log } = await fetchOne(path, opts)
      assert.ok(entry.error instanceof guard.PropsFetchError, `got ${JSON.stringify(entry)}`)
      assert.ok(entry.error.message.startsWith(`props URL ${url} `), entry.error.message)
      assert.match(entry.error.message, pattern)
      assert.equal(log, `[montaj] ${entry.error.message}\n`)
    })
  }

  test('a redirect to an http(s) image is followed and kept', async () => {
    const { entry } = await fetchOne('/img/to-png')
    assert.equal(entry.contentType, 'image/png')
    assert.deepEqual(entry.body, PNG)
  })

  test('no more than 6 at a time, and every one is served', async () => {
    maxInFlight = 0
    const urls = Array.from({ length: 15 }, (_, i) => `${origin}/busy/${i}`)
    const got = await Promise.all(urls.map(u => guard.fetchOnDemandPropsUrl(u)))
    assert.equal(maxInFlight, 6)
    assert.ok(got.every(e => e.body?.equals(PNG)))
  })

  test('a media URL is unchanged: prefetched, served as fetched, whatever it holds', async () => {
    const url = `${origin}/page.png`
    const got = await guard.prefetchPropsUrls([url])
    assert.equal(got.get(url).contentType, 'text/html')
    assert.deepEqual(got.get(url).body, HTML)
  })

  // installPageGuard on a page that asks. The fake page has no evaluate(), so
  // a guard that touched the page where it should not would throw.
  function fakePage() {
    const page = { handlers: [] }
    page.setRequestInterception = async () => {}
    page.on = (event, fn) => { if (event === 'request') page.handlers.push(fn) }
    page.request = (url, method = 'GET') => {
      const calls = []
      let done
      const settled = new Promise(r => { done = r })
      const req = {
        url: () => url, method: () => method, resourceType: () => 'image',
        abort: async reason => { calls.push(['abort', reason]); done() },
        continue: async () => { calls.push(['continue']); done() },
        respond: async r => { calls.push(['respond', r]); done() },
      }
      for (const h of page.handlers) h(req)
      return { calls, settled }
    }
    return page
  }
  const boundaryFor = (...paths) => ({ allows: () => false, onDemandUrls: new Set(paths.map(p => `${origin}${p}`)) })

  test('installPageGuard: an image the page asks for is served from Node\'s fetch', async () => {
    hits.length = 0
    const page = fakePage()
    const g = await guard.installPageGuard(page, { boundary: boundaryFor('/img/guard-octet') })
    assert.deepEqual(hits, [], 'nothing is fetched before the page asks')
    const r = page.request(`${origin}/img/guard-octet`)
    await r.settled
    assert.equal(r.calls.length, 1)
    assert.equal(r.calls[0][0], 'respond')
    assert.equal(r.calls[0][1].status, 200)
    assert.equal(r.calls[0][1].contentType, 'image/png', 'served as what it sniffed as')
    assert.deepEqual(r.calls[0][1].body, PNG)
    assert.deepEqual(hits, ['/img/guard-octet'])
    assert.equal(g.blocked.size, 0)
    assert.doesNotThrow(() => g.assertPropsServed())
  })

  test('installPageGuard: one that is not an image is aborted, logged as not fetched, and the job goes on', async () => {
    const page = fakePage()
    const url = `${origin}/img/guard-html`
    const [{ g, r }, log] = await withStderr(async () => {
      const g = await guard.installPageGuard(page, { boundary: boundaryFor('/img/guard-html') })
      const r = page.request(url)
      await r.settled
      return { g, r }
    })
    assert.deepEqual(r.calls, [['abort', 'blockedbyclient']])
    assert.match(log, new RegExp(`^\\[montaj\\] not fetched: ${url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\(a props URL is fetched only when`))
    assert.ok(g.blocked.has(url), 'so its console line is noise, and the sample is not cached')
    assert.doesNotThrow(() => g.assertPropsServed())
  })

  test('installPageGuard: one that fails is aborted and fails the job by name', async () => {
    const page = fakePage()
    const url = `${origin}/img/guard-missing`
    const [{ g, r }] = await withStderr(async () => {
      const g = await guard.installPageGuard(page, { boundary: boundaryFor('/img/guard-missing') })
      const r = page.request(url)
      await r.settled
      return { g, r }
    })
    assert.deepEqual(r.calls, [['abort', 'blockedbyclient']])
    assert.throws(() => g.assertPropsServed(), new RegExp(`props URL ${url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} could not be fetched: HTTP 404`))
  })

  test('installPageGuard: settleOnDemand does nothing on a page whose props name no such URL', async () => {
    const page = fakePage()
    const g = await guard.installPageGuard(page, { boundary: { allows: () => false } })
    await g.settleOnDemand()   // would throw: the fake page has no evaluate()
  })
})
