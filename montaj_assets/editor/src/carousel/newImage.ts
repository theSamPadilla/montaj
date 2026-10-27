import type { EditorAdapter, ImageElement, Project } from '../types'
import { loadImageNaturalSize, placeImageBox, type ImageSize } from './imageGeometry'

/**
 * A new image element for the file at host path `src`, ready to add to a slide
 * (§556 M7): a box shaped like the image (`placeImageBox`), centred on `at` or
 * on the slide. The size is read through the adapter's own URL for `src`, as
 * Replace image reads it. When it cannot be read (the load fails or times out,
 * or the resolver throws) the box is the centred square images started in
 * before. Never rejects.
 */
export async function newImageElement(
  adapter: { resolveImageSrc(element: ImageElement): string },
  resolution: readonly [number, number],
  src: string,
  at?: { x: number; y: number },
): Promise<ImageElement> {
  const id = crypto.randomUUID()
  let size: ImageSize | null = null
  try {
    size = await loadImageNaturalSize(
      adapter.resolveImageSrc({ id, type: 'image', src, x: 0, y: 0, w: 0, h: 0, rotation: 0 }),
    )
  } catch {
    // A resolver that throws: the size cannot be read.
  }
  const { x, y, w, h } = placeImageBox(size, resolution, at)
  return { id, type: 'image', src, x, y, w, h, rotation: 0 }
}

/**
 * Generates an image from `prompt` through the adapter and shapes a new element
 * for it. Shared by the "+ AI Image" prompt and the AI image panel. Rejects with
 * the adapter's error; throws when the host has no `generateImage`.
 */
export async function generateImageElement(
  adapter: EditorAdapter<Project>,
  project: Pick<Project, 'id' | 'settings'>,
  prompt: string,
): Promise<ImageElement> {
  if (!adapter.generateImage) throw new Error('Image generation is not available')
  const result = await adapter.generateImage(prompt, project.id)
  return newImageElement(adapter, project.settings.resolution, result.path)
}
