// A component defined in a plain .js file (the js loader has no JSX), with no
// React import: `React` and `frame` are both the wrapper's.
export function Child() {
  return React.createElement('span', { 'data-child': '' }, `child:${frame}`)
}
