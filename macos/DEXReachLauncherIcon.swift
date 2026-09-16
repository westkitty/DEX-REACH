import AppKit

let output = CommandLine.arguments.dropFirst().first ?? "DEXReachLauncher.png"
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)

image.lockFocus()

let canvas = NSRect(origin: .zero, size: size)
let background = NSBezierPath(roundedRect: canvas.insetBy(dx: 48, dy: 48), xRadius: 210, yRadius: 210)
NSColor(calibratedWhite: 0.035, alpha: 1).setFill()
background.fill()

let border = NSBezierPath(roundedRect: canvas.insetBy(dx: 70, dy: 70), xRadius: 190, yRadius: 190)
border.lineWidth = 28
NSColor(calibratedRed: 0.95, green: 0.05, blue: 0.06, alpha: 1).setStroke()
border.stroke()

let slash = NSBezierPath()
slash.lineWidth = 44
slash.lineCapStyle = .round
slash.move(to: NSPoint(x: 388, y: 676))
slash.line(to: NSPoint(x: 310, y: 348))
slash.move(to: NSPoint(x: 506, y: 676))
slash.line(to: NSPoint(x: 428, y: 348))
NSColor(calibratedRed: 0.95, green: 0.05, blue: 0.06, alpha: 1).setStroke()
slash.stroke()

let primary = NSMutableParagraphStyle()
primary.alignment = .center
let primaryAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 290, weight: .black),
    .foregroundColor: NSColor.white,
    .paragraphStyle: primary
]
"D   R".draw(in: NSRect(x: 120, y: 344, width: 784, height: 350), withAttributes: primaryAttributes)

let secondary = NSMutableParagraphStyle()
secondary.alignment = .center
let secondaryAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 98, weight: .bold),
    .foregroundColor: NSColor(calibratedRed: 0.95, green: 0.05, blue: 0.06, alpha: 1),
    .kern: 12,
    .paragraphStyle: secondary
]
"REACH".draw(in: NSRect(x: 130, y: 190, width: 764, height: 130), withAttributes: secondaryAttributes)

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    fputs("Could not render icon\n", stderr)
    exit(1)
}

try png.write(to: URL(fileURLWithPath: output), options: .atomic)
