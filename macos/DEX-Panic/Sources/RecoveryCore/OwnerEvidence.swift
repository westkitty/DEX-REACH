import Foundation

public struct ClassifiedWorkGroup: Equatable, Identifiable {
    public let id: String
    public let name: String
    public let cpuPercent: Double
    public let memoryPercent: Double
    public let members: Int
    public let threshold: String
    public let explanation: String
}

public struct ClassifiedWorkSnapshot {
    public let host: WorkHost
    public let observedAt: Date
    public let state: WorkSampleStatus
    public let reportedCount: Int?
    public let groups: [ClassifiedWorkGroup]
    public let explanation: String
}

public struct TaskAutopsyRow: Equatable, Identifiable {
    public let id: String
    public let operation: String
    public let state: String
    public let updatedAt: Date
    public let resultRecorded: Bool
    public let guidance: String
}

public struct TaskAutopsySnapshot {
    public let host: WorkHost
    public let observedAt: Date
    public let state: WorkSampleStatus
    public let tasks: [TaskAutopsyRow]
    public let explanation: String
}

public enum OwnerEvidenceParser {
    private static let allowedLabels = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-")
    private static let validStates: Set<String> = [
        "ACCEPTED", "PREPARING", "RUNNING", "INPUT_REQUIRED", "AMBIGUOUS",
        "COMPLETED", "FAILED", "CANCELLED", "RECONCILED"
    ]
    private static let dateFormatter = ISO8601DateFormatter()
    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static func parseDate(_ value: String) -> Date? {
        fractionalFormatter.date(from: value) ?? dateFormatter.date(from: value)
    }

    /// npm prints a banner before the JSON; ignore all stdout except the final valid JSON payload.
    /// Raw text must never be stored, displayed or copied to the diagnostic clipboard.
    private static func payload(_ raw: String, opening: Character) -> Any? {
        let lines = raw.split(whereSeparator: \.isNewline)
        guard let index = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces).first == opening }) else { return nil }
        let json = lines[index...].joined(separator: "\n")
        guard json.utf8.count <= 64_000 else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(json.utf8))
    }

    private static func safeLabel(_ raw: String, limit: Int = 48) -> String? {
        guard raw.count <= 128, !raw.isEmpty, raw.unicodeScalars.allSatisfy({ allowedLabels.contains($0) }) else { return nil }
        return String(raw.prefix(limit))
    }

    public static func classify(_ result: CommandResult, host: WorkHost) -> ClassifiedWorkSnapshot {
        let sampledAt = Date()
        guard result.succeeded, let root = payload(result.output, opening: "{") as? [String: Any],
              let observed = root["observed"] as? [String: Any],
              let count = observed["uncoordinatedHeavy"] as? Int, (0...200).contains(count),
              let details = observed["uncoordinatedDetails"] as? [[String: Any]] else {
            return .init(host: host, observedAt: sampledAt, state: .unavailable, reportedCount: nil, groups: [],
                         explanation: "The local coordinator did not supply a complete, verified classification. No process attribution inferred.")
        }
        let projected = (root["schemaVersion"] as? Int) == 1
        let complete = projected ? (observed["detailsComplete"] as? Bool == true) : (details.count == count)
        guard complete, details.count == count, details.count <= 24,
              (!projected || (root["nodeId"] as? String == host.rawValue)) else {
            return .init(host: host, observedAt: sampledAt, state: .partial, reportedCount: count, groups: [],
                         explanation: "Coordinator count and grouped details disagree or exceed the display bound. Attribution withheld.")
        }
        var groups: [ClassifiedWorkGroup] = []
        for (index, detail) in details.enumerated() {
            guard let label = detail["processLabel"] as? String,
                  let name = safeLabel(label),
                  let cpu = detail["cpu"] as? Double, cpu.isFinite, (0...3200).contains(cpu),
                  let mem = detail["mem"] as? Double, mem.isFinite, (0...100).contains(mem),
                  let members = (projected ? detail["members"] as? Int : (detail["pids"] as? [Int])?.count),
                  (1...64).contains(members),
                  let matchedBy = detail["matchedBy"] as? String, ["cpu", "memory"].contains(matchedBy) else {
                return .init(host: host, observedAt: sampledAt, state: .partial, reportedCount: count, groups: [],
                             explanation: "Malformed coordinator classification. Raw process identities withheld.")
            }
            let explanation = matchedBy == "cpu"
                ? "Classified by coordinator's CPU threshold. Grouped process tree, not one row per job."
                : "Classified by coordinator's memory threshold. Resident memory can share pages."
            groups.append(.init(id: "\(host.rawValue)-\(index)", name: name, cpuPercent: cpu,
                                memoryPercent: mem, members: members, threshold: matchedBy,
                                explanation: explanation))
        }
        return .init(host: host, observedAt: sampledAt, state: .observed, reportedCount: count,
                     groups: groups,
                     explanation: "This is the coordinator's read-only classification at inspection time, not a restart recommendation. PIDs, commands, credentials, project paths and process arguments are omitted.")
    }

    public static func tasks(_ result: CommandResult, host: WorkHost) -> TaskAutopsySnapshot {
        let sampledAt = Date()
        guard result.succeeded else {
            return .init(host: host, observedAt: sampledAt, state: .unavailable, tasks: [],
                         explanation: "Read-only task query failed; no task effects inferred.")
        }
        let projected = payload(result.output, opening: "{") as? [String: Any]
        if let projected {
            guard projected["schemaVersion"] as? Int == 1,
                  projected["nodeId"] as? String == host.rawValue,
                  projected["complete"] as? Bool == true else {
                return .init(host: host, observedAt: sampledAt, state: .partial, tasks: [],
                             explanation: "Projected task inventory is incomplete or belongs to another node; no fallback.")
            }
        }
        let objects = (projected?["tasks"] as? [[String: Any]]) ??
            (payload(result.output, opening: "[") as? [[String: Any]])
        guard let objects, objects.count <= 12 else {
            return .init(host: host, observedAt: sampledAt, state: .unavailable, tasks: [],
                         explanation: "The local durable-task store did not return a complete, bounded read-only list. Do not assume no tasks exist.")
        }
        var rows: [TaskAutopsyRow] = []
        for object in objects {
            guard let id = object["taskId"] as? String,
                  id.range(of: #"^rtsk_[0-9a-f]{11,13}_[0-9a-f]{16,32}$"#, options: .regularExpression) != nil,
                  let nodeID = object["nodeId"] as? String, nodeID == host.rawValue,
                  let state = object["state"] as? String, validStates.contains(state),
                  let operation = object["operation"] as? String, let op = safeLabel(operation, limit: 48),
                  let dateText = object["updatedAtUtc"] as? String,
                  let date = parseDate(dateText) else {
                return .init(host: host, observedAt: sampledAt, state: .partial, tasks: [],
                             explanation: "Task records include unknown identity/state or invalid timestamps. List withheld; no replay.")
            }
            let hasResult = (object["resultRecorded"] as? Bool) ??
                (object["resultRef"] is String && object["resultHash"] is String)
            let guidance: String
            switch state {
            case "INPUT_REQUIRED": guidance = "Owner input required; no automatic continuation."
            case "AMBIGUOUS": guidance = "External effects unresolved. Do not replay."
            case "COMPLETED": guidance = "Completion recorded\(hasResult ? " with a result reference" : ""); external side effects are not independently proven here."
            case "RECONCILED": guidance = "Reconciled state recorded; verify receipt linkage before relying on effects."
            case "FAILED", "CANCELLED": guidance = "Terminal state recorded; external effects are not inferred."
            default: guidance = "Nonterminal recorded state. A live worker or progress is not proven by this record."
            }
            rows.append(.init(id: id, operation: op, state: state, updatedAt: date,
                              resultRecorded: hasResult, guidance: guidance))
        }
        return .init(host: host, observedAt: sampledAt, state: .observed, tasks: rows,
                     explanation: "Owner-local durable task records only. This view does not retrieve private result data, change task state, reattach or retry anything.")
    }
}

