import type { CSSProperties } from 'react'

/**
 * The preview frame: exactly W:H, as large as fits its parent, centred. The
 * `object-fit: contain` of a box.
 *
 * It used to be `h-full max-w-full` plus `aspect-ratio`. The height is fixed at
 * 100%, so the aspect ratio derives the width from it; when that width is wider
 * than the parent, `max-w-full` clamps the width while the height stays 100%,
 * and the box silently stops being W:H. A landscape project in a preview area
 * narrower than 16:9 (the editor with its side panels open) hit it every time:
 * the engine's canvas fills its box, so the picture played squashed, and the
 * overlays, which scale by the box's width, drifted off the picture. The
 * `<video>` path hid it, since `object-fit: contain` letterboxes inside the
 * wrong box. Portrait projects never showed it, because there the height is
 * what runs out.
 *
 * Container query units do the fit: the parent is a size container, and the box
 * takes the smaller of the parent's full width and the width its full height
 * allows. Both resolve against the parent's content box, so its padding stays.
 */
export const FIT_PARENT_STYLE: CSSProperties = {
  containerType: 'size',
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

/** The box's own size: W:H, contain-fitted to the nearest size container. */
export function fitBoxStyle(w: number, h: number): CSSProperties {
  return {
    aspectRatio: `${w} / ${h}`,
    width: `min(100cqw, calc(100cqh * ${w} / ${h}))`,
  }
}
