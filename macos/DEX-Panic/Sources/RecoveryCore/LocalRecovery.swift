import Foundation
#if os(Linux)
import Glibc
#else
import Darwin
#endif

public struct LaunchdSupervisor {
    private let runner: CommandRunning
    private let userID: UInt32

    public init(runner: CommandRunning, userID: UInt32 = getuid()) {
        self.runner = runner
        self.userID = userID
    }

    public func probe(_ service: ManagedService) -> ServiceProbe {
        let started = ProcessInfo.processInfo.systemUptime
        let result = runner.run(CommandSpec(executable: "/bin/launchctl",
                                            arguments: ["print", "gui/\(userID)/\(service.launchdLabel)"],
                                            timeout: 4))
        let elapsed = max(0, Int((ProcessInfo.processInfo.systemUptime - started) * 1000))
        if result.timedOut { return .init(service: service, state: .unknown, detail: "Probe timed out", durationMilliseconds: elapsed) }
        if result.startError != nil { return .init(service: service, state: .unknown, detail: "Cannot invoke launchctl", durationMilliseconds: elapsed) }
        let state = LaunchctlParser.parse(output: result.output, exitCode: result.exitCode)
        let detail: String
        switch state {
        case .running: detail = "Running"
        case .stopped: detail = "Loaded, not running"
        case .notInstalled: detail = "Not loaded"
        case .unknown: detail = "Unknown state; no automatic repair"
        }
        return .init(service: service, state: state, detail: detail, durationMilliseconds: elapsed)
    }

    private func isKnownService(_ service: ManagedService) -> Bool {
        ServiceRegistry.reach.contains { $0.id == service.id && $0.launchdLabel == service.launchdLabel }
    }

    public func start(_ probe: ServiceProbe) -> CommandResult {
        guard isKnownService(probe.service), RecoveryGuard.decide(.startStopped, for: probe) == .allowed else {
            return .init(exitCode: nil, timedOut: false, startError: "Start refused by service guard")
        }
        // The menu snapshot may be old. Require a second, fresh stopped observation.
        guard self.probe(probe.service).state == .stopped else {
            return .init(exitCode: nil, timedOut: false, startError: "Service changed or cannot be re-probed; no start sent")
        }
        return runner.run(CommandSpec(executable: "/bin/launchctl",
                                      arguments: ["kickstart", "gui/\(userID)/\(probe.service.launchdLabel)"],
                                      timeout: 8))
    }

    public func restart(_ probe: ServiceProbe, ownerConfirmed: Bool) -> CommandResult {
        guard isKnownService(probe.service) else {
            return .init(exitCode: nil, timedOut: false, startError: "Unknown service; no restart sent")
        }
        switch RecoveryGuard.decide(.forceRestart, for: probe) {
        case .blocked:
            return .init(exitCode: nil, timedOut: false, startError: "Restart refused by service guard")
        case .allowed:
            return start(probe)
        case .confirmationRequired:
            guard ownerConfirmed else {
                return .init(exitCode: nil, timedOut: false, startError: "Owner confirmation required")
            }
            // Even after confirmation, do not kill a service whose live state changed.
            guard self.probe(probe.service).state == .running else {
                return .init(exitCode: nil, timedOut: false, startError: "Service changed or cannot be re-probed; no restart sent")
            }
            return runner.run(CommandSpec(executable: "/bin/launchctl",
                                          arguments: ["kickstart", "-k", "gui/\(userID)/\(probe.service.launchdLabel)"],
                                          timeout: 8))
        }
    }
}

public struct OwnerCLI {
    private let runner: CommandRunning
    public let repo: URL
    private let home: URL

    public init(runner: CommandRunning, home: URL = FileManager.default.homeDirectoryForCurrentUser,
                repo: URL? = nil) {
        self.runner = runner
        self.home = home
        self.repo = repo ?? home.appendingPathComponent("DEX-REACH", isDirectory: true)
    }

    public func status() -> CommandResult { invoke("status") }
    public func workStatus() -> CommandResult { invoke("work-status") }
    public func disable() -> CommandResult { invoke("disable") }

    /// Read-only inspector commands only. Other CLI verbs do not pass this gate.
    public func readOnly(_ args: [String]) -> CommandResult {
        guard args == ["work-status", "--json"] || args == ["tasks", "--limit", "8", "--json"] else {
            return .init(exitCode: nil, timedOut: false, startError: "Read-only command outside allowlist")
        }
        return invoke(args: args, timeout: 18, maxOutputBytes: 64000)
    }

    private func invoke(_ subcommand: String) -> CommandResult {
        invoke(args: [subcommand], timeout: 12, maxOutputBytes: 8192)
    }

    private func invoke(args: [String], timeout: TimeInterval, maxOutputBytes: Int) -> CommandResult {
        let fm = FileManager.default
        guard fm.fileExists(atPath: repo.appendingPathComponent("package.json").path),
              fm.fileExists(atPath: repo.appendingPathComponent("scripts/dex-reach.ts").path) else {
            return .init(exitCode: nil, timedOut: false, startError: "Expected DEX-REACH checkout unavailable in home folder")
        }
        guard let npm = findNpm() else {
            return .init(exitCode: nil, timedOut: false, startError: "Node/npm unavailable; policy was NOT verified or changed")
        }
        var env = ProcessInfo.processInfo.environment
        let pathParts = [npm.deletingLastPathComponent().path, "/opt/homebrew/bin", "/usr/local/bin",
                         "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        var unique: [String] = []
        for entry in pathParts where !unique.contains(entry) { unique.append(entry) }
        env["PATH"] = unique.joined(separator: ":")
        return runner.run(CommandSpec(executable: npm.path,
                                      arguments: ["run", "dex", "--"] + args,
                                      workingDirectory: repo, environment: env,
                                      timeout: timeout, maxOutputBytes: maxOutputBytes))
    }

    private func findNpm() -> URL? {
        let fm = FileManager.default
        var paths = ["/opt/homebrew/bin/npm", "/usr/local/bin/npm", "/usr/bin/npm",
                     home.appendingPathComponent(".volta/bin/npm").path,
                     home.appendingPathComponent(".n/bin/npm").path]
        let nvmVersions = home.appendingPathComponent(".nvm/versions/node", isDirectory: true)
        if let entries = try? fm.contentsOfDirectory(atPath: nvmVersions.path) {
            for name in entries.sorted().reversed() {
                paths.append(nvmVersions.appendingPathComponent(name).appendingPathComponent("bin/npm").path)
            }
        }
        return paths.first(where: { fm.isExecutableFile(atPath: $0) }).map { URL(fileURLWithPath: $0) }
    }
}
