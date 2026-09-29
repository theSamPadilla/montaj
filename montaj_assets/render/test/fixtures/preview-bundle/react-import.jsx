import React, { useMemo } from 'react'
import { NoImport } from './lib/no-react-import.js'

function Memo() {
  const label = useMemo(() => `memo:${frame}`, [])
  return <b data-memo="">{label}</b>
}

export default function ReactImport(props) {
  if (props.seen) props.seen({ React, useMemo })
  return (
    <div>
      <Memo />
      <NoImport />
    </div>
  )
}
