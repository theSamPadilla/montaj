// The page `slide-chrome-clip.test.mjs` drives in a real browser (§586 M4).
//
// The real SlideCanvas, in the frame CarouselEditor.tsx gives it in the
// classic layout: the canvas column (`relative flex-1 flex flex-col min-h-0
// overflow-hidden`) under a toolbar row, its scroll area (`relative flex-1
// flex flex-col items-center justify-center gap-4 overflow-y-auto min-h-0
// p-4`), the ring box with the 40 px margin around the slide, and the hint
// line under it. The classes are written out as inline styles: the package
// ships no stylesheet. `?stack` puts two slides in it instead, from the top.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import SlideCanvas from '../../src/carousel/SlideCanvas'
import type { ImageElement, Slide } from '../../src/types'

const MARGIN = 40
const GAP = 16

const picture = (w: number, h: number, fill: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`,
  )}`

function image(id: string, box: Partial<ImageElement>): ImageElement {
  return { id, type: 'image', src: picture(400, 200, '#2a9d3a'), x: 0, y: 0, w: 400, h: 200, rotation: 0, ...box }
}

// 1080 x 1080 at half scale: the slide is 540 display px, the margin box 620.
// Each element reaches 60 to 70 display px past the margin, but `far`, which
// reaches past the bottom-right of the visible scroll area itself.
const slide: Slide = {
  id: 's',
  base_color: '#ffffff',
  elements: [
    image('left', { x: -200, y: 300 }),
    image('bottom', { x: 400, y: 1000, w: 200, h: 300 }),
    image('right', { x: 980, y: 300, w: 300, h: 200, locked: true }),
    image('far', { x: 1400, y: 1400, w: 800, h: 600 }),
  ],
}

type Call = { fn: string; args: unknown[] }
type State = { selected: string | null; crop: string | null }

declare global {
  interface Window {
    __calls: Call[]
    __set: (next: Partial<State>) => void
    __ready: boolean
  }
}

window.__calls = []
const record = (fn: string) => (...args: unknown[]) => {
  window.__calls.push({ fn, args })
  return Promise.resolve()
}

// `?stack`: two slides one under the other in a scroll area that scrolls, as a
// stack of slides does. The first one's `low` reaches 260 display px past its
// bottom edge, onto the second slide and its `under`.
const STACK = new URLSearchParams(location.search).has('stack')
const stacked: Slide[] = [
  { id: 's1', base_color: '#ffffff', elements: [image('low', { x: 300, y: 1000, w: 400, h: 600 })] },
  { id: 's2', base_color: '#eeeeee', elements: [image('under', { x: 0, y: 0, w: 1080, h: 1080 })] },
]

function Canvas({ slide, state, setState }: { slide: Slide; state: State; setState: (f: (s: State) => State) => void }) {
  const mine = slide.elements.some((e) => e.id === state.selected) ? state.selected : null
  return (
    <div data-slide={slide.id} style={{ flexShrink: 0, margin: MARGIN, marginBottom: MARGIN - GAP }}>
      <SlideCanvas
        slide={slide}
        width={1080}
        height={1080}
        interactive
        scale={0.5}
        margin={MARGIN}
        selectedElementId={mine}
        selectedElementIds={mine ? [mine] : []}
        onSelect={(id) => { window.__calls.push({ fn: 'onSelect', args: [slide.id, id] }); setState((s) => ({ ...s, selected: id })) }}
        onSelectMany={(ids) => { window.__calls.push({ fn: 'onSelectMany', args: [slide.id, ids] }) }}
        onToggleSelect={(id) => { window.__calls.push({ fn: 'onToggleSelect', args: [slide.id, id] }) }}
        resolveImageSrc={(el) => el.src}
        moveElement={record('moveElement')}
        resizeElement={record('resizeElement')}
        rotateElement={record('rotateElement')}
        updateImageCrop={record('updateImageCrop')}
        commit={record('commit')}
        cropElementId={mine ? state.crop : null}
        onExitCrop={() => setState((s) => ({ ...s, crop: null }))}
        onUnlock={(id) => { window.__calls.push({ fn: 'onUnlock', args: [id] }) }}
      />
    </div>
  )
}

function App() {
  const [state, setState] = useState<State>({ selected: null, crop: null })
  window.__set = (next) => setState((s) => ({ ...s, ...next }))
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', width: 1000, height: 1000 }}>
      <div data-testid="toolbar" style={{ flexShrink: 0, height: 56, borderBottom: '1px solid #ddd' }} />
      <div
        data-testid="scroll-area"
        style={{
          position: 'relative',
          flex: '1 1 0%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: STACK ? 'flex-start' : 'center',
          gap: GAP,
          overflowY: 'auto',
          minHeight: 0,
          padding: 16,
        }}
      >
        {(STACK ? stacked : [slide]).map((sl) => <Canvas key={sl.id} slide={sl} state={state} setState={setState} />)}
        <div style={{ flexShrink: 0, fontSize: 12 }}>Drag to reposition, resize/rotate via handles.</div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true }))
