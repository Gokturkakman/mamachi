import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var apiKey = ""

    var body: some View {
        Form {
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
                    Label(model.hasAPIKey ? "Stored locally" : "Not configured", systemImage: model.hasAPIKey ? "checkmark.shield.fill" : "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(model.hasAPIKey ? .green : .secondary)
                }
                Text("The key is stored in macOS Keychain and sent only to the authenticated local daemon, which connects directly to OpenAI.")
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

            Section("Voice session") {
                HStack {
                    Text("Status")
                    Spacer()
                    Text(model.voiceState.label).foregroundStyle(.secondary)
                }
                HStack {
                    Button("Connect") { model.connectVoice() }
                        .disabled(!model.hasAPIKey || !model.daemonConnected)
                    Button("Disconnect") { model.disconnectVoice() }
                        .disabled(model.voiceState == .disconnected)
                    Spacer()
                    Text("⌘⇧Space toggles the microphone")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Local conversation history") {
                HStack {
                    Text("\(model.transcripts.count) saved turns")
                    Spacer()
                    Button("Clear History", role: .destructive) { model.clearTranscripts() }
                        .disabled(model.transcripts.isEmpty)
                }
                Text("Transcripts remain on this Mac until cleared. Raw audio is never persisted.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let error = model.errorMessage {
                Section("Needs attention") {
                    Text(error).foregroundStyle(.red)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 560, height: 460)
        .padding(8)
    }
}
