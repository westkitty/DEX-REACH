import Foundation

/// An interpretation of observed data, never a diagnosis of hidden process health.
public struct DiagnosticFinding: Equatable {
    public let title: String
    public let meaning: String
    public let nextStep: String
    public let kind: String

    public init(title: String, meaning: String, nextStep: String, kind: String) {
        self.title = title
        self.meaning = meaning
        self.nextStep = nextStep
        self.kind = kind
    }
}

public enum ProbeExplanation {
    public static func assess(_ probes: [ServiceProbe],
                              services: [ManagedService] = ServiceRegistry.reach) -> DiagnosticFinding {
        let required = services.filter(\.required)
        let matches = required.map { service in
            probes.filter { $0.service.id == service.id &&
                            $0.service.launchdLabel == service.launchdLabel }
        }
        let observed = matches.flatMap { $0 }
        let missing = required.count - matches.filter { $0.count == 1 }.count

        if let stopped = observed.first(where: { $0.state == .stopped }) {
            let name = ServiceRegistry.reach.first(where: { $0.id == stopped.service.id })?.title ?? "Required service"
            return .init(
                title: "Required service confirmed stopped",
                meaning: "\(name) is loaded but launchd reports it is not running. This is a positive observation, not a timeout. Other services may still be unknown.",
                nextStep: "Check for active tasks first. If safe, open that service's menu and use Start stopped service. The app will recheck before acting. Do not force a restart of an unknown service.",
                kind: "confirmed-stopped")
        }
        if let absent = observed.first(where: { $0.state == .notInstalled }) {
            let name = ServiceRegistry.reach.first(where: { $0.id == absent.service.id })?.title ?? "Required service"
            return .init(
                title: "Required service not loaded",
                meaning: "launchd reports \(name) is not loaded. This does not establish why it is missing or that installation is safe.",
                nextStep: "Inspect the DEX installation and launchd configuration with the owner before making changes. DEX//PANIC never installs missing services or guesses their identifiers.",
                kind: "not-loaded")
        }
        if missing > 0 {
            return .init(
                title: "Incomplete service inventory",
                meaning: "One or more required services had no unique matching observation. The app cannot declare the required daemon set healthy.",
                nextStep: "Run fresh checks once. If observations remain missing, copy this report; do not restart an unverified service.",
                kind: "incomplete")
        }
        let requiredUnknown = observed.filter { $0.state == .unknown }
        let timeouts = requiredUnknown.filter { $0.detail == "Probe timed out" }
        if !timeouts.isEmpty {
            return .init(
                title: "Local service checks timed out",
                meaning: "\(timeouts.count) of \(required.count) required launchctl checks exceeded the 4-second probe deadline. This means the checks failed to return in time; it does NOT prove those daemons stopped. Machine pressure or slow launchctl responses are possible, not confirmed causes.",
                nextStep: "Let competing work settle, then use Run fresh checks once. Inspect work admission to see whether the coordinator is queuing new work. If it continues, copy this report. Do not restart a service whose state is unknown.",
                kind: "timeout")
        }
        if !requiredUnknown.isEmpty {
            let couldNotLaunch = requiredUnknown.contains { $0.detail == "Cannot invoke launchctl" }
            return .init(
                title: couldNotLaunch ? "Local status command unavailable" : "Service state could not be verified",
                meaning: couldNotLaunch
                    ? "The app could not start launchctl for at least one required service. This is an inspection failure, not evidence that the service stopped."
                    : "launchctl returned an unreadable or unfamiliar state for at least one required service.",
                nextStep: "Run fresh checks once, then copy the diagnostic report if the state stays unknown. Do not use a forced restart as a substitute for evidence.",
                kind: couldNotLaunch ? "command-failed" : "unrecognized")
        }
        let optionalUnknown = services.filter { !$0.required }.contains { service in
            probes.first(where: { $0.service.id == service.id })?.state == .unknown
        }
        return .init(
            title: optionalUnknown ? "Required services running; optional check uncertain" : "Required services observed running",
            meaning: optionalUnknown
                ? "All required daemons were reported running by launchd. The optional worker could not be verified."
                : "launchd reported each required daemon running. Liveness does not establish that the gateway accepts work, that owner policy is ON, or that a task completed.",
            nextStep: "If work still stalls, use Inspect work admission and Inspect owner policy. A successful process check is not a completed-job receipt.",
            kind: optionalUnknown ? "optional-unknown" : "liveness")
    }
}

