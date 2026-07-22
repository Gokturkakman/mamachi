@preconcurrency import AVFoundation
import Foundation

@MainActor
final class AudioService {
    var onMicrophonePCM: ((Data) -> Void)?
    var onLevel: ((Double) -> Void)?
    var onError: ((Error) -> Void)?
    var onPlaybackDrained: (() -> Void)?

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 24_000,
        channels: 1,
        interleaved: true
    )!
    private var converter: AVAudioConverter?
    private var capturing = false
    private var playbackGeneration = 0
    private var pendingPlaybackBuffers = 0
    private var scheduledPlaybackFrames: AVAudioFramePosition = 0
    private var playbackOriginFrame: AVAudioFramePosition = 0
    var isPlaying: Bool { player.isPlaying }
    var hasPendingPlayback: Bool { pendingPlaybackBuffers > 0 }
    var playbackPositionMilliseconds: Int {
        guard
            let renderTime = player.lastRenderTime,
            let playbackTime = player.playerTime(forNodeTime: renderTime),
            playbackTime.sampleRate > 0
        else { return 0 }
        let playedFrames = max(0, playbackTime.sampleTime - playbackOriginFrame)
        let milliseconds = Double(playedFrames) * 1_000 / playbackTime.sampleRate
        return max(0, Int(milliseconds.rounded(.down)))
    }

    init() {
        player.volume = 0.62
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: wireFormat)
    }

    func startCapture() async throws {
        guard !capturing else { return }
        guard await microphoneAccess() else { throw AudioError.microphoneDenied }

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
            throw AudioError.noInputDevice
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: wireFormat) else {
            throw AudioError.converterUnavailable
        }
        self.converter = converter
        input.installTap(onBus: 0, bufferSize: 2_048, format: inputFormat) { [weak self] buffer, _ in
            self?.consumeInput(buffer, converter: converter)
        }
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
        capturing = true
    }

    func stopCapture() {
        guard capturing else { return }
        engine.inputNode.removeTap(onBus: 0)
        converter = nil
        capturing = false
        onLevel?(0)
    }

    func beginPlaybackItem() {
        playbackOriginFrame = scheduledPlaybackFrames
    }

    func play(pcm data: Data) {
        guard !data.isEmpty, data.count.isMultiple(of: 2) else { return }
        do {
            if !engine.isRunning {
                engine.prepare()
                try engine.start()
            }
            let frameCount = AVAudioFrameCount(data.count / 2)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: frameCount) else { return }
            buffer.frameLength = frameCount
            let destination = buffer.mutableAudioBufferList.pointee.mBuffers
            guard let bytes = destination.mData else { return }
            data.copyBytes(to: bytes.assumingMemoryBound(to: UInt8.self), count: data.count)
            buffer.mutableAudioBufferList.pointee.mBuffers.mDataByteSize = UInt32(data.count)
            let generation = playbackGeneration
            pendingPlaybackBuffers += 1
            scheduledPlaybackFrames += AVAudioFramePosition(frameCount)
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                Task { @MainActor in self?.didFinishPlaybackBuffer(generation: generation) }
            }
            if !player.isPlaying { player.play() }
        } catch {
            clearPlayback()
            onError?(error)
        }
    }

    func clearPlayback() {
        playbackGeneration += 1
        pendingPlaybackBuffers = 0
        scheduledPlaybackFrames = 0
        playbackOriginFrame = 0
        player.stop()
        player.reset()
    }

    func stop() {
        stopCapture()
        clearPlayback()
        engine.stop()
    }

    private func didFinishPlaybackBuffer(generation: Int) {
        guard generation == playbackGeneration, pendingPlaybackBuffers > 0 else { return }
        pendingPlaybackBuffers -= 1
        if pendingPlaybackBuffers == 0 { onPlaybackDrained?() }
    }

    private func microphoneAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            true
        case .notDetermined:
            await AVCaptureDevice.requestAccess(for: .audio)
        default:
            false
        }
    }

    nonisolated private func consumeInput(_ input: AVAudioPCMBuffer, converter: AVAudioConverter) {
        let ratio = 24_000 / input.format.sampleRate
        let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 16
        guard
            let outputFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: 24_000,
                channels: 1,
                interleaved: true
            ),
            let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity)
        else { return }

        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return input
        }
        guard status != .error, conversionError == nil, output.frameLength > 0 else { return }
        let audioBuffer = output.audioBufferList.pointee.mBuffers
        guard let bytes = audioBuffer.mData else { return }
        let byteCount = Int(output.frameLength) * Int(outputFormat.streamDescription.pointee.mBytesPerFrame)
        let data = Data(bytes: bytes, count: byteCount)
        let level = Self.inputLevel(input)
        Task { @MainActor [weak self] in
            self?.onMicrophonePCM?(data)
            self?.onLevel?(level)
        }
    }

    nonisolated private static func inputLevel(_ buffer: AVAudioPCMBuffer) -> Double {
        guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        let samples = channels[0]
        let count = Int(buffer.frameLength)
        let stride = 8
        var sum = 0.0
        var measured = 0
        for index in Swift.stride(from: 0, to: count, by: stride) {
            let value = Double(samples[index])
            sum += value * value
            measured += 1
        }
        guard measured > 0 else { return 0 }
        return min(1, sqrt(sum / Double(measured)) * 7)
    }
}

enum AudioError: LocalizedError {
    case converterUnavailable
    case microphoneDenied
    case noInputDevice

    var errorDescription: String? {
        switch self {
        case .converterUnavailable:
            "The microphone format cannot be converted to 24 kHz PCM."
        case .microphoneDenied:
            "Microphone access is required. Enable Mamachi in System Settings > Privacy & Security > Microphone."
        case .noInputDevice:
            "No microphone input device is available."
        }
    }
}
