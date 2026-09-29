import { useCurrentFrame } from 'remotion'

export default function Remotion() {
  return <div>{useCurrentFrame()}</div>
}