/// Whitelisted capacity fields extracted from a successful, manually requested CLI read.
/// Raw CLI output is intentionally never carried to the share report.
public struct WorkEvidence: Equatable {
    public let memory: String
    public let cpu: String
    public let thermal: String
    public let activeLeases: Int?
    public let queueDepth: Int?
    public let uncoordinatedHeavy: Int?
}

public enum WorkEvidenceParser {
    public static func parse(_ result: CommandResult) -> WorkEvidence? {
        guard result.succeeded else { return nil }
        let lines = result.output.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        func value(_ label: String) -> String? {
            let matches = lines.filter { $0.hasPrefix(label + ":") }
            guard matches.count == 1 else { return nil }
            return matches[0].dropFirst(label.count + 1).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        func controlled(_ label: String, allowed: Set<String>) -> String? {
            guard let observed = value(label)?.lowercased(), allowed.contains(observed) else { return nil }
            return observed
        }
        func count(_ label: String) -> Int? {
            guard let raw = value(label), let count = Int(raw), (0...10000).contains(count) else { return nil }
            return count
        }
        guard let memory = controlled("Memory pressure", allowed: ["healthy", "warning", "critical", "unknown"]),
              let cpu = controlled("CPU pressure", allowed: ["healthy", "busy", "saturated", "unknown"]) else { return nil }
        return WorkEvidence(memory: memory, cpu: cpu,
                            thermal: controlled("Thermal", allowed: ["healthy", "warm", "critical", "unknown"]) ?? "not reported",
                            activeLeases: count("Active leases"), queueDepth: count("Queue depth"),
                            uncoordinatedHeavy: count("Uncoordinated heavy jobs"))
    }
}

/// Captured, bounded status data. No arbitrary CLI stdout, credentials or local file paths.
public struct DiagnosticSnapshot {
    public let probes: [ServiceProbe]
    public let services: [ManagedService]
    public let lastConfirmedRunning: [String: Date]
    public let cycleDurationMilliseconds: Int?
    public let lastChecked: Date?
    public let refreshInFlight: Bool
    public let admissionNote: String
    public let admissionChecked: Date?
    public let workEvidence: WorkEvidence?
    public let workSnapshots: [WorkHost: WorkHostSnapshot]
    public let classifiedWork: [WorkHost: ClassifiedWorkSnapshot]
    public let taskAutopsies: [WorkHost: TaskAutopsySnapshot]
    public let authorityNote: String
    public let authorityChecked: Date?
    public let logFull: Bool
    public let incidents: [IncidentRecord]
    public let capturedAt: Date

