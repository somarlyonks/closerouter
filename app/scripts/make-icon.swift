// Generates the macOS app icon (all required AppIcon sizes) into the appiconset directory.
// The glyph is assets/logo.svg, drawn on a dark rounded card to match the web UI theme.
// Usage: swift make-icon.swift <output-directory>
import AppKit

let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // scripts/
    .deletingLastPathComponent() // app/
    .deletingLastPathComponent()

func makeImage(size: CGFloat) -> NSBitmapImageRep? {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: Int(size),
        pixelsHigh: Int(size),
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else { return nil }
    rep.size = NSSize(width: size, height: size)

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    let rect = NSRect(x: 0, y: 0, width: size, height: size)
    let inset = size * 0.10
    let rrect = rect.insetBy(dx: inset, dy: inset)
    let path = NSBezierPath(roundedRect: rrect, xRadius: rrect.width * 0.22, yRadius: rrect.height * 0.22)
    let gradient = NSGradient(colors: [
        NSColor(calibratedRed: 0.145, green: 0.157, blue: 0.180, alpha: 1),
        NSColor(calibratedRed: 0.055, green: 0.063, blue: 0.078, alpha: 1),
    ])!
    gradient.draw(in: path, angle: -90)

    // Fresh NSImage per size so the vector SVG re-rasterizes at native resolution.
    if let logo = NSImage(contentsOf: repoRoot.appendingPathComponent("assets/logo.svg")) {
        let aspect = logo.size.width / logo.size.height
        let box = rrect.insetBy(dx: size * 0.12, dy: size * 0.12)
        var w = box.width
        var h = w / aspect
        if h > box.height {
            h = box.height
            w = h * aspect
        }
        let dst = NSRect(
            x: rrect.midX - w / 2,
            y: rrect.midY - h / 2,
            width: w,
            height: h
        )
        logo.size = dst.size
        NSGraphicsContext.current?.imageInterpolation = .high
        logo.draw(in: dst)
    } else {
        fatalError("failed to load assets/logo.svg (no SVG image codec)")
    }

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let outDir = CommandLine.arguments[1]
let sizes: [(name: String, px: Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]
for (name, px) in sizes {
    guard let rep = makeImage(size: CGFloat(px)),
          let data = rep.representation(using: .png, properties: [:]) else {
        fatalError("failed to render \(name)")
    }
    try! data.write(to: URL(fileURLWithPath: "\(outDir)/\(name)"))
}
print("wrote \(sizes.count) icons to \(outDir)")
