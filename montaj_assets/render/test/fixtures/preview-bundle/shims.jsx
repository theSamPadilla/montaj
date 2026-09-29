// Every specifier the preview shims, imported the ways an overlay would.
// preview-bundle.test.mjs also builds this file with render's bundleComponent:
// render must resolve every one of these, which keeps the shim list to exactly
// what render can resolve.
import React, { useMemo } from 'react'
import 'react-dom'
import 'react-dom/client'
import { jsx } from 'react/jsx-runtime'
import { jsxDEV } from 'react/jsx-dev-runtime'
import { interpolate, useThreeFrame } from 'montaj/render'
import {
  springStep, Canvas, FaIcon, THREE, Ph, FaSolid, FaBrands, BarChart,
} from 'montaj-overlay-runtime'

export default function Shims(props) {
  props.seen({
    React, useMemo, jsx, jsxDEV, interpolate, useThreeFrame,
    springStep, Canvas, FaIcon, THREE, Ph, FaSolid, FaBrands, BarChart,
  })
  return <div>{new THREE.Vector3(1, 2, 3).y}</div>
}
