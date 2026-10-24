// §568 fixtures for tests/test_web_image.py, generated on macOS (never a personal photo): swift make-fixtures.swift <outdir>
// A pattern with known colours: four quadrants (stored top-left mid blue, top-right saturated red, bottom-left
// saturated green, bottom-right grey) and a small white marker in a corner. The quadrants are asymmetric, so a
// missing or wrong rotation moves them; the tests check where each lands, not the marker.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let out = CommandLine.arguments[1]
func pattern(width: Int, height: Int, space: CGColorSpace, bits: Int, alpha: Bool, markerAt: (Int, Int)) -> CGImage {
  let info: UInt32 = alpha ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue
  let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: bits, bytesPerRow: 0, space: space,
                      bitmapInfo: info | (bits == 16 ? CGBitmapInfo.byteOrder16Little.rawValue : 0))!
  let w = CGFloat(width), h = CGFloat(height)
  let quads: [(CGFloat, CGFloat, [CGFloat])] = [(0, h / 2, [64, 128, 192]), (w / 2, h / 2, [230, 30, 40]), (0, 0, [30, 200, 60]), (w / 2, 0, [128, 128, 128])]
  if alpha { ctx.clear(CGRect(x: 0, y: 0, width: w, height: h)) }
  for (x, y, c) in quads {
    ctx.setFillColor(CGColor(colorSpace: space, components: [c[0] / 255, c[1] / 255, c[2] / 255, alpha && x > 0 && y == 0 ? 0.5 : 1])!)
    ctx.fill(CGRect(x: x, y: y, width: w / 2, height: h / 2))
  }
  if alpha { ctx.clear(CGRect(x: w / 2, y: 0, width: w / 4, height: h / 4)) } // a fully transparent patch
  ctx.setFillColor(CGColor(colorSpace: space, components: [1, 1, 1, 1])!)
  // CG's origin is bottom-left: markerAt is in top-left pixel coordinates of the stored image
  ctx.fill(CGRect(x: CGFloat(markerAt.0), y: h - CGFloat(markerAt.1) - 20, width: 20, height: 20))
  return ctx.makeImage()!
}
func write(_ img: CGImage, _ name: String, _ type: UTType, orientation: Int = 1, tiled: Bool = false) {
  let url = URL(fileURLWithPath: out).appendingPathComponent(name)
  let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)!
  var props: [CFString: Any] = [kCGImagePropertyOrientation: orientation, kCGImageDestinationLossyCompressionQuality: 0.95, kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFCompression: 5]]
  if tiled { props[kCGImagePropertyTIFFDictionary] = [kCGImagePropertyTIFFTileWidth: 512, kCGImagePropertyTIFFTileLength: 512] }
  CGImageDestinationAddImage(dest, img, props as CFDictionary)
  if !CGImageDestinationFinalize(dest) { print("FAILED \(name)"); exit(1) }
  print("wrote \(name)")
}
let p3 = CGColorSpace(name: CGColorSpace.displayP3)!
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
// Orientation 6: the stored image is rotated 90° clockwise to show. Stored 300x220 shows as 220x300, its stored
// bottom-left (green) quadrant shown top-left.
write(pattern(width: 300, height: 220, space: p3, bits: 8, alpha: false, markerAt: (300 - 20, 0)), "p3-rot6.heic", .heic, orientation: 6)
write(pattern(width: 240, height: 180, space: p3, bits: 8, alpha: false, markerAt: (0, 0)), "p3.heic", .heic)
write(pattern(width: 240, height: 180, space: srgb, bits: 8, alpha: false, markerAt: (0, 0)), "srgb.heic", .heic)
write(pattern(width: 240, height: 180, space: p3, bits: 8, alpha: false, markerAt: (0, 0)), "p3.tiff", .tiff)
write(pattern(width: 240, height: 180, space: p3, bits: 16, alpha: false, markerAt: (0, 0)), "p3-16bit.tiff", .tiff)
write(pattern(width: 240, height: 180, space: p3, bits: 8, alpha: true, markerAt: (0, 0)), "p3-alpha.tiff", .tiff)
write(pattern(width: 240, height: 180, space: p3, bits: 8, alpha: false, markerAt: (0, 0)), "p3-rot6.tiff", .tiff, orientation: 6)

// A CMYK TIFF (Generic CMYK) and a gray one (Generic Gray Gamma 2.2), each with its own profile: an RGB output must
// never carry a CMYK or gray profile (the profile's colour space has to be the pixels').
func flat(space: CGColorSpace, comps: Int, fills: [[CGFloat]]) -> CGImage {
  let ctx = CGContext(data: nil, width: 240, height: 180, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                      bitmapInfo: CGImageAlphaInfo.none.rawValue)!
  // left half fills[0], right half fills[1]
  for (i, f) in fills.enumerated() {
    ctx.setFillColor(CGColor(colorSpace: space, components: f + [1])!)
    ctx.fill(CGRect(x: CGFloat(i) * 120, y: 0, width: 120, height: 180))
  }
  return ctx.makeImage()!
}
let cmyk = CGColorSpace(name: CGColorSpace.genericCMYK)!
let gray = CGColorSpace(name: CGColorSpace.genericGrayGamma2_2)!
write(flat(space: cmyk, comps: 4, fills: [[1, 0, 0, 0], [0, 1, 1, 0]]), "cmyk.tiff", .tiff)
write(flat(space: gray, comps: 1, fills: [[0.25], [0.75]]), "gray.tiff", .tiff)
