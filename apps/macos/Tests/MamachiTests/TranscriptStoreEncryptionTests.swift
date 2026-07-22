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

    private func makeFixture() throws -> (directory: URL, file: URL, store: TranscriptStore) {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "mamachi-transcript-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appending(path: "transcripts.json")
        let encryption = ApplicationEncryptionService(key: Data(repeating: 0x5A, count: 32))
        return (directory, file, try TranscriptStore(fileURL: file, encryption: encryption))
    }
}
