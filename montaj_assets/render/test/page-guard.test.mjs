// render/test/page-guard.test.mjs
//
// PV54. page-guard.js: what every overlay page runs under.
//
//   (a) structural: every browser that loads an overlay page is launched with
//       overlayPageLaunchOptions and guarded before it loads anything, and
//       every overlay bundle is built with overlayEsbuildOptions;
//   (b) configuration: the controls interception cannot enforce (the resolver
//       rule, the WebRTC policy, the popup blocker, the CSP) are in force;
//   (c) the request decision, on URL strings, and the handler that applies it;
//   and the props-URL prefetch's named failures.
//
// What (b) proves is that the controls are IN FORCE. The evidence that they
// WORK, for the channels request interception cannot see, is the pre-fix
// measurement in montaj-app's PV54 plan, not re-derived here.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import puppeteer from 'puppeteer'
import {
  GOOGLE_FONT_HOSTS, hostResolverRules, overlayPageLaunchOptions, overlayPageCsp, overlayPageCspMeta,
  pageNeedsGoogleFonts, pageRequestDecision, installPageGuard, prefetchPropsUrls, PropsFetchError,
} from '../page-guard.js'
import { generateHtml } from '../bundle.js'

const RENDER = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = name => readFileSync(join(RENDER, name), 'utf8')

// The render modules: every .js directly in render/, not node_modules, test/
// or the dev-only scripts/.
const MODULES = readdirSync(RENDER).filter(n => n.endsWith('.js')).sort()

// ---------------------------------------------------------------------------
// (a) structural
// ---------------------------------------------------------------------------

