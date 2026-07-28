import Foundation

struct DaemonReady {
    let port: Int
    let token: String
    let workspace: String
    let databasePath: String
}

@MainActor
final class DaemonProcess {
    var onRestart: ((DaemonReady) -> Void)?
    var onTerminalFailure: ((Error) -> Void)?

    private let executableOverride: URL?
    private let statePathOverride: URL?
    private let baseEnvironmentOverride: [String: String]?
    private let restartDelaysNanoseconds: [UInt64]
    private let stabilityNanoseconds: UInt64
    private var process: Process?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?
    private var restartTask: Task<Void, Never>?
    private var stabilityTask: Task<Void, Never>?
    private var desiredRunning = false
    private var restartAttempt = 0
    private var launchGeneration = 0
    private var workspace = ""
    private var codingBackend: CodingAgentBackend = .omp

    init(
        executableURL: URL? = nil,
        statePath: URL? = nil,
        baseEnvironment: [String: String]? = nil,
        restartDelaysNanoseconds: [UInt64] = [250_000_000, 1_000_000_000, 2_000_000_000, 5_000_000_000],
        stabilityNanoseconds: UInt64 = 30_000_000_000
    ) {
        executableOverride = executableURL
        statePathOverride = statePath
        baseEnvironmentOverride = baseEnvironment
        self.restartDelaysNanoseconds = restartDelaysNanoseconds
        self.stabilityNanoseconds = stabilityNanoseconds
    }

    func start(workspace: String, codingBackend: CodingAgentBackend) async throws -> DaemonReady {
        if process?.isRunning == true { throw DaemonLaunchError.alreadyRunning }
        restartTask?.cancel()
        stabilityTask?.cancel()
        restartTask = nil
        stabilityTask = nil
        desiredRunning = true
        restartAttempt = 0
        self.workspace = workspace
        self.codingBackend = codingBackend
        do {
            let ready = try await launch()
            armStabilityWindow()
            return ready
        } catch {
            desiredRunning = false
            clearProcessReferences()
            throw error
        }
    }

    func stop() {
        desiredRunning = false
        launchGeneration += 1
        restartTask?.cancel()
        stabilityTask?.cancel()
        restartTask = nil
        stabilityTask = nil
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        process?.terminationHandler = nil
        if process?.isRunning == true { process?.terminate() }
        clearProcessReferences()
    }

