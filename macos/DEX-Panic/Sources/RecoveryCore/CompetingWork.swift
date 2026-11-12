import Foundation

/// Read-only, privacy-bounded process sample. Paths and command arguments are never retained.
public struct WorkProcess: Equatable, Identifiable {
    public let pid: Int
    public let parentPID: Int
    public let name: String
    public let cpuPercent: Double
    public let residentMiB: Double
    public let category: String
    public let explanation: String
    public let isRelevantCandidate: Bool

    public var id: Int { pid }

    public init(pid: Int, parentPID: Int, name: String, cpuPercent: Double, residentMiB: Double,
                category: String, explanation: String, isRelevantCandidate: Bool) {
        self.pid = pid
        self.parentPID = parentPID
        self.name = name
        self.cpuPercent = cpuPercent
        self.residentMiB = residentMiB
        self.category = category
        self.explanation = explanation
        self.isRelevantCandidate = isRelevantCandidate
    }
}

public enum WorkHost: String, CaseIterable {
    case macBook = "macbook-air.local"
    case bigMac = "bigmac"

    public var displayName: String {
        switch self {
        case .macBook: return "MacBook Air"
        case .bigMac: return "Big Mac"
        }
    }
}

public enum WorkSampleStatus: Equatable {
    case observed
    case partial
    case unavailable
}

public struct WorkHostSnapshot {
    public let host: WorkHost
    public let status: WorkSampleStatus
    public let sampledAt: Date
    public let processes: [WorkProcess]
    public let explanation: String

    public init(host: WorkHost, status: WorkSampleStatus, sampledAt: Date = Date(),
                processes: [WorkProcess], explanation: String) {
        self.host = host
        self.status = status
        self.sampledAt = sampledAt
        self.processes = processes
        self.explanation = explanation
    }
}

public enum ProcessExplanation {
    /// Interpret executable basename only. Generic process names never prove a particular owner.
    public static func classify(_ name: String) -> (String, String, Bool) {
        let n = name.lowercased()
        if n.contains("ollama") || n.contains("llama") || n.contains("mlx") ||
            n.contains("hermes") || n.contains("piper") || n.contains("kokoro") {
            return ("AI runtime", "AI inference, speech or agent tooling. May consume substantial resources. Confirm the active task before changing it.", true)
        }
        if n.contains("dex-reach") || n.contains("dexpanic") || n.contains("dex-panic") {
            return ("DEX infrastructure", "Likely DEX process. A running PID alone does not prove coordinator admission or completed work.", true)
        }
        if n.contains("swift") || n.contains("xcodebuild") || n.contains("clang") ||
            n == "cc1" || n == "ld" || n.contains("rustc") || n == "cargo" ||
            n == "tsc" || n.contains("esbuild") {
            return ("Build / compile", "Compiler/build process. Multiple simultaneous builds may compete for CPU and memory.", true)
        }
        if n == "node" || n == "npm" || n == "npx" || n == "python" ||
            n.hasPrefix("python3") || n == "bun" || n == "deno" {
            return ("General runtime", "Could be DEX, a build, a developer server or unrelated work. The executable name alone cannot identify its task.", true)
        }
        if n.contains("docker") || n.contains("containerd") || n.contains("virtualization") ||
            n.contains("virtualmachine") || n == "qemu" || n.contains("parallels") {
            return ("Container / VM", "Virtual machines and containers can reserve substantial resources, but may be unrelated to DEX.", true)
        }
        if n.contains("brave") || n.contains("chrome") || n.contains("safari") ||
            n.contains("firefox") || n.contains("webkit") {
            return ("Browser", "Browser/helper process. Resident memory may be high; the name does not identify a particular tab.", true)
        }
        if n.contains("jellyfin") || n.contains("ffmpeg") || n.contains("handbrake") {
            return ("Media", "Media server or transcoding work can use CPU/memory; may be unrelated to DEX.", true)
        }
        if n == "kernel_task" || n == "windowserver" || n.contains("mdworker") ||
            n.contains("corespotlight") || n == "launchd" {
            return ("macOS system", "System process. A high resource reading is not evidence it should be stopped.", false)
        }
        return ("Other", "Measured process. Its name and resource usage alone do not explain why it is running.", false)
    }
}

