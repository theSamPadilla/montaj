import { Child } from './b.js'

export { Child }

// Reads the bare `frame` inside the function body, never at the top level.
export function helperLabel() {
  return `helper:${frame}`
}
