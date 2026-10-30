import { useState } from 'react'
import { sourceCropImageStyle } from './sourceCropStyle'

type Crop = { x: number; y: number; w: number; h: number }

/**
 * An image clip's media, cropped (PV55): see `sourceCropImageStyle`. With no
 * crop (or the full frame) it renders the exact <img> it replaced, so an
 * uncropped image's DOM is unchanged. The natural size comes from the loaded
 * <img>, EXIF orientation applied, as ffmpeg's decode applies it.
 *
 * Loaded with anonymous CORS, as the video slots are: a spin or zoom blur
 * reads the <img> into WebGL (radialBlurGL.ts), which refuses a cross-origin
 * picture without CORS (a hosted image on R2, which sends
 * Access-Control-Allow-Origin, would otherwise show unblurred, 'blocked').
 */
export default function CroppedImage({ src, crop, fit, boxWidth, boxHeight }: {
  src: string
  crop: Crop | undefined
  fit: 'cover' | 'contain' | 'fill'
  boxWidth: number
  boxHeight: number
}) {
  const [natural, setNatural] = useState<{ src: string; w: number; h: number } | null>(null)
  const size = natural?.src === src ? natural : null
  const style = crop
    ? sourceCropImageStyle({ crop, sourceWidth: size?.w ?? 0, sourceHeight: size?.h ?? 0, boxWidth, boxHeight, fit })
    : null
  if (!style) {
    return <img src={src} crossOrigin="anonymous" draggable={false} className="absolute inset-0 w-full h-full pointer-events-none" style={{ objectFit: fit }} />
  }
  const record = (el: HTMLImageElement) => {
    if (el.naturalWidth > 0 && el.naturalHeight > 0 && (size?.w !== el.naturalWidth || size?.h !== el.naturalHeight)) {
      setNatural({ src, w: el.naturalWidth, h: el.naturalHeight })
    }
  }
  return (
    <div className="pointer-events-none" style={style.clip}>
      <img
        src={src}
        crossOrigin="anonymous"
        draggable={false}
        // An already-cached image may be complete before React attaches onLoad.
        ref={(el) => { if (el?.complete) record(el) }}
        onLoad={(e) => record(e.currentTarget)}
        className="pointer-events-none"
        style={{ ...style.img, visibility: style.ready ? undefined : 'hidden' }}
      />
    </div>
  )
}
