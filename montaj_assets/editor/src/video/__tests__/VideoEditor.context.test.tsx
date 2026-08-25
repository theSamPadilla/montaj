/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest'
import src from '../VideoEditor.tsx?raw'

/**
 * A source-level assertion rather than a render test: VideoEditor mounts the
 * whole editor (engine, canvas timeline, workers) and is not cheaply
 * renderable in jsdom. What matters here is only that the reporter is wired
 * to the real clock and the real selection state — which the source shows
 * directly, and which is exactly what a future refactor could silently break.
 */
describe('VideoEditor context reporting', () => {
  it('calls useReportContext', () => {
    expect(src).toMatch(/useReportContext\(/)
  })

  it('passes the real clock and both selection states', () => {
    const call = src.match(/useReportContext\(\{[\s\S]*?\}\)/)?.[0] ?? ''
    expect(call).toMatch(/clock/)
    expect(call).toMatch(/selectedIds/)
    expect(call).toMatch(/selectedCaptionId/)
    expect(call).toMatch(/adapter/)
  })

  // D1: captions share `selectedIds` with clips/audio now, so `selectedCaptionId`
  // must be DERIVED from that array rather than tracked as its own `useState` —
  // a second selection model is exactly the bug a future refactor could
  // reintroduce silently, since both compile and both satisfy the assertion
  // above.
  it('derives selectedCaptionId from selectedIds instead of its own useState', () => {
    expect(src).not.toMatch(/\[selectedCaptionId, setSelectedCaptionId\]/)
    const decl = src.match(/const selectedCaptionId = [^\n]+/)?.[0] ?? ''
    expect(decl).toMatch(/selectedIds\.find/)
  })

  // handleSelectCaption used to keep two selection models mutually exclusive
  // (set the caption id AND clear selectedIds). Under D1 there is one model,
  // so selecting a caption is just replacing selectedIds.
  it('handleSelectCaption sets selectedIds directly, not a separate caption state', () => {
    const fn = src.match(/const handleSelectCaption = useCallback\(\([\s\S]*?\}, \[\]\)/)?.[0] ?? ''
    expect(fn).toMatch(/setSelectedIds/)
    expect(fn).not.toMatch(/setSelectedCaptionId/)
  })
})
