// springStep is a preview global, but render's montaj/render (core/index.js)
// does not export it, so this import fails in render and must fail here too.
import { springStep } from 'montaj/render'

export default function MissingExport() {
  return <div>{springStep(frame, 0, 1)}</div>
}
