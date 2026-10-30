#!/usr/bin/env swift
import AppKit
import Foundation

// Original AppBridge mark. Rendered offscreen; no application window is opened.
// Run: swift scripts/create-app-icon.swift
let project = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let assets = project.appendingPathComponent("assets", isDirectory: true)
let work = project.appendingPathComponent(".cache/app-icon-\(UUID().uuidString)", isDirectory: true)
let iconset = work.appendingPathComponent("appbridge.iconset", isDirectory: true)
let manager = FileManager.default

func color(_ hex: UInt32, alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
            green: CGFloat((hex >> 8) & 255) / 255,
            blue: CGFloat(hex & 255) / 255, alpha: alpha)
}

func png(size: Int) throws -> Data {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                       bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                       isPlanar: false, colorSpaceName: .deviceRGB,
                                       bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw NSError(domain: "AppBridgeIcon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot create icon bitmap"])
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    let context = graphics.cgContext
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)

    // Transparent outer margin preserves the familiar macOS app-icon silhouette.
    let base = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 184, yRadius: 184)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = color(0x182448, alpha: 0.22)
    shadow.shadowOffset = NSSize(width: 0, height: -10)
    shadow.shadowBlurRadius = 20
    shadow.set()
    color(0x5267BE).setFill()
    base.fill()
    NSGraphicsContext.restoreGraphicsState()

    color(0xFFFFFF, alpha: 0.14).setStroke()
    base.lineWidth = 3
    base.stroke()

    // A continuous arch rests on two piers, with the deck connecting both sides.
    let arch = NSBezierPath()
    arch.move(to: NSPoint(x: 336, y: 468))
    arch.curve(to: NSPoint(x: 688, y: 468),
               controlPoint1: NSPoint(x: 336, y: 692),
               controlPoint2: NSPoint(x: 688, y: 692))
    arch.lineWidth = 66
    arch.lineCapStyle = .round
    arch.lineJoinStyle = .round
    color(0xFFFFFF).setStroke()
    arch.stroke()

    color(0xFFFFFF).setFill()
    for x in [303, 655] {
        NSBezierPath(roundedRect: NSRect(x: x, y: 332, width: 66, height: 244), xRadius: 33, yRadius: 33).fill()
    }
    NSBezierPath(roundedRect: NSRect(x: 234, y: 398, width: 556, height: 66), xRadius: 33, yRadius: 33).fill()

    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "AppBridgeIcon", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot encode icon PNG"])
    }
    return data
}

do {
    try manager.createDirectory(at: assets, withIntermediateDirectories: true)
    try manager.createDirectory(at: iconset, withIntermediateDirectories: true)
    defer { try? manager.removeItem(at: work) }

    for logical in [16, 32, 128, 256, 512] {
        try png(size: logical).write(to: iconset.appendingPathComponent("icon_\(logical)x\(logical).png"), options: .atomic)
        try png(size: logical * 2).write(to: iconset.appendingPathComponent("icon_\(logical)x\(logical)@2x.png"), options: .atomic)
    }
    let icns = work.appendingPathComponent("appbridge.icns")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
    process.arguments = ["-c", "icns", "-o", icns.path, iconset.path]
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw NSError(domain: "AppBridgeIcon", code: 3, userInfo: [NSLocalizedDescriptionKey: "iconutil failed"])
    }
    try png(size: 1024).write(to: assets.appendingPathComponent("appbridge-icon.png"), options: .atomic)
    try Data(contentsOf: icns).write(to: assets.appendingPathComponent("appbridge.icns"), options: .atomic)
    print("Created assets/appbridge-icon.png and assets/appbridge.icns")
} catch {
    fputs("AppBridge icon: \(error)\n", stderr)
    exit(1)
}
