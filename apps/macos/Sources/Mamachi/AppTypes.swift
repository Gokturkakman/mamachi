import Foundation

struct TranscriptEntry: Codable, Identifiable, Equatable {
    enum Speaker: String, Codable {
        case user
        case mamachi
    }

    let id: UUID
    let speaker: Speaker
    let text: String
    let at: Date
}

struct TaskViewState: Identifiable, Equatable {
    let id: String
    var state: String
    var revision: Int
    var objective: String
    var terminalSummary: String?
    var recentActivity: String?
    // Display-only facts populated as richer domain events land. Defaulted so
    // existing initializers stay source-compatible.
    var phase: String? = nil
    var currentStep: String? = nil
    /// Grounded progress in percent (0–100) from the daemon fact projector.
    var progress: Double? = nil
    var verificationState: String? = nil
    var pendingQuestion: String? = nil
    var createdAt: Date? = nil
    var specHistory: [SpecRevisionViewState] = []
    var observerSummary: String? = nil
    var observerRisks: [String] = []
    var observerNextStep: String? = nil
    var blockers: [BlockerViewState] = []
    var changedFiles: [ChangedFileViewState] = []
    var evidence: [EvidenceViewState] = []
    var runBoundaries: [RunBoundaryViewState] = []

    var isTerminal: Bool {
        ["completed", "failed", "cancelled"].contains(state)
    }

    var stateLabel: String {
        state.replacingOccurrences(of: "_", with: " ").capitalized
    }

    var phaseLabel: String? {
        switch phase {
        case "understanding": "Understanding"
        case "execution": "Executing"
        case "implementation": "Implementing"
        case "verification": "Verifying"
        case "awaiting_user": "Needs you"
        case "complete": "Complete"
        case let .some(other): other.replacingOccurrences(of: "_", with: " ").capitalized
        case nil: nil
        }
    }
}

struct CapturedContextViewState: Identifiable, Equatable {
    let id: String
    let kind: String
    let summary: String
}

/// One immutable revision of the task specification, oldest first.
struct SpecRevisionViewState: Identifiable, Equatable {
    let revision: Int
    let objective: String
    var revisedAt: Date? = nil

    var id: Int { revision }
}

/// Spoken updates queued while the microphone sleeps (PRD 8.1).
struct PendingBriefViewState: Equatable {
    var count = 0
    var latestSummary = ""
}

/// A blocker or conflict the coder surfaced while working a task.
struct BlockerViewState: Identifiable, Equatable {
    let id: String
    var summary: String
    /// "blocker" for missing prerequisites, "conflict" for merge/revision conflicts.
    var kind: String = "blocker"
}

/// A file the coder created, edited, or deleted for the current task.
struct ChangedFileViewState: Identifiable, Equatable {
    /// Workspace-relative (or absolute) path; doubles as the identity.
    let path: String
    /// "modified", "added", "deleted", or "renamed".
    var kind: String = "modified"
    var summary: String? = nil
    /// Optional 1-based range for editor deep links.
    var line: Int? = nil
    var endLine: Int? = nil

    var id: String { path }
}

/// Verification evidence the coder produced: test runs, builds, manual checks.
struct EvidenceViewState: Identifiable, Equatable {
    let id: String
    var summary: String
    /// "test", "build", "lint", "run", or "manual".
    var kind: String = "check"
    /// nil while pending or informational; true/false once judged.
    var passed: Bool? = nil
    var detail: String? = nil
    /// Optional source location backing the evidence.
    var file: String? = nil
    var line: Int? = nil
}

/// A run or recovery boundary in the task's execution timeline.
struct RunBoundaryViewState: Identifiable, Equatable {
    let id: String
    var label: String
    /// "run" for a fresh run, "recovery" for resume-after-interruption.
    var kind: String = "run"
    var at: Date? = nil
}

/// One line of live coder activity shown in the task activity ticker.
struct CoderFeedEntry: Identifiable, Equatable {
    let id = UUID()
    let text: String
    let at: Date
}

struct ConfirmationViewState: Identifiable, Equatable {
    let id: String
    let taskId: String
    let taskRevision: Int
    let category: String
    let summary: String
    let toolName: String
    let state: String
}


enum InteractionMode: String, CaseIterable, Identifiable {
    case voice
    case text

    var id: String { rawValue }
    var label: String { self == .voice ? "Voice" : "Chat" }
    var systemImage: String { self == .voice ? "waveform" : "text.bubble" }
}

enum VoiceConnectionState: String {
    case disconnected
    case connecting
    case connected
    case listening
    case thinking
    case speaking
    case error

    var label: String {
        switch self {
        case .disconnected: "Offline"
        case .connecting: "Connecting"
        case .connected: "Ready"
        case .listening: "Listening"
        case .thinking: "Thinking"
        case .speaking: "Speaking"
        case .error: "Needs attention"
        }
    }
}

enum ProtocolID {
    static func makeV7(now: Date = Date()) -> String {
        var generator = SystemRandomNumberGenerator()
        var bytes = (0..<16).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        let milliseconds = UInt64(max(0, now.timeIntervalSince1970 * 1_000))
        bytes[0] = UInt8(truncatingIfNeeded: milliseconds >> 40)
        bytes[1] = UInt8(truncatingIfNeeded: milliseconds >> 32)
        bytes[2] = UInt8(truncatingIfNeeded: milliseconds >> 24)
        bytes[3] = UInt8(truncatingIfNeeded: milliseconds >> 16)
        bytes[4] = UInt8(truncatingIfNeeded: milliseconds >> 8)
        bytes[5] = UInt8(truncatingIfNeeded: milliseconds)
        bytes[6] = (bytes[6] & 0x0F) | 0x70
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(
            uuid: (
                bytes[0], bytes[1], bytes[2], bytes[3],
                bytes[4], bytes[5], bytes[6], bytes[7],
                bytes[8], bytes[9], bytes[10], bytes[11],
                bytes[12], bytes[13], bytes[14], bytes[15]
            )
        ).uuidString.lowercased()
    }
}
