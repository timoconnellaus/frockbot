#!/usr/bin/env swift
// Draws the "FrockBot Dev" macOS app icon from the released one.
//
// The local desktop build (`bun run update:desktop`) is installed beside the
// released app, so its Dock, Finder and app switcher icon must say which copy
// it is at a glance. This takes `AppIcon.appiconset/app_icon_1024.png`, lays a
// bold "DEV" ribbon across the bottom, and writes every size the set names to
// `AppIconDev.appiconset`. Run it again whenever the released icon changes:
//
//   swift scripts/mac-dev-icon.swift
//
// Only the development build selects `AppIconDev`
// (`apps/native/macos/Runner/Configs/AppInfo.xcconfig`); release builds keep
// `AppIcon` untouched. The iPhone's FrockBot Dev build
// (`apps/native/ios/Runner/Configs/AppInfo.xcconfig`) gets the same ribbon over
// its own icon, which `swift scripts/native-app-icon.swift` writes first.
import AppKit
import Foundation

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let assets = root.appendingPathComponent("apps/native/macos/Runner/Assets.xcassets")
let source = assets.appendingPathComponent("AppIcon.appiconset")
let target = assets.appendingPathComponent("AppIconDev.appiconset")

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

guard let master = NSImage(contentsOf: source.appendingPathComponent("app_icon_1024.png")) else {
  fail("Could not read \(source.path)/app_icon_1024.png")
}

func bitmap(_ pixels: Int, draw: (CGRect) -> Void) -> NSBitmapImageRep {
  guard
    let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
      bytesPerRow: 0, bitsPerPixel: 0)
  else { fail("Could not allocate a \(pixels)px bitmap") }
  rep.size = NSSize(width: pixels, height: pixels)
  NSGraphicsContext.saveGraphicsState()
  let context = NSGraphicsContext(bitmapImageRep: rep)!
  context.imageInterpolation = .high
  NSGraphicsContext.current = context
  draw(CGRect(x: 0, y: 0, width: pixels, height: pixels))
  context.flushGraphics()
  NSGraphicsContext.restoreGraphicsState()
  return rep
}

// The full-size composite: the released artwork with a near-black ribbon and
// amber "DEV" across its lower quarter. The dark band against the pink ground
// stays distinct even at 16 px, where the lettering is no longer legible.
func ribboned(_ master: NSImage) -> NSBitmapImageRep {
  bitmap(1024) { frame in
    master.draw(in: frame, from: .zero, operation: .copy, fraction: 1)
    let band = CGRect(x: 0, y: 0, width: frame.width, height: frame.height * 0.26)
    NSColor(srgbRed: 0.07, green: 0.07, blue: 0.08, alpha: 1).setFill()
    band.fill()
    NSColor(srgbRed: 1.0, green: 0.76, blue: 0.0, alpha: 1).setFill()
    CGRect(x: 0, y: band.maxY, width: frame.width, height: frame.height * 0.018).fill()
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: band.height * 0.72, weight: .black),
      .foregroundColor: NSColor(srgbRed: 1.0, green: 0.76, blue: 0.0, alpha: 1),
      .kern: band.height * 0.06,
      .paragraphStyle: style,
    ]
    let text = NSAttributedString(string: "DEV", attributes: attributes)
    let height = text.size().height
    text.draw(in: CGRect(x: 0, y: band.midY - height / 2, width: frame.width, height: height))
  }
}
let composite = ribboned(master)
let compositeImage = NSImage(size: NSSize(width: 1024, height: 1024))
compositeImage.addRepresentation(composite)

let fileManager = FileManager.default
try? fileManager.removeItem(at: target)
do {
  try fileManager.createDirectory(at: target, withIntermediateDirectories: true)
} catch {
  fail("Could not create \(target.path): \(error)")
}

let contents = source.appendingPathComponent("Contents.json")
guard
  let data = try? Data(contentsOf: contents),
  let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
  let images = manifest["images"] as? [[String: Any]]
else { fail("Could not read \(contents.path)") }

var written = Set<String>()
for image in images {
  guard let filename = image["filename"] as? String,
    let size = (image["size"] as? String)?.split(separator: "x").first.flatMap({ Double($0) }),
    let scale = (image["scale"] as? String)?.dropLast().description, let factor = Double(scale)
  else { fail("Unexpected image entry in \(contents.path): \(image)") }
  guard written.insert(filename).inserted else { continue }
  let pixels = Int(size * factor)
  let rep = bitmap(pixels) { frame in
    compositeImage.draw(in: frame, from: .zero, operation: .copy, fraction: 1)
  }
  guard let png = rep.representation(using: .png, properties: [:]) else {
    fail("Could not encode \(filename)")
  }
  do {
    try png.write(to: target.appendingPathComponent(filename))
  } catch {
    fail("Could not write \(filename): \(error)")
  }
}
do {
  try data.write(to: target.appendingPathComponent("Contents.json"))
} catch {
  fail("Could not write Contents.json: \(error)")
}
print("Wrote \(written.count) images to \(target.path)")

// The iPhone's: one 1024 px image, and like its released icon, no alpha
// channel, which App Store Connect refuses.
let iosAssets = root.appendingPathComponent("apps/native/ios/Runner/Assets.xcassets")
let iosSource = iosAssets.appendingPathComponent("AppIcon.appiconset")
let iosTarget = iosAssets.appendingPathComponent("AppIconDev.appiconset")
guard let iosMaster = NSImage(contentsOf: iosSource.appendingPathComponent("app_icon_1024.png"))
else { fail("Could not read \(iosSource.path)/app_icon_1024.png") }
guard
  let image = ribboned(iosMaster).cgImage,
  let space = CGColorSpace(name: CGColorSpace.sRGB),
  let context = CGContext(
    data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
    space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
else { fail("Could not flatten the iPhone icon") }
context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
guard let flat = context.makeImage(),
  let iosPng = NSBitmapImageRep(cgImage: flat).representation(using: .png, properties: [:])
else { fail("Could not encode the iPhone icon") }
do {
  try? fileManager.removeItem(at: iosTarget)
  try fileManager.createDirectory(at: iosTarget, withIntermediateDirectories: true)
  try iosPng.write(to: iosTarget.appendingPathComponent("app_icon_1024.png"))
  try Data(contentsOf: iosSource.appendingPathComponent("Contents.json"))
    .write(to: iosTarget.appendingPathComponent("Contents.json"))
} catch {
  fail("Could not write \(iosTarget.path): \(error)")
}
print("Wrote the iPhone icon to \(iosTarget.path)")
