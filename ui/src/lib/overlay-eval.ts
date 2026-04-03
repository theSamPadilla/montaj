/**
 * In-browser JSX overlay evaluator.
 *
 * Fetches a custom overlay JSX file, transpiles it with @babel/standalone,
 * and returns a factory function that accepts the runtime globals
 * (frame, fps, duration, props, interpolate, spring) and returns a React element.
 *
 * The factory re-runs the entire module body on each call so module-level
 * computations (e.g. `const opacity = interpolate(frame, ...)`) pick up the
 * current frame — mirroring how the render engine takes a fresh Puppeteer
 * screenshot per frame.
 *
 * Limitation: overlays must not use React hooks (useState, useEffect, etc.)
 * because the component function is called directly, not through React's reconciler.
 */

import React from 'react'
import * as Ph from '@phosphor-icons/react'
import { FontAwesomeIcon as FaIcon } from '@fortawesome/react-fontawesome'
import * as FaSolid from '@fortawesome/free-solid-svg-icons'
import * as FaBrands from '@fortawesome/free-brands-svg-icons'
import { interpolate } from './interpolate'
import { spring } from './spring'

export type OverlayFactory = (
  frame: number,
  fps: number,
  durationFrames: number,
  props: Record<string, unknown>,
) => React.ReactElement | null

// Per-src cache so we compile each file only once.
const cache = new Map<string, OverlayFactory>()

export function clearOverlayCache(src: string) {
  cache.delete(src)
}

// Lazy Babel load — only pulled in when a custom overlay is first encountered.
let babelPromise: Promise<{ transform: (code: string, opts: object) => { code: string } }> | null = null

function getBabel() {
  if (!babelPromise) {
    babelPromise = import('@babel/standalone').then((mod) => (mod as any).default ?? mod)
  }
  return babelPromise
}

export async function compileOverlay(src: string): Promise<OverlayFactory> {
  if (cache.has(src)) return cache.get(src)!

  const fetchUrl = src.startsWith('/api/') ? src : `/api/files?path=${encodeURIComponent(src)}`
  const [jsxText, Babel] = await Promise.all([
    fetch(fetchUrl, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`Could not load overlay: ${src}`)
      return r.text()
    }),
    getBabel(),
  ])

  const { code } = Babel.transform(jsxText, {
    presets: ['react'],
    filename: 'overlay.jsx',
  })

  // Strip any import statements — globals are injected via function params instead.
  const stripped = code.replace(/^\s*import\s[^;]+;?\s*$/gm, '').trim()

  // Rewrite `export default function Foo` / `export default Foo` → `var __Component`
  const normalized = stripped
    .replace(/export\s+default\s+function\s+(\w+)/, 'var __Component = function $1')
    .replace(/export\s+default\s+/, 'var __Component = ')

  // Rewrite hardcoded absolute local file paths (e.g. /Users/Sam/…, /home/…) so the
  // browser fetches them through the /api/files proxy instead of failing with a 404.
  const proxied = normalized.replace(
    /(['"`])(\/(?:Users|home|private|tmp|var)\/[^'"`\s]+)\1/g,
    (_m, q, p) => `${q}/api/files?path=${encodeURIComponent(p)}${q}`,
  )

  // The factory runs the full module body with the given frame/globals in scope.
  // Module-level vars (like `const opacity = interpolate(frame, ...)`) recompute
  // on every call because they're inside this function, not at true module scope.
  // The component is then called directly to get the React element tree.
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'React',
    'frame',
    'fps',
    'duration',
    'props',
    'interpolate',
    'spring',
    'Ph',
    'FaIcon',
    'FaSolid',
    'FaBrands',
    `"use strict";
${proxied}
if (typeof __Component !== 'function') return null;
// Merge runtime globals + props so both calling conventions work:
//   - Caption templates destructure { frame, fps, segments, ... } from props
//   - Custom overlays use frame/fps as closure vars and ignore the argument
return __Component({ frame, fps, duration, ...props });`,
  )

  const factory: OverlayFactory = (frame, fps, durationFrames, overlayProps) => {
    try {
      return fn(React, frame, fps, durationFrames, overlayProps ?? {}, interpolate, spring, Ph, FaIcon, FaSolid, FaBrands) as React.ReactElement | null
    } catch (err) {
      console.warn(`[overlay-eval] ${src.split('/').pop()}:`, err)
      return null
    }
  }

  cache.set(src, factory)
  return factory
}
