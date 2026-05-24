import type { CarouselAspect } from '@/lib/types/carousel'

/** Tiny SVG rectangles that convey landscape / portrait / square orientation. */
export function AspectRatioIcon({ ratio, className }: { ratio: string; className?: string }) {
  const size = 16
  let w: number, h: number
  switch (ratio) {
    case '9:16': w = 9; h = 14; break
    case '1:1':  w = 12; h = 12; break
    case '16:9':
    default:     w = 14; h = 9; break
  }
  const x = (size - w) / 2
  const y = (size - h) / 2
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={className}>
      <rect x={x} y={y} width={w} height={h} rx={1.5} fill="currentColor" />
    </svg>
  )
}

/** SVG rectangles proportioned to carousel aspect ratios. */
export function CarouselAspectIcon({ aspect, className }: { aspect: CarouselAspect; className?: string }) {
  // All icons fit within a 16x16 viewbox.
  let w: number, h: number
  switch (aspect) {
    case 'square':   w = 12; h = 12; break
    case 'portrait': w = 12; h = 15; break
    case 'vertical': w = 9;  h = 16; break
  }
  const x = (16 - w) / 2
  const y = (16 - h) / 2
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" className={className}>
      <rect x={x} y={y} width={w} height={h} rx={1.5} fill="currentColor" />
    </svg>
  )
}
