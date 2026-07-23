import AppKit
import Foundation

// The coding backend is explicit so Mamachi never silently sends a task to a
// different subscription or provider than the user selected.
enum CodingAgentBackend: String, CaseIterable, Identifiable {
    case codex
    case claude
    case omp

    var id: String { rawValue }

    var label: String {
        switch self {
        case .codex: "Codex"
        case .claude: "Claude Code"
        case .omp: "Oh My Pi"
        }
    }

    var detail: String {
        switch self {
        case .codex: "Uses your existing Codex CLI login and settings."
        case .claude: "Uses your existing Claude Code login and settings."
        case .omp: "Uses your existing OMP provider logins. A separate API key is optional."
        }
    }

    var systemImage: String {
        switch self {
        case .codex: "terminal.fill"
        case .claude: "c.circle.fill"
        case .omp: "shippingbox.fill"
        }
    }
}

struct CodingAgentStatus: Identifiable, Equatable {
    let backend: CodingAgentBackend
    let executablePath: String?
    let installed: Bool
    let authenticated: Bool
    let detail: String

    var id: CodingAgentBackend { backend }
    var ready: Bool { installed && authenticated }

    static func unavailable(_ backend: CodingAgentBackend) -> Self {
        Self(
            backend: backend,
            executablePath: nil,
            installed: backend == .omp,
            authenticated: false,
            detail: backend == .omp ? "Embedded runtime ready; OMP provider login required." : "Not installed."
        )
    }
}

enum CodingAgentSetupError: LocalizedError {
    case setupScriptCouldNotOpen
    case setupScriptCouldNotWrite(String)

    var errorDescription: String? {
        switch self {
        case .setupScriptCouldNotOpen:
            "The coding-agent setup terminal could not be opened."
        case .setupScriptCouldNotWrite(let message):
            "The coding-agent setup command could not be prepared: \(message)"
        }
    }
}

