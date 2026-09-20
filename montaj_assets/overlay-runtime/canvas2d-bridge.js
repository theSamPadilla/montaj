/**
 * Returns a `useCanvas2DFrame(draw, frame, fps, duration)` function configured
 * for the given context.
 *
 * Unlike `useThreeFrame`, there is NO behavioral split between 'render' and
 * 'preview' here. r3f owns an internal requestAnimationFrame loop that has to
 * be disabled in render (`frameloop="never"`) and left running in preview so
 * something still redraws the scene — a plain 2D canvas has no internal loop
 * to reconcile against. Both contexts return the identical implementation
 * below. `context` is still accepted and validated so this factory has the
 * same shape as `makeUseThreeFrame`/`makeCanvas`, and so a future
 * context-specific need (if one ever arises) has an obvious place to land.
 *
 * Returns a REF CALLBACK, not an object ref + `useLayoutEffect` (the pattern
 * `useThreeFrame` uses internally). That's a deliberate difference, not a
 * style choice: overlay JSX's default export is invoked two different ways
 * depending on context —
 *
 *   - 'render' (montaj_assets/render/bundle.js's shim): mounted as a REAL
 *     React element, `<Component frame={frame} .../>`, via createRoot(...).
 *   - 'preview' (montaj_assets/ui/src/lib/overlay-eval.ts's compiled
 *     factory): called directly as a plain function, `__Component({...})`,
 *     OUTSIDE any component's fiber. overlay-eval.ts's own file comment
 *     spells this out: overlays must not use React hooks (useState,
 *     useEffect, etc.) "because the component function is called directly,
 *     not through React's reconciler."
 *
 * `useThreeFrame` sidesteps that the same way Three overlays are required
 * to: skills/write-overlay/SKILL.md mandates mounting `useThreeFrame()` in a
 * nested `<FrameBridge />` child of `<Canvas>` rather than at the top level
 * of the default export — the hook only ever runs inside a component that IS
 * mounted by a real reconciler (r3f's own, for `<Canvas>`'s children). A 2D
 * canvas has no such library-owned child-component convention to lean on, so
 * `useCanvas2DFrame` avoids needing one a different way: a callback ref is
 * attached by React's normal commit-phase ref handling for the HOST
 * `<canvas>` element itself, which is always a real, independently-tracked
 * fiber — regardless of how the function that RETURNED that element was
 * invoked. It costs no hook slot on the calling function, so it's safe to
 * call directly at the top level of an overlay's default export in both
 * contexts, matching the shape authors already expect from `interpolate`/
 * `spring`.
 *
 * `draw` runs synchronously inside the ref callback, which React invokes
 * during a commit's mutation/layout phase — i.e. before `flushSync` returns
 * in render's `__setFrame` (see bundle.js), so the drawn pixels are
 * guaranteed present before Puppeteer's next `data-rendered-frame` check and
 * screenshot. No `window.__render*` trigger is needed the way `useThreeFrame`
 * needs `window.__renderThree`, because there is no separate library-owned
 * draw call to invoke after commit — the ref callback's synchronous
 * `ctx.*` calls ARE the draw.
 *
 * `frame`/`fps`/`duration` are explicit arguments rather than read off
 * `window`, for the same reason `interpolate`/`spring` take `frame`
 * explicitly: `window.frame` is kept in sync in render (bundle.js sets it
 * every `__setFrame` call) but is never set in preview — overlay-eval.ts
 * resolves a bare `frame` identifier via closure over the compiled
 * function's own parameter instead of a global. An explicit argument
 * resolves identically (by closure or by global, per context) in both.
 *
 * A NEW closure is returned on every call — by design, not an oversight —
 * so React sees the ref prop's identity change on every frame and
 * re-invokes it: the same "callback ref as a per-render effect" pattern the
 * React team documents for imperative work tied to a DOM node's current
 * props. The `<canvas>` element itself is never remounted by this, so it
 * does not clear or otherwise disturb previously drawn pixels between calls
 * — same-frame-same-pixels is `draw`'s own responsibility, exactly as it is
 * for any other overlay content.
 */
export function makeUseCanvas2DFrame(context) {
  if (context !== 'render' && context !== 'preview') {
    throw new Error(`makeUseCanvas2DFrame: unknown context ${context}`)
  }
  return function useCanvas2DFrame(draw, frame, fps, duration) {
    return (node) => {
      if (!node) return
      const ctx = node.getContext('2d')
      if (!ctx) return
      draw(ctx, { frame, fps, duration })
    }
  }
}
