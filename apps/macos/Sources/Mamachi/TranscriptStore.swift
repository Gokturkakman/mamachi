import Foundation

struct TranscriptStore {
    private let fileURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(fileManager: FileManager = .default) throws {
        let support = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = support.appending(path: "Mamachi", directoryHint: .isDirectory)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        fileURL = directory.appending(path: "transcripts.json")

        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    func load() throws -> [TranscriptEntry] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        return try decoder.decode([TranscriptEntry].self, from: Data(contentsOf: fileURL))
    }

    func save(_ entries: [TranscriptEntry]) throws {
        try encoder.encode(entries).write(to: fileURL, options: [.atomic, .completeFileProtection])
    }

    func clear() throws {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        try FileManager.default.removeItem(at: fileURL)
    }
}
