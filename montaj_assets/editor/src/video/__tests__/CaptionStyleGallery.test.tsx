// CaptionStyleGallery.test.tsx
//
// Covers the five behaviours the Style-tab gallery owes its caller:
//   1. one card per style, each with a real accessible name
//   2. clicking a card commits `captions.style` through `onCaptionEdit`
//   3. the active style's card reads selected
//   4. hovering starts the frame advance; unhovering stops it and resets
//   5. a host with no `compileOverlay` degrades to the static specimen
//
// Two pieces of the environment are faked, both deliberately:
//
//   - `requestAnimationFrame` / `cancelAnimationFrame`. The card's loop is
//     driven off the rAF TIMESTAMP, so handing it chosen timestamps makes the
//     frame it computes exact and assertable, instead of racing real frames.
//     `cancelAnimationFrame` really removes the pending callback, which is what
//     lets the unhover half of test 4 mean anything.
//
//   - `compileOverlay`, which returns a factory that records every call AND
//     renders a node carrying the frame it was given. The DOM assertion is the
//     guard against a vacuous test: jsdom lays nothing out, so if the card had
//     copied CaptionPreview's `scale === null` gate it would render nothing at
//     all and a call-count-only assertion would pass while the gallery was
//     blank. See FALLBACK_CARD_W in CaptionStyleGallery.tsx.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Captions } from '../../schema'
import type { OverlayFactory, Project } from '../../types'
import CaptionStyleGallery, {
  CAPTION_STYLES,
  CAPTION_STYLE_LABELS,
  SAMPLE_SEGMENT,
} from '../CaptionStyleGallery'

// ── rAF harness ─────────────────────────────────────────────────────────────
let pendingFrames: Map<number, FrameRequestCallback>
let nextFrameId: number

/** Run every callback currently scheduled, at `now` ms. Callbacks that
 *  re-schedule (the card's loop does) repopulate the queue for the next call. */
function flushFrame(now: number) {
  const due = Array.from(pendingFrames.values())
  pendingFrames.clear()
  act(() => { due.forEach(cb => cb(now)) })
}

beforeEach(() => {
  pendingFrames = new Map()
  nextFrameId = 1
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    const id = nextFrameId++
    pendingFrames.set(id, cb)
    return id
  })
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id: number) => {
    pendingFrames.delete(id)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ── Fixtures ────────────────────────────────────────────────────────────────
interface RecordedCall {
  src: string
  frame: number
  fps: number
  totalFrames: number
  props: Record<string, unknown>
}

function makeProject(captions: Captions): Project {
  return { id: 'p1', captions } as unknown as Project
}

async function renderGallery(opts: {
  style?: Captions['style']
  extra?: Partial<Captions>
  withCompiler?: boolean
} = {}) {
  const { style = 'karaoke', extra = {}, withCompiler = true } = opts

  const calls: RecordedCall[] = []
  // One factory per template src, so a card's calls are attributable to it.
  // `resolveCaptionTemplate` is identity below, so src === style name.
  const compileOverlay = vi.fn(async (src: string): Promise<OverlayFactory> => {
    return (frame, fps, totalFrames, props) => {
      calls.push({ src, frame, fps, totalFrames, props })
      return <div data-testid={`live-${src}`} data-frame={String(frame)} />
    }
  })
  const resolveCaptionTemplate = vi.fn((s: string) => s)

  const captions: Captions = { style, segments: [], ...extra }
  const project = makeProject(captions)
  const onCaptionEdit = vi.fn()

  const view = render(
    <CaptionStyleGallery
      captions={captions}
      project={project}
      onCaptionEdit={onCaptionEdit}
      compileOverlay={withCompiler ? compileOverlay : undefined}
      resolveCaptionTemplate={withCompiler ? resolveCaptionTemplate : undefined}
    />,
  )

  // Let every card's compile resolve before any assertion, so no test races
  // the async setFactory (and none of them leak an un-acted state update).
  if (withCompiler) {
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid^="live-"]')).toHaveLength(CAPTION_STYLES.length)
    })
  }

  return { view, calls, compileOverlay, resolveCaptionTemplate, captions, project, onCaptionEdit }
}

const cardFor = (style: Captions['style']) =>
  screen.getByRole('button', { name: CAPTION_STYLE_LABELS[style] })

