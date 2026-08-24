import { describe, it, expect } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { CaptionEvent, Captions } from '@bycrux/editor'
import { CaptionJobProvider, useCaptionJob, type CaptionJobApi } from '@/app/editor/captionJob'
import CaptionActivityIndicator from '../CaptionActivityIndicator'

// Drives the REAL CaptionJobProvider rather than mocking useCaptionJob, so
// this test proves the indicator is actually wired to the job state (not
// just that it renders correctly given hand-fed props) — same call
// captionJob.test.tsx makes, whose fake-stream helpers and act()/waitFor()
// style this borrows (start() fires an internal async loop, so its effects
// land across microtask ticks rather than synchronously within act()).

const CAPTIONS: Captions = { style: 'pop', segments: [{ start: 0, end: 1, text: 'hi', words: [] }] }

function arrayStream(events: CaptionEvent[]): () => AsyncIterable<CaptionEvent> {
  return () => (async function* () {
    for (const ev of events) yield ev
  })()
}

/** Renders the indicator under a live provider and hands back `start`/
 *  `cancel`/`dismiss`, captured from a sibling that calls `useCaptionJob()`.
 *  Those three are stable across renders (captionJob.tsx's `useCallback([])`
 *  deps), so capturing them once at mount is safe. `start` only kicks off
 *  the job — callers still need `waitFor` to observe its async effects. */
function renderIndicator(props: { compact?: boolean } = {}) {
  let api: CaptionJobApi | undefined

  function Harness() {
    api = useCaptionJob()
    return null
  }

  const utils = render(
    <CaptionJobProvider>
      <Harness />
      <CaptionActivityIndicator {...props} />
    </CaptionJobProvider>,
  )

  return {
    ...utils,
    start: (...args: Parameters<CaptionJobApi['start']>) => act(() => { api!.start(...args) }),
    cancel: () => act(() => { api!.cancel() }),
    dismiss: () => act(() => { api!.dismiss() }),
  }
}

describe('CaptionActivityIndicator', () => {
  it('renders nothing while idle', () => {
    const { container } = renderIndicator()
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the spinner, "Generating captions", and the latest log line while running', async () => {
    const { start } = renderIndicator()

    start('proj-1', arrayStream([
      { type: 'log', message: '[mix_timeline] building mix spec' },
      { type: 'log', message: '[transcribe] loading model' },
    ]))

    await waitFor(() => expect(screen.getByText('Generating captions')).toBeInTheDocument())
    // Only the latest line is shown, mapped through the phase-label table —
    // not the raw "[transcribe] loading model".
    await waitFor(() => expect(screen.getByText('· Transcribing: loading model')).toBeInTheDocument())
    expect(screen.queryByText(/mix_timeline/)).not.toBeInTheDocument()
  })

  it('falls back to just the phase name for a raw JSON progress line', async () => {
    const { start } = renderIndicator()

    start('proj-1', arrayStream([
      { type: 'log', message: '[transcribe] {"progress": "42%"}' },
    ]))

    await waitFor(() => expect(screen.getByText('· Transcribing…')).toBeInTheDocument())
    expect(screen.queryByText(/progress/)).not.toBeInTheDocument()
  })

  it('shows the error message and a dismiss control on error', async () => {
    const { start } = renderIndicator()

    start('proj-1', arrayStream([{ type: 'error', message: 'multi_source' }]))

    await waitFor(() => expect(screen.getByText('multi_source')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Dismiss caption error' })).toBeInTheDocument()
  })

  it('Cancel calls cancel() and returns the readout to idle (renders null)', async () => {
    // Parked forever after one log line — a real job would keep streaming;
    // this test drives the rest via cancel() rather than a terminal event.
    const stream = (async function* () {
      yield { type: 'log', message: '[mix_timeline] working' } as CaptionEvent
      await new Promise(() => {})
    })()

    const { start, cancel, container } = renderIndicator()
    start('proj-1', () => stream)
    await waitFor(() => expect(screen.getByText('Generating captions')).toBeInTheDocument())

    cancel()
    expect(container).toBeEmptyDOMElement()
  })

  it('dismiss calls dismiss() and clears a terminal error back to idle', async () => {
    const { start, dismiss, container } = renderIndicator()

    start('proj-1', arrayStream([{ type: 'error', message: 'boom' }]))
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())

    dismiss()
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing once the job reaches done', async () => {
    const { start, container } = renderIndicator()

    start('proj-1', arrayStream([{ type: 'done', captions: CAPTIONS }]))

    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('compact mode drops the log line and shortens the running label', async () => {
    const { start } = renderIndicator({ compact: true })

    start('proj-1', arrayStream([{ type: 'log', message: '[mix_timeline] working' }]))

    await waitFor(() => expect(screen.getByText('Captions')).toBeInTheDocument())
    expect(screen.queryByText(/Mixing audio/)).not.toBeInTheDocument()
  })

  it('gives Cancel a real accessible name', async () => {
    const { start } = renderIndicator()
    start('proj-1', arrayStream([{ type: 'log', message: 'starting' }]))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel caption generation' })).toBeInTheDocument()
    })
  })
})
