import { shadowed } from './lib/shadow.js'

export default function Shadow() {
  return <div>{`${shadowed()}|${frame}|${typeof THREE.Vector3}`}</div>
}
