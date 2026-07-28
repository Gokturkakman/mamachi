@preconcurrency import AVFoundation
import Foundation

@MainActor
final class AudioService {
    var onMicrophonePCM: ((Data) -> Void)?
    var onLevel: ((Double) -> Void)?
    var onError: ((Error) -> Void)?
    var onPlaybackDrained: (() -> Void)?
    var onPlaybackLevel: ((Double) -> Void)?

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 24_000,
        channels: 1,
        interleaved: true
    )!
    private var converter: AVAudioConverter?
    private var playbackConfigured = false
    private var capturing = false
    private var voiceProcessingConfigured = false
    private var playbackGeneration = 0
    private var pendingPlaybackBuffers = 0
    private var scheduledPlaybackFrames: AVAudioFramePosition = 0
    private var playbackOriginFrame: AVAudioFramePosition = 0
    private var configurationObserver: (any NSObjectProtocol)?
    private var captureWatchdog: Task<Void, Never>?
    /// True from `startCapture` until `stopCapture`: recovery rebuilds
    /// capture from this intent, never from the transient `capturing` state.
    private var captureIntended = false
    private var recoveryErrorReported = false
    var isPlaying: Bool { player.isPlaying }
    var hasPendingPlayback: Bool { pendingPlaybackBuffers > 0 }
    var isPlaybackAvailable: Bool {
        let format = engine.outputNode.outputFormat(forBus: 0)
        return format.channelCount > 0 && format.sampleRate > 0
    }
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
        // Device/route changes (AirPods, headphones, sleep/wake) stop the
        // engine silently; without recovery the session goes deaf until the
        // next disengage/engage cycle. Playback wiring stays lazy: constructing
        // AppModel must not require an output device, including in headless CI.
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            Task { @MainActor in self?.handleAudioEngineConfigurationChange() }
        }
    }

    func startCapture() async throws {
        guard !capturing else { return }
        guard await microphoneAccess() else { throw AudioError.microphoneDenied }
        captureIntended = true
        do {
            try activateCapture()
        } catch {
            captureIntended = false
            throw error
        }
    }

    /// Installs the input tap against the CURRENT device format and starts
    /// the engine. Split from `startCapture` so route-change recovery can
    /// re-arm capture without repeating the permission check.
    private func activateCapture() throws {
        let input = engine.inputNode
        if !voiceProcessingConfigured {
            try input.setVoiceProcessingEnabled(true)
            voiceProcessingConfigured = true
        }
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
            throw AudioError.noInputDevice
        }
        guard let converter = Self.makeWireConverter(from: inputFormat) else {
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
        startCaptureWatchdog()
    }

    func stopCapture() {
        captureIntended = false
        recoveryErrorReported = false
        captureWatchdog?.cancel()
        captureWatchdog = nil
        guard capturing else { return }
        engine.inputNode.removeTap(onBus: 0)
        converter = nil
        capturing = false
        onLevel?(0)
    }

    /// Notification entry point. Configuration changes also fire for benign
    /// reconfigurations (voice-processing enable during the first capture,
    /// format renegotiation) while the engine keeps running — tearing down a
    /// healthy tap on those made engagement go deaf. Only a stopped engine
    /// is a real death.
    func handleAudioEngineConfigurationChange() {
        guard !engine.isRunning else { return }
        recoverStoppedEngine()
    }

    /// Repairs a dead engine. Two failure modes:
    /// 1. Scheduled playback completions never fire once the engine stops,
    ///    so `pendingPlaybackBuffers` wedges above zero and the microphone
    ///    PCM gate in AppModel stays closed forever.
    /// 2. The input tap and converter hold the OLD device format, so capture
    ///    silently delivers nothing on the new device.
    /// Rebuild is driven by INTENT, not by `capturing`: a failed attempt
    /// (formats are transiently unusable mid-transition) leaves the watchdog
    /// retrying until the route settles.
    func recoverStoppedEngine() {
        let hadPlayback = pendingPlaybackBuffers > 0 || player.isPlaying
        if hadPlayback { clearPlayback() }
        if captureIntended {
            if capturing {
                engine.inputNode.removeTap(onBus: 0)
                converter = nil
                capturing = false
            }
            do {
                try activateCapture()
                recoveryErrorReported = false
            } catch {
                // Report the first failure only; the 3 s watchdog keeps
                // retrying silently until the device settles.
                if !recoveryErrorReported {
                    recoveryErrorReported = true
                    onError?(error)
                }
            }
        }
        // After capture is re-armed: lets AppModel resume its normal
        // microphone flow (the pending-playback gate is now open).
        if hadPlayback { onPlaybackDrained?() }
    }

    /// Some engine deaths never post a configuration change (observed with
    /// device unplug races); poll cheaply while capture is supposed to run.
    private func startCaptureWatchdog() {
        captureWatchdog?.cancel()
        captureWatchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard let self, !Task.isCancelled else { return }
                if self.captureIntended, !self.capturing || !self.engine.isRunning {
                    self.recoverStoppedEngine()
                }
            }
        }
    }

    private func configurePlaybackIfNeeded() throws {
        guard !playbackConfigured else { return }
        guard isPlaybackAvailable else { throw AudioError.noOutputDevice }
        engine.connect(player, to: engine.mainMixerNode, format: wireFormat)
        // Real-time playout loudness for the collapsed pill's waveform: tap
        // the mixer output (what actually reaches the speaker right now, not
        // audio as it arrives from the network) and mirror microphone level
        // normalization.
        let playerNode = player
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1_024, format: nil) { [weak self, playerNode] buffer, _ in
            guard playerNode.isPlaying else { return }
            let level = Self.normalizedLevel(buffer)
            Task { @MainActor in self?.onPlaybackLevel?(level) }
        }
        playbackConfigured = true
    }

    func beginPlaybackItem() {
        playbackOriginFrame = scheduledPlaybackFrames
    }

    func play(pcm data: Data) {
        guard !data.isEmpty, data.count.isMultiple(of: 2) else { return }
        do {
            try configurePlaybackIfNeeded()
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

    /// Builds the capture-side converter to the 24 kHz int16 mono wire
    /// format. The channel map is pinned to channel 0: multi-channel
    /// voice-processing inputs (Mac mic arrays) carry beamforming residue in
    /// the other channels, and the converter's default downmix averages them
    /// — near-inverted phases cancel to digital silence, which shipped
    /// zero-RMS audio to STT while the channel-0-based level meter looked
    /// perfectly alive.
    nonisolated static func makeWireConverter(from inputFormat: AVAudioFormat) -> AVAudioConverter? {
        let wire = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 24_000,
            channels: 1,
            interleaved: true
        )!
        guard let converter = AVAudioConverter(from: inputFormat, to: wire) else { return nil }
        converter.channelMap = [0]
        return converter
    }

    nonisolated private func consumeInput(_ input: AVAudioPCMBuffer, converter: AVAudioConverter) {
        guard let data = Self.convertToWire(input, using: converter) else { return }
        let level = Self.normalizedLevel(input)
        Task { @MainActor [weak self] in
            self?.onMicrophonePCM?(data)
            self?.onLevel?(level)
        }
    }

    /// Converts one tap buffer to wire PCM. Pure and static so the
    /// channel-pinning regression test exercises the exact production path.
    nonisolated static func convertToWire(_ input: AVAudioPCMBuffer, using converter: AVAudioConverter) -> Data? {
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
        else { return nil }

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
        guard status != .error, conversionError == nil, output.frameLength > 0 else { return nil }
        let audioBuffer = output.audioBufferList.pointee.mBuffers
        guard let bytes = audioBuffer.mData else { return nil }
        let byteCount = Int(output.frameLength) * Int(outputFormat.streamDescription.pointee.mBytesPerFrame)
        return Data(bytes: bytes, count: byteCount)
    }

    nonisolated private static func normalizedLevel(_ buffer: AVAudioPCMBuffer) -> Double {
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
    case noOutputDevice

    var errorDescription: String? {
        switch self {
        case .converterUnavailable:
            "The microphone format cannot be converted to 24 kHz PCM."
        case .microphoneDenied:
            "Microphone access is required. Enable Mamachi in System Settings > Privacy & Security > Microphone."
        case .noInputDevice:
            "No microphone input device is available."
        case .noOutputDevice:
            "No audio output device is available."
        }
    }
}
