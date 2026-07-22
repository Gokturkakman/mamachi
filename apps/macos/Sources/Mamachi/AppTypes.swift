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

    var isTerminal: Bool {
        ["completed", "failed", "cancelled"].contains(state)
    }
}
struct CapturedContextViewState: Identifiable, Equatable {
    let id: String
    let kind: String
    let summary: String
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
