import { helperLabel } from './chain/lib/a.js'

type Props = { title?: string }

export default function Typed(props: Props) {
  const title: string = props.title ?? 'tsx'
  return <p>{`${title}:${frame}:${helperLabel()}`}</p>
}