public enum WorkProcessParser {
    /// Native ps rows are PID PPID %CPU RSS(KiB) executable path (not command arguments).
    public static func parse(_ output: String) -> [WorkProcess] {
        var result: [WorkProcess] = []
        for row in output.split(whereSeparator: \.isNewline).prefix(120) {
            let fields = row.split(maxSplits: 4, omittingEmptySubsequences: true,
                                   whereSeparator: \.isWhitespace)
            guard fields.count == 5,
                  let pid = Int(fields[0]), (1...9_999_999).contains(pid),
                  let ppid = Int(fields[1]), (0...9_999_999).contains(ppid),
                  let cpu = Double(fields[2]), cpu.isFinite, (0...3200).contains(cpu),
                  let rss = Double(fields[3]), rss.isFinite, (0...100_000_000).contains(rss) else { continue }
            let path = String(fields[4])
            guard !path.contains("\0") else { continue }
            let basename = String(path.split(separator: "/", omittingEmptySubsequences: true).last ?? "")
            let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+- ()")
            let safeName = String(basename.unicodeScalars.filter { allowed.contains($0) }.prefix(64))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !safeName.isEmpty else { continue }
            let (category, explanation, relevant) = ProcessExplanation.classify(safeName)
            result.append(WorkProcess(pid: pid, parentPID: ppid, name: safeName,
                                      cpuPercent: cpu, residentMiB: rss / 1024,
                                      category: category, explanation: explanation,
                                      isRelevantCandidate: relevant))
        }
        return result
    }

    /// Shortlisted candidates do not correspond to the coordinator's exact heavy-job count.
    public static func shortlist(cpu: [WorkProcess], memory: [WorkProcess], limit: Int = 16) -> [WorkProcess] {
        guard limit > 0 else { return [] }
        var dedup: [Int: WorkProcess] = [:]
        for entry in cpu + memory where dedup[entry.pid] == nil { dedup[entry.pid] = entry }
        let all = Array(dedup.values)
        let topCPU = all.sorted { $0.cpuPercent > $1.cpuPercent }
        let topMemory = all.sorted { $0.residentMiB > $1.residentMiB }
        let relevant = all.filter(\.isRelevantCandidate)
            .sorted { $0.cpuPercent + $0.residentMiB / 64 > $1.cpuPercent + $1.residentMiB / 64 }
        var shortlisted: [WorkProcess] = []
        var seen: Set<Int> = []
        for entry in relevant.prefix(7) + topCPU.prefix(7) + topMemory.prefix(7) {
            if seen.insert(entry.pid).inserted { shortlisted.append(entry) }
        }
        return Array(shortlisted.prefix(min(limit, 20)))
    }
}

public struct CompetingWorkInspector {
    private let runner: CommandRunning
    private let host: HostProfile

    public init(runner: CommandRunning, host: HostProfile = .current) {
        self.runner = runner
        self.host = host
    }

    private static let psFields = "pid=,ppid=,%cpu=,rss=,comm="
    private static let remoteMarker = "DEX_PANIC_NODE_BIGMAC_VERIFIED"

    private static func parsed(_ result: CommandResult) -> [WorkProcess]? {
        guard result.succeeded else { return nil }
        let entries = WorkProcessParser.parse(result.output)
        return entries.isEmpty ? nil : entries
    }

    public func inspectMacBook() -> WorkHostSnapshot {
        switch host {
        case .macBook: return inspectLocal(as: .macBook)
        case .bigMac: return inspectRemoteMacBook()
        case .unknown: return .init(host: .macBook, status: .unavailable, processes: [],
                                    explanation: "Local host identity not verified. No fallback or remote scan.")
        }
    }

    private func inspectLocal(as target: WorkHost) -> WorkHostSnapshot {
        // Strictly read-only; never invoke shell, sudo, kill, launchctl or any remote tool.
        let cpu = runner.run(CommandSpec(executable: "/bin/ps",
                              arguments: ["-axro", Self.psFields], timeout: 6))
        let memory = runner.run(CommandSpec(executable: "/bin/ps",
                                 arguments: ["-axmo", Self.psFields], timeout: 6))
        let a = Self.parsed(cpu)
        let b = Self.parsed(memory)
        guard a != nil || b != nil else {
            return .init(host: target, status: .unavailable, processes: [],
                         explanation: "Local read-only process checks timed out or failed. No process was terminated or retried.")
        }
        let partial = a == nil || b == nil
        return .init(host: target, status: partial ? .partial : .observed,
                     processes: WorkProcessParser.shortlist(cpu: a ?? [], memory: b ?? []),
                     explanation: partial
                        ? "One ranking failed; this is an incomplete process sample, not evidence of an idle machine."
                        : "On-demand CPU and resident-memory samples from the verified local host. These are NOT an exact match for the coordinator's workload count.")
    }

