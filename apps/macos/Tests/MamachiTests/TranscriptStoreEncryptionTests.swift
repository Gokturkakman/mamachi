import Foundation
import XCTest
@testable import Mamachi

final class TranscriptStoreEncryptionTests: XCTestCase {
    func testRoundTripDoesNotPersistTranscriptPlaintext() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let entry = TranscriptEntry(
            id: UUID(uuidString: "018f0000-0000-7000-8000-000000000001")!,
            speaker: .user,
            text: "sensitive transcript sentinel",
            at: Date(timeIntervalSince1970: 1_700_000_000)
        )

        try fixture.store.save([entry])

        let stored = try Data(contentsOf: fixture.file)
        XCTAssertEqual(stored.first, 1)
        XCTAssertFalse(String(decoding: stored, as: UTF8.self).contains(entry.text))
        XCTAssertEqual(try fixture.store.load(), [entry])
    }

    func testLegacyPlaintextMigratesOnRead() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let entry = TranscriptEntry(
            id: UUID(uuidString: "018f0000-0000-7000-8000-000000000002")!,
            speaker: .mamachi,
            text: "legacy transcript sentinel",
            at: Date(timeIntervalSince1970: 1_700_000_100)
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode([entry]).write(to: fixture.file)

        XCTAssertEqual(try fixture.store.load(), [entry])
        let migrated = try Data(contentsOf: fixture.file)
        XCTAssertEqual(migrated.first, 1)
        XCTAssertFalse(String(decoding: migrated, as: UTF8.self).contains(entry.text))
    }

    func testTamperedEnvelopeFailsAuthentication() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let entry = TranscriptEntry(
            id: UUID(uuidString: "018f0000-0000-7000-8000-000000000003")!,
            speaker: .user,
            text: "tamper sentinel",
            at: Date(timeIntervalSince1970: 1_700_000_200)
        )
        try fixture.store.save([entry])
        var stored = try Data(contentsOf: fixture.file)
        stored[stored.index(before: stored.endIndex)] ^= 0x01
        try stored.write(to: fixture.file)

        XCTAssertThrowsError(try fixture.store.load())
    }

    func testRetentionBoundsAgeCountAndTextBytes() {
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let policy = TranscriptRetentionPolicy(maxAge: 100, maxEntries: 2, maxTextBytes: 6)
        let entries = [
            TranscriptEntry(id: UUID(), speaker: .user, text: "expired", at: now.addingTimeInterval(-101)),
            TranscriptEntry(id: UUID(), speaker: .mamachi, text: "old", at: now.addingTimeInterval(-3)),
            TranscriptEntry(id: UUID(), speaker: .user, text: "four", at: now.addingTimeInterval(-2)),
            TranscriptEntry(id: UUID(), speaker: .mamachi, text: "hi", at: now.addingTimeInterval(-1)),
        ]

        let retained = policy.applying(to: entries, now: now)

        XCTAssertEqual(retained.map(\.text), ["four", "hi"])
    }

    func testLoadPrunesPersistedTranscriptHistory() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "mamachi-transcript-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appending(path: "transcripts.json")
        let encryption = ApplicationEncryptionService(key: Data(repeating: 0x5A, count: 32))
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let unlimited = TranscriptRetentionPolicy(maxAge: 1_000, maxEntries: 10, maxTextBytes: 1_000)
        let writer = try TranscriptStore(fileURL: file, encryption: encryption, retentionPolicy: unlimited) { now }
        let expired = TranscriptEntry(
            id: UUID(),
            speaker: .user,
            text: "expired transcript",
            at: now.addingTimeInterval(-200)
        )
        let current = TranscriptEntry(
            id: UUID(),
            speaker: .mamachi,
            text: "current transcript",
            at: now
        )
        try writer.save([expired, current])
        let bounded = try TranscriptStore(
            fileURL: file,
            encryption: encryption,
            retentionPolicy: TranscriptRetentionPolicy(maxAge: 100, maxEntries: 10, maxTextBytes: 1_000)
        ) { now }

        XCTAssertEqual(try bounded.load(), [current])
        XCTAssertEqual(try bounded.load(), [current])
    }

    private func makeFixture() throws -> (directory: URL, file: URL, store: TranscriptStore) {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "mamachi-transcript-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appending(path: "transcripts.json")
        let encryption = ApplicationEncryptionService(key: Data(repeating: 0x5A, count: 32))
        let store = try TranscriptStore(fileURL: file, encryption: encryption) {
            Date(timeIntervalSince1970: 1_700_000_300)
        }
        return (directory, file, store)
    }
}
