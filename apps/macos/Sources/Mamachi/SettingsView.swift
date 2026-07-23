import AppKit
import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var diagnostics: DiagnosticsService
    @State private var apiKey = ""
    @State private var codingProvider: CodingProvider = .anthropic
    @State private var codingCredential = ""
    @State private var primaryModel: String
    @State private var fastModel: String
    @State private var thinkingLevel: String
    @State private var automaticRouting: Bool
    @State private var globeKeyConflict: String?

    private let thinkingLevels = [
        ("inherit", "OMP default"),
        ("auto", "Automatic"),
        ("off", "Off"),
        ("minimal", "Minimal"),
        ("low", "Low"),
        ("medium", "Medium"),
        ("high", "High"),
        ("xhigh", "Extra high"),
        ("max", "Maximum"),
    ]

    init(model: AppModel, diagnostics: DiagnosticsService) {
        self.model = model
        self.diagnostics = diagnostics
        _primaryModel = State(initialValue: model.primaryCodingModel)
        _fastModel = State(initialValue: model.fastCodingModel)
        _thinkingLevel = State(initialValue: model.codingThinkingLevel)
        _automaticRouting = State(initialValue: model.automaticModelRouting)
    }

    var body: some View {
        Form {
            Section("Setup") {
                HStack {
                    Label(
                        model.hasAPIKey ? "Voice and chat ready" : "OpenAI Realtime key required",
                        systemImage: model.hasAPIKey ? "checkmark.circle.fill" : "exclamationmark.circle.fill"
                    )
                    .foregroundStyle(model.hasAPIKey ? .green : .orange)
                    Spacer()
                    Label(
                        model.selectedCodingAgentStatus.ready
                            ? "\(model.codingAgentBackend.label) ready"
                            : "Coding agent setup required",
                        systemImage: model.selectedCodingAgentStatus.ready
                            ? "checkmark.circle.fill"
                            : "exclamationmark.circle.fill"
                    )
                    .foregroundStyle(model.selectedCodingAgentStatus.ready ? .green : .orange)
                }
                Text("Both services must show ready before Mamachi can handle a coding request end to end.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("OpenAI Realtime — voice and chat") {
                SecureField(model.hasAPIKey ? "Key stored in Keychain" : "OpenAI API key", text: $apiKey)
                    .textContentType(.password)
                HStack {
                    Button(model.hasAPIKey ? "Replace Key" : "Save Key") {
                        model.saveAPIKey(apiKey)
                        apiKey = ""
                    }
                    .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if model.hasAPIKey {
                        Button("Remove", role: .destructive) { model.saveAPIKey("") }
                    }
                    Spacer()
                    Text(model.hasAPIKey ? "Stored in macOS Keychain" : "Required")
                        .font(.caption)
                        .foregroundStyle(model.hasAPIKey ? .green : .orange)
                }
            }

            Section("Coding agent") {
                Picker("Backend", selection: codingBackend) {
                    ForEach(CodingAgentBackend.allCases) { backend in
                        Text(backend.label).tag(backend)
                    }
                }
                .pickerStyle(.segmented)

                let status = model.selectedCodingAgentStatus
                HStack {
                    Label(status.detail, systemImage: status.ready ? "checkmark.circle.fill" : "exclamationmark.circle")
                        .foregroundStyle(status.ready ? .green : .orange)
                    Spacer()
                    Button("Refresh") { Task { await model.refreshCodingAgentStatuses() } }
                    if !status.ready {
                        Button(status.executablePath == nil ? "Install and Log In" : "Log In") {
                            model.openCodingAgentSetup(model.codingAgentBackend)
                        }
                    }
                }

                if model.codingAgentBackend == .omp {
                    DisclosureGroup("Optional API-key fallback") {
                        Picker("Provider", selection: $codingProvider) {
                            ForEach(CodingProvider.allCases) { provider in Text(provider.label).tag(provider) }
                        }
                        SecureField("Provider API key", text: $codingCredential)
                            .textContentType(.password)
                        HStack {
                            Text("Not needed when OMP already has a provider login.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button("Save Provider Key") {
                                if model.saveCodingProviderCredential(codingCredential, for: codingProvider) {
                                    codingCredential = ""
                                }
                            }
                            .disabled(codingCredential.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                }

                DisclosureGroup("Advanced model routing") {
                    TextField("Primary model — blank uses backend default", text: $primaryModel)
                        .textFieldStyle(.roundedBorder)
                    TextField("Fast model", text: $fastModel)
                        .textFieldStyle(.roundedBorder)
                    Picker("Thinking level", selection: $thinkingLevel) {
                        ForEach(thinkingLevels, id: \.0) { value, label in
                            Text(label).tag(value)
                        }
                    }
                    Toggle("Route easy and research tasks to the fast model", isOn: $automaticRouting)
                    HStack {
                        Text("Provider/model selectors apply to OMP; direct CLIs use matching or backend-default models.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Apply to next task") {
                            model.updateRuntimeSettings(
                                primaryModel: primaryModel,
                                fastModel: fastModel,
                                thinkingLevel: thinkingLevel,
                                automaticRouting: automaticRouting
                            )
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }

            Section("Interaction") {
                Picker("Response mode", selection: interactionMode) {
                    ForEach(InteractionMode.allCases) { mode in
                        Label(mode.label, systemImage: mode.systemImage).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                Text(
                    model.interactionMode == .voice
                        ? "Mamachi answers aloud and the orb controls the microphone."
                        : "Chat mode accepts typed messages and never requests spoken output."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            Section("Computer control") {
                Picker("Access profile", selection: computerControlProfile) {
                    ForEach(ComputerControlProfile.selectable) { profile in
                        Text(profile.label).tag(profile)
                    }
                    if ComputerControlProfile.matching(model.computerCapabilities) == .custom {
                        Text("Custom").tag(ComputerControlProfile.custom)
                    }
                }
                .pickerStyle(.segmented)

                DisclosureGroup("Individual capabilities") {
                    ForEach(ComputerCapability.allCases) { capability in
                        Toggle(isOn: capabilityBinding(capability)) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(capability.label)
                                Text(capability.detail)
                                    .font(.caption)
                                    .foregroundStyle(capability.isElevated ? Color.orange : Color.secondary)
                            }
                        }
                    }
                }

                Picker("Confirmation", selection: computerConfirmationMode) {
                    ForEach(ComputerConfirmationMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }

                if model.computerCapabilities.contains(.appleScript)
                    || model.computerCapabilities.contains(.shell)
                {
                    Label(
                        "Full access can run unrestricted automation outside the coding workspace.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                } else {
                    Text("Only enabled categories can execute. Changes apply immediately.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                HStack {
                    Text("Keyboard, pointer, window, and UI inspection require Accessibility access.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Open Accessibility Settings") { model.openAccessibilitySettings() }
                }
            }

            Section("Activation") {
                Picker("Wake key", selection: activationKey) {
                    ForEach(ActivationKey.allCases) { key in
                        Text(key.label).tag(key)
                    }
                }
                .help("Bare modifier key that wakes voice mode")
                Text("Double-tap the wake key for hands-free voice, hold it for push-to-talk, and tap again to stop. ⌥Space always works as a fallback.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if model.activationKey != .off {
                    if model.activationMonitorActive {
                        HStack(spacing: 6) {
                            Circle().fill(.green).frame(width: 8, height: 8)
                            Text("Wake key active")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Wake key active")
                    } else {
                        HStack {
                            Label(
                                "Needs Accessibility access — grant it in System Settings, then reopen Settings",
                                systemImage: "exclamationmark.triangle"
                            )
                            .font(.caption)
                            .foregroundStyle(.orange)
                            Spacer()
                            Button("Open Accessibility Settings") { model.openAccessibilitySettings() }
                        }
                    }
                }

                if model.activationKey == .fn, let hint = globeKeyConflict {
                    HStack(alignment: .top) {
                        Label(hint, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                        Spacer()
                        Button("Open Keyboard Settings") { GlobeKeyUsage.openKeyboardSettings() }
                            .help("Opens the macOS Keyboard settings pane")
                    }
                }
            }

            Section("Overlay") {
                Picker("Collapsed indicator", selection: collapsedOverlaySize) {
                    ForEach(OverlaySizePreset.allCases) { preset in
                        Text(preset.label).tag(preset)
                    }
                }
                .pickerStyle(.segmented)

                Picker("Expanded panel", selection: expandedOverlaySize) {
                    ForEach(OverlaySizePreset.allCases) { preset in
                        Text(preset.label).tag(preset)
                    }
                }
                .pickerStyle(.segmented)

                HStack {
                    Text(
                        "Collapsed \(model.collapsedOverlaySize.collapsedDimensions) · "
                            + "Expanded \(model.expandedOverlaySize.expandedDimensions)"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Spacer()
                    Button("Reset Position") { model.resetOverlayFrame() }
                }

                Text("Sizes apply immediately and remain selected until you change them here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }


            Section("Task reactions") {
                Toggle("Notify when the coder needs input", isOn: attentionNotifications)
                Toggle("Notify when a task finishes or fails", isOn: completionNotifications)
                Toggle("Play reaction sounds", isOn: reactionSounds)
                Text("Notifications identify the task state without interrupting an active conversation.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }


            Section("Workspace") {
                HStack {
                    Image(systemName: "folder")
                    Text(model.workspace)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button("Choose…") { model.chooseWorkspace() }
                }
            }

            Section("Session") {
                HStack {
                    Text("Realtime status")
                    Spacer()
                    Text(model.voiceState.label).foregroundStyle(.secondary)
                }
                HStack {
                    Button("Connect") { model.connectVoice() }
                        .disabled(!model.hasAPIKey || !model.daemonConnected)
                    Button("Disconnect") { model.disconnectVoice() }
                        .disabled(model.voiceState == .disconnected)
                    Spacer()
                    Text("⌥Space starts voice mode")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Text("\(model.transcripts.count) saved turns")
                    Spacer()
                    Button("Clear History", role: .destructive) { model.clearTranscripts() }
                        .disabled(model.transcripts.isEmpty)
                }
                HStack {
                    Text("Application")
                    Spacer()
                    Button("Quit Mamachi", role: .destructive, action: model.quitApplication)
                        .keyboardShortcut("q", modifiers: .command)
                }
            }

            Section("Privacy & Diagnostics") {
                PrivacySettingsView(model: model, diagnostics: diagnostics)
            }

            if let error = model.errorMessage {
                Section("Needs attention") {
                    Text(error).foregroundStyle(.red)
                }
            }
        }
        .formStyle(.grouped)
        .scrollIndicators(.visible)
        .task { await model.refreshCodingAgentStatuses() }
        .onAppear { globeKeyConflict = GlobeKeyUsage.conflictHint() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            globeKeyConflict = GlobeKeyUsage.conflictHint()
        }
        .frame(width: 600, height: 760)
        .padding(8)
    }

    private var codingBackend: Binding<CodingAgentBackend> {
        Binding(get: { model.codingAgentBackend }, set: model.selectCodingBackend)
    }

    private var interactionMode: Binding<InteractionMode> {
        Binding(get: { model.interactionMode }, set: model.setInteractionMode)
    }

    private var activationKey: Binding<ActivationKey> {
        Binding(get: { model.activationKey }, set: model.setActivationKey)
    }

    private var collapsedOverlaySize: Binding<OverlaySizePreset> {
        Binding(get: { model.collapsedOverlaySize }, set: model.setCollapsedOverlaySize)
    }

    private var expandedOverlaySize: Binding<OverlaySizePreset> {
        Binding(get: { model.expandedOverlaySize }, set: model.setExpandedOverlaySize)
    }

    private var computerControlProfile: Binding<ComputerControlProfile> {
        Binding(
            get: { ComputerControlProfile.matching(model.computerCapabilities) },
            set: { profile in
                guard let capabilities = profile.capabilities else { return }
                model.updateComputerControlSettings(
                    capabilities: capabilities,
                    confirmationMode: model.computerConfirmationMode
                )
            }
        )
    }

    private var computerConfirmationMode: Binding<ComputerConfirmationMode> {
        Binding(
            get: { model.computerConfirmationMode },
            set: {
                model.updateComputerControlSettings(
                    capabilities: model.computerCapabilities,
                    confirmationMode: $0
                )
            }
        )
    }

    private func capabilityBinding(_ capability: ComputerCapability) -> Binding<Bool> {
        Binding(
            get: { model.computerCapabilities.contains(capability) },
            set: { enabled in
                var capabilities = model.computerCapabilities
                if enabled {
                    capabilities.insert(capability)
                } else {
                    capabilities.remove(capability)
                }
                model.updateComputerControlSettings(
                    capabilities: capabilities,
                    confirmationMode: model.computerConfirmationMode
                )
            }
        )
    }

    private var attentionNotifications: Binding<Bool> {
        Binding(
            get: { model.notifyOnAttention },
            set: { model.updateReactionSettings(
                attention: $0,
                completion: model.notifyOnCompletion,
                sounds: model.reactionSoundsEnabled
            ) }
        )
    }

    private var completionNotifications: Binding<Bool> {
        Binding(
            get: { model.notifyOnCompletion },
            set: { model.updateReactionSettings(
                attention: model.notifyOnAttention,
                completion: $0,
                sounds: model.reactionSoundsEnabled
            ) }
        )
    }

    private var reactionSounds: Binding<Bool> {
        Binding(
            get: { model.reactionSoundsEnabled },
            set: { model.updateReactionSettings(
                attention: model.notifyOnAttention,
                completion: model.notifyOnCompletion,
                sounds: $0
            ) }
        )
    }
}

/// Reads macOS's "Press Globe key to" assignment (com.apple.HIToolbox,
/// AppleFnUsageType: 0 = Do Nothing, 1 = Change Input Source, 2 = Show Emoji
/// & Symbols, 3 = Start Dictation) so Fn wake-key users can be warned about
/// gestures racing the system. Read fresh on every call — it is a cheap
/// preference lookup and the user may change it in System Settings while
/// Mamachi is open.
enum GlobeKeyUsage {
    /// Full warning text when the Globe key is bound to a system action, or
    /// nil when it is set to Do Nothing. A missing or unrecognized preference
    /// value yields a generic hint.
    static func conflictHint() -> String? {
        let remedy = "Set 'Press Globe key to' to 'Do Nothing' and disable the "
            + "double-Fn Dictation shortcut so it doesn't race Mamachi."
        let action: String
        switch CFPreferencesCopyAppValue("AppleFnUsageType" as CFString, "com.apple.HIToolbox" as CFString) as? Int {
        case 0:
            return nil
        case 1:
            action = "Change Input Source"
        case 2:
            action = "Show Emoji & Symbols"
        case 3:
            action = "Start Dictation"
        default:
            return "macOS may bind the Globe key to a system action. \(remedy)"
        }
        return "macOS currently uses the Globe key for \(action). \(remedy)"
    }

    static func openKeyboardSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension") else { return }
        NSWorkspace.shared.open(url)
    }
}