/// Strictly read-only owner CLI commands, on verified local machine or one explicitly pinned
/// remote host. Remote inspection does not bypass DEX node admission for AI execution:
/// this is an owner-local status lane over the existing authenticated SSH transport.
public struct OwnerEvidenceInspector {
    private let runner: CommandRunning
    private let profile: HostProfile
    private let local: OwnerCLI

    public init(runner: CommandRunning, profile: HostProfile = .current) {
        self.runner = runner
        self.profile = profile
        self.local = OwnerCLI(runner: runner)
    }

    private func run(_ command: [String], target: WorkHost) -> CommandResult {
        guard let current = profile.localWorkHost else {
            return .init(exitCode: nil, timedOut: false, startError: "Unverified local machine identity")
        }
        if current == target { return local.readOnly(command) }
        // Big Mac is the only proven remote owner-SSH link from MacBook.
        guard current == .macBook, target == .bigMac else {
            return .init(exitCode: nil, timedOut: false, startError: "Remote host trust not established; no fallback")
        }
        let args = command.joined(separator: " ")
        // Only validated fixed read-only command sequences may reach this point.
        guard command == ["work-status", "--panic"] || command == ["tasks", "--panic"] else {
            return .init(exitCode: nil, timedOut: false, startError: "Read-only command outside allowlist")
        }
        let remote = """
        set -e
        if [ "$(/bin/hostname -s)" != "bigmac" ] || [ "$(/usr/bin/id -un)" != "bigmac" ]; then exit 42; fi
        /bin/echo DEX_PANIC_BIGMAC_CLI_VERIFIED
        cd /Users/bigmac/DEX-Panic-0.3.0-Release-20261112
        /opt/homebrew/bin/npm run dex -- \(args)
        """
        let result = runner.run(CommandSpec(executable: "/usr/bin/ssh",
                             arguments: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=7",
                                         "-o", "ConnectionAttempts=1", "-o", "StrictHostKeyChecking=yes",
                                         "westcat", remote], timeout: 25, maxOutputBytes: 64000))
        guard result.succeeded, result.output.hasPrefix("DEX_PANIC_BIGMAC_CLI_VERIFIED\n") else {
            return .init(exitCode: nil, timedOut: result.timedOut, startError: "Big Mac CLI unavailable or identity unverified")
        }
        return .init(exitCode: 0, timedOut: false,
                     output: String(result.output.dropFirst("DEX_PANIC_BIGMAC_CLI_VERIFIED\n".count)))
    }

    public func attribution(host: WorkHost) -> ClassifiedWorkSnapshot {
        OwnerEvidenceParser.classify(run(profile == .macBook && host == .macBook
            ? ["work-status", "--json"] : ["work-status", "--panic"], target: host), host: host)
    }
    public func autopsy(host: WorkHost) -> TaskAutopsySnapshot {
        OwnerEvidenceParser.tasks(run(profile == .macBook && host == .macBook
            ? ["tasks", "--limit", "8", "--json"] : ["tasks", "--panic"], target: host), host: host)
    }
}
