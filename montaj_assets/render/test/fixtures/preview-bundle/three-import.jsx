// `three` lives in overlay-runtime's node_modules, which is not on render's
// search path, so this fails to build in render and must fail in the preview
// too. Overlays reach three through the bare THREE global instead.
import * as THREE from 'three'

export default function ThreeImport() {
  return <div>{new THREE.Vector3(1, 2, 3).y}</div>
}