    private func launch() async throws -> DaemonReady {
        let daemon = try executableOverride ?? Self.daemonExecutable()
        let statePath = try statePathOverride ?? Self.statePath()
        let token = UUID().uuidString.lowercased()
        launchGeneration += 1
        let generation = launchGeneration

        let process = Process()
        process.executableURL = daemon
        process.currentDirectoryURL = URL(filePath: workspace, directoryHint: .isDirectory)
        var environment = try baseEnvironmentOverride ?? Self.runtimeEnvironment()
        environment["PATH"] = CodingAgentDiscovery.augmentedPath()
        environment["MAMACHI_CODING_BACKEND"] = codingBackend.rawValue
        if let codex = CodingAgentDiscovery.executable(for: .codex) {
            environment["MAMACHI_CODEX_PATH"] = codex
        }
        if let claude = CodingAgentDiscovery.executable(for: .claude) {
            environment["MAMACHI_CLAUDE_PATH"] = claude
        }
        environment["MAMACHI_TOKEN"] = token
        environment["MAMACHI_PORT"] = "0"
        environment["MAMACHI_STATE_PATH"] = statePath.path
        environment["MAMACHI_CONNECTION_PATH"] =
            statePath.deletingLastPathComponent().appending(path: "connection.json").path
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

            func launchError(_ error: Error) {
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
                            let databasePath = object["databasePath"] as? String,
                            !settled
                        else { continue }
                        settled = true
                        outputPipe.fileHandleForReading.readabilityHandler = nil
                        stderrBuffer.removeAll(keepingCapacity: false)
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
                queue.async {
                    guard !settled, stderrBuffer.count < 65_536 else { return }
                    stderrBuffer.append(data.prefix(65_536 - stderrBuffer.count))
                }
            }
            process.terminationHandler = { [weak self] process in
                let status = process.terminationStatus
                queue.async {
                    let detail = String(data: stderrBuffer, encoding: .utf8)?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    if !settled {
                        launchError(DaemonLaunchError.exited(code: status, detail: detail))
                        return
                    }
                    Task { @MainActor [weak self] in
                        self?.handleUnexpectedExit(generation: generation, code: status)
                    }
                }
            }

            do {
                try process.run()
            } catch {
                queue.async { launchError(error) }
            }
        }
    }

    private func handleUnexpectedExit(generation: Int, code: Int32) {
        guard desiredRunning, generation == launchGeneration else { return }
        stabilityTask?.cancel()
        stabilityTask = nil
        clearProcessReferences()
        scheduleRestart(after: DaemonLaunchError.exited(code: code, detail: ""))
    }

    private func scheduleRestart(after error: Error) {
        guard desiredRunning, restartTask == nil else { return }
        guard restartAttempt < restartDelaysNanoseconds.count else {
            desiredRunning = false
            onTerminalFailure?(error)
            return
        }
        let delay = restartDelaysNanoseconds[restartAttempt]
        restartAttempt += 1
        restartTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: delay)
                guard let self, self.desiredRunning else { return }
                let ready = try await self.launch()
                self.restartTask = nil
                self.armStabilityWindow()
                self.onRestart?(ready)
            } catch is CancellationError {
                self?.restartTask = nil
            } catch {
                guard let self else { return }
                self.restartTask = nil
                self.clearProcessReferences()
                self.scheduleRestart(after: error)
            }
        }
    }

    private func armStabilityWindow() {
        stabilityTask?.cancel()
        let generation = launchGeneration
        stabilityTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: self?.stabilityNanoseconds ?? 0)
                guard
                    let self,
                    self.desiredRunning,
                    self.launchGeneration == generation,
                    self.process?.isRunning == true
                else { return }
                self.restartAttempt = 0
                self.stabilityTask = nil
            } catch {
                return
            }
        }
    }

    private func clearProcessReferences() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        process = nil
        outputPipe = nil
        errorPipe = nil
    }

    private static func runtimeEnvironment() throws -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let keychain = KeychainStore()
        for (name, credential) in try keychain.codingCredentialEnvironment() {
            environment[name] = credential
        }
        environment["MAMACHI_ENCRYPTION_KEY"] =
            try keychain.loadOrCreateApplicationEncryptionKey().base64EncodedString()
        return environment
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
        var candidate =
            Bundle.main.executableURL?.deletingLastPathComponent()
            ?? URL(filePath: FileManager.default.currentDirectoryPath)
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

    static func daemonExecutable(bundle: Bundle = .main) throws -> URL {
        if let configured = ProcessInfo.processInfo.environment["MAMACHI_DAEMON_PATH"], !configured.isEmpty {
            guard FileManager.default.isExecutableFile(atPath: configured) else {
                throw DaemonLaunchError.daemonNotExecutable(configured)
            }
            return URL(filePath: configured)
        }
        guard let resources = bundle.resourceURL else {
            throw DaemonLaunchError.bundledDaemonMissing
        }
        let daemon = resources.appending(path: "runtime/mamachi-daemon")
        guard FileManager.default.isExecutableFile(atPath: daemon.path) else {
            throw DaemonLaunchError.bundledDaemonMissing
        }
        return daemon
    }
}

enum DaemonLaunchError: LocalizedError {
    case alreadyRunning
    case bundledDaemonMissing
    case daemonNotExecutable(String)
    case projectRootNotFound
    case exited(code: Int32, detail: String)

    var errorDescription: String? {
        switch self {
        case .alreadyRunning:
            "Mamachi daemon is already running."
        case .bundledDaemonMissing:
            "The bundled Mamachi daemon is missing. Reinstall Mamachi."
        case .daemonNotExecutable(let path):
            "The configured Mamachi daemon is not executable: \(path)"
        case .projectRootNotFound:
            "Mamachi project root was not found. Set MAMACHI_PROJECT_ROOT."
        case .exited(let code, let detail):
            detail.isEmpty ? "Mamachi daemon exited with code \(code)." : "Mamachi daemon exited with code \(code): \(detail)"
        }
    }
}
