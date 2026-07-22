import AppKit
import ApplicationServices
import AVFoundation
import Foundation
import SwiftUI
import UserNotifications

enum OnboardingStep: Int, CaseIterable {
    case microphone
    case notifications
    case accessibility
    case vscode
    case realtimeCredential
    case codingCredential

    var title: String {
        switch self {
        case .microphone: "Microphone"
        case .notifications: "Notifications"
        case .accessibility: "Accessibility"
        case .vscode: "VS Code integration"
        case .realtimeCredential: "OpenAI Realtime"
        case .codingCredential: "Coding provider"
        }
    }
}

@MainActor
final class OnboardingModel: ObservableObject {
    static let completionDefaultsKey = "onboardingCompletedVersion"
    static let currentVersion = 1

    @Published var step: OnboardingStep = .microphone
    @Published var statusMessage = ""
    @Published var realtimeKey = ""
    @Published var codingCredential = ""
    @Published var codingProvider: CodingProvider = .anthropic
    @Published private(set) var isWorking = false
    @Published private(set) var vscodeInstalled = false
    @Published private(set) var vscodeExtensionInstalled = false

    private let appModel: AppModel
    private let keychain: KeychainStore
    private let onComplete: () -> Void

    init(appModel: AppModel, keychain: KeychainStore = KeychainStore(), onComplete: @escaping () -> Void) {
        self.appModel = appModel
        self.keychain = keychain
        self.onComplete = onComplete
        refreshVSCodeStatus()
    }

    static var isComplete: Bool {
        UserDefaults.standard.integer(forKey: completionDefaultsKey) >= currentVersion
    }

    var progress: Double {
        Double(step.rawValue + 1) / Double(OnboardingStep.allCases.count)
    }

    func requestMicrophone() {
        isWorking = true
        Task {
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            statusMessage = granted ? "Microphone access granted." : "Microphone access was not granted. You can enable it later in System Settings."
            isWorking = false
            advance()
        }
    }

    func requestNotifications() {
        isWorking = true
        Task {
            do {
                let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
                statusMessage = granted ? "Notifications enabled." : "Notifications were not enabled."
            } catch {
                statusMessage = "Notification permission could not be requested: \(error.localizedDescription)"
            }
            isWorking = false
            advance()
        }
    }

