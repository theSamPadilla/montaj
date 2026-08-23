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
})
