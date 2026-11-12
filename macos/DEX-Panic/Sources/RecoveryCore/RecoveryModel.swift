import Foundation

public struct ManagedService: Equatable, Codable, Identifiable {
    public let id: String
    public let title: String
    public let launchdLabel: String
    public let required: Bool

    public init(id: String, title: String, launchdLabel: String, required: Bool) {
        self.id = id
        self.title = title
        self.launchdLabel = launchdLabel
        self.required = required
    }
}

public enum ServiceRegistry {
    // Exact allowlist. Unknown launchd labels can never be supplied as commands.
    public static let reach: [ManagedService] = [
        .init(id: "gateway", title: "Gateway", launchdLabel: "com.stinkyweasel.dex-reach.gateway", required: true),
        .init(id: "node", title: "Node", launchdLabel: "com.stinkyweasel.dex-reach.node", required: true),
        .init(id: "coordinator", title: "Coordinator", launchdLabel: "com.stinkyweasel.dex-reach.coordinator", required: true),
        .init(id: "worker", title: "Worker (optional)", launchdLabel: "com.stinkyweasel.dex-reach.worker", required: false)
    ]
}

public enum ServiceState: String, Codable, Equatable {
    case running
    case stopped
    case notInstalled
    case unknown
}

public struct ServiceProbe: Equatable {
    public let service: ManagedService
    public let state: ServiceState
    public let detail: String
    /// Monotonic wall elapsed time of this inspection, measured before classification.
    public let durationMilliseconds: Int?

    public init(service: ManagedService, state: ServiceState, detail: String,
                durationMilliseconds: Int? = nil) {
        self.service = service
        self.state = state
        self.detail = detail
        self.durationMilliseconds = durationMilliseconds
    }
}

public enum ServiceAction: Equatable {
    case startStopped
    case forceRestart
}

public enum ActionDecision: Equatable {
    case allowed
    case confirmationRequired
    case blocked(String)
}

public enum RecoveryGuard {
    public static func decide(_ action: ServiceAction, for probe: ServiceProbe) -> ActionDecision {
        switch action {
        case .startStopped:
            if probe.state == .stopped { return .allowed }
            return .blocked("Only an installed, confirmed stopped service can be started without a force action.")
        case .forceRestart:
            switch probe.state {
            case .running: return .confirmationRequired
            case .stopped: return .allowed
            case .notInstalled: return .blocked("Service is not installed. Recovery never installs services.")
            case .unknown: return .blocked("Liveness is unknown. No destructive restart without a fresh positive probe.")
            }
        }
    }
}

public enum LaunchctlParser {
    public static func parse(output: String, exitCode: Int32?) -> ServiceState {
        if exitCode != 0 {
            // On many macOS releases, launchctl returns 113 or says it could not find the service.
            // A nonzero exit with unfamiliar text remains UNKNOWN, never assumed absent.
            let normalized = output.lowercased()
            if normalized.contains("could not find service") || normalized.contains("service not found") || normalized.contains("no such service") {
                return .notInstalled
            }
            return .unknown
        }
        for line in output.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if trimmed == "state = running" { return .running }
            if trimmed == "state = waiting" || trimmed == "state = stopped" || trimmed == "state = exited" {
                return .stopped
            }
        }
        return .unknown
    }
}

public enum SystemHealth: Equatable {
    case healthy
    case degraded
    case unknown
}

public enum HealthClassifier {
    public static func classify(_ probes: [ServiceProbe],
                                services: [ManagedService] = ServiceRegistry.reach) -> SystemHealth {
        // Required services are explicit for each verified host; unknown hosts fail closed.
        let required = services.filter(\.required)
        guard !required.isEmpty else { return .unknown }
        let observations = required.map { service in
            probes.filter { $0.service.id == service.id && $0.service.launchdLabel == service.launchdLabel }
        }
        let states = observations.flatMap { $0.map(\.state) }
        if states.contains(where: { $0 == .stopped || $0 == .notInstalled }) { return .degraded }
        if observations.contains(where: { $0.count != 1 }) { return .unknown }
        if states.contains(.unknown) { return .unknown }
        return .healthy // Liveness only; never represents admission or task correctness.
    }
}

/// Menu-bar white is evidence of daemon liveness only, not permission or task completion.
public enum StatusIndicatorTone: Equatable {
    case white
    case red

    public static func forHealth(_ health: SystemHealth) -> StatusIndicatorTone {
        return health == .healthy ? .white : .red
    }
}

public enum OwnerAccessMode: Equatable {
    case off
    case readOnly
    case on
    case unknown
}

public enum OwnerStatusParser {
    /// Parse only the one authoritative top-level owner mode field.
    /// A successful command is not evidence of OFF without this exact readback.
    public static func accessMode(_ result: CommandResult) -> OwnerAccessMode {
        guard result.succeeded else { return .unknown }
        let matches = result.output.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.hasPrefix("AI access:") }
        guard matches.count == 1, let line = matches.first else { return .unknown }
        let value = line.dropFirst("AI access:".count).trimmingCharacters(in: .whitespacesAndNewlines)
        if value == "DISABLED (all remote AI execution refused)" { return .off }
        if value.hasPrefix("READ-ONLY (") { return .readOnly }
        if value.hasPrefix("ENABLED (") { return .on }
        return .unknown
    }
}

public enum AdmissionState: Equatable {
    case available
    case queued
    case unknown
}

public enum WorkStatusParser {
    public static func admission(_ result: CommandResult) -> AdmissionState {
        guard result.succeeded else { return .unknown }
        let matches = result.output.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.hasPrefix("Admission for a new medium mutating job:") }
        guard matches.count == 1, let mode = matches.first else { return .unknown }
        if mode.hasSuffix(": AVAILABLE") { return .available }
        if mode.hasSuffix(": QUEUE") { return .queued }
        return .unknown
    }
}
