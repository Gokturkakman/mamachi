import SwiftUI

private struct DiagnosticPreviewPayload: Identifiable {
    let id = UUID()
    let data: Data
}

struct PrivacySettingsView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var diagnostics: DiagnosticsService
    @State private var provider: CodingProvider = .anthropic
    @State private var credential = ""
    @State private var credentialStored = false
    @State private var statusMessage = ""
    @State private var previewPayload: DiagnosticPreviewPayload?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Coding provider", selection: $provider) {
                ForEach(CodingProvider.allCases) { provider in Text(provider.label).tag(provider) }
            }
            .onChange(of: provider) { _, _ in refreshCredentialStatus() }
            SecureField(credentialStored ? "Credential stored in Keychain" : "Provider API key", text: $credential)
                .textContentType(.password)
            HStack {
                Button(credentialStored ? "Replace Coding Key" : "Save Coding Key") { saveCredential() }
                    .disabled(credential.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if credentialStored {
                    Button("Remove", role: .destructive) { removeCredential() }
                }
                Spacer()
                Label(credentialStored ? "Stored in Keychain" : "Not configured", systemImage: credentialStored ? "checkmark.shield.fill" : "key")
                    .font(.caption)
                    .foregroundStyle(credentialStored ? .green : .secondary)
            }

            Divider()
            Text("Mamachi keeps its application encryption key in Keychain. Local transcripts, captured editor payloads, evidence payloads, and observer notes are encrypted at rest.")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Diagnostics")
                    Text("Preview the aggressively redacted JSON before choosing a file to export.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Preview…") { makePreview() }
            }
            if !statusMessage.isEmpty {
                Text(statusMessage).font(.caption).foregroundStyle(.secondary)
            }
        }
        .onAppear(perform: refreshCredentialStatus)
        .sheet(item: $previewPayload) { payload in
            DiagnosticsPreviewView(data: payload.data)
        }
    }

    private func refreshCredentialStatus() {
        do {
            credentialStored = try KeychainStore().loadCodingCredential(for: provider) != nil
            statusMessage = ""
        } catch {
            credentialStored = false
            statusMessage = error.localizedDescription
        }
    }

    private func saveCredential() {
        let value = credential.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        do {
            try KeychainStore().saveCodingCredential(value, for: provider)
            credential = ""
            credentialStored = true
            statusMessage = "Credential saved. Restart Mamachi before starting coding tasks with this provider."
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    private func removeCredential() {
        do {
            try KeychainStore().deleteCodingCredential(for: provider)
            credentialStored = false
            credential = ""
            statusMessage = "Credential removed from Keychain."
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    private func makePreview() {
        diagnostics.recordTransition(
            component: .daemon,
            from: .unknown,
            to: model.daemonConnected ? .connected : .disconnected,
            elapsedMilliseconds: 0
        )
        do {
            previewPayload = DiagnosticPreviewPayload(data: try diagnostics.previewData())
            statusMessage = "Review the preview; export is available only inside it."
        } catch {
            statusMessage = error.localizedDescription
        }
    }
}