    func promptForAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    func openAccessibilitySettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") else { return }
        NSWorkspace.shared.open(url)
    }

    func refreshVSCodeStatus() {
        vscodeInstalled = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode") != nil
        let extensions = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".vscode/extensions")
        let names = (try? FileManager.default.contentsOfDirectory(atPath: extensions.path)) ?? []
        vscodeExtensionInstalled = names.contains { $0 == "mamachi.mamachi-vscode" || $0.hasPrefix("mamachi.mamachi-vscode-") }
    }

    func openVSCode() {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode") else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: .init())
    }

    func installBundledVSCodeExtension() {
        do {
            guard let resources = Bundle.main.resourceURL else {
                throw OnboardingError.bundledExtensionMissing
            }
            let source = resources.appending(path: "vscode-extension", directoryHint: .isDirectory)
            guard FileManager.default.fileExists(atPath: source.appending(path: "package.json").path) else {
                throw OnboardingError.bundledExtensionMissing
            }
            let extensions = FileManager.default.homeDirectoryForCurrentUser
                .appending(path: ".vscode/extensions", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: extensions, withIntermediateDirectories: true)
            for name in try FileManager.default.contentsOfDirectory(atPath: extensions.path)
            where name == "mamachi.mamachi-vscode" || name.hasPrefix("mamachi.mamachi-vscode-") {
                try FileManager.default.removeItem(at: extensions.appending(path: name, directoryHint: .isDirectory))
            }
            let manifestData = try Data(contentsOf: source.appending(path: "package.json"))
            let manifest = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any]
            let version = manifest?["version"] as? String ?? "0.1.0"
            let destination = extensions.appending(
                path: "mamachi.mamachi-vscode-\(version)",
                directoryHint: .isDirectory
            )
            try FileManager.default.copyItem(at: source, to: destination)
            refreshVSCodeStatus()
            statusMessage = "Mamachi’s VS Code extension was installed. Reload VS Code if it is already open."
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    func saveRealtimeCredential() {
        let value = realtimeKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        do {
            try keychain.saveAPIKey(value)
            appModel.hasAPIKey = true
            realtimeKey = ""
            advance()
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    func saveCodingProviderCredential() {
        let value = codingCredential.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        do {
            try keychain.saveCodingCredential(value, for: codingProvider)
            codingCredential = ""
            statusMessage = "\(codingProvider.label) credential saved in Keychain."
            advance()
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    func advance() {
        statusMessage = ""
        guard let next = OnboardingStep(rawValue: step.rawValue + 1) else {
            UserDefaults.standard.set(Self.currentVersion, forKey: Self.completionDefaultsKey)
            onComplete()
            return
        }
        step = next
        if next == .vscode { refreshVSCodeStatus() }
    }
}

enum OnboardingError: LocalizedError {
    case bundledExtensionMissing

    var errorDescription: String? {
        "The bundled Mamachi VS Code extension is missing. Reinstall Mamachi and try again."
    }
}

struct OnboardingView: View {
    @ObservedObject var onboarding: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Set up Mamachi").font(.largeTitle.bold())
                Text("Step \(onboarding.step.rawValue + 1) of \(OnboardingStep.allCases.count): \(onboarding.step.title)")
                    .foregroundStyle(.secondary)
                ProgressView(value: onboarding.progress)
            }

            Group {
                switch onboarding.step {
                case .microphone: microphoneStep
                case .notifications: notificationStep
                case .accessibility: accessibilityStep
                case .vscode: vscodeStep
                case .realtimeCredential: realtimeStep
                case .codingCredential: codingStep
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            if !onboarding.statusMessage.isEmpty {
                Text(onboarding.statusMessage).font(.callout).foregroundStyle(.secondary)
            }
        }
        .padding(28)
        .frame(width: 620, height: 460)
    }

    private var microphoneStep: some View {
        setupStep(
            icon: "mic.fill",
            explanation: "Mamachi captures audio only while voice mode is active. Audio is streamed for the live session and is never included in diagnostics.",
            primaryTitle: "Request Microphone Access",
            primaryAction: onboarding.requestMicrophone
        )
    }

    private var notificationStep: some View {
        setupStep(
            icon: "bell.badge.fill",
            explanation: "Notifications can tell you when a task needs input or finishes while the overlay is hidden.",
            primaryTitle: "Request Notification Access",
            primaryAction: onboarding.requestNotifications
        )
    }

    private var accessibilityStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Global shortcut access", systemImage: "accessibility")
                .font(.title2.bold())
            Text("Accessibility permission lets Mamachi respond to its global shortcut. macOS controls this permission; Mamachi does not read other applications through it.")
            HStack {
                Button("Show macOS Prompt") { onboarding.promptForAccessibility() }
                Button("Open System Settings") { onboarding.openAccessibilitySettings() }
                Spacer()
                Button("Continue") { onboarding.advance() }.buttonStyle(.borderedProminent)
            }
        }
    }

    private var vscodeStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Editor integration status", systemImage: "chevron.left.forwardslash.chevron.right")
                .font(.title2.bold())
            statusRow("Visual Studio Code", ready: onboarding.vscodeInstalled)
            statusRow("Mamachi VS Code extension", ready: onboarding.vscodeExtensionInstalled)
            Text("The extension provides editor context only when you explicitly capture it. Mamachi does not silently read source or terminal content.")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Button("Refresh") { onboarding.refreshVSCodeStatus() }
                if onboarding.vscodeInstalled { Button("Open VS Code") { onboarding.openVSCode() } }
                if onboarding.vscodeInstalled && !onboarding.vscodeExtensionInstalled {
                    Button("Install Mamachi Extension") { onboarding.installBundledVSCodeExtension() }
                }
                Spacer()
                Button("Continue") { onboarding.advance() }.buttonStyle(.borderedProminent)
            }
        }
    }

    private var realtimeStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("OpenAI Realtime key", systemImage: "waveform.badge.mic")
                .font(.title2.bold())
            Text("Required for Mamachi voice and chat. The key is saved only in your macOS Keychain and sent directly to OpenAI.")
            SecureField("Realtime API key", text: $onboarding.realtimeKey)
                .textContentType(.password)
            HStack {
                Spacer()
                Button("Save in Keychain") { onboarding.saveRealtimeCredential() }
                    .disabled(onboarding.realtimeKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private var codingStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Coding-provider credential", systemImage: "key.fill")
                .font(.title2.bold())
            Text("Optional. The selected provider credential is saved only in your macOS Keychain and supplied directly to the local coding runtime.")
            Picker("Provider", selection: $onboarding.codingProvider) {
                ForEach(CodingProvider.allCases) { provider in Text(provider.label).tag(provider) }
            }
            SecureField("Provider API key", text: $onboarding.codingCredential)
                .textContentType(.password)
            HStack {
                Button("Finish without a coding key") { onboarding.advance() }
                Spacer()
                Button("Save and Finish") { onboarding.saveCodingProviderCredential() }
                    .disabled(onboarding.codingCredential.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private func setupStep(icon: String, explanation: String, primaryTitle: String, primaryAction: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(onboarding.step.title, systemImage: icon).font(.title2.bold())
            Text(explanation)
            HStack {
                Button("Not Now") { onboarding.advance() }
                Spacer()
                Button(primaryTitle, action: primaryAction)
                    .disabled(onboarding.isWorking)
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private func statusRow(_ label: String, ready: Bool) -> some View {
        HStack {
            Image(systemName: ready ? "checkmark.circle.fill" : "minus.circle")
                .foregroundStyle(ready ? .green : .secondary)
            Text(label)
            Spacer()
            Text(ready ? "Detected" : "Not detected").foregroundStyle(.secondary)
        }
    }
}
