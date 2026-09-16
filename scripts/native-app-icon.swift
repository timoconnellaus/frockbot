#!/usr/bin/env swift
// Generates the native app icons from Pixel's approved close-up icon artwork.
import AppKit
import Foundation

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let native = root.appendingPathComponent("apps/native")
let source = native.appendingPathComponent("assets/branding/pixel-closeup-icon.png")

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

guard let artwork = NSImage(contentsOf: source) else {
  fail("Could not read Pixel artwork at \(source.path)")
}

let coral = NSColor(srgbRed: 0.969, green: 0.231, blue: 0.384, alpha: 1)

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
    coral.setFill()
    CGRect(x: 0, y: 0, width: pixels, height: pixels).fill()
  } else {
    context.cgContext.clear(CGRect(x: 0, y: 0, width: pixels, height: pixels))
  }
  draw(CGRect(x: 0, y: 0, width: pixels, height: pixels))
  context.flushGraphics()
  NSGraphicsContext.restoreGraphicsState()
  return rep
}

func drawArtwork(in frame: CGRect, inset: CGFloat, round: Bool) {
  let artFrame = frame.insetBy(dx: frame.width * inset, dy: frame.height * inset)
  let clip = round
    ? NSBezierPath(ovalIn: artFrame)
    : NSBezierPath(
        roundedRect: artFrame,
        xRadius: artFrame.width * 0.225,
        yRadius: artFrame.height * 0.225
      )
  NSGraphicsContext.saveGraphicsState()
  clip.addClip()
  coral.setFill()
  artFrame.fill()
  artwork.draw(in: artFrame, from: .zero, operation: .sourceOver, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
}

func fullIcon(_ pixels: Int, round: Bool = false, opaque: Bool = false) -> NSBitmapImageRep {
  bitmap(pixels, opaque: opaque) { frame in
    if opaque {
      coral.setFill()
      frame.fill()
    }
    drawArtwork(in: frame, inset: round ? 0.01 : 0.052, round: round)
  }
}

func adaptiveForeground(_ pixels: Int) -> NSBitmapImageRep {
  bitmap(pixels) { frame in
    coral.setFill()
    frame.fill()
    drawArtwork(in: frame, inset: -0.015, round: false)
  }
}

func maskableIcon(_ pixels: Int) -> NSBitmapImageRep {
  bitmap(pixels, opaque: true) { frame in
    coral.setFill()
    frame.fill()
    drawArtwork(in: frame, inset: -0.015, round: false)
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
