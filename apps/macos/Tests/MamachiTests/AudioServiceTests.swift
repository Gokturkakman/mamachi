import AVFoundation
import XCTest
@testable import Mamachi

final class AudioServiceTests: XCTestCase {
    private func requireAudioHardware() throws {
        try XCTSkipIf(
            ProcessInfo.processInfo.environment["CI"] != nil,
            "AVAudioEngine hardware tests require a physical audio device"
        )
    }
    @MainActor
    func testSchedulesRealtimePCMOnPlayerNode() throws {
        try requireAudioHardware()
        let service = AudioService()
        try XCTSkipUnless(service.isPlaybackAvailable, "No audio output device is available")
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
    func testReportsWhenAllRealtimePCMHasPlayed() async throws {
        try requireAudioHardware()
        let service = AudioService()
        try XCTSkipUnless(service.isPlaybackAvailable, "No audio output device is available")
        let drained = expectation(description: "scheduled PCM drained")
        service.onPlaybackDrained = { drained.fulfill() }

        service.play(pcm: Data(count: 4_800))
        XCTAssertTrue(service.hasPendingPlayback)

        await fulfillment(of: [drained], timeout: 1)
        XCTAssertFalse(service.hasPendingPlayback)
        service.stop()
    }
    @MainActor
    func testStoppedEngineRecoveryUnwedgesPlaybackGate() async throws {
        try requireAudioHardware()
        let service = AudioService()
        try XCTSkipUnless(service.isPlaybackAvailable, "No audio output device is available")
        var drains = 0
        service.onPlaybackDrained = { drains += 1 }

        // Two seconds of scheduled audio: still pending when recovery runs.
        service.play(pcm: Data(count: 96_000))
        XCTAssertTrue(service.hasPendingPlayback)

        // Simulates the engine dying mid-playout (route/device change): the
        // scheduled buffer's .dataPlayedBack completion never fires on its
        // own, which previously wedged AppModel's microphone PCM gate shut.
        service.recoverStoppedEngine()

        XCTAssertFalse(service.hasPendingPlayback, "wedged pending-playback gate must reset")
        XCTAssertEqual(drains, 1, "recovery reports drained exactly once")

        // Stale completions from the cleared generation must not double-fire.
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(drains, 1)
        service.stop()
    }

    @MainActor
    func testBenignConfigurationChangeLeavesRunningPlaybackAlone() throws {
        try requireAudioHardware()
        let service = AudioService()
        try XCTSkipUnless(service.isPlaybackAvailable, "No audio output device is available")
        var drains = 0
        service.onPlaybackDrained = { drains += 1 }

        // play() starts the engine, so this notification is the benign kind
        // (voice-processing enable, format renegotiation). Tearing down live
        // state on it was the deaf-on-engage regression.
        service.play(pcm: Data(count: 96_000))
        XCTAssertTrue(service.hasPendingPlayback)

        service.handleAudioEngineConfigurationChange()

        XCTAssertTrue(service.hasPendingPlayback, "running engine state must survive benign notifications")
        XCTAssertEqual(drains, 0)
        service.stop()
    }
    /// Mac mic arrays under voice processing deliver multi-channel buffers
    /// whose extra channels carry near-inverted beamforming residue. The
    /// converter's default downmix averaged them into digital silence —
    /// zero-RMS PCM on the wire while the channel-0 level meter looked
    /// alive. The wire converter must pin channel 0 instead of downmixing.
    @MainActor
    func testWireConverterSurvivesPhaseCancellingChannels() {
        guard let inputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 48_000,
            channels: 2,
            interleaved: false
        ) else { return XCTFail("input format unavailable") }
        guard let converter = AudioService.makeWireConverter(from: inputFormat) else {
            return XCTFail("wire converter unavailable")
        }

        let frames: AVAudioFrameCount = 4_800
        guard let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frames) else {
            return XCTFail("input buffer unavailable")
        }
        buffer.frameLength = frames
        guard let channels = buffer.floatChannelData else {
            return XCTFail("float channels unavailable")
        }
        for index in 0..<Int(frames) {
            let phase = 2 * Double.pi * 440 * Double(index) / 48_000
            let sample = Float(sin(phase) * 0.5)
            channels[0][index] = sample
            channels[1][index] = -sample // beamforming residue: inverted phase
        }

        guard let data = AudioService.convertToWire(buffer, using: converter) else {
            return XCTFail("conversion produced no data")
        }
        let samples = data.withUnsafeBytes { raw in
            Array(raw.bindMemory(to: Int16.self))
        }
        XCTAssertFalse(samples.isEmpty)
        var sum = 0.0
        for sample in samples {
            let value = Double(sample) / 32_768
            sum += value * value
        }
        let rms = sqrt(sum / Double(samples.count))
        XCTAssertGreaterThan(
            rms,
            0.05,
            "channel-pinned conversion must preserve the speech signal; a blind downmix cancels it to silence"
        )
    }
}