enum CodingAgentDiscovery {
    static func executable(for backend: CodingAgentBackend) -> String? {
        let command = switch backend {
        case .codex: "codex"
        case .claude: "claude"
        case .omp: "omp"
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        var candidates = searchPathDirectories().map { $0.appending(path: command).path }
        candidates.append(contentsOf: [
            home.appending(path: ".local/bin/\(command)").path,
            home.appending(path: ".bun/bin/\(command)").path,
            home.appending(path: ".npm-global/bin/\(command)").path,
            home.appending(path: ".claude/local/\(command)").path,
            "/opt/homebrew/bin/\(command)",
            "/usr/local/bin/\(command)",
        ])
        let nvm = home.appending(path: ".nvm/versions/node", directoryHint: .isDirectory)
        if let versions = try? FileManager.default.contentsOfDirectory(
            at: nvm,
            includingPropertiesForKeys: nil
        ) {
            candidates.append(contentsOf: versions
                .sorted { $0.lastPathComponent > $1.lastPathComponent }
                .map { $0.appending(path: "bin/\(command)").path })
        }
        return candidates.first(where: isExecutable)
    }

    static func augmentedPath() -> String {
        var paths = searchPathDirectories().map(\.path)
        for backend in CodingAgentBackend.allCases {
            if let executable = executable(for: backend) {
                paths.append(URL(filePath: executable).deletingLastPathComponent().path)
            }
        }
        return Array(NSOrderedSet(array: paths)).compactMap { $0 as? String }.joined(separator: ":")
    }

    static func statuses(keychain: KeychainStore = KeychainStore()) async -> [CodingAgentStatus] {
        let storedProviders = Set(CodingProvider.allCases.filter {
            ((try? keychain.loadCodingCredential(for: $0)) ?? nil)?.isEmpty == false
        })
        return await withTaskGroup(of: CodingAgentStatus.self, returning: [CodingAgentStatus].self) { group in
            for backend in CodingAgentBackend.allCases {
                group.addTask {
                    await status(for: backend, storedProviders: storedProviders)
                }
            }
            var result: [CodingAgentStatus] = []
            for await status in group { result.append(status) }
            return CodingAgentBackend.allCases.compactMap { backend in
                result.first(where: { $0.backend == backend })
            }
        }
    }

    static func openSetupTerminal(for backend: CodingAgentBackend, executablePath: String?) throws {
        let script = setupScript(for: backend, executablePath: executablePath)
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: "Mamachi/Setup", directoryHint: .isDirectory)
        let url = directory.appending(path: "mamachi-\(backend.rawValue)-setup.command")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try script.write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        } catch {
            throw CodingAgentSetupError.setupScriptCouldNotWrite(error.localizedDescription)
        }
        guard NSWorkspace.shared.open(url) else {
            throw CodingAgentSetupError.setupScriptCouldNotOpen
        }
    }

    static func ompLoginAvailable(exitCode: Int32, output: String) -> Bool {
        guard
            exitCode == 0,
            let data = output.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return false
        }
        let reports = object["reports"] as? [Any] ?? []
        let accountsWithoutUsage = object["accountsWithoutUsage"] as? [Any] ?? []
        return !reports.isEmpty || !accountsWithoutUsage.isEmpty
    }

    private static func status(
        for backend: CodingAgentBackend,
        storedProviders: Set<CodingProvider>
    ) async -> CodingAgentStatus {
        if backend == .omp {
            let executable = executable(for: .omp)
            let keyReady = !storedProviders.isEmpty
            let loginReady: Bool
            if let executable {
                let probe = await run(executable: executable, arguments: ["usage", "--json", "--redact"])
                loginReady = ompLoginAvailable(exitCode: probe.exitCode, output: probe.output)
            } else {
                loginReady = false
            }
            let ready = loginReady || keyReady
            return CodingAgentStatus(
                backend: .omp,
                executablePath: executable,
                installed: true,
                authenticated: ready,
                detail: loginReady
                    ? "Embedded runtime will reuse your existing OMP provider login."
                    : keyReady
                        ? "Embedded runtime will use the provider key stored in Mamachi."
                        : "Embedded runtime ready; log in through OMP or optionally add a provider key."
            )
        }
        guard let executable = executable(for: backend) else {
            return .unavailable(backend)
        }
        let providerCredential = backend == .codex
            ? storedProviders.contains(.openAI)
            : storedProviders.contains(.anthropic)
        let probe = await run(
            executable: executable,
            arguments: backend == .codex ? ["login", "status"] : ["auth", "status", "--json"]
        )
        let authenticated: Bool
        if providerCredential {
            authenticated = true
        } else if backend == .codex {
            authenticated = probe.exitCode == 0 && probe.output.localizedCaseInsensitiveContains("logged in")
        } else if
            probe.exitCode == 0,
            let data = probe.output.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        {
            authenticated = object["loggedIn"] as? Bool == true
        } else {
            authenticated = false
        }
        return CodingAgentStatus(
            backend: backend,
            executablePath: executable,
            installed: true,
            authenticated: authenticated,
            detail: authenticated ? "Installed and logged in." : "Installed; login required."
        )
    }

    private static func searchPathDirectories() -> [URL] {
        let environmentPath = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        let paths = environmentPath.split(separator: ":").map { URL(filePath: String($0), directoryHint: .isDirectory) }
        return paths + [URL(filePath: "/opt/homebrew/bin"), URL(filePath: "/usr/local/bin")]
    }

    private static func isExecutable(_ path: String) -> Bool {
        FileManager.default.isExecutableFile(atPath: path)
    }

    private static func run(executable: String, arguments: [String]) async -> (exitCode: Int32, output: String) {
        await Task.detached(priority: .utility) {
            let process = Process()
            let output = Pipe()
            process.executableURL = URL(filePath: executable)
            process.arguments = arguments
            process.standardOutput = output
            process.standardError = output
            process.environment = ProcessInfo.processInfo.environment.merging([
                "PATH": augmentedPath(),
                "NO_COLOR": "1",
                "TERM": "dumb",
            ]) { _, next in next }
            do {
                try process.run()
            } catch {
                return (-1, error.localizedDescription)
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
                if process.isRunning { process.terminate() }
            }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return (process.terminationStatus, String(decoding: data, as: UTF8.self))
        }.value
    }

    private static func setupScript(
        for backend: CodingAgentBackend,
        executablePath: String?
    ) -> String {
        let command = switch backend {
        case .codex: "codex"
        case .claude: "claude"
        case .omp: "omp"
        }
        let quotedExecutable = executablePath.map { "'\($0.replacingOccurrences(of: "'", with: "'\\''"))'" }
        let install: String
        let login: String
        if backend == .codex {
            install = """
            if ! command -v codex >/dev/null 2>&1; then
              if command -v npm >/dev/null 2>&1; then npm install -g @openai/codex
              elif command -v brew >/dev/null 2>&1; then brew install codex
              else echo 'Install Node.js or Homebrew, then click setup again.'; exit 1
              fi
            fi
            """
            login = "\(quotedExecutable ?? command) login"
        } else if backend == .claude {
            install = """
            if ! command -v claude >/dev/null 2>&1; then
              curl -fsSL https://claude.ai/install.sh | bash
              export PATH="$HOME/.local/bin:$PATH"
            fi
            """
            login = "\(quotedExecutable ?? command) auth login"
        } else {
            install = """
            if ! command -v omp >/dev/null 2>&1; then
              if command -v npm >/dev/null 2>&1; then npm install -g @oh-my-pi/pi-coding-agent
              elif command -v bun >/dev/null 2>&1; then bun install -g @oh-my-pi/pi-coding-agent
              else echo 'Install Node.js, Bun, or Oh My Pi, then click setup again.'; exit 1
              fi
            fi
            """
            login = """
            echo 'OMP will open now. Use /login to add a provider, then quit OMP when setup is complete.'
            \(quotedExecutable ?? command)
            """
        }
        return """
        #!/bin/zsh
        set -e
        export PATH="\(augmentedPath()):$PATH"
        clear
        echo 'Mamachi · \(backend.label) setup'
        echo
        \(install)
        \(login)
        echo
        echo 'Setup complete. Return to Mamachi and click Refresh.'
        printf 'Press any key to close this window…'
        read -k 1
        echo
        """
    }
}
