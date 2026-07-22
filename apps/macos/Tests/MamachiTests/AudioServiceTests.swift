import XCTest
@testable import Mamachi

final class AudioServiceTests: XCTestCase {
    @MainActor
    func testSchedulesRealtimePCMOnPlayerNode() {
        let service = AudioService()
        var playbackError: Error?
        service.onError = { playbackError = $0 }

        let sampleCount = 2_400
        var samples = [Int16]()
        samples.reserveCapacity(sampleCount)
        for index in 0..<sampleCount {
            let phase = 2 * Double.pi * 440 * Double(index) / 24_000
            samples.append(Int16(sin(phase) * 2_000))
        }
        let pcm = samples.withUnsafeBytes { Data($0) }

        service.play(pcm: pcm)
        XCTAssertNil(playbackError)
        XCTAssertTrue(service.isPlaying)
        service.stop()
    }

    @MainActor
    func testReportsWhenAllRealtimePCMHasPlayed() async {
        let service = AudioService()
        let drained = expectation(description: "scheduled PCM drained")
        service.onPlaybackDrained = { drained.fulfill() }

        service.play(pcm: Data(count: 4_800))
        XCTAssertTrue(service.hasPendingPlayback)

        await fulfillment(of: [drained], timeout: 1)
        XCTAssertFalse(service.hasPendingPlayback)
        service.stop()
    }
}
