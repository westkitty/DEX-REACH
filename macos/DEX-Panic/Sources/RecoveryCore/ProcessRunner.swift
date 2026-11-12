import Foundation

public struct CommandSpec {
    public let executable: String
    public let arguments: [String]
    public let workingDirectory: URL?
    public let environment: [String: String]?
    public let timeout: TimeInterval
    public let maxOutputBytes: Int

    public init(executable: String, arguments: [String], workingDirectory: URL? = nil,
                environment: [String: String]? = nil, timeout: TimeInterval = 5,
                maxOutputBytes: Int = 8192) {
        self.executable = executable
        self.arguments = arguments
        self.workingDirectory = workingDirectory
        self.environment = environment
        self.timeout = timeout
        self.maxOutputBytes = max(1024, min(64000, maxOutputBytes))
    }
}

public struct CommandResult {
    public let exitCode: Int32?
    public let timedOut: Bool
    public let output: String
    public let startError: String?

    public init(exitCode: Int32?, timedOut: Bool, output: String = "", startError: String? = nil) {
        self.exitCode = exitCode
        self.timedOut = timedOut
        self.output = output
        self.startError = startError
    }

    public var succeeded: Bool { !timedOut && startError == nil && exitCode == 0 }
    public var outcomeLabel: String {
        if timedOut { return "UNKNOWN: timed out (do not replay an uncertain mutation)" }
        if let startError { return "Could not start: \(startError)" }
        if let exitCode { return exitCode == 0 ? "Command completed" : "Command exited \(exitCode)" }
        return "UNKNOWN: no process outcome"
    }
}

public protocol CommandRunning {
    func run(_ spec: CommandSpec) -> CommandResult
}

public struct SystemProcessRunner: CommandRunning {
    public init() {}

    public func run(_ spec: CommandSpec) -> CommandResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: spec.executable)
        process.arguments = spec.arguments
        process.currentDirectoryURL = spec.workingDirectory
        if let environment = spec.environment { process.environment = environment }

        // Redirect output to a private temporary file so a large launchctl/status response
        // cannot fill a pipe and deadlock the recovery UI. Never persist raw output in logs.
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("dex-panic-\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(atPath: outputURL.path, contents: nil,
                                             attributes: [.posixPermissions: 0o600]) else {
            return CommandResult(exitCode: nil, timedOut: false, startError: "Private output capture unavailable")
        }
        defer { try? FileManager.default.removeItem(at: outputURL) }
        guard let capture = try? FileHandle(forWritingTo: outputURL) else {
            return CommandResult(exitCode: nil, timedOut: false, startError: "Cannot open output capture")
        }
        defer { try? capture.close() }
        process.standardOutput = capture
        process.standardError = capture

        do { try process.run() }
        catch { return CommandResult(exitCode: nil, timedOut: false, startError: "Process launch failed") }

        let completed = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .utility).async {
            process.waitUntilExit()
            completed.signal()
        }
        if completed.wait(timeout: .now() + max(1, spec.timeout)) == .timedOut {
            // The effect of a timed-out owner command is UNKNOWN. This only stops the
            // subprocess launched by this app; it never kills DEX services or retries it.
            if process.isRunning { process.terminate() }
            _ = completed.wait(timeout: .now() + 1)
            return CommandResult(exitCode: nil, timedOut: true)
        }

        capture.synchronizeFile()
        // Reading only the first bounded bytes avoids loading an unbounded CLI response.
        let reader = try? FileHandle(forReadingFrom: outputURL)
        let limited = (try? reader?.read(upToCount: spec.maxOutputBytes)) ?? Data()
        try? reader?.close()
        return CommandResult(exitCode: process.terminationStatus, timedOut: false,
                             output: String(decoding: limited, as: UTF8.self))
    }
}
