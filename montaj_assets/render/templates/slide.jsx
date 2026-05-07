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
          const { x = 0, y = 0, w = width, h = height, rotation = 0 } = element
          return (
            <img
              key={element.id}
              src={resolveAsset(element.src)}
              style={{
                position:        'absolute',
                left:            x,
                top:             y,
                width:           w,
                height:          h,
                transform:       `rotate(${rotation}deg)`,
                transformOrigin: 'center center',
                objectFit:       'cover',
              }}
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
              <OverlayComponent
                {...mergedProps}
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
