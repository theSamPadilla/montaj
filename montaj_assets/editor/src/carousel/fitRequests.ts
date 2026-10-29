// A write to a hugging pill that changes its size asks the canvas showing it
// to store the box its pill measures, so the prop and the box are one undo
// step: the host applies the prop as a preview, asks here, and commits after.

type Handler = (slideId: string, elementId: string) => Promise<void> | void

const handlers = new Set<Handler>()

/** A canvas listens for requests for its slide's elements. Returns the unlisten. */
export function onFitRequest(handler: Handler): () => void {
  handlers.add(handler)
  return () => { handlers.delete(handler) }
}

/** How long a request waits for a canvas to look; none showing it means the write stands as it is. */
const WAIT_MS = 400

/** Asks the canvas showing `elementId` to store its fitted box; resolves when it has looked. */
export async function requestFit(slideId: string, elementId: string): Promise<void> {
  const asked = [...handlers].map((h) => h(slideId, elementId)).filter((p): p is Promise<void> => !!p)
  if (!asked.length) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([Promise.all(asked), new Promise<void>((res) => { timer = setTimeout(res, WAIT_MS) })])
  clearTimeout(timer)
}
