// Every shimmed package, imported the ways an overlay would.
import * as THREE from 'three'
import { Vector3 } from 'three'
import { interpolate, useThreeFrame } from 'montaj/render'
import { springStep, Canvas as RuntimeCanvas, FaIcon } from 'montaj-overlay-runtime'
import { Canvas } from '@react-three/fiber'
import { BarChart, ResponsiveContainer } from 'recharts'
import { Star } from '@phosphor-icons/react'
import * as Phosphor from '@phosphor-icons/react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faStar } from '@fortawesome/free-solid-svg-icons'
import { faGithub } from '@fortawesome/free-brands-svg-icons'
import 'react-dom'

export default function Shims(props) {
  props.seen({
    THREE, Vector3, interpolate, useThreeFrame, springStep, RuntimeCanvas, FaIcon,
    Canvas, BarChart, ResponsiveContainer, Star, Phosphor, FontAwesomeIcon, faStar, faGithub,
  })
  return <div>{new Vector3(1, 2, 3).y}</div>
}
