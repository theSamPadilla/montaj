// The media box of a clip's <img>, <video> or <canvas> in the preview: the
// element above the blur's two wrappers (itemBlur.tsx `BlurWrappers`, always
// rendered, `display: contents` without a linear blur).
export function mediaBoxOf(el: Element): HTMLElement {
  const turn = el.closest('[data-montaj-blur-turn]')
  if (!turn?.parentElement) throw new Error('mediaBoxOf: not inside a media box')
  return turn.parentElement
}
