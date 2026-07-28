import Foundation
import XCTest
@testable import Mamachi

final class DaemonProcessTests: XCTestCase {
    private func makeDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "mamachi-daemon-process-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func writeExecutable(_ body: String, to directory: URL) throws -> URL {
        let executable = directory.appending(path: "fake-daemon")
        try ("#!/bin/sh\n" + body).write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        return executable
    }

    @MainActor
    func testUnexpectedExitRestartsAndPublishesFreshConnection() async throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let counter = directory.appending(path: "launch-count")
        let database = directory.appending(path: "state.sqlite")
        let executable = try writeExecutable(
            """
            count=0
            if [ -f '\(counter.path)' ]; then count=$(cat '\(counter.path)'); fi
            count=$((count + 1))
            printf '%s' "$count" > '\(counter.path)'
            printf '{"type":"mamachi.ready","port":43210,"token":"%s","workspace":"\(directory.path)","databasePath":"\(database.path)"}\n' "$MAMACHI_TOKEN"
            if [ "$count" -eq 1 ]; then exit 42; fi
            sleep 5
            """,
            to: directory
        )
        let daemon = DaemonProcess(
            executableURL: executable,
            statePath: database,
            baseEnvironment: [:],
            restartDelaysNanoseconds: [1_000_000],
            stabilityNanoseconds: 1_000_000_000
        )
        let restarted = expectation(description: "daemon restarted")
        var restartedReady: DaemonReady?
        daemon.onRestart = { ready in
            restartedReady = ready
            restarted.fulfill()
        }

        let initial = try await daemon.start(workspace: directory.path, codingBackend: .omp)
        await fulfillment(of: [restarted], timeout: 2)
        defer { daemon.stop() }

        XCTAssertEqual(try String(contentsOf: counter, encoding: .utf8), "2")
        XCTAssertEqual(restartedReady?.port, 43210)
        XCTAssertNotEqual(restartedReady?.token, initial.token)
    }

    @MainActor
    func testIntentionalStopNeverRestarts() async throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let counter = directory.appending(path: "launch-count")
        let database = directory.appending(path: "state.sqlite")
        let executable = try writeExecutable(
            """
            printf '1' > '\(counter.path)'
            printf '{"type":"mamachi.ready","port":43210,"token":"%s","workspace":"\(directory.path)","databasePath":"\(database.path)"}\n' "$MAMACHI_TOKEN"
            sleep 5
            """,
            to: directory
        )
        let daemon = DaemonProcess(
            executableURL: executable,
            statePath: database,
            baseEnvironment: [:],
            restartDelaysNanoseconds: [1_000_000],
            stabilityNanoseconds: 1_000_000_000
        )
        var didRestart = false
        daemon.onRestart = { _ in didRestart = true }

        _ = try await daemon.start(workspace: directory.path, codingBackend: .omp)
        daemon.stop()
        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertFalse(didRestart)
        XCTAssertEqual(try String(contentsOf: counter, encoding: .utf8), "1")
    }

    @MainActor
    func testCrashLoopStopsAfterBoundedRetries() async throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let counter = directory.appending(path: "launch-count")
        let database = directory.appending(path: "state.sqlite")
        let executable = try writeExecutable(
            """
            count=0
            if [ -f '\(counter.path)' ]; then count=$(cat '\(counter.path)'); fi
            count=$((count + 1))
            printf '%s' "$count" > '\(counter.path)'
            printf '{"type":"mamachi.ready","port":43210,"token":"%s","workspace":"\(directory.path)","databasePath":"\(database.path)"}\n' "$MAMACHI_TOKEN"
            exit 17
            """,
            to: directory
        )
        let daemon = DaemonProcess(
            executableURL: executable,
            statePath: database,
            baseEnvironment: [:],
            restartDelaysNanoseconds: [1_000_000, 1_000_000],
            stabilityNanoseconds: 1_000_000_000
        )
        let exhausted = expectation(description: "restart budget exhausted")
        daemon.onTerminalFailure = { _ in exhausted.fulfill() }

        _ = try await daemon.start(workspace: directory.path, codingBackend: .omp)
        await fulfillment(of: [exhausted], timeout: 2)
        defer { daemon.stop() }

        XCTAssertEqual(try String(contentsOf: counter, encoding: .utf8), "3")
    }
}