    public init(probes: [ServiceProbe],
                services: [ManagedService] = ServiceRegistry.reach,
                lastConfirmedRunning: [String: Date] = [:],
                cycleDurationMilliseconds: Int? = nil, lastChecked: Date?,
                refreshInFlight: Bool, admissionNote: String, admissionChecked: Date?,
                workEvidence: WorkEvidence? = nil, workSnapshots: [WorkHost: WorkHostSnapshot] = [:],
                classifiedWork: [WorkHost: ClassifiedWorkSnapshot] = [:],
                taskAutopsies: [WorkHost: TaskAutopsySnapshot] = [:],
                authorityNote: String, authorityChecked: Date?, logFull: Bool,
                incidents: [IncidentRecord], capturedAt: Date = Date()) {
        self.probes = probes
        self.services = services
        self.lastConfirmedRunning = lastConfirmedRunning
        self.cycleDurationMilliseconds = cycleDurationMilliseconds
        self.lastChecked = lastChecked
        self.refreshInFlight = refreshInFlight
        self.admissionNote = admissionNote
        self.admissionChecked = admissionChecked
        self.workEvidence = workEvidence
        self.workSnapshots = workSnapshots
        self.classifiedWork = classifiedWork
        self.taskAutopsies = taskAutopsies
        self.authorityNote = authorityNote
        self.authorityChecked = authorityChecked
        self.logFull = logFull
        self.incidents = incidents
        self.capturedAt = capturedAt
    }
}

public enum DiagnosticReport {
    private static let allowedAdmission: Set<String> = [
        "NOT INSPECTED", "AVAILABLE AT CHECK", "QUEUED AT CHECK", "NOT VERIFIED"
    ]
    private static let allowedAuthority: Set<String> = [
        "NOT INSPECTED", "ON", "READ-ONLY", "OFF VERIFIED", "OFF NOT VERIFIED", "NOT VERIFIED"
    ]
    private static let allowedActions: Set<String> = [
        "state-change", "read-owner-status", "read-work-status",
        "Disable remote execution", "Start stopped service", "Confirmed service restart"
    ]
    private static let allowedTargets: Set<String> = [
        "gateway", "node", "coordinator", "worker", "node-local-policy", "coordinator-capacity"
    ]
    private static let allowedStates: Set<String> = ["running", "stopped", "notInstalled", "unknown"]

    private static func time(_ date: Date?) -> String {
        guard let date else { return "not inspected" }
        return ISO8601DateFormatter().string(from: date)
    }

    private static func reason(_ probe: ServiceProbe) -> String {
        switch probe.detail {
        case "Running": return "launchd state running"
        case "Loaded, not running": return "launchd reports loaded but stopped"
        case "Not loaded": return "launchd could not find this service"
        case "Probe timed out": return "launchctl print exceeded 4-second deadline"
        case "Cannot invoke launchctl": return "could not start launchctl"
        case "Unknown state; no automatic repair": return "launchctl returned unrecognized state"
        default: return "detail unavailable (untrusted text excluded)"
        }
    }

    private static func safeOutcome(_ record: IncidentRecord) -> String {
        if record.action == "state-change" {
            let parts = record.outcome.components(separatedBy: "-to-")
            if parts.count == 2, parts.allSatisfy({ allowedStates.contains($0) }) {
                return record.outcome
            }
            return "state transition details omitted"
        }
        if record.outcome == "Command completed" { return "Command completed (effects not inferred)" }
        if record.outcome.hasPrefix("Command exited ") { return "Command exited nonzero" }
        if record.outcome.hasPrefix("UNKNOWN: timed out") { return "Command timed out; effects unknown" }
        if record.outcome.hasPrefix("Could not start:") { return "Command could not start" }
        return "Outcome detail omitted"
    }

