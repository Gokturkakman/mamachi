import Foundation

struct TranscriptStore {
    private let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let encryption: ApplicationEncryptionService

    init(
        fileManager: FileManager = .default,
        encryption: ApplicationEncryptionService = ApplicationEncryptionService()
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
            encryption: encryption
        )
    }

    init(fileURL: URL, encryption: ApplicationEncryptionService) throws {
        self.fileURL = fileURL
        self.encryption = encryption
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
        if !wasEncrypted {
            try save(entries)
        }
        return entries
    }

    func save(_ entries: [TranscriptEntry]) throws {
        let plaintext = try encoder.encode(entries)
        let envelope = try encryption.encrypt(plaintext)
        try envelope.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }

    func clear() throws {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        try FileManager.default.removeItem(at: fileURL)
    }
}
