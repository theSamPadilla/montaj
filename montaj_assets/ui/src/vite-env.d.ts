/// <reference types="vite/client" />

declare const __APP_VERSION__: string

declare module 'montaj-overlay-runtime' {
  import type { ComponentType, FunctionComponent } from 'react'

  export function makeOverlayGlobals(context: 'render' | 'preview'): Record<string, unknown>

  export function interpolate(
    frame: number,
    inputRange: number[],
    outputRange: number[],
    options?: {
      extrapolate?: 'clamp' | 'extend'
      extrapolateLeft?: 'clamp' | 'extend'
      extrapolateRight?: 'clamp' | 'extend'
    },
  ): number

  export function spring(opts: {
    frame: number
    fps: number
    mass?: number
    stiffness?: number
    damping?: number
    initialVelocity?: number
  }): number

  // Icon namespaces — Phosphor and FontAwesome icon objects.
  export const Ph: Record<string, ComponentType<unknown>>
  export const FaSolid: Record<string, unknown>
  export const FaBrands: Record<string, unknown>
  export const FaIcon: ComponentType<{ icon: unknown; [key: string]: unknown }>

  // THREE is the full namespace from `three` — too large to enumerate; declare
  // as `any` so authors can use `THREE.Vector3`, `THREE.MathUtils`, etc. without
  // import friction. Authors needing precise types should `import * as THREE
  // from 'three'` directly (but overlay JSX can't import — globals only).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const THREE: any

  // Hook returns void — registers a side-effect (window.__renderThree in render
  // context) or no-ops (preview context). Not a value-returning hook.
  export function makeUseThreeFrame(context: 'render' | 'preview'): () => void
  export const useThreeFrame: () => void

  // Canvas is a React component. r3f's actual Canvas is a forwardRef object;
  // ComponentType<any> matches both the forwardRef case and the preview-context
  // function component wrapper.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function makeCanvas(context: 'render' | 'preview'): ComponentType<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Canvas: ComponentType<any>
}
