import AppKit
import SwiftUI
import XCTest
@testable import Mamachi

final class OverlaySnapshotTests: XCTestCase {
    @MainActor
    func testListeningOverlayRendersOrbAndConversation() throws {
        let model = AppModel()
        model.daemonConnected = true
        model.voiceState = .listening
        model.isEngaged = true
        model.microphoneLevel = 0.72
        model.liveUserTranscript = "Please update the selected function and verify it."

        let renderer = ImageRenderer(content: OverlayView(model: model))
        renderer.scale = 2
        renderer.proposedSize = ProposedViewSize(width: 528, height: 225)
        guard
            let image = renderer.nsImage,
            let tiff = image.tiffRepresentation,
            let representation = NSBitmapImageRep(data: tiff),
            let png = representation.representation(using: .png, properties: [:])
        else {
            return XCTFail("The native overlay did not render an image")
        }

        XCTAssertGreaterThan(png.count, 10_000)
        if let outputPath = ProcessInfo.processInfo.environment["MAMACHI_SNAPSHOT_PATH"] {
            try png.write(to: URL(filePath: outputPath), options: .atomic)
        }
    }

    @MainActor
    func testLongStreamingAssistantTranscriptRendersInExpandedDrawer() throws {
        let model = AppModel()
        model.daemonConnected = true
        model.voiceState = .connected
        model.isEngaged = true
        model.drawerExpanded = true
        model.transcripts = [
            TranscriptEntry(
                id: UUID(),
                speaker: .user,
                text: "Explain the current task, but keep the spoken answer concise.",
                at: Date()
            ),
        ]
        model.liveAssistantTranscript = """
        I’m updating the requested files now. The detailed transcript stays readable here while the spoken response remains brief and the conversation automatically follows each incoming word.
        """

        let renderer = ImageRenderer(content: OverlayView(model: model))
        renderer.scale = 2
        renderer.proposedSize = ProposedViewSize(width: 528, height: 680)
        guard
            let image = renderer.nsImage,
            let tiff = image.tiffRepresentation,
            let representation = NSBitmapImageRep(data: tiff),
            let png = representation.representation(using: .png, properties: [:])
        else {
            return XCTFail("The expanded overlay did not render an image")
        }

        XCTAssertGreaterThan(png.count, 20_000)
        if let outputPath = ProcessInfo.processInfo.environment["MAMACHI_LONG_SNAPSHOT_PATH"] {
            try png.write(to: URL(filePath: outputPath), options: .atomic)
        }
    }

    @MainActor
    func testOverlaySizeSettingsRender() throws {
        let model = AppModel()
        model.collapsedOverlaySize = .small
        model.expandedOverlaySize = .large
        let hosting = NSHostingView(
            rootView: SettingsView(model: model, diagnostics: DiagnosticsService())
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 616, height: 776),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.contentView = hosting
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        window.displayIfNeeded()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
        hosting.layoutSubtreeIfNeeded()

        guard
            let representation = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds)
        else {
            return XCTFail("Settings did not create a bitmap")
        }
        hosting.cacheDisplay(in: hosting.bounds, to: representation)
        guard let png = representation.representation(using: .png, properties: [:]) else {
            return XCTFail("Settings did not render an image")
        }

        var visibleSamples = 0
        for x in stride(from: 0, to: representation.pixelsWide, by: 8) {
            for y in stride(from: 0, to: representation.pixelsHigh, by: 8) {
                guard
                    let color = representation.colorAt(x: x, y: y)?
                        .usingColorSpace(.deviceRGB)
                else { continue }
                if color.alphaComponent > 0.1
                    && (color.redComponent < 0.94
                        || color.greenComponent < 0.94
                        || color.blueComponent < 0.94)
                {
                    visibleSamples += 1
                }
            }
        }
        XCTAssertGreaterThan(visibleSamples, 100)

        if let outputPath = ProcessInfo.processInfo.environment["MAMACHI_SETTINGS_SNAPSHOT_PATH"] {
            try png.write(to: URL(filePath: outputPath), options: .atomic)
        }
    }
}
