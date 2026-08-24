import '@testing-library/jest-dom'

// SP3 fix B2: jsdom's canPlayType returns '' for everything, which would make
// the proxy capability gate strip proxySrc in EVERY test and silently change
// what the src-selection tests assert. Report the proxy codec as playable so
// tests exercise the supported path by default; the unsupported path is
// covered explicitly via __setProxySupportForTests in proxySupport.test.ts.
const realCanPlayType = HTMLMediaElement.prototype.canPlayType
HTMLMediaElement.prototype.canPlayType = function (type: string) {
  if (type.includes('avc1')) return 'probably'
  return realCanPlayType.call(this, type)
}

// jsdom implements no ResizeObserver, and several editor components measure
// themselves with one (CaptionSpecimen, SocialSafeZoneOverlay, the preview's
// scale observer). Without a stub, merely MOUNTING one of them throws
// `ReferenceError: ResizeObserver is not defined` — a test-infrastructure
// failure that reads as a behaviour regression. Eight test files had each
// grown their own local stub; this is that same stub, installed once.
//
// A no-op is the right shape: the callback never fires, so every consumer
// takes its "not measured yet" path, which each one already handles (e.g.
// CaptionSpecimen clamps to its readable font-size floor). Tests that need
// real measurements still override this with their own fake.
//
// Guarded so a future jsdom that ships a real implementation wins over ours.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