    /// Exactly the explicitly named Big Mac, with SSH trust and account/host identity checks.
    /// Owner-initiated read-only inspection, no user-supplied shell, no remote mutations/fallback.
    public func inspectBigMac() -> WorkHostSnapshot {
        switch host {
        case .bigMac: return inspectLocal(as: .bigMac)
        case .macBook: return inspectRemoteBigMac()
        case .unknown: return .init(host: .bigMac, status: .unavailable, processes: [],
                                    explanation: "Local host identity not verified. No fallback or remote scan.")
        }
    }

    /// Big Mac cannot silently label its own ps output as MacBook. Until a known-host
    /// authenticated route back to the MacBook exists, the remote machine is unavailable.
    private func inspectRemoteMacBook() -> WorkHostSnapshot {
        let script = """
        set -e
        if [ "$(/bin/hostname -s)" != "MacBook-Air" ] || [ "$(/usr/bin/id -un)" != "andrew" ]; then exit 42; fi
        /bin/echo DEX_PANIC_NODE_MACBOOK_VERIFIED
        /bin/echo DEX_PANIC_CPU
        /bin/ps -axro \(Self.psFields) | /usr/bin/head -n 32
        /bin/echo DEX_PANIC_MEMORY
        /bin/ps -axmo \(Self.psFields) | /usr/bin/head -n 32
        """
        let result = runner.run(CommandSpec(executable: "/usr/bin/ssh",
                            arguments: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=7",
                                        "-o", "ConnectionAttempts=1", "-o", "StrictHostKeyChecking=yes",
                                        "macbook-air.local", script], timeout: 18))
        return parseRemote(result, host: .macBook, marker: "DEX_PANIC_NODE_MACBOOK_VERIFIED",
                           unavailable: "MacBook remote access is unavailable or unverified. Requires authenticated macbook-air.local, owner andrew, hostname MacBook-Air. No fallback.")
    }

    private func inspectRemoteBigMac() -> WorkHostSnapshot {
        let script = """
        set -e
        if [ "$(/bin/hostname -s)" != "bigmac" ] || [ "$(/usr/bin/id -un)" != "bigmac" ]; then exit 42; fi
        /bin/echo \(Self.remoteMarker)
        /bin/echo DEX_PANIC_CPU
        /bin/ps -axro \(Self.psFields) | /usr/bin/head -n 32
        /bin/echo DEX_PANIC_MEMORY
        /bin/ps -axmo \(Self.psFields) | /usr/bin/head -n 32
        """
        let result = runner.run(CommandSpec(executable: "/usr/bin/ssh",
                            arguments: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=7",
                                        "-o", "ConnectionAttempts=1", "-o", "StrictHostKeyChecking=yes",
                                        "westcat", script], timeout: 18))
        return parseRemote(result, host: .bigMac, marker: Self.remoteMarker,
                           unavailable: "Big Mac SSH check unavailable or host identity unverified. Requires trusted westcat alias, hostname bigmac and user bigmac. No fallback.")
    }

    private func parseRemote(_ result: CommandResult, host target: WorkHost, marker: String,
                             unavailable message: String) -> WorkHostSnapshot {
        guard result.succeeded,
              let marker = result.output.range(of: marker + "\n"),
              result.output[..<marker.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .init(host: target, status: .unavailable, processes: [], explanation: message)
        }
        let payload = String(result.output[marker.upperBound...])
        let sections = payload.components(separatedBy: "DEX_PANIC_CPU\n")
        guard sections.count == 2 else {
            return .init(host: target, status: .unavailable, processes: [],
                         explanation: "Big Mac returned an incomplete process sample; no healthy/idle status inferred.")
        }
        let pieces = sections[1].components(separatedBy: "DEX_PANIC_MEMORY\n")
        guard pieces.count == 2 else {
            return .init(host: target, status: .unavailable, processes: [],
                         explanation: "Big Mac process data was truncated or incomplete; no remote changes made.")
        }
        let a = WorkProcessParser.parse(pieces[0])
        let b = WorkProcessParser.parse(pieces[1])
        guard !a.isEmpty && !b.isEmpty else {
            return .init(host: target, status: .unavailable, processes: [],
                         explanation: "No reliable Big Mac process rows were returned; it must not be called idle.")
        }
        return .init(host: target, status: .observed,
                     processes: WorkProcessParser.shortlist(cpu: a, memory: b),
                     explanation: "Authenticated read-only snapshot from \(target.displayName) (explicit target \(target.rawValue)). CPU and resident memory are point-in-time estimates.")
    }
}
