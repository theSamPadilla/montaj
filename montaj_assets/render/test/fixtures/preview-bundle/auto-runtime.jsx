/** @jsxRuntime automatic */
// Opts into the automatic runtime, so esbuild imports react/jsx-runtime.
export default function AutoRuntime() {
  const keyed = { key: 'from-props', 'data-k': '' }
  return (
    <ul>
      {['a', 'b'].map(k => <li key={k}>{`${k}${frame}`}</li>)}
      <>
        <li {...keyed} />
      </>
    </ul>
  )
}
