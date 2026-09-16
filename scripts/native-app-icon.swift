#!/usr/bin/env swift
// Generates the native app icons from Pixel's approved transparent artwork.
import AppKit
import Foundation

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let source = root.appendingPathComponent("output/flock-svg-rig/parts/pixel-render.png")
let native = root.appendingPathComponent("apps/native")

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

guard let pixel = NSImage(contentsOf: source) else {
  fail("Could not read Pixel artwork at \(source.path)")
}

func bitmap(_ pixels: Int, opaque: Bool = false, draw: (CGRect) -> Void) -> NSBitmapImageRep {
  guard
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: pixels,
      pixelsHigh: pixels,
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bytesPerRow: 0,
      bitsPerPixel: 0
    )
  else { fail("Could not allocate a \(pixels)px bitmap") }
  rep.size = NSSize(width: pixels, height: pixels)
  NSGraphicsContext.saveGraphicsState()
  let context = NSGraphicsContext(bitmapImageRep: rep)!
  context.imageInterpolation = NSImageInterpolation.high
  NSGraphicsContext.current = context
  if opaque {
    NSColor(srgbRed: 0.925, green: 0.22, blue: 0.42, alpha: 1).setFill()
    CGRect(x: 0, y: 0, width: pixels, height: pixels).fill()
  } else {
    context.cgContext.clear(CGRect(x: 0, y: 0, width: pixels, height: pixels))
  }
  draw(CGRect(x: 0, y: 0, width: pixels, height: pixels))
  context.flushGraphics()
  NSGraphicsContext.restoreGraphicsState()
  return rep
}

func gradient(in path: NSBezierPath) {
  path.addClip()
  NSGradient(
    starting: NSColor(srgbRed: 1, green: 0.29, blue: 0.53, alpha: 1),
    ending: NSColor(srgbRed: 0.82, green: 0.10, blue: 0.34, alpha: 1)
  )!.draw(in: path, angle: -55)
}

func drawPixel(in frame: CGRect, safe: Bool) {
  let width = frame.width * (safe ? 0.57 : 0.655)
  let height = width * 615 / 457
  let body = CGRect(
    x: frame.midX - width / 2,
    y: safe ? frame.height * 0.13 : frame.height * 0.055,
    width: width,
    height: height
  )
  NSGraphicsContext.saveGraphicsState()
  let shadow = NSShadow()
  shadow.shadowColor = NSColor.black.withAlphaComponent(0.22)
  shadow.shadowBlurRadius = frame.width * 0.035
  shadow.shadowOffset = NSSize(width: 0, height: -frame.width * 0.018)
  shadow.set()
  pixel.draw(in: body, from: .zero, operation: .sourceOver, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
}

func fullIcon(_ pixels: Int, round: Bool = false, opaque: Bool = false) -> NSBitmapImageRep {
  bitmap(pixels, opaque: opaque) { frame in
    let inset = round ? frame.width * 0.015 : frame.width * 0.052
    let background = round
      ? NSBezierPath(ovalIn: frame.insetBy(dx: inset, dy: inset))
      : NSBezierPath(
          roundedRect: frame.insetBy(dx: inset, dy: inset),
          xRadius: frame.width * 0.21,
          yRadius: frame.width * 0.21
        )
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.2)
    shadow.shadowBlurRadius = frame.width * 0.045
    shadow.shadowOffset = NSSize(width: 0, height: -frame.width * 0.022)
    shadow.set()
    NSColor(srgbRed: 0.82, green: 0.10, blue: 0.34, alpha: 1).setFill()
    background.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGraphicsContext.saveGraphicsState()
    gradient(in: background)
    NSGraphicsContext.restoreGraphicsState()

    let halo = NSBezierPath(
      ovalIn: CGRect(
        x: frame.width * 0.15,
        y: frame.height * 0.145,
        width: frame.width * 0.70,
        height: frame.height * 0.70
      )
    )
    NSColor(srgbRed: 1, green: 0.965, blue: 0.88, alpha: 1).setFill()
    halo.fill()
    drawPixel(in: frame, safe: false)
  }
}

func adaptiveForeground(_ pixels: Int) -> NSBitmapImageRep {
  bitmap(pixels) { frame in
    let halo = NSBezierPath(
      ovalIn: CGRect(
        x: frame.width * 0.18,
        y: frame.height * 0.18,
        width: frame.width * 0.64,
        height: frame.height * 0.64
      )
    )
    NSColor(srgbRed: 1, green: 0.965, blue: 0.88, alpha: 1).setFill()
    halo.fill()
    drawPixel(in: frame, safe: true)
  }
}

func maskableIcon(_ pixels: Int) -> NSBitmapImageRep {
  bitmap(pixels, opaque: true) { frame in
    let halo = NSBezierPath(
      ovalIn: CGRect(
        x: frame.width * 0.18,
        y: frame.height * 0.18,
        width: frame.width * 0.64,
        height: frame.height * 0.64
      )
    )
    NSColor(srgbRed: 1, green: 0.965, blue: 0.88, alpha: 1).setFill()
    halo.fill()
    drawPixel(in: frame, safe: true)
  }
}

func write(_ rep: NSBitmapImageRep, to url: URL) {
  guard let data = rep.representation(using: .png, properties: [:]) else {
    fail("Could not encode \(url.lastPathComponent)")
  }
  do {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try data.write(to: url)
  } catch {
    fail("Could not write \(url.path): \(error)")
  }
}

let mac = native.appendingPathComponent("macos/Runner/Assets.xcassets/AppIcon.appiconset")
for size in [16, 32, 64, 128, 256, 512, 1024] {
  write(fullIcon(size), to: mac.appendingPathComponent("app_icon_\(size).png"))
}

let android = native.appendingPathComponent("android/app/src/main/res")
let densities = [
  ("mdpi", 48, 108),
  ("hdpi", 72, 162),
  ("xhdpi", 96, 216),
  ("xxhdpi", 144, 324),
  ("xxxhdpi", 192, 432),
]
for (density, legacy, foreground) in densities {
  let directory = android.appendingPathComponent("mipmap-\(density)")
  write(fullIcon(legacy, opaque: true), to: directory.appendingPathComponent("ic_launcher.png"))
  write(fullIcon(legacy, round: true, opaque: true), to: directory.appendingPathComponent("ic_launcher_round.png"))
  write(adaptiveForeground(foreground), to: directory.appendingPathComponent("ic_launcher_foreground.png"))
}

let web = native.appendingPathComponent("web")
write(fullIcon(32), to: web.appendingPathComponent("favicon.png"))
write(fullIcon(192), to: web.appendingPathComponent("icons/Icon-192.png"))
write(fullIcon(512), to: web.appendingPathComponent("icons/Icon-512.png"))
write(maskableIcon(192), to: web.appendingPathComponent("icons/Icon-maskable-192.png"))
write(maskableIcon(512), to: web.appendingPathComponent("icons/Icon-maskable-512.png"))

print("Generated Pixel app icons for macOS, Android, and web")
