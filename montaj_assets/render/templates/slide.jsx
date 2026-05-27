/**
 * slide.jsx — React component that renders one carousel slide.
 *
 * Props:
 *   slide           — the slide object from project.json
 *   width           — canvas width in pixels
 *   height          — canvas height in pixels
 *   overlayRegistry — { [templatePath]: ReactComponent }
 *   resolveAsset    — function(relPath) => URL string (converts relative paths to file://)
 */

// Per-overlay host. Sets `window.props` to THIS overlay's merged props
// IMMEDIATELY before rendering the overlay component, then renders the
// component. The video renderer (montaj_assets/render/bundle.js) does the
// same thing per-segment so the skill-documented bare-`props` pattern
// (`function Foo() { return props.title }`) works. We do it per-overlay
// here because a slide can host multiple overlay elements.
//
// React rendering is synchronous for the Puppeteer path: when React mounts
// `OverlayHost`, this function body runs (setting window.props), returns a
// ReactElement for `Component`, and React then renders `Component` whose
// body reads `window.props`. The next overlay's `OverlayHost` doesn't run
// until the previous one has finished mounting, so per-overlay isolation
// holds even with multiple overlays on a single slide.
function OverlayHost({ Component, mergedProps, frame, fps, duration }) {
  if (typeof window !== 'undefined') {
    window.props    = mergedProps
    window.frame    = frame
    window.fps      = fps
    window.duration = duration
  }
  return <Component {...mergedProps} frame={frame} fps={fps} duration={duration} />
}

export function Slide({ slide, width, height, overlayRegistry, resolveAsset }) {
  const elements = slide.elements ?? []

  return (
    <div style={{
      position:        'relative',
      width:           width,
      height:          height,
      backgroundColor: slide.base_color ?? '#ffffff',
      overflow:        'hidden',
    }}>
      {elements.map((element) => {
        if (element.type === 'image') {
          const { x = 0, y = 0, w = width, h = height, rotation = 0, crop } = element
          const baseStyle = {
            position:        'absolute',
            left:            x,
            top:             y,
            width:           w,
            height:          h,
            transform:       `rotate(${rotation}deg)`,
            transformOrigin: 'center center',
          }

          if (crop) {
            const { x: cx, y: cy, w: cw, h: ch } = crop
            return (
              <div key={element.id} style={{ ...baseStyle, overflow: 'hidden' }}>
                <img
                  src={resolveAsset(element.src)}
                  style={{
                    display:    'block',
                    width:      `${100 / cw}%`,
                    height:     `${100 / ch}%`,
                    marginLeft: `${-cx * 100 / cw}%`,
                    marginTop:  `${-cy * 100 / ch}%`,
                    objectFit:  'cover',
                  }}
                />
              </div>
            )
          }

          return (
            <img
              key={element.id}
              src={resolveAsset(element.src)}
              style={{ ...baseStyle, objectFit: 'contain' }}
            />
          )
        }

        if (element.type === 'overlay') {
          const { x = 0, y = 0, w = width, h = height, rotation = 0 } = element
          const templatePath = element.overlay?.template
          const OverlayComponent = templatePath ? overlayRegistry[templatePath] : null

          if (!OverlayComponent) return null

          const frame    = element.frame ?? 0
          const fps      = 30
          const duration = element.overlay?.props?.duration ?? 60

          // Slide-side coords win; force identity on overlay's own positioning props
          const mergedProps = {
            ...element.overlay?.props,
            offsetX: 0,
            offsetY: 0,
            scale:   1,
            // Box dimensions in design-canvas px. Chart overlays use these to size their
            // Recharts root explicitly, avoiding ResponsiveContainer + ResizeObserver
            // racing the Puppeteer screenshot.
            boxWidth:  w,
            boxHeight: h,
          }

          return (
            <div
              key={element.id}
              style={{
                position:        'absolute',
                left:            x,
                top:             y,
                width:           w,
                height:          h,
                transform:       `rotate(${rotation}deg)`,
                transformOrigin: 'center center',
                overflow:        'hidden',
              }}
            >
              <OverlayHost
                Component={OverlayComponent}
                mergedProps={mergedProps}
                frame={frame}
                fps={fps}
                duration={duration}
              />
            </div>
          )
        }

        return null
      })}
    </div>
  )
}
