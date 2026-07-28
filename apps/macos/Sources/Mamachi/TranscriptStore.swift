import Foundation

struct TranscriptRetentionPolicy {
    static let standard = TranscriptRetentionPolicy(
        maxAge: 30 * 24 * 60 * 60,
        maxEntries: 1_000,
        maxTextBytes: 1_000_000
    )

    let maxAge: TimeInterval
    let maxEntries: Int
    let maxTextBytes: Int

    func applying(to entries: [TranscriptEntry], now: Date) -> [TranscriptEntry] {
        let cutoff = now.addingTimeInterval(-max(0, maxAge))
        var remainingBytes = max(0, maxTextBytes)
        var retained: [TranscriptEntry] = []
        retained.reserveCapacity(min(entries.count, max(0, maxEntries)))

        for entry in entries.reversed() {
            guard retained.count < max(0, maxEntries), entry.at >= cutoff else { continue }
            let byteCount = entry.text.utf8.count
            guard byteCount <= remainingBytes else { continue }
            remainingBytes -= byteCount
            retained.append(entry)
        }
        return retained.reversed()
    }
}

struct TranscriptStore {
    private let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let encryption: ApplicationEncryptionService
    private let retentionPolicy: TranscriptRetentionPolicy
    private let now: () -> Date

    init(
        fileManager: FileManager = .default,
        encryption: ApplicationEncryptionService = ApplicationEncryptionService(),
        retentionPolicy: TranscriptRetentionPolicy = .standard,
        now: @escaping () -> Date = Date.init
    ) throws {
        let support = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = support.appending(path: "Mamachi", directoryHint: .isDirectory)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        try self.init(
            fileURL: directory.appending(path: "transcripts.json"),
            encryption: encryption,
            retentionPolicy: retentionPolicy,
            now: now
        )
    }

    init(
        fileURL: URL,
        encryption: ApplicationEncryptionService,
        retentionPolicy: TranscriptRetentionPolicy = .standard,
        now: @escaping () -> Date = Date.init
    ) throws {
        self.fileURL = fileURL
        self.encryption = encryption
        self.retentionPolicy = retentionPolicy
        self.now = now
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    func load() throws -> [TranscriptEntry] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        let stored = try Data(contentsOf: fileURL)
        let wasEncrypted = encryption.isEncryptedEnvelope(stored)
        let plaintext = try wasEncrypted ? encryption.decrypt(stored) : stored
        let entries = try decoder.decode([TranscriptEntry].self, from: plaintext)
        let retained = retentionPolicy.applying(to: entries, now: now())
        if !wasEncrypted || retained != entries {
            try persist(retained)
        }
        return retained
    }

    @discardableResult
    func save(_ entries: [TranscriptEntry]) throws -> [TranscriptEntry] {
        let retained = retentionPolicy.applying(to: entries, now: now())
        try persist(retained)
        return retained
    }

    func clear() throws {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        try FileManager.default.removeItem(at: fileURL)
    }

    private func persist(_ entries: [TranscriptEntry]) throws {
        let plaintext = try encoder.encode(entries)
        let envelope = try encryption.encrypt(plaintext)
        try envelope.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }
}
