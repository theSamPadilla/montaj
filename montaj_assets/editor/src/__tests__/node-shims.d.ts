// This package has no @types/node (it's a browser-facing library with no
// Node-touching runtime code otherwise), so plain TypeScript can't resolve
// `node:*` specifiers on its own. Vitest runs on Node and provides the real
// modules at runtime regardless — these ambient shapes cover only the
// handful of calls `no-opacity-modifier-on-editor-vars.test.ts` makes,
// purely so `tsc --noEmit` can typecheck that file.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function readdirSync(path: string): string[]
  export function statSync(path: string): { isDirectory(): boolean }
}
declare module 'node:path' {
  export function dirname(path: string): string
  export function join(...parts: string[]): string
  export function relative(from: string, to: string): string
}
declare module 'node:url' {
  export function fileURLToPath(url: string): string
}
