import Foundation

struct DaemonReady {
    let port: Int
    let token: String
    let workspace: String
    let databasePath: String
}

@MainActor
final class DaemonProcess {
    private var process: Process?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?

    func start(workspace: String) async throws -> DaemonReady {
        if process?.isRunning == true { throw DaemonLaunchError.alreadyRunning }
        let projectRoot = try Self.projectRoot()
        let bun = try Self.discoverBun()
        let statePath = try Self.statePath()
        let token = UUID().uuidString.lowercased()

        let process = Process()
        process.executableURL = bun
        process.arguments = ["run", "daemon"]
        process.currentDirectoryURL = projectRoot
        var environment = ProcessInfo.processInfo.environment
        environment["MAMACHI_TOKEN"] = token
        environment["MAMACHI_PORT"] = "0"
        environment["MAMACHI_STATE_PATH"] = statePath.path
        environment["MAMACHI_CONNECTION_PATH"] = statePath.deletingLastPathComponent().appending(path: "connection.json").path
        environment["MAMACHI_WORKSPACE"] = workspace
        process.environment = environment

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        self.process = process
        self.outputPipe = outputPipe
        self.errorPipe = errorPipe

        return try await withCheckedThrowingContinuation { continuation in
            let queue = DispatchQueue(label: "com.mamachi.daemon-output")
            var stdoutBuffer = Data()
            var stderrBuffer = Data()
            var settled = false

            func fail(_ error: Error) {
                guard !settled else { return }
                settled = true
                outputPipe.fileHandleForReading.readabilityHandler = nil
                errorPipe.fileHandleForReading.readabilityHandler = nil
                continuation.resume(throwing: error)
            }

            outputPipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                queue.async {
                    stdoutBuffer.append(data)
                    while let newline = stdoutBuffer.firstIndex(of: 0x0A) {
                        let line = stdoutBuffer[..<newline]
                        stdoutBuffer.removeSubrange(...newline)
                        guard
                            let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                            object["type"] as? String == "mamachi.ready",
                            let port = object["port"] as? Int,
                            let readyToken = object["token"] as? String,
                            let readyWorkspace = object["workspace"] as? String,
                            let databasePath = object["databasePath"] as? String
                        else { continue }
                        guard !settled else { return }
                        settled = true
                        outputPipe.fileHandleForReading.readabilityHandler = nil
                        continuation.resume(
                            returning: DaemonReady(
                                port: port,
                                token: readyToken,
                                workspace: readyWorkspace,
                                databasePath: databasePath
                            )
                        )
                    }
                }
            }
            errorPipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                queue.async { stderrBuffer.append(data) }
            }
            process.terminationHandler = { process in
                queue.async {
                    guard !settled else { return }
                    let detail = String(data: stderrBuffer, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    fail(DaemonLaunchError.exited(code: process.terminationStatus, detail: detail ?? ""))
                }
            }

            do {
                try process.run()
            } catch {
                queue.async { fail(error) }
            }
        }
    }

    func stop() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        if process?.isRunning == true { process?.terminate() }
        process = nil
        outputPipe = nil
        errorPipe = nil
    }

    private static func statePath() throws -> URL {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = support.appending(path: "Mamachi", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appending(path: "state.sqlite")
    }

    static func projectRoot() throws -> URL {
        if let configured = ProcessInfo.processInfo.environment["MAMACHI_PROJECT_ROOT"], !configured.isEmpty {
            return URL(filePath: configured, directoryHint: .isDirectory)
        }
        var candidate = Bundle.main.executableURL?.deletingLastPathComponent() ?? URL(filePath: FileManager.default.currentDirectoryPath)
        for _ in 0..<12 {
            let manifest = candidate.appending(path: "package.json")
            if
                let data = try? Data(contentsOf: manifest),
                let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                object["name"] as? String == "mamachi"
            {
                return candidate
            }
            candidate.deleteLastPathComponent()
        }
        throw DaemonLaunchError.projectRootNotFound
    }

    private static func discoverBun() throws -> URL {
        let environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser
        let candidates = [
            environment["BUN_PATH"],
            home.appending(path: ".bun/bin/bun").path,
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
        ].compactMap { $0 }
        if let path = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return URL(filePath: path)
        }
        throw DaemonLaunchError.bunNotFound
    }
}

enum DaemonLaunchError: LocalizedError {
    case alreadyRunning
    case bunNotFound
    case projectRootNotFound
    case exited(code: Int32, detail: String)

    var errorDescription: String? {
        switch self {
        case .alreadyRunning:
            "Mamachi daemon is already running."
        case .bunNotFound:
            "Bun was not found. Install Bun or set BUN_PATH."
        case .projectRootNotFound:
            "Mamachi project root was not found. Set MAMACHI_PROJECT_ROOT."
        case .exited(let code, let detail):
            detail.isEmpty ? "Mamachi daemon exited with code \(code)." : "Mamachi daemon exited with code \(code): \(detail)"
        }
    }
}
