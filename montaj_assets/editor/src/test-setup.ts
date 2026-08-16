import '@testing-library/jest-dom'

// SP3 fix B2: jsdom's canPlayType returns '' for everything, which would make
// the proxy capability gate strip proxySrc in EVERY test and silently change
// what the src-selection tests assert. Report the proxy codec as playable so
// tests exercise the supported path by default; the unsupported path is
// covered explicitly via __setProxySupportForTests in proxySupport.test.ts.
const realCanPlayType = HTMLMediaElement.prototype.canPlayType
HTMLMediaElement.prototype.canPlayType = function (type: string) {
  if (type.includes('av01')) return 'probably'
  return realCanPlayType.call(this, type)
}