describe('(a) every overlay page is launched, guarded and bundled through the shared helpers', () => {
  test('the scan sees the modules it is about', () => {
    for (const m of ['renderer.js', 'sample-frame.js', 'render-carousel.js', 'bundle.js', 'preview-bundle.js', 'capture-site.js']) {
      assert.ok(MODULES.includes(m), m)
    }
  })

  test('every puppeteer.launch( outside capture-site.js takes overlayPageLaunchOptions(', () => {
    const launchers = []
    for (const m of MODULES.filter(m => m !== 'capture-site.js')) {
      const text = src(m)
      const all = text.match(/puppeteer\.launch\(/g)?.length ?? 0
      const shared = text.match(/puppeteer\.launch\(\s*overlayPageLaunchOptions\(/g)?.length ?? 0
      assert.equal(shared, all, `${m}: ${all - shared} launch(es) without overlayPageLaunchOptions`)
      if (all) launchers.push(m)
    }
    assert.deepEqual(launchers, ['render-carousel.js', 'renderer.js', 'sample-frame.js'])
  })

  test('every page they open gets installPageGuard before its first goto', () => {
    for (const m of ['render-carousel.js', 'renderer.js', 'sample-frame.js']) {
      const text = src(m)
      const pages = text.match(/\.newPage\(\)/g)?.length ?? 0
      const guards = text.match(/\binstallPageGuard\(page,/g)?.length ?? 0
      assert.ok(pages > 0, `${m} opens a page`)
      assert.equal(guards, pages, `${m}: ${pages} page(s), ${guards} guard(s)`)
      assert.ok(text.indexOf('installPageGuard(page,') < text.indexOf('.goto('), `${m}: the guard precedes the goto`)
    }
  })

  test('every esbuild.build( takes overlayEsbuildOptions, and keeps its plugins', () => {
    // One build per module, in exactly these shapes. A new build site anywhere
    // in render/ fails the first assertion until it is added here.
    const FORMS = {
      'bundle.js':          /const options = overlayEsbuildOptions\(\{ boundary \}\)[^]*?esbuild\.build\(\{\n\s*\.\.\.options,/,
      'preview-bundle.js':  /esbuild\.build\(previewEsbuildOptions\(/,
      'render-carousel.js': /esbuild\.build\(\{\n\s*\.\.\.overlayEsbuildOptions\(\{ boundary \}\),/,
    }
    assert.deepEqual(MODULES.filter(m => /esbuild\.build\(/.test(src(m))), Object.keys(FORMS))
    for (const [m, form] of Object.entries(FORMS)) {
      const text = src(m)
      assert.equal(text.match(/esbuild\.build\(/g).length, 1, `${m}: one build`)
      assert.match(text, form, m)
      // A `plugins:` of its own must keep the guard's.
      for (const [line] of text.matchAll(/^\s*plugins:.*$/gm)) {
        assert.match(line, /\[\.\.\.\w+\.plugins,/, `${m}: ${line.trim()}`)
      }
    }
    // preview-bundle's options start from overlayEsbuildOptions and keep its plugins.
    assert.match(src('preview-bundle.js'),
      /const base = overlayEsbuildOptions\(\{ boundary:[^]*?\.\.\.base,[^]*?plugins:\s*\[\.\.\.base\.plugins,/)
  })

  test('capture-site.js loads remote pages and launches with neither file-access flag', () => {
    // Its comment names both flags on purpose, so the launch call is what is read.
    const launch = src('capture-site.js').match(/puppeteer\.launch\(\{[^]*?\n  \}\)/g)
    assert.equal(launch?.length, 1)
    assert.match(launch[0], /args: \[/)
    assert.doesNotMatch(launch[0], /--allow-file-access-from-files|--disable-web-security|overlayPageLaunchOptions/)
  })
})

// ---------------------------------------------------------------------------
// (b) configuration: in force
// ---------------------------------------------------------------------------

describe('(b) the launch flags', () => {
  test('no host resolves; the font hosts are excluded only for a page that needs them', () => {
    assert.equal(hostResolverRules(), 'MAP * ~NOTFOUND')
    assert.equal(hostResolverRules({ needsGoogleFonts: true }),
      'MAP * ~NOTFOUND, EXCLUDE fonts.googleapis.com, EXCLUDE fonts.gstatic.com')
  })

  test('the args carry the resolver rule, the WebRTC policy and no SharedWorker', () => {
    for (const needsGoogleFonts of [false, true]) {
      const { args } = overlayPageLaunchOptions({ needsGoogleFonts })
      assert.ok(args.includes(`--host-resolver-rules=${hostResolverRules({ needsGoogleFonts })}`))
      assert.ok(args.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp'))
      // The spelling that does nothing (measured) must not stand in for it.
      assert.ok(!args.some(a => a.startsWith('--force-webrtc-ip-handling-policy')))
      assert.ok(args.includes('--disable-blink-features=SharedWorker'))
      assert.equal(args.some(a => a.includes('EXCLUDE')), needsGoogleFonts)
    }
  })

  test('the popup blocker is on: puppeteer\'s default --disable-popup-blocking is dropped', () => {
    const opts = overlayPageLaunchOptions()
    assert.ok(puppeteer.defaultArgs(opts).includes('--disable-popup-blocking'), 'puppeteer adds it by default')
    assert.ok(opts.ignoreDefaultArgs.includes('--disable-popup-blocking'))
    assert.ok(!opts.args.includes('--disable-popup-blocking'))
  })

  test('--disable-web-security only for the callers that always had it', () => {
    assert.ok(!overlayPageLaunchOptions().args.includes('--disable-web-security'))
    assert.ok(overlayPageLaunchOptions({ disableWebSecurity: true }).args.includes('--disable-web-security'))
    assert.match(src('renderer.js'), /overlayPageLaunchOptions\(\{ needsGoogleFonts, disableWebSecurity: true \}\)/)
    assert.match(src('sample-frame.js'), /overlayPageLaunchOptions\(\{ needsGoogleFonts, disableWebSecurity: true \}\)/)
    assert.match(src('render-carousel.js'), /overlayPageLaunchOptions\(\{ needsGoogleFonts \}\)/)
  })

  test('the browser Chromium actually starts has them', { timeout: 60_000 }, async () => {
    const browser = await puppeteer.launch(overlayPageLaunchOptions({ needsGoogleFonts: true }))
    try {
      const argv = browser.process().spawnargs
      assert.ok(argv.includes(`--host-resolver-rules=${hostResolverRules({ needsGoogleFonts: true })}`))
      assert.ok(argv.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp'))
      assert.ok(argv.includes('--disable-blink-features=SharedWorker'))
      assert.ok(!argv.includes('--disable-popup-blocking'))
    } finally { await browser.close() }
  })
})

describe('(b) the page CSP', () => {
  const CSP = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/

  test('a page with no Google Fonts: connect-src and worker-src are local only', () => {
    const html = generateHtml(100, 100)
    assert.equal(html.match(CSP)?.[1], 'connect-src file: data: blob:; worker-src file: data: blob:')
    assert.equal(pageNeedsGoogleFonts(html), false)
    // First in <head> after the charset: a meta policy covers only what follows it.
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<style>'))
  })

  test('a page that links Google Fonts: the two font hosts, and it says it needs them', () => {
    const html = generateHtml(100, 100, false, ['Anton'])
    assert.equal(html.match(CSP)?.[1],
      'connect-src file: data: blob: https://fonts.googleapis.com https://fonts.gstatic.com; worker-src file: data: blob:')
    assert.equal(pageNeedsGoogleFonts(html), true)
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('fonts.googleapis.com/css2'))
  })

  test('props URLs are named exactly in connect-src, without their query', () => {
    const csp = overlayPageCsp({ connectUrls: ['https://cdn.example.com/team/badge.png?v=2', 'data:x', 'nonsense'] })
    assert.equal(csp, 'connect-src file: data: blob: https://cdn.example.com/team/badge.png; worker-src file: data: blob:')
    // `;` and `,` cannot end the directive or the policy.
    assert.match(overlayPageCsp({ connectUrls: ['https://h.example/a;b,c.png'] }), /https:\/\/h\.example\/a%3Bb%2Cc\.png;/)
    // The meta attribute is escaped.
    assert.doesNotMatch(overlayPageCspMeta({ connectUrls: ['https://h.example/"><x'] }), /"><x/)
  })

  test('both renderers build their CSP from the same helper', () => {
    for (const m of ['bundle.js', 'render-carousel.js']) {
      assert.match(src(m), /overlayPageCspMeta\(\{ needsGoogleFonts: fellThrough\.length > 0, connectUrls \}\)/, m)
    }
  })
})

// ---------------------------------------------------------------------------
// (c) the request decision
// ---------------------------------------------------------------------------

describe('(c) pageRequestDecision', () => {
  const INSIDE = '/work/page/bundle.js'
  const boundary = { allows: p => p.startsWith('/work/') }
  const badge = 'https://cdn.example.com/team/badge.png'
  const entry = { contentType: 'image/png', body: Buffer.from('png') }
  const propsCache = new Map([[badge, entry]])
  const decide = (url, method = 'GET', extra = {}) =>
    pageRequestDecision({ url, method }, { boundary, propsCache, ...extra })

  test('file: in the boundary continues; outside it aborts, naming the path', () => {
    assert.deepEqual(decide(pathToFileURL(INSIDE).href), { action: 'continue' })
    assert.deepEqual(decide('file:///elsewhere/notes.txt'), { action: 'abort', kind: 'read', path: '/elsewhere/notes.txt' })
  })

  test('file: is judged by the path Chromium loads: decoded, without query or fragment', () => {
    const seen = []
    const spy = { allows: p => { seen.push(p); return true } }
    pageRequestDecision({ url: 'file:///work/a%20b.png?x=1#f' }, { boundary: spy })
    assert.deepEqual(seen, ['/work/a b.png'])
  })

  test('file: with a host names no local file here, and is aborted', () => {
    assert.equal(decide('file://server/work/page/bundle.js').action, 'abort')
    assert.deepEqual(decide('file://localhost/work/page/bundle.js'), { action: 'continue' })
  })

  test('data: and blob: continue', () => {
    assert.deepEqual(decide('data:image/png;base64,AAAA'), { action: 'continue' })
    assert.deepEqual(decide('blob:file:///0b6f-4c1a'), { action: 'continue' })
  })

  test('a props URL, exactly, is answered from the cache', () => {
    assert.deepEqual(decide(badge), { action: 'respond', response: entry })
    // new URL() normalizes, so the host's case is not a near miss.
    assert.deepEqual(decide('https://CDN.example.com/team/badge.png'), { action: 'respond', response: entry })
  })

  test('a props URL, nearly, is aborted', () => {
    for (const url of [
      `${badge}?v=2`, `${badge}#x`, `${badge}/`, 'http://cdn.example.com/team/badge.png',
      'https://cdn.example.com:8443/team/badge.png', 'https://cdn.example.com/team/badge.PNG',
      'https://evil.cdn.example.com/team/badge.png', 'https://cdn.example.com.evil.tld/team/badge.png',
    ]) {
      assert.equal(decide(url).action, 'abort', url)
    }
    for (const method of ['POST', 'PUT', 'HEAD']) {
      assert.equal(decide(badge, method).action, 'abort', method)
    }
  })

  test('the Google Fonts hosts continue for a page that needs them, and only for plain https GET', () => {
    const css = 'https://fonts.googleapis.com/css2?family=Anton&display=swap'
    const woff = 'https://fonts.gstatic.com/s/anton/v25/1Ptgg87LROyAm0K08i4gS7lu.woff2'
    for (const url of [css, woff]) {
      assert.deepEqual(decide(url, 'GET', { needsGoogleFonts: true }), { action: 'continue' }, url)
      assert.equal(decide(url, 'GET', { needsGoogleFonts: false }).action, 'abort', `${url} without the need`)
      assert.equal(decide(url, 'POST', { needsGoogleFonts: true }).action, 'abort', `${url} POST`)
    }
    for (const url of [
      'http://fonts.googleapis.com/css2?family=Anton', 'https://fonts.googleapis.com:444/css2',
      'https://user:pw@fonts.googleapis.com/css2', 'https://x.fonts.googleapis.com/css2',
      'https://fonts.googleapis.com.evil.tld/css2', 'https://fonts.google.com/',
    ]) {
      assert.equal(decide(url, 'GET', { needsGoogleFonts: true }).action, 'abort', url)
    }
    assert.deepEqual(GOOGLE_FONT_HOSTS, ['fonts.googleapis.com', 'fonts.gstatic.com'])
  })

  test('a props URL whose prefetch failed aborts, carrying the failure', () => {
    const error = new PropsFetchError(`props URL ${badge} could not be fetched: HTTP 404`)
    const failed = new Map([[badge, { error }]])
    assert.deepEqual(pageRequestDecision({ url: badge }, { boundary, propsCache: failed }),
      { action: 'abort', kind: 'props', error })
  })

  test('a props URL that is not media is never fetched: aborted, named without its query', () => {
    const signup = 'https://example.com/signup?token=abc'
    const b = { allows: () => false, unfetchedUrls: new Set([signup]) }
    assert.deepEqual(pageRequestDecision({ url: signup }, { boundary: b }),
      { action: 'abort', kind: 'unfetched', url: 'https://example.com/signup' })
  })

  test('everything else aborts, naming the host only', () => {
    assert.deepEqual(decide('https://example.com/any/path?q=1'), { action: 'abort', kind: 'network', host: 'example.com' })
    for (const url of ['ws://127.0.0.1:9/x', 'wss://example.com/', 'chrome://version', 'about:blank', 'ftp://h/x', 'not a url']) {
      assert.equal(decide(url).action, 'abort', url)
    }
  })
})

describe('(c) installPageGuard applies each decision exactly once', () => {
  const boundary = { allows: p => p.startsWith('/work/') }
  const badge = 'https://cdn.example.com/team/badge.png'

  function fakePage() {
    const page = { interception: null, handlers: [] }
    page.setRequestInterception = async on => { page.interception = on }
    page.on = (event, fn) => { if (event === 'request') page.handlers.push(fn) }
    page.request = (url, { method = 'GET', resourceType = 'image' } = {}) => {
      const calls = []
      const req = {
        url: () => url, method: () => method, resourceType: () => resourceType,
        abort: async reason => { calls.push(['abort', reason]) },
        continue: async () => { calls.push(['continue']) },
        respond: async r => { calls.push(['respond', r]) },
      }
      for (const h of page.handlers) h(req)
      return { req, calls }
    }
    return page
  }

  async function withStderr(fn) {
    const orig = process.stderr.write.bind(process.stderr)
    let text = ''
    process.stderr.write = c => { text += String(c); return true }
    try { return [await fn(), text] } finally { process.stderr.write = orig }
  }

  test('a boundary is required', async () => {
    await assert.rejects(installPageGuard(fakePage(), {}), /read boundary is required/)
  })

  test('interception is on, and each request gets one outcome; blocks are logged by path or host only', async () => {
    const page = fakePage()
    const cached = []
    const [guard, log] = await withStderr(async () => {
      const g = await installPageGuard(page, {
        boundary,
        propsCache: new Map([[badge, { contentType: 'image/png', body: Buffer.from('png') }]]),
        onCached: r => cached.push(r.url()),
      })
      page.results = {
        inside: page.request('file:///work/page/logo.png'),
        outside: page.request('file:///elsewhere/notes.txt'),
        props: page.request(badge),
        network: page.request('https://example.com/collect?q=1', { method: 'POST', resourceType: 'fetch' }),
      }
      return g
    })
    assert.equal(page.interception, true)
    const { inside, outside, props, network } = page.results
    assert.deepEqual(inside.calls, [['continue']])
    assert.deepEqual(outside.calls, [['abort', 'blockedbyclient']])
    assert.equal(props.calls.length, 1)
    assert.equal(props.calls[0][0], 'respond')
    assert.equal(props.calls[0][1].status, 200)
    assert.equal(props.calls[0][1].contentType, 'image/png')
    assert.deepEqual(cached, [badge])
    assert.deepEqual(network.calls, [['abort', 'blockedbyclient']])
    assert.match(log, /\[montaj\] blocked a read outside the allowed folders: \/elsewhere\/notes\.txt\n/)
    assert.match(log, /\[montaj\] blocked a network request to example\.com\n/)
    assert.doesNotMatch(log, /collect|q=1/)
    assert.deepEqual([...guard.blocked].sort(), ['file:///elsewhere/notes.txt', 'https://example.com/collect?q=1'])
  })

  test('onAllowed takes over exactly the requests the guard allows', async () => {
    const page = fakePage()
    const handed = []
    await withStderr(() => installPageGuard(page, { boundary, onAllowed: r => handed.push(r.url()) }))
    const allowed = page.request('file:///work/page/logo.png')
    const refused = page.request('file:///elsewhere/logo.png')
    assert.deepEqual(handed, ['file:///work/page/logo.png'])
    assert.deepEqual(allowed.calls, [], 'the guard leaves an allowed request to onAllowed')
    assert.deepEqual(refused.calls, [['abort', 'blockedbyclient']])
  })

  test('a failed props URL the page asks for is recorded, and assertPropsServed throws it', async () => {
    const page = fakePage()
    const error = new PropsFetchError(`props URL ${badge} could not be fetched: HTTP 404`)
    const [guard, log] = await withStderr(async () => {
      const g = await installPageGuard(page, { boundary, propsCache: new Map([[badge, { error }]]) })
      assert.doesNotThrow(() => g.assertPropsServed(), 'nothing asked for yet')
      page.results = page.request(badge)
      return g
    })
    assert.deepEqual(page.results.calls, [['abort', 'blockedbyclient']])
    assert.equal(guard.failedProps.get(badge), error)
    assert.ok(guard.blocked.has(badge), 'so its console line is noise, not a page error')
    assert.throws(() => guard.assertPropsServed(), err => err === error)
    assert.equal(log, '', 'the prefetch already logged it')
  })

  test('a non-media props URL the page asks for is logged as never fetched', async () => {
    const page = fakePage()
    const signup = 'https://example.com/signup?token=abc'
    const [guard, log] = await withStderr(async () => {
      const g = await installPageGuard(page, { boundary: { ...boundary, unfetchedUrls: new Set([signup]) } })
      page.results = page.request(signup)
      return g
    })
    assert.deepEqual(page.results.calls, [['abort', 'blockedbyclient']])
    assert.match(log, /^\[montaj\] not fetched: https:\/\/example\.com\/signup \(a props URL is fetched only when/)
    assert.doesNotMatch(log, /token/)
    assert.doesNotThrow(() => guard.assertPropsServed())
  })

  test('isBlockNoise is Chromium\'s console line for a blocked request, and nothing else', async () => {
    const page = fakePage()
    const guard = await withStderr(() => installPageGuard(page, { boundary })).then(([g]) => g)
    page.request('file:///elsewhere/logo.png')
    const msg = (type, text, url) => ({ type: () => type, text: () => text, location: () => ({ url }) })
    assert.equal(guard.isBlockNoise(msg('error', 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT', 'file:///elsewhere/logo.png')), true)
    assert.equal(guard.isBlockNoise(msg('error', 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT', 'file:///work/x.png')), false)
    assert.equal(guard.isBlockNoise(msg('error', 'TypeError: x is undefined', 'file:///elsewhere/logo.png')), false)
    assert.equal(guard.isBlockNoise(msg('warning', 'net::ERR_BLOCKED_BY_CLIENT', 'file:///elsewhere/logo.png')), false)
  })
})

// ---------------------------------------------------------------------------
// props URLs, fetched by Node before the page loads
// ---------------------------------------------------------------------------

describe('prefetchPropsUrls: each URL once, at most 6 at a time, and a named failure when it cannot be had', () => {
  let server, origin
  const hits = []
  let inFlight = 0, maxInFlight = 0
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

  before(async () => {
    server = createServer((req, res) => {
      hits.push(req.url)
      if (req.url === '/images/media/team/badge/barcelona.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length })
        return res.end(PNG)
      }
      if (req.url.startsWith('/busy/')) {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
        return setTimeout(() => { inFlight--; res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG) }, 80)
      }
      if (req.url === '/declared-big.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(4 * 1024 * 1024) })
        return res.end()
      }
      if (req.url === '/streamed-big.png') {
        res.writeHead(200, { 'content-type': 'image/png' })   // chunked: no length up front
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
      if (req.url === '/slow.png') return   // never answers
      res.writeHead(404); res.end()
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${server.address().port}`
  })
  after(() => { server.closeAllConnections(); server.close() })

  async function withStderr(fn) {
    const orig = process.stderr.write.bind(process.stderr)
    let text = ''
    process.stderr.write = c => { text += String(c); return true }
    try { return [await fn(), text] } finally { process.stderr.write = orig }
  }

  test('fetched once however often it is named, and served as fetched', async () => {
    hits.length = 0
    const url = `${origin}/images/media/team/badge/barcelona.png`
    const a = await prefetchPropsUrls([url, url])
    const b = await prefetchPropsUrls(new Set([url]))
    assert.deepEqual(hits, ['/images/media/team/badge/barcelona.png'])
    assert.deepEqual([...a.keys()], [url])
    assert.equal(a.get(url).contentType, 'image/png')
    assert.deepEqual(a.get(url).body, PNG)
    assert.equal(b.get(url), a.get(url))
  })

  test('no more than 6 at a time, and every one is served', async () => {
    const urls = Array.from({ length: 15 }, (_, i) => `${origin}/busy/${i}.png`)
    const got = await prefetchPropsUrls(urls)
    assert.equal(maxInFlight, 6)
    assert.ok(urls.every(u => got.get(u).body?.equals(PNG)))
  })

  const MB = 1024 * 1024
  for (const [label, path, opts, pattern] of [
    ['a 404', '/missing.png', {}, /could not be fetched: HTTP 404$/],
    ['a declared size over the cap', '/declared-big.png', { maxBytes: MB }, /exceeds 1 MB$/],
    ['a streamed size over the cap', '/streamed-big.png', { maxBytes: MB }, /exceeds 1 MB$/],
    ['a timeout', '/slow.png', { timeoutMs: 300 }, /could not be fetched: timed out after 0 s$/],
  ]) {
    test(`${label}: recorded, not thrown, as a PropsFetchError naming the URL, and logged`, async () => {
      const url = `${origin}${path}`
      const [got, log] = await withStderr(() => prefetchPropsUrls([url], opts))
      const { error } = got.get(url)
      assert.ok(error instanceof PropsFetchError)
      assert.ok(error.message.startsWith(`props URL ${url} `), error.message)
      assert.match(error.message, pattern)
      assert.equal(log, `[montaj] ${error.message}\n`)
    })
  }

  test('a failure is remembered for the job: asked once', async () => {
    hits.length = 0
    const url = `${origin}/missing-twice.png`
    const [a] = await withStderr(() => prefetchPropsUrls([url]))
    const [b] = await withStderr(() => prefetchPropsUrls([url]))
    assert.ok(a.get(url).error && b.get(url).error)
    assert.deepEqual(hits, ['/missing-twice.png'])
  })
})