    /// A stable, plain-text share report. Only typechecked/allowlisted values cross the clipboard.
    public static func render(_ snapshot: DiagnosticSnapshot) -> String {
        let finding = ProbeExplanation.assess(snapshot.probes, services: snapshot.services)
        let health = HealthClassifier.classify(snapshot.probes, services: snapshot.services)
        var lines: [String] = [
            "DEX//PANIC SHARE-SAFE DIAGNOSTIC REPORT",
            "Format: 3 | App: 0.3.0 | Source: owner-local recovery controller",
            "Captured (UTC): \(time(snapshot.capturedAt))",
            "Last service snapshot (UTC): \(time(snapshot.lastChecked))",
            "Snapshot age (seconds): \(snapshot.lastChecked.map { max(0, Int(snapshot.capturedAt.timeIntervalSince($0))) }.map(String.init) ?? "not observed")",
            "Service refresh in progress: \(snapshot.refreshInFlight ? "yes" : "no")",
            "Required service liveness: \(health)",
            "Probe cycle duration (ms): \(snapshot.cycleDurationMilliseconds.map(String.init) ?? "not observed")",
            "Finding: \(finding.title) [\(finding.kind)]",
            "Meaning: \(finding.meaning)",
            "Safe next step: \(finding.nextStep)",
            "",
            "SERVICE OBSERVATIONS (launchd only)"
        ]
        for service in snapshot.services {
            let matches = snapshot.probes.filter {
                $0.service.id == service.id && $0.service.launchdLabel == service.launchdLabel
            }
            if matches.count == 1, let probe = matches.first {
                let duration = probe.durationMilliseconds.map { " (\($0) ms)" } ?? " (duration unavailable)"
                let lastGood = time(snapshot.lastConfirmedRunning[service.id])
                lines.append("- \(service.id) [\(service.required ? "required" : "optional")]: \(probe.state.rawValue); \(reason(probe))\(duration); last positive: \(lastGood)")
            } else {
                lines.append("- \(service.id) [\(service.required ? "required" : "optional")]: missing/duplicate; no reliable observation")
            }
        }
        let capacity = allowedAdmission.contains(snapshot.admissionNote) ? snapshot.admissionNote : "NOT VERIFIED"
        let authority = allowedAuthority.contains(snapshot.authorityNote) ? snapshot.authorityNote : "NOT VERIFIED"
        lines += [
            "",
            "OTHER EVIDENCE (on-demand, not continuously monitored)",
            "Work admission: \(capacity) | last inspection (UTC): \(time(snapshot.admissionChecked))",
            "Work memory pressure: \(snapshot.workEvidence?.memory ?? "not inspected")",
            "Work CPU pressure: \(snapshot.workEvidence?.cpu ?? "not inspected")",
            "Work thermal state: \(snapshot.workEvidence?.thermal ?? "not inspected")",
            "Active work leases: \(snapshot.workEvidence?.activeLeases.map(String.init) ?? "not inspected")",
            "Queued jobs: \(snapshot.workEvidence?.queueDepth.map(String.init) ?? "not inspected")",
            "Uncoordinated heavy jobs: \(snapshot.workEvidence?.uncoordinatedHeavy.map(String.init) ?? "not inspected")",
            "Owner policy: \(authority) | last inspection (UTC): \(time(snapshot.authorityChecked))",
            "Task effects: NOT VERIFIED (not checked by DEX//PANIC)",
            "Incident-log full/unavailable: \(snapshot.logFull ? "yes" : "no")",
            "",
            "RECENT METADATA EVENTS (maximum 24, oldest first)"
        ]
        var eventCount = 0
        for record in snapshot.incidents.suffix(24) {
            guard allowedActions.contains(record.action), allowedTargets.contains(record.target),
                  record.timestamp.count < 45,
                  ISO8601DateFormatter().date(from: record.timestamp) != nil else { continue }
            lines.append("- \(record.timestamp) | \(record.action) | \(record.target) | \(safeOutcome(record))")
            eventCount += 1
        }
        if eventCount == 0 { lines.append("- no share-safe events available") }
        lines.append("")
        lines.append("PROCESS SAMPLES (read-only; not exact coordinator attribution)")
        let allowedName = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+- ()")
        for host in WorkHost.allCases {
            guard let snapshot = snapshot.workSnapshots[host] else {
                lines.append("- \(host.displayName) [\(host.rawValue)]: not inspected")
                continue
            }
            let state: String
            switch snapshot.status {
            case .observed: state = "observed"
            case .partial: state = "partial"
            case .unavailable: state = "unavailable"
            }
            lines.append("- \(host.displayName) [\(host.rawValue)]: \(state) at \(time(snapshot.sampledAt))")
            for process in snapshot.processes.prefix(8) {
                let filtered = String(process.name.unicodeScalars.filter { allowedName.contains($0) }.prefix(48))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let suspicious = ["token", "secret", "password", "sk-proj", "apikey", "api_key"]
                    .contains { filtered.lowercased().contains($0) }
                let name = filtered.isEmpty || suspicious ? "[process name withheld]" : filtered
                guard process.cpuPercent.isFinite, (0...3200).contains(process.cpuPercent),
                      process.residentMiB.isFinite, (0...100_000).contains(process.residentMiB) else { continue }
                lines.append(String(format: "  \(name) | CPU %.1f%% | RSS %.0f MiB", process.cpuPercent, process.residentMiB))
            }
        }
        lines += ["", "COORDINATOR CLASSIFIED WORK (read-only; actual classification, no process IDs)"]
        let safeLabel = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-")
        for host in WorkHost.allCases {
            guard let inspected = snapshot.classifiedWork[host] else {
                lines.append("- \(host.rawValue): not inspected")
                continue
            }
            let label = inspected.state == .observed ? "classified" : "unverified"
            lines.append("- \(host.rawValue): \(label) at \(time(inspected.observedAt)); grouped count \(inspected.reportedCount.map(String.init) ?? "unknown")")
            for group in inspected.groups.prefix(8) {
                guard group.cpuPercent.isFinite, (0...3200).contains(group.cpuPercent),
                      group.memoryPercent.isFinite, (0...100).contains(group.memoryPercent),
                      (1...64).contains(group.members), ["cpu", "memory"].contains(group.threshold),
                      !group.name.isEmpty, group.name.count <= 48,
                      group.name.unicodeScalars.allSatisfy({ safeLabel.contains($0) }) else { continue }
                let suspicious = ["token", "secret", "password", "apikey", "credential", "sk-proj"]
                    .contains { group.name.lowercased().contains($0) }
                let name = suspicious ? "withheld" : group.name
                lines.append(String(format: "  \(name) | CPU %.1f%% | Memory %.1f%% | members \(group.members) | threshold \(group.threshold)", group.cpuPercent, group.memoryPercent))
            }
        }
        lines += ["", "DURABLE TASK STATES (read-only; effects not independently proven)"]
        for host in WorkHost.allCases {
            guard let inspected = snapshot.taskAutopsies[host] else {
                lines.append("- \(host.rawValue): not inspected")
                continue
            }
            let label = inspected.state == .observed ? "observed" : "unverified"
            lines.append("- \(host.rawValue): \(label) at \(time(inspected.observedAt)); listed \(inspected.tasks.count)")
            for task in inspected.tasks.prefix(8) {
                guard task.id.range(of: #"^rtsk_[0-9a-f]{11,13}_[0-9a-f]{16,32}$"#, options: .regularExpression) != nil,
                      ["ACCEPTED", "PREPARING", "RUNNING", "INPUT_REQUIRED", "AMBIGUOUS", "COMPLETED", "FAILED", "CANCELLED", "RECONCILED"].contains(task.state),
                      task.operation.count <= 48,
                      task.operation.unicodeScalars.allSatisfy({ safeLabel.contains($0) }) else { continue }
                lines.append("  \(task.id) | \(task.operation) | \(task.state) | result reference \(task.resultRecorded ? "recorded" : "not recorded")")
            }
        }
        lines += [
            "",
            "INTERPRETATION LIMITS",
            "A timeout is NOT proof that a daemon crashed. Running is NOT proof of task completion.",
            "Queued admission is NOT a permission change; old readings may be stale.",
            "No DEX runtime changes or recovery actions were performed to create this report.",
            "Process names are sanitized executable basenames, never argv or paths. Review before sharing.",
            "Private paths, credentials, raw command output and unrestricted logs are excluded."
        ]
        return String(lines.joined(separator: "\n").prefix(12000))
    }
}
