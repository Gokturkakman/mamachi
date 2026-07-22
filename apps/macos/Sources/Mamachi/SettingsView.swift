import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var apiKey = ""
    @State private var primaryModel: String
    @State private var fastModel: String
    @State private var thinkingLevel: String
    @State private var automaticRouting: Bool

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

    init(model: AppModel) {
        self.model = model
        _primaryModel = State(initialValue: model.primaryCodingModel)
        _fastModel = State(initialValue: model.fastCodingModel)
        _thinkingLevel = State(initialValue: model.codingThinkingLevel)
        _automaticRouting = State(initialValue: model.automaticModelRouting)
    }

    var body: some View {
        Form {
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

            Section("Coding agent") {
                TextField("Primary model — blank uses OMP default", text: $primaryModel)
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
                    Text("Model selectors use OMP's provider/model format.")
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

            Section("Task reactions") {
                Toggle("Notify when the coder needs input", isOn: attentionNotifications)
                Toggle("Notify when a task finishes or fails", isOn: completionNotifications)
                Toggle("Play reaction sounds", isOn: reactionSounds)
                Text("Notifications identify the task state without interrupting an active conversation.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("OpenAI Realtime") {
                SecureField(model.hasAPIKey ? "Key stored in Keychain" : "sk-…", text: $apiKey)
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
                    Label(
                        model.hasAPIKey ? "Stored locally" : "Not configured",
                        systemImage: model.hasAPIKey ? "checkmark.shield.fill" : "exclamationmark.triangle"
                    )
                    .font(.caption)
                    .foregroundStyle(model.hasAPIKey ? .green : .secondary)
                }
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
                    Text("⌘⇧Space starts voice mode")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Text("\(model.transcripts.count) saved turns")
                    Spacer()
                    Button("Clear History", role: .destructive) { model.clearTranscripts() }
                        .disabled(model.transcripts.isEmpty)
                }
            }

            if let error = model.errorMessage {
                Section("Needs attention") {
                    Text(error).foregroundStyle(.red)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 560, height: 620)
        .padding(8)
    }

    private var interactionMode: Binding<InteractionMode> {
        Binding(get: { model.interactionMode }, set: model.setInteractionMode)
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
