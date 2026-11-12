import Foundation

/// Exact local role identity. Never infer a MacBook role on an unknown machine.
public enum HostProfile: Equatable {
    case macBook
    case bigMac
    case unknown

    public static func detect(hostname: String, user: String) -> HostProfile {
        let short = hostname.lowercased().replacingOccurrences(of: ".local", with: "")
        if short == "macbook-air" && user == "andrew" { return .macBook }
        if short == "bigmac" && user == "bigmac" { return .bigMac }
        return .unknown
    }

    public static var current: HostProfile {
        detect(hostname: ProcessInfo.processInfo.hostName, user: NSUserName())
    }

    public var nodeID: String {
        switch self {
        case .macBook: return WorkHost.macBook.rawValue
        case .bigMac: return WorkHost.bigMac.rawValue
        case .unknown: return "UNVERIFIED"
        }
    }

    public var localWorkHost: WorkHost? {
        switch self {
        case .macBook: return .macBook
        case .bigMac: return .bigMac
        case .unknown: return nil
        }
    }

    /// On the MacBook, the gateway/node/coordinator are the required local services.
    /// Big Mac is a secondary execution node: only its node agent is a required local
    /// daemon. Do not demand a nonexistent local Big Mac gateway or coordinator.
    public var services: [ManagedService] {
        switch self {
        case .macBook: return ServiceRegistry.reach
        case .bigMac: return ServiceRegistry.reach.filter { $0.id == "node" }
        case .unknown: return []
        }
    }

    /// The local owner policy command has been proven only for the primary MacBook.
    public var canControlOwnerPolicy: Bool { self == .macBook }
}
