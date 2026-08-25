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

// Lazy overlay-runtime load — the runtime (three.js, @react-three/fiber, etc.) is only
// pulled in when a custom overlay is first compiled, mirroring the Babel deferral below.
let globalsPromise: Promise<Record<string, unknown>> | null = null

function getOverlayGlobals(): Promise<Record<string, unknown>> {
  if (!globalsPromise) {
    globalsPromise = import('montaj-overlay-runtime').then((m) => m.makeOverlayGlobals('preview'))
  }
  return globalsPromise
}

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

  // `src` must be an already-servable path — an absolute filesystem path (what
  // the pipeline writes: project/init.py stores os.path.abspath, so every real
  // overlay/image/video item carries an absolute src) or an `/api/...` URL. It
  // is handed straight to /api/files, whose GET resolves a relative path against
  // the SERVER cwd (the workspace root), not the project dir — so a
  // project-relative form like `./overlays/x.jsx` 404s here even though render,
  // which runs in the project dir, resolves it fine. The preview has no project
  // context at this call site (compileOverlay/fileUrl are host-agnostic and take
  // an absolute path by contract), so it cannot resolve relative srcs. The
  // schema's `./…` examples describe location, not a literal preview-fetchable
  // value; author overlay `src` as an absolute path (or teach the host to
  // resolve project-relative srcs before they reach here).
  const fetchUrl = src.startsWith('/api/') ? src : `/api/files?path=${encodeURIComponent(src)}`
  const [jsxText, Babel, overlayGlobals] = await Promise.all([
    fetch(fetchUrl, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`Could not load overlay: ${src}`)
      return r.text()
    }),
    getBabel(),
    getOverlayGlobals(),
  ])
  const globalNames  = Object.keys(overlayGlobals)
  const globalValues = Object.values(overlayGlobals)

  const { code } = Babel.transform(jsxText, {
    presets: ['react'],
    filename: 'overlay.jsx',
  })

  // Strip any import statements — globals are injected via function params instead.
  const stripped = code.replace(/^\s*import\s[^;]+;?\s*$/gm, '').trim()

  // Rewrite `export default function Foo` / `export default Foo` → `var __Component`.
  // Also strip the `export` keyword from named exports (`export const X`, `export function X`,
  // `export { X, Y }`) — the function body can't host ESM, and the values themselves are
  // ignored unless they're assigned to __Component. This makes the compiler tolerant of the
  // full export syntax authors actually write per skills/write-overlay.
  const normalized = stripped
    .replace(/export\s+default\s+function\s+(\w+)/, 'var __Component = function $1')
    .replace(/export\s+default\s+/, 'var __Component = ')
    .replace(/^\s*export\s+(?=(?:const|let|var|function|class|async\s))/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '')

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
    ...globalNames,
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
      return fn(React, frame, fps, durationFrames, overlayProps ?? {}, ...globalValues) as React.ReactElement | null
    } catch (err) {
      console.warn(`[overlay-eval] ${src.split('/').pop()}:`, err)
      return null
    }
  }

  cache.set(src, factory)
  return factory
}
