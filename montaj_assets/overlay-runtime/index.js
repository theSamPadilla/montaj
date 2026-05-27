import * as React                       from 'react'
import { interpolate, spring }          from './helpers.js'
import { makeUseThreeFrame }            from './three-bridge.js'
import { makeCanvas }                   from './canvas-wrapper.js'
import { Ph, FaSolid, FaBrands, FaIcon } from './icons.js'
import * as THREE                       from 'three'
import {
  BarChart, Bar,
  LineChart, Line,
  PieChart, Pie,
  Cell,
  XAxis, YAxis,
  CartesianGrid,
  Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts'

// Named exports — allow consumers to import individual primitives directly,
// e.g. `import { interpolate } from 'montaj-overlay-runtime'`. Used by render's
// core/index.js to preserve the existing `import { interpolate, spring,
// useThreeFrame } from 'montaj/render'` API for overlay JSX written before this
// refactor. The render-context useThreeFrame is the default named export here
// because that's what existing overlay JSX expects.
export { interpolate, spring }
export const useThreeFrame = makeUseThreeFrame('render')
export const Canvas        = makeCanvas('render')
export { Ph, FaSolid, FaBrands, FaIcon, THREE }
export { makeUseThreeFrame, makeCanvas }
export {
  BarChart, Bar,
  LineChart, Line,
  PieChart, Pie,
  Cell,
  XAxis, YAxis,
  CartesianGrid,
  Tooltip, Legend,
  ResponsiveContainer,
}

/**
 * Returns the full set of globals to inject into the overlay JSX evaluation
 * context. Both render's bundle.js shim and ui's overlay-eval.ts call this.
 *
 * @param {'render' | 'preview'} context
 * @returns {Record<string, unknown>} keyed by the global name as it appears
 *   inside overlay JSX (e.g. 'Canvas', 'THREE', 'interpolate').
 */
export function makeOverlayGlobals(context) {
  if (context !== 'render' && context !== 'preview') {
    throw new Error(`makeOverlayGlobals: unknown context ${context}`)
  }
  // Fail-fast guard: r3f's reconciler bindings are React-version-specific. If
  // either consumer ever bumps to React 19 without us updating r3f, downstream
  // failures are obscure ("Cannot read property ... of undefined"); catching it
  // here gives a clear actionable error.
  if (!React.version?.startsWith('18.')) {
    throw new Error(
      `montaj-overlay-runtime: requires React 18.x, got ${React.version}. ` +
      `Upgrade @react-three/fiber and revisit r3f compatibility before bumping React.`,
    )
  }
  return {
    interpolate,
    spring,
    useThreeFrame: makeUseThreeFrame(context),
    Canvas:        makeCanvas(context),
    THREE,
    Ph,
    FaIcon,
    FaSolid,
    FaBrands,
    // Charts (SVG, Recharts). Context-invariant: same components for render and preview.
    BarChart, Bar,
    LineChart, Line,
    PieChart, Pie,
    Cell,
    XAxis, YAxis,
    CartesianGrid,
    Tooltip, Legend,
    ResponsiveContainer,
  }
}
