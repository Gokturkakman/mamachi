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
}
