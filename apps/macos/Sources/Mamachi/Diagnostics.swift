import AppKit
import Foundation
import SwiftUI

enum DiagnosticComponent: String, Codable {
    case application
    case daemon
    case realtime
    case codingProvider
    case editorIntegration
}

enum DiagnosticState: String, Codable {
    case unknown
    case starting
    case connected
    case disconnected
    case ready
    case unavailable
    case failed
}

struct DiagnosticTransition: Codable, Equatable {
    let component: DiagnosticComponent
    let from: DiagnosticState
    let to: DiagnosticState
    let elapsedMilliseconds: Int
}

struct DiagnosticFailure: Codable, Equatable {
    let component: DiagnosticComponent
    let errorClass: String
}

struct DiagnosticSnapshot: Codable {
    let formatVersion: Int
    let generatedAt: Date
    let appVersion: String
    let daemonVersion: String
    let macOSVersion: String
    let transitions: [DiagnosticTransition]
    let failures: [DiagnosticFailure]
    let providerRequestIDs: [String]
}

enum DiagnosticsPrivacyError: LocalizedError {
    case unsafeField(String)
    case unsafeValue

    var errorDescription: String? {
        switch self {
        case .unsafeField(let field): "Diagnostics contained a prohibited field: \(field)"
        case .unsafeValue: "Diagnostics contained a value that resembles private content."
        }
    }
}

struct DiagnosticsPrivacyPolicy {
    private static let prohibitedFields = [
        "source", "content", "transcript", "message", "tool", "argument", "credential", "token", "audio", "prompt", "selection",
    ]
    private static let secretMarkers = ["sk-", "api_key", "apikey", "bearer ", "authorization:", "-----begin"]

    func validate(_ data: Data) throws {
        let object = try JSONSerialization.jsonObject(with: data)
        try inspect(object)
    }

    private func inspect(_ value: Any) throws {
        if let dictionary = value as? [String: Any] {
            for (key, child) in dictionary {
                let normalized = key.lowercased()
                if Self.prohibitedFields.contains(where: normalized.contains) {
                    throw DiagnosticsPrivacyError.unsafeField(key)
                }
                try inspect(child)
            }
        } else if let array = value as? [Any] {
            for child in array { try inspect(child) }
        } else if let string = value as? String {
            let normalized = string.lowercased()
            if Self.secretMarkers.contains(where: normalized.contains) || string.contains("/Users/") {
                throw DiagnosticsPrivacyError.unsafeValue
            }
        }
    }
}

@MainActor
final class DiagnosticsService: ObservableObject {
    private static let maximumTransitions = 100
    private static let maximumFailures = 50
    private static let maximumRequestIDs = 50

    private var transitions: [DiagnosticTransition] = []
    private var failures: [DiagnosticFailure] = []
    private var providerRequestIDs: [String] = []

    func recordTransition(
        component: DiagnosticComponent,
        from: DiagnosticState,
        to: DiagnosticState,
        elapsedMilliseconds: Int
    ) {
        transitions.append(DiagnosticTransition(
            component: component,
            from: from,
            to: to,
            elapsedMilliseconds: min(max(elapsedMilliseconds, 0), 600_000)
        ))
        transitions = Array(transitions.suffix(Self.maximumTransitions))
    }

    func recordFailure(component: DiagnosticComponent, error: Error) {
        let rawClass = String(describing: type(of: error))
        let safeClass = String(rawClass.unicodeScalars.filter {
            CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._")).contains($0)
        }.prefix(80))
        failures.append(DiagnosticFailure(component: component, errorClass: safeClass.isEmpty ? "Error" : safeClass))
        failures = Array(failures.suffix(Self.maximumFailures))
    }

    func recordProviderRequestID(_ identifier: String) {
        let normalized = identifier.lowercased()
        guard !["sk-", "api_key", "apikey", "bearer", "authorization"].contains(where: normalized.contains) else { return }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        let safe = String(identifier.unicodeScalars.filter { allowed.contains($0) }.prefix(128))
        guard !safe.isEmpty else { return }
        providerRequestIDs.append(safe)
        providerRequestIDs = Array(providerRequestIDs.suffix(Self.maximumRequestIDs))
    }

    func previewData() throws -> Data {
        let snapshot = DiagnosticSnapshot(
            formatVersion: 1,
            generatedAt: Date(),
            appVersion: Self.appVersion,
            daemonVersion: Self.daemonVersion,
            macOSVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            transitions: transitions,
            failures: failures,
            providerRequestIDs: providerRequestIDs
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(snapshot)
        try DiagnosticsPrivacyPolicy().validate(data)
        return data
    }

    private static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development"
    }

    private static var daemonVersion: String {
        guard
            let url = Bundle.main.url(forResource: "daemon-version", withExtension: "json", subdirectory: "runtime"),
            let data = try? Data(contentsOf: url),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let version = object["daemonVersion"] as? String
        else { return appVersion }
        return version
    }
}

struct DiagnosticsPreviewView: View {
    let data: Data
    @Environment(\.dismiss) private var dismiss
    @State private var exportError: String?

    private var preview: String { String(decoding: data, as: UTF8.self) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Diagnostics Preview").font(.title2.bold())
            Text("Only bounded states, error classes, timings, versions, and safe provider request IDs are included. Source, transcripts, tool arguments, credentials, and audio are excluded.")
                .font(.callout)
                .foregroundStyle(.secondary)
            TextEditor(text: .constant(preview))
                .font(.system(.caption, design: .monospaced))
                .frame(minHeight: 360)
                .border(.separator)
            if let exportError { Text(exportError).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Export…") { exportPreviewedData() }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 680, height: 520)
    }

    private func exportPreviewedData() {
        let panel = NSSavePanel()
        panel.title = "Export Previewed Diagnostics"
        panel.nameFieldStringValue = "mamachi-diagnostics.json"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try DiagnosticsPrivacyPolicy().validate(data)
            try data.write(to: url, options: [.atomic])
            dismiss()
        } catch {
            exportError = error.localizedDescription
        }
    }
}
