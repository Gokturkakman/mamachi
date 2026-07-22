import AppKit
import Combine
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var workspace: String
    @Published var daemonConnected = false
    @Published var voiceState: VoiceConnectionState = .disconnected
    @Published var isEngaged = false
    @Published var microphoneLevel = 0.0
    @Published var activeTaskId: String?
    @Published var queue: [String] = []
    @Published var tasks: [TaskViewState] = []
    @Published var pendingContexts: [CapturedContextViewState] = []
    @Published var transcripts: [TranscriptEntry] = []
    @Published var liveUserTranscript = ""
    @Published var liveAssistantTranscript = ""
    @Published var errorMessage: String?
    @Published var hasAPIKey = false
    @Published var needsAPIKey = false
    @Published var drawerExpanded = false
    var onOpenSettings: (() -> Void)?

    private let daemon = DaemonProcess()
    private let ipc = IpcClient()
    private let audio = AudioService()
    private let keychain = KeychainStore()
    private let transcriptStore: TranscriptStore?
    private var started = false
    private var pendingText: String?
    private var resumeEngagementAfterKey = false
    private var playbackStartedAt: TimeInterval?
    private var playbackMicrophoneBaseline = 0.0
    private var bargeInFrames = 0

    var activeTask: TaskViewState? {
        guard let activeTaskId else { return nil }
        return tasks.first(where: { $0.id == activeTaskId })
    }

    init() {
        transcriptStore = try? TranscriptStore()
        transcripts = (try? transcriptStore?.load()) ?? []
        hasAPIKey = ((try? keychain.loadAPIKey()) ?? nil) != nil
        workspace = UserDefaults.standard.string(forKey: "workspace")
            ?? ProcessInfo.processInfo.environment["MAMACHI_WORKSPACE"]
            ?? (try? DaemonProcess.projectRoot().path)
            ?? FileManager.default.homeDirectoryForCurrentUser.path

        ipc.onEvent = { [weak self] event in self?.handle(event) }
        ipc.onAudio = { [weak self] data in self?.handleAudioOutput(data) }
        ipc.onDisconnect = { [weak self] error in
            guard let self else { return }
            daemonConnected = false
            voiceState = .disconnected
            if let error { errorMessage = error.localizedDescription }
        }
        audio.onMicrophonePCM = { [weak self] data in
            guard
                let self,
                isEngaged,
                voiceState != .speaking,
                !audio.hasPendingPlayback
            else { return }
            ipc.sendAudio(data)
        }
        audio.onLevel = { [weak self] level in self?.handleMicrophoneLevel(level) }
        audio.onError = { [weak self] error in self?.errorMessage = "Audio playback failed: \(error.localizedDescription)" }
        audio.onPlaybackDrained = { [weak self] in self?.resumeMicrophoneIfReady() }
    }

    func start() {
        guard !started else { return }
        started = true
        Task {
            do {
                let ready = try await daemon.start(workspace: workspace)
                workspace = ready.workspace
                ipc.connect(port: ready.port, token: ready.token)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func stop() {
        isEngaged = false
        audio.stop()
        if daemonConnected { ipc.sendRequest(type: "voice.disconnect", payload: [:]) }
        ipc.disconnect()
        daemon.stop()
    }

    func toggleEngagement() {
        if isEngaged && voiceState == .speaking {
            bargeIn()
            return
        }
        if isEngaged {
            isEngaged = false
            audio.stopCapture()
            if voiceState == .listening { voiceState = .connected }
            return
        }
        isEngaged = true
        errorMessage = nil
        if voiceState == .connected || voiceState == .listening || voiceState == .thinking || voiceState == .speaking {
            startMicrophone()
        } else {
            connectVoice()
        }
    }

    func connectVoice() {
        guard daemonConnected else {
            isEngaged = false
            errorMessage = "Mamachi daemon is not connected."
            return
        }
        do {
            guard let apiKey = try keychain.loadAPIKey(), !apiKey.isEmpty else {
                resumeEngagementAfterKey = isEngaged
                isEngaged = false
                needsAPIKey = true
                errorMessage = "Add an OpenAI API key to start voice."
                openSettings()
                return
            }
            needsAPIKey = false
            voiceState = .connecting
            ipc.sendRequest(type: "voice.connect", payload: ["apiKey": apiKey])
        } catch {
            isEngaged = false
            errorMessage = error.localizedDescription
        }
    }

    func disconnectVoice() {
        isEngaged = false
        audio.stopCapture()
        audio.clearPlayback()
        ipc.sendRequest(type: "voice.disconnect", payload: [:])
        voiceState = .disconnected
    }

    func sendText(_ rawText: String) {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        appendTranscript(speaker: .user, text: text)
        if voiceState == .connected || voiceState == .listening || voiceState == .thinking || voiceState == .speaking {
            ipc.sendRequest(type: "voice.text", payload: ["text": text])
        } else {
            pendingText = text
            connectVoice()
        }
    }

    func saveAPIKey(_ rawKey: String) {
        let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if key.isEmpty {
                try keychain.deleteAPIKey()
                hasAPIKey = false
                disconnectVoice()
            } else {
                try keychain.saveAPIKey(key)
                hasAPIKey = true
                needsAPIKey = false
                let shouldEngage = resumeEngagementAfterKey
                resumeEngagementAfterKey = false
                if shouldEngage { isEngaged = true }
                if shouldEngage || pendingText != nil { connectVoice() }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func chooseWorkspace() {
        let panel = NSOpenPanel()
        panel.title = "Select a coding workspace"
        panel.prompt = "Use Workspace"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(filePath: workspace, directoryHint: .isDirectory)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        workspace = url.path
        UserDefaults.standard.set(workspace, forKey: "workspace")
        ipc.sendRequest(type: "workspace.select", payload: ["path": workspace])
    }

    func controlActiveTask(_ action: String) {
        guard let task = activeTask else { return }
        let type: String
        let payload: [String: Any]
        switch action {
        case "pause":
            type = "task.requestPause"
            payload = ["taskId": task.id, "reason": "Paused from the Mamachi task drawer"]
        case "resume":
            type = "task.resume"
            payload = ["taskId": task.id]
        case "cancel":
            type = "task.cancel"
            payload = ["taskId": task.id, "reason": "Cancelled from the Mamachi task drawer"]
        default:
            return
        }
        ipc.sendRequest(
            type: "command.execute",
            payload: [
                "command": [
                    "id": ProtocolID.makeV7(),
                    "type": type,
                    "actor": "ui",
                    "expectedRevision": task.revision,
                    "payload": payload,
                ],
            ]
        )
    }

    func clearTranscripts() {
        do {
            try transcriptStore?.clear()
            transcripts = []
            liveUserTranscript = ""
            liveAssistantTranscript = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func dismissError() {
        errorMessage = nil
    }
    func openSettings() {
        onOpenSettings?()
    }


    private func handleAudioOutput(_ data: Data) {
        if playbackStartedAt == nil {
            playbackStartedAt = ProcessInfo.processInfo.systemUptime
            playbackMicrophoneBaseline = 0
            bargeInFrames = 0
        }
        audio.play(pcm: data)
    }

    private func handleMicrophoneLevel(_ level: Double) {
        microphoneLevel = level
        guard
            isEngaged,
            voiceState == .speaking,
            let playbackStartedAt
        else { return }

        let elapsed = ProcessInfo.processInfo.systemUptime - playbackStartedAt
        if elapsed < 0.55 {
            playbackMicrophoneBaseline = playbackMicrophoneBaseline == 0
                ? level
                : playbackMicrophoneBaseline * 0.82 + level * 0.18
            return
        }

        let threshold = min(0.82, max(0.09, playbackMicrophoneBaseline * 1.28 + 0.035))
        if level > threshold {
            bargeInFrames += 1
        } else {
            bargeInFrames = 0
            playbackMicrophoneBaseline = playbackMicrophoneBaseline * 0.98 + level * 0.02
        }
        if bargeInFrames >= 4 { bargeIn() }
    }

    private func resetBargeInDetection() {
        playbackStartedAt = nil
        playbackMicrophoneBaseline = 0
        bargeInFrames = 0
    }

    private func resumeMicrophoneIfReady() {
        guard isEngaged, voiceState == .connected, !audio.hasPendingPlayback else { return }
        startMicrophone()
    }

    private func bargeIn() {
        resetBargeInDetection()
        audio.clearPlayback()
        ipc.sendRequest(type: "voice.interrupt", payload: [:])
        voiceState = .listening
        startMicrophone()
    }

    private func startMicrophone() {
        Task {
            do {
                try await audio.startCapture()
                if isEngaged { voiceState = .listening }
            } catch {
                isEngaged = false
                errorMessage = error.localizedDescription
            }
        }
    }

    private func handle(_ envelope: [String: Any]) {
        guard let type = envelope["type"] as? String else { return }
        let payload = envelope["payload"] as? [String: Any] ?? [:]
        switch type {
        case "server.ready":
            daemonConnected = true
        case "response":
            if payload["ok"] as? Bool == false {
                errorMessage = payload["error"] as? String ?? "Mamachi request failed."
                if voiceState == .connecting {
                    voiceState = .error
                    isEngaged = false
                }
            }
        case "state.snapshot":
            applySnapshot(payload["snapshot"] as? [String: Any])
        case "workspace.changed":
            if let path = payload["path"] as? String { workspace = path }
        case "context.captured":
            if
                let id = payload["id"] as? String,
                let kind = payload["kind"] as? String,
                let summary = payload["summary"] as? String,
                !pendingContexts.contains(where: { $0.id == id })
            {
                pendingContexts.append(CapturedContextViewState(id: id, kind: kind, summary: summary))
            }
        case "context.consumed":
            if let ids = payload["ids"] as? [String] {
                pendingContexts.removeAll(where: { ids.contains($0.id) })
            }
        case "voice.state":
            applyVoiceState(payload["state"] as? String)
        case "voice.interrupt":
            audio.clearPlayback()
        case "voice.error":
            voiceState = .error
            errorMessage = payload["error"] as? String ?? "OpenAI Realtime returned an error."
        case "voice.transcript.user_delta":
            if let text = payload["text"] as? String { liveUserTranscript += text }
        case "voice.transcript.user":
            if let text = payload["text"] as? String {
                liveUserTranscript = ""
                appendTranscript(speaker: .user, text: text)
            }
        case "voice.transcript.assistant_delta":
            if let text = payload["text"] as? String { liveAssistantTranscript += text }
        case "voice.transcript.assistant":
            if let text = payload["text"] as? String {
                liveAssistantTranscript = ""
                appendTranscript(speaker: .mamachi, text: text)
            }
        case "coder.initializing", "coder.ready", "coder.running", "coder.tool_started", "coder.tool_finished", "coder.message":
            applyCoderActivity(type: type, payload: payload)
        default:
            break
        }
    }

    private func applyVoiceState(_ state: String?) {
        switch state {
        case "connecting": voiceState = .connecting
        case "connected", "idle":
            voiceState = .connected
            resetBargeInDetection()
            if let pendingText {
                self.pendingText = nil
                ipc.sendRequest(type: "voice.text", payload: ["text": pendingText])
            }
            resumeMicrophoneIfReady()
        case "listening": voiceState = .listening
        case "thinking": voiceState = .thinking
        case "speaking": voiceState = .speaking
        case "disconnected":
            resetBargeInDetection()
            voiceState = .disconnected
        default: break
        }
    }

    private func applySnapshot(_ rawSnapshot: [String: Any]?) {
        guard let rawSnapshot else { return }
        activeTaskId = rawSnapshot["activeTaskId"] as? String
        queue = rawSnapshot["queue"] as? [String] ?? []
        guard let rawTasks = rawSnapshot["tasks"] as? [[String: Any]] else { return }
        let activityByID = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0.recentActivity) })
        tasks = rawTasks.compactMap { rawTask in
            guard
                let id = rawTask["id"] as? String,
                let state = rawTask["state"] as? String,
                let revision = rawTask["revision"] as? Int,
                let spec = rawTask["spec"] as? [String: Any],
                let objective = spec["objective"] as? String
            else { return nil }
            return TaskViewState(
                id: id,
                state: state,
                revision: revision,
                objective: objective,
                terminalSummary: rawTask["terminalSummary"] as? String,
                recentActivity: activityByID[id] ?? nil
            )
        }
    }

    private func applyCoderActivity(type: String, payload: [String: Any]) {
        guard let taskId = payload["taskId"] as? String, let index = tasks.firstIndex(where: { $0.id == taskId }) else { return }
        let summary: String
        if let toolName = payload["toolName"] as? String {
            summary = type == "coder.tool_started" ? "Running \(toolName)" : "Finished \(toolName)"
        } else if let text = payload["text"] as? String {
            summary = text
        } else if let model = payload["model"] as? String {
            summary = "Coding with \(model)"
        } else {
            summary = type.replacingOccurrences(of: "coder.", with: "").replacingOccurrences(of: "_", with: " ").capitalized
        }
        tasks[index].recentActivity = String(summary.prefix(500))
    }

    private func appendTranscript(speaker: TranscriptEntry.Speaker, text: String) {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        if let last = transcripts.last, last.speaker == speaker, last.text == normalized { return }
        transcripts.append(TranscriptEntry(id: UUID(), speaker: speaker, text: normalized, at: Date()))
        do {
            try transcriptStore?.save(transcripts)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
