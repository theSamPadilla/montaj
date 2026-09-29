// Module-level bindings with the same names as the wrapper's globals. esbuild
// must rename these, not the free `frame`/`THREE` other modules read.
const frame = 'module-frame'
const THREE = 'module-three'

export function shadowed() {
  return `${frame}/${THREE}`
}