// ── Tests ───────────────────────────────────────────────────────────────────
describe('CaptionStyleGallery', () => {
  it('renders one labelled card per style', async () => {
    await renderGallery()

    expect(screen.getAllByRole('button')).toHaveLength(CAPTION_STYLES.length)
    for (const style of CAPTION_STYLES) {
      expect(cardFor(style)).toHaveAttribute('data-style', style)
    }
  })

  it('compiles every style template eagerly on mount, before any hover', async () => {
    const { compileOverlay } = await renderGallery()

    expect(compileOverlay).toHaveBeenCalledTimes(CAPTION_STYLES.length)
    const compiled = compileOverlay.mock.calls.map(c => c[0]).sort()
    expect(compiled).toEqual([...CAPTION_STYLES].sort())
  })

  it('feeds each template the synthetic sample and the track theme', async () => {
    const { calls } = await renderGallery({ extra: { color: '#ff0000', fontsize: 46 } })

    const popCall = calls.filter(c => c.src === 'pop')[0]
    expect(popCall.props.segments).toEqual([SAMPLE_SEGMENT])
    // Pin the sample's own shape too, not just that it round-trips: four
    // contiguous words, each clearing pop.jsx's `wordDuration > 6` (frames)
    // exit-fade guard at SAMPLE_FPS with room to spare.
    const sampleWords = SAMPLE_SEGMENT.words ?? []
    expect(SAMPLE_SEGMENT.text).toBe('The quick brown fox')
    expect(sampleWords.map(w => w.word)).toEqual(['The', 'quick', 'brown', 'fox'])
    expect(sampleWords.map(w => w.start)).toEqual([0, 0.65, 1.3, 1.95])
    expect(sampleWords.map(w => w.end)).toEqual([0.65, 1.3, 1.95, 2.6])
    for (const w of sampleWords) {
      expect((w.end - w.start) * 30).toBeGreaterThan(6)
    }
    expect(popCall.fps).toBe(30)
    // Track theme reaches the card...
    expect(popCall.props.color).toBe('#ff0000')
    // ...but the project's own font size does NOT: a card renders at a fixed,
    // legible size (see CARD_FONT_SIZE) because the frame is scaled to ~1/8.
    expect(popCall.props.fontSize).not.toBe(46)
    expect(popCall.props.fontSize).toBeGreaterThan(46)
  })

  it('commits captions.style when a card is clicked', async () => {
    const { onCaptionEdit, project } = await renderGallery({ style: 'karaoke' })

    fireEvent.click(cardFor('pop'))

    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0]).toEqual({
      ...project,
      captions: { ...project.captions, style: 'pop' },
    })
  })

  it('marks only the active style card as selected', async () => {
    await renderGallery({ style: 'outline' })

    expect(cardFor('outline')).toHaveAttribute('aria-pressed', 'true')
    for (const style of CAPTION_STYLES.filter(s => s !== 'outline')) {
      expect(cardFor(style)).toHaveAttribute('aria-pressed', 'false')
    }
  })

  it('advances the frame while hovered and stops on unhover', async () => {
    const { calls } = await renderGallery()

    // The still every card rests at before any pointer interaction.
    const posterFrame = calls.filter(c => c.src === 'pop')[0].frame
    expect(screen.getByTestId('live-pop')).toHaveAttribute('data-frame', String(posterFrame))
    expect(pendingFrames.size).toBe(0)

    const card = cardFor('pop')
    fireEvent.mouseEnter(card)
    calls.length = 0

    // Timestamps are chosen, not real: elapsed 0s / 0.4s / 0.9s at 30fps.
    flushFrame(1000)
    flushFrame(1400)
    flushFrame(1900)

    expect(calls.filter(c => c.src === 'pop').map(c => c.frame)).toEqual([0, 12, 27])
    // Not vacuous: the advancing frame reached the DOM, so the card really is
    // rendering the template rather than gating on an unmeasured scale.
    expect(screen.getByTestId('live-pop')).toHaveAttribute('data-frame', '27')
    // The loop is per-card, not per-gallery: an unhovered card stays put.
    expect(calls.filter(c => c.src === 'karaoke')).toHaveLength(0)

    fireEvent.mouseLeave(card)

    // The loop is torn down — nothing is left scheduled — and the card snaps
    // back to its poster frame rather than freezing mid-animation.
    expect(pendingFrames.size).toBe(0)
    expect(screen.getByTestId('live-pop')).toHaveAttribute('data-frame', String(posterFrame))

    calls.length = 0
    flushFrame(3000)
    expect(calls).toHaveLength(0)
  })

  it('tears the frame loop down on unmount, leaving nothing scheduled', async () => {
    const { view } = await renderGallery()

    fireEvent.mouseEnter(cardFor('pop'))
    flushFrame(1000)
    expect(pendingFrames.size).toBe(1)

    view.unmount()

    expect(pendingFrames.size).toBe(0)
  })

  it('falls back to the static specimen when the host has no compiler', async () => {
    await renderGallery({ withCompiler: false })

    expect(screen.getAllByTestId('caption-specimen')).toHaveLength(CAPTION_STYLES.length)
    expect(document.querySelectorAll('[data-testid^="live-"]')).toHaveLength(0)

    // The specimen shows the sample's own word (POSTER_FRAME lands on the
    // SECOND word, "quick" — see POSTER_FRAME in CaptionStyleGallery.tsx),
    // not an empty-state prompt.
    const outlineWord = within(cardFor('outline')).getByTestId('caption-specimen-word')
    expect(outlineWord).toHaveTextContent('quick')
    // ...and in THAT style's look: `outline` is the one style whose template
    // defaults to uppercase (captionStyleDefaults.ts), and CaptionSpecimen has
    // no fallback of its own for textTransform, so the `toHaveStyle` below
    // only holds because the card applies the per-style default. The word
    // itself is stored lower-case ("quick", not "QUICK") — `toHaveTextContent`
    // reads the raw DOM text node, unaffected by CSS, so the CASE assertion
    // above and the CSS `text-transform` assertion below are independent
    // checks, not one relying on the other.
    expect(outlineWord).toHaveStyle({ textTransform: 'uppercase' })
    expect(within(cardFor('pop')).getByTestId('caption-specimen-word'))
      .toHaveStyle({ letterSpacing: '-0.02em' })
  })

  it('commits captions.style from a fallback-mode card too', async () => {
    // Deliberately the same assertion as the live-mode click test above, run
    // against the compiler-less path. The click handler lives on the <button>
    // that wraps BOTH the live frame and the specimen fallback, so this holds
    // today — but nothing else in this file would catch a refactor that moved
    // it inside the live branch, and every live-mode test would stay green
    // while it happened.
    //
    // The fallback path IS the Hub / Los Parceros experience (neither host
    // supplies `compileOverlay`), so that regression would ship a gallery
    // where clicking a style does nothing on exactly the hosts nobody here
    // exercises by hand.
    const { onCaptionEdit, project } = await renderGallery({ style: 'karaoke', withCompiler: false })

    fireEvent.click(cardFor('pop'))

    expect(onCaptionEdit).toHaveBeenCalledTimes(1)
    expect(onCaptionEdit.mock.calls[0][0]).toEqual({
      ...project,
      captions: { ...project.captions, style: 'pop' },
    })
  })

  it('falls back to the static specimen for a card whose compile rejects, while the rest stay live', async () => {
    // A failed compile must not leave that one card permanently on the black
    // `aspect-ratio` band with `element === null` — it should degrade to the
    // same static specimen a no-compiler host gets, same as compileCached's
    // eviction-on-reject already does for the module cache.
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const compileOverlay = vi.fn(async (src: string): Promise<OverlayFactory> => {
      if (src === 'outline') throw new Error('template fetch failed')
      return (frame) => <div data-testid={`live-${src}`} data-frame={String(frame)} />
    })
    const resolveCaptionTemplate = vi.fn((s: string) => s)
    const captions: Captions = { style: 'karaoke', segments: [] }
    const project = makeProject(captions)

    render(
      <CaptionStyleGallery
        captions={captions}
        project={project}
        onCaptionEdit={vi.fn()}
        compileOverlay={compileOverlay}
        resolveCaptionTemplate={resolveCaptionTemplate}
      />,
    )

    // Six of the seven compiles resolve; `outline`'s rejects and never
    // produces a `live-outline` node.
    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid^="live-"]')).toHaveLength(CAPTION_STYLES.length - 1)
    })

    expect(screen.queryByTestId('live-outline')).not.toBeInTheDocument()
    // Not vacuous: the failed card actually renders the specimen fallback,
    // not just "no live node" (which an infinitely-pending compile would also
    // produce).
    expect(within(cardFor('outline')).getByTestId('caption-specimen')).toBeInTheDocument()

    for (const style of CAPTION_STYLES.filter(s => s !== 'outline')) {
      expect(within(cardFor(style)).getByTestId(`live-${style}`)).toBeInTheDocument()
    }
  })

  it('advances the frame on focus and stops on blur, mirroring hover', async () => {
    // Keyboard/touch/pen parity with the hover test above: the frame loop
    // must also run off focus/blur, not just mouseenter/mouseleave, or a
    // keyboard user tabbing through the grid never sees anything past the
    // poster frame.
    const { calls } = await renderGallery()

    const posterFrame = calls.filter(c => c.src === 'pop')[0].frame
    expect(screen.getByTestId('live-pop')).toHaveAttribute('data-frame', String(posterFrame))
    expect(pendingFrames.size).toBe(0)

    const card = cardFor('pop')
    fireEvent.focus(card)
    calls.length = 0

    // Same chosen timestamps as the hover test: elapsed 0s / 0.4s / 0.9s at 30fps.
    flushFrame(1000)
    flushFrame(1400)
    flushFrame(1900)

    expect(calls.filter(c => c.src === 'pop').map(c => c.frame)).toEqual([0, 12, 27])
    // Not vacuous: without the onFocus handler `hovered` never flips, so this
    // would still read the poster frame and the assertion above would fail.
    expect(screen.getByTestId('live-pop')).toHaveAttribute('data-frame', '27')
    expect(calls.filter(c => c.src === 'karaoke')).toHaveLength(0)

    fireEvent.blur(card)

    // Torn down on blur, same as mouseleave, and reset to the poster frame
    // rather than freezing mid-animation.
    expect(pendingFrames.size).toBe(0)
    expect(screen.getByTestId('live-pop')).toHaveAttribute('data-frame', String(posterFrame))

    calls.length = 0
    flushFrame(3000)
    expect(calls).toHaveLength(0)
  })
})
