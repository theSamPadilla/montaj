// Chain fixture: entry.jsx -> ./lib/a.js -> ./b.js. No React import: the JSX
// compiles to the wrapper's bare `React`.
import { helperLabel, Child } from './lib/a.js'

export default function ChainOverlay() {
  return (
    <div data-overlay="chain">
      <span data-helper="">{helperLabel()}</span>
      <Child />
    </div>
  )
}
