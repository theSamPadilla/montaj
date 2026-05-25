import { useLayoutEffect } from 'react'
import { useThree } from '@react-three/fiber'

/**
 * Returns a `useThreeFrame()` hook configured for the given context.
 *
 *   - 'render':  registers window.__renderThree, a synchronous trigger the
 *                Puppeteer shim calls inside __setFrame to draw the WebGL
 *                buffer before screenshot. gl.finish() blocks until the GPU
 *                has flushed.
 *   - 'preview': no-op. The preview-context Canvas wrapper forces
 *                frameloop="always", so r3f's internal RAF loop handles the
 *                drawing. Authors still call useThreeFrame() (it's mandated by
 *                the skill) but in preview it just returns without doing
 *                anything.
 */
export function makeUseThreeFrame(context) {
  if (context === 'render') {
    return function useThreeFrame() {
      const gl     = useThree(s => s.gl)
      const scene  = useThree(s => s.scene)
      const camera = useThree(s => s.camera)
      useLayoutEffect(() => {
        const rawGL = gl.getContext()
        window.__renderThree = () => {
          gl.render(scene, camera)
          rawGL.finish()
        }
        return () => { delete window.__renderThree }
      }, [gl, scene, camera])
    }
  }
  if (context === 'preview') {
    return function useThreeFrame() { /* no-op — r3f's RAF handles drawing */ }
  }
  throw new Error(`makeUseThreeFrame: unknown context ${context}`)
}
